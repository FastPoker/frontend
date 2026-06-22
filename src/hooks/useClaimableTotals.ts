'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { toast } from 'sonner';

import { makeL1Connection,
  ANCHOR_PROGRAM_ID,
  PLAYER_CLAIMABLE_SOL_OFFSET,
  POKER_MINT,
  POOL_PDA,
  STEEL_PROGRAM_ID,
} from '@/lib/constants';
import { getPlayerPda } from '@/lib/pda';
import { buildClaimStakeRewardsTx, readStakeRewards } from '@/lib/stake';
import { usePrices } from '@/hooks/usePrices';
import { refreshWalletBalances } from '@/hooks/useWalletBalances';
import type { ClaimableTotals } from '@/components/claimable/ClaimableDropdown';
import { assertFunds, FUNDS_HINTS } from '@/lib/assertFunds';
import { confirmFundsAction } from '@/lib/funds-confirmation';
import { RAW_YIELD_NAME } from '@/lib/jackpot-format';

const CLAIM_SOL_WINNINGS_DISC = Buffer.from([47, 206, 17, 43, 28, 213, 74, 12]);
const STEEL_CLAIM_ALL_DISC = 6;

function getUnrefinedPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('unrefined'), owner.toBuffer()],
    STEEL_PROGRAM_ID,
  );
}

function getSteelMintAuthority(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool')],
    STEEL_PROGRAM_ID,
  );
}

export interface UseClaimableTotalsResult {
  totals: ClaimableTotals;
  loading: boolean;
  hasClaimable: boolean;
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
  onClaim: (key: 'poker' | 'sng' | 'stake') => Promise<void>;
}

const CLAIMABLE_REFRESH_MS = 30_000;

interface RawTotals {
  pokerUnrefined: number;
  pokerRefined: number;
  sngSol: number;
  stakingSol: number;
  /** Unix ms when this snapshot was captured. 0 means we have no data yet. */
  asOfMs: number;
}

const ZERO_TOTALS: RawTotals = {
  pokerUnrefined: 0,
  pokerRefined: 0,
  sngSol: 0,
  stakingSol: 0,
  asOfMs: 0,
};

// Shared poll loop. FooterStrip and ProfilePill both mount this hook in the
// global layout, plus the /earn page stacks additional consumers. The module
// owns one interval per connected wallet, and every consumer subscribes to the
// same direct-chain snapshot.
let walletStr: string | null = null;
let snapshot: RawTotals = ZERO_TOTALS;
let inflight: Promise<void> | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(t: RawTotals) => void>();

function publish(next: RawTotals) {
  snapshot = next;
  subscribers.forEach((fn) => fn(next));
}

async function readFromRpc(walletBase58: string): Promise<RawTotals | null> {
  // The player's OWN claimable winnings (SNG SOL + $FP + staking). Read at every
  // request level including Minimal — it's the user's funds, not a cosmetic stat,
  // and it's only one getMultipleAccounts + the stake read per poll.
  try {
    const publicKey = new PublicKey(walletBase58);
    const connection = makeL1Connection();
    const [playerPda] = getPlayerPda(publicKey);
    const [unrefinedPda] = getUnrefinedPda(publicKey);

    // Batch the three account reads into one getMultipleAccounts to stay light
    // on the free public-RPC budget.
    const [infos, stakeView] = await Promise.all([
      connection.getMultipleAccountsInfo([playerPda, unrefinedPda, POOL_PDA]),
      readStakeRewards(connection, publicKey).catch(() => null),
    ]);
    const [playerInfo, unrefinedInfo, poolInfo] = infos;

    let sngSol = 0;
    if (
      playerInfo &&
      playerInfo.data.length >= PLAYER_CLAIMABLE_SOL_OFFSET + 8
    ) {
      const lamports = Number(
        Buffer.from(playerInfo.data).readBigUInt64LE(
          PLAYER_CLAIMABLE_SOL_OFFSET,
        ),
      );
      sngSol = lamports / 1e9;
    }

    let pokerUnrefined = 0;
    let pokerRefined = 0;
    let unrefinedRaw = BigInt(0);
    let storedRefined = BigInt(0);
    let refinedDebt = BigInt(0);
    if (unrefinedInfo && unrefinedInfo.data.length >= 72) {
      const d = Buffer.from(unrefinedInfo.data);
      unrefinedRaw = d.readBigUInt64LE(40);
      storedRefined = d.readBigUInt64LE(48);
      const debtLo = d.readBigUInt64LE(56);
      const debtHi = d.readBigUInt64LE(64);
      refinedDebt = (debtHi << BigInt(64)) | debtLo;
      pokerUnrefined = Number(unrefinedRaw) / 1e6;
    }

    if (poolInfo && poolInfo.data.length >= 168) {
      const pd = Buffer.from(poolInfo.data);
      const accLo = pd.readBigUInt64LE(152);
      const accHi = pd.readBigUInt64LE(160);
      const accRefined = (accHi << BigInt(64)) | accLo;
      if (unrefinedRaw > BigInt(0) && accRefined > BigInt(0)) {
        const accumulated = unrefinedRaw * accRefined;
        const lazy =
          accumulated > refinedDebt
            ? (accumulated - refinedDebt) / BigInt(1_000_000_000_000)
            : BigInt(0);
        pokerRefined = Number(storedRefined + lazy) / 1e6;
      } else {
        pokerRefined = Number(storedRefined) / 1e6;
      }
    } else {
      pokerRefined = Number(storedRefined) / 1e6;
    }

    const stakingSol = stakeView?.pendingSol ?? 0;
    return { pokerUnrefined, pokerRefined, sngSol, stakingSol, asOfMs: Date.now() };
  } catch (err) {
    console.error('useClaimableTotals: direct RPC read failed', err);
    return null;
  }
}

async function loadOnce(walletBase58: string, force = false): Promise<void> {
  if (inflight && !force) return inflight;
  inflight = (async () => {
    const fromRpc = await readFromRpc(walletBase58);
    if (fromRpc && walletStr === walletBase58) {
      publish(fromRpc);
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function startPolling() {
  if (intervalHandle !== null || !walletStr) return;
  const w = walletStr;
  void loadOnce(w);
  intervalHandle = setInterval(() => {
    if (walletStr) void loadOnce(walletStr);
  }, CLAIMABLE_REFRESH_MS);
}

function stopPolling() {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function setActiveWallet(next: string | null) {
  if (walletStr === next) return;
  walletStr = next;
  publish(ZERO_TOTALS);
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (next && subscribers.size > 0) startPolling();
}

// Window-level listeners are attached once for the whole module, not per
// subscriber. Previously each hook instance bound its own focus + visibility
// listener, so a /earn page with 5 mounts of this hook fired 5 parallel
// refresh calls every time the user tabbed back.
let domListenersAttached = false;
function ensureDomListeners() {
  if (domListenersAttached || typeof window === 'undefined') return;
  domListenersAttached = true;
  const refreshIfWallet = () => {
    if (walletStr) void loadOnce(walletStr);
  };
  window.addEventListener('focus', refreshIfWallet);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshIfWallet();
  });
}

/**
 * Force a live direct-chain read right before sending a claim transaction so
 * we never submit against a stale balance. Updates the shared snapshot when it
 * completes so every subscriber gets the fresh value.
 */
export async function forceLiveRefresh(walletBase58: string): Promise<void> {
  if (inflight) await inflight;
  await loadOnce(walletBase58, /* force */ true);
}

/**
 * Optimistic zero of the claimed bucket(s). Call right after the claim TX
 * confirms so the UI snaps to 0 immediately, without waiting for fresh RPC
 * propagation. The next force-live read overwrites this with the chain's truth.
 *
 * Keys:
 *   - 'stake' = stakingSol  (Claim SOL Rewards on /earn)
 *   - 'sng'   = sngSol      (Claim SNG SOL winnings)
 *   - 'poker' = pokerUnrefined + pokerRefined  (Claim $FP rewards)
 */
export function markClaimedOptimistic(key: 'stake' | 'sng' | 'poker'): void {
  const next: RawTotals = { ...snapshot, asOfMs: Date.now() };
  if (key === 'stake') next.stakingSol = 0;
  else if (key === 'sng') next.sngSol = 0;
  else if (key === 'poker') {
    next.pokerUnrefined = 0;
    next.pokerRefined = 0;
  }
  publish(next);
}

/**
 * Aggregates pending rewards across four surfaces:
 *   - pokerUnrefined -> Steel UnrefinedPDA.unrefined_amount (your SNG emissions)
 *   - pokerRefined   -> Steel UnrefinedPDA.refined_amount + lazy accrual
 *                       from pool.acc_refined_per_token (passive share of others' burns)
 *   - sngSol         -> Anchor PlayerPDA.claimable_sol (SNG prize payouts)
 *   - stakingSol     -> Steel StakePDA lazy pendingSol (APY on staked $FP)
 *
 * ClaimStakeRewards also settles pending $FP rake-share on the stake side;
 * it is claimed atomically with stakingSol through the 'stake' button.
 */
export function useClaimableTotals(): UseClaimableTotalsResult {
  const { publicKey, sendTransaction } = useUnifiedWallet();
  const { solPrice, fpPrice } = usePrices();
  const [raw, setRaw] = useState<RawTotals>(snapshot);
  const [loading, setLoading] = useState(false);

  // Track wallet identity at module scope. The single source of truth is
  // walletStr; this effect keeps it in sync with the React-side wallet.
  useEffect(() => {
    const next = publicKey ? publicKey.toBase58() : null;
    setActiveWallet(next);
  }, [publicKey]);

  // Subscribe this React instance to the shared snapshot.
  useEffect(() => {
    subscribers.add(setRaw);
    setRaw(snapshot);
    ensureDomListeners();
    if (publicKey && intervalHandle === null) startPolling();
    return () => {
      subscribers.delete(setRaw);
      if (subscribers.size === 0) stopPolling();
    };
  }, [publicKey]);

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!publicKey) {
        publish(ZERO_TOTALS);
        return;
      }
      if (!opts?.silent) setLoading(true);
      try {
        await loadOnce(publicKey.toBase58());
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [publicKey],
  );

  const claimPoker = useCallback(async () => {
    if (!publicKey || !sendTransaction) return;
    // Force a live read before constructing the tx so the confirmation modal
    // shows the up-to-the-second amount, not a 15s-old cached value.
    await forceLiveRefresh(publicKey.toBase58());
    const liveTotals = snapshot;
    const connection = makeL1Connection();
    const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, publicKey);
    const [unrefinedPda] = getUnrefinedPda(publicKey);
    const [mintAuthority] = getSteelMintAuthority();
    const data = Buffer.alloc(1);
    data.writeUInt8(STEEL_CLAIM_ALL_DISC, 0);
    const ix = new TransactionInstruction({
      programId: STEEL_PROGRAM_ID,
      keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: unrefinedPda, isSigner: false, isWritable: true },
        { pubkey: POOL_PDA, isSigner: false, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: POKER_MINT, isSigner: false, isWritable: true },
        { pubkey: mintAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
    const tx = new Transaction();
    try {
      await getAccount(connection, tokenAccount);
    } catch {
      tx.add(
        createAssociatedTokenAccountInstruction(
          publicKey,
          tokenAccount,
          publicKey,
          POKER_MINT,
        ),
      );
    }
    tx.add(ix);
    tx.feePayer = publicKey;
    tx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
    if (!(await confirmFundsAction({
      title: 'Confirm $FP Claim',
      action: `Claim all ${RAW_YIELD_NAME}`,
      amount: `${liveTotals.pokerUnrefined.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${RAW_YIELD_NAME}`,
      transaction: tx,
    }))) {
      return;
    }
    await assertFunds({
      connection,
      payer: publicKey,
      requiredLamports: FUNDS_HINTS.TX_FEE_LAMPORTS,
      reason: 'Claiming requires a small SOL balance for the transaction fee.',
    });
    // Pre-simulate so we surface the real on-chain reason instead of
    // Phantom's generic "Unexpected error" when its own preflight rejects
    // the TX. Common $FP-claim failures: empty UnrefinedPda (nothing to
    // claim yet), Steel program/mintAuthority drift after a redeploy.
    try {
      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) {
        const logs = (sim.value.logs || []).slice(-6).join(' | ');
        throw new Error(`Claim simulation failed: ${JSON.stringify(sim.value.err)} — ${logs}`);
      }
    } catch (simErr: unknown) {
      if (simErr instanceof Error && simErr.message.startsWith('Claim simulation failed')) throw simErr;
      // Network error during simulate — let the real send try anyway.
    }
    const sig = await sendTransaction(tx, connection);
    await connection.confirmTransaction(sig, 'confirmed');
  }, [publicKey, sendTransaction]);

  const claimSng = useCallback(async () => {
    if (!publicKey || !sendTransaction) return;
    await forceLiveRefresh(publicKey.toBase58());
    const liveTotals = snapshot;
    const connection = makeL1Connection();
    const [playerPda] = getPlayerPda(publicKey);
    const ix = new TransactionInstruction({
      programId: ANCHOR_PROGRAM_ID,
      keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: playerPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: CLAIM_SOL_WINNINGS_DISC,
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = publicKey;
    tx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
    if (!(await confirmFundsAction({
      title: 'Confirm SOL Claim',
      action: 'Claim SNG SOL winnings',
      amount: `${liveTotals.sngSol.toFixed(6).replace(/\.?0+$/, '')} SOL`,
      transaction: tx,
    }))) {
      return;
    }
    await assertFunds({
      connection,
      payer: publicKey,
      requiredLamports: FUNDS_HINTS.TX_FEE_LAMPORTS,
      reason: 'Claiming requires a small SOL balance for the transaction fee.',
    });
    const sig = await sendTransaction(tx, connection);
    await connection.confirmTransaction(sig, 'confirmed');
  }, [publicKey, sendTransaction]);

  const claimStake = useCallback(async () => {
    if (!publicKey || !sendTransaction) return;
    await forceLiveRefresh(publicKey.toBase58());
    const liveTotals = snapshot;
    const connection = makeL1Connection();
    const tx = await buildClaimStakeRewardsTx(connection, publicKey);
    if (!(await confirmFundsAction({
      title: 'Confirm Stake Claim',
      action: 'Claim staking SOL rewards',
      amount: `${liveTotals.stakingSol.toFixed(6).replace(/\.?0+$/, '')} SOL`,
      transaction: tx,
    }))) {
      return;
    }
    await assertFunds({
      connection,
      payer: publicKey,
      requiredLamports: FUNDS_HINTS.TX_FEE_LAMPORTS,
      reason: 'Claiming requires a small SOL balance for the transaction fee.',
    });
    const sig = await sendTransaction(tx, connection);
    await connection.confirmTransaction(sig);
  }, [publicKey, sendTransaction]);

  const onClaim = useCallback(
    async (key: 'poker' | 'sng' | 'stake') => {
      const runner =
        key === 'poker' ? claimPoker : key === 'sng' ? claimSng : claimStake;
      const label =
        key === 'poker'
          ? '$FP from SNG'
          : key === 'sng'
            ? 'SOL from SNG'
            : 'SOL from staking';
      // Lazy-import metrics so this module stays usable in non-browser contexts.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const M = require('@/lib/sentry-metrics') as typeof import('@/lib/sentry-metrics');
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      try {
        await runner();
        toast.success(`${label} claimed`);
        // Snap UI to 0 first so the user sees the result the instant their
        // wallet confirms, then force-live read to confirm against chain.
        // Without the optimistic zero, even forceLiveRefresh leaves a
        // ~200-500ms gap during the RPC roundtrip where the old value lingers.
        markClaimedOptimistic(key);
        if (publicKey) {
          await forceLiveRefresh(publicKey.toBase58());
          // Also nudge the parallel useWalletBalances singleton (FooterStrip
          // pill + balances pull from there).
          void refreshWalletBalances();
        } else {
          await refresh();
        }
        M.count(M.NAMES.CLAIM_ATTEMPT, 1, { kind: key, result: 'success' });
        M.distribution(M.NAMES.CLAIM_ATTEMPT + '.duration', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0, { kind: key, result: 'success' }, 'millisecond');
      } catch (err) {
        console.error(`${label} claim failed`, err);
        toast.error(`${label} claim failed`);
        // Distinguish user-cancelled wallet popups from real failures —
        // those are noise, not anomalies.
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        const cancelled = /user rejected|cancelled|user denied|transaction cancelled/.test(msg);
        M.count(M.NAMES.CLAIM_ATTEMPT, 1, { kind: key, result: cancelled ? 'cancelled' : 'failure' });
        throw err;
      }
    },
    [claimPoker, claimSng, claimStake, refresh],
  );

  // Memoized so the reference is STABLE across renders when the underlying
  // values don't change. Without this, every consumer got a fresh `totals`
  // object each render — and any effect listing `totals` in its deps (e.g. the
  // earn page's primary-vault RPC simulate) re-fired on EVERY render, an
  // unbounded simulate + setState loop that froze the whole tab.
  const totals: ClaimableTotals = useMemo(() => ({
    pokerUnrefined: raw.pokerUnrefined,
    pokerRefined: raw.pokerRefined,
    sngSol: raw.sngSol,
    stakingSol: raw.stakingSol,
    asOfMs: raw.asOfMs,
    solPrice,
    fpPrice,
  }), [raw.pokerUnrefined, raw.pokerRefined, raw.sngSol, raw.stakingSol, raw.asOfMs, solPrice, fpPrice]);

  const hasClaimable =
    totals.pokerUnrefined +
      totals.pokerRefined +
      totals.sngSol +
      totals.stakingSol >
    0.0001;

  return { totals, loading, hasClaimable, refresh, onClaim };
}
