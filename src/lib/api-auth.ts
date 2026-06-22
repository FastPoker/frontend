import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const SIGNATURE_FUTURE_SKEW_MS = 60 * 1000;

function allowedOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>([request.nextUrl.origin]);
  for (const raw of [process.env.APP_ORIGIN, process.env.NEXT_PUBLIC_APP_URL]) {
    if (!raw) continue;
    try {
      origins.add(new URL(raw).origin);
    } catch {}
  }
  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:3000');
    origins.add('http://localhost:3001');
    origins.add('http://localhost:3004');
    origins.add('http://localhost:3005');
    origins.add('http://127.0.0.1:3000');
    origins.add('http://127.0.0.1:3004');
    origins.add('http://127.0.0.1:3005');
  }
  return origins;
}

function isDevTunnelOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const { protocol, hostname } = new URL(origin);
    // Private LAN IPs (http or https) — for on-device mobile testing over the
    // LAN (e.g. https://10.10.10.x:3004). Dev-only; production returned above.
    if (/^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(hostname)) return true;
    if (protocol !== 'https:') return false;
    return hostname.endsWith('.trycloudflare.com') || hostname.endsWith('.loca.lt') || hostname.endsWith('.ngrok-free.app') || hostname.endsWith('.ngrok.app');
  } catch {
    return false;
  }
}

export function requireTrustedOrigin(request: NextRequest): NextResponse | null {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    return null;
  }
  const origin = request.headers.get('origin');
  if (!origin) {
    return NextResponse.json({ error: 'Origin required' }, { status: 403 });
  }
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return NextResponse.json({ error: 'Invalid Origin' }, { status: 403 });
  }
  if (!allowedOrigins(request).has(normalized) && !isDevTunnelOrigin(normalized)) {
    return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  }
  return null;
}

function decodeSignature(signature: string): Uint8Array {
  try {
    return Uint8Array.from(Buffer.from(signature, 'base64'));
  } catch {}
  return bs58.decode(signature);
}

export function requireWalletSignature(
  body: any,
  purpose: string,
  walletField = 'wallet',
): NextResponse | null {
  const wallet = body?.[walletField] || body?.playerPubkey;
  const auth = body?.auth || body;
  const message = auth?.message;
  const signature = auth?.signature;

  if (!wallet || !message || !signature) {
    return NextResponse.json({ error: 'wallet, message, and signature required' }, { status: 401 });
  }

  const walletLine = String(message).split('\n').find((line: string) => line.startsWith('Wallet: '));
  if (!walletLine || walletLine.slice('Wallet: '.length).trim() !== wallet) {
    return NextResponse.json({ error: 'Wallet mismatch in signed message' }, { status: 401 });
  }

  const purposeLine = String(message).split('\n').find((line: string) => line.startsWith('Purpose: '));
  if (purposeLine && purposeLine.slice('Purpose: '.length).trim() !== purpose) {
    return NextResponse.json({ error: 'Purpose mismatch in signed message' }, { status: 401 });
  }

  const issuedLine = String(message).split('\n').find((line: string) => line.startsWith('Issued: '));
  if (!issuedLine) {
    return NextResponse.json({ error: 'Missing Issued field' }, { status: 401 });
  }
  const issuedMs = new Date(issuedLine.slice('Issued: '.length).trim()).getTime();
  const nowMs = Date.now();
  if (!Number.isFinite(issuedMs) || issuedMs < nowMs - SIGNATURE_MAX_AGE_MS || issuedMs > nowMs + SIGNATURE_FUTURE_SKEW_MS) {
    return NextResponse.json({ error: 'Signature expired', code: 'STALE_SIGNATURE' }, { status: 401 });
  }

  try {
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      decodeSignature(signature),
      new PublicKey(wallet).toBytes(),
    );
    if (!ok) {
      return NextResponse.json({ error: 'Invalid signature', code: 'BAD_SIGNATURE' }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid signature', code: 'BAD_SIGNATURE' }, { status: 401 });
  }

  return null;
}
