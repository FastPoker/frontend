'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import Link from 'next/link';
import Image from 'next/image';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { toast } from 'sonner';

import { useEarnPosition } from '@/hooks/useEarnPosition';
import { useClaimableTotals, forceLiveRefresh, markClaimedOptimistic } from '@/hooks/useClaimableTotals';
import { refreshWalletBalances } from '@/hooks/useWalletBalances';
import { usePokerSupply } from '@/hooks/usePokerSupply';
import { usePoolHealth } from '@/hooks/usePoolHealth';
import { usePrices } from '@/hooks/usePrices';
import { useOnChainYield } from '@/hooks/useOnChainYield';
import { useDealerRegistry } from '@/hooks/useDealerRegistry';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { PageHeadline } from '@/components/ui/PageHeadline';
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getMint,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { makeL1Connection, POKER_MINT, POOL_PDA, STEEL_PROGRAM_ID, USDC_DEVNET_MINT, USDC_MAINNET_MINT, USDC_MINT } from '@/lib/constants';
import { applyPriorityFee } from '@/lib/priority-fee';
import { getClientL1Rpc } from '@/lib/rpc-config';
import { getProgramAccountsV2, decodeV2Accounts } from '@/lib/helius-tx';
import { shouldUsePool } from '@/lib/rpc-pool';
import {
  buildBurnStakeInstruction,
  buildInitSplRewardPoolInstruction,
  buildClaimStakeRewardsTx,
  getStakePda,
  getSplRewardPoolPda,
  getSplStakerClaimPda,
  LAUNCH_SPL_REWARD_MINTS,
} from '@/lib/stake';
import { TokenIdentity } from '@/components/earn/TokenIdentity';
import { SFX } from '@/lib/sfx';
import { confirmFundsAction } from '@/lib/funds-confirmation';
import { RAW_YIELD_NAME, LIQUID_FP_NAME } from '@/lib/jackpot-format';
import { BRAND } from '@/lib/branding';

const FP = BRAND.tokenSymbol;

// ─── Formatting helpers ───────────────────────────────────────────────
function fmtNum(n: number, decimals = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function rawToUiAmount(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

async function getSplDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  if (mint.equals(POKER_MINT)) return 9;
  if (mint.equals(USDC_MAINNET_MINT) || mint.equals(USDC_DEVNET_MINT)) return 6;
  try {
    return (await getMint(connection, mint)).decimals;
  } catch {
    return 9;
  }
}

function fmtPct(pct: number): string {
  return `${pct.toFixed(4)}%`;
}

function actionErr(err: unknown, label: string) {
  console.error(`[earn] ${label} failed`, err);
  const msg = err instanceof Error ? err.message : '';
  if (/user rejected|cancelled|user denied|transaction cancelled/i.test(msg)) return;
  toast.error(msg || `${label} failed.`);
}

// ─── StatCell — used in the hero grid ────────────────────────────────
function StatCell({
  label,
  value,
  sub,
  accent = 'text-bone',
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="px-4 py-3 border-r border-orange/10 last:border-r-0 bg-ink/30">
      <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em] mb-1">
        {label.toUpperCase()}
      </div>
      <div className={`font-display text-xl leading-none tabular-nums ${accent}`}>
        {value}
      </div>
      {sub && (
        <div className="font-mono text-[9px] text-boneDim/50 mt-1">{sub}</div>
      )}
    </div>
  );
}

// ─── Hero — position overview ─────────────────────────────────────────
function EarningsHero() {
  const pos = useEarnPosition();
  const pool = usePoolHealth();
  const prices = usePrices();
  const { totals, loading: claimableLoading } = useClaimableTotals();
  const { isConnected: connected } = useUnifiedWallet();

  // Protocol all-time SOL into the staker pool (on-chain reward counters:
  // solDistributed = paid out, solAvailable = pending. Authoritative.)
  const totalSolRevenue = pool.solDistributed + pool.solAvailable;

  const LAUNCH_MS = Date.parse('2026-05-26T00:00:00Z');
  const daysSinceLaunch = Math.max(1, (Date.now() - LAUNCH_MS) / 86_400_000);
  const annualSolToStakers = (totalSolRevenue / daysSinceLaunch) * 365;
  const annualSolPerFp = pool.totalPoolStaked > 0 ? annualSolToStakers / pool.totalPoolStaked : 0;
  const fpSol = prices.fpPrice > 0 && prices.solPrice > 0 ? prices.fpPrice / prices.solPrice : 0;
  const apyPct = annualSolPerFp > 0 && fpSol > 0 ? (annualSolPerFp / fpSol) * 100 : null;
  const apyBig =
    apyPct != null
      ? `${apyPct >= 1000 ? Math.round(apyPct).toLocaleString() : apyPct.toFixed(1)}%${prices.fpIndicative ? ' ·est' : ''}`
      : null;

  const solYearStr = pool.loading
    ? '...'
    : totalSolRevenue <= 0
      ? '0.0000 SOL'
      : connected && pos.burned > 0
        ? `${fmtNum(annualSolToStakers * (pos.sharePercent / 100), 4)} SOL/yr`
        : `${fmtNum(annualSolPerFp * 1000, 5)} SOL/yr · per 1K ${FP}`;

  const burnedDisplay = connected
    ? pos.loading && pos.burned === 0
      ? '...'
      : fmtNum(pos.burned, 2)
    : '--';

  const shareDisplay = connected
    ? pos.loading && pos.sharePercent === 0
      ? '...'
      : fmtPct(pos.sharePercent)
    : '--%';

  const claimableSol = totals.stakingSol;
  const claimableFp =
    pos.pendingPoker + totals.pokerUnrefined + totals.pokerRefined;

  const pendingSolDisplay = connected
    ? claimableLoading
      ? '...'
      : `${fmtNum(claimableSol, 4)} SOL`
    : '--';

  const pendingPokerDisplay = connected
    ? (pos.loading || claimableLoading) && claimableFp === 0
      ? '...'
      : `${fmtNum(claimableFp, 2)} ${FP}`
    : '--';

  return (
    <div
      className="relative overflow-hidden rounded-sm hairline glass-card"
      style={{
        background:
          'linear-gradient(135deg, rgba(16,12,14,0.62), rgba(10,8,10,0.68))',
      }}
    >
      <div
        className="absolute inset-0 pointer-events-none opacity-40"
        style={{
          background:
            'radial-gradient(ellipse at top right, rgba(242,106,31,0.18), transparent 60%)',
        }}
      />
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.04]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, #F26A1F 0 1px, transparent 1px 14px)',
        }}
      />

      <div className="relative p-6 lg:p-8">
        <div className="flex flex-col items-center gap-2 mb-3 md:flex-row md:items-center md:justify-between">
          <div id="earn-position-eyebrow" className="font-mono text-[10px] tracking-[0.22em] text-orange/80">
            YOUR POSITION
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[9px] text-emerald-300/70 tracking-[0.2em]">TOTAL SOL REVENUE</span>
            <span className="font-display text-emerald-300 text-xl leading-none tabular-nums">
              {pool.loading ? '--' : totalSolRevenue.toFixed(2)}
            </span>
            <span className="font-mono text-[9px] text-boneDim/55 tracking-wider">SOL · all-time</span>
          </div>
        </div>
        <div className="flex flex-col items-center gap-y-3 mb-2 md:flex-row md:flex-wrap md:items-baseline md:gap-x-6 md:gap-y-2 md:justify-between">
          <div className="flex flex-col items-center gap-1 md:flex-row md:items-baseline md:gap-3">
            <span className="font-display text-bone text-5xl lg:text-6xl leading-none tabular-nums">
              {burnedDisplay}
            </span>
            <span className="font-mono text-[11px] text-amber tracking-wider">
              {FP} BURNED
            </span>
          </div>
          <div className="flex flex-col items-center gap-1 md:flex-row md:flex-wrap md:items-baseline md:justify-end md:gap-2 min-w-0">
            <span className="hidden md:inline font-mono text-[11px] text-boneDim/50 tracking-wider">
              =
            </span>
            <span className="font-display text-orange text-3xl tabular-nums">
              {shareDisplay}
            </span>
            <span className="font-mono text-[10px] text-boneDim/60 tracking-wider whitespace-nowrap">
              OF EVERY VAULT · FOREVER
            </span>
          </div>
        </div>
        <p className="font-mono text-[11px] text-boneDim/70 leading-relaxed max-w-xl mt-3">
          Your stake is the {FP} you have{' '}
          <span className="text-orange">permanently burned</span>. It entitles
          you to a share of every protocol revenue stream: SOL, {FP}, and
          every listed SPL token.
        </p>

        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-0 hairline rounded-sm overflow-hidden">
          <StatCell
            label="Pool share"
            value={shareDisplay}
            accent="text-orange"
            sub={connected ? undefined : 'connect wallet'}
          />
          <StatCell
            label="Claimable SOL"
            value={pendingSolDisplay}
            sub={connected ? 'claimable now' : 'connect wallet'}
          />
          <StatCell
            label={`Claimable ${FP}`}
            value={pendingPokerDisplay}
            sub={connected ? 'claimable now' : 'connect wallet'}
          />
          <StatCell
            label={apyBig ? 'Est. APY' : 'Est. yearly SOL'}
            value={pool.loading ? '...' : (apyBig ?? solYearStr)}
            accent="text-emerald-300"
            sub={apyBig ? solYearStr : (connected && pos.burned > 0 ? 'your est. yearly SOL' : `per 1K ${FP} · 7d avg`)}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Revenue streams — four protocol sources ──────────────────────────
const STREAMS = [
  {
    id: 'rake',
    num: '01',
    title: 'CASH TABLE RAKE',
    split: '20%',
    ofWhat: 'of the 5% pot rake',
    effective: '1% of volume to pool',
    denom: `SOL · ${FP} · SPL`,
    why: 'Every cash hand pays a 5% rake (capped per pot). 20% of that rake flows to the staker pool in whatever token the pot was played in.',
    ctaNote: `routes to SOL / ${FP} / SPL vaults`,
  },
  {
    id: 'sng',
    num: '02',
    title: 'SNG ENTRY FEES',
    split: '45%',
    ofWhat: 'of every SNG entry fee',
    effective: 'paid in SOL',
    denom: 'SOL',
    why: 'Every Sit-N-Go charges an entry fee on top of the buy-in. 45% of that fee goes to stakers. The rest funds operations and tournament infrastructure.',
    ctaNote: 'routes to SOL vault',
  },
  {
    id: 'listing',
    num: '03',
    title: 'TOKEN LISTING AUCTIONS',
    split: '50%',
    ofWhat: 'of auction proceeds',
    effective: 'highest-bid slot',
    denom: 'SOL',
    why: 'New SPL tokens auction for the right to be listed as a cash-table denomination. 50% of the winning bid goes straight to the staker pool.',
    ctaNote: 'routes to SOL vault',
  },
  {
    id: 'dealer',
    num: '04',
    title: 'DEALER LICENSE SALES',
    split: '50%',
    ofWhat: 'of every license minted',
    effective: 'bonding-curve priced',
    denom: 'SOL',
    why: 'Dealer licenses let operators run their own crank and earn a share of every hand they deal. Every license sale splits 50/50: stakers and Platform Fee.',
    ctaNote: 'routes to SOL vault',
  },
] as const;

function RevenueStreams() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {STREAMS.map((s) => (
        <div
          key={s.id}
          className="rounded-sm hairline bg-inkA overflow-hidden flex flex-col"
        >
          <div className="px-5 py-3 border-b border-orange/10 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="font-display text-orange/40 text-xl tabular-nums leading-none">
                {s.num}
              </span>
              <span className="font-display text-bone text-sm tracking-wide">
                {s.title}
              </span>
            </div>
            <span className="font-mono text-[9px] text-boneDim/50 tracking-wider">
              {s.denom}
            </span>
          </div>
          <div className="p-5 flex-1 flex flex-col">
            <div className="flex items-baseline gap-3 mb-2">
              <span className="font-display text-emerald-300 text-5xl leading-none tabular-nums">
                {s.split}
              </span>
              <div className="font-mono text-[10px] text-boneDim/70 leading-tight">
                <div>{s.ofWhat}</div>
                <div className="text-boneDim/50 mt-0.5">{s.effective}</div>
              </div>
            </div>

            <p className="font-mono text-[11px] text-boneDim/75 leading-relaxed my-4">
              {s.why}
            </p>

            <div className="mt-auto hairline bg-ink/40 p-3 flex items-center justify-end">
              <span className="font-mono text-[10px] text-orange/70 tracking-wider text-right">{s.ctaNote}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Flow steps — how yield works ─────────────────────────────────────
function FlowStep({
  idx,
  title,
  body,
  accent,
}: {
  idx: string;
  title: string;
  body: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`flex gap-3 p-3 rounded-sm ${accent ? 'bg-orange/[0.06] hairline' : 'hairline bg-ink/20'}`}
    >
      <div
        className={`font-display text-2xl leading-none tabular-nums shrink-0 ${accent ? 'text-orange' : 'text-boneDim/40'}`}
      >
        {idx}
      </div>
      <div>
        <div
          className={`font-mono text-[11px] leading-tight mb-1 ${accent ? 'text-bone' : 'text-bone/90'}`}
        >
          {title}
        </div>
        <div className="font-mono text-[10px] text-boneDim/60 leading-relaxed">
          {body}
        </div>
      </div>
    </div>
  );
}

// ─── SimRow — before/after projection line ───────────────────────────
function SimRow({
  label,
  before,
  after,
}: {
  label: string;
  before: string;
  after: string;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="eyebrow text-boneDim/60">{label}</span>
      <div className="flex items-center gap-2 font-mono text-[12px] tabular-nums">
        <span className="font-mono text-[12px] tabular-nums text-boneDim/50 line-through">{before}</span>
        <svg
          className="w-3 h-3 text-orange/50 shrink-0"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M2 6h8m-3-3 3 3-3 3" />
        </svg>
        <span className="text-orange">{after}</span>
      </div>
    </div>
  );
}

// ─── Stake section — interactive BurnToEarn form + yield-flow explainer ─
function StakeSection() {
  const { isConnected: connected, publicKey, sendTransaction } = useUnifiedWallet();
  const pos = useEarnPosition();
  const yieldStats = useOnChainYield(pos.totalPoolStaked);

  const [rawInput, setRawInput] = useState('');
  const [burning, setBurning] = useState(false);
  const sliderThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inputAmount = Math.max(0, parseFloat(rawInput) || 0);

  // Projection calculations
  const currentStake = pos.burned;
  const poolTotal = pos.totalPoolStaked;
  const newStake = currentStake + inputAmount;
  const newPool = poolTotal + inputAmount;
  const newSharePct = newPool > 0 ? (newStake / newPool) * 100 : 0;

  function fmtStake(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toFixed(0);
  }

  const beforeStakeStr = connected ? fmtStake(currentStake) + ` ${FP}` : '--';
  const afterStakeStr =
    connected && inputAmount > 0 ? fmtStake(newStake) + ` ${FP}` : beforeStakeStr;

  const beforeShareStr = connected
    ? pos.sharePercent.toFixed(4) + '%'
    : '--%';
  const afterShareStr =
    connected && inputAmount > 0
      ? newSharePct.toFixed(4) + '%'
      : beforeShareStr;

  const poolDailySol = yieldStats.avgDailySol7d || yieldStats.avgDailySol;
  const fmtSol = (n: number) => (n >= 0.01 ? n.toFixed(3) : n.toFixed(5));
  const beforeDailyStr =
    connected && yieldStats.hasData
      ? `${fmtSol((poolDailySol * pos.sharePercent) / 100)} SOL`
      : '--';
  const afterDailyStr =
    connected && inputAmount > 0 && yieldStats.hasData
      ? `${fmtSol((poolDailySol * newSharePct) / 100)} SOL`
      : beforeDailyStr;

  function handlePctClick(pct: number) {
    SFX.play('ui-tap');
    if (!connected || pos.pokerBalance <= 0) return;
    const val = Math.floor(pos.pokerBalance * (pct / 100));
    setRawInput(val > 0 ? String(val) : '');
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const sanitized = e.target.value.replace(/[^0-9.]/g, '');
    setRawInput(sanitized);
    if (sliderThrottleRef.current) return;
    SFX.play('ui-slider');
    sliderThrottleRef.current = setTimeout(() => {
      sliderThrottleRef.current = null;
    }, 120);
  }

  function handleMaxClick() {
    SFX.play('ui-tap');
    if (!connected || pos.pokerBalance <= 0) return;
    setRawInput(String(Math.floor(pos.pokerBalance)));
  }

  const handleBurn = useCallback(async () => {
    if (!connected || !publicKey || !sendTransaction || inputAmount <= 0) return;
    if (inputAmount > pos.pokerBalance) {
      toast.error(`Amount exceeds available ${FP} balance.`);
      return;
    }
    SFX.play('chip-bet');
    setBurning(true);
    try {
      const connection = makeL1Connection();
      const ix = await buildBurnStakeInstruction(
        publicKey,
        BigInt(Math.floor(inputAmount * 1e9)),
      );
      const tx = new Transaction();
      for (const mint of LAUNCH_SPL_REWARD_MINTS) {
        const [splRewardPool] = getSplRewardPoolPda(mint);
        const info = await connection.getAccountInfo(splRewardPool);
        if (!info) tx.add(buildInitSplRewardPoolInstruction(publicKey, mint));
      }
      tx.add(ix);
      if (!(await confirmFundsAction({
        title: 'Confirm Burn To Stake',
        action: `Burn ${FP} into staking position`,
        amount: `${fmtStake(inputAmount)} ${FP}`,
        details: ['This action is one-way.'],
        transaction: tx,
      }))) {
        return;
      }
      await applyPriorityFee(tx);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
      toast.success(`Burned ${fmtStake(inputAmount)} ${FP}. Stake confirmed.`);
      setRawInput('');
      await pos.refetch();
    } catch (err) {
      actionErr(err, 'Burn');
    } finally {
      setBurning(false);
    }
  }, [connected, publicKey, sendTransaction, inputAmount, pos]);

  const burnDisabled = !connected || inputAmount <= 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-4">
      {/* LEFT: interactive burn form */}
      <div
        id="earn-burn-card"
        className="overflow-hidden flex flex-col rounded-sm"
        style={{
          background: 'linear-gradient(145deg, rgba(255,100,0,0.38) 0%, rgba(180,55,0,0.28) 45%, rgba(10,4,0,0.82) 100%)',
          border: '1px solid rgba(255,122,0,0.55)',
          backdropFilter: 'blur(28px)',
          WebkitBackdropFilter: 'blur(28px)',
        }}
      >
        <div className="px-5 py-3 border-b border-orange/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-display text-bone text-sm">BURN TO STAKE</span>
            <span className="font-mono text-[9px] text-orange/80 px-1.5 py-0.5 rounded-sm bg-orange/10 tracking-wider">
              1-WAY
            </span>
          </div>
          <span className="font-mono text-[9px] text-boneDim/50 tracking-wider">
            IX . stake_burn
          </span>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="eyebrow text-boneDim/70">YOUR STAKE</div>
            <div className="font-mono text-[10px] text-boneDim/60 tracking-wider">
              {connected
                ? `WALLET: ${fmtStake(pos.pokerBalance)} ${FP}`
                : 'WALLET: --'}
            </div>
          </div>

          <div className="flex items-center gap-2 bg-ink border border-orange/20 focus-within:border-orange/60 rounded-sm px-3 py-3 transition-colors">
            <Image
              src="/brand/app-icon.png"
              alt={FP}
              width={20}
              height={20}
              className="rounded-full opacity-80 shrink-0"
            />
            <input
              type="number"
              min="0"
              value={rawInput}
              onChange={handleInputChange}
              placeholder="0"
              className="flex-1 bg-transparent font-display text-3xl text-bone tabular-nums focus:outline-none placeholder:text-boneDim/30"
            />
            <button
              onClick={handleMaxClick}
              className="font-mono text-[11px] text-orange hover:text-bone tracking-wider transition"
            >
              MAX
            </button>
          </div>

          <div className="flex gap-1.5">
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                onClick={() => handlePctClick(pct)}
                className="flex-1 py-1 rounded-full hairline hover:bg-orange/10 hover:border-orange/40 font-mono text-[11px] text-boneDim hover:text-bone tracking-wider transition"
              >
                {pct}%
              </button>
            ))}
          </div>

          <div className="rounded-sm bg-ink/40 hairline p-3 space-y-2">
            <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em] mb-1">
              AFTER BURN
            </div>
            <SimRow label="Stake" before={beforeStakeStr} after={afterStakeStr} />
            <SimRow label="Share" before={beforeShareStr} after={afterShareStr} />
            <SimRow label="Est. daily" before={beforeDailyStr} after={afterDailyStr} />
          </div>

          <button
            type="button"
            disabled={burnDisabled || burning}
            onClick={handleBurn}
            className={[
              'btn-orange w-full py-3 rounded-sm font-mono text-[11px] tracking-[0.22em] transition',
              (burnDisabled || burning) ? 'opacity-40 cursor-not-allowed' : '',
            ].join(' ')}
          >
            {burning
              ? 'BURNING...'
              : inputAmount > 0
              ? `BURN ${fmtStake(inputAmount)} ${FP} · STAKE`
              : connected
              ? 'ENTER AMOUNT'
              : 'SIGN IN'}
          </button>

          <div className="font-mono text-[9px] text-boneDim/50 leading-relaxed text-center">
            BURN IS PERMANENT. Your {FP} is destroyed on-chain and the stake
            record is minted to your wallet as a non-transferable receipt.
          </div>
        </div>
      </div>

      {/* RIGHT: how yield flows */}
      <div className="rounded-sm hairline bg-inkA overflow-hidden">
        <div className="px-5 py-3 border-b border-orange/10 flex items-center justify-between">
          <span className="font-display text-bone text-sm">
            HOW YIELD FLOWS
          </span>
          <span className="font-mono text-[9px] text-boneDim/50 tracking-wider">
            FLOW
          </span>
        </div>
        <div className="p-5 space-y-3">
          <FlowStep
            idx="01"
            title={`Everything on ${BRAND.name} generates revenue`}
            body="Cash rake · SNG entries · dealer license sales · token listing auctions. Every stream flows to staker vaults."
          />
          <FlowStep
            idx="02"
            title="Revenue sorts by denomination"
            body={`SOL-denominated streams go to the SOL vault (the big one). ${FP}-denominated goes to the ${FP} vault. Each listed SPL token gets its own vault.`}
          />
          <FlowStep
            idx="03"
            title="You claim each vault separately"
            body={`Your share cuts across every vault. Claim SOL, claim ${FP}, claim individual SPL tokens. Your choice, per TX. No lock-up.`}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Primary vault cards — SOL + $FP ─────────────────────────────────
function VaultCard({
  mint,
  symbol,
  title,
  subtitle,
  ratios,
  accent,
  iconSrc,
  iconAlt,
  claimable,
  claimableLabel,
  onClaim,
  claiming,
}: {
  mint: 'SOL' | 'FP' | 'USDC';
  symbol: string;
  title: string;
  subtitle: string;
  ratios: { k: string; pct: number; note: string }[];
  accent: 'emerald' | 'amber' | 'blue';
  iconSrc?: string;
  iconAlt?: string;
  claimable: number | null;
  claimableLabel: string;
  onClaim: () => void;
  claiming: boolean;
}) {
  const accentCls =
    accent === 'amber' ? 'text-amber' : accent === 'blue' ? 'text-sky-300' : 'text-emerald-300';
  const accentBg =
    accent === 'amber'
      ? 'bg-amber/10 border-amber/30 hover:bg-amber/15'
      : accent === 'blue'
      ? 'bg-sky-400/10 border-sky-400/30 hover:bg-sky-400/15'
      : 'bg-emerald-400/10 border-emerald-400/30 hover:bg-emerald-400/15';
  const barColor = accent === 'amber' ? '#FFC63A' : accent === 'blue' ? '#38BDF8' : '#34D399';

  const displayValue =
    claimable === null ? '--' : fmtNum(claimable, accent === 'emerald' ? 4 : 2);
  const displaySub =
    claimable === null ? 'connect wallet to see claimable' : claimableLabel;

  const resolvedIconSrc = iconSrc ?? (mint === 'SOL' ? '/tokens/sol.svg' : mint === 'USDC' ? '/tokens/usdc.svg' : '/brand/app-icon.png');
  const resolvedIconAlt = iconAlt ?? symbol;

  return (
    <div className="rounded-sm hairline bg-inkA overflow-hidden flex flex-col h-full">
      <div className="px-5 py-3 border-b border-orange/10 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${accent === 'amber' ? 'bg-amber' : accent === 'blue' ? 'bg-sky-400' : 'bg-emerald-400'}`}
          />
          <span className="font-display text-bone text-sm">{title}</span>
        </div>
        <span className="font-mono text-[9px] text-boneDim/50 tracking-wider">
          {subtitle}
        </span>
      </div>
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex items-baseline gap-2 mb-1">
          <Image
            src={resolvedIconSrc}
            alt={resolvedIconAlt}
            width={34}
            height={34}
            className="rounded-full opacity-80"
          />
          <span
            className={`font-display text-5xl tabular-nums ${claimable === null ? 'text-boneDim/40' : accentCls}`}
          >
            {displayValue}
          </span>
          <span className="font-mono text-[11px] text-boneDim/60 tracking-wider">
            {symbol}
          </span>
        </div>
        <div className="font-mono text-[10px] text-boneDim/50 mb-5">
          {displaySub}
        </div>

        <div className="mb-5">
          <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em] mb-3">
            REVENUE MIX · PROTOCOL-LEVEL SPLIT
          </div>
          <div className="flex h-2 rounded-sm overflow-hidden mb-3">
            {ratios.map((r, i) => (
              <div
                key={i}
                style={{
                  width: `${r.pct}%`,
                  background: barColor,
                  opacity: 1 - i * 0.18,
                }}
              />
            ))}
          </div>
          <div className="space-y-1.5">
            {ratios.map((r, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-1.5 h-1.5 rounded-sm shrink-0"
                    style={{ background: barColor, opacity: 1 - i * 0.18 }}
                  />
                  <span className="font-mono text-[10px] text-bone">
                    {r.k}
                  </span>
                  {r.note && (
                    <span className="font-mono text-[9px] text-boneDim/45">
                      · {r.note}
                    </span>
                  )}
                </div>
                <span
                  className={`font-mono text-[10px] tabular-nums ${accentCls}`}
                >
                  {r.pct}%
                </span>
              </div>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={onClaim}
          disabled={claiming || claimable === null || claimable <= 0}
          className={`mt-auto w-full py-2.5 rounded-sm border font-mono text-[11px] tracking-[0.22em] transition text-bone text-center ${accentBg} disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {claiming
            ? 'CLAIMING...'
            : claimable === null
            ? 'SIGN IN'
            : claimable <= 0
            ? 'NOTHING TO CLAIM'
            : `CLAIM ${symbol} · 1 TX`}
        </button>
      </div>
    </div>
  );
}

// ─── SPL Token Vaults (inline claim) ────────────────────────────────
interface SplVaultRow {
  tokenMint: string;
  decimals: number;
  vaultBalance: number;
  totalDeposited: number;
  yourClaimable: number;
  yourClaimed: number;
  claimable: boolean;
  activated: boolean;
  activeWeight: number;
  currentWeight: number;
  needsWeightSync: boolean;
  weightSharePct: number;
  firstActivationBonus: number;
}

async function buildSplRewardClaimTx(
  connection: Connection,
  owner: PublicKey,
  tokenMint: PublicKey,
): Promise<Transaction> {
  const [stakePda] = getStakePda(owner);
  const [splPoolPda] = getSplRewardPoolPda(tokenMint);
  const [claimPda] = getSplStakerClaimPda(owner, tokenMint);
  const stakerAta = await getAssociatedTokenAddress(tokenMint, owner);
  const poolAta = await getAssociatedTokenAddress(tokenMint, POOL_PDA, true);

  const tx = new Transaction();
  try {
    await getAccount(connection, stakerAta);
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(owner, stakerAta, owner, tokenMint));
  }

  tx.add(
    new TransactionInstruction({
      programId: STEEL_PROGRAM_ID,
      keys: [
        { pubkey: owner,                 isSigner: true,  isWritable: true  },
        { pubkey: stakePda,              isSigner: false, isWritable: false },
        { pubkey: POOL_PDA,              isSigner: false, isWritable: true  },
        { pubkey: splPoolPda,            isSigner: false, isWritable: true  },
        { pubkey: claimPda,              isSigner: false, isWritable: true  },
        { pubkey: stakerAta,             isSigner: false, isWritable: true  },
        { pubkey: poolAta,               isSigner: false, isWritable: true  },
        { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([31]), tokenMint.toBuffer()]),
    }),
  );

  return tx;
}

const splSimCache = new Map<string, { value: bigint; ts: number }>();
const SPL_SIM_TTL_MS = 45_000;

function invalidateSplSim(owner: PublicKey, tokenMint: PublicKey) {
  splSimCache.delete(`${owner.toBase58()}:${tokenMint.toBase58()}`);
}

async function simulateSplRewardClaimable(
  connection: Connection,
  owner: PublicKey,
  tokenMint: PublicKey,
): Promise<bigint> {
  const key = `${owner.toBase58()}:${tokenMint.toBase58()}`;
  const hit = splSimCache.get(key);
  if (hit && Date.now() - hit.ts < SPL_SIM_TTL_MS) return hit.value;
  const tx = await buildSplRewardClaimTx(connection, owner, tokenMint);
  tx.feePayer = owner;
  tx.recentBlockhash = (await getLatestBlockhashClient(connection, 'confirmed')).blockhash;
  const sim = await connection.simulateTransaction(tx);
  let result = 0n;
  for (const line of sim.value.logs ?? []) {
    const m = line.match(/claimed (\d+) of mint/);
    if (m) { result = BigInt(m[1]); break; }
  }
  splSimCache.set(key, { value: result, ts: Date.now() });
  return result;
}

function SplVaultClaims() {
  const { isConnected: connected, publicKey, sendTransaction } = useUnifiedWallet();
  const pos = useEarnPosition();
  const [vaults, setVaults] = useState<SplVaultRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyMint, setBusyMint] = useState<string | null>(null);
  // getProgramAccountsV2 is a getProgramAccounts-class scan, which the free
  // public pool blocks. When that happens we surface a "bring your own RPC"
  // hint instead of erroring out.
  const [gpaBlocked, setGpaBlocked] = useState(false);

  const fetchVaults = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setGpaBlocked(false);
    try {
      const connection = makeL1Connection();

      const POKER_MINT_STR = POKER_MINT.toBase58();
      const PRIMARY_SPL_MINTS = new Set([
        POKER_MINT_STR,
        USDC_MAINNET_MINT.toBase58(),
        USDC_DEVNET_MINT.toBase58(),
      ]);

      // Scan Steel SPLRewardPool PDAs (PokerAccount disc = 9). This is a
      // getProgramAccounts-class read; on the free pool it is blocked, so we
      // degrade gracefully to an empty state + RPC hint.
      const disc9 = Buffer.from([9]);
      let accounts: ReturnType<typeof decodeV2Accounts>;
      try {
        const v2 = await getProgramAccountsV2(getClientL1Rpc(), {
          programId: STEEL_PROGRAM_ID.toBase58(),
          filters: [
            { memcmp: { offset: 0, bytes: disc9.toString('base64'), encoding: 'base64' } },
          ],
        });
        accounts = decodeV2Accounts(v2.accounts);
      } catch (gpaErr) {
        console.warn('[splVault] getProgramAccounts blocked or failed (free pool?)', gpaErr);
        setGpaBlocked(true);
        setVaults([]);
        return;
      }

      const [stakePda] = getStakePda(publicKey);
      const stakeInfo = await connection.getAccountInfo(stakePda);
      const stakeBurned = stakeInfo && stakeInfo.data.length >= 48
        ? BigInt(Buffer.from(stakeInfo.data).readBigUInt64LE(40))
        : 0n;

      const rows: SplVaultRow[] = [];
      const SCALE = 1_000_000_000_000n;

      for (const { data: d } of accounts) {
        if (d.length < 72) continue;
        const tokenMintPk = new PublicKey(d.subarray(8, 40));
        const mint = tokenMintPk.toBase58();
        if (PRIMARY_SPL_MINTS.has(mint)) continue;
        const decimals = await getSplDecimals(connection, tokenMintPk);
        const rewardsAvailable = d.readBigUInt64LE(40);
        const rewardsDistributed = d.readBigUInt64LE(48);
        const accLo = d.readBigUInt64LE(56);
        const accHi = d.readBigUInt64LE(64);
        const accumulated = (BigInt(accHi) << 64n) | BigInt(accLo);
        const activeBurnedTotal = d.length >= 88 ? d.readBigUInt64LE(80) : 0n;
        const activationCount = d.length >= 96 ? d.readBigUInt64LE(88) : 0n;

        const totalDeposited = rawToUiAmount(rewardsAvailable + rewardsDistributed, decimals);
        const vaultBalance = rawToUiAmount(rewardsAvailable, decimals);

        let yourClaimable = 0n;
        const yourClaimed = 0;
        let activated = false;
        let snapshotBurned = 0n;
        if (stakeBurned > 0n) {
          const [claimPda] = getSplStakerClaimPda(publicKey, tokenMintPk);
          const claimInfo = await connection.getAccountInfo(claimPda);
          activated = Boolean(claimInfo && claimInfo.data.length >= 96);
          if (claimInfo && claimInfo.data.length >= 96) {
            snapshotBurned = Buffer.from(claimInfo.data).readBigUInt64LE(72);
          }
          let pendingFromSim: bigint | null = null;
          try {
            pendingFromSim = await simulateSplRewardClaimable(connection, publicKey, tokenMintPk);
          } catch (simErr) {
            console.warn('[splVault.sim] failed for', mint, simErr);
          }

          if (pendingFromSim !== null) {
            yourClaimable = pendingFromSim;
          } else {
            let rewardDebt = 0n;
            if (claimInfo && claimInfo.data.length >= 96) {
              const cd = Buffer.from(claimInfo.data);
              snapshotBurned = cd.readBigUInt64LE(72);
              const rdLo = cd.readBigUInt64LE(80);
              const rdHi = cd.readBigUInt64LE(88);
              rewardDebt = (BigInt(rdHi) << 64n) | BigInt(rdLo);
            }
            if (activated) {
              const scaledPending = snapshotBurned * accumulated - rewardDebt;
              yourClaimable = scaledPending > 0n ? scaledPending / SCALE : 0n;
            } else if (activeBurnedTotal === 0n) {
              yourClaimable = rewardsAvailable;
            }
          }
        }
        const needsWeightSync = activated && stakeBurned > snapshotBurned;

        const myWeight = activated ? snapshotBurned : stakeBurned;
        const shareDenom = activated ? activeBurnedTotal : (activeBurnedTotal + stakeBurned);
        const weightSharePct = shareDenom > 0n ? Number((myWeight * 1000000n) / shareDenom) / 10000 : 0;
        const firstActivationBonus = activationCount === 0n ? vaultBalance : 0;
        rows.push({
          tokenMint: mint,
          decimals,
          vaultBalance,
          totalDeposited,
          yourClaimable: rawToUiAmount(yourClaimable, decimals),
          yourClaimed,
          claimable: yourClaimable > 0n,
          activated,
          activeWeight: rawToUiAmount(snapshotBurned, 9),
          currentWeight: rawToUiAmount(stakeBurned, 9),
          needsWeightSync,
          weightSharePct,
          firstActivationBonus,
        });
      }
      rows.sort((a, b) => b.vaultBalance - a.vaultBalance);
      setVaults(rows);
    } catch (err) {
      console.error('Failed to fetch SPL reward pools:', err);
    } finally {
      setLoading(false);
    }
  }, [publicKey, pos.burned]);

  useEffect(() => {
    if (!connected || !publicKey) {
      setVaults([]);
      return;
    }
    fetchVaults();
  }, [connected, publicKey, fetchVaults]);

  const claimOne = useCallback(
    async (mintStr: string) => {
      if (!publicKey || !sendTransaction) return;
      setBusyMint(mintStr);
      try {
        const connection = makeL1Connection();
        const tokenMint = new PublicKey(mintStr);
        const tx = await buildSplRewardClaimTx(connection, publicKey, tokenMint);

        tx.feePayer = publicKey;
        tx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
        const claimRow = vaults.find(v => v.tokenMint === mintStr);
        const actionLabel = !claimRow?.activated
          ? 'Activate this token vault'
          : claimRow.needsWeightSync && !claimRow.claimable
            ? 'Sync token reward weight'
            : 'Claim staker token rewards';
        if (!(await confirmFundsAction({
          title: claimRow?.activated ? 'Confirm SPL Reward Claim' : 'Confirm Token Vault Activation',
          action: actionLabel,
          amount: claimRow && claimRow.yourClaimable > 0 ? `${claimRow.yourClaimable.toFixed(6).replace(/\.?0+$/, '')} token units` : undefined,
          details: [`Mint: ${mintStr}`],
          transaction: tx,
        }))) {
          return;
        }
        await applyPriorityFee(tx);
        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction(sig);
        toast.success(
          !claimRow?.activated
            ? 'Token vault activated.'
            : claimRow.needsWeightSync && !claimRow.claimable
              ? 'Token vault weight synced.'
              : 'SPL rewards claimed.',
        );
        invalidateSplSim(publicKey, tokenMint);
        await fetchVaults();
      } catch (err) {
        actionErr(err, 'claim_spl_rewards');
      } finally {
        setBusyMint(null);
      }
    },
    [publicKey, sendTransaction, fetchVaults, vaults],
  );

  const summary = useMemo(() => {
    const claimableRows = vaults.filter((v) => v.yourClaimable > 0);
    const tokensReady = claimableRows.length;
    const biggest = claimableRows.reduce<{ mint: string; amt: number } | null>(
      (best, v) => (best && best.amt >= v.yourClaimable ? best : { mint: v.tokenMint, amt: v.yourClaimable }),
      null,
    );
    const mintsWithBalance = vaults.filter((v) => v.vaultBalance > 0).length;
    return { tokensReady, biggest, mintsWithBalance, total: vaults.length };
  }, [vaults]);

  if (!connected) {
    return (
      <div className="rounded-sm hairline bg-inkA p-6">
        <div className="font-mono text-[11px] text-boneDim/70 leading-relaxed">
          Connect your wallet to view per-token rake vaults.
        </div>
      </div>
    );
  }

  if (gpaBlocked) {
    return (
      <div className="rounded-sm hairline bg-inkA p-6">
        <div className="font-mono text-[11px] text-boneDim/70 leading-relaxed">
          Per-token rake vaults need a full-history RPC. The free public endpoint
          blocks the program-account scan this view depends on. Connect your own
          RPC in settings to list and claim individual SPL token vaults. The SOL,{' '}
          {FP} and USDC vaults above keep working on the free pool.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-sm hairline bg-inkA overflow-hidden">
      <div className="px-5 py-3 border-b border-orange/10 grid grid-cols-3 gap-4">
        <div>
          <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em]">BIGGEST CLAIM</div>
          {summary.biggest ? (
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="font-display text-amber text-xl tabular-nums">{summary.biggest.amt.toFixed(4)}</span>
              <span className="font-mono text-[9px] text-amber/70 tracking-wider">
                <TokenIdentity mint={summary.biggest.mint} compact />
              </span>
            </div>
          ) : (
            <div className="font-display text-boneDim/40 text-xl tabular-nums mt-1">—</div>
          )}
        </div>
        <div>
          <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em]">TOKENS READY</div>
          <div className="font-display text-bone text-xl tabular-nums mt-1">{summary.tokensReady}</div>
        </div>
        <div>
          <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em]">ACTIVE VAULTS</div>
          <div className="font-display text-bone text-xl tabular-nums mt-1">{summary.total}</div>
        </div>
      </div>

      {loading && vaults.length === 0 ? (
        <div className="p-6 font-mono text-[11px] text-boneDim/60 text-center">Loading vaults...</div>
      ) : vaults.length === 0 ? (
        <div className="p-6 font-mono text-[11px] text-boneDim/70 leading-relaxed text-center">
          No SPL token vaults yet. When auction-winning tokens generate rake, they appear here.
        </div>
      ) : (
        <div className="divide-y divide-white/[0.04]">
          {vaults.map((v) => (
            <div key={v.tokenMint} className="px-5 py-3 flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <TokenIdentity mint={v.tokenMint} />
                <div className="font-mono text-[9px] text-boneDim/50 tracking-wider mt-0.5">
                  TOTAL EARNINGS {v.totalDeposited.toFixed(2)} · AVAILABLE {v.vaultBalance.toFixed(4)}
                  {' · '}
                  {v.activated
                    ? `ACTIVE WEIGHT ${v.activeWeight.toFixed(2)} ${FP}`
                    : 'NOT ACTIVATED'}
                  {v.needsWeightSync ? ` · CURRENT ${v.currentWeight.toFixed(2)} ${FP}` : ''}{v.weightSharePct > 0 ? ` · WEIGHT SHARE ${v.weightSharePct.toFixed(2)}%` : ''}{v.firstActivationBonus > 0 ? ` · FIRST-ACTIVATION BONUS ${v.firstActivationBonus.toFixed(4)}` : ''}
                </div>
              </div>
              <div className="text-right" title="Your pro-rata share of this vault, computed by simulating the claim IX against the live contract.">
                <div className="font-display text-amber text-base tabular-nums">
                  {v.yourClaimable.toFixed(4)}
                </div>
                <div className="font-mono text-[9px] text-amber/60 tracking-wider">YOUR SHARE</div>
              </div>
              <button
                type="button"
                onClick={() => claimOne(v.tokenMint)}
                disabled={
                  busyMint === v.tokenMint ||
                  pos.burned <= 0 ||
                  (!v.claimable && v.activated && !v.needsWeightSync)
                }
                className="shrink-0 px-3 py-2 rounded-sm border border-orange/40 hover:border-orange hover:bg-orange/10 font-mono text-[10px] tracking-[0.18em] text-orange/90 hover:text-orange transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busyMint === v.tokenMint
                  ? 'WORKING...'
                  : pos.burned <= 0
                  ? 'NO STAKE'
                  : !v.activated
                  ? 'ACTIVATE'
                  : v.claimable
                  ? 'CLAIM'
                  : v.needsWeightSync
                  ? 'SYNC'
                  : 'EMPTY'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PrimaryVaults() {
  const { isConnected: connected, publicKey, sendTransaction } = useUnifiedWallet();
  const { totals, loading } = useClaimableTotals();
  const [claimingSol, setClaimingSol] = useState(false);
  const [claimingSpl, setClaimingSpl] = useState<'fp' | 'usdc' | null>(null);
  const [splClaimable, setSplClaimable] = useState<Record<'fp' | 'usdc', number | null>>({
    fp: null,
    usdc: null,
  });

  const primarySplVaults = useMemo(() => [
    {
      key: 'fp' as const,
      mint: POKER_MINT,
      decimals: 9,
      cardMint: 'FP' as const,
      symbol: FP,
      title: `${FP} Vault`,
      subtitle: `${FP}-denominated cash table rake`,
      accent: 'amber' as const,
      iconSrc: '/brand/app-icon.png',
      ratios: [{ k: `Cash table rake (${FP})`, pct: 100, note: '20% of 5% rake' }],
      claimableLabel: `your share of ${FP} rake pool`,
    },
    {
      key: 'usdc' as const,
      mint: USDC_MINT,
      decimals: 6,
      cardMint: 'USDC' as const,
      symbol: 'USDC',
      title: 'USDC Vault',
      subtitle: 'USDC-denominated cash table rake',
      accent: 'blue' as const,
      iconSrc: '/tokens/usdc.svg',
      ratios: [{ k: 'Cash table rake (USDC)', pct: 100, note: '20% of 5% rake' }],
      claimableLabel: 'your share of USDC rake pool',
    },
  ], []);

  const solClaimable = connected
    ? loading
      ? null
      : totals.stakingSol
    : null;

  useEffect(() => {
    if (!connected || !publicKey) {
      setSplClaimable({ fp: null, usdc: null });
      return;
    }
    let cancelled = false;
    (async () => {
      const connection = makeL1Connection();
      const entries = await Promise.all(primarySplVaults.map(async (vault) => {
        try {
          const raw = await simulateSplRewardClaimable(connection, publicKey, vault.mint);
          return [vault.key, rawToUiAmount(raw, vault.decimals)] as const;
        } catch (err) {
          console.warn(`[${vault.key}Vault.sim] failed`, err);
          return [vault.key, 0] as const;
        }
      }));
      if (!cancelled) setSplClaimable(Object.fromEntries(entries) as Record<'fp' | 'usdc', number>);
    })();
    return () => { cancelled = true; };
  }, [connected, publicKey, totals.asOfMs, primarySplVaults]);

  const handleClaimSolRewards = useCallback(async () => {
    if (!connected || !publicKey || !sendTransaction) return;
    setClaimingSol(true);
    try {
      const connection = makeL1Connection();
      const tx = await buildClaimStakeRewardsTx(connection, publicKey);
      if (!(await confirmFundsAction({
        title: 'Confirm SOL Reward Claim',
        action: 'Claim staking SOL rewards',
        amount: solClaimable != null ? `${solClaimable.toFixed(6).replace(/\.?0+$/, '')} SOL` : undefined,
        transaction: tx,
      }))) {
        return;
      }
      await applyPriorityFee(tx);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
      toast.success('SOL rewards claimed.');
      markClaimedOptimistic('stake');
      await forceLiveRefresh(publicKey.toBase58());
      void refreshWalletBalances();
    } catch (err) {
      actionErr(err, 'Claim SOL rewards');
    } finally {
      setClaimingSol(false);
    }
  }, [connected, publicKey, sendTransaction, solClaimable]);

  const handleClaimSplRewards = useCallback(async (vault: typeof primarySplVaults[number]) => {
    if (!connected || !publicKey || !sendTransaction) return;
    setClaimingSpl(vault.key);
    try {
      const connection = makeL1Connection();
      const tx = await buildSplRewardClaimTx(connection, publicKey, vault.mint);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
      const claimable = splClaimable[vault.key];
      if (!(await confirmFundsAction({
        title: `Confirm ${vault.symbol} Reward Claim`,
        action: `Claim staker ${vault.symbol} rewards`,
        amount: claimable != null ? `${claimable.toFixed(6).replace(/\.?0+$/, '')} ${vault.symbol}` : undefined,
        transaction: tx,
      }))) {
        return;
      }
      await applyPriorityFee(tx);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
      toast.success(`${vault.symbol} rewards claimed.`);
      invalidateSplSim(publicKey, vault.mint);
      setSplClaimable((prev) => ({ ...prev, [vault.key]: 0 }));
      await forceLiveRefresh(publicKey.toBase58());
      void refreshWalletBalances();
    } catch (err) {
      actionErr(err, `Claim ${vault.symbol}`);
    } finally {
      setClaimingSpl(null);
    }
  }, [connected, publicKey, sendTransaction, splClaimable]);

  const solRatios = [
    { k: 'SNG entry fees', pct: 48, note: '45% of fee' },
    { k: 'Token listing auctions', pct: 22, note: '50% of auction' },
    { k: 'Dealer license sales', pct: 18, note: '50% of mint' },
    { k: 'Cash table rake (SOL)', pct: 12, note: '20% of 5% rake' },
  ];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <VaultCard
        mint="SOL"
        symbol="SOL"
        title="SOL Vault"
        subtitle="All SOL-denominated protocol revenue"
        ratios={solRatios}
        accent="emerald"
        claimable={solClaimable}
        claimableLabel="staking + SNG rewards"
        onClaim={handleClaimSolRewards}
        claiming={claimingSol}
      />
      {primarySplVaults.map((vault) => (
        <VaultCard
          key={vault.key}
          mint={vault.cardMint}
          symbol={vault.symbol}
          title={vault.title}
          subtitle={vault.subtitle}
          ratios={vault.ratios}
          accent={vault.accent}
          iconSrc={vault.iconSrc}
          claimable={connected ? splClaimable[vault.key] : null}
          claimableLabel={vault.claimableLabel}
          onClaim={() => handleClaimSplRewards(vault)}
          claiming={claimingSpl === vault.key}
        />
      ))}
    </div>
  );
}

// ─── Tournament Earnings ─────────────────────────────────────────────
function TwoStateCard({
  state,
  amountPrimary,
  unit,
  label,
  desc,
  accent,
  ctaLabel,
  ctaDisabled,
  onCta,
  meta,
  iconSrc,
  iconAlt,
}: {
  state: string;
  amountPrimary: string;
  unit: string;
  label: string;
  desc: string;
  accent: 'amber' | 'gold' | 'emerald';
  ctaLabel: string;
  ctaDisabled?: boolean;
  onCta?: () => void;
  meta: { k: string; v: string }[];
  iconSrc?: string;
  iconAlt?: string;
}) {
  const accentCls =
    accent === 'amber'
      ? 'text-amber'
      : accent === 'gold'
      ? 'text-gold'
      : 'text-emerald-300';
  const accentBorder =
    accent === 'amber'
      ? 'border-amber/30'
      : accent === 'gold'
      ? 'border-gold/30'
      : 'border-emerald-400/30';
  const accentBg =
    accent === 'amber'
      ? 'bg-amber/10'
      : accent === 'gold'
      ? 'bg-gold/5'
      : 'bg-emerald-400/10';
  const panelBg =
    accent === 'amber'
      ? 'bg-amber/5 border-amber/20'
      : accent === 'gold'
      ? 'bg-gold/5 border-gold/20'
      : 'bg-emerald-400/5 border-emerald-400/20';
  const eyebrowCls =
    accent === 'amber'
      ? 'text-amber/90'
      : accent === 'gold'
      ? 'text-gold/90'
      : 'text-emerald-300';
  const dotBg =
    accent === 'amber'
      ? 'bg-amber'
      : accent === 'gold'
      ? 'bg-gold'
      : 'bg-emerald-400';

  return (
    <div className="rounded-sm hairline bg-inkA overflow-hidden flex flex-col">
      <div className="px-5 py-3 border-b border-orange/10 flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${dotBg}`} />
        <span className="font-display text-bone text-sm">{state}</span>
        <span className="ml-auto font-mono text-[9px] text-boneDim/50 tracking-[0.2em]">{unit.toUpperCase()}</span>
      </div>
      <div className="p-5 flex-1 flex flex-col">
        <div className={`rounded-sm border px-4 py-3 mb-4 ${panelBg}`}>
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className={`w-1 h-1 rounded-full ${dotBg}`} />
            <span className={`font-mono text-[9px] tracking-[0.2em] ${eyebrowCls}`}>
              {label.toUpperCase()}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            {iconSrc && (
              <Image
                src={iconSrc}
                alt={iconAlt ?? unit}
                width={26}
                height={26}
                className="rounded-full opacity-90 self-center"
              />
            )}
            <span className={`font-display text-3xl leading-none tabular-nums ${accentCls}`}>
              {amountPrimary}
            </span>
            <span className="font-mono text-[10px] text-boneDim/60 tracking-wider">
              {unit}
            </span>
          </div>
          <div className="font-mono text-[10px] text-boneDim/50 mt-1.5 leading-tight">
            {desc}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-0 hairline rounded-sm overflow-hidden mb-4">
          {meta.map((m, i) => (
            <div
              key={i}
              className="px-2 py-2 border-r border-orange/10 last:border-r-0 bg-ink/20"
            >
              <div className="font-mono text-[8px] text-boneDim/50 tracking-wider mb-0.5">
                {m.k.toUpperCase()}
              </div>
              <div className="font-mono text-[11px] text-bone tabular-nums">
                {m.v}
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={onCta}
          disabled={ctaDisabled}
          className={[
            'mt-auto py-2.5 rounded-sm border font-mono text-[10px] tracking-[0.22em] transition hover:brightness-110 text-bone disabled:opacity-40 disabled:cursor-not-allowed',
            accentBorder,
            accentBg,
          ].join(' ')}
        >
          {ctaLabel}
        </button>
      </div>
    </div>
  );
}

function TournamentEarnings() {
  const { publicKey, sendTransaction } = useUnifiedWallet();
  const { totals, loading, onClaim } = useClaimableTotals();
  const [claimingSng, setClaimingSng] = useState(false);

  const sngSol = totals.sngSol || 0;
  const hasSngClaim = sngSol > 0.000001;

  const handleClaimSng = useCallback(async () => {
    if (!publicKey || !sendTransaction || !hasSngClaim) return;
    setClaimingSng(true);
    try {
      await onClaim('sng');
    } catch {
      // onClaim already surfaces the error via toast
    } finally {
      setClaimingSng(false);
    }
  }, [publicKey, sendTransaction, hasSngClaim, onClaim]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <TwoStateCard
        state={hasSngClaim ? 'READY TO CLAIM' : 'PRIZE WINNINGS'}
        amountPrimary={loading ? '...' : fmtNum(sngSol, 4)}
        unit="SOL"
        label="Unclaimed SNG payouts"
        desc="Finish ITM in any SNG and your share of the prize pool lands here. Always paid in SOL, claimed separately from staking vaults."
        accent="gold"
        ctaLabel={claimingSng ? 'CLAIMING...' : hasSngClaim ? 'CLAIM PRIZES' : 'NO PRIZES YET'}
        ctaDisabled={!hasSngClaim || claimingSng}
        onCta={handleClaimSng}
        iconSrc="/tokens/sol.svg"
        iconAlt="SOL"
        meta={[
          { k: 'pending sol', v: fmtNum(sngSol, 4) },
          { k: 'status', v: hasSngClaim ? 'CLAIMABLE' : 'NONE' },
          { k: 'payout', v: 'INSTANT' },
        ]}
      />
      <UnifiedFpYieldCard
        unrefined={totals.pokerUnrefined}
        refined={totals.pokerRefined}
        loading={loading}
        onClaim={() => onClaim('poker')}
      />
    </div>
  );
}

// Unified $FP card: Raw $FP + $FP are paid together by Claim All.
function UnifiedFpYieldCard({
  unrefined,
  refined,
  loading,
  onClaim,
}: {
  unrefined: number;
  refined: number;
  loading: boolean;
  onClaim: () => Promise<void>;
}) {
  const [claiming, setClaiming] = useState(false);
  const totalBefore = unrefined + refined;
  const totalAfterTax = unrefined * 0.9 + refined;
  const hasClaim = totalBefore > 0.000001;
  const unrefinedShare =
    totalBefore > 0 ? (unrefined / totalBefore) * 100 : 0;

  const handle = useCallback(async () => {
    if (!hasClaim) return;
    setClaiming(true);
    try {
      await onClaim();
    } catch {
      // onClaim surfaces toast
    } finally {
      setClaiming(false);
    }
  }, [hasClaim, onClaim]);

  const dashIfEmpty = (n: number, d = 2) =>
    loading ? '...' : hasClaim ? fmtNum(n, d) : '0.00';

  return (
    <div className="rounded-sm hairline bg-inkA overflow-hidden flex flex-col">
      <div className="px-5 py-3 border-b border-orange/10 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-amber" />
        <span className="font-display text-bone text-sm">{FP} TOURNAMENT YIELD</span>
        <span className="ml-auto font-mono text-[9px] text-boneDim/50 tracking-[0.2em]">{RAW_YIELD_NAME.toUpperCase()} &middot; {LIQUID_FP_NAME.toUpperCase()}</span>
      </div>
      <div className="p-5 flex-1 flex flex-col">
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="rounded-sm bg-amber/5 border border-amber/20 px-4 py-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="w-1 h-1 rounded-full bg-amber" />
              <span className="font-mono text-[9px] text-amber/90 tracking-[0.2em]">{RAW_YIELD_NAME.toUpperCase()}</span>
            </div>
            <div className="flex items-baseline gap-2">
              <Image src="/brand/app-icon.png" alt={FP} width={26} height={26} className="rounded-full opacity-90" />
              <span className="font-display text-3xl leading-none tabular-nums text-amber">{dashIfEmpty(unrefined)}</span>
              <span className="font-mono text-[10px] text-boneDim/60 tracking-wider">{FP}</span>
            </div>
            <div className="font-mono text-[10px] text-boneDim/50 mt-1.5 leading-tight">
              Your held tournament FP.
            </div>
          </div>
          <div className="rounded-sm bg-emerald-400/5 border border-emerald-400/20 px-4 py-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="w-1 h-1 rounded-full bg-emerald-400" />
              <span className="font-mono text-[9px] text-emerald-300 tracking-[0.2em]">{LIQUID_FP_NAME.toUpperCase()}</span>
            </div>
            <div className="flex items-baseline gap-2">
              <Image src="/brand/app-icon.png" alt={FP} width={26} height={26} className="rounded-full opacity-90" />
              <span className="font-display text-3xl leading-none tabular-nums text-emerald-300">{dashIfEmpty(refined)}</span>
              <span className="font-mono text-[10px] text-boneDim/60 tracking-wider">{FP}</span>
            </div>
            <div className="font-mono text-[10px] text-boneDim/50 mt-1.5 leading-tight">
              Earned while staying raw.
            </div>
          </div>
        </div>

        <p className="font-mono text-[10px] text-boneDim/70 leading-relaxed mb-3">
          SNG play mints Raw {FP} (escrowed). Refining it pays a 10% refinement fee. That fee splits pro-rata to everyone still holding Raw {FP}, paid as liquid {FP}. Claim All refines your Raw {FP} and pays out the accumulated {FP} in the same transaction.
        </p>

        <div className="grid grid-cols-3 gap-0 hairline rounded-sm overflow-hidden mb-4">
          <div className="px-2 py-2 border-r border-orange/10 bg-ink/20">
            <div className="font-mono text-[8px] text-boneDim/50 tracking-wider mb-0.5">NET IF CLAIMED</div>
            <div className="font-mono text-[11px] text-bone tabular-nums">{dashIfEmpty(totalAfterTax)}</div>
          </div>
          <div className="px-2 py-2 border-r border-orange/10 bg-ink/20">
            <div className="font-mono text-[8px] text-boneDim/50 tracking-wider mb-0.5">CLAIM FEE</div>
            <div className="font-mono text-[11px] text-bone tabular-nums">10%</div>
          </div>
          <div className="px-2 py-2 bg-ink/20">
            <div className="font-mono text-[8px] text-boneDim/50 tracking-wider mb-0.5">RAW SHARE</div>
            <div className="font-mono text-[11px] text-bone tabular-nums">
              {loading ? '...' : hasClaim ? `${unrefinedShare.toFixed(0)}%` : '--%'}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={handle}
          disabled={!hasClaim || claiming}
          className="mt-auto py-2.5 rounded-sm border border-amber/30 bg-amber/10 font-mono text-[10px] tracking-[0.22em] transition hover:brightness-110 text-bone disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {claiming
            ? 'CLAIMING...'
            : hasClaim
              ? `CLAIM ALL ${FP} · ${fmtNum(totalAfterTax)} NET`
              : `NO ${FP} YIELD YET`}
        </button>
      </div>
    </div>
  );
}

// ─── Pool Stats ───────────────────────────────────────────────────────
function PoolStats() {
  const pool = usePoolHealth();
  const supply = usePokerSupply();
  const { publicKey } = useUnifiedWallet();
  const pos = useEarnPosition();

  // YOUR all-time SOL from staking. Without a per-wallet indexer ledger (this
  // build is backend-free), the lifetime claimed total isn't queryable client-
  // side; we surface live pending staking SOL instead and label it accordingly.
  const myPendingStakingSol = pos.pendingSol || 0;

  const fmtWhole = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}K`
        : n.toFixed(2);

  const totalBurned = pool.totalPoolStaked;
  const everMinted = supply.wholeSupply + totalBurned;
  const burnPct = everMinted > 0 ? (totalBurned / everMinted) * 100 : 0;
  const dataLoading = pool.loading || supply.loading;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.6fr] gap-4">
      <div className="rounded-sm hairline bg-inkA p-5">
        <div className="font-mono text-[10px] tracking-[0.22em] text-orange/80 mb-4">
          AGGREGATE · ALL-TIME
        </div>
        <div className="space-y-5">
          <div>
            <div className="font-mono text-[10px] text-boneDim/60 tracking-wider mb-1">
              Total {FP} Burned
            </div>
            <div className="font-display text-3xl text-bone leading-none tabular-nums">
              {dataLoading ? '--' : fmtWhole(totalBurned)}
            </div>
            <div className="font-mono text-[10px] text-boneDim/50 mt-1">
              stake burns + claim fees + tournament
            </div>
          </div>
          <div>
            <div className="font-mono text-[10px] text-boneDim/60 tracking-wider mb-1">
              {publicKey ? 'Your Pending SOL · Staking' : 'SOL Distributed All-Time'}
            </div>
            <div className="font-display text-3xl text-bone leading-none tabular-nums">
              {publicKey
                ? myPendingStakingSol.toFixed(4)
                : (pool.loading ? '--' : pool.solDistributed.toFixed(3))}
            </div>
            <div className="font-mono text-[10px] text-boneDim/50 mt-1">
              {publicKey ? 'live · pending claim' : 'to stakers'}
            </div>
          </div>
          <div>
            <div className="font-mono text-[10px] text-emerald-300/80 tracking-wider mb-1">
              Total SOL Revenue
            </div>
            <div className="font-display text-3xl text-bone leading-none tabular-nums">
              {pool.loading
                ? '--'
                : (pool.solDistributed + pool.solAvailable).toFixed(3)}
              <span className="font-mono text-[11px] text-boneDim/60 tracking-wider ml-1">SOL</span>
            </div>
            <div className="font-mono text-[10px] text-boneDim/50 mt-1">
              all SOL ever into the pool · paid + pending
            </div>
          </div>
          <div>
            <div className="font-mono text-[10px] text-orange tracking-wider mb-1">
              Network Burn %
            </div>
            <div className="font-display text-3xl text-bone leading-none tabular-nums">
              {dataLoading ? '--%' : `${burnPct.toFixed(2)}%`}
            </div>
            <div className="font-mono text-[10px] text-boneDim/50 mt-1">
              of circulating supply
            </div>
          </div>
        </div>
      </div>

      <ProtocolRevenueCard />
    </div>
  );
}

// ─── Protocol revenue (big picture) ─────────────────────────────────────
// Client-side: per-UTC-day SOL inflow to the pool PDA, derived from the on-chain
// signature walk (useOnChainYield). The free public pool can't sustain that
// scan, so this degrades to a "connect your own RPC" note rather than a server
// route. No /api dependency.
function ProtocolRevenueCard() {
  const pos = useEarnPosition();
  const yieldStats = useOnChainYield(pos.totalPoolStaked);

  const days = yieldStats.bars;
  const maxDay = Math.max(1e-9, ...days.map((d) => d.sol));
  const windowTotal = days.reduce((a, d) => a + d.sol, 0);
  const last24h = days.length ? days[days.length - 1].sol : 0;

  if (yieldStats.degraded) {
    return (
      <div className="rounded-sm hairline bg-inkA p-5 flex flex-col justify-center">
        <div className="font-mono text-[10px] tracking-[0.22em] text-orange/80 mb-2">
          PROTOCOL REVENUE · DAILY
        </div>
        <p className="font-mono text-[11px] text-boneDim/70 leading-relaxed max-w-md">
          The daily revenue chart is built from a full pool-history scan, which
          the free public RPC throttles. Connect your own RPC in settings to see
          the 14-day SOL-into-pool trend. All-time totals on the left are read
          from a single pool account and stay accurate on the free pool.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-sm hairline bg-inkA p-5">
      <div className="flex items-center justify-between mb-1">
        <div className="font-mono text-[10px] tracking-[0.22em] text-orange/80">
          PROTOCOL REVENUE · DAILY
        </div>
        <div className="text-right">
          <div className="font-mono text-[9px] text-boneDim/50 tracking-[0.18em]">LAST 24H</div>
          <div className="font-display text-bone text-lg tabular-nums leading-none">
            {yieldStats.loading ? '--' : last24h.toFixed(2)}
            <span className="font-mono text-[10px] text-boneDim/60 tracking-wider ml-1">SOL</span>
          </div>
        </div>
      </div>
      <div className="font-mono text-[10px] text-boneDim/60 mb-4">
        SOL into the staker pool per UTC day · {days.length || 14} days · {windowTotal.toFixed(2)} SOL window total
      </div>

      <div className="relative h-32 flex items-stretch gap-1.5 pt-4">
        {(days.length ? days : Array.from({ length: 14 }, (_, i) => ({ day: 'd' + i, sol: 0 }))).map((d, i, arr) => {
          const isZero = d.sol <= 0;
          const heightPct = isZero ? 6 : Math.max(10, Math.sqrt(d.sol / maxDay) * 100);
          const showLabel = !isZero && (d.sol === maxDay || i === arr.length - 1);
          return (
            <div key={d.day} className="flex-1 h-full flex flex-col items-center justify-end border-b border-amber/10">
              {showLabel && (
                <div className="font-mono text-[8px] text-amber/90 tabular-nums leading-none mb-0.5 whitespace-nowrap">
                  {d.sol >= 100 ? d.sol.toFixed(0) : d.sol.toFixed(1)}
                </div>
              )}
              <div
                className={isZero ? 'w-full rounded-t-sm bg-amber/10 border border-amber/20' : 'w-full rounded-t-sm bg-amber/60 border border-amber/30 hover:bg-amber/75 transition'}
                style={{ height: heightPct + '%' }}
                title={d.day + ': ' + d.sol.toFixed(3) + ' SOL'}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-2 font-mono text-[9px] text-boneDim/40 tracking-wider">
        <span>{days[0]?.day ?? '14d ago'}</span>
        <span>today</span>
      </div>

      <div className="mt-3 font-mono text-[9px] text-boneDim/45">
        Measured on-chain from SOL credited to the staker pool. Stake {FP} to earn your share.
      </div>
    </div>
  );
}

// ─── Dealer license callout ───────────────────────────────────────────
function MiniStat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] text-boneDim/70 tracking-wider uppercase">
        {k}
      </div>
      <div className="font-mono text-[12px] text-bone tabular-nums">{v}</div>
      {sub && (
        <div className="font-mono text-[8px] text-boneDim/55">{sub}</div>
      )}
    </div>
  );
}

function DealerCallout() {
  const registry = useDealerRegistry();

  const fmtCount = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toString();
  const fmtSol = (lamports: number) => {
    const sol = lamports / 1e9;
    return sol >= 1 ? `${sol.toFixed(2)} SOL` : `${sol.toFixed(3)} SOL`;
  };

  const licensesValue = registry.loading
    ? '…'
    : registry.errored
      ? '—'
      : fmtCount(registry.totalSold);
  const nextPriceValue = registry.loading
    ? '…'
    : registry.errored
      ? '— SOL'
      : fmtSol(registry.nextPriceLamports);
  const revenueValue = registry.loading
    ? '…'
    : registry.errored
      ? '—'
      : fmtSol(registry.totalRevenue);

  return (
    <div className="rounded-sm hairline bg-gradient-to-r from-inkA via-ink to-inkA overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr_auto] gap-4 items-center p-4">
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-sm overflow-hidden border border-orange/40 bg-orange/5 shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/app-icon.png"
              alt={`${BRAND.name} Dealer License`}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-display text-bone text-base">
                DEALER LICENSE
              </span>
              <span className="font-mono text-[9px] text-boneDim/50 tracking-wider px-1.5 py-0.5 rounded-sm bg-ink hairline">
                OPTIONAL
              </span>
            </div>
            <div className="font-mono text-[10px] text-boneDim/60 mt-0.5">
              Run a crank operator · earn 20% of cash rake + 45% of SNG fees
              on hands you deal
            </div>
          </div>
        </div>

        <div className="flex items-start gap-4 pl-0 md:pl-4 md:border-l border-orange/10">
          <MiniStat k="Licenses minted" v={licensesValue} />
          <MiniStat k="Next price" v={nextPriceValue} />
          <MiniStat k="Pool revenue" v={revenueValue} sub="50 stakers · 50 Platform Fee" />
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/dealer/license"
            className="px-3 py-2 rounded-sm hairline hover:border-orange/60 hover:bg-orange/5 font-mono text-[10px] tracking-[0.18em] text-boneDim hover:text-bone transition whitespace-nowrap"
          >
            MINT LICENSE &rarr;
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────
export default function EarnOverviewPage() {
  return (
    <div id="earn-page-root" className="max-w-[1280px] mx-auto w-full px-3 sm:px-5 space-y-10 pb-16">
      <div id="earn-headline-shell" className="mt-2 mb-2 pt-6 pb-6">
        <PageHeadline
          id="earn-page-headline"
          lineOne="Earn on every"
          lineTwo="Hand dealt."
          subtitleAside
          subtitle={`Burn ${FP} to claim a permanent share of every protocol vault: rake, SNG entries, license sales, token listings. Separate claim per token. No lock-up.`}
        />
      </div>

      <section className="!mt-0">
        <SectionHeader
          eyebrow="YOUR POSITION"
          title="Your stake"
          subtitle={`Burned ${FP}, pool share, and pending yield.`}
        />
        <EarningsHero />
      </section>

      <section>
        <SectionHeader
          eyebrow="01 · YOUR STAKE"
          title="Burn to earn more"
          subtitle={`${FP} burned is stake: permanent, no lock, no cooldown. More burn = larger share of every vault below. One-way: burned ${FP} is gone, but the yield is forever.`}
        />
        <StakeSection />
      </section>

      <section>
        <SectionHeader
          eyebrow="02 · CLAIM · STAKING YIELD"
          title="SOL, FP & USDC vaults"
          subtitle="The primary vaults. SOL aggregates rake + SNG entries + license sales + listings. The reward-token and USDC vaults are SPL rake pools claimed through the token-vault path. One claim transaction per vault."
        />
        <PrimaryVaults />
      </section>

      <section>
        <SectionHeader
          eyebrow="03 · CLAIM · SPL TOKEN VAULTS"
          title="Per-token rake claims"
          subtitle="Listed SPL tokens each keep their own rake vault. Premium SPL vaults are pinned above; other listed tokens are claimed here independently."
        />
        <SplVaultClaims />
      </section>

      <section>
        <SectionHeader
          eyebrow="04 · CLAIM · TOURNAMENT"
          title="Prizes, emissions, FP yield"
          subtitle={`Tournament earnings are separate from staking. Bronze and higher SNGs can pay SOL prizes; every SNG mints Raw ${FP}, and holding Raw ${FP} can earn liquid ${FP}.`}
        />
        <TournamentEarnings />
      </section>

      <section>
        <SectionHeader
          eyebrow="05 · REVENUE STREAMS"
          title="Where the money comes from"
          subtitle="Four protocol streams feed the vaults above. Each card shows the split and the denomination."
        />
        <RevenueStreams />
      </section>

      <section>
        <SectionHeader
          eyebrow="06 · POOL"
          title="The bigger picture"
          subtitle="All-time aggregate metrics and the on-chain daily revenue trend."
        />
        <PoolStats />
      </section>

      <section>
        <DealerCallout />
      </section>

      <div className="flex items-center justify-between px-1 pt-2 font-mono text-[9px] text-boneDim/40 tracking-wider">
        <span>stake_vault · Steel pool · read-only</span>
        <span>anchor IDL · on-chain</span>
      </div>
    </div>
  );
}
