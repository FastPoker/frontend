'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';

import { makeL1Connection } from '@/lib/constants';
import { readStakeRewards } from '@/lib/stake';

export interface EarnPositionData {
  /** $FP burned (staked) by this wallet, in token units */
  burned: number;
  /** Wallet's share of pool as a percentage (0-100) */
  sharePercent: number;
  /** Total $FP staked in pool, in token units */
  totalPoolStaked: number;
  /** Claimable SOL from staking (lazy-computed) */
  pendingSol: number;
  /** Claimable $FP rake-share from staking (lazy-computed) */
  pendingPoker: number;
  /** Wallet's unstaked $FP balance (available to burn) */
  pokerBalance: number;
  loading: boolean;
  connected: boolean;
  refetch: () => Promise<void>;
}

const EMPTY: Omit<EarnPositionData, 'connected' | 'refetch'> = {
  burned: 0,
  sharePercent: 0,
  totalPoolStaked: 0,
  pendingSol: 0,
  pendingPoker: 0,
  pokerBalance: 0,
  loading: false,
};

/**
 * Wallet staking position, read fully client-side.
 *
 * `readStakeRewards` batches the staker's $FP ATA, their Stake PDA, and the
 * shared pool PDA into ONE getMultipleAccountsInfo (3 accounts, well under the
 * free public-pool's 10-account cap) and computes lazy pending SOL/$FP exactly
 * the way the on-chain ClaimStakeRewards IX would. No indexer, no server route.
 */
export function useEarnPosition(): EarnPositionData {
  const { isConnected: connected, publicKey } = useUnifiedWallet();
  const [data, setData] = useState<Omit<EarnPositionData, 'connected' | 'refetch'>>({
    ...EMPTY,
    loading: true,
  });

  const refetch = useCallback(async () => {
    if (!publicKey) {
      setData({ ...EMPTY });
      return;
    }
    setData((d) => ({ ...d, loading: true }));
    try {
      const conn = makeL1Connection();
      const view = await readStakeRewards(conn, publicKey);
      setData({
        burned: view.staked,
        sharePercent: view.yourSharePercent,
        totalPoolStaked: view.totalPoolStaked,
        pendingSol: view.pendingSol,
        pendingPoker: view.pendingPoker,
        pokerBalance: view.pokerBalance,
        loading: false,
      });
    } catch (err) {
      console.warn('[useEarnPosition] stake read failed', err);
      setData((d) => ({ ...d, loading: false }));
    }
  }, [publicKey]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { ...data, connected, refetch };
}
