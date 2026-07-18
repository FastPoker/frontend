'use client';

// The level-anchored duel-state chip: "Duels: warm-up" (L1-2) -> "DUELS LIVE" (L3+), and (once the
// duel rounds ship) "Duel LIVE" pulsing during an active duel. Branding is present from day one;
// the live indicator only appears when real duels exist (sngDuelRoundsEnabled).

import { useSngBountyState } from '@/hooks/useSngBountyState';
import { duelView } from '@/lib/sng-duel-view';
import { sngDuelsEnabled, sngDuelRoundsEnabled } from '@/lib/sng-duel-flags';
import { DUEL_STATE_LABEL } from '@/lib/bounty-format';

export default function DuelStatusChip({
  table,
  heroSeat,
  currentBlindLevel,
  className,
}: {
  table: string | null | undefined;
  heroSeat: number | null;
  currentBlindLevel: number; // 0-indexed
  className?: string;
}) {
  // Branding is present from day one on any duel-format table: the chip renders warm-up/LIVE from the
  // blind level even before a SngDuelState sidecar exists. The sidecar only adds the pulsing active-duel
  // state. (The mount already scopes this to 6/9-max SNG tables.)
  const { state } = useSngBountyState(table ?? null);
  if (!sngDuelsEnabled()) return null;

  const dv = state ? duelView(state, heroSeat) : null;
  const roundsLive = sngDuelRoundsEnabled();

  let label: string;
  let tone: string;
  let pulse = false;

  if (roundsLive && dv?.active) {
    label = dv.phase === 'live' ? DUEL_STATE_LABEL.active : DUEL_STATE_LABEL.pending;
    tone = 'text-amber border-amber/50 bg-amber/10';
    pulse = true;
  } else {
    const live = currentBlindLevel >= 2; // design L3+ == code level 2+
    label = live ? DUEL_STATE_LABEL.live : DUEL_STATE_LABEL.warmup;
    tone = live
      ? 'text-amber border-amber/40 bg-amber/5'
      : 'text-bone/60 border-white/10 bg-white/5';
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-display uppercase tracking-[0.16em] ${tone} ${
        pulse ? 'animate-pulse' : ''
      } ${className ?? ''}`}
      data-format="bounty"
    >
      {label}
    </span>
  );
}
