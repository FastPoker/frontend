'use client';
// ============================================================================
// EmissionsFooter
// Shared boost-gauge + burn-pressure footer. Extracted from SizeInPlayToMint so
// both the SNG tab (tab 1) and the Cash tab (tab 2) render the exact same
// element in the same position with a top border under the carousel/grid.
// ============================================================================

const DEFAULT_BOOST = 88;
const DEFAULT_BURN = { pct: 28, delta: '−0.06', ago: '12s' };

export interface EmissionsFooterProps {
  /** 0..100 emission boost %. Falls back to the shared mock when omitted. */
  boost?: number;
  /** Burn pressure read-out. Falls back to the shared mock when omitted. */
  burn?: { pct: number; delta: string; ago: string };
  /** Stable DOM id (defaults to the original SNG id). */
  id?: string;
}

export function EmissionsFooter({ boost, burn, id = 'size-in-play-emissions-footer' }: EmissionsFooterProps) {
  const BOOST = boost ?? DEFAULT_BOOST;
  const BURN = burn ?? DEFAULT_BURN;
  const boostAngle = -90 + (BOOST / 100) * 180;
  return (
    <div id={id} className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4 pt-3 border-t border-gold/10">
      {/* Boost block */}
      <div
        className="flex items-center gap-2"
        title={`Emission boost = how much $FP each seat earns right now vs the peak rate. Drops as more $FP gets minted (decay curve, 5% floor). At ${BOOST.toFixed(2)}%, you get ${BOOST.toFixed(2)}% of peak per game.`}
      >
        <svg viewBox="0 0 70 44" className="w-[60px] h-[36px] shrink-0">
          <defs>
            <linearGradient id="siptm-boost-grad" x1="0" x2="1">
              <stop offset="0" stopColor="#F26A1F" stopOpacity="0.55" />
              <stop offset="0.55" stopColor="#FFC63A" stopOpacity="0.9" />
              <stop offset="1" stopColor="#fb7185" stopOpacity="0.95" />
            </linearGradient>
          </defs>
          <path d="M8 36 A26 26 0 0 1 62 36" fill="none" stroke="#F5F1E6" strokeOpacity="0.08" strokeWidth="5" strokeLinecap="round" />
          <path
            d="M8 36 A26 26 0 0 1 62 36"
            fill="none"
            stroke="#fb7185"
            strokeOpacity={BOOST > 85 ? 0.75 : 0.22}
            strokeWidth="5"
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray="15 85"
            strokeDashoffset="-85"
          />
          <path
            d="M8 36 A26 26 0 0 1 62 36"
            fill="none"
            stroke="url(#siptm-boost-grad)"
            strokeWidth="5"
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray="100"
            strokeDashoffset={100 - BOOST}
          />
          {[0, 25, 50, 75, 100].map((p) => {
            const major = p === 0 || p === 100;
            return (
              <line
                key={p}
                x1="35" y1="9" x2="35" y2={major ? 3.5 : 5.5}
                stroke="#F5F1E6"
                strokeOpacity={major ? 0.6 : 0.32}
                strokeWidth={major ? 1.4 : 1}
                transform={`rotate(${-90 + p * 1.8} 35 36)`}
              />
            );
          })}
          <g transform={`rotate(${boostAngle} 35 36)`} style={{ filter: 'drop-shadow(0 0 3px rgba(255,255,255,0.55))' }}>
            <line x1="35" y1="36" x2="35" y2="11" stroke="#0B0D10" strokeWidth="4.2" strokeLinecap="round" />
            <line x1="35" y1="36" x2="35" y2="11" stroke="#F5F1E6" strokeWidth="2.6" strokeLinecap="round" />
            <polygon points="32,13 38,13 35,7" fill="#fb7185" stroke="#0B0D10" strokeWidth="0.4" />
          </g>
          <circle cx="35" cy="36" r="4" fill="#0B0D10" stroke="#fb7185" strokeWidth="1.2" />
          <circle cx="35" cy="36" r="1.6" fill="#fb7185" />
        </svg>
        {/* Mobile (no sm:): stretch text block to fill the row, right-align so the gauge anchors left and the data hugs the right edge.
            Desktop (sm:): revert to compact left-aligned block next to the gauge. */}
        <div id="emissions-boost-text" className="flex-1 sm:flex-initial flex flex-col leading-none min-w-0 items-end sm:items-start text-right sm:text-left">
          <div className="flex items-baseline gap-1.5 sm:gap-1 justify-end sm:justify-start w-full sm:w-auto">
            <span className="font-display text-base sm:text-sm text-bone tabular-nums tracking-tight">{BOOST.toFixed(2)}<span className="text-[10px] sm:text-[9px] text-boneDim/55 ml-[1px]">%</span></span>
            <span className="font-display text-[11px] sm:text-[10px] tracking-[0.16em] sm:tracking-[0.14em] text-amber/85 uppercase leading-none">Emission Boost</span>
          </div>
          <span className="font-mono text-[9px] text-boneDim/75 mt-1 leading-tight w-full sm:w-auto sm:truncate">$FP per game · drops as minted</span>
        </div>
      </div>

      {/* Burn block */}
      {(() => {
        const baseFill = Math.min(BURN.pct, 100);
        const overFill = Math.min(Math.max(BURN.pct - 100, 0), 100);
        const deepOverFill = Math.max(BURN.pct - 200, 0);
        const isDeflation = BURN.pct > 100;
        const burnColor = isDeflation ? 'text-rose-400' : 'text-amber';
        const burnLabelColor = isDeflation ? 'text-rose-400/85' : 'text-amber/80';
        return (
          <div
            className="flex flex-col gap-1 min-w-0"
            title={`Burn = $FP permanently destroyed by stakers (burn locks a share of every vault: cash rake, SNG fees, license sales, auction proceeds). ${BURN.pct.toFixed(2)}% of circulating burned this week (${BURN.delta} in last ${BURN.ago}).${isDeflation ? ' DEFLATIONARY: more burned than minted in this window.' : ''}`}
          >
            <div className="flex items-baseline gap-1.5">
              <span className={`font-display text-sm tabular-nums leading-none ${burnColor}`}>
                {BURN.pct.toFixed(2)}<span className="text-[9px] opacity-55 ml-[1px]">%</span>
              </span>
              <span className={`font-display text-[10px] tracking-[0.14em] uppercase leading-none ${burnLabelColor}`}>Burn</span>
              {isDeflation && (
                <span className="font-mono text-[7px] tracking-[0.16em] text-rose-400/90 uppercase leading-none px-1 py-[1px] rounded-sm border border-rose-400/40 bg-rose-400/10">DEFLATION</span>
              )}
              <span className="font-mono text-[7px] text-boneDim/55 tabular-nums ml-auto leading-none">{BURN.delta}/{BURN.ago}</span>
            </div>
            <div className="h-[5px] bg-bone/6 rounded-full overflow-hidden relative">
              <div
                className="absolute inset-y-0 left-0 bg-amber/70 transition-all"
                style={{ width: `${baseFill}%`, boxShadow: '0 0 6px rgba(245,158,11,0.35)' }}
              />
              {overFill > 0 && (
                <div
                  className="absolute inset-y-0 left-0 bg-rose-400/55 transition-all mix-blend-screen"
                  style={{ width: `${overFill}%`, boxShadow: '0 0 8px rgba(251,113,133,0.5)' }}
                />
              )}
              {deepOverFill > 0 && (
                <div
                  className="absolute inset-y-0 left-0 bg-rose-500/70 transition-all"
                  style={{ width: `${Math.min(deepOverFill, 100)}%`, boxShadow: '0 0 10px rgba(244,63,94,0.7)' }}
                />
              )}
            </div>
            <span className="font-mono text-[9px] text-boneDim/75 leading-tight truncate">
              {isDeflation ? `+${(BURN.pct - 100).toFixed(0)}% over circulating · supply shrinking` : 'stakers locking $FP for vault share'}
            </span>
          </div>
        );
      })()}
    </div>
  );
}
