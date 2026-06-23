/**
 * Shared JPV1 scanner used by /api/jackpots/* routes.
 *
 * Strategy:
 *   1. Indexer-first: when NEXT_PUBLIC_ENABLE_INDEXER=true, hit the unified
 *      indexer's /jackpots/* routes via JACKPOT_INDEXER_URL or INDEXER_BASE_URL.
 *      The paths under that base are unchanged so the standalone service still
 *      works if you point JACKPOT_INDEXER_URL=http://127.0.0.1:3199 at it directly.
 *   2. RPC scan: list recent FastPoker program signatures, batch-fetch
 *      parsed txs, decode the SPL Memo CPI bytes via
 *      `extractJpv1FromMemo`, dedupe and surface newest-first.
 *
 * Caches keyed by tunable buckets to keep RPC pressure manageable when
 * the indexer is unavailable.
 */
import { ANCHOR_PROGRAM_ID } from '@/lib/constants';
import { getL1Rpc } from '@/lib/rpc-config';
import { extractJpv1FromMemo, JackpotReceipt } from '@/lib/jpv1';
import { iterateTransactionsForAddress } from '@/lib/helius-tx';
import { getIndexerBaseUrl, indexerReadsEnabled } from '@/lib/indexer-env';

// Resolution order, only when NEXT_PUBLIC_ENABLE_INDEXER=true:
//   1. JACKPOT_INDEXER_URL — explicit override (legacy: pointed at standalone
//      service on port 3199; can still be used post-migration if you keep it
//      running side-by-side).
//   2. INDEXER_BASE_URL + '/jackpots' — the unified indexer, which absorbed the
//      JPV1 decoder + routes.
const JACKPOT_INDEXER_URL =
  indexerReadsEnabled()
    ? (process.env.JACKPOT_INDEXER_URL || (getIndexerBaseUrl() ? `${getIndexerBaseUrl()}/jackpots` : ''))
    : '';
const INDEXER_TIMEOUT_MS = 3_000;

const RECENT_CACHE_TTL_MS = 5_000;
const LEADERBOARD_CACHE_TTL_MS = 60_000;
const PER_HAND_CACHE_TTL_MS = 60_000;

/** Default page size for getSignaturesForAddress sweeps. */
const SIG_PAGE_SIZE = 1_000;
/** Hard ceiling on receipts cached/returned in a single sweep. */
const MAX_RECEIPTS = 200;

interface RecentCacheEntry {
  fetchedAt: number;
  receipts: JackpotReceipt[];
}

interface PerHandCacheEntry {
  fetchedAt: number;
  receipt: JackpotReceipt | null;
}

const recentCache = new Map<number, RecentCacheEntry>();
const perHandCache = new Map<string, PerHandCacheEntry>();
let leaderboardCache: { fetchedAt: number; receipts: JackpotReceipt[] } | null = null;

/**
 * Scan the FastPoker program's recent signatures and return all JPV1
 * receipts where `mini_hit || grand_hit`. Newest-first, deduped by
 * (txSig, table, hand_number).
 *
 * `targetCount` caps the result list. We page through `getSignaturesForAddress`
 * up to roughly `SIG_PAGE_SIZE` signatures (one page) by default, which is
 * plenty for /recent dashboards. Leaderboard callers ask for more.
 */
async function scanProgramForReceipts(targetCount: number, maxPages = 1): Promise<JackpotReceipt[]> {
  // Uses the shared transaction-history iterator: enhanced history fast path
  // when the provider supports it, standard Solana RPC fallback otherwise.
  const receipts: JackpotReceipt[] = [];
  const seen = new Set<string>();
  const cap = Math.max(targetCount, SIG_PAGE_SIZE * Math.max(1, maxPages));

  try {
    const pages = iterateTransactionsForAddress(getL1Rpc(), {
      address: ANCHOR_PROGRAM_ID.toBase58(),
      transactionDetails: 'full',
      sortOrder: 'desc',
      commitment: 'confirmed',
      filters: { status: 'succeeded' },
    }, { maxTxs: cap });

    for await (const txs of pages) {
      for (const tx of txs) {
        const decoded = extractJpv1FromMemo(tx);
        if (!decoded || decoded.length === 0) continue;
        for (const r of decoded) {
          if (!r.miniHit && !r.grandHit) continue;
          const key = `${r.txSig}:${r.table}:${r.handNumber}`;
          if (seen.has(key)) continue;
          seen.add(key);
          receipts.push(r);
        }
        if (receipts.length >= targetCount) break;
      }
      if (receipts.length >= targetCount) break;
    }
  } catch (err) {
    console.warn('[jackpot-scanner] scanProgramForReceipts failed:', err instanceof Error ? err.message : err);
  }

  receipts.sort((a, b) => {
    const at = a.blockTime ?? 0;
    const bt = b.blockTime ?? 0;
    if (at !== bt) return bt - at;
    return b.slot - a.slot;
  });

  return receipts;
}

/**
 * Fetch from the local jackpot-indexer service. Returns null if the
 * indexer is unset, unreachable, errored, or times out — callers fall
 * back to the RPC scan path in that case.
 */
async function fetchFromIndexer<T>(pathSuffix: string): Promise<T | null> {
  if (!JACKPOT_INDEXER_URL) return null;
  try {
    const url = `${JACKPOT_INDEXER_URL.replace(/\/$/, '')}${pathSuffix}`;
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Returns up to `limit` recent JPV1 receipts (newest-first). When the
 * indexer is configured we proxy to it; otherwise we fall back to the
 * RPC scan with a 5s in-memory cache keyed by `limit`.
 */
export async function getRecentReceipts(limit: number): Promise<JackpotReceipt[]> {
  const clamped = Math.max(1, Math.min(limit, MAX_RECEIPTS));

  if (JACKPOT_INDEXER_URL) {
    const body = await fetchFromIndexer<{ receipts: JackpotReceipt[] }>(
      `/recent?limit=${clamped}`,
    );
    if (body?.receipts) return body.receipts;
    // fall through to RPC scan
  }

  const now = Date.now();
  const cached = recentCache.get(clamped);
  if (cached && now - cached.fetchedAt < RECENT_CACHE_TTL_MS) {
    return cached.receipts;
  }
  const receipts = await scanProgramForReceipts(clamped, 1);
  const out = receipts.slice(0, clamped);
  recentCache.set(clamped, { fetchedAt: now, receipts: out });
  return out;
}

/**
 * Returns up to `MAX_RECEIPTS` receipts for leaderboard aggregation.
 * Indexer-first; RPC fallback caches 60s and pages 2 sig pages so we
 * have a wider window than /recent.
 */
export async function getLeaderboardReceipts(): Promise<JackpotReceipt[]> {
  if (JACKPOT_INDEXER_URL) {
    // Reuse the indexer's recent endpoint at MAX_RECEIPTS to seed the
    // leaderboard window. The unified indexer holds the full history in
    // MongoDB, so an upper bound of MAX_RECEIPTS keeps payloads manageable while
    // the existing top/biggest aggregation already has its dedicated
    // paths exposed by the route layer.
    const body = await fetchFromIndexer<{ receipts: JackpotReceipt[] }>(
      `/recent?limit=${MAX_RECEIPTS}`,
    );
    if (body?.receipts) return body.receipts;
  }

  const now = Date.now();
  if (leaderboardCache && now - leaderboardCache.fetchedAt < LEADERBOARD_CACHE_TTL_MS) {
    return leaderboardCache.receipts;
  }
  const receipts = await scanProgramForReceipts(MAX_RECEIPTS, 2);
  leaderboardCache = { fetchedAt: now, receipts };
  return receipts;
}

/**
 * Returns native indexer leaderboard payloads for `view=top` and
 * `view=biggest` when the indexer is configured. Returns null when the
 * indexer is unset/down so callers can fall back to the in-memory
 * aggregation built from `getLeaderboardReceipts`.
 */
export async function getIndexerLeaderboard(
  view: 'top' | 'biggest' | 'recent',
  limit: number,
): Promise<{ view: string; entries: any[] } | null> {
  if (!JACKPOT_INDEXER_URL) return null;
  return await fetchFromIndexer<{ view: string; entries: any[] }>(
    `/leaderboard?view=${encodeURIComponent(view)}&limit=${limit}`,
  );
}

function perHandKey(table: string, handNumber: number): string {
  return `${table}:${handNumber}`;
}

/**
 * Look up a JPV1 receipt by (table, hand_number). Caches both hits and
 * misses for 60s. Indexer-first; RPC fallback reuses the leaderboard
 * window, then a /recent style sweep.
 */
export async function findReceiptForHand(table: string, handNumber: number): Promise<JackpotReceipt | null> {
  const key = perHandKey(table, handNumber);
  const now = Date.now();
  const cached = perHandCache.get(key);
  if (cached && now - cached.fetchedAt < PER_HAND_CACHE_TTL_MS) {
    return cached.receipt;
  }

  // Indexer first when configured.
  if (JACKPOT_INDEXER_URL) {
    const body = await fetchFromIndexer<{ receipt: JackpotReceipt | null }>(
      `/hand/${encodeURIComponent(table)}/${handNumber}`,
    );
    if (body) {
      perHandCache.set(key, { fetchedAt: now, receipt: body.receipt ?? null });
      return body.receipt ?? null;
    }
    // fall through to RPC scan if indexer was unreachable
  }

  // Try the leaderboard window first (it's wider and usually warm).
  const leaderboard = await getLeaderboardReceipts();
  let match = leaderboard.find(r => r.table === table && r.handNumber === handNumber) ?? null;

  // If not present, do a smaller dedicated scan in case it's older than the cache.
  if (!match) {
    const recent = await getRecentReceipts(MAX_RECEIPTS);
    match = recent.find(r => r.table === table && r.handNumber === handNumber) ?? null;
  }

  perHandCache.set(key, { fetchedAt: now, receipt: match });
  return match;
}
