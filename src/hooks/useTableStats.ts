'use client';

import { useEffect, useState } from 'react';
import { INDEXER_API_ENABLED } from '@/lib/feature-flags';

/**
 * Per-table lobby stats (Avg Pot / VPIP / Hands per Hour) for the cash
 * table list. Powered by the indexer's table-stats domain (24h rolling
 * window, refreshed every 5min in-memory on the indexer).
 *
 * Optimization notes:
 *  - Single batched fetch for ALL visible PDAs, not per-row. Lobby renders
 *    one hook for the whole list and pipes the result into each row.
 *  - Module-level 60s cache shared across mounts so re-rendering the lobby
 *    (filter toggles, tab switches) doesn't re-hit the indexer.
 *  - 30s refresh interval while mounted. Indexer cache is already at 5min
 *    granularity so anything tighter is wasted.
 *  - No Solana RPC calls anywhere — pure Mongo aggregation upstream.
 *  - Circuit-breaker in /api/indexer/[...path] short-circuits when the
 *    indexer is down, so the hook fails fast and rows just show `-`.
 */

export interface TableStats {
  /** Average final pot size over the window, in lamports. */
  avgPotLamports: number;
  /** 0..1, fraction of seat-hands that voluntarily put money in preflop. */
  vpip: number;
  /** Hands per hour over the window. */
  handsPerHour: number;
  /** Hand count contributing to the aggregates. */
  handCount: number;
  /** Unix ms when this snapshot was computed by the indexer. */
  asOfMs: number;
}

interface CacheEntry {
  stats: Record<string, TableStats | null>;
  fetchedAtMs: number;
}

const CACHE_TTL_MS = 60_000;
const REFRESH_MS = 30_000;
const moduleCache = new Map<string, CacheEntry>();
const inflight: Map<string, Promise<Record<string, TableStats | null>>> = new Map();

function cacheKeyFor(pdas: string[]): string {
  return [...pdas].sort().join(',');
}

async function fetchTableStats(pdas: string[]): Promise<Record<string, TableStats | null>> {
  if (!INDEXER_API_ENABLED || pdas.length === 0) return {};
  const key = cacheKeyFor(pdas);
  const cached = moduleCache.get(key);
  if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
    return cached.stats;
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      const res = await fetch(`/api/indexer/tables/stats?pdas=${encodeURIComponent(pdas.join(','))}`, {
        cache: 'no-store',
      });
      if (!res.ok) return {} as Record<string, TableStats | null>;
      const data = await res.json();
      const stats = (data?.stats || {}) as Record<string, TableStats | null>;
      moduleCache.set(key, { stats, fetchedAtMs: Date.now() });
      return stats;
    } catch {
      return {} as Record<string, TableStats | null>;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Returns a `{ pda → stats|null }` map for the requested table PDAs.
 * `null` for a PDA means the indexer has no hands for that table in the
 * last 24h window (fresh/quiet tables) — callers should render `-`.
 */
export function useTableStats(pdas: readonly string[]): {
  stats: Record<string, TableStats | null>;
  loading: boolean;
} {
  const sortedKey = [...pdas].sort().join(',');
  const [stats, setStats] = useState<Record<string, TableStats | null>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!INDEXER_API_ENABLED || pdas.length === 0) {
      setStats({});
      setLoading(false);
      return;
    }
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      const result = await fetchTableStats([...pdas]);
      if (!cancelled) {
        setStats(result);
        setLoading(false);
      }
    };

    void run();
    const id = window.setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // sortedKey is the canonical dependency — array identity changes on every
    // render but content stability is what we actually want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedKey]);

  return { stats, loading };
}
