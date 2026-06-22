'use client';

export interface SidePot {
  /** 0 = main pot, 1+ = side pots */
  index: number;
  /** Formatted amount (e.g., "1.25 SOL") */
  amountLabel: string;
  /** Player handles eligible for this pot */
  eligible: string[];
}

export interface SidePotsDisplayProps {
  pots: SidePot[];
}

export function SidePotsDisplay({ pots }: SidePotsDisplayProps) {
  if (pots.length === 0) return null;
  return (
    <div className="glass-panel hairline rounded-md px-3 py-2.5 space-y-2 min-w-[200px]">
      <div className="font-mono text-[8px] tracking-[0.3em] text-boneDim/55">POTS</div>
      {pots.map((pot) => (
        <div key={pot.index} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[9px] tracking-[0.22em] text-boneDim/70">
              {pot.index === 0 ? 'MAIN' : `SIDE ${pot.index}`}
            </span>
            <span className="font-display text-sm tabular-nums text-amber">
              {pot.amountLabel}
            </span>
          </div>
          {pot.eligible.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {pot.eligible.map((p, i) => (
                <span
                  key={i}
                  className="font-mono text-[8px] px-1.5 py-0.5 rounded-sm border border-bone/10 bg-ink/40 text-boneDim/65 truncate max-w-[80px]"
                >
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
