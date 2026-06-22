'use client';

/**
 * Module-level singleton over `/api/my-sng-tables`. Previously polled by
 * both `ActiveTableBar` (layout-level, lives on every page) AND
 * `Lobby.tsx` (lobby page only) on independent 20s intervals — at 1000 CCU
 * that's ~360k req/hr per surface = 720k/hr to the same endpoint, plus the
 * underlying RPC cost the route pays (one expensive gPA-style scan per uncached
 * call). Now both consumers subscribe to a single poll loop and the
 * upstream call happens once per refresh window regardless of mount count.
 */

import { useEffect, useState } from 'react';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { levelAtLeast } from '@/lib/user-config';

export interface MyActiveTable {
  tablePda: string;
  type?: 'cash' | 'heads_up' | '6max' | '9max' | string;
  maxPlayers?: number;
  tier?: number;
  // Table.phase (0 Waiting · 1 Starting · 2 Preflop · …). The route already
  // returns it; surfaced here so the SNG placement tracker can narrate
  // SEATING (phase 0, seat exists) vs DEALING_IN (phase ≥ 1) after the PDA lands.
  phase?: number;
}

export interface MyActiveTablesSnapshot {
  tables: MyActiveTable[];
  loaded: boolean;
  asOfMs: number;
}

const INITIAL: MyActiveTablesSnapshot = { tables: [], loaded: false, asOfMs: 0 };
const REFRESH_MS = 20_000;
// Boosted cadence while the user is QUEUED for an SNG (set from
// ActiveTableBar). Seating used to be invisible for up to ~50s with the join
// modal closed (20s poll + the route's 30s cache), long enough to blind out.
// Boosted polls run every 5s with force=1 (cache bypass); the cost is bounded
// because only actively-queued users boost, and only until they're seated.
const BOOST_REFRESH_MS = 5_000;
let boosted = false;

let activeWallet: string | null = null;
let snapshot: MyActiveTablesSnapshot = INITIAL;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
// Start-time of the most recently PUBLISHED response. A force refresh breaks the
// single-flight guard (it must, to bypass the cache), so a forced full-scan can
// run concurrently with — and resolve before/after — a background poll. Without
// a recency guard, last-writer-wins lets a slow stale poll (the route's 30s
// cached snapshot) clobber a fresher forced result, e.g. a just-left table
// reappearing. We only publish a response that STARTED no earlier than the one
// already shown.
let lastPublishedAtMs = 0;
// Monotonic id of the latest started fetch, so only the most-recent fetch clears
// the inflight slot (a settling stale promise must not wipe a newer in-flight one).
let inflightSeq = 0;
const subscribers = new Set<(s: MyActiveTablesSnapshot) => void>();

function publish(next: MyActiveTablesSnapshot) {
  snapshot = next;
  subscribers.forEach((fn) => fn(next));
}

// `force` bypasses the route's 30s per-wallet cache. The background poll uses
// the cache (that's where the credit savings are — nobody changed anything);
// an explicit refresh (after the user joins/leaves, or the placement tracker)
// must read fresh so the user never waits ~30s to see their own action.
async function fetchOnce(walletStr: string, force = false): Promise<void> {
  if (inflight && !force) return inflight;
  const startedAt = Date.now();
  const mySeq = ++inflightSeq;
  const p = (async () => {
    const publishFallback = async () => {
      let rows: MyActiveTable[] = [];
      try {
        const { getMySngTablesOnChain } = await import('@/lib/api');
        rows = await getMySngTablesOnChain(walletStr);
      } catch {
        // Leave empty on RPC failure.
      }
      if (activeWallet === walletStr && startedAt >= lastPublishedAtMs) {
        lastPublishedAtMs = startedAt;
        publish({ tables: rows, loaded: true, asOfMs: startedAt });
      }
    };
    try {
      // LIGHT/static: no server route assumption. Detect seated SNG tables
      // on-chain via PlayerTableMarker over the pool table slots.
      if (!levelAtLeast('full')) {
        await publishFallback();
        return;
      }
      const url = `/api/my-sng-tables?wallet=${encodeURIComponent(walletStr)}${force ? '&force=1' : ''}`;
      const res = await fetch(url);
      if (!res.ok) {
        await publishFallback();
        return;
      }
      const data = await res.json();
      if (activeWallet !== walletStr) return;
      const tables: MyActiveTable[] = Array.isArray(data?.tables)
        ? data.tables.filter((t: any) => typeof t?.tablePda === 'string')
        : [];
      // Monotonic publish: never let an earlier-started response overwrite a
      // fresher one that already landed (the force-vs-background race).
      if (startedAt < lastPublishedAtMs) return;
      lastPublishedAtMs = startedAt;
      publish({ tables, loaded: true, asOfMs: startedAt });
    } catch {
      await publishFallback();
    } finally {
      // Only the latest-started fetch clears the slot, so a settling stale
      // promise can't wipe a newer in-flight one.
      if (inflightSeq === mySeq) inflight = null;
    }
  })();
  inflight = p;
  return p;
}

function startPolling() {
  if (intervalHandle !== null || !activeWallet) return;
  void fetchOnce(activeWallet, boosted);
  if (boosted) {
    // Queued users poll fast and fresh; no jitter needed for this small set.
    intervalHandle = setInterval(() => {
      if (activeWallet) void fetchOnce(activeWallet, true);
    }, BOOST_REFRESH_MS);
    return;
  }
  // Jittered start so 1000 tabs opening together don't synchronize.
  const phase = Math.random() * REFRESH_MS;
  const startTimer = setTimeout(() => {
    intervalHandle = setInterval(() => {
      if (activeWallet) void fetchOnce(activeWallet);
    }, REFRESH_MS);
  }, phase);
  // Treat the startTimer as the "interval handle" until the real one is set,
  // so stopPolling can cancel either.
  intervalHandle = startTimer as unknown as ReturnType<typeof setInterval>;
}

function stopPolling() {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    clearTimeout(intervalHandle as unknown as ReturnType<typeof setTimeout>);
    intervalHandle = null;
  }
}

function setActiveWallet(next: string | null) {
  if (activeWallet === next) return;
  activeWallet = next;
  publish(INITIAL);
  stopPolling();
  if (next && subscribers.size > 0) startPolling();
}

export function useMyActiveTables(): MyActiveTablesSnapshot {
  const { publicKey } = useUnifiedWallet();
  const [state, setState] = useState<MyActiveTablesSnapshot>(snapshot);

  useEffect(() => {
    setActiveWallet(publicKey ? publicKey.toBase58() : null);
  }, [publicKey]);

  useEffect(() => {
    subscribers.add(setState);
    setState(snapshot);
    if (publicKey && intervalHandle === null) startPolling();
    return () => {
      subscribers.delete(setState);
      if (subscribers.size === 0) stopPolling();
    };
  }, [publicKey]);

  return state;
}

/** Force a fresh fetch (e.g. right after a leave/join). */
export async function refreshMyActiveTables(): Promise<void> {
  if (activeWallet) await fetchOnce(activeWallet, /* force */ true);
}

/**
 * Switch the shared poll between the normal cached 20s cadence and the
 * boosted 5s cache-bypassing cadence. Called with `true` while the user is
 * queued for an SNG so seating is detected within seconds even when the join
 * modal is closed; called with `false` once they are seated or leave the
 * queue. Idempotent.
 */
export function setMyActiveTablesBoost(on: boolean): void {
  if (boosted === on) return;
  boosted = on;
  if (intervalHandle !== null) {
    stopPolling();
    startPolling();
  }
}
