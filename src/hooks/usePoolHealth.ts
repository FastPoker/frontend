'use client';

import { useEffect, useState } from 'react';
import { Connection } from '@solana/web3.js';

import { makeL1Connection } from '@/lib/constants';
import { readPoolHealth } from '@/lib/stake';

export interface PoolHealthView {
  totalPoolStaked: number;
  solDistributed: number;
  /** SOL waiting to be claimed by stakers. Total earned = solDistributed + solAvailable. */
  solAvailable: number;
  pokerDistributed: number;
  pokerAvailable: number;
  totalUnrefined: number;
  loading: boolean;
  errored: boolean;
}

const INITIAL: PoolHealthView = {
  totalPoolStaked: 0,
  solDistributed: 0,
  solAvailable: 0,
  pokerDistributed: 0,
  pokerAvailable: 0,
  totalUnrefined: 0,
  loading: true,
  errored: false,
};

// Shared module-level state. Every component that calls usePoolHealth()
// subscribes to the same poll loop instead of opening its own. Without this,
// the lobby alone fires 4× per 15s window (EmissionsStrip + the SizeInPlayToMint
// widget each invoke the hook independently), and FooterStrip adds another
// poll on every non-bare route.
//
// Direct RPC to L1, shared by all mounted consumers. This convenience read is
// intentionally kept in the client, not the standalone indexer.
const DEFAULT_POLL_MS = 420_000; // slow poll (~7min), staggered from supply; keeps free pool light
let snapshot: PoolHealthView = INITIAL;
const subscribers = new Set<(v: PoolHealthView) => void>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let directConnection: Connection | null = null;
let inflight: Promise<void> | null = null;

function publish(next: PoolHealthView) {
  snapshot = next;
  subscribers.forEach((fn) => fn(next));
}

async function readDirect(): Promise<PoolHealthView | null> {
  // On-chain pool/staking health (RAW/BURNED stats). One pool-PDA read (single
  // account, not blocked on the free pool), polled slowly (~7min) — shows at
  // Minimal without sustained free-pool load.
  try {
    if (!directConnection) directConnection = makeL1Connection();
    const view = await readPoolHealth(directConnection);
    return { ...view, loading: false, errored: false };
  } catch {
    return null;
  }
}

function fetchOnce(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const fromDirect = await readDirect();
    if (fromDirect) {
      publish(fromDirect);
      return;
    }
    publish({ ...snapshot, loading: false, errored: true });
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function startPolling(pollMs: number) {
  if (intervalHandle !== null) return;

  void fetchOnce();
  intervalHandle = setInterval(fetchOnce, pollMs);
}

function stopPolling() {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function usePoolHealth(pollMs = DEFAULT_POLL_MS): PoolHealthView {
  const [state, setState] = useState<PoolHealthView>(snapshot);

  useEffect(() => {
    subscribers.add(setState);
    setState(snapshot);
    if (subscribers.size === 1) startPolling(pollMs);
    return () => {
      subscribers.delete(setState);
      if (subscribers.size === 0) stopPolling();
    };
  }, [pollMs]);

  return state;
}
