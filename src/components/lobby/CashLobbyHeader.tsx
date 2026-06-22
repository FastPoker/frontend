'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// CashLobbyHeader - live-data port of CashHybridV2_3 mockup.
//
// Sources:
//   • Visual structure: src/app/ideas/_variants/cards-cash-hybrid-v2.tsx
//     (CashHybridV2_3 + atoms Header / Spotlight / MiniGrid / filter row)
//   • Live data shape: CashTable from src/components/lobby/Lobby.tsx
//   • Boost meta:      CashTable.boost (already populated by indexer, see
//                       src/lib/boosts.ts)
//
// Filter state ownership (May 2026 unification):
//   • CashSection (Lobby.tsx) owns the unified `CashFilterState`. The shape is
//     exported from this file so both the header and the cash list import the
//     same type. The filter row inside the header is the SINGLE source of
//     truth for token pins, format pills, BB range and table/creator search.
//     The bottom CashFilterBar is gone.
//
// Rules of engagement:
//   • Renders boosted tables in the spotlight + grid (`boost?.active === true`).
//     The cash list in CashSection handles everything else and excludes these.
//   • If no tables are boosted: shows the busiest tables instead so the spot
//     never sits empty.
//   • Token logos reuse the same /tokens/sol.svg + /brand/app-icon.png
//     mapping that FeaturedCashCard uses.
// ============================================================================
import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { PublicKey } from '@solana/web3.js';
import { POKER_MINT, USDC_MAINNET_MINT, USDC_DEVNET_MINT } from '@/lib/constants';
import { useListedTokens, useTokenMeta } from '@/hooks/useListedTokens';
import { SFX } from '@/lib/sfx';
import type { TableStats } from '@/hooks/useTableStats';

// Re-declare CashTable inline to avoid a circular import with Lobby.tsx.
// MUST stay structurally compatible with Lobby.tsx#CashTable.
export interface CashTable {
  pubkey: string;
  phase: number;
  currentPlayers: number;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  gameType: number;
  pot: number;
  handNumber: number;
  isDelegated: boolean;
  isUserCreated: boolean;
  tokenMint: string;
  /** Real token decimals (from /api/tables/list). USDC=6, SOL/$FP=9, etc. */
  decimals: number;
  location: string;
  rakeCap?: number;
  isPrivate?: boolean;
  creator?: string;
  boost?: {
    active: boolean;
    tier: 'standard' | 'high' | 'top';
    remainingMs: number;
    boosterCount: number;
    rank: number | null;
  };
}

// ─── Unified filter shape (single source of truth) ──────────────────────────
export type CashFormat = 'HU' | '6-Max' | '9-Max';

/** List-view sort columns. `fill` = default (closest-to-fill ASC, pot DESC). */
export type CashSortKey = 'fill' | 'stakes' | 'seats' | 'pot' | 'avgpot' | 'vpip' | 'hph';
export type CashSortDir = 'asc' | 'desc';

export interface CashFilterState {
  /** SOL + $FP + USDC are the default pinned chips + up to 4 user-added symbols. */
  pinnedTokens: string[];
  /** Empty = ALL formats. */
  formats: CashFormat[];
  /** Free-text search: matches table pubkey / creator / token symbol. */
  search: string;
  /** Custom BB range (token-units, numeric compare). */
  bbMin?: number;
  bbMax?: number;
  /** Custom seat-count range (raw seat count, e.g. 2 to 9). */
  minSeats?: number;
  maxSeats?: number;
  /** Include full tables in the cash list. */
  showFull: boolean;
  /** Include private (password-locked) tables in the cash list. */
  showPrivate: boolean;
  /** List-view column sort. Default `fill` = closest-to-fill ASC, pot DESC. */
  sortKey: CashSortKey;
  sortDir: CashSortDir;
}

export const DEFAULT_CASH_FILTER: CashFilterState = {
  pinnedTokens: ['SOL', '$FP', 'USDC'],
  formats: [],
  search: '',
  bbMin: undefined,
  bbMax: undefined,
  minSeats: undefined,
  maxSeats: undefined,
  showFull: false,
  showPrivate: false,
  sortKey: 'fill',
  sortDir: 'asc',
};

// ─── Token mapping helpers (live-data) ──────────────────────────────────────
const TOKEN_COLORS: Record<string, string> = {
  SOL:   '#F26A1F',
  '$FP': '#FFC63A',
  USDC:  '#2775CA',
};

function tokenSymbolFor(mint: string): string {
  if (mint === PublicKey.default.toBase58()) return 'SOL';
  if (mint === POKER_MINT.toBase58()) return '$FP';
  if (mint === USDC_MAINNET_MINT.toBase58() || mint === USDC_DEVNET_MINT.toBase58()) return 'USDC';
  return mint.slice(0, 4) + '…';
}

function tokenIconFor(mint: string): string | null {
  const sym = tokenSymbolFor(mint);
  if (sym === 'SOL') return '/tokens/sol.svg';
  if (sym === '$FP') return '/brand/app-icon.png';
  if (sym === 'USDC') return '/tokens/usdc.svg';
  return null; // forces SymbolMonogram fallback
}

// ─── Format helpers (Lobby.tsx parity) ──────────────────────────────────────
const SOL_DECIMALS = 9;
function fmtAmount(raw: number, decimals: number = SOL_DECIMALS): string {
  const v = raw / 10 ** decimals;
  if (v >= 1) return v.toFixed(2).replace(/\.?0+$/, '');
  if (v >= 0.001) return parseFloat(v.toPrecision(3)).toString();
  return v.toExponential(1);
}
/**
 * BB-only display. Used by the header range filter (where users type a numeric
 * range, so a single value is unambiguous).
 */
function fmtBigBlind(bb: number, decimals: number = SOL_DECIMALS): string {
  return fmtAmount(bb, decimals);
}

/**
 * SB / BB pair. Used on Spotlight + MiniGrid table cards so users can read the
 * stake structure at a glance (matches the cash list rows).
 */
function fmtBlinds(sb: number, bb: number, decimals: number = SOL_DECIMALS): string {
  return `${fmtAmount(sb, decimals)} / ${fmtAmount(bb, decimals)}`;
}
function formatLabel(maxPlayers: number): CashFormat {
  if (maxPlayers <= 2) return 'HU';
  if (maxPlayers <= 6) return '6-Max';
  return '9-Max';
}

// ─── Atoms (extracted verbatim from cards-cash-hybrid-v2.tsx) ───────────────
const SolIcon = ({ size = 12 }: { size?: number }) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img src="/tokens/sol.svg" alt="SOL" style={{ width: size, height: size }} />
);
const FpIcon = ({ size = 12 }: { size?: number }) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img src="/brand/app-icon.png" alt="$FP" style={{ width: size, height: size }} />
);
const UsdcIcon = ({ size = 12 }: { size?: number }) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img src="/tokens/usdc.svg" alt="USDC" style={{ width: size, height: size }} />
);

function SymbolMonogram({ symbol, size }: { symbol: string; size: number }) {
  const color = TOKEN_COLORS[symbol] ?? '#B8B4A8';
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-mono font-bold"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(7, size * 0.45),
        background: `${color}22`,
        color,
        border: `1px solid ${color}66`,
      }}
    >
      {symbol.replace('$', '')[0]}
    </span>
  );
}

function TokenLogo({ symbol, icon, size = 14 }: { symbol: string; icon: string | null; size?: number }) {
  if (!icon) return <SymbolMonogram symbol={symbol} size={size} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={icon} alt={symbol} style={{ width: size, height: size }} className="rounded-full" />;
}

type BoostTier = 'standard' | 'high' | 'top';
const boostColor = (tier?: BoostTier) =>
  tier === 'top'      ? 'text-rose-400 border-rose-400/45 bg-rose-400/10'
  : tier === 'high'   ? 'text-orange  border-orange/50  bg-orange/12'
  : tier === 'standard' ? 'text-amber border-amber/45  bg-amber/10'
  : 'text-boneDim/75 border-bone/20 bg-bone/5';

function rankToStars(rank?: number | null): number {
  if (!rank || rank < 1) return 0;
  if (rank === 1) return 5;
  if (rank === 2) return 4;
  if (rank === 3) return 3;
  if (rank === 4) return 2;
  return 1;
}

function StarRating({ count, max = 5, size = 9 }: { count: number; max?: number; size?: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={`Boost rank ${count} of ${max} stars`}
      className="inline-flex items-center gap-[1px] tabular-nums"
      style={{ fontSize: size, lineHeight: 1 }}
    >
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < count ? 'text-amber' : 'text-bone/15'}>★</span>
      ))}
    </span>
  );
}

// ─── Loud pot pill ──────────────────────────────────────────────────────────
function PotBadge({
  pot, tokenSymbol, tokenIcon, size = 'lg', decimals = SOL_DECIMALS,
}: {
  pot: number;
  tokenSymbol: string;
  tokenIcon: string | null;
  size?: 'sm' | 'md' | 'lg';
  decimals?: number;
}) {
  const num = size === 'lg' ? 'text-[27px] sm:text-[30px]'
            : size === 'md' ? 'text-[32px]'
            : 'text-[11px]';
  const display = pot > 0 ? fmtAmount(pot, decimals) : '0';
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`font-display ${num} tabular-nums text-white leading-none`}>{display}</span>
      <span className="font-mono text-[12px] tracking-[0.12em] uppercase text-white/65 leading-none">{tokenSymbol}</span>
    </span>
  );
}

// ─── Filter constants ──────────────────────────────────────────────────────
const FORMATS: CashFormat[] = ['HU', '6-Max', '9-Max'];

// CashFeatured - internal projection of CashTable for spotlight/grid.
type CashFeatured = {
  pubkey: string;
  format: CashFormat;
  seats: number;
  filled: number;
  smallBlindRaw: number;
  bigBlindRaw: number;
  potRaw: number;
  tokenSymbol: string;
  tokenIcon: string | null;
  rakeCapBb: number;
  boostTier?: BoostTier;
  boosterCount?: number;
  rank?: number | null;
  remainingMs?: number;
  handNumber?: number;
  /** Real token decimals for this table (USDC=6, SOL/$FP=9, etc.). */
  decimals: number;
  /** Convenience: BB in human units for range filtering. */
  bbValue: number;
  /** Search corpus: pubkey, creator, token symbol. */
  searchKey: string;
};

function tableToFeatured(
  t: CashTable,
  resolve: { symbolFor: (m: string) => string; iconFor: (m: string) => string | null },
): CashFeatured {
  const sym = resolve.symbolFor(t.tokenMint);
  const rakeCapBb = t.bigBlind > 0 ? Math.round((t.rakeCap ?? 0) / t.bigBlind * 10) / 10 : 5;
  return {
    pubkey: t.pubkey,
    format: formatLabel(t.maxPlayers),
    seats: t.maxPlayers,
    filled: t.currentPlayers,
    smallBlindRaw: t.smallBlind,
    bigBlindRaw: t.bigBlind,
    potRaw: t.pot,
    tokenSymbol: sym,
    tokenIcon: resolve.iconFor(t.tokenMint),
    rakeCapBb,
    boostTier: t.boost?.tier,
    boosterCount: t.boost?.boosterCount,
    rank: t.boost?.rank ?? undefined,
    remainingMs: t.boost?.remainingMs,
    handNumber: t.handNumber > 0 ? t.handNumber : undefined,
    decimals: t.decimals ?? SOL_DECIMALS,
    bbValue: t.bigBlind / 10 ** (t.decimals ?? SOL_DECIMALS),
    searchKey: `${t.pubkey} ${t.creator ?? ''} ${sym}`.toLowerCase(),
  };
}

// Popular tokens that can be search-pinned. Shown as suggestions in the
// TokenSearch dropdown until live indexer feeds a richer catalog.
/**
 * Apply the unified `CashFilterState` to a list of featured tables (used by
 * the spotlight + minigrid). The cash list in CashSection runs an equivalent
 * filter against the raw `CashTable[]`.
 */
export function applyFeaturedFilter(featured: CashFeatured[], filter: CashFilterState): CashFeatured[] {
  const q = filter.search.trim().toLowerCase();
  const searching = q.length > 0;
  // Active search OVERRIDES the token chips: typing a symbol (e.g. HYPE) must
  // match it even while SOL/$FP/USDC are pinned. Previously SOL/$FP/USDC were
  // hardcoded into `allowed`, so a searched/pinned SPL token was always filtered
  // out. The allow-list is now exactly the pins (no hardcoded defaults), and it's
  // skipped entirely while searching.
  const pinnedActive = !searching && filter.pinnedTokens.length > 0;
  const formatActive = filter.formats.length > 0;
  const min = filter.bbMin;
  const max = filter.bbMax;
  return featured.filter(t => {
    if (pinnedActive && !filter.pinnedTokens.includes(t.tokenSymbol)) return false;
    if (formatActive && !filter.formats.includes(t.format)) return false;
    if (q && !t.searchKey.includes(q)) return false;
    if (min !== undefined && !Number.isNaN(min) && t.bbValue < min) return false;
    if (max !== undefined && !Number.isNaN(max) && t.bbValue > max) return false;
    return true;
  });
}

// ─── Spotlight (manual carousel - pager dots only, no auto-rotate) ──────────
function useSpotlight(tables: CashFeatured[]) {
  const sorted = useMemo(() => {
    // Paid boost placement (if any boosted tables are live) keeps its rank order.
    if (tables.some(t => t.rank != null)) {
      return [...tables].sort((a, b) => {
        const ra = a.rank ?? 99;
        const rb = b.rank ?? 99;
        if (ra !== rb) return ra - rb;
        return b.potRaw - a.potRaw;
      });
    }
    // Default: feature the CLOSEST-TO-FULL tables that already have players, so
    // they fill the rest of the way fast. Cap the rotation at 3 (1 if only one
    // table has players). Only when NOTHING is populated do we fall back to a
    // few joinable empties so the card is never blank.
    const byFull = (a: CashFeatured, b: CashFeatured) => {
      const fa = a.seats > 0 ? a.filled / a.seats : 0;
      const fb = b.seats > 0 ? b.filled / b.seats : 0;
      if (fb !== fa) return fb - fa;           // closest to full first
      if (b.filled !== a.filled) return b.filled - a.filled; // then more players
      return b.potRaw - a.potRaw;              // then bigger pot
    };
    const populated = tables.filter(t => t.filled > 0).sort(byFull);
    if (populated.length > 0) return populated.slice(0, 3);
    return [...tables].sort((a, b) => (b.potRaw - a.potRaw) || (a.bbValue - b.bbValue)).slice(0, 3);
  }, [tables]);
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const N = Math.max(sorted.length, 1);

  useEffect(() => { setActive(0); }, [sorted.length]);
  // Auto-advance the carousel every 4s (matches the timing-meter duration).
  useEffect(() => {
    if (paused || N <= 1) return;
    const id = setInterval(() => setActive(a => (a + 1) % N), 4000);
    return () => clearInterval(id);
  }, [paused, N]);

  return { active, setActive, paused, setPaused, current: sorted[active], N, sorted };
}

function Spotlight({
  tables, onTakeSeat, isFallback, stats, names,
}: {
  tables: CashFeatured[];
  onTakeSeat: (pubkey: string) => void;
  /** When true, header shows "BUSIEST" - these are the busiest tables shown
      because no boosted tables are live, not curated boosted slots. */
  isFallback?: boolean;
  stats?: Record<string, TableStats | null>;
  names?: Record<string, string | null>;
}) {
  const { active, setActive, paused, setPaused, current, N, sorted } = useSpotlight(tables);
  const empty = sorted.length === 0;

  return (
    <div
      className="relative overflow-hidden"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <style jsx>{`
        @keyframes hyb-fade { from { opacity: 0; transform: translateX(-28px); } to { opacity: 1; transform: translateX(0); } }
        .hyb-fade { animation: hyb-fade 0.45s ease-out; }
        @keyframes hyb-progress { from { transform: scaleX(0); } to { transform: scaleX(1); } }
        .hyb-progress { animation: hyb-progress 4s linear infinite; transform-origin: left; }
        .hyb-progress-paused { animation-play-state: paused; }
        @keyframes nav-fade { from { opacity: 0; } to { opacity: 1; } }
        .nav-fade { opacity: 0; animation: nav-fade 0.3s ease-out 0.45s forwards; }
      `}</style>

      {/* No padding here - the outer body wrapper supplies it (mirrors tab 1's
          quickplay cell, which has no px so the card = full grid-cell width). */}
      <div className="relative">

        {empty ? (
          <div className="py-8 text-center">
            <div className="font-display text-bone/70 text-[18px] tracking-[0.1em]">NO BOOSTED TABLES MATCH</div>
            <div className="font-mono text-[10px] text-boneDim/55 mt-2">Adjust the filter row below to widen the spotlight.</div>
          </div>
        ) : (
          <div className="relative">
          {sorted.map((table, i) => {
            const isActive = i === active;
            const s = stats?.[table.pubkey] ?? null;
            return (
              <div
                key={table.pubkey}
                style={{
                  position: isActive ? 'relative' : 'absolute',
                  inset: isActive ? undefined : 0,
                  opacity: isActive ? 1 : 0,
                  pointerEvents: isActive ? 'auto' : 'none',
                  transition: 'opacity 0.4s ease-out',
                  zIndex: isActive ? 1 : 0,
                }}
              >
            <button
              type="button"
              onClick={() => { SFX.play('ui-click'); onTakeSeat(table.pubkey); }}
              className="relative w-full rounded-md font-bold flex flex-col items-stretch p-0 border-2 border-orange/80 ring-1 ring-orange/40 shadow-[0_4px_18px_rgba(242,106,31,0.35),inset_0_1px_0_rgba(255,255,255,0.18)] overflow-hidden bg-transparent brightness-125 transition-[transform,box-shadow] duration-150 active:scale-[0.98] active:translate-y-[1px]"
            >
              {table.rank && table.rank <= 3 && (
                <span className="absolute top-2 left-2 z-10 inline-flex items-center justify-center w-5 h-5 rounded-full bg-orange text-[9px] font-display text-[#0d1217] shadow-[0_2px_6px_rgba(0,0,0,0.5)]">
                  {table.rank}
                </span>
              )}
              <div
                className="h-[157px] shrink-0 overflow-hidden px-4 pt-1.5 pb-2 flex flex-col items-stretch"
                style={{
                  backgroundImage: "url('/brand/take_a_seat_card.png')",
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  backgroundRepeat: 'no-repeat',
                  boxShadow: [
                    'inset 0 0 36px 6px rgba(0,0,0,0.55)',
                    'inset 0 0 90px rgba(0,0,0,0.35)',
                    'inset 0 1px 0 rgba(255,255,255,0.18)',
                  ].join(', '),
                  textShadow: '0 1px 2px rgba(0,0,0,1), 0 2px 6px rgba(0,0,0,1)',
                }}
              >
                {/* Top bar: format pill (left) + seats pill (right) */}
                <div className="flex items-start justify-between">
                  <div className={`inline-flex items-baseline gap-1.5 bg-black/60 backdrop-blur-sm border border-white/15 rounded-sm px-3 py-1.5 ${table.rank && table.rank <= 3 ? 'ml-6' : ''}`}>
                    <span className="font-display text-[18px] text-emerald-400 leading-none">{table.format}</span>
                    {rankToStars(table.rank) > 0 && <StarRating count={rankToStars(table.rank)} size={10} />}
                  </div>
                  <div className="inline-flex items-baseline gap-0.5 bg-black/60 backdrop-blur-sm border border-white/15 rounded-sm px-3 py-1.5">
                    <span className="font-display text-[18px] tabular-nums text-emerald-400 leading-none">{table.filled}</span>
                    <span className="font-mono text-[9px] tracking-[0.14em] text-white/50 uppercase leading-none">/{table.seats} seated</span>
                  </div>
                </div>

                {/* Center: token + blinds as a unified group, equal margin top and bottom */}
                <div className="flex-1 flex flex-col items-center justify-center gap-1 text-center">
                  <div style={{ marginTop: '-25px', borderRadius: '50%', padding: '3px', background: 'conic-gradient(from 0deg, #F26A1F 0%, #FFC63A 20%, #FF8C00 40%, #FFD700 55%, #F26A1F 70%, #FF6B00 85%, #FFC63A 100%)', boxShadow: '0 0 13px 6px rgba(242,106,31,0.63), 0 0 28px 13px rgba(242,106,31,0.46), 0 0 53px 22px rgba(242,106,31,0.28), 0 0 84px 35px rgba(255,140,0,0.18)' }}>
                    <div style={{ borderRadius: '50%', overflow: 'hidden' }}>
                      <TokenLogo symbol={table.tokenSymbol} icon={table.tokenIcon} size={78} />
                    </div>
                  </div>
                  {names?.[table.pubkey] && (
                    <span className="font-mono text-[8px] tracking-[0.18em] text-white/35 uppercase truncate max-w-[90%]" title={names[table.pubkey] || ''}>
                      {names[table.pubkey]}
                    </span>
                  )}
                  <div className="inline-flex flex-col items-center gap-0.5 mt-0.5">
                    <span className="font-display text-[11px] tracking-[0.22em] uppercase text-white leading-none">blinds</span>
                    <span
                      className="font-display text-[24px] sm:text-[26px] tabular-nums text-white leading-none"
                      style={{ textShadow: '0 2px 16px rgba(0,0,0,1), 0 0 6px rgba(0,0,0,1)' }}
                    >
                      {fmtBlinds(table.smallBlindRaw, table.bigBlindRaw, table.decimals)}
                    </span>
                  </div>
                </div>

                {/* Bottom: 24h stats frosted pill */}
                {s && s.handCount > 0 && (
                  <div className="flex justify-center">
                    <div className="inline-flex items-baseline gap-2 bg-black/55 backdrop-blur-sm border border-white/8 rounded-sm px-2.5 py-1 font-mono text-[9px] tabular-nums text-white/65 leading-none">
                      <span className="text-white/38 text-[7px] tracking-[0.16em] uppercase">avg</span>
                      <span>{(s.avgPotLamports / 10 ** table.decimals).toFixed(3)}</span>
                      <span className="text-white/22">·</span>
                      <span className="text-white/38 text-[7px] tracking-[0.16em] uppercase">vpip</span>
                      <span>{Math.round(s.vpip * 100)}%</span>
                      <span className="text-white/22">·</span>
                      <span className="text-white/38 text-[7px] tracking-[0.16em] uppercase">hnd/hr</span>
                      <span>{Math.round(s.handsPerHour)}</span>
                    </div>
                  </div>
                )}
              </div>
              {/* Orange CTA band */}
              <div
                className="shrink-0 px-3 py-3 text-black flex flex-col items-center justify-center gap-y-1"
                style={{ background: 'linear-gradient(180deg, #F26A1F 0%, #d85a16 100%)' }}
              >
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] opacity-95">
                  <span>SEATS</span>
                  <span className="tabular-nums font-bold">{table.filled}/{table.seats}</span>
                </span>
                <span className="font-display text-[18px] sm:text-[20px] tracking-[0.2em] leading-none" style={{ textShadow: 'none' }}>
                  TAKE A SEAT ▸
                </span>
              </div>
            </button>
              </div>
            );
          })}
          {N > 1 && (
            <div className="absolute right-2 z-20 flex items-center gap-1.5" style={{ bottom: '72px' }}>
              <button
                type="button"
                aria-label="Previous spotlight"
                onClick={() => { SFX.play('ui-tap'); setActive((active - 1 + N) % N); }}
                className="group/nav h-9 w-8 rounded-sm flex items-center justify-center bg-black/35 backdrop-blur-md border border-bone/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:bg-black/55 hover:border-orange/55 active:scale-95 transition-all duration-150"
              >
                <span className="font-display text-[18px] leading-none -ml-px text-bone/65 group-hover/nav:text-bone transition-colors">‹</span>
              </button>
              <button
                type="button"
                aria-label="Next spotlight"
                onClick={() => { SFX.play('ui-tap'); setActive((active + 1) % N); }}
                className="group/nav h-9 w-8 rounded-sm flex items-center justify-center bg-black/35 backdrop-blur-md border border-bone/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:bg-black/55 hover:border-orange/55 active:scale-95 transition-all duration-150"
              >
                <span className="font-display text-[18px] leading-none -mr-px text-bone/65 group-hover/nav:text-bone transition-colors">›</span>
              </button>
            </div>
          )}
          </div>
        )}

        {/* Status row - label + count (left), timing meter (middle, fills over the
            4s auto-advance so its travel matches the carousel index change),
            pager dots (right-justified). */}
        <div className="flex items-center gap-3 mt-3">
          <span className="font-mono text-[8px] tracking-[0.22em] text-orange uppercase shrink-0">{isFallback ? '◉ Busiest' : '★ Spotlight'}</span>
          <span className="font-mono text-[8px] tracking-[0.16em] text-boneDim/45 uppercase tabular-nums shrink-0">
            {empty ? '0 / 0' : `${active + 1} / ${N}`}
          </span>
          {empty ? (
            <span className="ml-auto font-mono text-[8px] text-boneDim/45 tracking-[0.16em] uppercase">no matches</span>
          ) : N > 1 ? (
            <>
              {/* Timing meter - between the label and the dots. 4s scaleX matches
                  the 4000ms auto-advance; key remounts it on each index change so
                  it always restarts in sync with the carousel. */}
              <div className="flex-1 min-w-[24px] h-[3px] bg-bone/8 rounded-full overflow-hidden">
                <div
                  key={`p-${active}-${paused ? 'p' : 'r'}`}
                  className={`h-full bg-orange ${paused ? 'hyb-progress hyb-progress-paused' : 'hyb-progress'}`}
                />
              </div>
              {/* Pager dots - right-justified */}
              <div className="flex items-center gap-1.5 shrink-0">
                {sorted.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setActive(i)}
                    aria-label={`Spotlight ${i + 1}`}
                    className={`transition-all rounded-full ${
                      i === active ? 'bg-orange w-[18px] h-[6px]' : 'bg-bone/20 hover:bg-bone/40 w-[6px] h-[6px]'
                    }`}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Mini grid (4 boosted runners-up) - ported back from frontend/main ──────
function MiniGrid({ tables, onTakeSeat, stats, names }: { tables: CashFeatured[]; onTakeSeat: (pubkey: string) => void; stats?: Record<string, TableStats | null>; names?: Record<string, string | null> }) {
  // Cap at 4. We don't pad/repeat anymore (live data - repeating real tables
  // would be misleading); show whatever is actually there.
  const minis = useMemo(() => tables.slice(0, 4), [tables]);

  if (minis.length === 0) {
    return (
      <div className="px-4 py-3 font-mono text-[10px] tracking-[0.16em] text-boneDim/45 uppercase">
        no supporting boosted tables. widen filters or check the lobby below
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 min-w-0 [&>*:nth-child(4)]:hidden sm:[&>*:nth-child(4)]:block">
      {minis.map((t, i) => {
        const stars = rankToStars(t.rank);
        const s = stats?.[t.pubkey] ?? null;
        const tableName = names?.[t.pubkey] ?? null;
        return (
          <button
            key={`${t.pubkey}-${i}`}
            onClick={() => { SFX.play('ui-tap'); onTakeSeat(t.pubkey); }}
            className="relative overflow-hidden text-left rounded-md border-2 border-orange/80 transition-all p-0 flex flex-col cursor-pointer group min-w-0"
            style={{
              backgroundImage: "url('/brand/play_card_bg.png')",
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
              boxShadow: [
                'inset 0 0 28px 5px rgba(0,0,0,0.58)',
                'inset 0 0 60px rgba(0,0,0,0.38)',
                'inset 0 1px 0 rgba(255,255,255,0.16)',
              ].join(', '),
              textShadow: '0 1px 1px rgba(0,0,0,1), 0 1px 3px rgba(0,0,0,1), 0 0 4px rgba(0,0,0,0.95)',
            }}
          >
            <div className="flex-1 px-2 pt-1.5 pb-2 flex flex-col">
              {/* Top: format (left) · token (center) · seats (right) */}
              <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-1">
                <div className={`justify-self-start inline-flex items-baseline gap-1 bg-black/60 backdrop-blur-sm border border-white/15 rounded-sm px-2 py-1 ${t.rank && t.rank <= 3 ? 'ml-5' : ''}`}>
                  <span className="font-display text-[13px] text-emerald-400 leading-none">{t.format}</span>
                  {stars > 0 && <StarRating count={stars} size={7} />}
                </div>
                <div className="flex justify-center">
                  <div style={{ borderRadius: '50%', padding: '2px', background: 'conic-gradient(from 0deg, #F26A1F 0%, #FFC63A 20%, #FF8C00 40%, #FFD700 55%, #F26A1F 70%, #FF6B00 85%, #FFC63A 100%)', boxShadow: '0 0 5px 2px rgba(242,106,31,0.63), 0 0 11px 5px rgba(242,106,31,0.46), 0 0 22px 9px rgba(242,106,31,0.28), 0 0 34px 14px rgba(255,140,0,0.18)' }}>
                    <div style={{ borderRadius: '50%', overflow: 'hidden' }}>
                      <TokenLogo symbol={t.tokenSymbol} icon={t.tokenIcon} size={32} />
                    </div>
                  </div>
                </div>
                <div className="justify-self-end inline-flex items-baseline gap-0.5 bg-black/60 backdrop-blur-sm border border-white/15 rounded-sm px-2 py-1">
                  <span className="font-display text-[13px] tabular-nums text-emerald-400 leading-none">{t.filled}</span>
                  <span className="font-mono text-[8px] text-white/50 leading-none">/{t.seats} seated</span>
                </div>
              </div>
              {/* Center: blinds */}
              <div className="flex flex-col items-center text-center mt-2">
                <span className="font-display text-[9px] tracking-[0.22em] uppercase text-white leading-none">blinds</span>
                <span className="font-display text-[16px] tabular-nums text-white leading-none" style={{ textShadow: '0 2px 10px rgba(0,0,0,1)' }}>
                  {fmtBlinds(t.smallBlindRaw, t.bigBlindRaw, t.decimals)}
                </span>
              </div>
              {/* Bottom: 24h stats */}
              {s && s.handCount > 0 && (
                <div className="mt-auto pt-1 flex items-baseline justify-center gap-1.5 font-mono text-[7px] tabular-nums text-white/60 leading-none">
                  <span>{(s.avgPotLamports / 10 ** t.decimals).toFixed(3)}</span>
                  <span className="text-white/25">·</span>
                  <span>{Math.round(s.vpip * 100)}%</span>
                  <span className="text-white/25">·</span>
                  <span>{Math.round(s.handsPerHour)}/hr</span>
                </div>
              )}
            </div>
            <div
              className="px-2.5 py-1.5 text-black flex items-center justify-center"
              style={{
                background: 'linear-gradient(180deg, #F26A1F 0%, #d85a16 100%)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 1px 0 rgba(255,198,58,0.55)',
              }}
            >
              <span className="font-display text-[12px] tracking-[0.2em] leading-none" style={{ textShadow: 'none' }}>TAKE A SEAT ▸</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Header ─────────────────────────────────────────────────────────────────
function Header({
  subline = 'Pick a token, pick a table, sit down. SOL + $FP rake on every pot, 5BB cap.',
}: {
  subline?: string;
}) {
  return (
    <div className="px-4 lg:px-6 pt-3 pb-3 relative">
      <div className="relative flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="font-display text-bone text-[22px] sm:text-[26px] leading-none tracking-[0.04em]">
            SIT DOWN. <span className="text-orange italic">PLAY CASH.</span>
          </h3>
          <p className="font-mono text-[10px] sm:text-[11px] text-boneDim/75 mt-1.5 tracking-[0.04em] leading-snug">
            {subline}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Filter row pieces ──────────────────────────────────────────────────────
function PinnedTokenBar({
  pinned, togglePinned, removePinned, searchActive = false,
}: {
  pinned: string[];
  togglePinned: (s: string) => void;
  removePinned: (s: string) => void;
  /** While the search box has text, the search drives the token filter — so the
   *  default chips are disabled/dimmed to make it obvious they don't apply. */
  searchActive?: boolean;
}) {
  // SOL + $FP + USDC are always RENDERED in the bar, but the user can toggle
  // them on and off - empty pinned set === no token restriction (show all).
  // A non-empty search overrides them, so they read as disabled then.
  const dim = searchActive ? 'opacity-40 pointer-events-none' : '';
  const solActive = !searchActive && pinned.includes('SOL');
  const fpActive = !searchActive && pinned.includes('$FP');
  const usdcActive = !searchActive && pinned.includes('USDC');
  const userPins = pinned.filter(s => s !== 'SOL' && s !== '$FP' && s !== 'USDC');
  return (
    <div className="flex items-center gap-1.5 sm:gap-2 flex-1 min-w-0">
      <button
        type="button"
        onClick={() => togglePinned('SOL')}
        aria-pressed={solActive}
        title={solActive ? 'Click to remove SOL filter' : 'Click to filter to SOL only'}
        className={`flex-1 min-w-0 inline-flex items-center justify-center gap-1 px-2.5 h-9 rounded-md font-mono text-[9px] tracking-[0.14em] uppercase border bg-black transition-all duration-150 ${dim} ${
          solActive
            ? 'border-[rgb(100,48,27)] text-orange shadow-[inset_0_2px_4px_rgba(0,0,0,0.7),inset_0_1px_2px_rgba(0,0,0,0.8),inset_0_-1px_0_rgba(255,255,255,0.06)]'
            : 'border-bone/15 text-bone/55 hover:border-bone/35 hover:text-bone/80'
        }`}
      >
        <SolIcon size={10} /> SOL
      </button>
      <button
        type="button"
        onClick={() => togglePinned('$FP')}
        aria-pressed={fpActive}
        title={fpActive ? 'Click to remove $FP filter' : 'Click to filter to $FP only'}
        className={`flex-1 min-w-0 inline-flex items-center justify-center gap-1 px-2.5 h-9 rounded-md font-mono text-[9px] tracking-[0.14em] uppercase border bg-black transition-all duration-150 ${dim} ${
          fpActive
            ? 'border-[rgb(100,48,27)] text-orange shadow-[inset_0_2px_4px_rgba(0,0,0,0.7),inset_0_1px_2px_rgba(0,0,0,0.8),inset_0_-1px_0_rgba(255,255,255,0.06)]'
            : 'border-bone/15 text-bone/55 hover:border-bone/35 hover:text-bone/80'
        }`}
      >
        <FpIcon size={10} /> $FP
      </button>
      <button
        type="button"
        onClick={() => togglePinned('USDC')}
        aria-pressed={usdcActive}
        title={usdcActive ? 'Click to remove USDC filter' : 'Click to filter to USDC only'}
        className={`flex-1 min-w-0 inline-flex items-center justify-center gap-1 px-2.5 h-9 rounded-md font-mono text-[9px] tracking-[0.14em] uppercase border bg-black transition-all duration-150 ${dim} ${
          usdcActive
            ? 'border-[rgb(100,48,27)] text-orange shadow-[inset_0_2px_4px_rgba(0,0,0,0.7),inset_0_1px_2px_rgba(0,0,0,0.8),inset_0_-1px_0_rgba(255,255,255,0.06)]'
            : 'border-bone/15 text-bone/55 hover:border-bone/35 hover:text-bone/80'
        }`}
      >
        <UsdcIcon size={10} /> USDC
      </button>
      {userPins.map(sym => (
        <span key={sym} className="inline-flex items-center gap-1 px-2.5 h-9 rounded-md bg-black border border-[rgb(100,48,27)] text-orange font-mono text-[9px] tracking-[0.14em] uppercase shadow-[inset_0_2px_4px_rgba(0,0,0,0.7),inset_0_1px_2px_rgba(0,0,0,0.8),inset_0_-1px_0_rgba(255,255,255,0.06)]">
          {sym}
          <button
            onClick={() => removePinned(sym)}
            aria-label={`Remove ${sym}`}
            className="ml-0.5 -mr-0.5 leading-none text-amber/70 hover:text-amber text-[12px]"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * Unified search: one box that filters the table list (host / pubkey / token
 * substring) AND surfaces an autocomplete dropdown of matching tokens with a
 * star-to-pin action. Replaces the old separate TokenSearch + FindTableInput.
 */
function UnifiedSearch({
  value, setValue, addPinned, pinned, pinUserCount, availableTokens, fullWidth = false,
}: {
  value: string;
  setValue: (s: string) => void;
  addPinned: (s: string) => void;
  pinned: string[];
  pinUserCount: number;
  /** Real, on-protocol tokens to suggest (registry-listed + tokens in play). */
  availableTokens: { symbol: string; icon: string | null }[];
  fullWidth?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const userCapReached = pinUserCount >= 4;

  // Token autocomplete derived from current text. Suggests only real tokens
  // (passed in from the live registry) and hides ones already pinned.
  const tokenMatches = useMemo(() => {
    const q = value.trim().toUpperCase();
    const pool = availableTokens.filter(t => !pinned.includes(t.symbol));
    // Empty query while focused → list the available tokens so they can be
    // browsed and picked; otherwise filter by what's typed.
    if (!q) return pool.slice(0, 6);
    return pool.filter(t => t.symbol.toUpperCase().includes(q)).slice(0, 6);
  }, [value, pinned, availableTokens]);

  return (
    <div className={`relative ${fullWidth ? 'w-full min-w-0' : ''}`}>
      <div className={`flex items-center gap-1 px-2.5 h-9 min-h-9 rounded-md border border-bone/15 bg-black transition-all duration-150 focus-within:border-[rgb(100,48,27)] focus-within:shadow-[inset_0_2px_4px_rgba(0,0,0,0.7),inset_0_1px_2px_rgba(0,0,0,0.8),inset_0_-1px_0_rgba(255,255,255,0.06)] ${fullWidth ? 'w-full' : ''}`}>
        <svg className="w-3 h-3 text-boneDim/50 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="7" cy="7" r="4.5" /><path d="m11 11 3 3" />
        </svg>
        <input
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder="search host or token"
          aria-label="Find table by host, pubkey, or token symbol"
          className={`bg-transparent outline-none font-mono text-[10px] tracking-[0.06em] text-bone placeholder:text-boneDim/40 placeholder:normal-case ${fullWidth ? 'flex-1 min-w-0' : 'w-[200px]'}`}
        />
        {value && (
          <button
            type="button"
            onClick={() => setValue('')}
            aria-label="Clear search"
            className="text-boneDim/55 hover:text-bone text-[12px] leading-none shrink-0"
          >
            ×
          </button>
        )}
      </div>
      {focused && tokenMatches.length > 0 && (
        <div className="absolute top-full left-0 mt-1 w-full min-w-[200px] z-20 rounded-sm border border-bone/20 bg-[#0d1217] shadow-xl">
          <div className="px-2.5 py-1 font-mono text-[8px] tracking-[0.18em] text-boneDim/50 uppercase border-b border-bone/10">
            Pick a token to filter
          </div>
          {tokenMatches.map(r => (
            <button
              key={r.symbol}
              type="button"
              onMouseDown={e => { e.preventDefault(); if (!userCapReached) { addPinned(r.symbol); setValue(r.symbol); } }}
              disabled={userCapReached}
              title={userCapReached ? 'Pin limit reached (4/4)' : `Pin ${r.symbol} to filter`}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bone/[0.06] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <TokenLogo symbol={r.symbol} icon={r.icon} size={12} />
              <span className="font-mono text-[10px] tracking-[0.1em] text-bone">{r.symbol}</span>
              <span className="ml-auto inline-flex items-center gap-1 font-mono text-[9px] tracking-[0.14em] uppercase text-orange">
                <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
                  <path d="M6 1l1.5 3 3.3.5-2.4 2.3.6 3.3L6 8.6l-3 1.5.6-3.3L1.2 4.5l3.3-.5z" />
                </svg>
                pin
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * BB-range entry. Token-agnostic - the user types a numeric BB range and we
 * filter `bigBlind` (raw → human units) against it. Tap target ≥ 36px.
 */
/** Compact 2-input filter for seat-count range. Mirrors BBRangeInputs styling. */
function SeatRangeInputs({
  minSeats, maxSeats, setMinSeats, setMaxSeats,
}: {
  minSeats?: number;
  maxSeats?: number;
  setMinSeats: (v: number | undefined) => void;
  setMaxSeats: (v: number | undefined) => void;
}) {
  const parse = (raw: string): number | undefined => {
    const v = raw.trim();
    if (v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 9) return undefined;
    return Math.floor(n);
  };
  const inputCls =
    'bg-black border border-bone/15 rounded-md font-mono text-[10px] tabular-nums text-bone transition-all duration-150 ' +
    'placeholder:text-boneDim/40 focus:outline-none focus:border-[rgb(100,48,27)] focus:text-orange focus:shadow-[inset_0_2px_4px_rgba(0,0,0,0.7),inset_0_1px_2px_rgba(0,0,0,0.8),inset_0_-1px_0_rgba(255,255,255,0.06)] px-2 sm:px-2.5 h-9 min-h-9 flex-1 min-w-0 text-center';
  return (
    <div className="flex items-center gap-1.5 sm:gap-2 flex-1 min-w-0">
      <span className="font-mono text-[8px] tracking-[0.18em] text-boneDim/55 uppercase shrink-0 hidden sm:inline">SEATS</span>
      <input
        type="number"
        inputMode="numeric"
        min={2}
        max={9}
        step={1}
        value={minSeats ?? ''}
        onChange={e => setMinSeats(parse(e.target.value))}
        placeholder="min"
        aria-label="Minimum seats"
        className={inputCls}
      />
      <span className="font-mono text-[10px] text-boneDim/45 shrink-0">→</span>
      <input
        type="number"
        inputMode="numeric"
        min={2}
        max={9}
        step={1}
        value={maxSeats ?? ''}
        onChange={e => setMaxSeats(parse(e.target.value))}
        placeholder="max"
        aria-label="Maximum seats"
        className={inputCls}
      />
    </div>
  );
}

function BBRangeInputs({
  bbMin, bbMax, setBBMin, setBBMax,
}: {
  bbMin?: number;
  bbMax?: number;
  setBBMin: (v: number | undefined) => void;
  setBBMax: (v: number | undefined) => void;
}) {
  const parse = (raw: string): number | undefined => {
    const v = raw.trim();
    if (v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  };
  const inputCls =
    'bg-black border border-bone/15 rounded-md font-mono text-[10px] tabular-nums text-bone transition-all duration-150 ' +
    'placeholder:text-boneDim/40 focus:outline-none focus:border-[rgb(100,48,27)] focus:text-orange focus:shadow-[inset_0_2px_4px_rgba(0,0,0,0.7),inset_0_1px_2px_rgba(0,0,0,0.8),inset_0_-1px_0_rgba(255,255,255,0.06)] px-2 sm:px-2.5 h-9 min-h-9 flex-1 min-w-0 text-center';
  return (
    <div className="flex items-center gap-1.5 sm:gap-2 flex-1 min-w-0">
      <span className="font-mono text-[8px] tracking-[0.18em] text-boneDim/55 uppercase shrink-0 hidden sm:inline">BB</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={bbMin ?? ''}
        onChange={e => setBBMin(parse(e.target.value))}
        placeholder="bb min"
        aria-label="BB minimum"
        className={inputCls}
      />
      <span className="font-mono text-[10px] text-boneDim/45 shrink-0">→</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={bbMax ?? ''}
        onChange={e => setBBMax(parse(e.target.value))}
        placeholder="bb max"
        aria-label="BB maximum"
        className={inputCls}
      />
    </div>
  );
}

// ─── Public component ──────────────────────────────────────────────────────
export interface CashLobbyHeaderProps {
  tables: CashTable[];               // ALL cash tables from API
  onNavigate: (pda: string) => void; // existing navigate handler
  onSpectate?: (pda: string) => void;
  onCreateTable?: () => void;        // CREATE TABLE button handler
  mode?: 'cash';                     // hint, optional
  /** True while the initial cash-table fetch is in flight. Empty-state branch
      shows a loading skeleton instead of the "no tables" CTA. */
  loading?: boolean;
  /** Unified filter - owned by CashSection. */
  filter: CashFilterState;
  setFilter: (next: CashFilterState) => void;
  /** Per-table 24h stats (avg pot / VPIP / hnd-hr) keyed by table pubkey.
   *  Optional - cards fall back to "no 24h data" when absent or empty. */
  stats?: Record<string, TableStats | null>;
  /** Player-claimed display names keyed by pubkey; overrides auto-name. */
  names?: Record<string, string | null>;
}

export default function CashLobbyHeader({
  tables, onNavigate, onCreateTable, loading, filter, setFilter, stats, names,
}: CashLobbyHeaderProps) {
  const router = useRouter();

  // Helpers that mutate the upstream filter immutably.
  const setPinned = (next: string[]) => setFilter({ ...filter, pinnedTokens: next });
  const addPinned = (sym: string) => {
    if (!sym) return;
    if (filter.pinnedTokens.includes(sym)) return;
    // Picking a specific listed/SPL token (e.g. $HYPE) is an EXCLUSIVE choice —
    // "show that token only" — so it replaces the pins rather than adding to the
    // allow-list (which would bury its tables among the pre-pinned SOL/$FP/USDC).
    // The default chips stay additive toggles.
    if (sym !== 'SOL' && sym !== '$FP' && sym !== 'USDC') {
      setPinned([sym]);
      return;
    }
    setPinned([...filter.pinnedTokens, sym]);
  };
  const removePinned = (sym: string) => setPinned(filter.pinnedTokens.filter(s => s !== sym));
  const togglePinned = (sym: string) => {
    if (filter.pinnedTokens.includes(sym)) removePinned(sym);
    else addPinned(sym);
  };

  // Real tokens for the "Pick a Token" search: registry-listed tokens (proper
  // symbols/logos) plus any non-default token that actually has a live cash
  // table. Replaces the old hardcoded popular-token list
  // which suggested coins that don't exist on the protocol.
  const listedTokens = useListedTokens();
  const { symbolFor, iconFor } = useTokenMeta();
  const availableTokens = useMemo(() => {
    const DEFAULTS = new Set(['SOL', '$FP', 'USDC']);
    const out: { symbol: string; icon: string | null }[] = [];
    const seen = new Set<string>();
    const add = (symbol: string, icon: string | null) => {
      if (!symbol || DEFAULTS.has(symbol) || seen.has(symbol)) return;
      seen.add(symbol);
      out.push({ symbol, icon });
    };
    for (const lt of listedTokens) add(lt.symbol, lt.icon);
    // Resolve table mints through the SAME registry resolver as the chips above,
    // so a listed SPL table (e.g. $HYPE) collapses into its one registry chip
    // instead of also appearing as a truncated-mint duplicate.
    for (const t of tables) add(symbolFor(t.tokenMint), iconFor(t.tokenMint));
    return out;
  }, [listedTokens, tables, symbolFor, iconFor]);

  const toggleFormat = (f: CashFormat) =>
    setFilter({
      ...filter,
      formats: filter.formats.includes(f)
        ? filter.formats.filter(x => x !== f)
        : [...filter.formats, f],
    });
  const clearFormats = () => setFilter({ ...filter, formats: [] });

  const setSearch = (search: string) => setFilter({ ...filter, search });
  const setBBMin = (bbMin: number | undefined) => setFilter({ ...filter, bbMin });
  const setBBMax = (bbMax: number | undefined) => setFilter({ ...filter, bbMax });
  const setMinSeats = (minSeats: number | undefined) => setFilter({ ...filter, minSeats });
  const setMaxSeats = (maxSeats: number | undefined) => setFilter({ ...filter, maxSeats });

  // 1. Project live tables → CashFeatured. PREFER boosted tables (sort by
  //    boost.rank); if none are boosted, fall back to the busiest tables.
  const { featured, isFallback } = useMemo(() => {
    const boosted = tables
      .filter(t => t.boost?.active === true)
      .sort((a, b) => {
        const ra = a.boost?.rank ?? 9999;
        const rb = b.boost?.rank ?? 9999;
        if (ra !== rb) return ra - rb;
        return b.pot - a.pot;
      });
    const resolve = { symbolFor, iconFor };
    if (boosted.length > 0) {
      return { featured: boosted.map(t => tableToFeatured(t, resolve)), isFallback: false };
    }
    const busy = tables
      .slice()
      .sort((a, b) => {
        if (b.currentPlayers !== a.currentPlayers) return b.currentPlayers - a.currentPlayers;
        if (b.pot !== a.pot) return b.pot - a.pot;
        return (b.handNumber ?? 0) - (a.handNumber ?? 0);
      })
      .slice(0, 9); // 5 spotlight + 4 mini grid
    return { featured: busy.map(t => tableToFeatured(t, resolve)), isFallback: true };
  }, [tables, symbolFor, iconFor]);

  // 2. Apply unified filter.
  const visible = useMemo(() => applyFeaturedFilter(featured, filter), [featured, filter]);

  // Player-density per format (drives the TABLE SIZE selector meters).
  const playersByFormat = useMemo(() => {
    const acc: Record<CashFormat, number> = { 'HU': 0, '6-Max': 0, '9-Max': 0 };
    for (const t of featured) acc[t.format] += t.filled;
    return acc;
  }, [featured]);

  // 3. Every featured/boosted table is a carousel index (MiniGrid folded in).

  const handleTakeSeat = (pda: string) => onNavigate(pda);
  const handleCreate = () => {
    if (onCreateTable) onCreateTable();
    else router.push('/my-tables/create');
  };

  // ZERO cash tables anywhere → loading skeleton if still fetching, otherwise
  // an empty-state CTA. (When tables exist but none are boosted, we fall back
  // to the busiest tables above, so this branch only fires when there are no
  // cash tables at all.)
  if (featured.length === 0) {
    if (loading) return null;
    return (
      <div>
        <Header />
        <div className="px-4 sm:px-6 py-6 text-center bg-black/30 border-b border-bone/10">
          <div className="font-display text-bone/80 text-[18px] tracking-[0.08em]">NO TABLES YET</div>
          <div className="font-mono text-[10px] text-boneDim/55 mt-2 max-w-md mx-auto">
            Be the first. Spin up a cash table and players will see it here.
          </div>
          <button
            onClick={handleCreate}
            className="mt-3 inline-flex items-center gap-1.5 btn-orange px-4 py-2 rounded-sm font-mono text-[10.5px] tracking-[0.2em] font-bold"
          >
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M6 2v8M2 6h8" />
            </svg>
            CREATE THE FIRST
          </button>
        </div>

        {/* Even with no tables we still surface the unified filter row so the
            user can adjust BB range / formats before tables stream in. */}
        <UnifiedFilterRow
          filter={filter}
          addPinned={addPinned}
          removePinned={removePinned}
          togglePinned={togglePinned}
          toggleFormat={toggleFormat}
          clearFormats={clearFormats}
          playersByFormat={playersByFormat}
          setSearch={setSearch}
          setBBMin={setBBMin}
          setBBMax={setBBMax}
          setMinSeats={setMinSeats}
          setMaxSeats={setMaxSeats}
          matchCount={0}
          availableTokens={availableTokens}
        />
      </div>
    );
  }

  return (
    <div>
      <Header />
      {/* Shared CHOOSE-A-GAME layout (mirrors SizeInPlayToMint): choosers in the
          left column, the game card(s) on the right. Here the right column is a
          carousel of cash cards instead of the single Quick Play card.
          Mobile: stacks (card first, then chooser). */}
      {/* Grid mirrors tab 1 (SizeInPlayToMint) exactly: equal halves, same gap,
          stretch so left selector + right card share width AND height. */}
      {/* Body wrapper applies px-4 OUTSIDE the grid (mirrors SizeInPlayToMint
          #size-in-play-body) so each column = exactly tab 1's column width. */}
      <div id="cash-lobby-body" className="px-4 pt-2.5 pb-2.5 max-w-full overflow-x-clip">
      {/* Grid restructured to mirror tab 1 (SizeInPlayToMint) exactly:
          left column = Table Size (format area) + Find-a-Table (filter area),
          right column = Spotlight spanning both rows. md:content-evenly gives
          the left column the same balanced top/bottom rhythm as tab 1. */}
      <div
        className="flex flex-col w-full min-w-0 md:grid md:grid-cols-2 md:gap-x-4 md:gap-y-6 md:items-stretch md:content-evenly md:mb-5"
        style={{ gridTemplateAreas: '"format spotlight" "filter spotlight"' }}
      >
        {/* Table Size - top-left. Mobile spacing mirrors tab 1's
            #size-in-play-format-row (mb-2.5 md:mb-0); min-w-0 at all
            breakpoints so the 4-up selector can't exceed the viewport. */}
        <div className="order-1 md:order-none min-w-0 mb-5 md:mb-0" style={{ gridArea: 'format' }}>
          <UnifiedFilterRow
            section="format"
            filter={filter}
            addPinned={addPinned}
            removePinned={removePinned}
            togglePinned={togglePinned}
            toggleFormat={toggleFormat}
            clearFormats={clearFormats}
            playersByFormat={playersByFormat}
            setSearch={setSearch}
            setBBMin={setBBMin}
            setBBMax={setBBMax}
            setMinSeats={setMinSeats}
            setMaxSeats={setMaxSeats}
            matchCount={visible.length}
            availableTokens={availableTokens}
          />
        </div>
        {/* Find a Table - bottom-left. Mobile spacing mirrors tab 1's
            #size-in-play-buyin-slider (mt-2 md:mt-0); min-w-0 at all
            breakpoints so the token/BB controls can't exceed the viewport. */}
        <div className="order-3 md:order-none min-w-0 mt-[10px]" style={{ gridArea: 'filter' }}>
          <UnifiedFilterRow
            section="filter"
            filter={filter}
            addPinned={addPinned}
            removePinned={removePinned}
            togglePinned={togglePinned}
            toggleFormat={toggleFormat}
            clearFormats={clearFormats}
            playersByFormat={playersByFormat}
            setSearch={setSearch}
            setBBMin={setBBMin}
            setBBMax={setBBMax}
            setMinSeats={setMinSeats}
            setMaxSeats={setMaxSeats}
            matchCount={visible.length}
            availableTokens={availableTokens}
          />
        </div>
        {/* Spotlight - right column, spans both rows. Mobile spacing mirrors
            tab 1's #size-in-play-quickplay (mb-[0.625rem] md:self-start);
            min-w-0 at all breakpoints so the card can't exceed the viewport. */}
        <div className="order-2 md:order-none min-w-0 md:self-start mb-[0.625rem] md:mb-0" style={{ gridArea: 'spotlight' }}>
          <Spotlight tables={visible} onTakeSeat={handleTakeSeat} isFallback={isFallback} stats={stats} names={names} />
        </div>
      </div>
      {/* Top divider only - cash tab keeps the line under the content but not
          the emissions UI (SNG tab still renders the full EmissionsFooter).
          Sits above the Featured row. */}
      {/* Featured - label + full-width rule on one line (line fills the row
          minus the FEATURED text + gap). Replaces the old standalone divider. */}
      <div id="cash-featured-header" className="mt-5 flex items-center gap-3">
        <span className="font-mono text-[9px] tracking-[0.22em] text-boneDim/55 uppercase shrink-0">Featured</span>
        <span aria-hidden className="flex-1 border-t border-gold/10" />
      </div>
      {/* Featured - main's MiniGrid row, ported back from frontend/main */}
      <div className="mt-3">
        <MiniGrid tables={visible} onTakeSeat={handleTakeSeat} stats={stats} names={names} />
      </div>
      </div>
    </div>
  );
}

/**
 * The unified filter row - single source of truth for the cash lobby.
 * Row 1: token chips + unified search (search filters tables, dropdown adds pins).
 * Row 2: format pills + BB range + match count.
 */
function UnifiedFilterRow({
  filter,
  addPinned,
  removePinned,
  togglePinned,
  toggleFormat,
  clearFormats,
  playersByFormat,
  setSearch,
  setBBMin,
  setBBMax,
  setMinSeats,
  setMaxSeats,
  matchCount,
  availableTokens,
  section = 'all',
}: {
  filter: CashFilterState;
  addPinned: (s: string) => void;
  removePinned: (s: string) => void;
  togglePinned: (s: string) => void;
  toggleFormat: (f: CashFormat) => void;
  clearFormats: () => void;
  playersByFormat: Record<CashFormat, number>;
  setSearch: (s: string) => void;
  setBBMin: (v: number | undefined) => void;
  setBBMax: (v: number | undefined) => void;
  setMinSeats: (v: number | undefined) => void;
  setMaxSeats: (v: number | undefined) => void;
  matchCount: number;
  availableTokens: { symbol: string; icon: string | null }[];
  /** Which sub-block to render. 'all' = both (used by the no-tables branch);
      'format' = Table Size selector only; 'filter' = Find-a-Table block only.
      Splitting these lets the cash grid mirror tab 1's format/buyin areas. */
  section?: 'all' | 'format' | 'filter';
}) {
  const userPinCount = filter.pinnedTokens.filter(s => s !== 'SOL' && s !== '$FP' && s !== 'USDC').length;
  const anyFormat = filter.formats.length === 0;
  const maxFmtPlayers = Math.max(playersByFormat['HU'], playersByFormat['6-Max'], playersByFormat['9-Max'], 1);
  const totalPlayers = playersByFormat['HU'] + playersByFormat['6-Max'] + playersByFormat['9-Max'];
  const fmtBtnClass = (active: boolean) =>
    `group/btn relative flex flex-col items-stretch justify-between gap-[clamp(4px,2cqw,10px)] px-[clamp(6px,3cqw,14px)] py-[clamp(7px,3.5cqw,14px)] max-h-[72px] overflow-hidden rounded-md border transition-all duration-150 [container-type:inline-size] ${
      active
        ? 'bg-black border-[rgb(100,48,27)] text-orange shadow-[inset_0_2px_4px_rgba(0,0,0,0.7),inset_0_1px_2px_rgba(0,0,0,0.8),inset_0_-1px_0_rgba(255,255,255,0.06)]'
        : 'bg-black border-bone/15 text-bone/55 hover:border-bone/35 hover:text-bone/80'
    }`;
  const fmtMeter = (litCount: number, lit: 'active' | 'inactive') => (
    <div className="flex w-full items-stretch gap-[clamp(1px,0.4cqw,2px)] h-[clamp(2px,1.2cqw,4px)]">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className={`h-full flex-1 rounded-sm ${i < litCount ? (lit === 'active' ? 'bg-orange' : 'bg-bone/30') : 'bg-bone/8'}`} />
      ))}
    </div>
  );
  const fmtCheckbox = (active: boolean) => (
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
    <div className="space-y-4 sm:space-y-5">
      {/* TABLE SIZE - card selector ported from SizeInPlayToMint (shared CHOOSE-A-GAME UI) */}
      {(section === 'all' || section === 'format') && (
      <div>
        <div className="flex items-baseline justify-between mb-2.5">
          <span className="font-display text-[13px] tracking-[0.1em] text-bone/85 uppercase leading-none">Table Size</span>
          <span className="font-mono text-[8px] text-amber/75 tracking-[0.12em] uppercase">{totalPlayers} seated</span>
        </div>
        <div className="grid grid-cols-4 gap-[clamp(4px,1.2cqw,10px)]">
          <button
            type="button"
            onClick={clearFormats}
            aria-pressed={anyFormat}
            title={`${totalPlayers} player${totalPlayers === 1 ? '' : 's'} across all sizes`}
            className={fmtBtnClass(anyFormat)}
          >
            {fmtCheckbox(anyFormat)}
            <span className="font-display tracking-tighter leading-[0.9] text-center whitespace-nowrap text-[clamp(10px,12cqw,26px)]">ANY</span>
            <span className={`font-mono uppercase tracking-[0.22em] leading-none text-center text-[clamp(7px,2.6cqw,10px)] ${anyFormat ? 'text-orange/70' : 'text-bone/40'}`}>All sizes</span>
            {fmtMeter(10, anyFormat && totalPlayers > 0 ? 'active' : 'inactive')}
          </button>
          {FORMATS.map((f) => {
            const seats = f === 'HU' ? 2 : f === '6-Max' ? 6 : 9;
            const players = playersByFormat[f];
            const lit = Math.round((players / maxFmtPlayers) * 10);
            const isActive = filter.formats.includes(f);
            const display = f === 'HU' ? 'HU' : f === '6-Max' ? '6-MAX' : '9-MAX';
            return (
              <button
                key={f}
                type="button"
                onClick={() => toggleFormat(f)}
                aria-pressed={isActive}
                title={`${players} player${players === 1 ? '' : 's'} in ${f}`}
                className={fmtBtnClass(isActive)}
              >
                {fmtCheckbox(isActive)}
                <span className="font-display tracking-tighter leading-[0.9] text-center whitespace-nowrap tabular-nums text-[clamp(10px,12cqw,26px)]">{display}</span>
                <span className={`font-mono uppercase tracking-[0.22em] leading-none text-center text-[clamp(7px,2.6cqw,10px)] ${isActive ? 'text-orange/70' : 'text-bone/40'}`}>{seats} seats</span>
                {fmtMeter(lit, isActive ? 'active' : 'inactive')}
              </button>
            );
          })}
        </div>
      </div>
      )}

      {/* Find a Table - titled filter block mirroring the SNG "Buy-in" section
          so the cash tab defines this space the same way tab 1 does. */}
      {(section === 'all' || section === 'filter') && (
      <div id="cash-find-table-block">
        <div className="flex items-baseline justify-between mb-2.5">
          <span className="font-display text-[13px] tracking-[0.1em] text-bone/85 uppercase leading-none">Pick a Token</span>
          <span className="font-mono text-[8px] text-amber/75 tracking-[0.12em] uppercase tabular-nums">
            {matchCount} match{matchCount === 1 ? '' : 'es'}
          </span>
        </div>
        {/* Search - full width of the available space */}
        <div className="w-full mb-2">
          <UnifiedSearch
            value={filter.search}
            setValue={setSearch}
            addPinned={addPinned}
            pinned={filter.pinnedTokens}
            pinUserCount={userPinCount}
            availableTokens={availableTokens}
            fullWidth
          />
        </div>
        {/* Complementary controls: token pins + BB range, beneath the search */}
        <div className="flex items-stretch gap-1.5 sm:gap-2">
          <PinnedTokenBar pinned={filter.pinnedTokens} togglePinned={togglePinned} removePinned={removePinned} searchActive={filter.search.trim().length > 0} />
          <BBRangeInputs bbMin={filter.bbMin} bbMax={filter.bbMax} setBBMin={setBBMin} setBBMax={setBBMax} />
        </div>
        {/* Seat-count range: 2..9 raw seats. Independent of TABLE SIZE pills above. */}
        <div className="flex items-stretch gap-1.5 sm:gap-2 mt-2">
          <SeatRangeInputs minSeats={filter.minSeats} maxSeats={filter.maxSeats} setMinSeats={setMinSeats} setMaxSeats={setMaxSeats} />
        </div>
      </div>
      )}
    </div>
  );
}
