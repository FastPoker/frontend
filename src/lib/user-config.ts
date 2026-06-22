/**
 * Runtime user config (localStorage). Lets a player set their own RPC from the
 * frontend without editing .env. Precedence for the effective RPC:
 *   localStorage (set via the in-app Settings panel)  >  build-time env  >  ''(pool)
 *
 * NEXT_PUBLIC_* env is inlined at build time and cannot change at runtime, so the
 * UI-set value lives in localStorage and is read at call time (browser only). The
 * Settings panel saves then reloads so the providers re-read the new endpoint.
 */
const RPC_KEY = 'fp.rpcUrl';
const WS_KEY = 'fp.wsUrl';

function ls(): Storage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

export function getUserRpcUrl(): string {
  return (ls()?.getItem(RPC_KEY) || '').trim();
}
export function getUserWsUrl(): string {
  return (ls()?.getItem(WS_KEY) || '').trim();
}

export function setUserRpc(rpcUrl: string, wsUrl?: string): void {
  const s = ls();
  if (!s) return;
  const rpc = (rpcUrl || '').trim();
  if (rpc) s.setItem(RPC_KEY, rpc); else s.removeItem(RPC_KEY);
  const ws = (wsUrl || '').trim();
  if (ws) s.setItem(WS_KEY, ws); else s.removeItem(WS_KEY);
}

export function clearUserRpc(): void {
  const s = ls();
  if (!s) return;
  s.removeItem(RPC_KEY);
  s.removeItem(WS_KEY);
}

/** True when the user explicitly forced the free public pool from Settings.
 *  The literal 'pool' sentinel makes "Free pool" actually use the pool even when
 *  the build baked in an env RPC (e.g. a Helius key in .env.local for testing) —
 *  otherwise clearing the override just fell back to that env URL and the modal
 *  lied about being on free. */
export function isPoolForced(): boolean {
  return getUserRpcUrl().toLowerCase() === 'pool';
}

/** Effective L1 RPC. Precedence: forced 'pool' > user URL > build-time env.
 *  Returns 'pool' when forced (shouldUsePool() recognizes that sentinel). */
export function getEffectiveRpcUrl(): string {
  return getUserRpcUrl() || (process.env.NEXT_PUBLIC_L1_RPC_URL || '').trim();
}
export function getEffectiveWsUrl(): string {
  if (isPoolForced()) return ''; // pool builds its own connection; ignore env WS
  return getUserWsUrl() || (process.env.NEXT_PUBLIC_L1_WS_URL || '').trim();
}

/** True when a real custom RPC URL is active — NOT the free pool, NOT the env
 *  default. Drives the "your endpoint vs free pool" UI label. */
export function hasUserRpc(): boolean {
  const u = getUserRpcUrl();
  return u.length > 0 && u.toLowerCase() !== 'pool';
}

// ── Request level: how much optional data the app loads/polls ───────────────
//   mvr    = minimum viable requests: SNG tiers + jackpot + balance only
//   higher = + footer prices, claimable totals, supply/pool stats, my-tables
//   full   = + cash/watch table enumeration (getProgramAccounts; needs good RPC)
export type RequestLevel = 'mvr' | 'higher' | 'full';
const LEVEL_KEY = 'fp.requestLevel';
const LEVEL_ORDER: Record<RequestLevel, number> = { mvr: 0, higher: 1, full: 2 };

export function getRequestLevel(): RequestLevel {
  const v = ls()?.getItem(LEVEL_KEY);
  return v === 'higher' || v === 'full' ? v : 'mvr';
}
export function setRequestLevel(level: RequestLevel): void {
  ls()?.setItem(LEVEL_KEY, level);
}
/** True if the current level is at least `min`. */
export function levelAtLeast(min: RequestLevel): boolean {
  return LEVEL_ORDER[getRequestLevel()] >= LEVEL_ORDER[min];
}
