/**
 * Public RPC pool with failover (standalone MVP).
 *
 * No single free public Solana RPC reliably serves every request: each one
 * intermittently returns 403 / 429 (rate limit) or 5xx. So the default config
 * rotates across several free, CORS-friendly endpoints and fails over on error.
 * This lets the standalone work on public APIs out of the box with no key.
 *
 * A user who wants reliability/responsiveness sets NEXT_PUBLIC_L1_RPC_URL to
 * their own single endpoint (then this pool is not used). They can also override
 * the pool list via NEXT_PUBLIC_L1_RPC_POOL (comma-separated URLs).
 */
import { Connection, type Commitment, type ConnectionConfig } from '@solana/web3.js';
import { getEffectiveRpcUrl } from './user-config';
import { reportHealth } from './system-health';
import { recordRpcCall } from './rpc-meter';

// Free, public, CORS-enabled mainnet endpoints. As of testing, PublicNode is the
// ONLY reliable free no-key endpoint that serves getMultipleAccounts/getAccountInfo
// (200 + CORS). The rest now 403/429 without a key (api.mainnet-beta = "Access
// forbidden", onfinality/ankr/alchemy-demo/blockeden = rate-limited, drpc = paid
// only), so listing them as primaries just burns a failed round-trip per read.
// onfinality is kept as a thin last-resort fallback (occasionally serves). Even
// PublicNode rate-limits under burst — for reliability, bring your own RPC.
const DEFAULT_PUBLIC_POOL = [
  'https://solana-rpc.publicnode.com',
  'https://solana.api.onfinality.io/public',
];

const DEFAULT_DEVNET_POOL = [
  'https://api.devnet.solana.com',
];

export function getPublicPool(): string[] {
  const raw = process.env.NEXT_PUBLIC_L1_RPC_POOL;
  if (raw && raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  const cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER || 'mainnet';
  return cluster === 'devnet' ? DEFAULT_DEVNET_POOL : DEFAULT_PUBLIC_POOL;
}

/**
 * True when no single RPC is configured (so we use the pool), or when the user
 * explicitly selected the "pool" sentinel. An explicit same-origin `/rpc`
 * build config is a real operator-hosted endpoint and must not be treated as
 * pool.
 */
export function shouldUsePool(): boolean {
  const byo = getEffectiveRpcUrl();
  return !byo || byo.toLowerCase() === 'pool';
}

// Sticky index: once an endpoint works we keep using it until it fails.
let stickyIndex = 0;

// Free public RPCs hard-reject concurrent bursts (403/429). Tested: PublicNode serves
// getMultipleAccounts 200 sequentially but 403s under a burst. So we serialize pool
// fetches (1 at a time) and retry the rotation a couple of rounds with backoff —
// sequential traffic public endpoints tolerate.
const MAX_CONCURRENT = 1;
// Two passes: one retry with backoff for a genuinely transient reject. More than
// that just amplifies load against an already rate-limited free endpoint (tested:
// extra rounds produced MORE 403s, not more successes — the limit is sustained,
// not per-burst). Free RPC is inherently best-effort; for reliability set your
// own RPC (or an operator proxy). The 20s read cache bounds steady-state load.
const RETRY_ROUNDS = 2;
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}
function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fetch() that ignores the URL web3.js passes and routes the JSON-RPC POST
 * across the pool, advancing past any 403/429/5xx/network error. Concurrency is
 * capped to avoid burst rate-limits on free public endpoints.
 */
export function makeRotatingFetch(endpoints: string[]): typeof fetch {
  const eps = endpoints.length ? endpoints : DEFAULT_PUBLIC_POOL;
  return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    recordRpcCall(init?.body); // one logical RPC call (retries don't re-count)
    await acquire();
    try {
      let lastErr: unknown;
      let failedOver = false;
      const totalAttempts = eps.length * RETRY_ROUNDS;
      for (let attempt = 0; attempt < totalAttempts; attempt++) {
        const round = Math.floor(attempt / eps.length);
        const i = (stickyIndex + attempt) % eps.length;
        try {
          const res = await fetch(eps[i], init);
          if (res.status === 403 || res.status === 429 || res.status >= 500) {
            lastErr = new Error(`rpc ${eps[i]} -> ${res.status}`);
            failedOver = true;
            // Backoff grows each round so a rate-limited endpoint gets a chance to recover.
            await sleep(150 + round * 400);
            continue;
          }
          stickyIndex = i; // stick to the endpoint that just worked
          // Liveness: clean success vs recovered-after-failover (a flapping pool).
          reportHealth('rpc', failedOver ? 'degraded' : 'ok', failedOver ? 'recovered via fallback' : undefined);
          return res;
        } catch (e) {
          lastErr = e;
          failedOver = true;
          await sleep(150 + round * 400);
          continue;
        }
      }
      reportHealth('rpc', 'down', 'all public RPCs failed');
      throw lastErr instanceof Error ? lastErr : new Error('all public RPC endpoints failed');
    } finally {
      release();
    }
  }) as typeof fetch;
}

/**
 * Wrap a fetch so every L1 RPC call updates the 'rpc' system-health channel.
 * Used for the single-endpoint (BYO RPC) path, which has no pool failover to
 * derive health from. The pool path reports inline in makeRotatingFetch.
 */
export function makeHealthFetch(base?: typeof fetch): typeof fetch {
  const f = base || fetch;
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    recordRpcCall(init?.body); // count credits for the BYO / operator-RPC path
    try {
      const res = await f(input, init);
      if (res.ok) reportHealth('rpc', 'ok');
      else reportHealth('rpc', res.status >= 500 ? 'down' : 'degraded', `http ${res.status}`);
      return res;
    } catch (e) {
      reportHealth('rpc', 'down', 'unreachable');
      throw e;
    }
  }) as typeof fetch;
}

/** Build a Connection backed by the rotating public pool. */
export function makePublicPoolConnection(commitment: Commitment = 'confirmed'): Connection {
  const eps = getPublicPool();
  const cfg: ConnectionConfig = {
    commitment,
    fetch: makeRotatingFetch(eps),
    disableRetryOnRateLimit: true,
  };
  return new Connection(eps[stickyIndex % eps.length], cfg);
}
