/**
 * Server-side TEE connection helper.
 * TEE (devnet-tee / MDTrz4) requires JWT auth for reads.
 * Auth flow: GET /auth/challenge?pubkey=... → POST /auth/login → JWT token
 */
import { Connection, Keypair } from '@solana/web3.js';
import * as https from 'https';
import * as nacl from 'tweetnacl';
import { loadRequiredServerKeypair } from '@/lib/server-runtime-keys';

const TEE_BASE = (
  process.env.TEE_RPC ||
  process.env.NEXT_PUBLIC_DEFAULT_TEE_RPC ||
  'https://mainnet-tee.magicblock.app'
).replace(/\/+$/, '');
const TEE_API_KEY = process.env.TEE_API_KEY || process.env.MAGICBLOCK_TEE_API_KEY || '';

// Per-validator token cache: base URL → { token, expiry }
const tokenCache = new Map<string, { token: string; expiry: number }>();

function normalizeTeeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function shouldUseTeeApiKey(baseUrl: string): boolean {
  try {
    return new URL(normalizeTeeBase(baseUrl)).hostname === 'mainnet-tee.magicblock.app';
  } catch {
    return false;
  }
}

function teeHeaders(baseUrl: string, extra?: Record<string, string>): Record<string, string> {
  if (TEE_API_KEY && shouldUseTeeApiKey(baseUrl)) {
    return { ...(extra || {}), 'x-api-key': TEE_API_KEY };
  }
  return { ...(extra || {}) };
}

function fetchJson(url: string, opts?: { method?: string; body?: string }): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const o: any = {
      hostname: p.hostname, port: 443,
      path: p.pathname + p.search,
      method: opts?.method || 'GET',
      headers: teeHeaders(url, { 'Content-Type': 'application/json' }),
    };
    if (opts?.body) o.headers['Content-Length'] = Buffer.byteLength(opts.body);
    const r = https.request(o, (res) => {
      let d = '';
      res.on('data', (c: string) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
    });
    r.on('error', reject);
    if (opts?.body) r.write(opts.body);
    r.end();
  });
}

function b58encode(buf: Buffer): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ZERO = BigInt(0);
  const FIFTY_EIGHT = BigInt(58);
  let n = BigInt('0x' + buf.toString('hex'));
  let r = '';
  while (n > ZERO) { r = A[Number(n % FIFTY_EIGHT)] + r; n = n / FIFTY_EIGHT; }
  for (let i = 0; i < buf.length && buf[i] === 0; i++) r = '1' + r;
  return r;
}

let authorityKeypair: Keypair | null = null;
function getAuthKeypair(): Keypair {
  if (authorityKeypair) return authorityKeypair;
  authorityKeypair = loadRequiredServerKeypair('AUTHORITY_KEYPAIR_PATH');
  return authorityKeypair;
}

/**
 * Get a TEE auth token for the specified validator (or default).
 * Tokens are cached per-validator and refreshed at 55 min.
 */
export async function getTeeToken(baseUrl?: string): Promise<string> {
  const base = normalizeTeeBase(baseUrl || TEE_BASE);
  const now = Date.now();
  const cached = tokenCache.get(base);
  if (cached && cached.expiry > now) return cached.token;

  const kp = getAuthKeypair();
  const pub = kp.publicKey.toBase58();
  const cr = await fetchJson(`${base}/auth/challenge?pubkey=${pub}`);
  if (!cr.challenge) throw new Error(`TEE challenge failed: ${JSON.stringify(cr)}`);

  const sig = nacl.sign.detached(Buffer.from(cr.challenge, 'utf-8'), kp.secretKey);
  const lr = await fetchJson(`${base}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ pubkey: pub, challenge: cr.challenge, signature: b58encode(Buffer.from(sig)) }),
  });
  if (!lr.token) throw new Error(`TEE login failed: ${JSON.stringify(lr)}`);

  tokenCache.set(base, { token: lr.token, expiry: now + 55 * 60 * 1000 });
  return lr.token;
}

// Per-validator connection cache: base URL → { conn, tokenSnapshot }
const connCache = new Map<string, { conn: Connection; tokenSnapshot: string }>();

/**
 * Get an authenticated TEE Connection (server-side).
 * Accepts optional validatorUrl to connect to a specific validator.
 * Caches per-validator and only recreates when the token changes.
 */
export async function getTeeConnection(validatorUrl?: string): Promise<Connection> {
  const base = normalizeTeeBase(validatorUrl || TEE_BASE);
  const token = await getTeeToken(base);
  const cached = connCache.get(base);
  if (cached && cached.tokenSnapshot === token) return cached.conn;
  const conn = new Connection(`${base}?token=${token}`, {
    commitment: 'confirmed',
    httpHeaders: teeHeaders(base),
  });
  connCache.set(base, { conn, tokenSnapshot: token });
  return conn;
}
