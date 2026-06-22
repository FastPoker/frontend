import { Commitment, Connection } from '@solana/web3.js';

type BlockhashResult = { blockhash: string; lastValidBlockHeight: number };

// Short-TTL in-flight de-dupe per commitment. A single page can fire many
// blockhash requests in one burst (e.g. /earn simulates every staker SPL vault,
// and each sim wants a recent blockhash) — a recent blockhash is interchangeable
// across those near-simultaneous sims, so collapse the burst into ONE /api/blockhash
// round-trip. The 2s TTL keeps signing paths (claim/burn) fresh. Fixes the
// "N+1 API Call" Sentry perf issue on /earn.
const BH_TTL_MS = 2000;
const bhCache = new Map<Commitment, { p: Promise<BlockhashResult>; ts: number }>();

/**
 * Browser-only helper that prefers the indexer-backed /api/blockhash proxy
 * (one cheap same-origin HTTP hop, no Helius credit) and falls back to the
 * supplied Connection's getLatestBlockhash on any failure (timeout, non-2xx,
 * malformed payload). Return shape matches web3.js so this is drop-in for
 * `connection.getLatestBlockhash(commitment)`.
 *
 * Only use this for L1 blockhashes. TEE / ER connections must keep calling
 * their own getLatestBlockhash directly — the indexer only tracks L1.
 */
export async function getLatestBlockhashClient(
  connection: Connection,
  commitment: Commitment = 'confirmed',
  opts: { timeoutMs?: number } = {},
): Promise<BlockhashResult> {
  const cached = bhCache.get(commitment);
  if (cached && Date.now() - cached.ts < BH_TTL_MS) return cached.p;

  const p = (async (): Promise<BlockhashResult> => {
    try {
      const res = await fetch(`/api/blockhash?commitment=${commitment}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
      });
      if (res.ok) {
        const body = (await res.json()) as { blockhash?: string; lastValidBlockHeight?: number };
        if (body.blockhash && typeof body.lastValidBlockHeight === 'number') {
          return { blockhash: body.blockhash, lastValidBlockHeight: body.lastValidBlockHeight };
        }
      }
    } catch {
      // network / timeout / abort — fall through to direct RPC
    }
    return connection.getLatestBlockhash(commitment);
  })();

  bhCache.set(commitment, { p, ts: Date.now() });
  // Never pin a rejected promise — drop it so the next call retries fresh.
  p.catch(() => { if (bhCache.get(commitment)?.p === p) bhCache.delete(commitment); });
  return p;
}
