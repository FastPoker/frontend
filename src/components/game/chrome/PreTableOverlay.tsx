'use client';

import { useEffect, useState } from 'react';

export interface PreTableOverlayProps {
  /** Game format */
  format: 'cash' | 'sng';
  /** Seats filled vs total */
  seatsFilled: number;
  seatsTotal: number;
  /** Seats ready (SNG ready-up phase) */
  seatsReady?: number;
  /** Ready deadline (unix seconds). 0 means no deadline active. */
  readyDeadline?: number;
  /** Pool entry label (e.g., "0.1 SOL") */
  entryLabel?: string;
  /** Bottom-of-overlay hint */
  hint?: string;
}

export function PreTableOverlay({
  format,
  seatsFilled,
  seatsTotal,
  seatsReady = 0,
  readyDeadline = 0,
  entryLabel,
  hint,
}: PreTableOverlayProps) {
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (!readyDeadline) {
      setCountdown(0);
      return;
    }
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      setCountdown(Math.max(0, readyDeadline - now));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [readyDeadline]);

  const isSng = format === 'sng';
  const waitingForSeats = seatsFilled < seatsTotal;
  const waitingForReady = !waitingForSeats && isSng && seatsReady < seatsTotal;

  const headline = waitingForSeats
    ? 'WAITING FOR PLAYERS'
    : waitingForReady
    ? 'READY CHECK'
    : 'STARTING';

  const sub = waitingForSeats
    ? isSng
      ? `Seats fill and stakes start. ${seatsTotal - seatsFilled} more to join.`
      : 'Tap a seat to join.'
    : waitingForReady
    ? 'All seats in. Confirm you\'re at the table.'
    : 'Dealing in...';

  const progressPct = waitingForSeats
    ? (seatsFilled / seatsTotal) * 100
    : waitingForReady
    ? (seatsReady / seatsTotal) * 100
    : 100;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
      <div className="glass-pop hairline rounded-lg px-8 py-6 pointer-events-auto fade-in shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
        <div className="font-mono text-[9px] tracking-[0.32em] text-boneDim/65 text-center">
          {isSng ? 'SIT N GO' : 'CASH TABLE'}
          {entryLabel && <span className="text-boneDim/45"> · {entryLabel}</span>}
        </div>
        <div className="font-display text-2xl text-bone tracking-[0.18em] text-center mt-2">
          {headline}
        </div>
        <div className="font-mono text-[10px] text-boneDim/75 tracking-wide text-center mt-1 max-w-[320px]">
          {sub}
        </div>

        <div className="mt-5 flex items-center gap-2 justify-center">
          {Array.from({ length: seatsTotal }).map((_, i) => {
            const filled = i < seatsFilled;
            const ready = i < seatsReady;
            return (
              <div
                key={i}
                className={[
                  'w-6 h-6 rounded-full border flex items-center justify-center transition-colors',
                  ready
                    ? 'bg-emerald-500/25 border-emerald-400/60'
                    : filled
                    ? 'bg-orange/20 border-orange/60'
                    : 'bg-ink/40 border-bone/15',
                ].join(' ')}
              >
                <span
                  className={[
                    'font-mono text-[9px] tabular-nums',
                    ready ? 'text-emerald-200' : filled ? 'text-orange' : 'text-boneDim/40',
                  ].join(' ')}
                >
                  {i + 1}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-4 h-[3px] rounded-full bg-bone/10 overflow-hidden w-[280px] mx-auto">
          <div
            className="h-full bg-orange transition-[width] duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        {waitingForReady && readyDeadline > 0 && (
          <div className="text-center mt-3 font-mono text-[11px] tabular-nums text-amber tracking-[0.24em]">
            {countdown}s REMAINING
          </div>
        )}

        {hint && (
          <div className="text-center mt-3 font-mono text-[9px] tracking-[0.2em] text-boneDim/55">
            {hint}
          </div>
        )}
      </div>
    </div>
  );
}
