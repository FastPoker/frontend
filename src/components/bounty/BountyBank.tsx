'use client';

// The Bounty Bank: hero's running tally of knockouts + $FP/SOL bounty + Maturity.
// PERSISTS after bust (it just renders the hero's on-chain credits, alive or not) and its value
// keeps rising with Maturity until the tournament settles - the engagement hook.

import { useSngBountyState } from '@/hooks/useSngBountyState';
import { bountyBankView, formatPoints, isFlatBounty } from '@/lib/sng-duel-view';
import { maturityBps } from '@/lib/sng-duel';
import { sngDuelsEnabled } from '@/lib/sng-duel-flags';
import { BOUNTY_BANK_NAME } from '@/lib/bounty-format';

const LABEL = 'text-[10px] uppercase tracking-[0.18em] text-bone/50';

function fmtFp(u: bigint | null): string {
  if (u == null) return '--';
  return (Number(u) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtSol(l: bigint | null): string {
  if (l == null) return '--';
  return (Number(l) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export default function BountyBank({
  table,
  heroSeat,
  currentBlindLevel,
  pokerPoolUnrefined,
  solPrizePoolLamports,
  className,
}: {
  table: string | null | undefined;
  heroSeat: number | null;
  currentBlindLevel: number; // 0-indexed live blind level
  pokerPoolUnrefined?: bigint;
  solPrizePoolLamports?: bigint;
  className?: string;
}) {
  // Hero-only surface (it's YOUR bank). Spectators (heroSeat null) don't get one - they see the
  // duel chip instead. A seated hero sees it from hand one: warm-up zeros before the sidecar exists,
  // real credits once it does, and it persists after bust because heroSeat is the fixed on-chain seat.
  const { state } = useSngBountyState(table ?? null);
  if (!sngDuelsEnabled() || heroSeat == null) return null;

  const bank = state
    ? bountyBankView(state, heroSeat, currentBlindLevel, { pokerPoolUnrefined, solPrizePoolLamports })
    : {
        koCount: 0,
        points: 0,
        koCreditUnits: 0n,
        fpWeightUnits: 0n,
        maturityBps: maturityBps(currentBlindLevel),
        settled: false,
        projectedFpUnrefined: null as bigint | null,
        projectedSolLamports: null as bigint | null,
      };
  const maturityPct = Math.min(100, Math.round(bank.maturityBps / 100));
  // Bounty Shield: the count is HELD POINTS - everyone starts with 1 in the bank
  // (worth pool/points-in-play from the first seeded hand) and duels move them.
  const shield = !!state && isFlatBounty(state);

  return (
    <div className={`glass-card rounded-xl px-3 py-2 ${className ?? ''}`} data-format="bounty">
      <div className="flex items-center justify-between">
        <span className={LABEL}>{BOUNTY_BANK_NAME}</span>
        {bank.settled ? <span className={`${LABEL} text-amber`}>SETTLED</span> : null}
      </div>

      <div className="mt-1 flex items-baseline gap-4">
        <div className="text-center">
          <div className="font-display text-2xl leading-none text-amber tabular-nums">{formatPoints(bank.points)}</div>
          <div className={LABEL}>{shield ? 'PTS' : 'KO'}</div>
        </div>
        <div className="text-center">
          <div className="font-display text-2xl leading-none text-amber tabular-nums">
            {fmtFp(bank.projectedFpUnrefined)}
          </div>
          <div className={LABEL}>$FP{bank.settled ? '' : ' proj'}</div>
        </div>
        {bank.projectedSolLamports != null && (
          <div className="text-center">
            <div className="font-display text-2xl leading-none text-emerald-400 tabular-nums">
              {fmtSol(bank.projectedSolLamports)}
            </div>
            <div className={LABEL}>SOL{bank.settled ? '' : ' proj'}</div>
          </div>
        )}
      </div>

      <div className="mt-2">
        <div className="flex items-center justify-between">
          <span className={LABEL}>Maturity{bank.settled ? '' : ' (rising)'}</span>
          <span className="text-[11px] font-display text-gold tabular-nums">{maturityPct}%</span>
        </div>
        <div className="mt-0.5 h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-gold to-amber transition-[width] duration-500"
            style={{ width: `${maturityPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
