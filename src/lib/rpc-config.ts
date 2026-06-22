/**
 * Central RPC endpoint resolution.
 *
 * Server-side (API routes, scripts): use `getL1Rpc()` — throws if no URL is set.
 * Client-side (browser bundles): import `L1_RPC_CLIENT` — empty string if no
 *   public URL is configured, so misconfig surfaces as an RPC failure rather
 *   than a hard crash during module init.
 *
 * URLs are read as env variables. There is no hardcoded provider URL anywhere.
 *
 * Recommended setup (production):
 *   Server:  L1_RPC=<full upstream URL with key>  (also feeds the /rpc rewrite)
 *   Client:  NEXT_PUBLIC_L1_RPC_URL=/rpc          (same-origin proxy, no CORS)
 *
 * Direct (no proxy) setup (development):
 *   Server:  L1_RPC=https://<provider>/?api-key=KEY
 *   Client:  NEXT_PUBLIC_L1_RPC_URL=https://<provider>/?api-key=KEY
 *
 * WebSocket subscriptions:
 *   Client:  NEXT_PUBLIC_L1_WS_URL=wss://<provider>/?api-key=KEY
 *
 * The browser cannot websocket-subscribe through the HTTP-only `/rpc` proxy.
 * If `NEXT_PUBLIC_L1_RPC_URL=/rpc`, configure `NEXT_PUBLIC_L1_WS_URL` or the
 * legacy public Helius key fallback below.
 *
 * Backward compatibility:
 *   The HELIUS_BASE_URL + HELIUS_API_KEY fallback exists for deployments that
 *   still set just an API key. New deployments should use the full URL above.
 */

function buildFromKey(base: string, key: string): string {
  if (!base || !key) return '';
  // Base may already contain trailing `?api-key=` (Helius shape) or any
  // other provider's prefix; we trust the deployer to set the exact base.
  return `${base}${key}`;
}

/**
 * Resolve a possibly-relative RPC URL to an absolute one. @solana/web3.js
 * Connection requires absolute URLs, so a same-origin `/rpc` rewrite must
 * be expanded against the current origin in the browser.
 */
function resolveBrowserUrl(raw: string): string {
  if (!raw) return '';
  if (raw.startsWith('/') && typeof window !== 'undefined') {
    return `${window.location.origin}${raw}`;
  }
  return raw;
}

function rpcToWsUrl(raw: string): string {
  const resolved = resolveBrowserUrl(raw);
  if (!resolved) return '';
  if (resolved.startsWith('wss://') || resolved.startsWith('ws://')) return resolved;
  if (resolved.startsWith('https://')) return `wss://${resolved.slice('https://'.length)}`;
  if (resolved.startsWith('http://')) return `ws://${resolved.slice('http://'.length)}`;
  return resolved;
}

function isSameOriginRpcProxy(raw: string): boolean {
  if (!raw) return false;
  if (raw === '/rpc' || raw.startsWith('/rpc/')) return true;
  if (typeof window === 'undefined') return false;
  try {
    const url = new URL(raw);
    return url.origin === window.location.origin && (url.pathname === '/rpc' || url.pathname.startsWith('/rpc/'));
  } catch {
    return false;
  }
}

function heliusWsFromPublicEnv(): string {
  const key = process.env.NEXT_PUBLIC_HELIUS_API_KEY || '';
  if (!key) return '';

  const base = process.env.NEXT_PUBLIC_HELIUS_BASE_URL || '';
  if (base) return rpcToWsUrl(buildFromKey(base, key));

  const cluster = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER || '').toLowerCase();
  const host = cluster.startsWith('mainnet') ? 'mainnet.helius-rpc.com' : 'devnet.helius-rpc.com';
  return `wss://${host}/?api-key=${key}`;
}

// --- Client-safe export ---------------------------------------------------
// IMPORTANT: only read `NEXT_PUBLIC_L1_RPC_URL` here. Next.js inlines every
// `process.env.NEXT_PUBLIC_*` reference at build time, so reading the legacy
// Helius base/key vars would bake their values into the browser bundle even
// if the resolver didn't use them. Legacy fallbacks live in the server
// helper below — server bundles never ship to the browser.
// Browser-safe default: the app ships a same-origin /rpc proxy, so use it when
// the public client RPC env is missing. Empty used to reach @solana/web3.js,
// which crashes the page while constructing a WebSocket from "".
const PUBLIC_L1_RPC_URL = process.env.NEXT_PUBLIC_L1_RPC_URL || '/rpc';
const PUBLIC_L1_WS_URL = process.env.NEXT_PUBLIC_L1_WS_URL || '';

/**
 * Returns the L1 RPC URL for browser use. Resolved at call time so
 * `/rpc`-style relative paths expand against `window.location.origin`.
 */
export function getClientL1Rpc(): string {
  return resolveBrowserUrl(PUBLIC_L1_RPC_URL);
}

export function getClientL1WsRpc(): string {
  const explicit = rpcToWsUrl(PUBLIC_L1_WS_URL);
  if (explicit) return explicit;

  const rpc = getClientL1Rpc();
  if (isSameOriginRpcProxy(rpc)) return heliusWsFromPublicEnv();
  return rpcToWsUrl(rpc);
}

// Back-compat: existing call sites import this directly. In SSR this will
// be the relative path; on client hydration the module re-evaluates and
// resolves to absolute.
export const L1_RPC_CLIENT = getClientL1Rpc();
export const L1_WS_RPC_CLIENT = getClientL1WsRpc();

// --- Server-side helper ---------------------------------------------------
/**
 * Returns the L1 RPC URL for server-side use.
 * Throws if no URL is configured — callers should not paper over this
 * with a hardcoded fallback.
 *
 * Server-side must use an absolute URL. `NEXT_PUBLIC_L1_RPC_URL` may be set
 * to `/rpc` for the browser (same-origin proxy via next.config.js rewrites),
 * which is meaningless server-side — that value is skipped here.
 */
export function getL1Rpc(): string {
  if (process.env.L1_RPC) return process.env.L1_RPC;

  // L1_RPC_PROXY_UPSTREAM is the absolute upstream URL the /rpc rewrite
  // forwards to. Accept it as a server-side fallback so a single env var
  // can drive both the rewrite target and direct server-side calls.
  if (process.env.L1_RPC_PROXY_UPSTREAM) return process.env.L1_RPC_PROXY_UPSTREAM;

  // NEXT_PUBLIC_L1_RPC_URL is browser-facing; only honor it server-side
  // when it's an absolute URL (the dev "browser hits provider directly" mode).
  // A relative `/rpc` value is rejected here so server code surfaces the
  // missing-config error instead of crashing on `new URL('/rpc')`.
  const pub = process.env.NEXT_PUBLIC_L1_RPC_URL || '';
  if (pub && !pub.startsWith('/')) return pub;

  // Backward-compat: build from key + base if both are set.
  const base = process.env.HELIUS_BASE_URL || process.env.NEXT_PUBLIC_HELIUS_BASE_URL || '';
  const key = process.env.HELIUS_API_KEY || process.env.NEXT_PUBLIC_HELIUS_API_KEY || '';
  const constructed = buildFromKey(base, key);
  if (constructed) return constructed;

  throw new Error(
    'RPC not configured server-side: set L1_RPC (absolute URL) in your environment. ' +
    'NEXT_PUBLIC_L1_RPC_URL=/rpc is for the browser only. See .env.example.',
  );
}
