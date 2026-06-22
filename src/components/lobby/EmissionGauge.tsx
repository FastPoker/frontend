'use client';

import { useMemo } from 'react';
import {
  EmissionFormat,
  decayMultiplierBps,
  calculateSngEmissionPerSeat,
} from '@/lib/emission';

// Convert whole-token circulating supply to base units for emission lib.
const ONE_WHOLE_BASE = BigInt(1_000_000_000);

function deriveEmission(circulatingSupply: number) {
  const netBase = BigInt(Math.max(0, Math.floor(circulatingSupply))) * ONE_WHOLE_BASE;
  const decayBps = decayMultiplierBps(netBase);
  const decayPct = decayBps / 100; // 0-100
  const huMicro = calculateSngEmissionPerSeat(EmissionFormat.HU, netBase);
  const sixMicro = calculateSngEmissionPerSeat(EmissionFormat.Six, netBase);
  const nineMicro = calculateSngEmissionPerSeat(EmissionFormat.Nine, netBase);
  return {
    decayPct,
    hu: Number(huMicro) / 1_000_000,
    six: Number(sixMicro) / 1_000_000,
    nine: Number(nineMicro) / 1_000_000,
    huPeak: 40,
    sixPeak: 120,
    ninePeak: 180,
  };
}

// ----- FULL: B5 layout — gauge + per-format row + burn pressure footer -----
// Used in the lobby above the SNG/Cash tabs.
export function EmissionGaugeFull({
  circulatingSupply,
  burnPressurePct,
  lastBurnDelta,
  lastBurnAgo,
  share = { hu: 8, six: 34, nine: 58 },
}: {
  circulatingSupply: number;
  burnPressurePct?: number;
  lastBurnDelta?: string;
  lastBurnAgo?: string;
  share?: { hu: number; six: number; nine: number };
}) {
  const e = useMemo(() => deriveEmission(circulatingSupply), [circulatingSupply]);
  // TODO indexer: replace mock burn pressure / last-burn with live 24h aggregates.
  const burnPct = burnPressurePct ?? 28;
  const burnDelta = lastBurnDelta ?? '-0.06';
  const burnAgo = lastBurnAgo ?? '12s';
  const angle = -90 + (e.decayPct / 100) * 180;

  return (
    <div id="sng-emission-strip" className="glass-room hairline rounded-md flex flex-col px-3 py-2 h-[100px] w-full relative overflow-hidden">
      <div
        className="absolute -top-6 left-3 w-[110px] h-[110px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(242,106,31,0.18) 0%, rgba(242,106,31,0) 70%)' }}
      />

      <div className="flex items-center gap-3 flex-1 min-h-0 relative z-10">
        <div className="flex items-center gap-2 w-[110px] shrink-0">
          <svg viewBox="0 0 80 50" className="w-[78px] h-[48px]">
            <defs>
              <linearGradient id="emg-grad" x1="0" x2="1">
                <stop offset="0" stopColor="#F26A1F" stopOpacity="0.4" />
                <stop offset="1" stopColor="#FFC63A" stopOpacity="0.9" />
              </linearGradient>
            </defs>
            <path d="M8 46 A32 32 0 0 1 72 46" fill="none" stroke="#F5F1E6" strokeOpacity="0.08" strokeWidth="6" strokeLinecap="round" />
            <path
              d="M8 46 A32 32 0 0 1 72 46"
              fill="none"
              stroke="url(#emg-grad)"
              strokeWidth="6"
              strokeLinecap="round"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - e.decayPct}
            />
            <line
              x1="40"
              y1="46"
              x2="40"
              y2="18"
              stroke="#F5F1E6"
              strokeWidth="2"
              strokeLinecap="round"
              transform={`rotate(${angle} 40 46)`}
            />
            <circle cx="40" cy="46" r="3" fill="#F26A1F" />
          </svg>
          <div className="flex flex-col leading-none">
            <span className="font-display text-xl text-bone tabular-nums">{e.decayPct.toFixed(0)}%</span>
            <span className="font-mono text-[8px] tracking-[0.22em] text-boneDim/70 mt-1">EMISSION BOOST</span>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-3 gap-2 min-w-0">
          {[
            { l: 'HU', r: e.hu, peak: e.huPeak },
            { l: '6MAX', r: e.six, peak: e.sixPeak },
            { l: '9MAX', r: e.nine, peak: e.ninePeak },
          ].map((c) => {
            const pct = c.peak > 0 ? c.r / c.peak : 0;
            const lit = Math.round(pct * 10);
            return (
              <div key={c.l} className="bg-ink/30 hairline rounded px-2 py-1 flex flex-col gap-0.5">
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-[9px] tracking-[0.22em] text-boneDim/70">{c.l}</span>
                  <span className="font-mono text-[8px] text-boneDim/70 tabular-nums">/{c.peak}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="font-display text-base text-bone tabular-nums leading-none">{c.r.toFixed(1)}</span>
                  <span className="font-mono text-[8px] text-boneDim/70">$FP</span>
                </div>
                <div className="flex gap-px mt-0.5" title={`${c.l} rate ${c.r.toFixed(1)} / peak ${c.peak} (${(pct * 100).toFixed(0)}%)`}>
                  {Array.from({ length: 10 }).map((_, i) => (
                    <div
                      key={i}
                      className={`h-[2px] flex-1 rounded-sm ${i < lit ? 'bg-orange' : 'bg-bone/5'}`}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-1 relative z-10">
        <span className="font-mono text-[8px] tracking-[0.22em] text-amber/70">BURN PRESSURE</span>
        <div className="flex-1 h-[6px] bg-bone/5 rounded-full overflow-hidden relative">
          <div className="h-full bg-amber/70 rounded-full" style={{ width: `${Math.min(burnPct, 100)}%` }} />
        </div>
        <span className="font-display text-sm text-amber tabular-nums leading-none">{burnPct.toFixed(2)}%</span>
        <span className="font-mono text-[8px] text-boneDim/70 tabular-nums">{burnDelta} / {burnAgo}</span>
      </div>
    </div>
  );
}

// ----- MINI: just the gauge for the footer strip ---------------------------
// Used in FooterStrip to the right of the supply stats.
export function EmissionGaugeMini({ circulatingSupply }: { circulatingSupply: number }) {
  const e = useMemo(() => deriveEmission(circulatingSupply), [circulatingSupply]);
  const angle = -90 + (e.decayPct / 100) * 180;

  return (
    <div
      className="flex items-center gap-1.5"
      title={`Global emission boost: ${e.decayPct.toFixed(1)}% of peak rate. Per-seat: HU ${e.hu.toFixed(1)} · 6MAX ${e.six.toFixed(1)} · 9MAX ${e.nine.toFixed(1)} $FP / hand.`}
    >
      <span className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em] uppercase">boost</span>
      <svg viewBox="0 0 60 36" className="w-[42px] h-[26px]">
        <defs>
          <linearGradient id="emg-mini-grad" x1="0" x2="1">
            <stop offset="0" stopColor="#F26A1F" stopOpacity="0.4" />
            <stop offset="1" stopColor="#FFC63A" stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <path d="M6 32 A24 24 0 0 1 54 32" fill="none" stroke="#F5F1E6" strokeOpacity="0.08" strokeWidth="3.5" strokeLinecap="round" />
        <path
          d="M6 32 A24 24 0 0 1 54 32"
          fill="none"
          stroke="url(#emg-mini-grad)"
          strokeWidth="3.5"
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - e.decayPct}
        />
        <line
          x1="30"
          y1="32"
          x2="30"
          y2="14"
          stroke="#F5F1E6"
          strokeWidth="1.5"
          strokeLinecap="round"
          transform={`rotate(${angle} 30 32)`}
        />
        <circle cx="30" cy="32" r="2" fill="#F26A1F" />
      </svg>
      <span className="font-mono text-[10px] text-bone tabular-nums">{e.decayPct.toFixed(0)}%</span>
    </div>
  );
}
