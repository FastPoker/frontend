'use client';

import { cn } from '@/lib/utils';

export interface SeatNameplateProps {
  /** Display handle (prefer handle over short pubkey) */
  label: string;
  /** Chip/stack value formatted (e.g., "1.420 SOL") */
  stackLabel: string;
  /** Action label: FOLD / CHECK / CALL / RAISE / ALL-IN / WAITING / etc. */
  actionLabel?: string;
  /** Timer seconds remaining (hero seat only) */
  timerSeconds?: number;
  /** Active state */
  isActive?: boolean;
  isHero?: boolean;
  isDealer?: boolean;
  isWinner?: boolean;
  isFolded?: boolean;
  isSittingOut?: boolean;
  /** Optional bet chip badge (e.g., "0.05") */
  betLabel?: string;
}

export function SeatNameplate({
  label,
  stackLabel,
  actionLabel,
  timerSeconds,
  isActive,
  isHero,
  isDealer,
  isWinner,
  isFolded,
  isSittingOut,
  betLabel,
}: SeatNameplateProps) {
  const tone = isWinner
    ? 'border-emerald-400/60 bg-emerald-500/10'
    : isActive
    ? 'border-orange/60 bg-orange/10 active-breath'
    : isFolded
    ? 'border-bone/10 bg-ink/40 opacity-60'
    : isSittingOut
    ? 'border-bone/10 bg-ink/40 opacity-50'
    : isHero
    ? 'border-amber/40 bg-ink/55'
    : 'border-bone/15 bg-ink/45';

  return (
    <div
      className={cn(
        'relative rounded-md border px-3 py-2 min-w-[132px] transition-colors',
        tone,
      )}
    >
      {isDealer && (
        <span className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-amber text-ink font-display text-[11px] font-bold flex items-center justify-center shadow-[0_4px_12px_rgba(244,165,42,0.45)]">
          D
        </span>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-bone tracking-wide truncate max-w-[90px]">
          {label}
        </span>
        {typeof timerSeconds === 'number' && isHero && (
          <span className="font-mono text-[10px] tabular-nums text-amber">{timerSeconds}s</span>
        )}
      </div>
      <div className="mt-0.5 font-display text-sm tabular-nums text-bone">{stackLabel}</div>
      {actionLabel && (
        <div
          className={cn(
            'mt-1 font-mono text-[9px] tracking-[0.24em]',
            isWinner ? 'text-emerald-300' : isActive ? 'text-orange' : 'text-boneDim/65',
          )}
        >
          {actionLabel}
        </div>
      )}
      {betLabel && (
        <span className="absolute -top-2 right-2 rounded-full px-2 py-0.5 bg-amber text-ink font-mono text-[9px] tabular-nums font-bold shadow-[0_4px_10px_rgba(244,165,42,0.4)]">
          {betLabel}
        </span>
      )}
    </div>
  );
}
