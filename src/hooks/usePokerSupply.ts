'use client';

import { useEffect, useState } from 'react';
import { Connection } from '@solana/web3.js';

import { makeL1Connection, POKER_MINT } from '@/lib/constants';

const ONE_WHOLE_BASE = BigInt(1_000_000_000);
const WHOLE_PER_BUCKET = BigInt(10_000_000);

export interface PokerSupplyView {
  supplyBase: bigint | null;
  wholeSupply: number;
  bucket: number;
  loading: boolean;
  errored: boolean;
}

const INITIAL: PokerSupplyView = {
  supplyBase: null,
  wholeSupply: 0,
  bucket: 0,
  loading: true,
  errored: false,
};

// Shared module-level cache. Mint supply moves slowly, so we poll once per
// 6 minutes and fan the result out to every subscriber. This is a direct
// single-account RPC read kept in the client.
const REFRESH_MS = 360_000; // slow poll (~6min): supply moves slowly, keep free pool light
let snapshot: PokerSupplyView = INITIAL;
let lastFetchTs = 0;
const subscribers = new Set<(v: PokerSupplyView) => void>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let directConnection: Connection | null = null;
let inflight: Promise<void> | null = null;

function buildView(supplyBase: bigint | null, errored: boolean): PokerSupplyView {
  const wholeSupply = supplyBase === null ? 0 : Number(supplyBase / ONE_WHOLE_BASE);
  const bucketRaw =
    supplyBase === null
      ? 0
      : Number(supplyBase / ONE_WHOLE_BASE / WHOLE_PER_BUCKET);
  return {
    supplyBase,
    wholeSupply,
    bucket: Math.min(99, Math.max(0, bucketRaw)),
    loading: supplyBase === null && !errored,
    errored,
  };
}

function publish(next: PokerSupplyView) {
  snapshot = next;
  subscribers.forEach((fn) => fn(next));
}

async function readDirect(): Promise<PokerSupplyView | null> {
  // On-chain POKER supply (CIRC stat). One getTokenSupply — a single account, not
  // hit by the free pool's getMultipleAccounts >10 block — polled slowly (~6min),
  // so it shows at Minimal without adding sustained free-pool load.
  try {
    if (!directConnection) directConnection = makeL1Connection();
    const res = await directConnection.getTokenSupply(POKER_MINT);
    return buildView(BigInt(res.value.amount), false);
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
      lastFetchTs = Date.now();
      return;
    }
    publish(buildView(snapshot.supplyBase, true));
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function startPolling() {
  if (intervalHandle !== null) return;

  if (Date.now() - lastFetchTs > REFRESH_MS) void fetchOnce();
  intervalHandle = setInterval(fetchOnce, REFRESH_MS);
}

function stopPolling() {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function usePokerSupply(): PokerSupplyView {
  const [state, setState] = useState<PokerSupplyView>(snapshot);

  useEffect(() => {
    subscribers.add(setState);
    setState(snapshot);
    if (subscribers.size === 1) startPolling();
    return () => {
      subscribers.delete(setState);
      if (subscribers.size === 0) stopPolling();
    };
  }, []);

  return state;
}
