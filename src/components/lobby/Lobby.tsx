'use client';

import { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore, Fragment } from 'react';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';

import { makeL1Connection, TIERS, SnGTier, POKER_MINT, USDC_MAINNET_MINT, USDC_DEVNET_MINT, SNG_MINI_ADDON_LAMPORTS, L1_RPC } from '@/lib/constants';
import { RequestLevelGate } from '@/components/system/RequestLevelGate';
import { CashStandalone } from '@/components/lobby/CashStandalone';
import { levelAtLeast } from '@/lib/user-config';
import { calculateSngPoolUnrefined, calculateSngEmissionPerSeat, decayMultiplierBps, EmissionFormat } from '@/lib/emission';
import { EmissionGaugeFull } from '@/components/lobby/EmissionGauge';
import { SizeInPlayToMint } from '@/components/lobby/SizeInPlayToMint';
import { PageHeadline } from '@/components/ui/PageHeadline';
import { usePoolHealth } from '@/hooks/usePoolHealth';
import { usePokerSupply } from '@/hooks/usePokerSupply';
import { isPoolJoinVoluntary, isPoolLeaveVoluntary } from '@/lib/sng-leave-signal';
import { computeSngFeeLamports, describeSngFee } from '@/lib/operator-fee';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { addActiveGame, reconcileActiveGames, getActiveGames, ACTIVE_GAMES_EVENT, type ActiveGameInfo } from '@/components/layout/ActiveTableBar';
import { useMyActiveTables, refreshMyActiveTables, type MyActiveTable } from '@/hooks/useMyActiveTables';
import { useTableStats, type TableStats } from '@/hooks/useTableStats';
import { useTokenMeta } from '@/hooks/useListedTokens';
import { useTableNames, NAME_PATTERN, checkNameAvailable } from '@/hooks/useTableNames';
import { buildCanonicalMessage, nowNonce, postNameClaim } from '@/lib/table-name-claim';
import bs58 from 'bs58';
import { SFX } from '@/lib/sfx';
import { toast } from 'sonner';
import { SolIcon, TokenIcon } from '@/components/ui/TokenIcon';
import { SngJackpotRail } from '@/components/jackpot/SngJackpotRail';
import { RAW_YIELD_NAME, LUCKY_JACKPOT_NAME, ROYAL_JACKPOT_NAME } from '@/lib/jackpot-format';
import { buildWalletApiAuth } from '@/lib/wallet-api-auth';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { STATIC_EXPORT } from '@/lib/runtime-mode';
import CashLobbyHeader, {
  type CashFilterState,
  type CashFormat,
  type CashSortKey,
  type CashSortDir,
  DEFAULT_CASH_FILTER,
} from '@/components/lobby/CashLobbyHeader';
import CloseTableModal from '@/components/lobby/CloseTableModal';
// ─── Types ───
interface TokenBalances {
  sol: number;
  poker: number;
  refined: number;
  unrefined: number;
  staked: number;
  pendingSolRewards: number;
}

interface PoolState {
  totalStaked: number;
  totalUnrefined: number;
  solDistributed: number;
  circulatingSupply: number;
}

interface SitNGoQueue {
  id: string;
  type: 'heads_up' | '6max' | '9max';
  currentPlayers: number;
  maxPlayers: number;
  buyIn: number;
  tier: number;
  status: 'waiting' | 'starting' | 'in_progress';
  tablePda?: string;
  players?: string[];
  onChainPlayers?: number;
  emptySeats?: number[];
}

interface CashTable {
  pubkey: string;
  phase: number;
  currentPlayers: number;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  gameType: number;
  pot: number;
  handNumber: number;
  lastActionSlot?: number;
  isDelegated: boolean;
  isUserCreated: boolean;
  tokenMint: string;
  tokenEscrow?: string;
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

type TableListResponse = {
  tables: CashTable[];
  loading?: boolean;
  nextCursor?: string | null;
  serverRpcConfigured?: boolean;
  indexerEnabled?: boolean;
  clientRpcFallback?: boolean;
};

async function fetchTableListWithStandaloneFallback(
  url: string,
  fallback: { creator?: string; gameType?: number; limit?: number },
): Promise<TableListResponse> {
  if (STATIC_EXPORT) {
    const { discoverLobbyTables } = await import('@/lib/table-discovery');
    const tables = await discoverLobbyTables(fallback).catch(() => []);
    return {
      tables: tables as CashTable[],
      loading: false,
      nextCursor: null,
      serverRpcConfigured: false,
      clientRpcFallback: true,
    };
  }

  try {
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      const tables = Array.isArray(data?.tables)
        ? data.tables.filter((table: any): table is CashTable => typeof table?.pubkey === 'string')
        : [];
      if (data?.serverRpcConfigured !== false || data?.indexerEnabled === true) {
        return { ...data, tables };
      }
    }
  } catch {
    // Fall through to browser-RPC discovery below.
  }

  const { discoverLobbyTables } = await import('@/lib/table-discovery');
  const tables = await discoverLobbyTables(fallback).catch(() => []);
  return {
    tables: tables as CashTable[],
    loading: false,
    nextCursor: null,
    serverRpcConfigured: false,
    clientRpcFallback: true,
  };
}

interface SngPool {
  gameType: number;
  gameTypeName: 'heads_up' | '6max' | '9max';
  tier: number;
  tierName: string;
  maxPlayers: number;
  entryAmount: number;
  feeAmount: number;
  pageRentContributionLamports?: number;
  totalBuyIn: number;
  queueCount: number;
  queue: string[];
  queueEntries?: Array<{ wallet: string; pageIndex: number; slotIndex: number }>;
  waitingCount?: number;
  headPageIndex?: number;
  tailPageIndex?: number;
  tailPageFull?: boolean;
  activeMatchSet?: boolean;
  matchEligibleAt: number;
  pda: string;
  poolBalanceLamports: number;
}

// ─── Creator / My-Tables types ───
export interface CreatorTable {
  pubkey: string;
  gameTypeName: string;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  currentPlayers: number;
  rakeAccumulated: number;
  creatorRakeTotal: number;
  vaultTotalRakeDistributed: number;
  phase: string;
  lastActionSlot?: number;
  tokenSymbol: string;
  decimals: number;
  isLegacy: boolean;
  tokenMint: string;
  tokenEscrow?: string;
  rakeCap: number;
  isDelegated: boolean;
  isPrivate: boolean;
  boost?: CashTable['boost'];
}

export interface LobbyProps {
  onResumeGame: (tablePda: string) => void;
  balances: TokenBalances;
  poolState: PoolState;
  player: { isRegistered: boolean; tournamentsPlayed: number; tournamentsWon: number; claimableSol: number };
  sitNGoQueues: SitNGoQueue[];
  session: { isActive: boolean; sessionKey: boolean };
  selectedTier: SnGTier;
  onTierChange: (tier: SnGTier) => void;
  sngPools?: SngPool[];
  onJoinPool?: (gameType: number, tier: number, miniOptIn?: boolean) => void;
  onLeavePool?: (gameType: number, tier: number) => void;
  joiningPool?: string | null;
  leavingPool?: string | null;
}

// ─── Helpers ───
const fmtSol = (v: number) => v.toFixed(v < 0.1 ? 3 : v < 1 ? 3 : 2);
const fmtFP = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
const place = (i: number) => ['1st', '2nd', '3rd'][i] || `${i + 1}th`;
const SNG_DEBUG = process.env.NEXT_PUBLIC_SNG_DEBUG === '1';
const sngDebug = (...args: unknown[]) => {
  if (SNG_DEBUG) console.log(...args);
};

function cx(...classes: (string | false | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

function getTokenSymbol(mint: string): string {
  if (mint === PublicKey.default.toBase58()) return 'SOL';
  if (mint === POKER_MINT.toBase58()) return '$FP';
  if (mint === USDC_MAINNET_MINT.toBase58() || mint === USDC_DEVNET_MINT.toBase58()) return 'USDC';
  return mint.slice(0, 4) + '...';
}

function formatBlinds(sb: number, bb: number, decimals: number): string {
  const dec = decimals;
  const sbVal = sb / 10 ** dec;
  const bbVal = bb / 10 ** dec;
  const fmt = (v: number) => v >= 1 ? v.toFixed(v % 1 === 0 ? 0 : 2) : parseFloat(v.toPrecision(3)).toString();
  return `${fmt(sbVal)} / ${fmt(bbVal)}`;
}

/**
 * BB-only stake display - replaces formatBlinds in lobby tiles + cash rows
 * (May 2026 unification). SB is intentionally suppressed; the bottom-row
 * filter UI was the only consumer that needed both values.
 */
function formatBigBlind(bb: number, decimals: number): string {
  const dec = decimals;
  const v = bb / 10 ** dec;
  if (v >= 1) return v.toFixed(v % 1 === 0 ? 0 : 2);
  return parseFloat(v.toPrecision(3)).toString();
}

// ─── TokenPill ───
const TOKEN_COLORS: Record<string, string> = {
  SOL:   '#F26A1F',
  '$FP': '#FFC63A',
  USDC:  '#2775CA',
};

function TokenPill({ symbol, size = 14 }: { symbol: string; size?: number }) {
  if (symbol === 'SOL') {
    return <Image src="/tokens/sol.svg" alt="SOL" width={size} height={size} className="rounded-full" />;
  }
  if (symbol === '$FP') {
    return <Image src="/brand/app-icon.png" alt="$FP" width={size} height={size} className="rounded-full" />;
  }
  if (symbol === 'USDC') {
    return <Image src="/tokens/usdc.svg" alt="USDC" width={size} height={size} className="rounded-full" />;
  }
  const color = TOKEN_COLORS[symbol] ?? '#B8B4A8';
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-mono font-bold"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(7, size * 0.55),
        background: `${color}22`,
        color,
        border: `1px solid ${color}66`,
      }}
    >
      {symbol.replace('$', '')[0]}
    </span>
  );
}

// ─── FormatGlyph (SVG seat diagram) ───
function FormatGlyph({ seats, size = 30, color = '#F26A1F' }: { seats: number; size?: number; color?: string }) {
  const s = size, cx_ = s / 2, cy_ = s / 2, r = s * 0.36;
  const dots = [];
  for (let i = 0; i < seats; i++) {
    const a = -Math.PI / 2 + (i / seats) * Math.PI * 2;
    dots.push({ x: cx_ + r * Math.cos(a), y: cy_ + r * Math.sin(a) });
  }
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-hidden>
      <ellipse cx={cx_} cy={cy_} rx={r * 0.85} ry={r * 0.58} fill="none" stroke={color} strokeOpacity={0.25} strokeWidth={1} />
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={2.2} fill={color} fillOpacity={i === 0 ? 1 : 0.55} />
      ))}
    </svg>
  );
}

// ─── Eyebrow label ───
function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cx('font-mono text-[9px] tracking-[0.25em] text-boneDim/55 uppercase leading-none', className)}>{children}</span>;
}

// ─── Metric tile ───
function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center leading-none">
      <span className="font-mono text-[9px] tracking-[0.22em] text-boneDim/55 uppercase">{label}</span>
      <span className="font-display text-bone text-lg tabular-nums leading-none mt-1">{value}</span>
    </div>
  );
}

// ─── EmissionsStrip ───
function EmissionsStrip({ circulatingSupply }: { circulatingSupply: number }) {
  // Burn pressure = lifetime burned $FP / lifetime ever-minted $FP. Same
  // numerator/denominator the /earn PoolStats panel uses, so the lobby
  // gauge stays in sync with the canonical figure on the earn page.
  // Defaults to 0 while hooks are loading; EmissionGaugeFull renders it
  // muted in that state.
  const pool = usePoolHealth();
  const supply = usePokerSupply();
  const totalBurned = pool.totalPoolStaked;
  const everMinted = supply.wholeSupply + totalBurned;
  const burnPct = everMinted > 0 ? (totalBurned / everMinted) * 100 : 0;
  return (
    <EmissionGaugeFull
      circulatingSupply={circulatingSupply}
      burnPressurePct={burnPct}
    />
  );
}

// ─── ModeTabs ───
function ModeTabs({
  mode, setMode, sngStats, cashStats, myStats, myEarningCount, spectateStats,
}: {
  mode: 'sng' | 'cash' | 'my' | 'spectate';
  setMode: (m: 'sng' | 'cash' | 'my' | 'spectate') => void;
  sngStats: string;
  cashStats: string;
  myStats: string;
  myEarningCount: number;
  spectateStats: string;
}) {
  // Tabs always present; each non-SNG tab lazy-loads its data only when selected
  // (minimal viable requests). Cash/Watch enumerate tables client-side via
  // getProgramAccounts, which needs a capable RPC (degrades on the free pool).
  const tabs: { key: 'sng' | 'cash' | 'my' | 'spectate'; label: string; sub: string; badge: number }[] = [
    { key: 'sng', label: 'SIT & GO', sub: sngStats, badge: 0 },
    { key: 'cash', label: 'CASH TABLES', sub: cashStats, badge: 0 },
    { key: 'my', label: 'MY TABLES', sub: myStats, badge: myEarningCount },
    { key: 'spectate', label: 'WATCH', sub: spectateStats, badge: 0 },
  ];

  return (
    <div
      id="lobby-mode-tabs-shell"
      className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 w-full !mt-0 rounded-t-md px-3 py-2 md:px-4 md:py-2.5"
      style={{
        background: 'linear-gradient(180deg, rgba(70, 31, 10, 0.8) 0%, rgba(52, 23, 8, 0.67) 100%)',
        borderTop: '1px solid rgba(242, 105, 31, 0.38)',
        borderLeft: '1px solid rgba(242, 105, 31, 0.38)',
        borderRight: '1px solid rgba(242, 105, 31, 0.38)',
        borderBottom: 'none',
        boxShadow: '0 -2px 12px rgba(242,106,31,0.10), 0 4px 14px rgba(0,0,0,0.35)',
        backdropFilter: 'blur(10px) saturate(1.05)',
        WebkitBackdropFilter: 'blur(10px) saturate(1.05)',
      }}
    >
      <div id="lobby-mode-tabs" className="inline-flex items-stretch self-start w-full md:w-auto" role="tablist">
        {tabs.map((t, i) => {
          const on = mode === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={on}
              onClick={() => { SFX.play('ui-toggle'); setMode(t.key); }}
              className={cx(
                'relative flex-1 md:flex-none min-w-0 md:min-w-[168px]',
                'px-1.5 sm:px-3 md:px-6 py-2.5',
                'items-baseline justify-center gap-2 whitespace-nowrap',
                // WATCH tab is hidden on mobile (SNG tab carries the WATCH CTA there); desktop keeps it.
                t.key === 'spectate' ? 'hidden md:inline-flex' : 'inline-flex',
                'transition-colors outline-none',
                i < tabs.length - 1 && (tabs[i + 1].key === 'spectate'
                  ? 'md:border-r md:border-orange/20'   // divider before the (mobile-hidden) WATCH tab only at md+
                  : 'border-r border-orange/20'),
                on ? 'text-bone' : 'text-bone/70 hover:text-bone',
              )}
            >
              <span
                className={cx(
                  'font-display leading-none',
                  'text-[clamp(10px,2.6vw,14px)] md:text-base',
                  'tracking-[0.02em] sm:tracking-[0.06em] md:tracking-[0.08em]',
                )}
              >
                {t.label}
              </span>
              {on && (
                <span
                  className="absolute left-0 right-0 bottom-0 h-[2px]"
                  style={{ background: '#F26A1F', boxShadow: '0 0 6px rgba(242,106,31,0.5)' }}
                />
              )}
              <span className={cx(
                'hidden lg:inline font-mono text-[10px] tabular-nums tracking-wider leading-none',
                on ? 'text-boneDim/70' : 'text-boneDim/45',
              )}>
                {t.sub}
              </span>
              {t.badge > 0 && !on && (
                <span className="absolute top-1.5 right-2 w-1.5 h-1.5 rounded-full bg-amber shadow-[0_0_6px_rgba(255,198,58,0.85)] animate-pulse" />
              )}
            </button>
          );
        })}
      </div>
      {/* Action button - right of tabs on desktop, full-width centered below on mobile.
          On mobile the SNG tab swaps CREATE TABLE for a WATCH CTA (you don't create
          SNG tables); CASH/MY keep CREATE TABLE. Desktop always shows CREATE TABLE. */}
      <div className="flex justify-center md:justify-end md:self-auto w-full md:w-auto">
        {/* Mobile-only WATCH button on the SNG tab (replaces Create Table there) */}
        {mode === 'sng' && (
          <button
            onClick={() => { SFX.play('ui-toggle'); setMode('spectate'); }}
            className="md:hidden w-full inline-flex justify-center items-center gap-1.5 px-3 py-2 rounded-sm font-mono text-[10.5px] tracking-[0.2em] font-bold whitespace-nowrap border border-orange/35 bg-orange/[0.07] text-orange hover:bg-orange/[0.13] hover:border-orange/55 transition"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            WATCH LIVE
          </button>
        )}
        <Link
          href="/my-tables/create"
          onMouseDown={() => SFX.play('ui-click')}
          className={cx(
            'w-full md:w-auto inline-flex justify-center items-center gap-1.5 px-3 py-2 rounded-sm font-mono text-[10.5px] tracking-[0.2em] font-bold whitespace-nowrap border border-bone/25 bg-bone/[0.04] text-bone hover:bg-bone/[0.08] hover:border-bone/40 transition',
            mode === 'sng' && 'hidden md:inline-flex',
          )}
        >
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M6 2v8M2 6h8" />
          </svg>
          CREATE TABLE
        </Link>
      </div>
    </div>
  );
}

// ─── SNG tier colors (mockup palette) ───
const TIER_COLORS: Record<number, string> = {
  0: '#A05A2C', // Copper
  1: '#C77A3F', // Bronze
  2: '#D7D5CE', // Silver
  3: '#F2C94C', // Gold
  4: '#86E1D1', // Platinum
  5: '#6EE7F0', // Diamond
  6: '#F5F1E6', // Black
};

const TIER_NAMES: Record<number, string> = {
  0: 'COPPER', 1: 'BRONZE', 2: 'SILVER', 3: 'GOLD', 4: 'PLATINUM', 5: 'DIAMOND', 6: 'BLACK',
};

const FORMAT_META: Array<{ key: 'heads_up' | '6max' | '9max'; name: string; seats: number; gameTypeIndex: number }> = [
  { key: 'heads_up', name: 'Heads-Up', seats: 2, gameTypeIndex: 0 },
  { key: '6max',     name: '6-Max',    seats: 6, gameTypeIndex: 1 },
  { key: '9max',     name: '9-Max',    seats: 9, gameTypeIndex: 2 },
];

const SNG_DISABLED_LABEL = 'CURRENTLY DISABLED';
const TEMP_DISABLED_SNG_POOLS = new Set<string>([
]);

function isSngPoolTemporarilyDisabled(gameTypeIndex: number, tier: number): boolean {
  return TEMP_DISABLED_SNG_POOLS.has(`${gameTypeIndex}-${tier}`);
}

// ─── SNG Pool Card ───
function SngPoolCard({
  queue, selectedTier, publicKey: myKey, poolData,
  onResume,
  onJoinPool, onLeavePool, joiningPool, leavingPool, myActiveGames,
  listActionOnly, onOpenModal,
}: {
  queue: SitNGoQueue;
  selectedTier: number;
  publicKey: string;
  poolData?: SngPool;
  onResume: (pda: string) => void;
  onJoinPool?: (gameType: number, tier: number, miniOptIn?: boolean) => void;
  onLeavePool?: (gameType: number, tier: number) => void;
  joiningPool?: string | null;
  leavingPool?: string | null;
  myActiveGames: SitNGoQueue[];
  listActionOnly?: boolean;
  onOpenModal?: (gameType: number, tier: number, autoStart?: boolean, defaultMini?: boolean, rejoin?: boolean) => void;
}) {
  const tierColor = TIER_COLORS[selectedTier] ?? '#F26A1F';
  const router = useRouter();
  // Seated players: the TAKE SEAT badge routes to My Tables (where they pick
  // which seat to return to) rather than resuming one table inline.
  const goMyTables = () => { SFX.play('ui-click'); router.push('/my-tables'); };
  const typeName = queue.type === 'heads_up' ? 'Heads-Up' : queue.type === '6max' ? '6-Max' : '9-Max';
  const spots = queue.maxPlayers;
  const hasEmptySeat = (queue.emptySeats?.length ?? 0) > 0;
  const actualPlayers = queue.onChainPlayers ?? queue.currentPlayers;
  const isMyGame = queue.players?.includes(myKey);

  const gameTypeIndex = queue.type === 'heads_up' ? 0 : queue.type === '6max' ? 1 : 2;
  const poolKey = `${gameTypeIndex}-${selectedTier}`;
  const isInPool = poolData ? poolData.queue.includes(myKey) : false;
  const isJoiningPool = joiningPool === poolKey;
  const isLeavingPool = leavingPool === poolKey;
  // Displayed buy-in = entry + fee (+ optional operator site fee). Excludes Lucky
  // Pot opt-in AND the page-rent contribution (the API's `totalBuyIn` adds rent
  // share, inflating price). The site fee, when configured, is folded in so the
  // JOIN button price matches what the confirm modal actually charges.
  const buyInLamportsCard = poolData ? poolData.entryAmount + poolData.feeAmount : 0;
  const siteFeeLamportsCard = poolData ? computeSngFeeLamports(buyInLamportsCard) : 0;
  const entryCostSol = poolData ? ((buyInLamportsCard + siteFeeLamportsCard) / 1e9).toFixed(3).replace(/\.?0+$/, '') : null;

  const myMatchedTablePda = myActiveGames.find(g => g.type === queue.type && g.tier === selectedTier && g.tablePda)?.tablePda;
  // If the pool already lists my wallet in matchedPlayers but /api/my-sng-tables
  // hasn't surfaced the tablePda yet (or the page was refreshed and
  // wasInPoolRef was lost), surface a sticky matched state so the card shows
  // MATCHING / TAKE SEAT instead of snapping back to a payable JOIN button.
  const serverSaysMatched = !!(poolData && myKey && (poolData as any).matchedPlayers?.includes?.(myKey));

  // Sticky "pending match" - between the moment the pool queue drops this
  // player (matched) and the moment /api/my-sng-tables surfaces the new
  // table PDA, both isInPool and myMatchedTablePda are false. Without a
  // sticky flag the tile snaps back to "JOIN" which lets the player
  // re-enter the pool (double buy-in risk). We latch "pending" while we
  // wait for the table PDA to land, capped at 60s so a bad match doesn't
  // lock the tile forever.
  const wasInPoolRef = useRef(false);
  const [pendingMatch, setPendingMatch] = useState(false);
  useEffect(() => {
    const tag = `[SNG-DEBUG] CARD gt=${gameTypeIndex} tier=${selectedTier}`;
    if (isInPool) {
      sngDebug(`${tag} branch=isInPool t=${Date.now()} -> wasInPool=true, pendingMatch=false`);
      wasInPoolRef.current = true;
      setPendingMatch(false);
      return;
    }
    if (myMatchedTablePda) {
      sngDebug(`${tag} branch=matchedTable t=${Date.now()} pda=${myMatchedTablePda.slice(0,8)}`);
      wasInPoolRef.current = false;
      setPendingMatch(false);
      return;
    }
    if (wasInPoolRef.current) {
      const recentLeave = isPoolLeaveVoluntary(gameTypeIndex, selectedTier);
      const recentJoin = isPoolJoinVoluntary(gameTypeIndex, selectedTier);
      if (recentLeave || recentJoin) {
        sngDebug(`${tag} branch=voluntary-suppress t=${Date.now()} recentLeave=${recentLeave} recentJoin=${recentJoin}`);
        wasInPoolRef.current = false;
        setPendingMatch(false);
        return;
      }
      sngDebug(`${tag} branch=pendingMatch-set t=${Date.now()} (fell out of pool with no match + no voluntary signal)`);
      setPendingMatch(true);
      const t = setTimeout(() => {
        sngDebug(`${tag} branch=pendingMatch-timeout t=${Date.now()}`);
        setPendingMatch(false);
        wasInPoolRef.current = false;
      }, 120000); // 120s: placement (TEE delegation + serial seat_from_pool) can run 30-90s under load; don't snap back to JOIN mid-placement
      return () => clearTimeout(t);
    }
  }, [isInPool, myMatchedTablePda, gameTypeIndex, selectedTier]);

  const isMatchingPending = pendingMatch || serverSaysMatched;
  const poolTemporarilyDisabled = isSngPoolTemporarilyDisabled(gameTypeIndex, selectedTier);
  const newJoinBlocked = poolTemporarilyDisabled && !isInPool && !isMatchingPending;
  const fillCount = poolData ? poolData.queueCount : actualPlayers;
  const fillPct = Math.min(fillCount / spots, 1);
  const avgFillTime = `~${Math.max(10, 60 - fillCount * 8)}s fill`;

  const _fmt = queue.maxPlayers === 2 ? EmissionFormat.HU : queue.maxPlayers === 6 ? EmissionFormat.Six : EmissionFormat.Nine;
  // 90% of gross goes to player pool; 10% feeds the Royal Jackpot.
  // calculateSngPoolUnrefined returns gross; trim 10% here so the per-place
  // rows match the on-chain payout (post-Royal-skim).
  const grossPokerUnrefined = poolData
    ? Number(calculateSngPoolUnrefined(_fmt, queue.maxPlayers, BigInt(0), selectedTier))
    : 0;
  const pokerPool = (grossPokerUnrefined * 0.9) / 1_000_000;
  const solPool = poolData ? (poolData.entryAmount * queue.maxPlayers) / 1e9 : 0;
  // SOL prize pool is paid only to ITM (top 1/2/3). POKER (Raw Yield) is
  // spread to every paid place per the new BPS schedule. Last seat is 0
  // (HU 2nd / 6-max 6th / 9-max 8th+9th). Mirrors PokerPayoutStructure in
  // programs/fastpoker/src/constants.rs.
  const solPayouts = queue.maxPlayers <= 2 ? [100] : queue.maxPlayers <= 6 ? [65, 35] : [50, 30, 20];
  const pokerPayouts = queue.maxPlayers <= 2
    ? [100, 0]
    : queue.maxPlayers <= 6
      ? [55, 25, 12, 5, 3, 0]
      : [50, 25, 15, 5, 3, 1, 1, 0, 0];

  // In list view the row renders its own layout; this component only renders the action button
  if (listActionOnly) {
    if (myMatchedTablePda) {
      // Seated: TAKE SEAT goes to My Tables (pick which seat to return to); a
      // second button re-queues this pool via the modal in fresh-join mode.
      return (
        <div className="flex flex-col gap-1">
          <button onClick={(e) => { e.stopPropagation(); goMyTables(); }} className="w-full py-1.5 rounded-sm bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 font-mono text-[10px] tracking-[0.18em] font-bold hover:bg-emerald-500/20 transition">TAKE SEAT ↗</button>
          <button onClick={() => { SFX.play('ui-click'); onOpenModal?.(gameTypeIndex, selectedTier, undefined, undefined, true); }} disabled={isJoiningPool || newJoinBlocked} className="fp-cta-join font-display disabled:opacity-30 disabled:cursor-not-allowed">{newJoinBlocked ? SNG_DISABLED_LABEL : isJoiningPool ? 'JOINING...' : entryCostSol ? `REJOIN ${entryCostSol}` : 'REJOIN'}</button>
        </div>
      );
    }
    if (isMatchingPending) {
      return <button disabled className="w-full py-1.5 rounded-sm border border-amber/40 bg-amber/10 text-amber font-mono text-[10px] tracking-[0.18em] font-bold cursor-wait">MATCHING...</button>;
    }
    if (isInPool) {
      return <button onClick={() => { SFX.play('ui-click'); onOpenModal?.(gameTypeIndex, selectedTier); }} className="w-full py-1.5 rounded-sm border border-gold/30 text-gold hover:text-bone hover:border-gold font-mono text-[10px] tracking-[0.18em] font-bold transition">VIEW QUEUE</button>;
    }
    if (newJoinBlocked) {
      return <button disabled className="w-full py-1.5 rounded-sm border border-boneDim/25 bg-bone/[0.04] text-boneDim/60 font-mono text-[10px] tracking-[0.18em] font-bold cursor-not-allowed">{SNG_DISABLED_LABEL}</button>;
    }
    if (poolData) {
      return <button onClick={() => { SFX.play('ui-click'); onOpenModal?.(gameTypeIndex, selectedTier); }} disabled={isJoiningPool} className="fp-cta-join font-display disabled:opacity-30">{isJoiningPool ? 'JOINING...' : entryCostSol ? `JOIN ${entryCostSol}` : 'JOIN'}</button>;
    }
    return <button disabled className="fp-cta-join font-display opacity-40 cursor-not-allowed">POOL OFFLINE</button>;
  }

  const disabled = !!isJoiningPool || !!isLeavingPool || (newJoinBlocked && !myMatchedTablePda);

  const onCardClick = () => {
    if (disabled) return;
    if (isMatchingPending) return;
    if (newJoinBlocked) return;
    SFX.play('ui-click');
    // In your own in-progress game (not a fresh pool match): resume it directly.
    if (!myMatchedTablePda && isMyGame && queue.tablePda) { onResume(queue.tablePda); return; }
    // Otherwise open the join modal. When already seated at a matched table, open
    // it in fresh-join mode (5th arg) so it offers JOIN and you can re-queue;
    // returning to that seat is the TAKE SEAT badge -> My Tables.
    if (poolData) { onOpenModal?.(gameTypeIndex, selectedTier, undefined, undefined, !!myMatchedTablePda); return; }
  };

  const statusLabel = myMatchedTablePda
    ? { text: 'TAKE SEAT ↗', tone: 'emerald' as const }
    : isMatchingPending
      ? { text: 'MATCHING', tone: 'amber' as const }
      : isInPool
        ? { text: 'IN QUEUE', tone: 'gold' as const }
        : newJoinBlocked
          ? { text: SNG_DISABLED_LABEL, tone: 'disabled' as const }
          : null;

  // CA3d-derived layout helpers
  const buyinSol = poolData ? poolData.entryAmount / 1e9 : 0;
  // Use feeAmount directly so the page-rent contribution is excluded from the
  // displayed buy-in/fee total. Lucky Pot is also excluded (opt-in separately).
  const feeSol = poolData ? poolData.feeAmount / 1e9 : 0;
  const overflow = Math.max(fillCount - spots, 0);
  const seatsLit = Math.min(fillCount, spots);
  const paidPlaceCount = pokerPayouts.filter(p => p > 0).length;
  const placeColorFor = (n: number) => n === 1 ? '#FFC63A' : n === 2 ? '#cbd5e1' : n === 3 ? '#b45309' : '#6b7280';

  const isBlackTier = selectedTier === 6;
  return (
    <button
      type="button"
      onClick={onCardClick}
      disabled={disabled}
      className={cx(
        'fp-sng-card relative flex flex-col text-left transition group overflow-hidden h-full w-full',
        myMatchedTablePda
          ? 'border-emerald-400/60 hover:border-emerald-400'
          : isMatchingPending
            ? 'border-amber/50 cursor-wait'
            : isInPool
              ? 'border-gold/60 hover:border-gold'
              : newJoinBlocked
                ? 'border-boneDim/30 cursor-not-allowed grayscale-[0.35]'
                : 'hover:brightness-110',
        disabled && 'opacity-60 cursor-not-allowed',
      )}
      style={{
        borderColor: !myMatchedTablePda && !isMatchingPending && !isInPool && !newJoinBlocked
          ? (isBlackTier ? 'rgba(245,241,230,0.65)' : `${tierColor}55`)
          : undefined,
        // BLACK TIER: keep play_card_bg art, just add a bone outline + soft
        // inset sheen + slight deepening tint so it reads as the premium tier.
        ...(isBlackTier ? {
          borderWidth: '1.5px',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.22), ' +
            'inset 0 0 0 1px rgba(0,0,0,0.55), ' +
            '0 0 0 1px rgba(245,241,230,0.18), ' +
            '0 10px 22px rgba(0,0,0,0.55)',
        } : null),
      }}
    >
      {/* BLACK TIER tint overlay - heavy near-opaque matte black so the play
          card art reads as a faint texture under the black wash + bone sheen. */}
      {isBlackTier && (
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'linear-gradient(180deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.96) 100%), ' +
              'radial-gradient(ellipse 70% 50% at 0% 0%, rgba(255,255,255,0.10) 0%, transparent 60%)',
          }}
        />
      )}
      {/* watermark */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.04] select-none">
        <TokenIcon mint={POKER_MINT.toBase58()} size={180} alt="" />
      </div>

      {statusLabel && (
        <div
          role={myMatchedTablePda ? 'link' : undefined}
          tabIndex={myMatchedTablePda ? 0 : undefined}
          onClick={myMatchedTablePda ? (e) => { e.stopPropagation(); goMyTables(); } : undefined}
          title={myMatchedTablePda ? 'Go to My Tables to take your seat' : undefined}
          className={cx(
            'absolute top-1.5 right-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-sm border z-10',
            myMatchedTablePda && 'cursor-pointer hover:bg-emerald-400/30',
            statusLabel.tone === 'emerald'
              ? 'bg-emerald-400/20 border-emerald-400/50'
              : statusLabel.tone === 'amber'
                ? 'bg-amber/20 border-amber/50'
                : statusLabel.tone === 'gold'
                  ? 'bg-gold/20 border-gold/50'
                  : 'bg-bone/10 border-boneDim/30',
          )}
        >
          <span
            className={cx(
              'w-1 h-1 rounded-full animate-pulse',
              statusLabel.tone === 'emerald' ? 'bg-emerald-400'
              : statusLabel.tone === 'amber' ? 'bg-amber'
                : statusLabel.tone === 'gold' ? 'bg-gold' : 'bg-boneDim',
            )}
          />
          <span
            className={cx(
              'font-mono text-[8px] tracking-[0.2em] leading-none font-bold',
              statusLabel.tone === 'emerald' ? 'text-emerald-400'
              : statusLabel.tone === 'amber' ? 'text-amber'
                : statusLabel.tone === 'gold' ? 'text-gold' : 'text-boneDim',
            )}
          >
            {statusLabel.text}
          </span>
        </div>
      )}

      {/* Header - tier hero */}
      <div className="relative flex items-end justify-between py-1.5">
        <div>
          <div className="font-display text-[20px] tracking-[0.16em] leading-none" style={{ color: tierColor }}>
            {(TIER_NAMES[selectedTier] ?? 'POOL').toUpperCase()}
          </div>
          <div className="font-mono text-[8px] tracking-[0.3em] text-boneDim/60 mt-1">POOL ENTRY</div>
        </div>
        <div className="inline-flex flex-col items-end bg-black/75 backdrop-blur-sm border border-white/25 rounded-sm px-3 py-1.5">
          <div className="font-display text-[16px] text-bone leading-none">{typeName}</div>
          <div className="font-mono text-[8px] tracking-[0.25em] text-boneDim/60 mt-1">{spots} SEATS</div>
        </div>
      </div>

      {/* Players hero row */}
      <div className="relative">
        <div
          className="flex items-baseline justify-between mb-1.5"
          style={{ textShadow: '0 0 1px rgba(0,0,0,1), 0 0 2px rgba(0,0,0,1), 0 1px 4px rgba(0,0,0,0.95), 0 2px 10px rgba(0,0,0,0.85), 0 0 20px rgba(0,0,0,0.7)' }}
        >
          <div className="font-display text-[18px] text-bone leading-none">PLAYERS</div>
          <div className="flex items-baseline gap-1">
            <span className="font-display text-[18px] text-bone tabular-nums leading-none">{fillCount}</span>
            <span className="font-display text-[18px] text-boneDim/50 tabular-nums leading-none">/ {spots}</span>
            {overflow > 0 && (
              <span className="font-mono text-[8px] tracking-[0.18em] uppercase ml-1 px-1.5 py-[1px] rounded-sm border"
                    style={{ color: '#FFC63A', borderColor: '#FFC63A66', background: 'rgba(255,198,58,0.08)' }}>
                +{overflow} queued
              </span>
            )}
          </div>
        </div>
        <div id="sng-card-seat-meter" className="flex gap-[3px] h-1.5 items-stretch">
          {Array.from({ length: spots }).map((_, i) => (
            <div
              key={i}
              className="flex-1 rounded-full transition-colors duration-200"
              style={{
                background: i < seatsLit ? '#F5F1E6' : 'rgba(245,241,230,0.15)',
                boxShadow: i < seatsLit ? '0 0 5px rgba(245,241,230,0.55)' : 'inset 0 0 0 1px rgba(245,241,230,0.10)',
              }}
            />
          ))}
          {overflow > 0 && (
            <div
              className="flex items-center justify-center px-1.5 rounded-full"
              style={{ background: 'rgba(255,198,58,0.16)' }}
            >
              <span className="font-mono text-[7px] font-bold leading-none tabular-nums" style={{ color: '#FFC63A' }}>
                +{overflow}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Prominent buy-in CTA (placement from 3006) - verb + total up top,
          buy/fee breakdown below. Visual only; click bubbles to the card button.
          Styled with the 3004 theme: fp-cta-join + boneDim, no tier-color divider. */}
      {(() => {
        const totalSol = buyinSol + feeSol;
        // Seated players see BUY IN (re-queue this pool); returning to an existing
        // seat is the TAKE SEAT badge -> My Tables. So a matched table no longer
        // morphs this CTA into TAKE SEAT.
        const joinVerb = isMatchingPending
          ? 'MATCHING…'
          : isInPool
            ? 'VIEW QUEUE'
            : newJoinBlocked
              ? SNG_DISABLED_LABEL
              : 'BUY IN';
        const isDefault = !newJoinBlocked && !isMatchingPending && !isInPool;
        const stateTone = isMatchingPending
          ? { bg: 'rgba(245,158,11,0.14)', border: '#f59e0b88', text: '#FFC63A' }
          : newJoinBlocked
            ? { bg: 'rgba(245,241,230,0.06)', border: 'rgba(184,180,168,0.28)', text: 'rgba(184,180,168,0.72)' }
            : { bg: 'rgba(255,198,58,0.14)', border: '#FFC63A88', text: '#FFC63A' };
        return (
          <div className="relative pb-3 border-b border-white/5">
            <div
              id="sng-card-buyin-cta"
              aria-hidden="true"
              className={cx(
                'w-full py-3 sm:py-2.5 rounded-sm font-display text-[14px] sm:text-[13px] tracking-[0.18em] inline-flex items-center justify-center gap-2',
                isDefault && 'btn-orange',
              )}
              style={isDefault ? undefined : {
                background: stateTone.bg,
                border: `1px solid ${stateTone.border}`,
                color: stateTone.text,
              }}
            >
              <span>{joinVerb}</span>
              {!newJoinBlocked && !isMatchingPending && (
                <>
                  <span className="opacity-50 font-mono text-[11px] font-normal">·</span>
                  <span className="font-mono text-[11px] tracking-[0.18em] tabular-nums font-normal">{fmtSol(totalSol)}</span>
                  <SolIcon size={12} />
                </>
              )}
              {!newJoinBlocked && <span className="ml-1 text-[18px] leading-none">▸</span>}
            </div>
            {!newJoinBlocked && <div className="mt-1.5 flex justify-center">
              <div className="font-mono text-[9px] tracking-[0.16em] text-bone/70 uppercase inline-flex items-center justify-center gap-1.5 bg-black/55 rounded-sm px-2.5 py-1 border border-white/5">
                <span className="tabular-nums">{fmtSol(buyinSol)} buy</span>
                <span className="opacity-50">+</span>
                <span className="tabular-nums">{fmtSol(feeSol)} fee</span>
                <span className="opacity-50">=</span>
                <span className="tabular-nums">total {fmtSol(totalSol)}</span>
                <SolIcon size={9} />
              </div>
            </div>}
          </div>
        );
      })()}

      {/* Paid places - pool totals double as column headers */}
      <div className="relative rounded-sm bg-black/30">
        <div className="px-2 py-1.5 border-b grid grid-cols-[36px_1fr_1fr] items-end gap-x-3" style={{ borderColor: `${tierColor}33` }}>
          <div>
            <div className="font-mono text-[8px] tracking-[0.22em]" style={{ color: tierColor }}>PAID</div>
            <div className="font-mono text-[7px] tracking-[0.18em] text-boneDim/60 mt-0.5">{paidPlaceCount}/{spots}</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[7px] tracking-[0.22em] text-emerald-400/75">SOL POOL</div>
            <div className="font-display text-[15px] text-emerald-300 flex items-center justify-end gap-1 leading-none mt-1 tabular-nums">{fmtSol(solPool)}<SolIcon size={12} /></div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[7px] tracking-[0.22em]" style={{ color: 'rgba(255,198,58,0.85)' }}>$FP POOL</div>
            <div className="font-display text-[15px] flex items-center justify-end gap-1 leading-none mt-1 tabular-nums" style={{ color: '#FFC63A', fontWeight: 600 }}>{fmtFP(pokerPool)}<TokenIcon mint={POKER_MINT.toBase58()} size={13} alt="" /></div>
          </div>
        </div>
        <div className="px-2 py-1 grid grid-cols-[36px_1fr_1fr] items-center gap-x-3 gap-y-0.5 tabular-nums">
          {pokerPayouts.map((pPct, i) => {
            const sPct = solPayouts[i] ?? 0;
            if (pPct === 0 && sPct === 0) return null;
            const placeNum = i + 1;
            const pColor = placeColorFor(placeNum);
            const sol = solPool * sPct / 100;
            const fp = pokerPool * pPct / 100;
            return (
              <Fragment key={i}>
                <span className="font-mono text-[10px] font-bold tracking-[0.12em]" style={{ color: pColor }}>#{placeNum}</span>
                <div className="flex items-center justify-end gap-1">
                  {sol > 0 ? (
                    <>
                      <span className="font-display text-[11px] text-emerald-300 leading-none">{fmtSol(sol)}</span>
                      <SolIcon size={10} />
                    </>
                  ) : (
                    <>
                      <span className="font-mono text-[9px] text-boneDim/35 leading-none">··</span>
                      <span style={{ width: 10, height: 10 }} />
                    </>
                  )}
                </div>
                <div className="flex items-center justify-end gap-1">
                  <span className="font-display text-[11px] leading-none" style={{ color: '#FFC63A', fontWeight: 600 }}>{fmtFP(fp)}</span>
                  <TokenIcon mint={POKER_MINT.toBase58()} size={11} alt="" />
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>

    </button>
  );
}

// Lucky Jackpot opt-in preference. The join modal's checkbox defaults from here
// so a player's choice (notably an OPT-OUT) sticks across future entries instead
// of resetting to opted-in every time. localStorage; undefined when never set.
const LUCKY_JACKPOT_PREF_KEY = 'fastpoker:lucky-jackpot-optin:v1';
function readLuckyJackpotPref(): boolean | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const v = window.localStorage.getItem(LUCKY_JACKPOT_PREF_KEY);
    return v === null ? undefined : v === '1';
  } catch { return undefined; }
}
function writeLuckyJackpotPref(v: boolean): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(LUCKY_JACKPOT_PREF_KEY, v ? '1' : '0'); } catch { /* quota / private mode */ }
}

// SNG join modal: six-step on-chain join flow.
const SNG_JOIN_STEPS: Array<{ id: string; title: string; desc: string }> = [
  { id: 'pick',  title: 'Pool selected',     desc: 'Format + tier chosen in lobby.' },
  { id: 'key',   title: 'Session key',       desc: 'Wallet signature authorizes gasless signer.' },
  { id: 'join',  title: 'join_sng_pool',     desc: 'On-chain IX - entry, fee, and refundable Lucky escrow to pool vault. You enter the queue.' },
  { id: 'queue', title: 'Queue filling',     desc: 'Waiting for remaining players.' },
  { id: 'cool',  title: 'Matching...',       desc: 'Queue full - pairing players and preparing table.' },
  { id: 'seat',  title: 'seat_from_pool',    desc: 'Buy-in to table vault. Lucky escrow funds the live pot only after you are seated.' },
];

interface SngJoinModalPool {
  gameTypeIndex: number;
  tier: number;
  format: typeof FORMAT_META[0];
  poolData?: SngPool;
  myMatchedTablePda?: string;
}

function SngJoinModal({
  pool, onClose, onConfirm, onLeave, onResume, joiningPool, leavingPool, publicKey: myKey,
  autoStart, defaultMiniOptIn,
}: {
  pool: SngJoinModalPool | null;
  onClose: () => void;
  onConfirm: (gameTypeIndex: number, tier: number, miniOptIn: boolean) => void;
  onLeave: (gameTypeIndex: number, tier: number) => void;
  onResume: (pda: string) => void;
  joiningPool?: string | null;
  leavingPool?: string | null;
  publicKey: string;
  /** Quick Play: skip the "Confirm" prompt and auto-fire onConfirm on mount. */
  autoStart?: boolean;
  /** Initial Lucky Pot opt-in (defaults true to match the prior modal behavior). */
  defaultMiniOptIn?: boolean;
}) {
  const [cooldown, setCooldown] = useState(30);
  // `?? readLuckyJackpotPref()`: an explicit caller default (e.g. Quick Play's
  // luckyOptIn) still wins via ??; normal join passes undefined, so the player's
  // saved opt-in/opt-out is honored, falling back to opted-in for first-timers.
  const [miniOptIn, setMiniOptIn] = useState<boolean>(defaultMiniOptIn ?? readLuckyJackpotPref() ?? true);
  const autoFiredRef = useRef(false);

  // Stable identity for THIS join request - parent recreates the `pool` object
  // literal every render, so depending on `pool` directly would re-fire effects
  // on every parent re-render (which causes an infinite wallet-sign loop when
  // autoStart=true). Key by gameTypeIndex+tier instead so resets only happen
  // when the player is truly switching pools.
  const poolIdentity = pool ? `${pool.gameTypeIndex}-${pool.tier}` : '';

  useEffect(() => {
    if (!poolIdentity) return;
    SFX.play('modal-open');
    setMiniOptIn(defaultMiniOptIn ?? readLuckyJackpotPref() ?? true);
    autoFiredRef.current = false;
  }, [poolIdentity, defaultMiniOptIn]);

  // Quick Play auto-start: immediately commit the join when the modal mounts.
  // The modal stays open as a status display (it's "joining", not "asking to
  // join"). `onConfirm` ref is unstable but autoFiredRef stops re-fires.
  useEffect(() => {
    if (!pool || !autoStart || autoFiredRef.current) return;
    if (isSngPoolTemporarilyDisabled(pool.gameTypeIndex, pool.tier)) return;
    autoFiredRef.current = true;
    onConfirm(pool.gameTypeIndex, pool.tier, defaultMiniOptIn ?? readLuckyJackpotPref() ?? true);
  }, [poolIdentity, autoStart, defaultMiniOptIn, onConfirm, pool]);

  // Derive step index from pool state
  const { poolData, format, tier, gameTypeIndex, myMatchedTablePda } = pool ?? {} as SngJoinModalPool;
  const poolKey = pool ? `${gameTypeIndex}-${tier}` : '';
  const isInPool = pool && poolData ? poolData.queue.includes(myKey) : false;
  const queueCount = poolData?.queueCount ?? 0;
  const seats = format?.seats ?? 0;
  const queueFull = !!pool && queueCount >= seats && seats > 0;
  const isJoining = pool && joiningPool === poolKey;
  const isLeaving = pool && leavingPool === poolKey;
  // "Sticky" registration flag - once the player has been in the queue OR has
  // been matched, keep treating them as registered even if the pool state
  // briefly drops them during the handoff from pool → seat. Without this the
  // step indicator snaps back to step 1 ("Session key") for a moment as the
  // queue is cleared before myActiveGames learns about the new table PDA.
  const hasJoinedRef = useRef(false);
  useEffect(() => {
    if (!pool) { hasJoinedRef.current = false; return; }
    if (isInPool || myMatchedTablePda) hasJoinedRef.current = true;
  }, [pool, isInPool, myMatchedTablePda]);

  const isPendingMatch = !!pool && !myMatchedTablePda && hasJoinedRef.current && !isInPool;
  const poolTemporarilyDisabled = !!pool && isSngPoolTemporarilyDisabled(gameTypeIndex, tier);
  const joinTemporarilyDisabled = poolTemporarilyDisabled && !isInPool && !myMatchedTablePda && !isPendingMatch;
  const canConfirmJoin = !!pool && !joinTemporarilyDisabled && !isInPool && !myMatchedTablePda && !isPendingMatch;

  let stepIdx = 0;
  if (pool) {
    if (myMatchedTablePda) stepIdx = 5;
    // Transition window: left the queue but table PDA hasn't landed in
    // myActiveGames yet - show "Matching…" instead of snapping to step 1.
    else if (isPendingMatch) stepIdx = 4;
    else if (isInPool && queueFull) stepIdx = 4;
    else if (isInPool) stepIdx = 3;
    else if (isJoining) stepIdx = 2;
    else stepIdx = 1;
  }

  useEffect(() => {
    if (!pool) return;
    if (!queueFull) { setCooldown(30); return; }
    const id = setInterval(() => {
      setCooldown(c => (c <= 0 ? 0 : c - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [pool, queueFull]);

  if (!pool || !format) return null;

  const tierColor = TIER_COLORS[tier] ?? '#F26A1F';
  const tierName = TIER_NAMES[tier] ?? 'POOL';
  const entrySol = poolData ? (poolData.entryAmount / 1e9) : 0;
  const feeSol = poolData ? (poolData.feeAmount / 1e9) : 0;
  const buyInSol = poolData ? (poolData.totalBuyIn / 1e9) : 0;
  const miniAddonSol = SNG_MINI_ADDON_LAMPORTS / 1e9;
  // Optional operator frontend fee (a SOL transfer appended to the join tx).
  // Folded into the displayed total so "CONFIRM JOIN · X SOL" is honest.
  const siteFeeSol = poolData ? computeSngFeeLamports(poolData.totalBuyIn) / 1e9 : 0;
  const siteFeeDesc = describeSngFee();
  const totalJoinSol = buyInSol + (miniOptIn ? miniAddonSol : 0) + siteFeeSol;
  const solPool = poolData ? entrySol * seats : 0;
  const _fmt = seats === 2 ? EmissionFormat.HU : seats === 6 ? EmissionFormat.Six : EmissionFormat.Nine;
  // 10% Royal-Jackpot skim on POKER gross before player pool distribution.
  const grossPokerUnrefined = poolData
    ? Number(calculateSngPoolUnrefined(_fmt, seats, BigInt(0), tier))
    : 0;
  const pokerPool = (grossPokerUnrefined * 0.9) / 1_000_000;
  const solPayouts = seats <= 2 ? [100] : seats <= 6 ? [65, 35] : [50, 30, 20];
  const pokerPayouts = seats <= 2
    ? [100, 0]
    : seats <= 6
      ? [55, 25, 12, 5, 3, 0]
      : [50, 25, 15, 5, 3, 1, 1, 0, 0];
  const miniFormatShare = seats <= 2 ? 25 : seats <= 6 ? 60 : 100;
  const grandTierWeight = tier === 0 ? '0.10x' : tier === 1 ? '0.20x' : tier === 2 ? '0.50x' : tier === 3 ? '1.00x' : tier === 4 ? '2.00x' : tier === 5 ? '4.00x' : '10.00x';
  const grandFormatWeight = seats <= 2 ? '1.00x' : seats <= 6 ? '1.73x' : '2.11x';

  const close = () => { SFX.play('modal-close'); onClose(); };
  const confirmJoin = () => {
    SFX.play('deposit');
    onConfirm(gameTypeIndex, tier, miniOptIn);
  };
  const leaveQueue = () => {
    SFX.play('modal-close');
    onLeave(gameTypeIndex, tier);
  };
  const toTable = () => {
    if (myMatchedTablePda) { SFX.play('tourney-win'); onResume(myMatchedTablePda); }
  };

  useEffect(() => {
    if (!myMatchedTablePda) return;
    // Let the user register the completed arc ("you're seated") before the
    // handoff, instead of a 900ms blink-and-redirect. They can also tap TO TABLE.
    const t = window.setTimeout(() => {
      SFX.play('tourney-win');
      onResume(myMatchedTablePda);
    }, 2500);
    return () => window.clearTimeout(t);
  }, [myMatchedTablePda, onResume]);

  // ── Live placement narration ──────────────────────────────────────────────
  // Kills the "frozen Matching… spinner" void: derive a continuously-updating
  // state from signals that already exist (queue fill, matchEligibleAt,
  // activeMatchSet, the matched table PDA + its phase). The two genuinely-blind
  // server steps (TEE delegation + serial seat_from_pool) are narrated honestly
  // by elapsed time with an escalating watchdog — never a bare spinner.
  const [placeNowMs, setPlaceNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setPlaceNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const pendingSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (isPendingMatch && !myMatchedTablePda) {
      if (pendingSinceRef.current == null) pendingSinceRef.current = Date.now();
    } else {
      pendingSinceRef.current = null;
    }
  }, [isPendingMatch, myMatchedTablePda]);
  // Speed the table-PDA poll only while THIS player is mid-placement (reverts
  // the instant a seat lands). my-sng-tables is uncached, so we only pay the
  // faster cadence for the player actually being placed.
  useEffect(() => {
    if (!isPendingMatch || myMatchedTablePda) return;
    const id = window.setInterval(() => { void refreshMyActiveTables(); }, 4000);
    return () => window.clearInterval(id);
  }, [isPendingMatch, myMatchedTablePda]);

  // "Not selected this round": a queued player can be pulled into a match attempt
  // (isPendingMatch) and then re-queued when the dealer seats a different subset
  // of candidates. Detect the PLACING -> back-in-pool transition so we can say so,
  // instead of silently snapping the narration back to IN THE QUEUE (the "it hung,
  // then dropped me back to the queue with no explanation" report).
  const wasPlacingRef = useRef(false);
  const [requeuedAtMs, setRequeuedAtMs] = useState<number | null>(null);
  useEffect(() => {
    if (isPendingMatch && !myMatchedTablePda) {
      wasPlacingRef.current = true;
      setRequeuedAtMs(null);
    } else if (myMatchedTablePda) {
      wasPlacingRef.current = false;
    } else if (wasPlacingRef.current && isInPool) {
      wasPlacingRef.current = false;
      setRequeuedAtMs(Date.now());
    }
  }, [isPendingMatch, isInPool, myMatchedTablePda]);
  const recentlyRequeued = requeuedAtMs != null && placeNowMs - requeuedAtMs < 8000;

  const cooldownLeft = poolData?.matchEligibleAt
    ? Math.max(0, Math.ceil(poolData.matchEligibleAt - placeNowMs / 1000))
    : 0;
  const pendingElapsedSec = pendingSinceRef.current ? Math.floor((placeNowMs - pendingSinceRef.current) / 1000) : 0;
  const watchdogDetail =
    pendingElapsedSec < 12 ? 'Building your table — delegating seats to the dealer…'
    : pendingElapsedSec < 30 ? 'Still seating players — larger tables take a little longer…'
    : pendingElapsedSec < 75 ? 'Almost done — finalizing the deal…'
    : 'Heavy load — the dealer is catching up. You keep your spot.';

  const placement: { label: string; detail: string; tone: 'queue' | 'match' | 'seat' } | null = (() => {
    if (myMatchedTablePda) return { label: "YOU'RE SEATED", detail: 'Table ready — taking your seat…', tone: 'seat' };
    if (isJoining) return { label: 'SIGNING YOU IN', detail: 'Confirming your buy-in…', tone: 'queue' };
    if (isPendingMatch) {
      return poolData?.activeMatchSet
        ? { label: 'MATCH LOCKED', detail: 'Building your table — delegating seats to the dealer…', tone: 'match' }
        : { label: 'PLACING YOU', detail: watchdogDetail, tone: 'match' };
    }
    if (isInPool) {
      if (recentlyRequeued) {
        return { label: 'BACK IN QUEUE', detail: 'That round seated other players. You kept your spot and are re-queued for the next match.', tone: 'queue' };
      }
      if (queueFull) {
        return poolData?.activeMatchSet
          ? { label: 'MATCH LOCKED', detail: 'Selecting your table…', tone: 'match' }
          : { label: 'POOL FULL', detail: cooldownLeft > 0 ? `Locking the table in ${cooldownLeft}s · you're in` : 'Finalizing match…', tone: 'match' };
      }
      return { label: 'IN THE QUEUE', detail: `${queueCount}/${seats} seats filled · others are joining`, tone: 'queue' };
    }
    return null;
  })();

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/80 backdrop-blur-md" onClick={close} />
      <div className="relative mx-4 my-6 w-[560px] max-w-[calc(100vw-32px)] fade-in">
        {/* Height-capped flex column: header/payouts/opt-in/footer are shrink-0,
            the join-flow body scrolls. dvh (with vh fallback) keeps the footer
            on-screen in mobile webviews (Phantom) where vh overshoots the
            visible area and clips the CONFIRM JOIN button off the bottom. */}
        <div className="glass-room overflow-hidden flex flex-col max-h-[88vh]" style={{ maxHeight: '88dvh' }}>
          <div className="px-5 py-3.5 hairline-b flex items-start justify-between gap-3 shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-0.5 h-9 rounded-full" style={{ background: tierColor }} />
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] tracking-[0.25em] leading-none" style={{ color: tierColor }}>{tierName}</span>
                  <span className="text-boneDim/30 text-[10px]">·</span>
                  <span className="font-mono text-[10px] text-boneDim/70 tracking-wider">SNG POOL</span>
                </div>
                <div className="font-display text-bone text-xl mt-0.5 leading-none">{format.name}</div>
              </div>
            </div>
            <button onClick={close} className="text-boneDim hover:text-bone transition text-2xl -mt-1 leading-none">&times;</button>
          </div>

          <div className="px-5 py-3 hairline-b grid grid-cols-3 gap-3 shrink-0">
            <div>
              <Eyebrow>Buy-in &middot; SOL</Eyebrow>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="font-display text-bone text-xl tabular-nums leading-none inline-flex items-center gap-1"><SolIcon size={14} /> {fmtSol(totalJoinSol)}</span>
              </div>
              <span className="font-mono text-[9px] text-boneDim/50 tabular-nums">{fmtSol(entrySol)} entry + {fmtSol(feeSol)} fee{siteFeeSol > 0 ? ` + ${fmtSol(siteFeeSol)} site${siteFeeDesc ? ` (${siteFeeDesc})` : ''}` : ''}{miniOptIn ? ` + ${fmtSol(miniAddonSol)} Lucky` : ''}</span>
            </div>
            <div>
              <Eyebrow>Prize pool</Eyebrow>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="font-display text-gold text-xl tabular-nums leading-none inline-flex items-center gap-1"><SolIcon size={14} /> {fmtSol(solPool)}</span>
              </div>
              {pokerPool > 0 && <span className="font-mono text-[9px] text-amber/80 tabular-nums inline-flex items-center gap-1">+ {fmtFP(pokerPool)} <TokenIcon mint={POKER_MINT.toBase58()} size={9} alt="$FP" /> $FP</span>}
            </div>
            <div>
              <Eyebrow>Payouts</Eyebrow>
              <div className="mt-1 flex flex-col gap-0.5">
                {pokerPayouts.map((pPct, i) => {
                  const sPct = solPayouts[i] ?? 0;
                  if (pPct === 0 && sPct === 0) return null;
                  return (
                    <div key={i} className="font-mono text-[10px] tabular-nums leading-tight">
                      <span className="text-boneDim/60 uppercase">{place(i)}</span>
                      <span className="text-boneDim/30 mx-1">·</span>
                      {solPool > 0 && sPct > 0 && (
                        <span className="text-gold inline-flex items-center gap-0.5">
                          <SolIcon size={10} />{fmtSol(solPool * sPct / 100)}
                        </span>
                      )}
                      {pokerPool > 0 && pPct > 0 && (
                        <span className="text-amber/80 ml-1 inline-flex items-center gap-0.5">
                          +{fmtFP(pokerPool * pPct / 100)} <TokenIcon mint={POKER_MINT.toBase58()} size={9} alt="$FP" />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {canConfirmJoin && (
            <label className="px-5 py-2 hairline-b flex items-center justify-between gap-3 cursor-pointer hover:bg-bone/5 transition shrink-0">
              <span className="min-w-0">
                <span className="block font-mono text-[10px] tracking-[0.18em] text-gold">{LUCKY_JACKPOT_NAME.toUpperCase()}</span>
                <span className="block font-mono text-[9px] text-boneDim/60">+{fmtSol(miniAddonSol)} SOL. Refunded if you leave queued; funds Lucky only after seating.</span>
                <span className="block font-mono text-[8px] text-boneDim/45 mt-0.5" title={`${ROYAL_JACKPOT_NAME} pays ${RAW_YIELD_NAME}. Claim All pays ${RAW_YIELD_NAME} and $FP together.`}>{ROYAL_JACKPOT_NAME} stays on either way. Your weight: {grandFormatWeight} format x {grandTierWeight} tier.</span>
              </span>
              <input
                type="checkbox"
                checked={miniOptIn}
                onChange={e => { setMiniOptIn(e.target.checked); writeLuckyJackpotPref(e.target.checked); }}
                className="h-4 w-4 accent-[#F2B84B]"
              />
            </label>
          )}

          {joinTemporarilyDisabled && (
            <div className="px-5 py-2 hairline-b flex items-center justify-between gap-3 shrink-0 bg-bone/[0.03]">
              <span className="font-mono text-[10px] tracking-[0.18em] text-boneDim font-bold">{SNG_DISABLED_LABEL}</span>
              <span className="font-mono text-[9px] text-boneDim/60 text-right">{format.name} {tierName} entries are paused.</span>
            </div>
          )}

          <div className="px-5 py-3 grow overflow-y-auto min-h-0">
            <Eyebrow>Join flow &middot; on-chain</Eyebrow>
            <div className="mt-2 space-y-0">
              {SNG_JOIN_STEPS.map((s, i) => {
                const done = i < stepIdx;
                const active = i === stepIdx;
                const pending = i > stepIdx;
                return (
                  <div key={s.id} className={cx('flex gap-3 py-1.5 transition', pending && 'opacity-40')}>
                    <div className="flex flex-col items-center">
                      <div className={cx('w-6 h-6 rounded-full flex items-center justify-center transition',
                        done && 'bg-emerald-400/20 border border-emerald-400/60 text-emerald-400',
                        active && 'bg-gold/20 border border-gold/70 text-gold animate-pulse',
                        pending && 'border border-boneDim/20 text-boneDim/40')}>
                        {done ? (
                          <svg className="w-3 h-3" viewBox="0 0 12 12">
                            <path d="M2 6l3 3 5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <span className="font-mono text-[10px] tabular-nums">{i + 1}</span>
                        )}
                      </div>
                      {i < SNG_JOIN_STEPS.length - 1 && (
                        <div className={cx('w-px flex-1 min-h-[8px] my-0.5', done ? 'bg-emerald-400/30' : 'bg-boneDim/10')} />
                      )}
                    </div>
                    <div className="pb-1 flex-1">
                      <div className={cx('font-display text-sm leading-tight', done ? 'text-bone/70' : active ? 'text-bone' : 'text-boneDim/70')}>{s.title}</div>
                      <div className="font-mono text-[10px] text-boneDim/60 tracking-wide mt-0.5">{s.desc}</div>
                      {s.id === 'queue' && active && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <div className="flex-1 max-w-[240px] h-1 rounded-full overflow-hidden" style={{ background: `${tierColor}22` }}>
                            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(queueCount / seats) * 100}%`, background: tierColor }} />
                          </div>
                          <span className="font-mono text-[10px] tabular-nums text-bone">{queueCount}/{seats}</span>
                        </div>
                      )}
                      {s.id === 'cool' && active && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
                          <span className="font-mono text-[10px] text-amber">{placement?.detail ?? 'Matching…'}</span>
                        </div>
                      )}
                      {s.id === 'seat' && active && (
                        <div className="mt-1 font-mono text-[10px] text-emerald-400 tracking-wider">TABLE DELEGATED &middot; REDIRECTING...</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="px-4 sm:px-5 py-3 hairline-t flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 shrink-0">
            <span className="font-mono text-[9px] tracking-wider shrink-0 min-w-0">
              {placement ? (
                <span className="flex flex-col leading-tight gap-0.5">
                  <span className={
                    placement.tone === 'seat' ? 'text-emerald-300 font-bold tracking-[0.18em]'
                    : placement.tone === 'match' ? 'text-amber font-bold tracking-[0.18em]'
                    : 'text-orange/90 font-bold tracking-[0.18em]'
                  }>{placement.label}</span>
                  <span className="text-boneDim/60 normal-case tracking-normal text-[10px]">{placement.detail}</span>
                </span>
              ) : 'READY'}
            </span>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              {canConfirmJoin && (
                <>
                  <button onClick={close} className="shrink-0 px-4 py-2 sm:py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] text-boneDim hover:text-bone hairline">CANCEL</button>
                  <button onClick={confirmJoin} disabled={!!isJoining} className="btn-orange flex-1 sm:flex-none px-3 sm:px-5 py-2 sm:py-1.5 rounded-sm font-mono text-[10px] tracking-[0.2em] font-bold disabled:opacity-40">
                    {isJoining ? 'SIGNING...' : (<span className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap">CONFIRM JOIN <span className="opacity-50">·</span> <SolIcon size={11} /> {fmtSol(totalJoinSol)}</span>)}
                  </button>
                </>
              )}
              {joinTemporarilyDisabled && (
                <>
                  <button onClick={close} className="shrink-0 px-4 py-2 sm:py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] text-boneDim hover:text-bone hairline">CLOSE</button>
                  <button disabled className="flex-1 sm:flex-none px-4 py-2 sm:py-1.5 rounded-sm font-mono text-[10px] tracking-[0.2em] font-bold border border-boneDim/25 bg-bone/[0.04] text-boneDim/60 cursor-not-allowed">{SNG_DISABLED_LABEL}</button>
                </>
              )}
              {isPendingMatch && (
                <>
                  <button onClick={close} className="shrink-0 px-3 py-2 sm:py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] text-boneDim hover:text-bone hairline">CLOSE</button>
                  <button disabled className="flex-1 sm:flex-none px-4 py-2 sm:py-1.5 rounded-sm font-mono text-[10px] tracking-[0.2em] font-bold border border-amber/40 bg-amber/10 text-amber cursor-wait">MATCHING...</button>
                </>
              )}
              {isInPool && !myMatchedTablePda && (
                <>
                  <button onClick={close} className="flex-1 sm:flex-none px-3 py-2 sm:py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] text-boneDim hover:text-bone hairline">KEEP IN QUEUE</button>
                  <button onClick={leaveQueue} disabled={!!isLeaving} className="shrink-0 px-3 py-2 sm:py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] text-red-300/80 hover:text-red-300 border border-red-400/20 hover:border-red-400/50 disabled:opacity-40">
                    {isLeaving ? 'LEAVING...' : 'LEAVE · REFUND'}
                  </button>
                </>
              )}
              {myMatchedTablePda && (
                <button onClick={toTable} className="btn-orange w-full sm:w-auto px-5 py-2 sm:py-1.5 rounded-sm font-mono text-[10px] tracking-[0.2em] font-bold">TO TABLE</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SNG Filter Bar (format pills + tier chips + activity + my queue) ───
interface SngFilter {
  formats: ('heads_up' | '6max' | '9max')[];
  tiers: number[];
  active: boolean;
  myQueue: boolean;
}

// Slim companion bar for SizeInPlayToMint - keeps view toggle, HAS ACTIVITY,
// MY QUEUE indicator, CLEAR, and totals; format/tier responsibility moved to widget.
function SngFilterSlimRow({
  filter, setFilter, totals, queuedCount, viewMode, setViewMode,
}: {
  filter: SngFilter;
  setFilter: (f: SngFilter | ((f: SngFilter) => SngFilter)) => void;
  totals: string;
  queuedCount: number;
  viewMode: 'card' | 'list';
  setViewMode: (v: 'card' | 'list') => void;
}) {
  const clear = () => setFilter({ formats: [], tiers: [], active: false, myQueue: false });
  const hasAny = filter.formats.length || filter.tiers.length || filter.active || filter.myQueue;

  return (
    <div className="flex items-center gap-2 py-2 flex-wrap">
      <button
        onClick={() => { SFX.play('ui-toggle'); setFilter(f => ({ ...f, active: !f.active })); }}
        className={cx(
          'px-2.5 py-1 rounded-sm font-mono text-[10px] tracking-wider border transition',
          filter.active
            ? 'border-emerald-400/70 bg-emerald-400/10 text-emerald-400'
            : 'border-gold/15 text-boneDim hover:border-gold/40 hover:text-bone',
        )}
      >
        HAS ACTIVITY
      </button>

      {queuedCount > 0 && (
        <button
          onClick={() => { SFX.play('ui-toggle'); setFilter(f => ({ ...f, myQueue: !f.myQueue })); }}
          className={cx(
            'px-2.5 py-1 rounded-sm font-mono text-[10px] tracking-wider border transition inline-flex items-center gap-1.5',
            filter.myQueue ? 'border-gold bg-gold/20 text-gold' : 'border-gold/30 text-gold/80 hover:border-gold',
          )}
        >
          <span className="w-1 h-1 rounded-full bg-gold animate-pulse" />
          MY QUEUE - {queuedCount}
        </button>
      )}

      {hasAny && (
        <button onClick={clear} className="px-2 py-1 font-mono text-[10px] tracking-wider text-boneDim/60 hover:text-bone">
          CLEAR
        </button>
      )}

      <span className="ml-auto font-mono text-[10px] text-boneDim/50 tracking-wider">{totals}</span>

      <div className="hidden md:flex items-center ml-2">
        <button
          onClick={() => { SFX.play('ui-tap'); setViewMode('card'); }}
          className={cx(
            'p-1.5 rounded-l-sm border hairline',
            viewMode === 'card' ? 'bg-gold/15 border-gold/50 text-gold' : 'text-boneDim/60 hover:text-bone',
          )}
          title="Card view"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="1" y="1" width="5" height="5" rx="0.5"/><rect x="8" y="1" width="5" height="5" rx="0.5"/>
            <rect x="1" y="8" width="5" height="5" rx="0.5"/><rect x="8" y="8" width="5" height="5" rx="0.5"/>
          </svg>
        </button>
        <button
          onClick={() => { SFX.play('ui-tap'); setViewMode('list'); }}
          className={cx(
            'p-1.5 rounded-r-sm border border-l-0 hairline',
            viewMode === 'list' ? 'bg-gold/15 border-gold/50 text-gold' : 'text-boneDim/60 hover:text-bone',
          )}
          title="List view"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <line x1="1" y1="3.5" x2="13" y2="3.5"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="1" y1="10.5" x2="13" y2="10.5"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

function SngFilterBar({
  filter, setFilter, totals, queuedCount, viewMode, setViewMode,
}: {
  filter: SngFilter;
  setFilter: (f: SngFilter | ((f: SngFilter) => SngFilter)) => void;
  totals: string;
  queuedCount: number;
  viewMode: 'card' | 'list';
  setViewMode: (v: 'card' | 'list') => void;
}) {
  const toggleFormat = (k: 'heads_up' | '6max' | '9max') => {
    SFX.play('ui-tap');
    setFilter(f => ({ ...f, formats: f.formats.includes(k) ? f.formats.filter(x => x !== k) : [...f.formats, k] }));
  };
  const toggleTier = (tierId: number) => {
    SFX.play('ui-tap');
    setFilter(f => ({ ...f, tiers: f.tiers.includes(tierId) ? f.tiers.filter(x => x !== tierId) : [...f.tiers, tierId] }));
  };
  const clear = () => setFilter({ formats: [], tiers: [], active: false, myQueue: false });
  const hasAny = filter.formats.length || filter.tiers.length || filter.active || filter.myQueue;

  return (
    <div className="flex items-center gap-2 py-2 flex-wrap">
      <Eyebrow className="mr-1">Format</Eyebrow>
      {FORMAT_META.map(f => {
        const on = filter.formats.includes(f.key);
        return (
          <button
            key={f.key}
            onClick={() => toggleFormat(f.key)}
            className={cx(
              'px-2.5 py-1 rounded-sm font-mono text-[10px] tracking-wider border transition inline-flex items-center gap-1',
              on ? 'border-gold/70 bg-gold/15 text-gold' : 'border-gold/15 text-boneDim hover:border-gold/40 hover:text-bone',
            )}
          >
            {on && <span className="text-gold leading-none">✓</span>}
            {f.name}
          </button>
        );
      })}

      <div className="h-4 w-px bg-gold/15 mx-1" />
      <Eyebrow className="mr-1">Tier</Eyebrow>
      {TIERS.map((t) => {
        const tierId = t.id as number;
        const on = filter.tiers.includes(tierId);
        const color = TIER_COLORS[tierId] ?? '#F26A1F';
        return (
          <button
            key={tierId}
            onClick={() => toggleTier(tierId)}
            className={cx(
              'px-2 py-1 rounded-sm font-mono text-[10px] tracking-wider border transition inline-flex items-center gap-1',
              on ? 'bg-gold/15' : 'hover:border-gold/40',
            )}
            style={on
              ? { borderColor: color, color }
              : { borderColor: `${color}40`, color: `${color}c0` }
            }
          >
            {on && <span className="leading-none" style={{ color }}>✓</span>}
            {t.name}
          </button>
        );
      })}

      <div className="h-4 w-px bg-gold/15 mx-1" />
      <button
        onClick={() => { SFX.play('ui-toggle'); setFilter(f => ({ ...f, active: !f.active })); }}
        className={cx(
          'px-2.5 py-1 rounded-sm font-mono text-[10px] tracking-wider border transition',
          filter.active
            ? 'border-emerald-400/70 bg-emerald-400/10 text-emerald-400'
            : 'border-gold/15 text-boneDim hover:border-gold/40 hover:text-bone',
        )}
      >
        HAS ACTIVITY
      </button>

      {queuedCount > 0 && (
        <button
          onClick={() => { SFX.play('ui-toggle'); setFilter(f => ({ ...f, myQueue: !f.myQueue })); }}
          className={cx(
            'px-2.5 py-1 rounded-sm font-mono text-[10px] tracking-wider border transition inline-flex items-center gap-1.5',
            filter.myQueue ? 'border-gold bg-gold/20 text-gold' : 'border-gold/30 text-gold/80 hover:border-gold',
          )}
        >
          <span className="w-1 h-1 rounded-full bg-gold animate-pulse" />
          MY QUEUE - {queuedCount}
        </button>
      )}

      {hasAny && (
        <button onClick={clear} className="px-2 py-1 font-mono text-[10px] tracking-wider text-boneDim/60 hover:text-bone">
          CLEAR
        </button>
      )}

      <span className="ml-auto font-mono text-[10px] text-boneDim/50 tracking-wider">{totals}</span>

      <div className="hidden md:flex items-center ml-2">
        <button
          onClick={() => { SFX.play('ui-tap'); setViewMode('card'); }}
          className={cx(
            'p-1.5 rounded-l-sm border hairline',
            viewMode === 'card' ? 'bg-gold/15 border-gold/50 text-gold' : 'text-boneDim/60 hover:text-bone',
          )}
          title="Card view"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="1" y="1" width="5" height="5" rx="0.5"/><rect x="8" y="1" width="5" height="5" rx="0.5"/>
            <rect x="1" y="8" width="5" height="5" rx="0.5"/><rect x="8" y="8" width="5" height="5" rx="0.5"/>
          </svg>
        </button>
        <button
          onClick={() => { SFX.play('ui-tap'); setViewMode('list'); }}
          className={cx(
            'p-1.5 rounded-r-sm border border-l-0 hairline',
            viewMode === 'list' ? 'bg-gold/15 border-gold/50 text-gold' : 'text-boneDim/60 hover:text-bone',
          )}
          title="List view"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <line x1="1" y1="3.5" x2="13" y2="3.5"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="1" y1="10.5" x2="13" y2="10.5"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// Below the `md` breakpoint (768px) the lobby only offers the card view for
// every game type (cash already does this); the list/row table is desktop-only.
function useLobbyIsMobile(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia('(max-width: 767px)');
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia('(max-width: 767px)').matches,
    () => false,
  );
}

// ─── SNG Section ───
function SngSection({
  queues, selectedTier, activeTier, onResume,
  publicKey: myKey, sngPools,
  onJoinPool, onLeavePool, joiningPool, leavingPool, myActiveGames,
  poolState, filter, setFilter, totals, queuedCount, onOpenModal,
}: {
  queues: SitNGoQueue[];
  selectedTier: SnGTier;
  /** The tier actually displayed · reflects filter selection, falls back to selectedTier */
  activeTier: number;
  onResume: (pda: string) => void;
  publicKey: string;
  sngPools?: SngPool[];
  onJoinPool?: (gameType: number, tier: number, miniOptIn?: boolean) => void;
  onLeavePool?: (gameType: number, tier: number) => void;
  joiningPool?: string | null;
  leavingPool?: string | null;
  myActiveGames: SitNGoQueue[];
  poolState: PoolState;
  filter: SngFilter;
  setFilter: (f: SngFilter | ((f: SngFilter) => SngFilter)) => void;
  totals: string;
  queuedCount: number;
  onOpenModal?: (gameType: number, tier: number, autoStart?: boolean, defaultMini?: boolean, rejoin?: boolean) => void;
}) {
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  // Mobile only offers the card view (the list/row table is desktop-only for
  // SNG + mint, matching cash). The toggle is hidden below md, but force the
  // effective mode here too so a previously-selected 'list' can't leak through.
  const lobbyIsMobile = useLobbyIsMobile();
  const effectiveViewMode = lobbyIsMobile ? 'card' : viewMode;

  // Live emission state for the SizeInPlayToMint widget. Mirrors EmissionsStrip
  // wiring (usePoolHealth + usePokerSupply) plus per-format current rates from
  // @/lib/emission. Burn delta/ago stay mocked until indexer surfaces 24h aggregates.
  const _pool = usePoolHealth();
  const _supply = usePokerSupply();
  const widgetEmission = useMemo(() => {
    const ONE_WHOLE_BASE = BigInt(1_000_000_000);
    const netBase = BigInt(Math.max(0, Math.floor(poolState.circulatingSupply))) * ONE_WHOLE_BASE;
    const emissionTier = filter.tiers.length === 1 ? filter.tiers[0] : activeTier;
    const boostPct = decayMultiplierBps(netBase) / 100;
    const currentFp = {
      'HU': Number(calculateSngEmissionPerSeat(EmissionFormat.HU, netBase, emissionTier)) / 1_000_000,
      '6-Max': Number(calculateSngEmissionPerSeat(EmissionFormat.Six, netBase, emissionTier)) / 1_000_000,
      '9-Max': Number(calculateSngEmissionPerSeat(EmissionFormat.Nine, netBase, emissionTier)) / 1_000_000,
    } as const;
    const totalBurned = _pool.totalPoolStaked;
    const everMinted = _supply.wholeSupply + totalBurned;
    const burnPct = everMinted > 0 ? (totalBurned / everMinted) * 100 : 0;
    return {
      boostPct,
      currentFp,
      burn: { pct: burnPct, delta: '−0.06', ago: '12s' },
    };
  }, [poolState.circulatingSupply, filter.tiers, activeTier, _pool.totalPoolStaked, _supply.wholeSupply]);

  // Group queues by tier, ordering formats HU → 6max → 9max per row (mockup gold pattern)
  const tierGroups = useMemo(() => {
    return TIERS.map(t => {
      const tierId = t.id as number;
      if (filter.tiers.length > 0 && !filter.tiers.includes(tierId)) return null;
      const tierQueues = FORMAT_META
        .map(f => queues.find(q => (q.tier ?? 0) === tierId && q.type === f.key))
        .filter(Boolean) as SitNGoQueue[];
      if (tierQueues.length === 0) return null;
      return { tier: t, tierId, tierQueues };
    }).filter(Boolean) as Array<{ tier: typeof TIERS[0]; tierId: number; tierQueues: SitNGoQueue[] }>;
  }, [queues, filter.tiers]);

  // Bridges between SizeInPlayToMint (single-select) and SngFilter (multi-select arrays).
  // Multi-select state can't round-trip through the widget - fall back to ANY when >1.
  const widgetTier: number | null = filter.tiers.length === 1 ? (filter.tiers[0] as number) : null;
  const widgetFormat: 'HU' | '6-Max' | '9-Max' | null = filter.formats.length === 1
    ? (filter.formats[0] === 'heads_up' ? 'HU' : filter.formats[0] === '6max' ? '6-Max' : '9-Max')
    : null;
  const onWidgetTierChange = (n: number | null) => setFilter(f => ({ ...f, tiers: n === null ? [] : [n] }));
  const onWidgetFormatChange = (f: 'HU' | '6-Max' | '9-Max' | null) => setFilter(prev => ({
    ...prev,
    formats: f === null ? [] : [f === 'HU' ? 'heads_up' as const : f === '6-Max' ? '6max' as const : '9max' as const],
  }));

  // Quick Play: route through SngJoinModal with autoStart=true so the user gets
  // the same UX as the card flow - wallet prompts to pay, modal stays open as a
  // status display, and if they cancel the wallet prompt the modal exposes a
  // JOIN button to retry. ANY tier/format = consider all pools. If no live pool
  // matches the requested (gameType, tier), we still open the modal so the
  // on-chain join bootstraps the pool PDA (it's PDA-derived, not "must exist
  // beforehand"). Defaults: HU + Bronze = fastest fill.
  const onQuickPlay = useCallback((luckyOptIn: boolean = false) => {
    if (!onOpenModal) return;
    const wantedGameType: number | null =
      widgetFormat === 'HU' ? 0
      : widgetFormat === '6-Max' ? 1
      : widgetFormat === '9-Max' ? 2
      : null;
    const wantedTier: number | null = widgetTier;

    let pickedGt: number | null = null;
    let pickedTier: number | null = null;

    if (wantedGameType !== null && wantedTier !== null && isSngPoolTemporarilyDisabled(wantedGameType, wantedTier)) {
      toast('9-Max Bronze is currently disabled.');
      return;
    }

    if (sngPools && sngPools.length > 0) {
      const matching = sngPools.filter(p => {
        if (isSngPoolTemporarilyDisabled(p.gameType, p.tier)) return false;
        if (wantedTier !== null && p.tier !== wantedTier) return false;
        if (wantedGameType !== null && p.gameType !== wantedGameType) return false;
        return true;
      });
      if (matching.length > 0) {
        const seatsByGt = (gt: number) => gt === 0 ? 2 : gt === 1 ? 6 : 9;
        const open = matching.filter(p => !p.queue.includes(myKey));
        const pool = (open.length > 0 ? open : matching).reduce((a, b) => {
          const aFill = a.queueCount / seatsByGt(a.gameType);
          const bFill = b.queueCount / seatsByGt(b.gameType);
          return bFill > aFill ? b : a;
        });
        pickedGt = pool.gameType;
        pickedTier = pool.tier;
      }
    }

    // No live matching pool - bootstrap. ANY/ANY => HU + Bronze.
    if (pickedGt === null || pickedTier === null) {
      pickedGt = wantedGameType ?? 0;   // HU
      pickedTier = wantedTier ?? 1;     // Bronze
    }

    if (isSngPoolTemporarilyDisabled(pickedGt, pickedTier)) {
      toast('9-Max Bronze is currently disabled.');
      return;
    }

    console.log('[QuickPlay] opening join modal (autoStart)', { gameType: pickedGt, tier: pickedTier, luckyOptIn });
    onOpenModal(pickedGt, pickedTier, true, luckyOptIn);
  }, [sngPools, widgetTier, widgetFormat, onOpenModal, myKey]);

  // Disabled when there's no modal-open handler wired (i.e. while the page is
  // still mounting), OR while a pool join is already in flight so the CTA can't
  // be re-fired during the (headless on Privy) auth + join. Empty/missing pools
  // no longer block Quick Play - see above.
  const quickPlayDisabled = !onOpenModal || !!joiningPool;

  // Live player counts per format - drives the LED bar fill on each table-size pill.
  // Sums queueCount across pools matching the selected tier (or all tiers when ANY).
  const playersByFormat = useMemo(() => {
    const counts: Record<'HU' | '6-Max' | '9-Max', number> = { 'HU': 0, '6-Max': 0, '9-Max': 0 };
    if (!sngPools) return counts;
    for (const p of sngPools) {
      if (widgetTier !== null && p.tier !== widgetTier) continue;
      const fmt: 'HU' | '6-Max' | '9-Max' = p.gameType === 0 ? 'HU' : p.gameType === 1 ? '6-Max' : '9-Max';
      counts[fmt] += p.queueCount;
    }
    return counts;
  }, [sngPools, widgetTier]);

  // List view · flat sorted list across all visible tiers
  if (effectiveViewMode === 'list') {
    const allQueues = tierGroups.flatMap(g => g.tierQueues);
    return (
      <section className="mt-4 space-y-3">
        <SizeInPlayToMint
          selectedTier={widgetTier}
          onTierChange={onWidgetTierChange}
          selectedFormat={widgetFormat}
          onFormatChange={onWidgetFormatChange}
          matchCount={allQueues.length}
          boostPct={widgetEmission.boostPct}
          currentFp={widgetEmission.currentFp}
          burn={widgetEmission.burn}
          onQuickPlay={onQuickPlay}
          quickPlayDisabled={quickPlayDisabled}
          playersByFormat={playersByFormat}
        />
        <div className="px-4">
          <SngFilterSlimRow
            filter={filter} setFilter={setFilter} totals={totals} queuedCount={queuedCount}
            viewMode={viewMode} setViewMode={setViewMode}
          />
        </div>
        <div className="px-4">
        <div className="glass-room overflow-hidden">
          <div className="overflow-x-auto">
            <div className="min-w-[720px]">
              <div className="grid grid-cols-[1.4fr_90px_80px_1fr_160px_80px] gap-3 px-3 py-1.5 hairline-b">
                <span className="eyebrow">Pool</span>
                <span className="eyebrow">Tier</span>
                <span className="eyebrow">Fmt</span>
                <span className="eyebrow">Queue</span>
                <span className="eyebrow">Prize</span>
                <span />
              </div>
              {allQueues.map((queue, idx) => {
                const gameTypeIndex = queue.type === 'heads_up' ? 0 : queue.type === '6max' ? 1 : 2;
                const qTier = queue.tier ?? 0;
                const tierColor = TIER_COLORS[qTier] ?? '#F26A1F';
                const tierName = TIER_NAMES[qTier] ?? 'POOL';
                const poolData = sngPools?.find(p => p.gameType === gameTypeIndex && p.tier === qTier);
                const isInPool = poolData ? poolData.queue.includes(myKey) : false;
                const fillCount = poolData ? poolData.queueCount : (queue.onChainPlayers ?? queue.currentPlayers);
                const spots = queue.maxPlayers;
                const fillPct = Math.min(fillCount / spots, 1);
                const solPool = poolData ? (poolData.entryAmount * spots) / 1e9 : 0;
                const _fmt = spots === 2 ? EmissionFormat.HU : spots === 6 ? EmissionFormat.Six : EmissionFormat.Nine;
                const pokerPool = poolData
                  ? Number(calculateSngPoolUnrefined(_fmt, spots, BigInt(0), qTier)) / 1_000_000
                  : 0;
                const avgFillTime = `~${Math.max(10, 60 - fillCount * 8)}s fill`;
                return (
                  <div
                    key={queue.id}
                    className={cx(
                      'grid grid-cols-[1.4fr_90px_80px_1fr_160px_80px] gap-3 items-center px-3 py-2 hairline-b transition',
                      isInPool ? 'bg-gold/[0.08]' : 'hover:bg-gold/[0.04]',
                    )}
                    style={{ animationDelay: `${idx * 40}ms` }}
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-0.5 h-6 rounded-full" style={{ background: tierColor }} />
                      <span className="font-display text-bone text-sm leading-none">{tierName} {queue.type === 'heads_up' ? 'Heads-Up' : queue.type === '6max' ? '6-Max' : '9-Max'}</span>
                    </div>
                    <span className="font-mono text-[9px] tracking-wider" style={{ color: tierColor }}>{tierName}</span>
                    <span className="font-mono text-[10px] text-boneDim/80 tabular-nums">{spots}p</span>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1 rounded-full overflow-hidden bg-gold/10 max-w-[100px]">
                        <div className="h-full rounded-full" style={{ width: `${fillPct * 100}%`, background: tierColor }} />
                      </div>
                      <span className="font-mono text-[9px] text-boneDim/60 tabular-nums">{avgFillTime}</span>
                      <span className="font-mono text-[10px] text-boneDim/70 tabular-nums">{fillCount}/{spots}</span>
                    </div>
                    <div className="flex items-center gap-1 flex-wrap">
                      {solPool > 0 && <span className="font-mono text-[11px] text-gold tabular-nums inline-flex items-center gap-1"><SolIcon size={11} /> {fmtSol(solPool)}</span>}
                      {pokerPool > 0 && <span className="font-mono text-[10px] text-amber tabular-nums inline-flex items-center gap-1">+{fmtFP(pokerPool)} <TokenIcon mint={POKER_MINT.toBase58()} size={10} alt="$FP" /> $FP</span>}
                    </div>
                    <SngPoolCard
                      key={`btn-${queue.id}`}
                      queue={queue}
                      selectedTier={qTier}
                      publicKey={myKey}
                      poolData={poolData}
                      onResume={onResume}
                      onJoinPool={onJoinPool}
                      onLeavePool={onLeavePool}
                      joiningPool={joiningPool}
                      leavingPool={leavingPool}
                      myActiveGames={myActiveGames}
                      onOpenModal={onOpenModal}
                      listActionOnly
                    />
                  </div>
                );
              })}
              {allQueues.length === 0 && (
                sngPools === undefined ? (
                  <div className="px-4 py-10 text-center">
                    <div className="w-6 h-6 border-2 border-gold/20 border-t-gold rounded-full animate-spin mx-auto mb-2" />
                    <span className="font-mono text-[10px] text-boneDim/50 tracking-wider">LOADING POOLS...</span>
                  </div>
                ) : (
                  <div className="px-4 py-10 text-center font-mono text-[10px] text-boneDim/50 tracking-wider">NO POOLS MATCH FILTERS</div>
                )
              )}
            </div>
          </div>
        </div>
        </div>
        <p className="px-4 text-boneDim/50 text-[10px] font-mono text-center tracking-wider">
          TABLES AUTO-START WHEN FULL &middot; NEW QUEUE OPENS AUTOMATICALLY
        </p>
        <div className="px-4">
          <SngJackpotRail variant="strip" />
        </div>
      </section>
    );
  }

  // Card view · grouped by tier
  let cardIndex = 0;
  return (
    <section className="mt-4 space-y-3">
      <SizeInPlayToMint
        selectedTier={widgetTier}
        onTierChange={onWidgetTierChange}
        selectedFormat={widgetFormat}
        onFormatChange={onWidgetFormatChange}
        matchCount={tierGroups.length}
        boostPct={widgetEmission.boostPct}
        currentFp={widgetEmission.currentFp}
        burn={widgetEmission.burn}
        onQuickPlay={onQuickPlay}
        quickPlayDisabled={quickPlayDisabled}
        playersByFormat={playersByFormat}
      />
      {/* Mobile: filter keeps its original standalone row. Desktop: moves into
          the active tier-group header (see gi === 0 branch below). */}
      <div className="px-4 md:hidden">
        <SngFilterSlimRow
          filter={filter} setFilter={setFilter} totals={totals} queuedCount={queuedCount}
          viewMode={viewMode} setViewMode={setViewMode}
        />
      </div>

      <div className="px-4 space-y-5">
        {tierGroups.map((g, gi) => {
          const tierColor = TIER_COLORS[g.tierId] ?? '#F26A1F';
          const tierName = (TIER_NAMES[g.tierId] ?? 'POOL').toUpperCase();
          return (
          <section key={g.tierId} className={cx(gi > 0 && 'hairline-t pt-5')}>
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <span
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full"
                style={{
                  background: `linear-gradient(90deg, ${tierColor}1a 0%, ${tierColor}08 100%)`,
                  border: `1px solid ${tierColor}3a`,
                  boxShadow: `inset 0 0 0 1px ${tierColor}10, 0 0 12px ${tierColor}18`,
                }}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: tierColor, boxShadow: `0 0 6px ${tierColor}` }}
                />
                <h3 className="font-display text-sm leading-none tracking-[0.14em] whitespace-nowrap" style={{ color: tierColor }}>
                  {tierName}
                </h3>
                <span className="font-mono text-[9px] text-boneDim/55 tracking-[0.2em] whitespace-nowrap">BUY-IN</span>
              </span>
              {gi === 0 ? (
                <div className="hidden md:block flex-1 min-w-0">
                  <SngFilterSlimRow
                    filter={filter} setFilter={setFilter} totals={totals} queuedCount={queuedCount}
                    viewMode={viewMode} setViewMode={setViewMode}
                  />
                </div>
              ) : (
                <div className="hidden md:block flex-1" />
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {g.tierQueues.map((queue) => {
                const idx = cardIndex++;
                const gameTypeIndex = queue.type === 'heads_up' ? 0 : queue.type === '6max' ? 1 : 2;
                const poolData = sngPools?.find(p => p.gameType === gameTypeIndex && p.tier === g.tierId);
                return (
                  <div key={queue.id} className="fade-in" style={{ animationDelay: `${idx * 40}ms` }}>
                    <SngPoolCard
                      queue={queue}
                      selectedTier={g.tierId}
                      publicKey={myKey}
                      poolData={poolData}
                      onResume={onResume}
                      onJoinPool={onJoinPool}
                      onLeavePool={onLeavePool}
                      joiningPool={joiningPool}
                      leavingPool={leavingPool}
                      myActiveGames={myActiveGames}
                      onOpenModal={onOpenModal}
                    />
                  </div>
                );
              })}
            </div>
          </section>
          );
        })}
        {tierGroups.length === 0 && (
          sngPools === undefined ? (
            <div className="glass-room px-4 py-10 text-center">
              <div className="w-6 h-6 border-2 border-gold/20 border-t-gold rounded-full animate-spin mx-auto mb-2" />
              <span className="font-mono text-[10px] text-boneDim/50 tracking-wider">LOADING POOLS...</span>
            </div>
          ) : (
            <div className="glass-room px-4 py-10 text-center font-mono text-[10px] text-boneDim/50 tracking-wider">NO POOLS MATCH FILTERS</div>
          )
        )}
      </div>

      <p className="px-4 text-boneDim/50 text-[10px] font-mono text-center tracking-wider">
        TABLES AUTO-START WHEN FULL &middot; NEW QUEUE OPENS AUTOMATICALLY
      </p>
      <div className="px-4">
        <SngJackpotRail variant="strip" />
      </div>
    </section>
  );
}

// ─── Cash Table Row ───
function CashTableRow({
  table, onNavigate, onSpectate, isSeated, stats, name, forceCard = false,
}: {
  table: CashTable;
  onNavigate: (pda: string) => void;
  onSpectate: (pda: string) => void;
  isSeated: boolean;
  stats?: TableStats | null;
  /** Player-claimed display name; overrides the auto-generated friendlyName. */
  name?: string | null;
  /** Card view: render only the card layout at every breakpoint. */
  forceCard?: boolean;
}) {
  // Registry-backed resolver (same source as the chips + filter) so a listed SPL
  // table like $HYPE renders its real symbol, not a truncated "98sM…" mint.
  const { symbolFor } = useTokenMeta();
  const symbol = symbolFor(table.tokenMint);
  const tokenTone = symbol === 'SOL' ? 'text-gold' : symbol === '$FP' ? 'text-amber' : 'text-boneDim';
  const filled = table.currentPlayers;
  const seats = table.maxPlayers;
  const full = filled >= seats;
  // SB / BB pair on table cards. The BB-only treatment is reserved for the
  // header range filter inputs (where users type a numeric range).
  const bbStr = formatBigBlind(table.bigBlind, table.decimals);
  const blindsStr = formatBlinds(table.smallBlind, table.bigBlind, table.decimals);
  const pda = table.pubkey;

  const friendlyName = name ? name : `${symbol} ${blindsStr} Table`;

  const NameBlock = (
    <div className="flex items-center gap-2 min-w-0">
      <TokenPill symbol={symbol} size={14} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-display text-bone text-sm leading-none truncate">
            {friendlyName}
          </span>
          {table.isPrivate && (
            <span className="px-1 py-[1px] rounded-sm bg-gold/10 border border-gold/40 font-mono text-[8px] text-gold tracking-wider leading-none">
              PRIVATE
            </span>
          )}
          {isSeated && (
            <span className="px-1 py-[1px] rounded-sm bg-gold/20 border border-gold/60 font-mono text-[8px] text-gold tracking-wider leading-none font-bold">
              SEATED
            </span>
          )}
          {table.boost?.active && (
            <span className="px-1 py-[1px] rounded-sm bg-amber/15 border border-amber/50 font-mono text-[8px] text-amber tracking-wider leading-none font-bold">
              BOOSTED
            </span>
          )}
        </div>
        <div className="font-mono text-[9px] text-boneDim/40 tracking-wider mt-0.5 truncate">
          {pda.slice(0, 6)}...{pda.slice(-4)}
          {table.creator && <span className="ml-2">host {table.creator.slice(0, 6)}...</span>}
        </div>
      </div>
    </div>
  );

  if (forceCard) {
    /* Card view: blinds focal, players highlighted, stats below */
    return (
      <div
        className="fp-sng-card relative overflow-hidden flex flex-col gap-3 min-w-0"
        style={{
          backgroundImage: "url('/brand/play_card_bg.png')",
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          boxShadow: [
            'inset 0 0 60px 12px rgba(0,0,0,0.85)',
            'inset 0 0 120px rgba(0,0,0,0.65)',
            'inset 0 1px 0 rgba(255,255,255,0.10)',
            '0 18px 36px rgba(0,0,0,0.22)',
          ].join(', '),
        }}
      >
        {/* watermark */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.04] select-none">
          <TokenPill symbol={symbol} size={150} />
        </div>

        {/* status badges - PUBLIC/PRIVATE always shows; LIVE retired */}
        <div className="absolute top-1.5 right-1.5 z-10 flex flex-wrap items-center justify-end gap-1 max-w-[62%]">
          {isSeated && (
            <span className="px-1.5 py-[2px] rounded-sm bg-gold/40 border border-gold/75 font-mono text-[8px] text-[#0d1217] tracking-[0.14em] leading-none font-bold">SEATED</span>
          )}
          {table.boost?.active && (
            <span className="px-1.5 py-[2px] rounded-sm bg-amber/35 border border-amber/70 font-mono text-[8px] text-[#0d1217] tracking-[0.14em] leading-none font-bold">BOOSTED</span>
          )}
          {table.isPrivate ? (
            <span className="px-1.5 py-[2px] rounded-sm bg-gold/35 border border-gold/70 font-mono text-[8px] text-[#0d1217] tracking-[0.14em] leading-none font-bold">PRIVATE</span>
          ) : (
            <span className="px-1.5 py-[2px] rounded-sm bg-emerald-400/35 border border-emerald-400/70 font-mono text-[8px] text-[#0d1217] tracking-[0.14em] leading-none font-bold">PUBLIC</span>
          )}
        </div>

        {/* Body: token centered top, blinds focal, stats below */}
        <div
          className="relative flex flex-col flex-1 px-3 pt-2 pb-2"
          style={{ textShadow: '0 1px 1px rgba(0,0,0,1), 0 1px 3px rgba(0,0,0,1), 0 0 4px rgba(0,0,0,0.95)' }}
        >
          {/* Top: format (left) · token (center) · seats (right) */}
          <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2">
            <div className="justify-self-start inline-flex items-baseline gap-1.5 bg-black/75 backdrop-blur-sm border border-white/25 rounded-sm px-3 py-1.5">
              <span className="font-display text-[16px] text-emerald-400 leading-none">{seats === 2 ? 'HU' : seats <= 6 ? '6-Max' : '9-Max'}</span>
            </div>
            <div className="flex justify-center">
              <div style={{ borderRadius: '50%', padding: '2px', background: 'conic-gradient(from 0deg, #F26A1F 0%, #FFC63A 20%, #FF8C00 40%, #FFD700 55%, #F26A1F 70%, #FF6B00 85%, #FFC63A 100%)', boxShadow: '0 0 7px 3px rgba(242,106,31,0.63), 0 0 16px 7px rgba(242,106,31,0.46), 0 0 30px 12px rgba(242,106,31,0.28), 0 0 47px 20px rgba(255,140,0,0.18)' }}>
                <div style={{ borderRadius: '50%', overflow: 'hidden' }}>
                  <TokenPill symbol={symbol} size={44} />
                </div>
              </div>
            </div>
            <div className="justify-self-end inline-flex items-baseline gap-0.5 bg-black/75 backdrop-blur-sm border border-white/25 rounded-sm px-3 py-1.5">
              <span className="font-display text-[16px] tabular-nums text-emerald-400 leading-none">{filled}</span>
              <span className="font-mono text-[9px] text-white/75 leading-none">/{seats} seated</span>
            </div>
          </div>

          {/* Blinds: centered below token */}
          <div className="flex flex-col items-center text-center mt-[8px]">
            <span className="font-display text-[11px] tracking-[0.22em] uppercase text-white leading-none">blinds</span>
            <span className="font-display text-[24px] tabular-nums text-white leading-none" style={{ textShadow: '0 2px 16px rgba(0,0,0,1)' }}>{blindsStr}</span>
            {name && <span className="font-mono text-[8px] tracking-[0.18em] text-white/60 uppercase truncate max-w-[90%] mt-1">{name}</span>}
          </div>

          {/* spacer */}
          <div className="flex-1 min-h-[14px]" />
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/[0.22] bg-black/55 backdrop-blur-sm rounded-sm px-2 pb-1">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="font-mono text-[7px] tracking-[0.16em] uppercase text-white/70 leading-none">avg pot</span>
              <span className="font-mono text-[10px] tabular-nums text-white leading-none truncate" title="24h average final pot">
                {stats && stats.handCount > 0 ? `${(stats.avgPotLamports / 10 ** table.decimals).toFixed(3)}` : <span className="text-white/55">{`·`}</span>}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="font-mono text-[7px] tracking-[0.16em] uppercase text-white/70 leading-none">vpip</span>
              <span className="font-mono text-[10px] tabular-nums text-white leading-none truncate" title="Voluntarily Put $ In Pot (24h)">
                {stats && stats.handCount > 0 ? `${Math.round(stats.vpip * 100)}%` : <span className="text-white/55">{`·`}</span>}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="font-mono text-[7px] tracking-[0.16em] uppercase text-white/70 leading-none">hnd/hr</span>
              <span className="font-mono text-[10px] tabular-nums text-white leading-none truncate" title="Hands per hour (24h)">
                {stats && stats.handCount > 0 ? Math.round(stats.handsPerHour) : <span className="text-white/55">{`·`}</span>}
              </span>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="flex items-stretch gap-2">
          <button
            onClick={() => { SFX.play('ui-click'); onNavigate(pda); }}
            disabled={full}
            className={cx(
              'flex-1 py-[11px] sm:py-[9px] rounded-sm font-display text-[14px] sm:text-[13px] tracking-[0.18em] inline-flex items-center justify-center gap-2 transition',
              full
                ? 'border border-boneDim/20 text-boneDim/40 cursor-not-allowed'
                : 'btn-orange',
            )}
          >
            <span>{full ? 'FULL' : isSeated ? 'RETURN' : 'TAKE A SEAT'}</span>
            {!full && <span className="ml-0.5 text-[18px] leading-none">▸</span>}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); SFX.play('ui-tap'); onSpectate(pda); }}
            className="shrink-0 px-3 flex items-center justify-center rounded-sm font-mono text-[10px] tracking-[0.18em] border border-bone/25 bg-black text-bone hover:border-bone/40 transition"
          >
            SPECTATE
          </button>
        </div>
      </div>
    );
  }

  /* List view row: 7-col grid; horizontal scroll on mobile via parent overflow-x-auto */
  return (
    <div
      className={cx(
        'grid w-full grid-cols-[1fr_110px_110px_80px_70px_80px_180px] gap-3 items-center px-3 py-2 hairline-b text-left transition',
        isSeated ? 'bg-gold/[0.06]' : 'hover:bg-gold/[0.04] group',
      )}
    >
      {NameBlock}
      <div className="flex items-baseline gap-1">
        <span className="font-display text-bone tabular-nums text-sm leading-none">{blindsStr}</span>
        <span className={cx('font-mono text-[9px] tracking-wider', tokenTone)}>{symbol}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] tabular-nums text-bone">{filled}/{seats}</span>
        <div className="flex gap-[2px]">
          {Array.from({ length: seats }).map((_, i) => (
            <span key={i} className={cx('w-1.5 h-3 rounded-[1px]', i < filled ? 'bg-gold' : 'bg-boneDim/15')} />
          ))}
        </div>
      </div>
      <span className="font-mono text-[10px] tabular-nums text-bone" title="24h average final pot">
        {stats && stats.handCount > 0 ? `${(stats.avgPotLamports / 10 ** table.decimals).toFixed(3)}` : <span className="text-boneDim/40">{`·`}</span>}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-bone" title="Voluntarily Put $ In Pot (24h)">
        {stats && stats.handCount > 0 ? `${Math.round(stats.vpip * 100)}%` : <span className="text-boneDim/40">{`·`}</span>}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-bone" title="Hands per hour (24h)">
        {stats && stats.handCount > 0 ? Math.round(stats.handsPerHour) : <span className="text-boneDim/40">{`·`}</span>}
      </span>
      <div className="flex items-center gap-1.5 justify-end">
        <button
          onClick={(e) => { e.stopPropagation(); SFX.play('ui-tap'); onSpectate(pda); }}
          className="px-2 py-1 rounded-sm font-mono text-[10px] tracking-[0.18em] border border-boneDim/25 text-boneDim hover:border-bone/50 hover:text-bone transition"
        >
          SPECTATE
        </button>
        <button
          onClick={() => { SFX.play('ui-click'); onNavigate(pda); }}
          className={cx(
            'px-2.5 py-1 rounded-sm font-mono text-[10px] tracking-[0.18em] transition font-bold',
            full
              ? 'border border-boneDim/20 text-boneDim/40 cursor-not-allowed'
              : isSeated
                ? 'border border-gold bg-gold/25 text-gold'
                : 'btn-orange',
          )}
          disabled={full}
        >
          {full ? 'FULL' : isSeated ? 'RETURN' : 'JOIN'}
        </button>
      </div>
    </div>
  );
}

// CashFilterBar + CashSortMode were retired May 2026. The unified filter row
// in CashLobbyHeader is the single source of truth for cash-tab filters.

// ─── Cash Section ───
//
// Filter state ownership (May 2026 unification): CashSection owns the unified
// `CashFilterState` and passes it as a controlled prop to CashLobbyHeader.
// The header's filter row IS the lobby filter - there is no separate bottom
// CashFilterBar anymore. Token pins, format pills, BB-range entry, and the
// free-text find-table search all live in the header.
//
// Persistence key migration:
//   • v1 (legacy): { search, tokens, seatedOnly, seats, minPlayers, hideFull,
//     sortMode } - left untouched on disk for back-compat.
//   • v2 (new):    CashFilterState - written here, read here on mount with a
//     graceful fall-back to v1 (we map `tokens → pinnedTokens`, `search →
//     search`, `hideFull → !showFull`).
/** Clickable column header for the cash list. `sortKey === null` = static
 *  (Name col), no click. Active column shows an arrow. */
function SortHeader({
  label, sortKey, active, dir, onClick,
}: {
  label: string;
  sortKey: CashSortKey | null;
  active: CashSortKey;
  dir: CashSortDir;
  onClick: (k: CashSortKey) => void;
}) {
  if (sortKey === null) {
    return <span className="eyebrow">{label}</span>;
  }
  const isActive = active === sortKey;
  return (
    <button
      type="button"
      onClick={() => onClick(sortKey)}
      className={cx(
        'eyebrow text-left inline-flex items-center gap-1 hover:text-bone transition',
        isActive && 'text-gold',
      )}
      aria-pressed={isActive}
      title={`Sort by ${label}`}
    >
      <span>{label}</span>
      {isActive && (
        <span className="text-[8px] leading-none">{dir === 'asc' ? '▲' : '▼'}</span>
      )}
    </button>
  );
}

function CashSection({
  tables, loading, onNavigate, onSpectate, seatedPdas, hasMore, loadingMore, onLoadMore,
}: {
  tables: CashTable[];
  loading: boolean;
  onNavigate: (pda: string) => void;
  onSpectate: (pda: string) => void;
  seatedPdas: Set<string>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  // Unified registry resolver — the SAME source the chips, rows, and spotlight use.
  // Using it here (rather than a local getTokenSymbol fallback) makes the filter
  // compute byte-identical symbols to the chips, so favoriting any listed/SPL token
  // matches its tables (no "…" vs "..." fallback drift).
  const { symbolFor } = useTokenMeta();
  const initialFilter = useMemo<CashFilterState>(() => {
    if (typeof window === 'undefined') return DEFAULT_CASH_FILTER;
    try {
      const v4Raw = localStorage.getItem('lobby.cashFilters.v4');
      if (v4Raw) {
        const v4 = JSON.parse(v4Raw);
        return {
          ...DEFAULT_CASH_FILTER,
          ...v4,
          pinnedTokens: Array.isArray(v4?.pinnedTokens) ? v4.pinnedTokens : DEFAULT_CASH_FILTER.pinnedTokens,
          formats: Array.isArray(v4?.formats) ? v4.formats : [],
        };
      }
      const v3Raw = localStorage.getItem('lobby.cashFilters.v3');
      if (v3Raw) {
        const v3 = JSON.parse(v3Raw);
        // v3 predates USDC as a default chip. Inject it once (unless the user
        // had cleared all token filters, which means "show all") so existing
        // users see USDC tables; their choice then persists under the v4 key.
        const pins: string[] = Array.isArray(v3?.pinnedTokens) ? v3.pinnedTokens : DEFAULT_CASH_FILTER.pinnedTokens;
        const withUsdc = (pins.length === 0 || pins.includes('USDC')) ? pins : [...pins, 'USDC'];
        return {
          ...DEFAULT_CASH_FILTER,
          ...v3,
          pinnedTokens: withUsdc,
          formats: Array.isArray(v3?.formats) ? v3.formats : [],
        };
      }
      const v2Raw = localStorage.getItem('lobby.cashFilters.v2');
      if (v2Raw) {
        const v2 = JSON.parse(v2Raw);
        // v2 stored an empty pinnedTokens by default; v3 makes SOL/$FP first-class
        // pins. If the user explicitly added user-tokens we keep them and prepend
        // the defaults so the UI shows them as selected.
        const userPins: string[] = Array.isArray(v2?.pinnedTokens)
          ? v2.pinnedTokens.filter((s: string) => s !== 'SOL' && s !== '$FP' && s !== 'USDC')
          : [];
        return {
          ...DEFAULT_CASH_FILTER,
          ...v2,
          pinnedTokens: ['SOL', '$FP', 'USDC', ...userPins],
          formats: Array.isArray(v2?.formats) ? v2.formats : [],
        };
      }
      const v1Raw = localStorage.getItem('lobby.cashFilters.v1');
      if (v1Raw) {
        const v1 = JSON.parse(v1Raw);
        // Map only what is meaningful in v2; drop sortMode / minPlayers /
        // seatedOnly / seats - those aren't part of the unified shape.
        const pinnedTokens: string[] = Array.isArray(v1?.tokens)
          ? ['SOL', '$FP', 'USDC', ...v1.tokens.filter((t: string) => t !== 'SOL' && t !== '$FP' && t !== 'USDC').slice(0, 4)]
          : DEFAULT_CASH_FILTER.pinnedTokens;
        return {
          ...DEFAULT_CASH_FILTER,
          search: typeof v1?.search === 'string' ? v1.search : '',
          pinnedTokens,
          showFull: v1?.hideFull === false ? true : false,
        };
      }
    } catch {
      /* fall through to defaults */
    }
    return DEFAULT_CASH_FILTER;
  }, []);

  const [filter, setFilter] = useState<CashFilterState>(initialFilter);
  const [visibleCount, setVisibleCount] = useState(40);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  // Persist v2 ONLY. v1 is left in place so users with both clients running
  // (rare, but possible during the rollout) don't lose their old prefs.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('lobby.cashFilters.v4', JSON.stringify(filter));
    } catch {
      /* quota / disabled storage - silently ignore */
    }
  }, [filter]);

  // Reset paging whenever the filter changes (any field).
  useEffect(() => {
    setVisibleCount(40);
  }, [filter]);

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && !loadingMore) onLoadMore();
    }, { rootMargin: '500px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  /**
   * Apply the unified filter to the cash list.
   * - Boosted tables remain excluded (header owns them).
   * - `pinnedTokens` is the allow-list - empty array == no token restriction.
   *   SOL and $FP are first-class entries the user can toggle off.
   * - `formats` empty = ALL.
   * - `search` matches pubkey / creator / token symbol substrings.
   * - `bbMin/bbMax` filter by `bigBlind` in human units (token-units numeric).
   * - `showFull` / `showPrivate` are off by default.
   * Sort: closest-to-fill ASC, tie-break by pot DESC (former 'recommended').
   */
  const filtered = useMemo(() => {
    const q = filter.search.trim().toLowerCase();
    // Active search OVERRIDES the token chips so typing a symbol (e.g. HYPE)
    // matches even while SOL/$FP/USDC are pinned (otherwise the default pins
    // filtered the searched SPL token out before the text match ran).
    const pinnedActive = !q && filter.pinnedTokens.length > 0;
    const formatActive = filter.formats.length > 0;
    const bbMin = filter.bbMin;
    const bbMax = filter.bbMax;
    const minSeats = filter.minSeats;
    const maxSeats = filter.maxSeats;

    const matchesFormat = (t: CashTable, fmts: CashFormat[]): boolean => {
      const label: CashFormat = t.maxPlayers <= 2 ? 'HU' : t.maxPlayers <= 6 ? '6-Max' : '9-Max';
      return fmts.includes(label);
    };

    let list = tables.filter(t => !t.boost?.active);

    if (pinnedActive) {
      const allowed = new Set(filter.pinnedTokens);
      list = list.filter(t => allowed.has(symbolFor(t.tokenMint)));
    }
    if (formatActive) list = list.filter(t => matchesFormat(t, filter.formats));
    if (!filter.showFull) list = list.filter(t => t.currentPlayers < t.maxPlayers);
    if (!filter.showPrivate) list = list.filter(t => !t.isPrivate);
    if (q) {
      list = list.filter(t =>
        t.pubkey.toLowerCase().includes(q) ||
        symbolFor(t.tokenMint).toLowerCase().includes(q) ||
        (t.creator || '').toLowerCase().includes(q),
      );
    }
    if (bbMin !== undefined && !Number.isNaN(bbMin)) {
      list = list.filter(t => (t.bigBlind / 10 ** (t.decimals ?? 9)) >= bbMin);
    }
    if (bbMax !== undefined && !Number.isNaN(bbMax)) {
      list = list.filter(t => (t.bigBlind / 10 ** (t.decimals ?? 9)) <= bbMax);
    }
    if (minSeats !== undefined && !Number.isNaN(minSeats)) {
      list = list.filter(t => t.maxPlayers >= minSeats);
    }
    if (maxSeats !== undefined && !Number.isNaN(maxSeats)) {
      list = list.filter(t => t.maxPlayers <= maxSeats);
    }
    return list;
  }, [tables, symbolFor, filter.pinnedTokens, filter.formats, filter.showFull, filter.showPrivate, filter.search, filter.bbMin, filter.bbMax, filter.minSeats, filter.maxSeats]);

  // De-clutter: show EVERY table that has players, but collapse the EMPTY
  // (0-player) duplicates to a single table per token+blind+size stake. That
  // keeps every active game visible AND every stake joinable (one "start a
  // fresh table" row each) without listing a dozen identical empty tables.
  const collapsed = useMemo(() => {
    const populated: CashTable[] = [];
    const emptyByStake = new Map<string, CashTable>();
    for (const t of filtered) {
      if (t.currentPlayers > 0) { populated.push(t); continue; }
      const key = `${t.tokenMint}|${t.smallBlind}|${t.bigBlind}|${t.maxPlayers}`;
      const cur = emptyByStake.get(key);
      // Stable pick so the surviving empty doesn't flap between renders.
      if (!cur || t.pubkey < cur.pubkey) emptyByStake.set(key, t);
    }
    return [...populated, ...emptyByStake.values()];
  }, [filtered]);

  // Indexer stats: fetch for as much of the list as the endpoint allows
  // (200-PDA cap). One call per 30s; cache shared at the module level.
  const statsPdas = useMemo(() => collapsed.slice(0, 200).map(t => t.pubkey), [collapsed]);
  const { stats: tableStatsByPda } = useTableStats(statsPdas);
  const { names: tableNamesByPda } = useTableNames(statsPdas);

  // Sort the filtered list. Default = closest-to-fill ASC, pot DESC. Column-
  // sort applies a stats-aware compare; tables with no indexer data fall to
  // the end regardless of dir.
  const sorted = useMemo(() => {
    const dir = filter.sortDir === 'desc' ? -1 : 1;
    const list = [...collapsed];
    const key = filter.sortKey;
    if (key === 'fill') {
      // Fullest-first by fill RATIO (not empty-seat count) so a near-full 9-max
      // ranks above a half-full HU. asc (the default) = fullest first; pot breaks ties.
      return list.sort((a, b) => {
        const emptyA = a.maxPlayers > 0 ? 1 - a.currentPlayers / a.maxPlayers : 1;
        const emptyB = b.maxPlayers > 0 ? 1 - b.currentPlayers / b.maxPlayers : 1;
        if (emptyA !== emptyB) return (emptyA - emptyB) * dir;
        return (b.pot - a.pot) * dir;
      });
    }
    if (key === 'stakes') return list.sort((a, b) => (a.bigBlind - b.bigBlind) * dir);
    if (key === 'seats') {
      // Sort by FILL RATIO (occupancy %), not raw capacity — so a 2/6 (33%)
      // ranks above an empty 0/9. Capacity, then pot, break ties. With the
      // default asc dir this puts the fullest table at the top.
      return list.sort((a, b) => {
        const emptyA = a.maxPlayers > 0 ? 1 - a.currentPlayers / a.maxPlayers : 1;
        const emptyB = b.maxPlayers > 0 ? 1 - b.currentPlayers / b.maxPlayers : 1;
        if (emptyA !== emptyB) return (emptyA - emptyB) * dir;
        if (a.maxPlayers !== b.maxPlayers) return (b.maxPlayers - a.maxPlayers) * dir;
        return (b.pot - a.pot) * dir;
      });
    }
    if (key === 'pot') return list.sort((a, b) => (a.pot - b.pot) * dir);
    const valueOf = (t: CashTable): number | null => {
      const s = tableStatsByPda[t.pubkey];
      if (!s || s.handCount === 0) return null;
      if (key === 'avgpot') return s.avgPotLamports;
      if (key === 'vpip') return s.vpip;
      if (key === 'hph') return s.handsPerHour;
      return null;
    };
    return list.sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * dir;
    });
  }, [collapsed, filter.sortKey, filter.sortDir, tableStatsByPda]);

  const visible = sorted.slice(0, visibleCount);

  // Click a header: cycle key → default-dir → flip-dir → off (back to fill).
  const onSortClick = (key: CashSortKey) => {
    const defaultDir: CashSortDir = key === 'stakes' || key === 'seats' ? 'asc' : 'desc';
    if (filter.sortKey !== key) {
      setFilter({ ...filter, sortKey: key, sortDir: defaultDir });
    } else if (filter.sortDir === defaultDir) {
      setFilter({ ...filter, sortDir: defaultDir === 'asc' ? 'desc' : 'asc' });
    } else {
      setFilter({ ...filter, sortKey: 'fill', sortDir: 'asc' });
    }
  };
  // View toggle (ported from the SNG tab). Desktop only - mobile always shows
  // cards (the row layout has too many columns to fit a phone). Default = list
  // (the table-rows view: stakes/seats/avg-pot/VPIP/hnd-hr) on desktop, with the
  // card view available via the toggle.
  const [cashView, setCashView] = useState<'card' | 'list'>('list');
  const loadMoreEl = (visibleCount < collapsed.length || hasMore) ? (
    <div ref={loadMoreRef} className="px-4 py-4 text-center">
      {visibleCount < collapsed.length ? (
        <button
          onClick={() => setVisibleCount(c => c + 40)}
          className="px-3 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] border border-gold/30 text-gold hover:bg-gold/10"
        >
          SHOW MORE
        </button>
      ) : (
        <button
          onClick={onLoadMore}
          disabled={loadingMore}
          className="px-3 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] border border-gold/30 text-gold disabled:opacity-50"
        >
          {loadingMore ? 'LOADING...' : 'LOAD MORE TABLES'}
        </button>
      )}
    </div>
  ) : null;
  const hasAnyFilter =
    filter.pinnedTokens.length > 0 ||
    filter.formats.length > 0 ||
    !!filter.search.trim() ||
    filter.bbMin !== undefined ||
    filter.bbMax !== undefined;

  // min-w-0: this section is a grid item of .fp-lobby-panel; without it
  // non-shrinking card content blows the track wider than the viewport on
  // mobile (keeps all cash cards responsive to the page width).
  return (
    <section className="mt-4 space-y-3 pb-4 min-w-0">
      <CashLobbyHeader
        tables={tables}
        loading={loading}
        onNavigate={onNavigate}
        onSpectate={onSpectate}
        filter={filter}
        setFilter={setFilter}
        stats={tableStatsByPda}
        names={tableNamesByPda}
      />

      {/* Slim row above the cash list - header owns the filters now. */}
      <div className="px-4 flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setFilter({ ...filter, showFull: !filter.showFull })}
          className={cx(
            'px-2 py-[3px] rounded-sm font-mono text-[9px] tracking-[0.18em] uppercase border transition',
            filter.showFull
              ? 'border-gold/55 bg-gold/15 text-gold'
              : 'border-bone/15 bg-bone/4 text-boneDim/65 hover:border-bone/30',
          )}
          aria-pressed={filter.showFull}
          title="Toggle full tables in the list"
        >
          {filter.showFull ? '✓ FULL TABLES' : 'SHOW FULL TABLES'}
        </button>
        <button
          onClick={() => setFilter({ ...filter, showPrivate: !filter.showPrivate })}
          className={cx(
            'px-2 py-[3px] rounded-sm font-mono text-[9px] tracking-[0.18em] uppercase border transition',
            filter.showPrivate
              ? 'border-gold/55 bg-gold/15 text-gold'
              : 'border-bone/15 bg-bone/4 text-boneDim/65 hover:border-bone/30',
          )}
          aria-pressed={filter.showPrivate}
          title="Toggle password-locked private tables in the list"
        >
          {filter.showPrivate ? '✓ PRIVATE GAMES' : 'SHOW PRIVATE GAMES'}
        </button>
        {hasAnyFilter && (
          <button
            onClick={() => setFilter({ ...DEFAULT_CASH_FILTER, showFull: filter.showFull, showPrivate: filter.showPrivate })}
            className="px-2 py-[3px] rounded-sm font-mono text-[9px] tracking-[0.18em] uppercase border border-bone/15 text-boneDim/55 hover:text-bone hover:border-bone/30 transition"
            title="Clear all filters"
          >
            × CLEAR
          </button>
        )}
        <div className="flex-1 h-px bg-gold/10" />
        <span className="font-mono text-[10px] text-boneDim/50 tabular-nums">
          {collapsed.length}/{tables.length} tables
        </span>
        {/* Card / list view toggle - desktop only (mobile always shows cards) */}
        <div className="hidden md:flex items-center">
          <button
            onClick={() => { SFX.play('ui-tap'); setCashView('card'); }}
            className={cx(
              'p-1.5 rounded-l-sm border hairline',
              cashView === 'card' ? 'bg-gold/15 border-gold/50 text-gold' : 'text-boneDim/60 hover:text-bone',
            )}
            title="Card view"
            aria-pressed={cashView === 'card'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="1" y="1" width="5" height="5" rx="0.5"/><rect x="8" y="1" width="5" height="5" rx="0.5"/>
              <rect x="1" y="8" width="5" height="5" rx="0.5"/><rect x="8" y="8" width="5" height="5" rx="0.5"/>
            </svg>
          </button>
          <button
            onClick={() => { SFX.play('ui-tap'); setCashView('list'); }}
            className={cx(
              'p-1.5 rounded-r-sm border border-l-0 hairline',
              cashView === 'list' ? 'bg-gold/15 border-gold/50 text-gold' : 'text-boneDim/60 hover:text-bone',
            )}
            title="List view"
            aria-pressed={cashView === 'list'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <line x1="1" y1="3.5" x2="13" y2="3.5"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="1" y1="10.5" x2="13" y2="10.5"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Caption - full-width second line beneath the filter row */}
      <div className="px-4 mt-2 font-mono text-[10px] text-boneDim/60 tracking-wider">
        ALL TABLES &middot; USER-CREATED &middot; NEW SEATS WAIT FOR THE BB
      </div>

      <div className="px-4 mt-1">
        {loading ? (
          <div className="rounded-md overflow-hidden border border-bone/10 bg-[#0d1217] py-10 text-center">
            <div className="w-5 h-5 border-2 border-orange/30 border-t-orange rounded-full animate-spin mx-auto mb-3" />
            <div className="font-mono text-[10px] text-boneDim/70 tracking-[0.16em] uppercase">Loading tables…</div>
          </div>
        ) : collapsed.length === 0 ? (
          <div className="glass-room overflow-hidden px-4 py-10 text-center font-mono text-[10px] text-boneDim/50 tracking-wider">
            NO TABLES MATCH FILTERS
          </div>
        ) : (
          <>
            {/* Mobile: always cards (toggle is hidden < md). */}
            <div className="md:hidden grid grid-cols-1 gap-2 min-w-0">
              {visible.map(t => (
                <CashTableRow
                  key={`m-${t.pubkey}`}
                  table={t}
                  onNavigate={onNavigate}
                  onSpectate={onSpectate}
                  isSeated={seatedPdas.has(t.pubkey)}
                  stats={tableStatsByPda[t.pubkey] ?? null}
                  name={tableNamesByPda[t.pubkey] ?? null}
                  forceCard
                />
              ))}
              {loadMoreEl}
            </div>

            {/* Desktop: respect cashView (card or list). */}
            <div className="hidden md:block">
              {cashView === 'card' ? (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-2 min-w-0">
                    {visible.map(t => (
                      <CashTableRow
                        key={`d-${t.pubkey}`}
                        table={t}
                        onNavigate={onNavigate}
                        onSpectate={onSpectate}
                        isSeated={seatedPdas.has(t.pubkey)}
                        stats={tableStatsByPda[t.pubkey] ?? null}
                        name={tableNamesByPda[t.pubkey] ?? null}
                        forceCard
                      />
                    ))}
                  </div>
                  {loadMoreEl}
                </>
              ) : (
                <div className="glass-room overflow-hidden">
                  <div className="md:min-w-[780px]">
                    <div className="grid grid-cols-[1fr_110px_110px_80px_70px_80px_180px] gap-3 px-3 py-1.5 hairline-b">
                      <SortHeader label="Table · Host" sortKey={null} active={filter.sortKey} dir={filter.sortDir} onClick={onSortClick} />
                      <SortHeader label="Stakes" sortKey="stakes" active={filter.sortKey} dir={filter.sortDir} onClick={onSortClick} />
                      <SortHeader label="Seats" sortKey="seats" active={filter.sortKey} dir={filter.sortDir} onClick={onSortClick} />
                      <SortHeader label="Avg pot" sortKey="avgpot" active={filter.sortKey} dir={filter.sortDir} onClick={onSortClick} />
                      <SortHeader label="VPIP" sortKey="vpip" active={filter.sortKey} dir={filter.sortDir} onClick={onSortClick} />
                      <SortHeader label="Hnd/hr" sortKey="hph" active={filter.sortKey} dir={filter.sortDir} onClick={onSortClick} />
                      <span />
                    </div>
                    {visible.map(t => (
                      <CashTableRow
                        key={`l-${t.pubkey}`}
                        table={t}
                        onNavigate={onNavigate}
                        onSpectate={onSpectate}
                        isSeated={seatedPdas.has(t.pubkey)}
                        stats={tableStatsByPda[t.pubkey] ?? null}
                        name={tableNamesByPda[t.pubkey] ?? null}
                      />
                    ))}
                    {loadMoreEl}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// Table boosting (featured placement, paid in USDC) is disabled for launch.
// Flip to true to bring back the BOOST button + BoostTableModal.
const BOOST_ENABLED = false;

// ─── My Table Row ───
// ─── Felt-surface card row (MTA_9 design) ───
function MyTableRow({
  table,
  name,
  onShare,
  onManage,
  onBoost,
  onClose,
  onManageWL,
  onRename,
}: {
  table: CreatorTable;
  name?: string | null;
  onShare: (t: CreatorTable) => void;
  onManage: (t: CreatorTable) => void;
  onBoost: (t: CreatorTable) => void;
  onClose: (t: CreatorTable) => void;
  onManageWL: (t: CreatorTable) => void;
  onRename: (t: CreatorTable) => void;
}) {
  const sym = table.tokenSymbol;
  const dec = table.decimals ?? 9;
  const sbVal = table.smallBlind / 10 ** dec;
  const bbVal = table.bigBlind / 10 ** dec;
  const fmt = (v: number) => v >= 1 ? v.toFixed(v % 1 === 0 ? 0 : 2) : parseFloat(v.toPrecision(3)).toString();
  const lifetimeEarned = table.creatorRakeTotal / 1e9;
  const isLive = table.phase !== 'Waiting' && table.phase !== 'Complete';
  const setupIncomplete = !table.isDelegated;
  const rakePct = 5;
  const rakeCapBb = table.bigBlind > 0 ? Math.round((table.rakeCap ?? 0) / table.bigBlind * 10) / 10 : 0;

  const statusColor =
    setupIncomplete ? '#FFC63A' :
    table.phase === 'Waiting' ? '#9ca3af' :
    table.phase === 'Complete' ? '#c084fc' :
    isLive ? '#34d399' : '#FFC63A';
  const statusLabel = setupIncomplete ? 'UNFINISHED' : isLive ? 'LIVE' : table.phase.toUpperCase();

  return (
    <div
      id="my-table-card-shell"
      role="button"
      tabIndex={0}
      onClick={() => onManage(table)}
      onKeyDown={(e) => { if (e.key === 'Enter') onManage(table); }}
      title={setupIncomplete ? 'Finish table setup' : 'Open table'}
      className="rounded-md p-3 relative overflow-hidden cursor-pointer transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange/50"
      style={{
        backgroundImage: "url('/brand/felt_table.png')",
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        border: '1px solid rgba(245,241,230,0.12)',
        boxShadow: [
          'inset 0 0 28px 5px rgba(0,0,0,0.55)',
          'inset 0 0 70px rgba(0,0,0,0.4)',
          'inset 0 1px 0 rgba(255,255,255,0.1)',
        ].join(', '),
      }}
    >
      <div
        className="absolute inset-0 opacity-[0.06] pointer-events-none"
        style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '6px 6px' }}
      />
      <div className="relative">
        {/* Header · token + pubkey + status + chips */}
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <TokenPill symbol={sym} size={20} />
          <span className="font-display text-[14px] text-bone tracking-[0.04em] truncate" title={name || undefined}>
            {name ? name : `${table.gameTypeName === 'Cash Game' ? 'Cash' : 'SNG'} · ${fmt(sbVal)}/${fmt(bbVal)} ${sym}`}
          </span>
          <span className="inline-flex items-center gap-1 font-mono text-[9px] tracking-[0.18em] uppercase" style={{ color: statusColor }}>
            <span className="w-[6px] h-[6px] rounded-full animate-pulse" style={{ background: statusColor }} />
            {statusLabel}
          </span>
          {setupIncomplete ? (
            <span className="font-mono text-[9px] tracking-[0.18em] uppercase px-1.5 py-0.5 rounded-sm border border-amber/45 bg-amber/10 text-amber">SETUP NEEDED</span>
          ) : (
            <span className="font-mono text-[9px] tracking-[0.18em] uppercase px-1.5 py-0.5 rounded-sm border border-orange/35 text-orange">TEE</span>
          )}
          {table.isPrivate && (
            <span className="font-mono text-[9px] tracking-[0.18em] uppercase px-1.5 py-0.5 rounded-sm border border-purple-400/35 text-purple-400">PRIVATE</span>
          )}
          {table.isLegacy && (
            <span className="font-mono text-[9px] tracking-[0.18em] uppercase px-1.5 py-0.5 rounded-sm border border-boneDim/35 text-boneDim/70">LEGACY</span>
          )}
          {table.boost?.active && (
            <span className="font-mono text-[9px] tracking-[0.18em] uppercase px-1.5 py-0.5 rounded-sm border border-amber/35 text-amber">★ BOOSTED</span>
          )}
        </div>

        {/* 4-cell stat grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="rounded-sm bg-black/35 border border-bone/15 px-2 py-1.5">
            <div className="font-mono text-[8px] tracking-[0.16em] text-bone/55 uppercase">BLINDS</div>
            <div className="font-display text-[14px] text-bone tabular-nums leading-none mt-0.5">{fmt(sbVal)}/{fmt(bbVal)}</div>
          </div>
          <div className="rounded-sm bg-black/35 border border-bone/15 px-2 py-1.5">
            <div className="font-mono text-[8px] tracking-[0.16em] text-bone/55 uppercase">SEATS</div>
            <div className="font-display text-[14px] text-emerald-400 tabular-nums leading-none mt-0.5">{table.currentPlayers}/{table.maxPlayers}</div>
          </div>
          <div className="rounded-sm bg-black/35 border border-bone/15 px-2 py-1.5">
            <div className="font-mono text-[8px] tracking-[0.16em] text-bone/55 uppercase">RAKE</div>
            <div className="font-display text-[14px] text-orange tabular-nums leading-none mt-0.5">{rakePct}% / {rakeCapBb}bb</div>
          </div>
          <div className="rounded-sm bg-black/35 border border-emerald-400/25 px-2 py-1.5">
            <div className="font-mono text-[8px] tracking-[0.16em] text-emerald-400/75 uppercase">LIFETIME</div>
            <div className="font-display text-[14px] text-emerald-400 tabular-nums leading-none mt-0.5 inline-flex items-center gap-1">
              <SolIcon size={11} /> {lifetimeEarned >= 0.001 ? lifetimeEarned.toFixed(3) : '0'}
            </div>
          </div>
        </div>

        {/* Bottom action row */}
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[9px] text-bone/65 tracking-[0.12em] uppercase">
            {table.maxPlayers}-max &middot; {table.pubkey.slice(0, 6)}…{table.pubkey.slice(-4)}
          </span>
          <div className="ml-auto flex items-center gap-1 justify-end flex-wrap">
            {BOOST_ENABLED && !setupIncomplete && (
              <button
                onClick={(e) => { e.stopPropagation(); onBoost(table); }}
                disabled={table.isPrivate || !table.isDelegated}
                className={cx(
                  'px-2 py-1 rounded-sm font-mono text-[10px] tracking-[0.16em] border inline-flex items-center gap-1 transition',
                  table.isPrivate || !table.isDelegated
                    ? 'border-amber/20 text-amber/40 cursor-not-allowed'
                    : 'border-amber/40 text-amber hover:bg-amber/10 hover:border-amber',
                )}
                title={table.isPrivate ? 'Private tables cannot be boosted' : 'Boost to featured placement'}
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M6 1l1.5 3.5L11 5l-2.5 2.5L9 11 6 9l-3 2 .5-3.5L1 5l3.5-.5z" />
                </svg>
                BOOST
              </button>
            )}
            {table.isPrivate && (
              <button
                onClick={(e) => { e.stopPropagation(); onManageWL(table); }}
                className="px-2 py-1 rounded-sm font-mono text-[10px] tracking-[0.12em] border border-gold/40 bg-ink/70 text-gold hover:bg-gold/15 hover:border-gold transition inline-flex items-center gap-1"
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 5V3.5a2 2 0 0 1 4 0V5" /><rect x="2.5" y="5" width="7" height="5.5" rx="1" />
                </svg>
                WL
              </button>
            )}
            {!setupIncomplete && (
              <button
                onClick={(e) => { e.stopPropagation(); onRename(table); }}
                className="px-2 py-1 rounded-sm font-mono text-[10px] tracking-[0.12em] border border-bone/20 bg-ink/70 text-bone/80 hover:border-bone/55 hover:text-bone hover:bg-ink/90 transition inline-flex items-center gap-1"
                title="Rename this table"
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 8L8 2l2 2-6 6H2v-2z" />
                </svg>
                {name ? 'RENAME' : 'NAME'}
              </button>
            )}
            {!setupIncomplete && (
              <button
                onClick={(e) => { e.stopPropagation(); onShare(table); }}
                className="px-2 py-1 rounded-sm font-mono text-[10px] tracking-[0.12em] border border-bone/20 bg-ink/70 text-bone/80 hover:border-bone/55 hover:text-bone hover:bg-ink/90 transition inline-flex items-center gap-1"
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="3" cy="6" r="1.5" /><circle cx="9" cy="3" r="1.5" /><circle cx="9" cy="9" r="1.5" />
                  <path d="M4.3 5.3l3.4-1.8M4.3 6.7l3.4 1.8" />
                </svg>
                SHARE
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onClose(table); }}
              className="px-2 py-1 rounded-sm font-mono text-[10px] tracking-[0.12em] border border-red-400/45 bg-ink/70 text-red-300 hover:bg-red-500/20 hover:border-red-400/80 hover:text-red-200 transition"
              title="Close this table and reclaim rent"
            >
              CLOSE
            </button>
            {setupIncomplete ? (
              <button
                onClick={(e) => { e.stopPropagation(); onManage(table); }}
                className="btn-orange px-3 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] font-bold shadow-[0_0_18px_rgba(255,198,58,0.55)] animate-pulse"
                title="Finish table setup"
              >
                FINISH SETUP!
              </button>
            ) : (
              <span className="font-mono text-[10px] text-orange tracking-[0.12em] pl-1 font-semibold pointer-events-none">OPEN →</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Rename modal · used by MyTablesSection to claim/rename a table ───
function TableRenameModal({
  table, currentName, onClose,
}: {
  table: CreatorTable;
  currentName: string | null;
  onClose: () => void;
}) {
  const { signMessage } = useUnifiedWallet();
  const [value, setValue] = useState(currentName ?? '');
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'same'>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Debounced availability check; 'same' = unchanged from currentName (allowed
  // no-op so user can confirm without typing if they just opened the modal).
  useEffect(() => {
    const v = value.trim();
    if (v === '') { setStatus('idle'); return; }
    if (currentName && v.toLowerCase() === currentName.toLowerCase()) { setStatus('same'); return; }
    if (!NAME_PATTERN.test(v)) { setStatus('invalid'); return; }
    setStatus('checking');
    const t = setTimeout(async () => {
      const res = await checkNameAvailable(v);
      if (!res.ok) { setStatus('invalid'); return; }
      setStatus(res.available ? 'available' : 'taken');
    }, 350);
    return () => clearTimeout(t);
  }, [value, currentName]);

  const canSubmit = !submitting && signMessage && (status === 'available' || status === 'same') && value.trim() !== '';

  const submit = async () => {
    if (!signMessage) return;
    const trimmed = value.trim();
    if (!NAME_PATTERN.test(trimmed)) return;
    if (status === 'same') { onClose(); return; }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const nonce = nowNonce();
      const msg = buildCanonicalMessage(table.pubkey, trimmed, nonce);
      const sigBytes = await signMessage(msg);
      const res = await postNameClaim({
        pda: table.pubkey,
        name: trimmed,
        signature: bs58.encode(sigBytes),
        nonce,
      });
      if (!res.ok) {
        setSubmitError(res.error || 'claim failed');
        setSubmitting(false);
        return;
      }
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-pop relative w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-display text-bone text-[18px] tracking-[0.04em]">
          {currentName ? 'RENAME TABLE' : 'NAME YOUR TABLE'}
        </div>
        <div className="font-mono text-[10px] text-boneDim/65 tracking-wide mt-1">
          Unique across all FastPoker tables, FCFS. Sign with your wallet to confirm.
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. whales_only"
          maxLength={20}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className="w-full mt-4 px-3 py-2.5 bg-black border border-bone/15 rounded-sm font-mono text-[12px] text-bone placeholder:text-boneDim/35 focus:outline-none focus:border-orange/55 transition"
        />
        <div className="flex items-center justify-between mt-1.5 px-0.5">
          <span className="font-mono text-[9px] text-boneDim/55 tracking-wide">3-20 chars, [A-Z0-9_-]</span>
          {status === 'checking' && <span className="font-mono text-[9px] text-boneDim/65">checking…</span>}
          {status === 'available' && <span className="font-mono text-[9px] text-emerald-400">available</span>}
          {status === 'taken' && <span className="font-mono text-[9px] text-rose-400">already taken</span>}
          {status === 'invalid' && value.trim() !== '' && <span className="font-mono text-[9px] text-rose-400">invalid format</span>}
          {status === 'same' && <span className="font-mono text-[9px] text-boneDim/65">unchanged</span>}
        </div>
        {submitError && (
          <div className="mt-3 px-2.5 py-1.5 rounded-sm border border-rose-400/40 bg-rose-400/10 font-mono text-[10px] text-rose-400">
            {submitError}
          </div>
        )}
        {!signMessage && (
          <div className="mt-3 px-2.5 py-1.5 rounded-sm border border-amber/35 bg-amber/10 font-mono text-[10px] text-amber">
            Wallet does not support signMessage. Reconnect with a wallet that does (Phantom / Solflare / Backpack).
          </div>
        )}
        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.16em] border border-boneDim/25 text-boneDim hover:border-bone/50 hover:text-bone transition"
          >
            CANCEL
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className={cx(
              'px-3 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.16em] font-bold transition',
              canSubmit ? 'btn-orange' : 'border border-boneDim/20 text-boneDim/40 cursor-not-allowed',
            )}
          >
            {submitting ? 'SIGNING…' : (currentName ? 'RENAME' : 'CLAIM')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Playing Now (tables the wallet is currently SEATED at) ───
// Distinct from the creator list below: these are live seats (your own
// tables OR anyone else's) with a one-tap RETURN. Fed by the shared
// useMyActiveTables seat scan, so it costs no extra RPC.
function PlayingNowSection({
  tables,
  onResume,
}: {
  tables: MyActiveTable[];
  onResume: (tablePda: string) => void;
}) {
  const pdas = useMemo(() => tables.map(t => t.tablePda), [tables]);
  const { names } = useTableNames(pdas);
  if (tables.length === 0) return null;

  const typeLabel = (t: MyActiveTable) => {
    if (t.type === 'cash') return 'CASH GAME';
    const seats = t.type === 'heads_up' ? 'HEADS-UP' : t.type === '6max' ? '6-MAX' : t.type === '9max' ? '9-MAX' : 'SIT & GO';
    const tierName = t.type !== 'cash' && t.tier != null ? (TIER_NAMES[t.tier] ?? '') : '';
    return tierName ? `${seats} · ${tierName}` : seats;
  };

  return (
    <div className="space-y-2 mt-4 px-4">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
        </span>
        <h3 className="font-display text-bone text-[18px] sm:text-[20px] leading-none tracking-[0.04em]">
          PLAYING NOW
        </h3>
        <span className="font-mono text-[10px] text-boneDim/60 tracking-[0.12em] uppercase">
          {tables.length} {tables.length === 1 ? 'seat' : 'seats'}
        </span>
      </div>
      <div className="space-y-2">
        {tables.map(t => {
          const tierColor = t.type !== 'cash' && t.tier != null ? TIER_COLORS[t.tier] : undefined;
          return (
            <button
              key={t.tablePda}
              onClick={() => { SFX.play('ui-click'); onResume(t.tablePda); }}
              className="w-full group flex items-center justify-between gap-3 px-3.5 py-3 rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] hover:bg-emerald-500/[0.08] hover:border-emerald-500/50 transition text-left"
            >
              <div className="min-w-0">
                <div className="font-display text-bone text-[15px] leading-none truncate">
                  {names[t.tablePda] ?? typeLabel(t)}
                </div>
                <div className="font-mono text-[9.5px] tracking-[0.1em] uppercase mt-1.5 flex items-center gap-2">
                  <span style={tierColor ? { color: tierColor } : undefined} className={tierColor ? '' : 'text-boneDim/60'}>{typeLabel(t)}</span>
                  <span className="text-boneDim/30">|</span>
                  {t.type !== 'cash' && t.phase === 7 ? (
                    <span className="text-amber-300">&bull; DISTRIBUTING PRIZES</span>
                  ) : (
                    <span className="text-emerald-400">&bull; SEATED</span>
                  )}
                  <span className="text-boneDim/30">|</span>
                  {/* Table ID so multiple same-tier tables are distinguishable. */}
                  <span className="text-boneDim/55 tabular-nums normal-case" title={t.tablePda}>
                    {t.tablePda.slice(0, 4)}…{t.tablePda.slice(-4)}
                  </span>
                </div>
              </div>
              <span className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-emerald-500/20 border border-emerald-500/50 group-hover:bg-emerald-500/30 font-mono text-[10px] tracking-[0.18em] font-bold text-emerald-300">
                RETURN
                <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2l5 4-5 4" /></svg>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── My Tables Section (MTA_9: heading + inline ticker + felt cards) ───
function MyTablesSection({
  tables,
  onShare,
  onManage,
  onBoost,
  onClose,
  onManageWL,
  loading,
  walletConnected,
}: {
  tables: CreatorTable[];
  onShare: (t: CreatorTable) => void;
  onManage: (t: CreatorTable) => void;
  onBoost: (t: CreatorTable) => void;
  onClose: (t: CreatorTable) => void;
  onManageWL: (t: CreatorTable) => void;
  loading: boolean;
  walletConnected: boolean;
}) {
  const totalLifetimeEarned = tables.reduce((s, t) => s + t.creatorRakeTotal / 1e9, 0);
  const liveCount = tables.filter(t => t.phase !== 'Waiting' && t.phase !== 'Complete').length;
  const unfinishedCount = tables.filter(t => !t.isDelegated).length;
  const fmtSol = (n: number) => (n < 0.1 ? n.toFixed(3) : n.toFixed(2));

  // Player-claimed names for the host's tables. One batched fetch; refreshed
  // every 30s so a successful rename propagates without manual refetch.
  const pdas = useMemo(() => tables.map(t => t.pubkey), [tables]);
  const { names: tableNamesByPda } = useTableNames(pdas);
  const [renameTarget, setRenameTarget] = useState<CreatorTable | null>(null);

  return (
    <div className="space-y-3 mt-4 px-4 pb-4">
      {/* Header frame · CREATE TABLE now lives in the tabs row (ModeTabs).
          px-4 lives on this section root (mirrors tab 1/2 #*-body) so the
          content sits inside the lobby panel, not touching its border. */}
      <div className="rounded-md overflow-hidden">
        <div className="pt-3 pb-3 flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-display text-bone text-[22px] sm:text-[26px] leading-none tracking-[0.04em]">
              YOUR TABLES. <span className="text-orange italic">YOUR HOUSE.</span>
            </h3>
            <p className="font-mono text-[10px] text-boneDim/70 tracking-[0.04em] mt-1.5">
              Host cash tables &middot; earn 45% of every pot rake &middot; auto-paid to your wallet
            </p>
          </div>
        </div>

        {/* Inline ticker - only when there are tables to summarize */}
        {tables.length > 0 && (
          <div className="py-2 px-3 rounded-sm bg-black/30 flex items-center gap-x-3 gap-y-1 flex-wrap font-mono text-[10px]">
            <span className="text-boneDim/75 tracking-[0.12em] uppercase">TABLES <span className="font-display text-[14px] text-bone tabular-nums ml-1">{tables.length}</span></span>
            <span className="text-boneDim/30">|</span>
            <span className="text-boneDim/75 tracking-[0.12em] uppercase">LIVE <span className="font-display text-[14px] text-emerald-400 tabular-nums ml-1">{liveCount}</span></span>
            <span className="text-boneDim/30">|</span>
            {unfinishedCount > 0 && (
              <>
                <span className="text-amber tracking-[0.12em] uppercase" title="Tables created on L1 that still need setup completed">
                  UNFINISHED TABLE CREATION <span className="font-display text-[14px] text-amber tabular-nums ml-1 drop-shadow-[0_0_8px_rgba(255,198,58,0.65)]">{unfinishedCount}</span>
                </span>
                <span className="text-boneDim/30">|</span>
              </>
            )}
            <span className="text-boneDim/75 tracking-[0.12em] uppercase">LIFETIME <span className="font-display text-[14px] text-emerald-400 tabular-nums ml-1">{fmtSol(totalLifetimeEarned)}</span> SOL</span>
            <span className="text-boneDim/30">|</span>
            <span className="text-boneDim/75 tracking-[0.12em] uppercase" title="24h rake requires indexer aggregation">24H <span className="font-display text-[14px] text-boneDim/40 tabular-nums ml-1">--</span></span>
          </div>
        )}
      </div>

      {/* Body */}
      {loading ? (
        <div className="rounded-md overflow-hidden border border-bone/10 bg-[#0d1217] py-10 text-center">
          <div className="w-5 h-5 border-2 border-orange/30 border-t-orange rounded-full animate-spin mx-auto mb-3" />
          <div className="font-mono text-[10px] text-boneDim/70 tracking-[0.16em] uppercase">Loading your tables…</div>
        </div>
      ) : !walletConnected ? (
        <div className="rounded-md overflow-hidden border border-bone/10 bg-[#0d1217]">
          <div
            className="px-4 sm:px-6 py-10 relative overflow-hidden text-center"
            style={{ background: 'radial-gradient(ellipse at 50% 50%, #1a4a2e 0%, #0a1f15 70%)' }}
          >
            <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '8px 8px' }} />
            <div className="relative">
              <div className="font-display text-[20px] text-bone tracking-[0.04em]">CONNECT YOUR WALLET</div>
              <p className="font-mono text-[10.5px] text-bone/75 mt-2 max-w-sm mx-auto leading-snug tracking-[0.04em]">
                See your creator tables and rake earnings.
              </p>
            </div>
          </div>
        </div>
      ) : tables.length === 0 ? (
        <div className="flex justify-center">
          <div
            id="my-tables-empty-shell"
            className="aspect-square relative overflow-hidden flex items-center justify-center w-full max-w-[500px] rounded-md border border-orange/40"
            style={{
              backgroundImage: "url('/brand/felt_table.png')",
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
              boxShadow: [
                'inset 0 0 28px 5px rgba(0,0,0,0.55)',
                'inset 0 0 70px rgba(0,0,0,0.4)',
                'inset 0 1px 0 rgba(255,255,255,0.1)',
              ].join(', '),
            }}
          >
            <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '8px 8px' }} />
            <div className="relative flex flex-col items-center">
              <div className="font-display text-[20px] text-bone tracking-[0.04em]">YOUR FELT IS EMPTY</div>
              <p className="font-mono text-[10.5px] text-bone/75 mt-2 mx-10 leading-snug">
                You&apos;re the house. 45% of every pot rake. SOL + $FP. 5BB cap. Auto-paid to your wallet.
              </p>
              <Link
                href="/my-tables/create"
                onMouseDown={() => SFX.play('ui-click')}
                className="btn-orange inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-sm font-mono text-[11px] tracking-[0.2em] font-bold"
              >
                <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 2v8M2 6h8" />
                </svg>
                CREATE TABLE
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {tables.map(t => (
            <MyTableRow
              key={t.pubkey}
              table={t}
              name={tableNamesByPda[t.pubkey] ?? null}
              onShare={onShare}
              onManage={onManage}
              onBoost={onBoost}
              onClose={onClose}
              onManageWL={onManageWL}
              onRename={(target) => setRenameTarget(target)}
            />
          ))}
          {renameTarget && (
            <TableRenameModal
              table={renameTarget}
              currentName={tableNamesByPda[renameTarget.pubkey] ?? null}
              onClose={() => setRenameTarget(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Lobby Component ───
function BoostTableModal({
  table,
  onClose,
  onActivated,
}: {
  table: CreatorTable;
  onClose: () => void;
  onActivated: () => void;
}) {
  const { publicKey, signMessage, sendTransaction } = useUnifiedWallet();
  const [prices, setPrices] = useState<{
    packages: Array<{ id: string; label: string; durationHours: number; usdCents: number }>;
    usdcMint: string;
    recipientUsdcAccount: string;
    cluster: string;
  } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busyPackage, setBusyPackage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/boosts/prices')
      .then(r => r.json())
      .then(data => { if (!cancelled) setPrices(data); })
      .catch(e => { if (!cancelled) setStatus(e.message || 'Boost pricing unavailable'); });
    return () => { cancelled = true; };
  }, []);

  const buy = async (packageId: string) => {
    if (!publicKey) { setStatus('Connect your wallet first.'); return; }
    if (!prices) { setStatus('Boost prices are still loading.'); return; }
    setBusyPackage(packageId);
    setStatus('Sign the free auth message to create a boost invoice. The next wallet prompt is the USDC payment.');
    try {
      const auth = await buildWalletApiAuth(publicKey, signMessage, 'boost');
      setStatus('Creating boost invoice...');
      const invoiceRes = await fetch('/api/boosts/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: auth.wallet, auth, tablePda: table.pubkey, packageId }),
      });
      const invoice = await invoiceRes.json();
      if (!invoiceRes.ok) throw new Error(invoice.error || 'Could not create invoice');

      const connection = makeL1Connection();
      const mint = new PublicKey(invoice.usdcMint);
      const sourceAta = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_PROGRAM_ID);
      const destinationAta = new PublicKey(invoice.recipientUsdcAccount);
      const reference = new PublicKey(invoice.referencePubkey);
      const sourceInfo = await connection.getAccountInfo(sourceAta);
      if (!sourceInfo) {
        throw new Error(`This wallet has no USDC token account for ${invoice.usdcMint}. Use Get USDC, then try again.`);
      }
      const balance = await connection.getTokenAccountBalance(sourceAta).catch(() => null);
      if (!balance || BigInt(balance.value.amount) < BigInt(invoice.usdcAmount)) {
        throw new Error(`Not enough USDC. This boost costs ${(Number(invoice.usdcAmount) / 1_000_000).toFixed(2)} USDC.`);
      }
      const ix = createTransferCheckedInstruction(
        sourceAta,
        mint,
        destinationAta,
        publicKey,
        BigInt(invoice.usdcAmount),
        6,
        [],
        TOKEN_PROGRAM_ID,
      );
      ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      const { blockhash, lastValidBlockHeight } = await getLatestBlockhashClient(connection, 'confirmed');
      tx.recentBlockhash = blockhash;

      setStatus('Approve the USDC transfer in your wallet.');
      const sig = await sendTransaction(tx, connection);
      setStatus('Payment received, finalizing (~30s)...');
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed').catch(() => {});

      const verifyRes = await fetch('/api/boosts/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: auth.wallet, auth, invoiceId: invoice.invoiceId, paymentTxSig: sig }),
      });
      const verified = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verified.error || 'Payment verification failed');
      if (verified.status === 'pending_finalization') {
        setStatus('Payment is confirmed and still finalizing. Check back in a moment.');
      } else if (verified.status === 'paid_unactivated') {
        setStatus('Payment finalized but needs admin reconciliation. Your payment is queued for review.');
      } else {
        setStatus('Boost activated.');
        onActivated();
      }
    } catch (e: any) {
      setStatus(e.message || 'Boost purchase failed');
    } finally {
      setBusyPackage(null);
    }
  };

  const jupiterUrl = prices?.usdcMint ? `https://jup.ag/swap/SOL-${prices.usdcMint}` : 'https://jup.ag/';

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center px-4 bg-black/70 backdrop-blur-sm">
      <div className="glass-pop hairline max-w-lg w-full rounded-md p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] text-amber tracking-[0.22em] font-bold">BOOST TABLE</div>
            <div className="font-display text-bone text-xl mt-1">{table.tokenSymbol} {formatBlinds(table.smallBlind, table.bigBlind, table.decimals)} Table</div>
          </div>
          <button onClick={onClose} className="text-boneDim hover:text-bone text-sm">CLOSE</button>
        </div>

        <div className="rounded-sm border border-amber/25 bg-amber/[0.06] px-3 py-2 font-mono text-[10px] text-amber/90 leading-relaxed">
          Boosts are paid lobby placement. They do not affect gameplay, cards, payouts, or table rules.
        </div>
        <div className="font-mono text-[10px] text-boneDim/65 leading-relaxed">
          Flow: sign a free message to authorize the invoice, then approve the USDC transfer. Only the transfer moves funds.
        </div>

        <div className="grid gap-2">
          {prices?.packages?.map(pkg => (
            <button
              key={pkg.id}
              onClick={() => buy(pkg.id)}
              disabled={!!busyPackage}
              className="flex items-center justify-between gap-3 rounded-sm border border-gold/25 bg-ink/50 px-3 py-2 text-left hover:border-gold/60 disabled:opacity-50"
            >
              <span>
                <span className="block font-display text-bone">{pkg.label}</span>
                <span className="block font-mono text-[9px] text-boneDim/60 tracking-wider">USDC ONLY - FINALIZED BEFORE PLACEMENT</span>
              </span>
              <span className="font-display text-gold">{(pkg.usdCents / 100).toFixed(2)} USDC</span>
            </button>
          )) || (
            <div className="px-3 py-4 text-center font-mono text-[10px] text-boneDim/60">LOADING BOOST PACKAGES...</div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <a href={jupiterUrl} target="_blank" rel="noreferrer" className="px-2.5 py-1 rounded-sm border border-blue-400/30 text-blue-300 font-mono text-[10px] tracking-wider hover:bg-blue-400/10">
            GET USDC
          </a>
          {prices?.usdcMint && (
            <button
              onClick={() => navigator.clipboard?.writeText(prices.usdcMint)}
              className="px-2.5 py-1 rounded-sm border border-boneDim/25 text-boneDim font-mono text-[10px] tracking-wider hover:text-bone"
            >
              COPY USDC MINT
            </button>
          )}
        </div>

        {status && <div className="font-mono text-[10px] text-boneDim/80 tracking-wide">{status}</div>}
      </div>
    </div>
  );
}

export function Lobby(props: LobbyProps) {
  const {
    onResumeGame, poolState,
    sitNGoQueues,
    selectedTier, onTierChange,
    sngPools, onJoinPool, onLeavePool, joiningPool, leavingPool,
  } = props;
  const { publicKey } = useUnifiedWallet();
  // Shared `/api/my-sng-tables` snapshot - deduped with ActiveTableBar.
  const myActiveTables = useMyActiveTables();
  // Client-tracked active games (localStorage). The cash game page writes its
  // seat here via setActiveTable; the server PlayerSeat scan behind
  // myActiveTables can't see a cash seat while the table is delegated/mid-hand,
  // so PLAYING NOW missed cash tables entirely. Merge these in (same reason as
  // ActiveTableBar). Reactive via the shared ACTIVE_GAMES_EVENT + window focus.
  const [clientGames, setClientGames] = useState<ActiveGameInfo[]>([]);
  useEffect(() => {
    const read = () => setClientGames(getActiveGames());
    read();
    window.addEventListener(ACTIVE_GAMES_EVENT, read);
    window.addEventListener('focus', read);
    return () => {
      window.removeEventListener(ACTIVE_GAMES_EVENT, read);
      window.removeEventListener('focus', read);
    };
  }, []);
  const playingNowTables = useMemo<MyActiveTable[]>(() => {
    const serverPdas = new Set(myActiveTables.tables.map((t) => t.tablePda));
    const cashExtras: MyActiveTable[] = clientGames
      .filter((g) => g.type === 'cash' && g.tablePda && !serverPdas.has(g.tablePda))
      .map((g) => ({ tablePda: g.tablePda, type: 'cash', maxPlayers: g.maxPlayers ?? 0, tier: 0 }));
    return [...myActiveTables.tables, ...cashExtras];
  }, [myActiveTables.tables, clientGames]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const fullRequestMode = levelAtLeast('full');
  const [mode, setMode] = useState<'sng' | 'cash' | 'my' | 'spectate'>('sng');
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t === 'sng' || t === 'cash' || t === 'my' || t === 'spectate') setMode(t);
  }, [searchParams]);

  const [cashTables, setCashTables] = useState<CashTable[]>([]);
  const [cashLoading, setCashLoading] = useState(true);
  const [cashNextCursor, setCashNextCursor] = useState<string | null>(null);
  const [cashLoadingMore, setCashLoadingMore] = useState(false);
  // All live (in-play) SNG tables on-chain, for the WATCH/spectate tab. Sourced
  // from /api/tables/list (the full registry) — NOT sitNGoQueues, which only
  // tracks this instance's managed pools.
  const [liveSngTables, setLiveSngTables] = useState<Array<{
    pubkey: string; gameType: number; currentPlayers: number; maxPlayers: number;
    phase: number; smallBlind: number; bigBlind: number; tier: number;
  }>>([]);
  // Lobby-wide header counts from the real table registry (/api/tables/list),
  // which includes live/delegated tables. gameType 3 = cash, 0/1/2 = SNG.
  // SNG queue/pool state cannot be used here: it only represents forming queues
  // and drops tables once they go live on the ER.
  const [tableSummary, setTableSummary] = useState({
    players: 0, cash: 0, sng: 0, cashActive: 0, sngActive: 0,
  });
  // Distinguishes "still loading" from a genuine zero so the headline stats show
  // a spinner on first paint instead of a misleading 0. Stays true after the
  // first successful load — later 10s refreshes update numbers silently.
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!fullRequestMode) { setSummaryLoaded(true); return; }
      try {
        const data = await fetchTableListWithStandaloneFallback('/api/tables/list?limit=300', { limit: 300 });
        const tables: Array<{ pubkey?: string; gameType?: number; currentPlayers?: number; maxPlayers?: number; phase?: number; smallBlind?: number; bigBlind?: number; tier?: number; isDelegated?: boolean }> = data.tables || [];
        let players = 0, cash = 0, sng = 0, cashActive = 0, sngActive = 0;
        const live: typeof liveSngTables = [];
        for (const t of tables) {
          const pl = t.currentPlayers ?? 0;
          players += pl;
          if (t.gameType === 3) { cash++; if (pl > 0) cashActive++; }
          else {
            sng++;
            if (pl > 0) sngActive++;
            // WATCH = any SNG table delegated to the TEE (i.e. live on the ER).
            // No phase or seat-count filtering: if it's a delegated SNG, it's
            // watchable. /api/tables/list already returns only delegated,
            // visible tables after server-side blacklist filtering, so this is the full live-SNG set.
            if (t.pubkey && t.isDelegated) {
              live.push({ pubkey: t.pubkey, gameType: t.gameType ?? 0, currentPlayers: pl, maxPlayers: t.maxPlayers ?? 9, phase: t.phase ?? 0, smallBlind: t.smallBlind ?? 0, bigBlind: t.bigBlind ?? 0, tier: t.tier ?? 0 });
            }
          }
        }
        if (!cancelled) { setTableSummary({ players, cash, sng, cashActive, sngActive }); setLiveSngTables(live); }
      } catch { /* ignore */ }
      finally {
        // Mark loaded after the FIRST attempt regardless of outcome — otherwise a
        // failed/non-OK fetch leaves the headline + spectate spinners spinning
        // forever. On failure we fall back to the zero/empty state (same as the
        // pre-spinner behavior); the 10s interval retries and fills in if the
        // endpoint recovers.
        if (!cancelled) setSummaryLoaded(true);
      }
    };
    load();
    const id = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [fullRequestMode]);
  const [myOnChainSngTables, setMyOnChainSngTables] = useState<{ tablePda: string; type: 'heads_up' | '6max' | '9max'; tier: number }[]>([]);
  const [myOnChainTablesLoaded, setMyOnChainTablesLoaded] = useState(false);

  // MY TABLES state
  const [creatorTables, setCreatorTables] = useState<CreatorTable[]>([]);
  const [creatorLoading, setCreatorLoading] = useState(false);
  const [boostTable, setBoostTable] = useState<CreatorTable | null>(null);
  const [closeTarget, setCloseTarget] = useState<CreatorTable | null>(null);

  const [sngFilter, setSngFilter] = useState<SngFilter>(() => {
    // Default to Bronze on every viewport so the widget mounts on a single
    // specific tier (the SizeInPlayToMint bridge needs `tiers.length === 1`
    // to render a non-ANY tier). Bronze remains the recommended starting point.
    return {
      formats: [],
      tiers: [1],
      active: false,
      myQueue: false,
    };
  });

  // SNG Join modal · tracks which pool (gameType + tier) the modal is currently showing
  const [modalPool, setModalPool] = useState<{ gameTypeIndex: number; tier: number; autoStart?: boolean; defaultMini?: boolean; rejoin?: boolean } | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('lobby.mode', mode);
  }, [mode]);

  // Sync selectedTier with filter.tiers[0] for SngSection grouping
  useEffect(() => {
    if (sngFilter.tiers.length === 1 && sngFilter.tiers[0] !== selectedTier) {
      onTierChange(sngFilter.tiers[0] as SnGTier);
    }
  }, [sngFilter.tiers, selectedTier, onTierChange]);

  // Authoritative table list comes from the `useMyActiveTables` singleton -
  // one shared poll loop with ActiveTableBar instead of two parallel 20s
  // intervals hitting the same endpoint.
  useEffect(() => {
    if (!publicKey) {
      setMyOnChainSngTables([]);
      setMyOnChainTablesLoaded(false);
      reconcileActiveGames([]);
      return;
    }
    if (!myActiveTables.loaded) return;
    const allLive = myActiveTables.tables;
    const sng = allLive.filter((t) => t.type !== 'cash');
    setMyOnChainTablesLoaded(true);
    setMyOnChainSngTables(
      sng.map((t) => ({
        tablePda: t.tablePda,
        type: (t.type ?? '9max') as 'heads_up' | '6max' | '9max',
        tier: t.tier ?? 0,
      })),
    );
    reconcileActiveGames(allLive.map((t) => t.tablePda));
    for (const t of sng) {
      const typeLabel =
        t.type === 'heads_up' ? 'HU' :
        t.type === '6max'     ? '6-Max' :
        t.type === '9max'     ? '9-Max' : '';
      addActiveGame({
        tablePda: t.tablePda,
        type: 'sng',
        maxPlayers: t.maxPlayers ?? 0,
        label: `SNG ${typeLabel}`,
      });
    }
  }, [publicKey, myActiveTables.tables, myActiveTables.loaded, myActiveTables.asOfMs]);

  // Fetch creator (MY) tables when wallet connects or MY tab is opened
  useEffect(() => {
    if (!publicKey) { setCreatorTables([]); return; }
    if (mode !== 'my' && creatorTables.length > 0) return; // already loaded, skip re-fetch unless on tab
    let cancelled = false;
    const PHASE_NAMES = ['Waiting', 'Starting', 'Preflop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete'];
    const fetchCreator = async () => {
      if (!fullRequestMode) {
        setCreatorLoading(true);
        try {
          const me = publicKey.toBase58();
          const { discoverMyCashTables } = await import('@/lib/table-discovery');
          // Shared, cached discovery (created + seated). My Tables lists tables you
          // HOST, so filter to ones you created — matching the original design.
          const discovered = (await discoverMyCashTables(me).catch(() => []))
            .filter((d) => d.state.creator.toBase58() === me);
          if (cancelled) return;
          const tables: CreatorTable[] = discovered.map((d) => {
            const ts = d.state;
            const tokenSymbol = getTokenSymbol(ts.tokenMint);
            return {
              pubkey: d.pubkey,
              gameTypeName: 'Cash Game',
              smallBlind: ts.smallBlind,
              bigBlind: ts.bigBlind,
              maxPlayers: ts.maxPlayers,
              currentPlayers: ts.currentPlayers,
              rakeAccumulated: 0,
              creatorRakeTotal: 0,
              vaultTotalRakeDistributed: 0,
              phase: PHASE_NAMES[ts.phase] ?? 'Unknown',
              tokenSymbol,
              tokenMint: ts.tokenMint,
              decimals: tokenSymbol === 'USDC' ? 6 : 9,
              isLegacy: false,
              rakeCap: 0,
              isDelegated: d.isDelegated,
              isPrivate: ts.isPrivate,
            };
          });
          if (!cancelled) setCreatorTables(tables);
        } catch (e) {
          if (!cancelled) console.warn('[standalone] on-chain creator-tables discovery failed', e);
        } finally {
          if (!cancelled) setCreatorLoading(false);
        }
        return;
      }
      setCreatorLoading(true);
      try {
        const data = await fetchTableListWithStandaloneFallback(
          `/api/tables/list?creator=${publicKey.toBase58()}&gameType=3`,
          { creator: publicKey.toBase58(), gameType: 3 },
        );
        const creatorAccounts = data.tables || [];
        if (cancelled) return;
        const tables: CreatorTable[] = creatorAccounts.map((t: CashTable) => {
          const tokenSymbol = getTokenSymbol(t.tokenMint);
          return {
            pubkey: t.pubkey,
            gameTypeName: t.gameType === 3 ? 'Cash Game' : 'Sit & Go',
            smallBlind: t.smallBlind,
            bigBlind: t.bigBlind,
            maxPlayers: t.maxPlayers,
            currentPlayers: t.currentPlayers,
            rakeAccumulated: (t as any).rakeAccumulated || 0,
            creatorRakeTotal: (t as any).creatorRakeTotal || 0,
            vaultTotalRakeDistributed: 0,
            phase: PHASE_NAMES[t.phase] ?? 'Unknown',
            lastActionSlot: t.lastActionSlot,
            tokenSymbol,
            tokenMint: t.tokenMint,
            tokenEscrow: t.tokenEscrow,
            decimals: t.decimals ?? 9,
            isLegacy: false,
            rakeCap: t.rakeCap || 0,
            isDelegated: t.isDelegated,
            isPrivate: !!t.isPrivate,
            boost: t.boost,
          };
        });
        if (!cancelled) setCreatorTables(tables);
      } catch (e) {
        console.error('Failed to fetch creator tables:', e);
      } finally {
        if (!cancelled) setCreatorLoading(false);
      }
    };
    fetchCreator();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, mode, fullRequestMode]);

  // Fetch cash tables when on cash tab. Uses a self-scheduling loop instead
  // of setInterval so we can stay tight (~2s) until the backend cache warms
  // up, then relax to 30s once tables are actually populated. Previously we
  // jumped to 30s after one retry, which left the tab stuck on an empty
  // state until the user toggled away and back.
  useEffect(() => {
    if (mode !== 'cash') return;
    if (!fullRequestMode) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const doFetch = async (): Promise<{ loading?: boolean; tables?: unknown[] } | null> => {
      try {
        const data = await fetchTableListWithStandaloneFallback('/api/tables/list?gameType=3&limit=60', { gameType: 3, limit: 60 });
        if (cancelled) return data;
        setCashTables(data.tables || []);
        setCashNextCursor(data.nextCursor || null);
        if (!data.loading) setCashLoading(false);
        return data;
      } catch {
        if (!cancelled) { setCashTables([]); setCashLoading(false); }
        return null;
      }
    };

    const scheduleNext = (stillLoading: boolean, isEmpty: boolean) => {
      if (cancelled) return;
      const hasData = !stillLoading && !isEmpty;
      const delay = hasData ? 30000 : (stillLoading ? 1500 : 2500);
      timeoutId = setTimeout(async () => {
        const data = await doFetch();
        scheduleNext(!!data?.loading, !data?.tables?.length);
      }, delay);
    };

    setCashLoading(true);
    doFetch().then((data) => {
      scheduleNext(!!data?.loading, !data?.tables?.length);
    });

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [mode, fullRequestMode]);

  const loadMoreCashTables = useCallback(async () => {
    if (!cashNextCursor || cashLoadingMore) return;
    setCashLoadingMore(true);
    try {
      const r = await fetch(`/api/tables/list?gameType=3&limit=60&cursor=${encodeURIComponent(cashNextCursor)}`);
      if (r.status === 409) {
        setCashNextCursor(null);
        return;
      }
      const data = await r.json();
      const incoming: CashTable[] = data.tables || [];
      setCashTables(prev => {
        const seen = new Set(prev.map(t => t.pubkey));
        return [...prev, ...incoming.filter(t => !seen.has(t.pubkey))];
      });
      setCashNextCursor(data.nextCursor || null);
    } catch {
      setCashNextCursor(null);
    } finally {
      setCashLoadingMore(false);
    }
  }, [cashLoadingMore, cashNextCursor]);

  // Active games
  const liveOnChainSngPdas = useMemo(
    () => new Set(myOnChainSngTables.map(t => t.tablePda)),
    [myOnChainSngTables],
  );
  const baseActiveGames = sitNGoQueues.filter(q =>
    q.status === 'in_progress'
    && q.players?.includes(publicKey?.toBase58() || '')
    && (!myOnChainTablesLoaded || (!!q.tablePda && liveOnChainSngPdas.has(q.tablePda))),
  );
  const extraFromChain: SitNGoQueue[] = myOnChainSngTables
    .filter(t => !baseActiveGames.some(q => q.tablePda === t.tablePda))
    .map(t => ({
      id: `onchain-${t.tablePda}`,
      type: t.type,
      currentPlayers: 0,
      maxPlayers: t.type === 'heads_up' ? 2 : t.type === '6max' ? 6 : 9,
      buyIn: 0,
      tier: t.tier ?? 0,
      status: 'in_progress' as const,
      tablePda: t.tablePda,
      players: [publicKey?.toBase58() || ''],
    }));
  const myActiveGames = [...baseActiveGames, ...extraFromChain];
  const myActiveIds = new Set(myActiveGames.map(q => q.id));
  const myKey = publicKey?.toBase58() || '';

  // Every live (in-progress) SNG with a table PDA — anyone can watch these,
  // not just games this wallet is in. Powers the WATCH (spectate) tab. Deduped
  // by tablePda, busiest first.
  const liveSpectateGames = useMemo(
    () => [...liveSngTables].sort((a, b) => b.currentPlayers - a.currentPlayers),
    [liveSngTables],
  );
  const spectateStats = `${liveSpectateGames.length} live`;

  // NOTE: a prior auto-close effect here force-closed the modal when a match
  // landed for this wallet. That fought the modal's built-in matched-state
  // branch (lines ~806-827) which already shows MATCHED · REDIRECTING + a
  // TO TABLE button. Removed so the modal stays open and transitions cleanly.
  // The CONFIRM-JOIN button is hidden correctly at line 809 via
  // `!isInPool && !myMatchedTablePda`, so there's no lingering CONFIRM JOIN.

  const myQueuedCount = useMemo(() => {
    const poolQueued = (sngPools || []).filter(p => p.queue.includes(myKey)).length;
    const sngQueued = sitNGoQueues.filter(q => q.status === 'waiting' && q.players?.includes(myKey)).length;
    return poolQueued + sngQueued;
  }, [sngPools, sitNGoQueues, myKey]);

  // SNG filtered queues · one best queue per (tier, type) combo, across all tiers
  const filteredQueues = useMemo(() => {
    const activeTierIds = sngFilter.tiers.length ? sngFilter.tiers : TIERS.map(t => t.id as number);
    const typesToShow = (sngFilter.formats.length ? sngFilter.formats : FORMAT_META.map(f => f.key)) as Array<'heads_up' | '6max' | '9max'>;

    const result: SitNGoQueue[] = [];

    for (const tierId of activeTierIds) {
      const candidates = sitNGoQueues.filter(q => {
        if (myActiveIds.has(q.id)) return false;
        if (!typesToShow.includes(q.type)) return false;
        if (sngFilter.active && (q.onChainPlayers ?? q.currentPlayers) === 0 && !q.tablePda) return false;
        if (sngFilter.myQueue && !q.players?.includes(myKey)) return false;
        if (q.status === 'in_progress') {
          const hasRoom = q.emptySeats?.length ? true : (q.onChainPlayers ?? q.currentPlayers) < q.maxPlayers;
          if (!hasRoom) return false;
        }
        if (q.status === 'waiting' && q.currentPlayers === 0 && q.tablePda) return false;
        if (q.status === 'starting') return false;
        const qTier = q.tier ?? 0;
        const isGenericWaiting = q.status === 'waiting' && q.currentPlayers === 0 && !q.tablePda;
        if (!isGenericWaiting && qTier !== tierId) return false;
        return true;
      });
      candidates.sort((a, b) => (b.onChainPlayers ?? b.currentPlayers) - (a.onChainPlayers ?? a.currentPlayers));
      const bestPerType = new Map<string, typeof candidates[0]>();
      for (const q of candidates) {
        // Generic-waiting queues (no tablePda) are shared across all tier rows; stamp
        // them to the current tier so downstream grouping attributes them correctly.
        const isGenericTemplate = q.status === 'waiting' && q.currentPlayers === 0 && !q.tablePda;
        const qStamped = isGenericTemplate && (q.tier ?? 0) !== tierId
          ? { ...q, tier: tierId, id: `${q.id}-t${tierId}` }
          : q;
        const existing = bestPerType.get(q.type);
        if (!existing) { bestPerType.set(q.type, qStamped); continue; }
        const qPlayers = q.onChainPlayers ?? q.currentPlayers;
        const ePlayers = existing.onChainPlayers ?? existing.currentPlayers;
        if (qPlayers > ePlayers) bestPerType.set(q.type, qStamped);
        else if (qPlayers === ePlayers && q.status === 'in_progress' && q.tablePda && q.emptySeats?.length && existing.status === 'waiting') {
          bestPerType.set(q.type, qStamped);
        }
      }
      // Only backfill virtual "available" slots when no filter would exclude them.
      // If the user enabled HAS ACTIVITY or MY QUEUE, empty virtual pools must not appear.
      if (!sngFilter.active && !sngFilter.myQueue) {
        for (const type of typesToShow) {
          if (!bestPerType.has(type)) {
            const max = type === 'heads_up' ? 2 : type === '6max' ? 6 : 9;
            bestPerType.set(type, {
              id: `virtual-${tierId}-${type}`, type, tier: tierId,
              currentPlayers: 0, maxPlayers: max, buyIn: 0, status: 'waiting',
            });
          }
        }
      }
      result.push(...Array.from(bestPerType.values()));
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sitNGoQueues, sngFilter, selectedTier, myActiveIds.size, myKey]);

  // Active tier: the tier shown in SngSection · driven by the filter pill, falls back to selectedTier
  const activeTier: number = sngFilter.tiers.length > 0 ? sngFilter.tiers[0] : selectedTier;

  // Header + tab stats come from tableSummary (the real /api/tables/list
  // registry, incl. live/delegated tables), not SNG queue templates.
  // Headline "Players" = seated at tables + waiting in SNG pool queues.
  // Seated-only undercounted the real activity: queued players ARE here and
  // committed (they paid a buy-in), they just have no seat yet. The pooled
  // waiters live in sngPools[].queueCount (the on-chain pool queue), NOT
  // sitNGoQueues[].currentPlayers (those are matched-table seats, already
  // counted in tableSummary.players — summing those would double-count).
  const queuedPlayers = (sngPools ?? []).reduce((sum, p) => sum + (p.queueCount || p.waitingCount || 0), 0);
  const totalPlayersHere = tableSummary.players + queuedPlayers;
  const sngStats = `${tableSummary.sng} tables · ${tableSummary.sngActive} active`;
  const cashStats = fullRequestMode
    ? `${tableSummary.cash} tables · ${tableSummary.cashActive} active`
    : 'search & saved';
  const sngTotals = `${tableSummary.sng} SNG tables`;
  // MY TABLES tab stats · 24h rake is indexer-only, show placeholder
  const myEarningCount = creatorTables.filter(t => t.phase !== 'Waiting' && t.phase !== 'Complete').length;
  const myCount = creatorTables.length;
  const myStats = `${myCount} ${myCount === 1 ? 'table' : 'tables'}`;

  const seatedPdas = useMemo(
    () => new Set(
      playingNowTables
        .filter((table) => table.type === 'cash')
        .map((table) => table.tablePda),
    ),
    [playingNowTables],
  );

  return (
    <div id="lobby-shell" className="fp-lobby-shell space-y-3">
      {/* ─── Page headline (matches EARN/About format) ─── */}
      <div id="lobby-headline-shell" className="mt-2 mb-2 pt-6 pb-6 [@media(orientation:landscape)_and_(max-height:500px)]:pt-0 [@media(orientation:landscape)_and_(max-height:500px)]:pb-0">
        <PageHeadline
          id="lobby-page-headline"
          singleLine
          lineOne="Find a"
          lineTwo="Game."
          right={
            <div
              id="lobby-headline-stats"
              className="mt-[10px] flex items-start gap-x-5 gap-y-3 whitespace-nowrap"
            >
              <div className="flex flex-col items-center gap-1">
                <span className="text-[9px] font-medium uppercase tracking-[0.22em] text-boneDim/60">
                  Players
                </span>
                <span
                  className="font-display text-xl lg:text-2xl leading-none text-orange tabular-nums"
                  title={summaryLoaded ? `${tableSummary.players} seated + ${queuedPlayers} in SNG queues` : undefined}
                >
                  {summaryLoaded ? totalPlayersHere : <span className="inline-block w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin align-middle" aria-label="loading" />}
                </span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <span className="text-[9px] font-medium uppercase tracking-[0.22em] text-boneDim/60">
                  Cash
                </span>
                <span className="font-display text-xl lg:text-2xl leading-none text-white tabular-nums">
                  {summaryLoaded ? tableSummary.cashActive : <span className="inline-block w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin align-middle" aria-label="loading" />}
                </span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <span className="text-[9px] font-medium uppercase tracking-[0.22em] text-boneDim/60">
                  SNG
                </span>
                <span className="font-display text-xl lg:text-2xl leading-none text-white tabular-nums">
                  {summaryLoaded ? tableSummary.sngActive : <span className="inline-block w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin align-middle" aria-label="loading" />}
                </span>
              </div>
            </div>
          }
        />
      </div>

      {/* ─── Mode switcher (orange-glass top bar) ─── */}
      <ModeTabs
        mode={mode}
        setMode={setMode}
        sngStats={sngStats}
        cashStats={cashStats}
        myStats={myStats}
        myEarningCount={myEarningCount}
        spectateStats={spectateStats}
      />

      <div id="lobby-panel-body" className="fp-lobby-panel !mt-0">

      {/* ─── SNG Section ─── */}
      {mode === 'sng' && (
        <SngSection
          queues={filteredQueues}
          selectedTier={selectedTier}
          activeTier={activeTier}
          onResume={onResumeGame}
          publicKey={myKey}
          sngPools={sngPools}
          onJoinPool={onJoinPool}
          onLeavePool={onLeavePool}
          joiningPool={joiningPool}
          leavingPool={leavingPool}
          myActiveGames={myActiveGames}
          poolState={poolState}
          filter={sngFilter}
          setFilter={setSngFilter}
          totals={sngTotals}
          queuedCount={myQueuedCount}
          onOpenModal={(gameTypeIndex, tier, autoStart, defaultMini, rejoin) => setModalPool({ gameTypeIndex, tier, autoStart, defaultMini, rejoin })}
        />
      )}

      {/* ─── SNG Join Modal ─── */}
      {modalPool && (() => {
        const fmt = FORMAT_META.find(f => f.gameTypeIndex === modalPool.gameTypeIndex);
        if (!fmt) return null;
        const poolData = sngPools?.find(p => p.gameType === modalPool.gameTypeIndex && p.tier === modalPool.tier);
        // Rejoin (fresh-join mode): a seated player re-queuing this pool. Suppress
        // the matched-table hint so the modal's canConfirmJoin gate opens and it
        // offers JOIN instead of TAKE SEAT. No change to the modal or on-chain steps.
        const myMatchedTablePda = modalPool.rejoin
          ? undefined
          : myActiveGames.find(g => g.type === fmt.key && g.tier === modalPool.tier && g.tablePda)?.tablePda;
        return (
          <SngJoinModal
            pool={{ gameTypeIndex: modalPool.gameTypeIndex, tier: modalPool.tier, format: fmt, poolData, myMatchedTablePda }}
            onClose={() => setModalPool(null)}
            onConfirm={(g, t, mini) => { onJoinPool?.(g, t, mini); }}
            onLeave={(g, t) => { onLeavePool?.(g, t); setModalPool(null); }}
            onResume={(pda) => { setModalPool(null); onResumeGame(pda); }}
            joiningPool={joiningPool}
            leavingPool={leavingPool}
            publicKey={myKey}
            autoStart={modalPool.autoStart}
            defaultMiniOptIn={modalPool.defaultMini}
          />
        );
      })()}

      {/* ─── Cash Section ─── */}
      {mode === 'cash' && !fullRequestMode && (
        <CashStandalone myWallet={publicKey?.toBase58() ?? null} />
      )}
      {mode === 'cash' && fullRequestMode && (
        <CashSection
          tables={cashTables}
          loading={cashLoading}
          onNavigate={onResumeGame}
          onSpectate={(pda) => router.push(`/game?table=${pda}&spectate=1`)}
          seatedPdas={seatedPdas}
          hasMore={!!cashNextCursor}
          loadingMore={cashLoadingMore}
          onLoadMore={loadMoreCashTables}
        />
      )}

      {/* ─── My Tables Section — your seated SNG tables (on at Minimal) ─── */}
      {mode === 'my' && (
        <>
        <PlayingNowSection
          tables={playingNowTables}
          onResume={(pda) => router.push(`/game?table=${pda}`)}
        />
        <MyTablesSection
          tables={creatorTables}
          loading={creatorLoading}
          walletConnected={!!publicKey}
          onShare={(t) => {
            const url = `${window.location.origin}/game?table=${t.pubkey}`;
            navigator.clipboard.writeText(url)
              .then(() => toast.success('Table link copied to clipboard'))
              .catch(() => toast.error('Could not copy link'));
          }}
          onManage={(t) => router.push(t.isDelegated ? `/game?table=${t.pubkey}` : `/my-tables/create?resume=${t.pubkey}`)}
          onBoost={(t) => setBoostTable(t)}
          onClose={(t) => setCloseTarget(t)}
          onManageWL={(t) => router.push(`/my-tables/whitelist?id=${encodeURIComponent(t.pubkey)}`)}
        />
        </>
      )}

      {/* ─── Spectate (WATCH) Section — every live SNG, anyone can watch ─── */}
      {mode === 'spectate' && !levelAtLeast('full') && (
        <RequestLevelGate need="full" feature="Watch / live tables"><span /></RequestLevelGate>
      )}
      {mode === 'spectate' && levelAtLeast('full') && (
        <div className="px-1 py-3 space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="font-display text-bone text-lg tracking-wide">LIVE SNG. <span className="text-orange italic">WATCH ANY GAME.</span></h3>
            <span className="font-mono text-[10px] text-boneDim/60 tracking-[0.12em] uppercase">{liveSpectateGames.length} {liveSpectateGames.length === 1 ? 'table' : 'tables'} live</span>
          </div>
          {!summaryLoaded ? (
            <div className="rounded-lg hairline bg-inkA px-4 py-10 text-center">
              <span className="inline-block w-6 h-6 rounded-full border-2 border-orange/30 border-t-orange animate-spin" aria-label="loading" />
              <div className="font-mono text-[10px] text-boneDim/40 mt-3 tracking-wide">Loading live tables</div>
            </div>
          ) : liveSpectateGames.length === 0 ? (
            <div className="rounded-lg hairline bg-inkA px-4 py-10 text-center">
              <div className="font-mono text-[11px] text-boneDim/60 tracking-wide">No live SNG tables right now.</div>
              <div className="font-mono text-[10px] text-boneDim/40 mt-1">Check back once games are in progress.</div>
            </div>
          ) : (
            <div className="space-y-2">
              {liveSpectateGames.map(g => {
                const fmt = g.gameType === 0 ? 'HU' : g.gameType === 1 ? '6-MAX' : '9-MAX';
                const street = ({ 0: 'WAITING', 1: 'STARTING', 2: 'PRE-FLOP', 3: 'FLOP', 4: 'TURN', 5: 'RIVER', 6: 'SHOWDOWN', 7: 'DISTRIBUTING PRIZES', 8: 'FLOP', 9: 'TURN', 10: 'RIVER' } as Record<number, string>)[g.phase] || 'IN HAND';
                // phase 7 = tournament Complete: it has ended and prizes are
                // settling on-chain (still delegated until undelegation).
                const ended = g.phase === 7;
                return (
                  <div key={g.pubkey} className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-md border border-white/10 bg-white/[0.02] hover:bg-white/[0.04] transition">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={cx('w-1.5 h-1.5 rounded-full shrink-0', ended ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse')} style={{ boxShadow: ended ? '0 0 8px #FFC63A' : '0 0 8px #34D399' }} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-display text-bone text-[14px] leading-none truncate">SNG {fmt}</span>
                          {(() => {
                            const tName = TIER_NAMES[g.tier];
                            if (!tName) return null;
                            // Uniform orange to match the bet slider (poker-slider
                            // track/thumb #F26A1F), not the per-tier palette.
                            const tColor = '#F26A1F';
                            return (
                              <span
                                className="shrink-0 px-1.5 py-[2px] rounded-sm font-mono text-[8px] tracking-[0.14em] leading-none font-bold uppercase"
                                style={{ color: tColor, border: `1px solid ${tColor}55`, background: `${tColor}14` }}
                              >
                                {tName}
                              </span>
                            );
                          })()}
                        </div>
                        {/* flex-wrap + whitespace-nowrap per segment: wraps to a clean
                            2nd line on mobile instead of breaking "PRE-FLOP" mid-word
                            and forcing the row wide enough to clip the SPECTATE button. */}
                        <div className="font-mono text-[9px] tracking-[0.06em] uppercase mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-boneDim/55">
                          <span className={cx('whitespace-nowrap', ended ? 'text-amber-300' : 'text-emerald-400')}>&bull; {street}</span>
                          <span className="tabular-nums whitespace-nowrap">{g.smallBlind}/{g.bigBlind} blinds</span>
                          <span className="tabular-nums whitespace-nowrap">{g.currentPlayers}/{g.maxPlayers} seated</span>
                          <span className="tabular-nums whitespace-nowrap" title={g.pubkey}>{g.pubkey.slice(0, 4)}…{g.pubkey.slice(-4)}</span>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => { SFX.play('ui-click'); router.push(`/game?table=${g.pubkey}&spectate=1`); }}
                      className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-sm bg-emerald-500/20 border border-emerald-500/50 hover:bg-emerald-500/30 font-mono text-[10px] tracking-[0.12em] font-bold text-emerald-300 transition"
                    >
                      SPECTATE
                      <svg className="w-3 h-3 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2l5 4-5 4" /></svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      </div>
      {BOOST_ENABLED && boostTable && (
        <BoostTableModal
          table={boostTable}
          onClose={() => setBoostTable(null)}
          onActivated={() => {
            setBoostTable(null);
            setMode('cash');
          }}
        />
      )}
      {closeTarget && (
        <CloseTableModal
          table={closeTarget}
          onClose={() => setCloseTarget(null)}
          onClosed={() => {
            // Optimistically drop the closed table; the 30s creatorTables poll
            // will reconcile if the close is still finalizing on-chain.
            setCreatorTables(prev => prev.filter(t => t.pubkey !== closeTarget.pubkey));
            setCloseTarget(null);
          }}
        />
      )}
    </div>
  );
}
