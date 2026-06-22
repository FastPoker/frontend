'use client';

import { useEffect, useState } from 'react';

export interface TournamentStatusProps {
  /** Current blinds level (1-indexed) */
  level: number;
  /** Small blind */
  sb: number;
  /** Big blind */
  bb: number;
  /** Token ticker (e.g., "SOL", "$FP") */
  tokenSymbol: string;
  /** Unix timestamp when blinds will increase. 0 = static. */
  nextLevelAt?: number;
  /** Players remaining */
  playersLeft: number;
  /** Total entrants */
  playersTotal: number;
  /** Total prize pool (formatted) */
  prizePoolLabel: string;
}

export function TournamentStatus({
  level,
  sb,
  bb,
  tokenSymbol,
  nextLevelAt = 0,
  playersLeft,
  playersTotal,
  prizePoolLabel,
}: TournamentStatusProps) {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!nextLevelAt) {
      setRemaining(0);
      return;
    }
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      setRemaining(Math.max(0, nextLevelAt - now));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextLevelAt]);

  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  const timer = remaining > 0 ? `${mm}:${ss.toString().padStart(2, '0')}` : '--';

  return (
    <div className="glass-panel hairline rounded-md px-4 py-3 grid grid-cols-4 gap-4">
      <div>
        <div className="font-mono text-[8px] tracking-[0.3em] text-boneDim/55">LEVEL</div>
        <div className="mt-0.5 font-display text-lg tabular-nums text-bone">{level}</div>
        {nextLevelAt > 0 && (
          <div className="mt-0.5 font-mono text-[9px] tabular-nums text-amber/80">{timer}</div>
        )}
      </div>
      <div>
        <div className="font-mono text-[8px] tracking-[0.3em] text-boneDim/55">BLINDS</div>
        <div className="mt-0.5 font-display text-lg tabular-nums text-bone">
          {sb}/{bb}
        </div>
        <div className="mt-0.5 font-mono text-[9px] text-boneDim/55">{tokenSymbol}</div>
      </div>
      <div>
        <div className="font-mono text-[8px] tracking-[0.3em] text-boneDim/55">PLAYERS</div>
        <div className="mt-0.5 font-display text-lg tabular-nums text-bone">
          {playersLeft}/{playersTotal}
        </div>
        <div className="mt-0.5 h-1 rounded-full bg-bone/10 overflow-hidden">
          <div
            className="h-full bg-orange/80"
            style={{
              width: `${playersTotal > 0 ? (playersLeft / playersTotal) * 100 : 0}%`,
            }}
          />
        </div>
      </div>
      <div>
        <div className="font-mono text-[8px] tracking-[0.3em] text-boneDim/55">PRIZE POOL</div>
        <div className="mt-0.5 font-display text-lg tabular-nums text-amber">
          {prizePoolLabel}
        </div>
      </div>
    </div>
  );
}
