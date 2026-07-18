'use client';

// The SnG Duels top HUD strip (replaces the tier/buy-in status strip on duel-format tables).
// Markup mirrors the approved /ideas/bounty-mini "assembled" cluster 1:1, wired to live data:
// tier chip · blinds (Lvl / current / next) · players · collected bounty (total chip) · maturity dots.
// Buy-in, pool and the KO/bounty standings live in the right-rail action bar, not here.

import { useSngBountyState } from '@/hooks/useSngBountyState';
import { bountyBankView } from '@/lib/sng-duel-view';
import { maturityBps } from '@/lib/sng-duel';
import { TokenMark } from './TokenMark';

const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d });
// Dividers are desktop-only; on phones the cluster wraps and dividers just add noise.
const Div = () => <div className="hidden md:block h-7 w-px bg-white/10" />;

export default function BountyHudBar({
  table,
  heroSeat,
  tierName,
  level,
  curBlinds,
  nextBlinds,
  playersLeft,
  totalPlayers,
  pokerPoolUnrefined,
  solPrizePoolLamports,
}: {
  table?: string | null;
  heroSeat: number | null;
  tierName: string;
  level: number;
  curBlinds: { small: number; big: number };
  nextBlinds: { small: number; big: number } | null;
  playersLeft: number;
  totalPlayers: number;
  pokerPoolUnrefined?: bigint;
  solPrizePoolLamports?: bigint;
}) {
  const { state } = useSngBountyState(table ?? null);
  const bank = state ? bountyBankView(state, heroSeat, level, { pokerPoolUnrefined, solPrizePoolLamports }) : null;
  const matPct = Math.min(100, Math.round((bank?.maturityBps ?? maturityBps(level)) / 100));
  const lit = Math.min(4, Math.max(0, Math.round(matPct / 25))); // 4-step ladder (25/50/75/100)
  const fpVal = bank?.projectedFpUnrefined != null ? Number(bank.projectedFpUnrefined) / 1_000_000 : 0;
  const solVal = bank?.projectedSolLamports != null ? Number(bank.projectedSolLamports) / 1e9 : 0;

  return (
    // Black card style, 1:1 with the approved /ideas/bounty-mini assembled cluster.
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 md:gap-6 rounded-xl border border-white/10 bg-black/40 px-3 py-1.5 md:px-5 md:py-2"
      data-format="bounty"
    >
      {/* tier + level + blinds as ONE flat stat, same label-over-value grammar as every other
          column - no more badge-in-a-box fighting the card (design note 2026-07-02). */}
      <div className="flex flex-col leading-none min-w-0">
        <span className="font-mono text-[8px] uppercase tracking-[0.18em] whitespace-nowrap">
          <span className="text-gold">{tierName}</span>
          <span className="text-bone/30"> &middot; </span>
          {/* Humans count blind levels from 1; on-chain blind_level is 0-based. Display-only
              shift - maturity/duel math keep the raw level (maturity IS full on the 4th level). */}
          <span className="text-orange">Level {level + 1}</span>
        </span>
        <span className="mt-1 font-display text-base tabular-nums leading-none text-bone whitespace-nowrap">
          {fmt(curBlinds.small)}/{fmt(curBlinds.big)}
          {nextBlinds && <span className="text-bone/35"> &rarr; {fmt(nextBlinds.small)}/{fmt(nextBlinds.big)}</span>}
        </span>
      </div>
      <Div />

      {/* players */}
      <div className="flex flex-col items-center leading-none">
        <span className="font-mono text-[8px] uppercase tracking-widest text-bone/45">Players</span>
        <span className="mt-1 font-display text-base tabular-nums text-bone">{playersLeft}/{totalPlayers}</span>
      </div>

      <div className="flex-1" />

      {/* collected bounty total (chip) */}
      <span className="inline-flex items-center gap-2.5 rounded-full border border-amber/25 bg-amber/[0.06] px-3 py-1">
        {/* "Bank": every knockout deposits here; it keeps maturing and settles at the end. */}
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber/60">Bank</span>
        <span className="inline-flex items-center gap-1 font-display text-sm tabular-nums text-gold"><TokenMark t="fp" size={13} />{fmt(fpVal)}</span>
        <span className="inline-flex items-center gap-1 font-display text-sm tabular-nums text-emerald-400"><TokenMark t="sol" size={13} />{fmt(solVal, 2)}</span>
      </span>
      <Div />

      {/* maturity dots + label */}
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <span key={i} className={`h-2 w-2 rounded-full ${i < lit ? 'bg-amber' : 'border border-white/20'}`} />
          ))}
        </div>
        <span className="font-mono text-[8px] uppercase tracking-[0.18em] text-bone/45">Maturity</span>
      </div>
    </div>
  );
}
