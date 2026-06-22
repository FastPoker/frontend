'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// SizeInPlayToMint
// Reusable lobby widget extracted from agent-A.tsx :: A5().
// Hero "SIZE IN. PLAY TO MINT." filter - combines table-size segmented control,
// SOL/$FP prize meters, buy-in tier slider, emission boost gauge and burn
// pressure footer into one controlled card.
//
// All props are optional - when omitted the widget falls back to its internal
// state (default: Copper tier, ANY format) and to mock emission/burn numbers.
// ============================================================================

import { useState, useEffect } from 'react';
import { EmissionsFooter } from '@/components/lobby/EmissionsFooter';
import { TIERS as SNG_TIERS } from '@/lib/constants';

// Lucky Pot opt-in preference, sticky in localStorage. Default ON (auto-selected).
const LUCKY_POT_STORAGE_KEY = 'fp.quickplay.luckyPot';
function useLuckyPotPref() {
  const [optIn, setOptIn] = useState<boolean>(true);
  useEffect(() => {
    try {
      const v = localStorage.getItem(LUCKY_POT_STORAGE_KEY);
      if (v === '0') setOptIn(false);
    } catch { /* SSR / private mode */ }
  }, []);
  const set = (v: boolean) => {
    setOptIn(v);
    try { localStorage.setItem(LUCKY_POT_STORAGE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };
  return [optIn, set] as const;
}

// Display accents; economic values are derived from @/lib/constants so the
// widget stays in lockstep with the contract twin.
const TIER_STYLES = [
  { id: 'copper',   color: 'text-[#A05A2C]', hex: '#A05A2C' },
  { id: 'bronze',   color: 'text-[#C77A3F]', hex: '#C77A3F' },
  { id: 'silver',   color: 'text-[#D7D5CE]', hex: '#D7D5CE' },
  { id: 'gold',     color: 'text-[#F2C94C]', hex: '#F2C94C' },
  { id: 'platinum', color: 'text-[#86E1D1]', hex: '#86E1D1' },
  { id: 'diamond',  color: 'text-[#6EE7F0]', hex: '#6EE7F0' },
  { id: 'black',    color: 'text-[#E8E2D6]', hex: '#0c0c0c' },
] as const;

const TIERS = TIER_STYLES.map((style, idx) => {
  const economic = SNG_TIERS[idx] ?? SNG_TIERS[0];
  const buyin = economic.totalBuyIn / 1e9;
  const prize = economic.entryAmount / 1e9;
  const fee = economic.feeAmount / 1e9;
  return {
    ...style,
    label: economic.name,
    buyin,
    prize,
    fee,
    prizeType: 'SOL + $FP',
    prizePct: buyin > 0 ? Math.round((prize / buyin) * 100) : 0,
  };
});

// A tier's accent hex doubles as the buy-in text color. The Black tier is
// near-black (#0c0c0c), which is unreadable as text on the dark panel — give
// such dark tiers a crisp white outline so the value (e.g. "5") stays legible
// while keeping the black accent.
function isDarkHex(hex: string): boolean {
  const h = hex.replace('#', '');
  if (h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) < 60;
}
const WHITE_OUTLINE =
  '-1px -1px 0 rgba(255,255,255,0.95), 1px -1px 0 rgba(255,255,255,0.95), -1px 1px 0 rgba(255,255,255,0.95), 1px 1px 0 rgba(255,255,255,0.95), 0 0 2px rgba(255,255,255,0.9)';

const FORMATS = ['HU', '6-Max', '9-Max'] as const;

const PER_SEAT_FP = { 'HU': 40, '6-Max': 120, '9-Max': 180 } as const;
export type FormatKey = keyof typeof PER_SEAT_FP;

// Mocks used when caller doesn't pass live emission props
const DEFAULT_BOOST = 88;
const DEFAULT_CURRENT_FP: Record<FormatKey, number> = { 'HU': 35, '6-Max': 106, '9-Max': 158 };
const DEFAULT_BURN = { pct: 28, delta: '−0.06', ago: '12s' };

export interface SizeInPlayToMintProps {
  /** 0..6 (matches SnGTier enum) or null = ANY. */
  selectedTier?: number | null;
  onTierChange?: (idx: number | null) => void;
  selectedFormat?: FormatKey | null;
  onFormatChange?: (f: FormatKey | null) => void;
  /** Drop the player into the most-filled matching pool. Receives Lucky Pot opt-in. */
  onQuickPlay?: (luckyOptIn: boolean) => void;
  /** Disable Quick Play (e.g. while a join is in flight, or zero matches). */
  quickPlayDisabled?: boolean;
  /** Live player counts per format - drives the LED-bar fill on each pill. */
  playersByFormat?: Record<FormatKey, number>;
  /** Wallet connect / state morphing inputs (drives the button verb). */
  walletConnected?: boolean;
  onConnectWallet?: () => void;
  /** SOL balance in SOL units. When < required buy-in, button shows "NEED X SOL". */
  solBalance?: number;
  /** Resume target - if set, button morphs to "RESUME" instead of "QUICK PLAY". */
  resumeTablePda?: string | null;
  onResume?: (pda: string) => void;
  /** Lucky Pot add-on amount in SOL (e.g. 0.01). Defaults to 0.01 if omitted. */
  luckyPotSol?: number;
  /** Overrides internal (anyTier?6:1)*(anyFormat?3:1) match calc. */
  matchCount?: number;
  // Emission state - falls back to mocks when omitted
  boostPct?: number;
  currentFp?: Record<FormatKey, number>;
  burn?: { pct: number; delta: string; ago: string };
}

// Tiny controlled-or-uncontrolled state hook
function useControllableState<T>(controlled: T | undefined, onChange: ((v: T) => void) | undefined, initial: T) {
  const [internal, setInternal] = useState<T>(initial);
  const isControlled = controlled !== undefined;
  const value = isControlled ? (controlled as T) : internal;
  const setValue = (v: T) => {
    if (!isControlled) setInternal(v);
    onChange?.(v);
  };
  return [value, setValue] as const;
}

export function SizeInPlayToMint(props: SizeInPlayToMintProps) {
  // null = ANY (wildcard). Defaults: idx=0 (Copper), format=null (ANY).
  const [idx, setIdx] = useControllableState<number | null>(props.selectedTier, props.onTierChange, 0);
  const [format, setFormat] = useControllableState<FormatKey | null>(props.selectedFormat, props.onFormatChange, null);
  const [luckyOptIn, setLuckyOptIn] = useLuckyPotPref();
  const luckyPotSol = props.luckyPotSol ?? 0.01;

  const anyTier = idx === null;
  const anyFormat = format === null;
  const tier = anyTier ? TIERS[3] : (TIERS[idx!] ?? TIERS[0]);
  const pct = anyTier ? 50 : (idx! / 6) * 100;

  // Emission state (live or mock)
  const BOOST = props.boostPct ?? DEFAULT_BOOST;
  const CURRENT_FP: Record<FormatKey, number> = props.currentFp ?? DEFAULT_CURRENT_FP;
  const BURN = props.burn ?? DEFAULT_BURN;

  // Prize structure mirrors programs/fastpoker constants:
  // PayoutStructure first-place share = 100% HU / 65% 6-Max / 50% 9-Max
  const FIRST_SHARE: Record<FormatKey, number> = { 'HU': 1.0, '6-Max': 0.65, '9-Max': 0.50 };
  const SEATS_BY_FORMAT: Record<FormatKey, number> = { 'HU': 2, '6-Max': 6, '9-Max': 9 };
  const tierPrizeRatio = (t: typeof TIERS[number]) => t.prizePct / 100;
  const computePool = (t: typeof TIERS[number], f: FormatKey) =>
    t.buyin * SEATS_BY_FORMAT[f] * tierPrizeRatio(t);
  const computeMaxWin = (t: typeof TIERS[number], f: FormatKey) =>
    computePool(t, f) * FIRST_SHARE[f];
  const computeMult = (t: typeof TIERS[number], f: FormatKey) =>
    SEATS_BY_FORMAT[f] * tierPrizeRatio(t) * FIRST_SHARE[f];

  // Active-cell numbers
  const activeFmt: FormatKey = anyFormat ? '6-Max' : format!;
  const pool = anyTier ? 0 : computePool(tier, activeFmt);
  const maxWin = anyTier ? 0 : computeMaxWin(tier, activeFmt);
  const mult = anyTier ? 0 : computeMult(tier, activeFmt);

  // Range when either axis is ANY
  const allCombos = TIERS.flatMap((t) =>
    (FORMATS as readonly FormatKey[]).map((f) => ({ t, f, pool: computePool(t, f), win: computeMaxWin(t, f), mult: computeMult(t, f) }))
  );
  const filteredCombos = allCombos.filter((c) =>
    (anyTier || c.t.id === tier.id) && (anyFormat || c.f === format)
  );
  const poolsInRange = filteredCombos.map((c) => c.pool).filter((p) => p > 0);
  const winsInRange = filteredCombos.map((c) => c.win).filter((w) => w > 0);
  const multsInRange = filteredCombos.map((c) => c.mult).filter((m) => m > 0);
  const poolLo = poolsInRange.length ? Math.min(...poolsInRange) : 0;
  const poolHi = poolsInRange.length ? Math.max(...poolsInRange) : 0;
  const winLo = winsInRange.length ? Math.min(...winsInRange) : 0;
  const winHi = winsInRange.length ? Math.max(...winsInRange) : 0;
  const multLo = multsInRange.length ? Math.min(...multsInRange) : 0;
  const multHi = multsInRange.length ? Math.max(...multsInRange) : 0;
  void winLo; void multLo; void poolLo; void poolHi; void mult; // referenced only for parity with source
  const fmtSol = (n: number) => n < 0.1 ? n.toFixed(3) : n.toFixed(2);

  // Bar fills normalized against absolute max win (Black 9-Max = 20.25 SOL).
  const ABSOLUTE_MAX_WIN = 5.0 * 9 * 0.9 * 0.5; // 20.25
  const solEvFill = Math.sqrt(Math.max(anyTier ? winHi : maxWin, 0) / ABSOLUTE_MAX_WIN);
  void solEvFill;

  const perSeatNow = anyFormat ? null : CURRENT_FP[format!];
  void perSeatNow;

  // $FP pool maths - mirrors SNG_FP_EMISSIONS_PLAN.md
  const FP_FIRST_SHARE: Record<FormatKey, number> = { 'HU': 1.0, '6-Max': 0.55, '9-Max': 0.50 };
  const ROYAL_SKIM = 0.10;
  const computeFpGross = (f: FormatKey) => CURRENT_FP[f] * SEATS_BY_FORMAT[f];
  const computeFpFirst = (f: FormatKey) => computeFpGross(f) * (1 - ROYAL_SKIM) * FP_FIRST_SHARE[f];
  const fpPool = anyFormat ? null : computeFpGross(format!);
  const fpFirst = anyFormat ? null : computeFpFirst(format!);
  const fpPoolsAll = (FORMATS as readonly FormatKey[]).map(computeFpGross);
  const fpFirstsAll = (FORMATS as readonly FormatKey[]).map(computeFpFirst);
  const fpPoolLo = Math.min(...fpPoolsAll);
  const fpPoolHi = Math.max(...fpPoolsAll);
  const fpFirstLo = Math.min(...fpFirstsAll);
  const fpFirstHi = Math.max(...fpFirstsAll);
  const fpFill = anyFormat ? 1 : (fpPool! / fpPoolHi);
  void fpPool; void fpFill; void fpPoolLo;

  const matchCount = props.matchCount ?? ((anyTier ? 7 : 1) * (anyFormat ? 3 : 1));

  return (
    <div>
      {/* Header pair: hero title (left) + filter controls (right) on desktop; stacked on mobile. */}
      <div id="size-in-play-header" className="px-4 lg:px-6 md:flex md:items-start md:justify-between md:gap-4">
        {/* Hero header */}
        <div id="size-in-play-hero" className="py-3 text-center sm:text-left md:text-left md:flex-1 md:min-w-0">
          <div className="font-display text-bone text-[22px] sm:text-[26px] leading-none tracking-[0.04em]">
            SIZE IN. <span className="text-orange italic">PLAY TO MINT.</span>
          </div>
          <div className="font-mono text-[10px] text-boneDim/70 tracking-[0.04em] mt-1.5">
            Pick a buy-in &amp; table size. Top finishers mint <span className="text-amber">$FP</span> and split the <span className="text-emerald-400">SOL</span> pool. Bottom seats get nothing.
          </div>
        </div>
        {/* Filter status + ANY toggles - sits to the right of the hero on desktop, stacked
            vertically (filter/match label on top, toggle buttons below). */}
        <div id="size-in-play-filter-row" className="flex items-center justify-between gap-2 mb-2 px-0 md:flex-col md:items-end md:gap-2 md:mb-0 md:py-3 md:shrink-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[9px] tracking-[0.22em] text-boneDim/60 uppercase">Filter</span>
            <span className="font-mono text-[8px] tracking-[0.14em] text-boneDim/45 uppercase tabular-nums">
              {matchCount} match{matchCount === 1 ? '' : 'es'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setIdx(anyTier ? 3 : null)}
              aria-label={anyTier ? 'Pick specific buy-in' : 'Show all buy-ins'}
              title="Toggle: show all buy-in tiers vs the one picked on the slider"
              className={`px-1.5 py-[1px] rounded font-mono text-[7px] tracking-[0.14em] uppercase border transition-all ${
                anyTier
                  ? 'bg-emerald-400/15 border-emerald-400/45 text-emerald-400'
                  : 'bg-bone/4 border-bone/15 text-boneDim/55 hover:border-bone/30'
              }`}
            >
              {anyTier ? '✓' : '+'} all tiers
            </button>
            <button
              onClick={() => setFormat(anyFormat ? '6-Max' : null)}
              aria-label={anyFormat ? 'Pick specific table size' : 'Show all table sizes'}
              title="Toggle: show all table sizes vs the one picked"
              className={`px-1.5 py-[1px] rounded font-mono text-[7px] tracking-[0.14em] uppercase border transition-all ${
                anyFormat
                  ? 'bg-amber/15 border-amber/45 text-amber'
                  : 'bg-bone/4 border-bone/15 text-boneDim/55 hover:border-bone/30'
              }`}
            >
              {anyFormat ? '✓' : '+'} all sizes
            </button>
          </div>
        </div>
      </div>

      <div id="size-in-play-body" className="px-4 pt-2.5 pb-2.5">
        {/* Desktop only: pair table-size row + quick-play card side-by-side (50/50).
            Both columns stretch to equal heights so the table-size buttons grow to
            match the quick-play card. */}
        <div
          className="flex flex-col md:grid md:grid-cols-2 md:gap-x-4 md:gap-y-3 md:items-stretch md:content-evenly md:mb-5"
          style={{ gridTemplateAreas: '"format quickplay" "buyin quickplay"' }}
        >
        {/* Table-size segmented control with ANY pill */}
        <div id="size-in-play-format-row" className="mb-2.5 md:mb-0 md:flex md:flex-col" style={{ gridArea: 'format' }}>
          <div className="flex items-baseline justify-between mb-3">
            <span className="font-display text-[13px] tracking-[0.1em] text-bone/85 uppercase leading-none">Table Size</span>
            <span className="font-mono text-[8px] text-amber/75 tracking-[0.12em] uppercase">scales SOL + $FP</span>
          </div>
          {(() => {
            // Player-density LED bars: fill each format pill relative to the busiest
            // format. Bigger fill = more players waiting in that format = more action.
            const playerCounts = props.playersByFormat ?? { 'HU': 0, '6-Max': 0, '9-Max': 0 };
            const maxFormatPlayers = Math.max(playerCounts['HU'], playerCounts['6-Max'], playerCounts['9-Max'], 1);
            const totalPlayers = playerCounts['HU'] + playerCounts['6-Max'] + playerCounts['9-Max'];
            // Nothing/Redesign skill applied - segmented buttons rebuilt around a three-layer hierarchy:
            //   primary  = format glyph (display, tightened tracking)
            //   tertiary = descriptor (mono caps)
            //   data     = thin player-density meter pinned to bottom
            // Vertical rhythm via justify-between; "no negative space" via clamp() that scales label,
            // descriptor, gaps and meter together with container width.
            const buttonClass = (active: boolean) =>
              `group/btn relative flex flex-col items-stretch justify-between gap-[clamp(4px,2cqw,10px)] px-[clamp(6px,3cqw,14px)] py-[clamp(7px,3.5cqw,14px)] max-h-[72px] overflow-hidden rounded-md border transition-all duration-150 [container-type:inline-size] ${
                active
                  ? 'bg-black border-[rgb(100,48,27)] text-orange shadow-[inset_0_2px_4px_rgba(0,0,0,0.7),inset_0_1px_2px_rgba(0,0,0,0.8),inset_0_-1px_0_rgba(255,255,255,0.06)]'
                  : 'bg-black border-bone/15 text-bone/55 hover:border-bone/35 hover:text-bone/80'
              }`;
            const renderMeter = (litCount: number, lit: 'active' | 'inactive') => (
              <div className="flex w-full items-stretch gap-[clamp(1px,0.4cqw,2px)] h-[clamp(2px,1.2cqw,4px)]">
                {Array.from({ length: 10 }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-full flex-1 rounded-sm ${
                      i < litCount
                        ? lit === 'active' ? 'bg-orange' : 'bg-bone/30'
                        : 'bg-bone/8'
                    }`}
                  />
                ))}
              </div>
            );
            // Top-right state checkbox: empty square when inactive, lightning bolt when active.
            const renderCheckbox = (active: boolean) => (
              <span
                aria-hidden
                className={`absolute top-[clamp(4px,1.4cqw,8px)] right-[clamp(4px,1.4cqw,8px)] w-[clamp(10px,3cqw,14px)] h-[clamp(10px,3cqw,14px)] rounded-[2px] border flex items-center justify-center transition-colors ${
                  active ? 'border-orange bg-orange/10' : 'border-bone/25 bg-transparent'
                }`}
              >
                {active && (
                  <svg viewBox="0 0 12 12" className="w-[clamp(7px,2.2cqw,10px)] h-[clamp(7px,2.2cqw,10px)] text-orange" fill="currentColor" aria-hidden>
                    <path d="M7 1 L2.5 7.2 L5.3 7.2 L4.3 11 L9.5 4.8 L6.7 4.8 Z" />
                  </svg>
                )}
              </span>
            );
            return (
              <div className="grid grid-cols-4 gap-[clamp(4px,1.2cqw,10px)]">
                {/* ANY */}
                <button
                  onClick={() => setFormat(null)}
                  aria-label="Any table size"
                  aria-pressed={anyFormat}
                  title={`${totalPlayers} player${totalPlayers === 1 ? '' : 's'} across all formats`}
                  className={buttonClass(anyFormat)}
                >
                  {renderCheckbox(anyFormat)}
                  <span className="font-display tracking-tighter leading-[0.9] text-center whitespace-nowrap text-[clamp(10px,12cqw,26px)]">ANY</span>
                  <span className={`font-mono uppercase tracking-[0.22em] leading-none text-center text-[clamp(7px,2.6cqw,10px)] ${anyFormat ? 'text-orange/70' : 'text-bone/40'}`}>
                    All sizes
                  </span>
                  {renderMeter(10, anyFormat && totalPlayers > 0 ? 'active' : 'inactive')}
                </button>

                {/* HU / 6-Max / 9-Max */}
                {(FORMATS as readonly FormatKey[]).map((f) => {
                  const seats = f === 'HU' ? 2 : f === '6-Max' ? 6 : 9;
                  const players = playerCounts[f];
                  const lit = Math.round((players / maxFormatPlayers) * 10);
                  const isActive = !anyFormat && format === f;
                  const display = f === 'HU' ? 'HU' : f === '6-Max' ? '6-MAX' : '9-MAX';
                  return (
                    <button
                      key={f}
                      onClick={() => setFormat(f)}
                      aria-label={`Table size ${f}`}
                      aria-pressed={isActive}
                      title={`${players} player${players === 1 ? '' : 's'} waiting in ${f}`}
                      className={buttonClass(isActive)}
                    >
                      {renderCheckbox(isActive)}
                      <span className="font-display tracking-tighter leading-[0.9] text-center whitespace-nowrap tabular-nums text-[clamp(10px,12cqw,26px)]">{display}</span>
                      <span className={`font-mono uppercase tracking-[0.22em] leading-none text-center text-[clamp(7px,2.6cqw,10px)] ${isActive ? 'text-orange/70' : 'text-bone/40'}`}>
                        {seats} seats
                      </span>
                      {renderMeter(lit, isActive ? 'active' : 'inactive')}
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Buy-in slider - moved into the left column (desktop) to share the column with table size.
            Mobile: stays in DOM order (after table size) so the page flows naturally. */}
        <div id="size-in-play-buyin-slider" className="order-3 mt-2 md:order-none md:mt-0" style={{ gridArea: 'buyin' }}>
          {/* Row 1: label (left) + caption (right) */}
          <div id="size-in-play-buyin-header" className="flex items-baseline justify-between mb-1">
            <span className="font-display text-[13px] tracking-[0.1em] text-bone/85 uppercase leading-none">Buy-in</span>
            <span className="font-mono text-[8px] text-emerald-400/75 tracking-[0.12em] uppercase leading-none">10% fee · 90% prize</span>
          </div>
          {/* Row 2: hero value - the primary layer of this section */}
          <div id="size-in-play-buyin-value" className="flex items-baseline gap-2 mb-2 leading-none">
            {anyTier ? (
              <>
                <span className="font-display text-[24px] tabular-nums tracking-tight text-emerald-400 leading-none">ALL</span>
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-boneDim/70">0.05–5 SOL</span>
                <span className="sm:hidden ml-auto font-display text-[16px] tracking-[0.12em] leading-none uppercase text-emerald-400 transition-all">
                  ALL TIERS
                </span>
              </>
            ) : (
              <>
                <span className="font-display text-[28px] tabular-nums tracking-tight leading-none transition-colors" style={{ color: tier.hex, textShadow: isDarkHex(tier.hex) ? WHITE_OUTLINE : undefined }}>
                  {tier.buyin}
                </span>
                <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-boneDim/70">
                  SOL<span className="hidden sm:inline"> · {tier.label}</span>
                </span>
                <span className={`sm:hidden ml-auto font-display text-[16px] tracking-[0.12em] leading-none uppercase transition-all ${tier.color}`}>
                  {tier.label}
                </span>
              </>
            )}
          </div>
          {/* Row 3: track + handle. */}
          <div
            id="size-in-play-buyin-track"
            className={`group relative h-[10px] mb-2 transition-opacity ${anyTier ? 'opacity-40' : ''}`}
          >
            <div
              className="absolute inset-0 rounded-full bg-bone/15 ring-1 ring-bone/8"
              style={{ boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.45), inset 0 -1px 0 rgba(255,255,255,0.04)' }}
            />
            {!anyTier && pct < 100 && (
              <div
                aria-hidden
                className="absolute inset-y-0 rounded-r-full pointer-events-none transition-all duration-200"
                style={{
                  left: `${pct}%`,
                  right: 0,
                  background: 'repeating-linear-gradient(45deg, rgba(245,241,230,0.10) 0px, rgba(245,241,230,0.10) 2px, transparent 2px, transparent 6px)',
                }}
              />
            )}
            {Array.from({ length: TIERS.length - 1 }, (_, i) => i).map((i) => (
              <div
                key={i}
                aria-hidden
                className="absolute top-1/2 -translate-y-1/2 w-px h-[18px] bg-bone/30 pointer-events-none"
                style={{ left: `calc(${(i / (TIERS.length - 1)) * 100}% - 0.5px)` }}
              />
            ))}
            {!anyTier && (
              <>
                <div
                  className="absolute inset-y-0 left-0 rounded-r-full transition-all duration-200"
                  style={{
                    width: `${pct}%`,
                    background: tier.id === 'black'
                        ? 'linear-gradient(180deg, #2e2e2e 0%, #080808 55%, #1c1c1c 100%)'
                        : tier.hex,
                    boxShadow: tier.id === 'black'
                      ? 'inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(0,0,0,0.7), 0 0 8px rgba(140,140,140,0.18)'
                      : `inset 0 -1px 0 rgba(0,0,0,0.25), 0 0 8px ${tier.hex}60`,
                  }}
                />
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-[22px] h-[22px] rounded-full border-2 transition-all duration-150 flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-bone/70 peer-active:scale-110 group-active:scale-110 group-hover:scale-105"
                  style={{
                    left: `calc(${pct}% - 11px)`,
                    background: tier.id === 'black'
                        ? 'linear-gradient(135deg, #3a3a3a 0%, #060606 45%, #222222 100%)'
                        : tier.hex,
                    borderColor: tier.id === 'black' ? 'rgba(255,255,255,0.18)' : 'rgba(245,241,230,0.95)',
                    boxShadow: tier.id === 'black'
                      ? '0 0 0 1.5px rgba(0,0,0,0.95), 0 2px 8px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.30), 0 0 14px rgba(180,180,180,0.14)'
                      : `0 0 0 1.5px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4), 0 0 14px ${tier.hex}a0`,
                  }}
                >
                  <div className="flex gap-[2px] pointer-events-none">
                    <div className={`w-px h-[7px] rounded-full ${tier.id === 'black' ? 'bg-white/40' : 'bg-bone/90'}`} />
                    <div className={`w-px h-[7px] rounded-full ${tier.id === 'black' ? 'bg-white/40' : 'bg-bone/90'}`} />
                    <div className={`w-px h-[7px] rounded-full ${tier.id === 'black' ? 'bg-white/40' : 'bg-bone/90'}`} />
                  </div>
                </div>
              </>
            )}
            <input
              type="range" min={0} max={TIERS.length - 1} step={1} value={idx ?? 3}
              aria-label="Buy-in tier"
              disabled={anyTier}
              onChange={(e) => setIdx(Number(e.target.value))}
              className="peer absolute inset-0 w-full opacity-0 cursor-grab active:cursor-grabbing h-full disabled:cursor-not-allowed"
            />
          </div>
          {/* Desktop tier label row - column count tracks TIERS length so a new
              tier (e.g. Black) automatically gets its slot without a layout edit. */}
          <div id="size-in-play-buyin-tier-row" className="hidden sm:grid gap-px" style={{ gridTemplateColumns: `repeat(${TIERS.length}, minmax(0, 1fr))` }}>
            {TIERS.map((t, i) => {
              const active = !anyTier && i === idx;
              return (
                <button
                  key={t.id}
                  aria-label={`Select ${t.label}`}
                  onClick={() => setIdx(i)}
                  title={t.label}
                  className={`font-display text-center tracking-[0.02em] leading-none uppercase transition-all border-none bg-transparent cursor-pointer truncate px-[1px] py-[2px] ${
                    active ? `${t.color} text-[11px]` : 'text-boneDim/40 text-[9px] hover:text-boneDim/85 hover:scale-105'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Quick Play - full-width hero CTA. Shows both prize potentials at a glance:
            MINT UP TO X $FP (always) and WIN UP TO X SOL. */}
        {(() => {
          // Actual 1st-place $FP (post 10% Royal skim, after PayoutStructure share),
          // NOT per-seat emission. Mirrors the contract's fpFirst computation.
          const earnFp = anyFormat ? Math.round(fpFirstHi) : Math.round(fpFirst!);
          const fpRangeLow = anyFormat ? Math.round(fpFirstLo) : null;
          // Buy-in cost - `tier.buyin` already includes the fee (totalBuyIn from
          // contract). Lucky Pot add-on is opt-in and excluded from the displayed price.
          const allTotals = TIERS.map(t => t.buyin).sort((a, b) => a - b);
          const buyinDisplay = anyTier
            ? `${fmtSol(allTotals[0])}–${fmtSol(allTotals[allTotals.length - 1])}`
            : fmtSol(tier.buyin);
          // Win-up-to SOL: specific tier => maxWin, ANY tier => winHi (top of range).
          const winUpToSol = (anyTier || anyFormat) ? winHi : maxWin;
          const noMatches = matchCount === 0;
          const disabled = props.quickPlayDisabled || noMatches;
          return (
            <div id="size-in-play-quickplay" className="relative mb-[0.625rem] md:self-start" style={{ gridArea: 'quickplay' }}>
              <button
                type="button"
                onClick={() => { if (!disabled) props.onQuickPlay?.(luckyOptIn); }}
                disabled={disabled}
                aria-label={`Quick Play, mint up to ${earnFp} $FP, win up to ${fmtSol(winUpToSol)} SOL, buy-in ${buyinDisplay} SOL`}
                className="w-full rounded-md font-bold flex flex-col items-stretch justify-center p-0 border-2 border-orange/80 ring-1 ring-orange/40 shadow-[0_4px_18px_rgba(242,106,31,0.35),inset_0_1px_0_rgba(255,255,255,0.18)] overflow-hidden bg-transparent brightness-125 hover:brightness-125 transition-all duration-150 active:scale-[0.98] active:translate-y-[1px] active:shadow-[0_2px_8px_rgba(242,106,31,0.4),inset_0_1px_0_rgba(255,255,255,0.18)] opacity-100 disabled:opacity-100"
              >
                {/* Top - image background. Replaces prior emerald gradient. */}
                <div
                  id="quickplay-prize-panel"
                  className="flex flex-col items-stretch gap-3 px-3 py-[35px] md:py-[39px]"
                  style={{
                    backgroundImage: "url('/brand/quick_play.png')",
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                    boxShadow: [
                      // Vignette - two stacked inset shadows for soft, deep darkening at the edges
                      'inset 0 0 36px 6px rgba(0,0,0,0.55)',
                      'inset 0 0 90px rgba(0,0,0,0.35)',
                      // Existing top highlight + amber bottom hairline
                      'inset 0 1px 0 rgba(255,255,255,0.18)',
                      '0 1px 0 rgba(255,198,58,0.55)',
                    ].join(', '),
                  }}
                >
                  <div className="grid grid-cols-[1fr_1px_1fr] items-center">
                  {/* MINT UP TO $FP - left stat */}
                  {(() => {
                    const FP_PAID_BY_FORMAT: Record<FormatKey, number> = { 'HU': 1, '6-Max': 5, '9-Max': 7 };
                    const fpPaidLabel = anyFormat
                      ? `ITM 1–${Math.max(...Object.values(FP_PAID_BY_FORMAT))}`
                      : FP_PAID_BY_FORMAT[format!] === 1 ? 'ITM 1st' : `ITM 1–${FP_PAID_BY_FORMAT[format!]}`;
                    return (
                      <div
                        id="quickplay-prize-mint"
                        className="flex flex-col items-center justify-center leading-none [text-wrap:balance] text-bone"
                        style={{ textShadow: '0 0 1px rgba(0,0,0,1), 0 0 2px rgba(0,0,0,1), 0 1px 4px rgba(0,0,0,0.95), 0 2px 10px rgba(0,0,0,0.85), 0 0 20px rgba(0,0,0,0.7)' }}
                      >
                        {/* Line 1 - label (tertiary) */}
                        <span className="font-display text-[11px] tracking-[0.22em] uppercase text-white leading-none mb-[6px]">MINT UP TO</span>
                        {/* Line 2 - big number only */}
                        <span className="font-display text-[26px] sm:text-[36px] tabular-nums leading-none">
                          {fpRangeLow !== null ? `${fpRangeLow}–${earnFp}` : earnFp}
                        </span>
                        {/* Line 3 - token icon + meta text */}
                        <span className="inline-flex items-center gap-1.5 font-mono text-[8px] tracking-[0.2em] mt-[8px] leading-none">
                          <img src="/brand/app-icon.png" alt="$FP" className="w-[18px] h-[18px]" />
                          {fpPaidLabel}
                        </span>
                      </div>
                    );
                  })()}
                  {/* Vertical divider between paired stats */}
                  <div aria-hidden className="h-[68%] w-px bg-bone/20 justify-self-center" />
                  {/* WIN UP TO SOL */}
                  {(() => {
                    const SOL_PAID_BY_FORMAT: Record<FormatKey, number> = { 'HU': 1, '6-Max': 2, '9-Max': 3 };
                    const solPaidLabel = anyFormat
                      ? `ITM 1–${Math.max(...Object.values(SOL_PAID_BY_FORMAT))}`
                      : SOL_PAID_BY_FORMAT[format!] === 1 ? 'ITM 1st' : `ITM 1–${SOL_PAID_BY_FORMAT[format!]}`;
                    return (
                      <div
                        id="quickplay-prize-win"
                        className="flex flex-col items-center justify-center leading-none [text-wrap:balance] text-bone"
                        style={{ textShadow: '0 0 1px rgba(0,0,0,1), 0 0 2px rgba(0,0,0,1), 0 1px 4px rgba(0,0,0,0.95), 0 2px 10px rgba(0,0,0,0.85), 0 0 20px rgba(0,0,0,0.7)' }}
                      >
                        {/* Line 1 - label */}
                        <span className="font-display text-[11px] tracking-[0.22em] uppercase text-white leading-none mb-[6px]">WIN UP TO</span>
                        {/* Line 2 - big number only */}
                        <span className="font-display text-[26px] sm:text-[36px] tabular-nums leading-none">
                          {winUpToSol > 0 ? fmtSol(winUpToSol) : '0'}
                        </span>
                        {/* Line 3 - token icon + meta text */}
                        <span className="inline-flex items-center gap-1.5 font-mono text-[8px] tracking-[0.2em] mt-[8px] leading-none">
                          <img src="/tokens/sol.svg" alt="SOL" className="w-[18px] h-[18px]" />
                          {solPaidLabel}
                        </span>
                      </div>
                    );
                  })()}
                  </div>
                </div>
                {/* Bottom - orange brand band, BLACK text for contrast. */}
                <div
                  className="px-3 py-3 text-black flex flex-col items-center justify-center gap-y-1"
                  style={{ background: 'linear-gradient(180deg, #F26A1F 0%, #d85a16 100%)' }}
                >
                  {/* BUY-IN - read-out above the main CTA */}
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] opacity-95">
                    <span>BUY-IN</span>
                    <span className="tabular-nums font-bold">{buyinDisplay}</span>
                    <img src="/tokens/sol.svg" alt="SOL" className="w-[10px] h-[10px]" />
                  </span>
                  {/* QUICK PLAY */}
                  <span className="font-display text-[18px] sm:text-[20px] tracking-[0.2em] leading-none">
                    QUICK PLAY ▸
                  </span>
                </div>
              </button>
              {/* Lucky Pot toggle - independent of the QUICK PLAY button so disabled-state
                  opacity on the parent doesn't bleed into this control. */}
              {/* Lucky Pot - interactive toggle. Same visual frame as the BUY-IN readout
                  (transparent + blur + hairline border) so the two read as a matched pair,
                  but a clear switch UI inside signals interactivity. */}
              <button
                type="button"
                role="switch"
                aria-checked={luckyOptIn}
                onClick={() => setLuckyOptIn(!luckyOptIn)}
                aria-label={luckyOptIn ? 'Lucky Pot ON - tap to remove side jackpot.' : 'Lucky Pot OFF - tap to add side jackpot.'}
                title={luckyOptIn ? 'Lucky Pot ON - extra side jackpot. Tap to remove.' : 'Lucky Pot OFF - tap to add side jackpot.'}
                className="absolute left-1/2 -translate-x-1/2 bottom-[4.5rem] inline-flex items-center gap-2 leading-none px-2.5 py-1.5 rounded-md text-white cursor-pointer transition-colors hover:border-white/25"
                style={{
                  background: luckyOptIn ? '#064e3b' : '#000000',
                  border: '1px solid rgba(255,255,255,0.10)',
                  backdropFilter: 'blur(8px) saturate(1.1)',
                  WebkitBackdropFilter: 'blur(8px) saturate(1.1)',
                  textShadow: '0 0 1px rgba(0,0,0,1), 0 1px 3px rgba(0,0,0,0.85)',
                }}
              >
                <span className="font-mono text-[10px] tracking-[0.18em] uppercase">Lucky</span>
                {/* Toggle switch */}
                <span
                  aria-hidden
                  className={`relative inline-block w-[22px] h-[12px] rounded-full transition-colors ${
                    luckyOptIn ? 'bg-emerald-500/85' : 'bg-white/20'
                  }`}
                >
                  <span
                    className={`absolute top-[1px] w-[10px] h-[10px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.45)] transition-all duration-150 ${
                      luckyOptIn ? 'left-[11px]' : 'left-[1px]'
                    }`}
                  />
                </span>
                <span className="font-mono text-[10px] tabular-nums leading-none font-bold">+{luckyPotSol}</span>
              </button>
            </div>
          );
        })()}
        </div>{/* /md:grid pair */}

        {/* Footer: boost gauge + burn pressure (shared with the Cash tab) */}
        <EmissionsFooter boost={BOOST} burn={BURN} />
      </div>
    </div>
  );
}
