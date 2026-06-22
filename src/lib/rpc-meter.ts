/**
 * Client-side L1 RPC usage meter.
 *
 * Helius (and most metered RPCs) bill per request, weighted by method:
 *   getProgramAccounts = 10 credits, getTransactionsForAddress = 10, Wallet/DAS
 *   methods = 100, everything standard (getAccountInfo, getMultipleAccounts,
 *   getLatestBlockhash, sendTransaction, …) = 1.
 *
 * Helius exposes NO usage API and NO credit headers (dashboard only), so we can't
 * read the provider's real number. Instead we count every L1 call we make (all L1
 * traffic flows through the rpc-pool fetch wrappers) and multiply by the weight
 * table — an accurate ESTIMATE that works for any provider, surfaced in the RPC
 * panel. On the free pool it's really a request count; on a metered RPC it's a
 * credit estimate. Totals roll over daily and persist in localStorage.
 */

// Methods that cost more than the standard 1 credit on Helius.
const WEIGHTS: Record<string, number> = {
  getProgramAccounts: 10,
  getTransactionsForAddress: 10,
  getAssetsByOwner: 100,
  getAssetsByGroup: 100,
  searchAssets: 100,
};
export function creditsFor(method: string): number {
  return WEIGHTS[method] ?? 1;
}

export interface RpcMeterSnapshot {
  date: string;
  calls: number;
  credits: number;
  byMethod: Record<string, { calls: number; credits: number }>;
}

const KEY = 'fp.rpcMeter.v1';

function today(): string {
  try {
    return new Date().toISOString().slice(0, 10);
  } catch {
    return '0000-00-00';
  }
}
function fresh(date: string): RpcMeterSnapshot {
  return { date, calls: 0, credits: 0, byMethod: {} };
}

function load(): RpcMeterSnapshot {
  if (typeof window === 'undefined') return fresh(today());
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && raw.date === today() && typeof raw.calls === 'number') return raw as RpcMeterSnapshot;
  } catch {
    /* ignore */
  }
  return fresh(today());
}

let snap: RpcMeterSnapshot = load();
const subs = new Set<(s: RpcMeterSnapshot) => void>();

function publish(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(snap));
  } catch {
    /* private mode / quota — keep counting in memory */
  }
  subs.forEach((fn) => fn(snap));
}

function bump(method: string): void {
  const base = snap.date === today() ? snap : fresh(today()); // roll over at midnight
  const c = creditsFor(method);
  const prev = base.byMethod[method] || { calls: 0, credits: 0 };
  // New object each time so React consumers re-render.
  snap = {
    date: base.date,
    calls: base.calls + 1,
    credits: base.credits + c,
    byMethod: { ...base.byMethod, [method]: { calls: prev.calls + 1, credits: prev.credits + c } },
  };
  publish();
}

/** Record one L1 RPC call from its JSON-RPC request body. Handles batch arrays. */
export function recordRpcCall(body: unknown): void {
  if (typeof body !== 'string') return;
  try {
    const parsed = JSON.parse(body);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const r of arr) if (r && typeof r.method === 'string') bump(r.method);
  } catch {
    /* non-JSON body — not an RPC call we can attribute */
  }
}

export function getRpcMeter(): RpcMeterSnapshot {
  return snap;
}
export function subscribeRpcMeter(fn: (s: RpcMeterSnapshot) => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
export function resetRpcMeter(): void {
  snap = fresh(today());
  publish();
}
