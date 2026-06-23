'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Transaction } from '@solana/web3.js';
import { toast } from 'sonner';

import { PageHeadline } from '@/components/ui/PageHeadline';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { useClaimableTotals } from '@/hooks/useClaimableTotals';
import { usePokerSupply } from '@/hooks/usePokerSupply';
import { usePoolHealth } from '@/hooks/usePoolHealth';
import { refreshWalletBalances } from '@/hooks/useWalletBalances';
import { applyPriorityFee } from '@/lib/priority-fee';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { confirmFundsAction } from '@/lib/funds-confirmation';
import { makeL1Connection } from '@/lib/constants';
import { sendWalletTx } from '@/lib/send-wallet-tx';
import {
  buildBurnStakeInstruction,
  readStakeRewards,
  type StakeRewardsView,
} from '@/lib/stake';
import { BRAND } from '@/lib/branding';

function fmt(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '--';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '--';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return fmt(n, 2);
}

function parseDecimalToBase(input: string, decimals: number): bigint {
  const raw = input.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error('Enter a valid amount.');
  const [wholeRaw, fracRaw = ''] = raw.split('.');
  if (fracRaw.length > decimals) {
    throw new Error(`Use ${decimals} decimals or fewer.`);
  }
  const whole = BigInt(wholeRaw || '0');
  const frac = BigInt((fracRaw + '0'.repeat(decimals)).slice(0, decimals));
  return whole * BigInt(10) ** BigInt(decimals) + frac;
}

function Metric({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-sm hairline bg-inkA px-4 py-3 min-w-0">
      <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.2em] uppercase">
        {label}
      </div>
      <div
        className={`mt-2 font-display text-3xl leading-none tabular-nums ${
          accent ? 'text-orange' : 'text-bone'
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-1 font-mono text-[10px] text-boneDim/55 leading-relaxed">
          {sub}
        </div>
      )}
    </div>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-11 px-4 rounded-sm bg-orange text-black font-display text-lg tracking-wide disabled:opacity-45 disabled:cursor-not-allowed hover:brightness-110 transition"
    >
      {children}
    </button>
  );
}

export default function EarnPage() {
  const connection = useMemo(() => makeL1Connection(), []);
  const {
    publicKey,
    isConnected,
    sendTransaction,
    signTransaction,
  } = useUnifiedWallet();
  const claimables = useClaimableTotals();
  const pool = usePoolHealth();
  const supply = usePokerSupply();

  const [position, setPosition] = useState<StakeRewardsView | null>(null);
  const [positionLoading, setPositionLoading] = useState(false);
  const [stakeAmount, setStakeAmount] = useState('');
  const [busy, setBusy] = useState<null | 'burn' | 'stake' | 'poker' | 'sng'>(null);

  const refreshPosition = useCallback(async () => {
    if (!publicKey) {
      setPosition(null);
      return;
    }
    setPositionLoading(true);
    try {
      setPosition(await readStakeRewards(connection, publicKey));
    } catch (err) {
      console.warn('[earn] stake read failed', err);
    } finally {
      setPositionLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refreshPosition();
  }, [refreshPosition]);

  const burnStake = useCallback(async () => {
    if (!publicKey) {
      toast.error('Connect wallet first.');
      return;
    }
    const amountBase = parseDecimalToBase(stakeAmount, 9);
    if (amountBase <= BigInt(0)) throw new Error('Enter an amount above zero.');

    setBusy('burn');
    try {
      const ix = await buildBurnStakeInstruction(publicKey, amountBase);
      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await getLatestBlockhashClient(connection, 'confirmed')).blockhash;
      await applyPriorityFee(tx);

      const amountDisplay = `${stakeAmount.trim()} ${BRAND.tokenSymbol}`;
      if (!(await confirmFundsAction({
        title: 'Confirm Stake Burn',
        action: `Burn ${BRAND.tokenSymbol} into staking position`,
        amount: amountDisplay,
        details: [
          'Burning stake is permanent.',
          'The wallet keeps its proportional claim on protocol reward vaults.',
        ],
        transaction: tx,
      }))) {
        return;
      }

      const sig = await sendWalletTx(tx, connection, { sendTransaction, signTransaction });
      await connection.confirmTransaction(sig, 'confirmed');
      toast.success('Stake position updated.');
      setStakeAmount('');
      await refreshPosition();
      await claimables.refresh({ silent: true });
      void refreshWalletBalances();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Stake burn failed.');
    } finally {
      setBusy(null);
    }
  }, [
    claimables,
    connection,
    publicKey,
    refreshPosition,
    sendTransaction,
    signTransaction,
    stakeAmount,
  ]);

  const runClaim = useCallback(
    async (kind: 'stake' | 'poker' | 'sng') => {
      setBusy(kind);
      try {
        await claimables.onClaim(kind);
        await refreshPosition();
      } catch {
        // useClaimableTotals already surfaces the failure toast.
      } finally {
        setBusy(null);
      }
    },
    [claimables, refreshPosition],
  );

  const staked = position?.staked ?? 0;
  const share = position?.yourSharePercent ?? 0;
  const pendingFp = (position?.pendingPoker ?? 0) +
    claimables.totals.pokerUnrefined +
    claimables.totals.pokerRefined;

  return (
    <main className="max-w-[1180px] mx-auto w-full px-3 sm:px-5 py-7 md:py-10 space-y-8">
      <PageHeadline
        lineOne="Earn"
        lineTwo="Vault Share"
        subtitle={`${BRAND.tokenSymbol} staking is wallet-built and on-chain. Burned stake tracks a proportional claim on protocol reward vaults without using the original client database.`}
        right={
          <div className="rounded-sm hairline bg-inkA px-3 py-2 text-right">
            <div className="font-mono text-[9px] tracking-[0.18em] text-boneDim/55 uppercase">
              Circulating
            </div>
            <div className="font-display text-bone text-2xl leading-none tabular-nums">
              {supply.loading ? '--' : fmtCompact(supply.wholeSupply)}
            </div>
          </div>
        }
      />

      <section>
        <SectionHeader
          eyebrow="Position"
          title="Wallet Rewards"
          subtitle="Your wallet signs every stake and claim transaction. The page reads staking state directly from Solana, so it works without a private app database."
        />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Metric
            label="Burned stake"
            value={positionLoading && !position ? '...' : fmt(staked, 2)}
            sub={isConnected ? `${BRAND.tokenSymbol} burned` : 'connect wallet'}
            accent
          />
          <Metric
            label="Pool share"
            value={isConnected ? `${share.toFixed(4)}%` : '--'}
            sub="share of reward vaults"
          />
          <Metric
            label="Claimable SOL"
            value={isConnected ? `${fmt(claimables.totals.stakingSol, 5)} SOL` : '--'}
            sub="staking rewards"
          />
          <Metric
            label={`Claimable ${BRAND.tokenSymbol}`}
            value={isConnected ? fmt(pendingFp, 2) : '--'}
            sub="liquid and refined rewards"
          />
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr] gap-4">
        <div className="rounded-sm hairline bg-inkA p-5">
          <div className="font-display text-bone text-2xl leading-none tracking-wide">
            Stake {BRAND.tokenSymbol}
          </div>
          <p className="mt-2 font-sans text-[12px] text-boneDim/70 leading-relaxed max-w-2xl">
            Burning moves liquid {BRAND.tokenSymbol} into your permanent staking
            position. It cannot be withdrawn, but it keeps earning from every
            reward vault supported by the protocol.
          </p>
          <div className="mt-5 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
            <input
              value={stakeAmount}
              onChange={(e) => setStakeAmount(e.target.value)}
              inputMode="decimal"
              placeholder={`Amount of ${BRAND.tokenSymbol}`}
              className="h-11 rounded-sm bg-black/35 border border-bone/15 px-3 font-mono text-[12px] text-bone outline-none focus:border-orange/60"
            />
            <ActionButton
              disabled={!isConnected || busy === 'burn' || !stakeAmount.trim()}
              onClick={() => void burnStake()}
            >
              {busy === 'burn' ? 'STAKING...' : 'BURN TO STAKE'}
            </ActionButton>
          </div>
        </div>

        <div className="rounded-sm hairline bg-inkA p-5">
          <div className="font-display text-bone text-2xl leading-none tracking-wide">
            Claims
          </div>
          <p className="mt-2 font-sans text-[12px] text-boneDim/70 leading-relaxed">
            Claims are normal wallet transactions. The source build does not
            need a helper wallet for these actions.
          </p>
          <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <ActionButton
              disabled={!isConnected || busy !== null || claimables.totals.stakingSol <= 0}
              onClick={() => void runClaim('stake')}
            >
              {busy === 'stake' ? '...' : 'SOL'}
            </ActionButton>
            <ActionButton
              disabled={!isConnected || busy !== null || pendingFp <= 0}
              onClick={() => void runClaim('poker')}
            >
              {busy === 'poker' ? '...' : BRAND.tokenSymbol}
            </ActionButton>
            <ActionButton
              disabled={!isConnected || busy !== null || claimables.totals.sngSol <= 0}
              onClick={() => void runClaim('sng')}
            >
              {busy === 'sng' ? '...' : 'SNG SOL'}
            </ActionButton>
          </div>
        </div>
      </section>

      <section>
        <SectionHeader
          eyebrow="Pool"
          title="Protocol Vaults"
          subtitle="These reads come from the shared Steel pool PDA and are intentionally slow-polled to keep the public MVR route light."
        />
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Metric label="Total staked" value={pool.loading ? '--' : fmt(pool.totalPoolStaked, 2)} />
          <Metric label="SOL available" value={pool.loading ? '--' : `${fmt(pool.solAvailable, 4)} SOL`} />
          <Metric label="SOL paid" value={pool.loading ? '--' : `${fmt(pool.solDistributed, 4)} SOL`} />
          <Metric label={`${BRAND.tokenSymbol} available`} value={pool.loading ? '--' : fmt(pool.pokerAvailable, 2)} />
          <Metric label="Unrefined" value={pool.loading ? '--' : fmt(pool.totalUnrefined, 2)} />
        </div>
      </section>
    </main>
  );
}
