'use client';

import { useEffect, useState } from 'react';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { reportHealth } from '@/lib/system-health';

export interface WalletBalances {
  solBalance: number;
  pokerBalance: number;
  staked: number;
  pokerUnrefined: number;
  pokerRefined: number;
  stakingSol: number;
  pendingPoker: number;
  /** XP from PlayerPDA. 0 if unregistered. */
  xp: number;
  /** Total $FP burned/staked across the whole pool (used by /earn share math). */
  totalPoolStaked: number;
  asOfMs: number;
  loading: boolean;
  errored: boolean;
}

const INITIAL: WalletBalances = {
  solBalance: 0,
  pokerBalance: 0,
  staked: 0,
  pokerUnrefined: 0,
  pokerRefined: 0,
  stakingSol: 0,
  pendingPoker: 0,
  xp: 0,
  totalPoolStaked: 0,
  asOfMs: 0,
  loading: true,
  errored: false,
};

// Shared module-level state per wallet. Every component that calls
// useWalletBalances() with the same connected wallet subscribes to the same
// poll loop. The lobby + footer + any panel that wants the user's balances
// share one direct SOL-balance read per refresh window in standalone mode.
const REFRESH_MS = 15_000;
let activeWallet: string | null = null;
let snapshot: WalletBalances = INITIAL;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
const subscribers = new Set<(b: WalletBalances) => void>();

function publish(next: WalletBalances) {
  snapshot = next;
  subscribers.forEach((fn) => fn(next));
}

async function readDirectSol(walletStr: string): Promise<WalletBalances | null> {
  try {
    const { makeL1Connection } = await import('@/lib/constants');
    const { PublicKey } = await import('@solana/web3.js');
    const lamports = await makeL1Connection().getBalance(new PublicKey(walletStr));
    return { ...snapshot, solBalance: lamports / 1e9, asOfMs: Date.now(), loading: false, errored: false };
  } catch {
    return null;
  }
}

async function fetchOnce(walletStr: string): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const direct = await readDirectSol(walletStr);
      if (activeWallet !== walletStr) return; // wallet changed mid-flight
      if (direct) publish(direct);
      else publish({ ...snapshot, loading: false, errored: true });
    } catch {
      reportHealth('rpc', 'degraded', 'wallet balance fetch failed');
      publish({ ...snapshot, loading: false, errored: true });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function startPolling() {
  if (intervalHandle !== null || !activeWallet) return;
  const w = activeWallet;
  void fetchOnce(w);
  intervalHandle = setInterval(() => {
    if (activeWallet) void fetchOnce(activeWallet);
  }, REFRESH_MS);
}

function stopPolling() {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function setActiveWallet(next: string | null) {
  if (activeWallet === next) return;
  activeWallet = next;
  publish(INITIAL);
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (next && subscribers.size > 0) startPolling();
}

/**
 * Per-wallet balance snapshot. The standalone source release keeps this light:
 * one direct SOL-balance read, shared across all mounted consumers.
 */
export function useWalletBalances(): WalletBalances {
  const { publicKey } = useUnifiedWallet();
  const [state, setState] = useState<WalletBalances>(snapshot);

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

/** Force a fresh read (e.g. right after a transaction). */
export async function refreshWalletBalances(): Promise<void> {
  if (!activeWallet) return;
  const wallet = activeWallet;
  const direct = await readDirectSol(wallet);
  if (direct && activeWallet === wallet) publish(direct);
}
