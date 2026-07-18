'use client';

// The Bell Duel flow (presentational, beside the felt): DUEL LIVE / WARM-UP -> opponent -> round
// tracker (R1->R2->R3, current highlighted, passed marked) -> "Showdown" at resolution (both commit,
// or forced R3) -> hero action buttons. Card reveal at resolution is passed in by the integration
// (from the private DeckState/SeatCards the game already reads); this owns the flow/structure.
// Gated on sngDuelRoundsEnabled - no duel surface until the duel rounds ship.

import { useEffect, useState } from 'react';
import { useSngBountyState } from '@/hooks/useSngBountyState';
import { duelView } from '@/lib/sng-duel-view';
import { sngDuelRoundsEnabled } from '@/lib/sng-duel-flags';
import { duelChoiceLabel } from '@/lib/bounty-format';

export type DuelAction = 'all-in' | 'fold';

export default function DuelModal({
  table,
  heroSeat,
  seatName,
  onAction,
  className,
}: {
  table: string | null | undefined;
  heroSeat: number | null;
  seatName?: (seat: number) => string;
  onAction?: (action: DuelAction) => void;
  className?: string;
}) {
  const { state, initialized } = useSngBountyState(table ?? null, 1_500);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 500);
    return () => window.clearInterval(id);
  }, []);

  if (!sngDuelRoundsEnabled() || !initialized || !state) return null;
  const dv = duelView(state, heroSeat);
  if (!dv.active) return null;

  const remain = dv.deadlineTs > 0 ? Math.max(0, dv.deadlineTs - now) : null;
  const nameA = seatName?.(dv.seatA) ?? `Seat ${dv.seatA}`;
  const nameB = seatName?.(dv.seatB) ?? `Seat ${dv.seatB}`;
  const bothCommitted = dv.choiceA !== 0 && dv.choiceB !== 0;
  const resolved = bothCommitted || dv.round >= dv.maxRound;

  const choiceTone = (c: number) =>
    c === 1 ? 'text-amber' : c === 2 ? 'text-bone/40' : 'text-bone/25';
  const choiceLabel = (c: number) => (c === 0 ? 'DECIDING' : duelChoiceLabel(c));

  return (
    <div className={`glass-room w-[280px] rounded-xl p-3 ${className ?? ''}`} data-format="bounty">
      <div className="flex items-center justify-between">
        <span className="font-display text-sm uppercase tracking-[0.2em] text-amber">
          {dv.phase === 'live' ? 'DUEL LIVE' : 'WARM-UP DUEL'}
        </span>
        {remain != null && (
          <span className="font-display text-[11px] tabular-nums text-bone/60">{remain}s</span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-bone">{nameA}</span>
        <span className="font-display text-amber">VS</span>
        <span className="text-bone">{nameB}</span>
      </div>

      <div className="mt-2 flex gap-1">
        {[1, 2, 3].map((r) => (
          <div
            key={r}
            className={`flex-1 rounded border px-1 py-0.5 text-center text-[10px] font-display ${
              r === dv.round
                ? 'border-amber bg-amber/10 text-amber'
                : r < dv.round
                  ? 'border-white/10 text-bone/40'
                  : 'border-white/5 text-bone/25'
            }`}
          >
            R{r}
            {r === 3 ? ' •' : ''}
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] font-display">
        <span className={choiceTone(dv.choiceA)}>{choiceLabel(dv.choiceA)}</span>
        <span className="text-bone/30">round {dv.round}</span>
        <span className={choiceTone(dv.choiceB)}>{choiceLabel(dv.choiceB)}</span>
      </div>

      {resolved && (
        <div className="mt-1 text-center text-[10px] uppercase tracking-[0.2em] text-amber">
          Showdown
        </div>
      )}

      {dv.heroNeedsAction && (remain == null || remain > 0) && onAction && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => onAction('all-in')}
            className="fp-cta-join py-1.5 font-display text-sm"
          >
            PLAY
          </button>
          <button
            onClick={() => onAction('fold')}
            className="rounded-lg border border-white/15 py-1.5 font-display text-sm text-bone/70"
          >
            NEXT CARDS
          </button>
        </div>
      )}
    </div>
  );
}
