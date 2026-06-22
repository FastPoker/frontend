'use client';

import { useEffect, useState } from 'react';

export interface SngJackpotSnapshot {
  authority: string;
  miniPoolLamports: string;
  grandUnrefinedPool: string;
  handsSinceMiniHit: string;
  handsSinceGrandHit: string;
  miniOddsDenominator: string;
  grandOddsDenominator: string;
  activeMiniWeight: string;
  activeGrandWeight: string;
  hitSequence: string;
}

interface JackpotApiResponse {
  success: boolean;
  initialized?: boolean;
  pda?: string;
  fetchedAt?: number;
  state?: SngJackpotSnapshot;
  error?: string;
}

// Slow poll: the jackpot pools accrue gradually over hands, so a ~5min cadence
// keeps it visible at Minimal without adding sustained load to the free pool.
const CACHE_MS = 290_000;
let cached: JackpotApiResponse | null = null;
let cachedAt = 0;
let inflight: Promise<JackpotApiResponse> | null = null;

// Standalone: read the SNG jackpot global DIRECTLY from chain (one getAccountInfo,
// polled ~1/min). No backend.
async function loadJackpot(force = false): Promise<JackpotApiResponse> {
  // One getAccountInfo of the jackpot global — a single account, well under the
  // free pool's getMultipleAccounts >10 block, so it loads fine at Minimal.
  const now = Date.now();
  if (!force && cached && now - cachedAt < CACHE_MS) return cached;
  if (!force && inflight) return inflight;

  inflight = (async (): Promise<JackpotApiResponse> => {
    const { makeL1Connection } = await import('@/lib/constants');
    const { getJackpotGlobalPda, parseJackpotGlobal } = await import('@/lib/onchain-game');
    const conn = makeL1Connection();
    const [pda] = getJackpotGlobalPda();
    const acct = await conn.getAccountInfo(pda, 'confirmed');
    if (!acct) return { success: true, initialized: false, pda: pda.toBase58(), fetchedAt: Date.now() };
    const s = parseJackpotGlobal(Buffer.from(acct.data));
    return {
      success: true,
      initialized: true,
      pda: pda.toBase58(),
      fetchedAt: Date.now(),
      state: {
        authority: s.authority.toBase58(),
        miniPoolLamports: s.miniPoolLamports.toString(),
        grandUnrefinedPool: s.grandUnrefinedPool.toString(),
        handsSinceMiniHit: s.handsSinceMiniHit.toString(),
        handsSinceGrandHit: s.handsSinceGrandHit.toString(),
        miniOddsDenominator: s.miniOddsDenominator.toString(),
        grandOddsDenominator: s.grandOddsDenominator.toString(),
        activeMiniWeight: s.activeMiniWeight.toString(),
        activeGrandWeight: s.activeGrandWeight.toString(),
        hitSequence: s.hitSequence.toString(),
      },
    };
  })()
    .then((body) => { cached = body; cachedAt = Date.now(); return body; })
    .catch((e: any) => ({ success: false, error: e?.message || 'Failed to load jackpot state' } as JackpotApiResponse))
    .finally(() => { inflight = null; });

  return inflight;
}

export function useSngJackpotState(refreshMs = 300_000) {
  const [snapshot, setSnapshot] = useState<JackpotApiResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const refresh = (force = false) => {
      setLoading(!cached);
      loadJackpot(force)
        .then((body) => {
          if (!alive) return;
          setSnapshot(body);
          setError(body.success ? null : body.error || 'Jackpot state unavailable');
        })
        .catch((e: any) => {
          if (!alive) return;
          setError(e?.message || 'Jackpot state unavailable');
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    };

    refresh();
    const id = window.setInterval(() => refresh(), refreshMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [refreshMs]);

  return {
    state: snapshot?.initialized ? snapshot.state ?? null : null,
    initialized: !!snapshot?.initialized,
    loading,
    error,
    pda: snapshot?.pda ?? null,
    fetchedAt: snapshot?.fetchedAt ?? null,
  };
}
