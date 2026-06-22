'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PublicKey } from '@solana/web3.js';
import {
  AlertCircle,
  BarChart3,
  Clock3,
  Coins,
  History,
  Medal,
  RefreshCw,
  Table2,
  Trophy,
  User,
  Wallet,
} from 'lucide-react';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { useConnectModal } from '@/components/wallet/FastPokerConnectModal';
import { SolIcon } from '@/components/ui/TokenIcon';
import { AvatarRing, LEVEL_XP, levelFromXp, tierForLevel, xpForLevel } from '@/components/progression/AvatarRing';
import { PixelAvatar } from '@/components/profile/avatars/PixelAvatar';
import {
  ACHIEVEMENT_TIER_STYLE,
  TIER_UNLOCKS,
  deriveAchievements,
  type AchievementDef,
} from '@/lib/profile-data';
import { ACHIEVEMENTS_ENABLED } from '@/lib/feature-flags';
import {
  loadPublicProfile,
  shortWallet,
  type EarningsRow,
  type PublicOnChainProfile,
  type PublicPlayerStats,
  type PublicProfileData,
} from '@/lib/public-profile';
import { cn } from '@/lib/utils';

interface PublicProfilePageProps {
  address: string;
}

type StatTone = 'bone' | 'orange' | 'amber' | 'emerald' | 'rose' | 'cyan';
type CareerMode = 'all' | 'cash' | 'sng';

const numberFmt = new Intl.NumberFormat('en-US');
const solFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const fpFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

const SOL_MINTS = new Set(['SOL', '11111111111111111111111111111111']);
const POKER_ALIASES = new Set(['POKER', '$FP']);

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rowField(row: unknown, keys: string[]): unknown {
  if (!row || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function rowString(row: unknown, keys: string[], fallback = '-'): string {
  const value = rowField(row, keys);
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function rowNumber(row: unknown, keys: string[]): number {
  return asNumber(rowField(row, keys));
}

function formatSol(value: number): string {
  return `${solFmt.format(value)} SOL`;
}

function formatLamports(lamports: number): string {
  return formatSol(lamports / 1_000_000_000);
}

function formatFp(value: number, decimals = 9): string {
  const div = decimals === 6 ? 1_000_000 : 1_000_000_000;
  return `${fpFmt.format(value / div)} $FP`;
}

function timestampLabel(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function relativeLabel(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return timestampLabel(value);
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return timestampLabel(value);
}

function jackpotLamports(row: unknown): number {
  return Math.max(
    rowNumber(row, ['largestSingleHitLamports', 'paidLamports', 'amountLamports', 'lamports']),
    rowNumber(row, ['miniPaidTotal']),
    rowNumber(row, ['grandPaidTotal']),
    rowNumber(row, ['royalPaidTotal']),
  );
}

function jackpotGrandHit(row: unknown): boolean {
  const kind = rowString(row, ['kind', 'jackpotType', 'type'], '').toLowerCase();
  return kind.includes('grand') || kind.includes('royal') || rowNumber(row, ['grandPaidTotal', 'royalPaidTotal']) > 0;
}

function earningAmount(row: EarningsRow): { label: string; tone: StatTone } {
  const kind = String(row.kind || row.type || '').toLowerCase();
  const tokenMint = row.tokenMint || '';
  const rawAmount = asNumber(row.amount ?? row.netSol ?? row.profitSol ?? row.amountSol ?? 0);
  const isOut = kind.includes('deposit') || kind.includes('buyin') || kind.includes('buy-in');
  const sign = isOut ? '-' : rawAmount >= 0 ? '+' : '';

  if (tokenMint && !SOL_MINTS.has(tokenMint)) {
    const isPoker = POKER_ALIASES.has(tokenMint) || tokenMint.length > 20;
    const decimals = kind.includes('cash') ? 9 : 6;
    return {
      label: isPoker ? `${sign}${formatFp(Math.abs(rawAmount), decimals)}` : `${sign}${numberFmt.format(Math.abs(rawAmount))} ${tokenMint.slice(0, 4)}...`,
      tone: isOut ? 'rose' : 'emerald',
    };
  }

  const sol = row.amount !== undefined ? rawAmount / 1_000_000_000 : rawAmount;
  return { label: `${sign}${formatSol(Math.abs(sol))}`, tone: isOut || sol < 0 ? 'rose' : 'emerald' };
}

function toneClass(tone?: StatTone): string {
  switch (tone) {
    case 'orange': return 'text-orange';
    case 'amber': return 'text-amber';
    case 'emerald': return 'text-emerald-300';
    case 'rose': return 'text-rose-300';
    case 'cyan': return 'text-cyan-200';
    default: return 'text-bone';
  }
}

function Panel({
  title,
  tag,
  icon,
  children,
}: {
  title: string;
  tag?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="glass-room overflow-hidden" style={{ padding: 0 }}>
      <div className="fp-card-header flex items-center justify-between gap-3 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {icon && <span className="text-orange">{icon}</span>}
          <span className="truncate font-display text-base tracking-[0.12em] text-bone">{title}</span>
        </div>
        {tag && (
          <span className="shrink-0 rounded-sm border border-orange/30 bg-orange/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-orange">
            {tag}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="px-5 py-6 font-mono text-[10px] uppercase tracking-[0.18em] text-boneDim/55">
      {children}
    </div>
  );
}

function LoadingState() {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-6xl items-center justify-center px-4">
      <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-boneDim">
        <RefreshCw className="h-4 w-4 animate-spin text-orange" />
        Loading profile
      </div>
    </main>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone = 'bone',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: StatTone;
}) {
  return (
    <div className="hairline min-w-0 rounded-lg bg-ink/30 p-4">
      <div className={cn('font-mono text-[9px] uppercase tracking-[0.22em]', toneClass(tone))}>{label}</div>
      <div className="mt-2 break-words font-display text-2xl leading-none text-bone tabular-nums md:text-3xl">{value}</div>
      {sub && <div className="mt-1.5 truncate font-mono text-[10px] tracking-wider text-boneDim/60">{sub}</div>}
    </div>
  );
}

function IdentityCard({
  wallet,
  level,
  xpInLevel,
  registeredAt,
  isRegistered,
}: {
  wallet: string;
  level: number;
  xpInLevel: number;
  registeredAt: number;
  isRegistered: boolean;
}) {
  const tier = tierForLevel(level);
  const pct = Math.max(0, Math.min(100, (xpInLevel / LEVEL_XP(level)) * 100));
  const joined = registeredAt > 0 ? timestampLabel(registeredAt * 1000) : 'Not registered';

  return (
    <Panel title="IDENTITY" tag={isRegistered ? 'REGISTERED' : 'VIEW ONLY'} icon={<User className="h-4 w-4" />}>
      <div className="p-5">
        <div className="flex flex-wrap items-center gap-5">
          <AvatarRing
            size={112}
            level={level}
            xp={xpInLevel}
            seed={wallet}
            innerNode={<PixelAvatar seed={wallet} size={112} />}
          />
          <div className="min-w-[220px] flex-1">
            <div className="font-display text-4xl leading-none tracking-wide text-bone">@{shortWallet(wallet, 5)}</div>
            <div className="mt-2 break-all font-mono text-[10px] tracking-[0.14em] text-boneDim/65">{wallet}</div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="rounded-sm border border-bone/15 bg-ink/50 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-boneDim">
                Joined {joined}
              </span>
              <span
                className="rounded-sm border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em]"
                style={{ color: tier.color, borderColor: `${tier.color}55`, background: `${tier.color}12` }}
              >
                L{level} {tier.name}
              </span>
            </div>
          </div>
        </div>
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-boneDim/65">
            <span>XP progress</span>
            <span>{numberFmt.format(xpInLevel)} / {numberFmt.format(LEVEL_XP(level))}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink/70">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${pct}%`,
                background: `linear-gradient(90deg, ${tier.color}, ${tier.glow})`,
                boxShadow: `0 0 8px ${tier.glow}80`,
              }}
            />
          </div>
        </div>
      </div>
    </Panel>
  );
}

function HoldingsPanel({ wallet, stats }: { wallet: string; stats: PublicOnChainProfile }) {
  const liquid = Math.max(0, stats.pokerBalance - stats.stakedAmount);
  return (
    <Panel title="WALLET HOLDINGS" tag={`ON-CHAIN · ${shortWallet(wallet)}`} icon={<Wallet className="h-4 w-4" />}>
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="SOL balance"
          value={<span className="inline-flex items-center gap-1.5">{stats.solBalance.toFixed(3)} <SolIcon size={22} /></span>}
          sub={stats.claimableSol > 0 ? `+${formatLamports(stats.claimableSol)} claimable` : 'On-chain balance'}
          tone="bone"
        />
        <StatTile
          label="$FP"
          value={stats.pokerBalance >= 1000 ? `${(stats.pokerBalance / 1000).toFixed(1)}k` : stats.pokerBalance.toFixed(2)}
          sub={`${liquid.toFixed(1)} liquid · ${stats.stakedAmount.toFixed(1)} staked`}
          tone="amber"
        />
        <StatTile
          label="Dealer licenses"
          value={stats.dealerLicenseCount}
          sub={stats.dealerLicenseCount > 0 ? 'Rake eligible wallet' : 'No license indexed'}
          tone="cyan"
        />
        <StatTile
          label="Raw yield"
          value={stats.unrefinedAmount > 0 ? stats.unrefinedAmount.toFixed(2) : '0'}
          sub={stats.refinedAmount > 0 ? `${stats.refinedAmount.toFixed(2)} refined` : 'No pending yield'}
          tone="orange"
        />
      </div>
    </Panel>
  );
}

function XpLadder({ level, xpInLevel }: { level: number; xpInLevel: number }) {
  const tier = tierForLevel(level);
  const pct = Math.max(0, Math.min(1, xpInLevel / LEVEL_XP(level)));
  const nodeCount = TIER_UNLOCKS.length;
  const nodeCenterPct = (i: number) => ((i + 0.5) / nodeCount) * 100;
  let currentIndex = 0;
  for (let i = 0; i < nodeCount; i += 1) if (level >= TIER_UNLOCKS[i].level) currentIndex = i;
  const currentNodeLevel = TIER_UNLOCKS[currentIndex].level;
  const nextNodeLevel = TIER_UNLOCKS[currentIndex + 1]?.level ?? currentNodeLevel;
  const intra = nextNodeLevel > currentNodeLevel
    ? Math.max(0, Math.min(1, (level - currentNodeLevel) / (nextNodeLevel - currentNodeLevel)))
    : 0;
  const firstCenter = nodeCenterPct(0);
  const fillCenter = currentIndex >= nodeCount - 1
    ? nodeCenterPct(nodeCount - 1)
    : nodeCenterPct(currentIndex) + intra * (nodeCenterPct(currentIndex + 1) - nodeCenterPct(currentIndex));

  return (
    <Panel title="XP & TIER LADDER" tag={`L${level} · ${tier.name}`} icon={<Medal className="h-4 w-4" />}>
      <div className="space-y-5 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="hairline rounded-sm bg-ink/30 p-3">
            <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-boneDim/55">Cash games</div>
            <div className="font-display text-xl text-bone">5 <span className="text-sm text-boneDim/55">XP / hand</span></div>
            <div className="mt-1 font-mono text-[10px] leading-relaxed text-boneDim/65">Awarded on cash-out.</div>
          </div>
          <div className="hairline rounded-sm bg-ink/30 p-3">
            <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-boneDim/55">Sit & Go</div>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-display text-xl text-amber">200</span>
              <span className="font-mono text-[10px] uppercase text-boneDim/55">win</span>
              <span className="font-display text-lg text-bone">75</span>
              <span className="font-mono text-[10px] uppercase text-boneDim/55">ITM</span>
              <span className="font-display text-lg text-boneDim/75">25</span>
              <span className="font-mono text-[10px] uppercase text-boneDim/55">bust</span>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-3 font-mono text-[9px] uppercase tracking-[0.2em] text-boneDim/55">Tier path</div>
          <div className="relative">
            <div
              className="absolute top-[22px] h-[2px] rounded-full bg-bone/10"
              style={{ left: `${firstCenter}%`, right: `${firstCenter}%` }}
            />
            <div
              className="absolute top-[22px] h-[2px] rounded-full"
              style={{
                left: `${firstCenter}%`,
                width: `${Math.max(0, fillCenter - firstCenter)}%`,
                background: `linear-gradient(90deg, ${tier.color}, ${tier.glow})`,
              }}
            />
            <div className="relative grid grid-cols-3 gap-2 sm:grid-cols-6">
              {TIER_UNLOCKS.map((unlock, index) => {
                const stopTier = tierForLevel(unlock.level);
                const reached = level >= unlock.level;
                const current =
                  (index === TIER_UNLOCKS.length - 1 && level >= unlock.level) ||
                  (level >= unlock.level && level < (TIER_UNLOCKS[index + 1]?.level ?? 999));
                return (
                  <div key={unlock.key} className="flex flex-col items-center text-center">
                    <div
                      className={cn('flex h-11 w-11 items-center justify-center rounded-full transition', reached ? '' : 'opacity-40 grayscale')}
                      style={{
                        background: reached ? `radial-gradient(circle, ${stopTier.glow}22, ${stopTier.color}12)` : 'rgba(16,20,26,0.6)',
                        border: `1.5px solid ${reached ? stopTier.color : 'rgba(255,255,255,0.08)'}`,
                        boxShadow: current ? `0 0 16px ${stopTier.glow}aa` : 'none',
                      }}
                    >
                      <span className="font-display text-[11px] tabular-nums" style={{ color: reached ? stopTier.color : '#6a6578' }}>
                        L{unlock.level}
                      </span>
                    </div>
                    <div className={cn('mt-1.5 font-mono text-[9px] uppercase tracking-[0.18em]', current ? 'text-orange' : reached ? 'text-bone' : 'text-boneDim/40')}>
                      {unlock.name}
                    </div>
                    <div className="mt-1 min-h-[28px] max-w-[110px] font-mono text-[8.5px] leading-snug text-boneDim/50">
                      {unlock.unlock}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="hairline rounded-sm bg-gradient-to-r from-orange/[0.04] to-transparent p-3">
          <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-boneDim/70">
            <span>Next: level {level + 1}</span>
            <span className="tabular-nums">{numberFmt.format(xpInLevel)} / {numberFmt.format(LEVEL_XP(level))}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink/60">
            <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: `linear-gradient(90deg, ${tier.color}, ${tier.glow})` }} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

function CareerStatsPanel({ stats }: { stats: PublicOnChainProfile }) {
  const [mode, setMode] = useState<CareerMode>('all');
  const netProfitSol = (stats.indexerTotalWinnings - stats.indexerTotalInvested) / 1e9;
  const cashNetSol = stats.indexerCashNetSol / 1e9;
  const sngNetSol = stats.indexerSngProfitSol / 1e9;
  const roi = stats.tournamentsPlayed > 0 && stats.indexerTotalInvested > 0
    ? (stats.indexerTotalWinnings - stats.indexerTotalInvested) / stats.indexerTotalInvested
    : null;
  const tiles =
    mode === 'cash'
      ? [
          { label: 'Sessions', value: numberFmt.format(stats.indexerCashSessions) },
          { label: 'Hands', value: numberFmt.format(stats.handsPlayed) },
          { label: 'Won', value: numberFmt.format(stats.handsWon) },
          { label: 'Net', value: formatSol(cashNetSol), tone: cashNetSol >= 0 ? 'emerald' : 'rose' },
        ]
      : mode === 'sng'
        ? [
            { label: 'Tourneys', value: numberFmt.format(stats.tournamentsPlayed) },
            { label: 'Wins', value: numberFmt.format(stats.tournamentsWon), tone: 'amber' },
            { label: 'ITM %', value: stats.tournamentsPlayed > 0 ? `${((stats.indexerItmCount / stats.tournamentsPlayed) * 100).toFixed(1)}%` : '--' },
            { label: 'ROI', value: roi !== null ? `${roi >= 0 ? '+' : ''}${(roi * 100).toFixed(1)}%` : '--', tone: roi !== null && roi >= 0 ? 'emerald' : 'rose' },
            { label: 'Net', value: formatSol(sngNetSol), tone: sngNetSol >= 0 ? 'emerald' : 'rose' },
            { label: '$FP earned', value: formatFp(stats.indexerTournamentPokerEarned, 6), tone: 'amber' },
          ]
        : [
            { label: 'Hands', value: numberFmt.format(stats.handsPlayed) },
            { label: 'Sessions', value: numberFmt.format(stats.indexerSessionsPlayed) },
            { label: 'Tourneys', value: numberFmt.format(stats.tournamentsPlayed) },
            { label: 'Net', value: formatSol(netProfitSol), tone: netProfitSol >= 0 ? 'emerald' : 'rose' },
          ];

  return (
    <Panel title="CAREER STATS" tag={`${numberFmt.format(stats.indexerSessionsPlayed)} SESSIONS`} icon={<BarChart3 className="h-4 w-4" />}>
      <div className="space-y-4 p-5">
        <div className="hairline grid grid-cols-3 gap-1 rounded-sm bg-ink/40 p-1">
          {([
            { id: 'all', label: 'ALL' },
            { id: 'cash', label: 'CASH' },
            { id: 'sng', label: 'SNG' },
          ] as { id: CareerMode; label: string }[]).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMode(tab.id)}
              className={cn(
                'rounded-sm py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] transition',
                mode === tab.id ? 'border border-orange/40 bg-orange/20 text-orange' : 'text-boneDim/60 hover:text-bone',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className={cn('grid gap-1.5', tiles.length > 4 ? 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6' : 'grid-cols-2 xl:grid-cols-4')}>
          {tiles.map((tile) => (
            <div key={tile.label} className="hairline min-w-0 rounded-sm bg-ink/30 p-2.5">
              <div className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-boneDim/55">{tile.label}</div>
              <div className={cn('mt-1.5 truncate font-display text-xl leading-none tabular-nums', toneClass(tile.tone as StatTone | undefined))}>
                {tile.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function PnlPanel({ earnings }: { earnings: EarningsRow[] }) {
  const points = useMemo(() => {
    const rows = [...earnings].reverse();
    let cumulative = 0;
    return rows.map((row) => {
      const amount = row.amount !== undefined ? asNumber(row.amount) / 1_000_000_000 : asNumber(row.netSol ?? row.profitSol ?? row.amountSol);
      const kind = String(row.kind || row.type || '');
      const delta = kind.includes('deposit') || kind.includes('buyin') ? -Math.abs(amount) : amount;
      cumulative += delta;
      return { cumulative, at: row.ts ?? row.timestamp };
    });
  }, [earnings]);

  const path = useMemo(() => {
    if (points.length < 2) return null;
    const width = 620;
    const height = 160;
    const min = Math.min(0, ...points.map((p) => p.cumulative));
    const max = Math.max(0, ...points.map((p) => p.cumulative));
    const span = Math.max(1, max - min);
    const coords = points.map((p, i) => {
      const x = (i / Math.max(1, points.length - 1)) * width;
      const y = height - ((p.cumulative - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return { d: `M ${coords.join(' L ')}`, width, height, final: points[points.length - 1].cumulative };
  }, [points]);

  return (
    <Panel title="PnL" tag={path ? formatSol(path.final) : 'NO SERIES'} icon={<BarChart3 className="h-4 w-4" />}>
      {path ? (
        <div className="p-5">
          <svg viewBox={`0 0 ${path.width} ${path.height}`} className="h-[180px] w-full overflow-visible">
            <line x1="0" x2={path.width} y1={path.height / 2} y2={path.height / 2} stroke="rgba(245,241,230,0.12)" strokeWidth="1" />
            <path d={path.d} fill="none" stroke={path.final >= 0 ? '#50DC78' : '#FF5A5A'} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="mt-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-boneDim/55">
            <span>{relativeLabel(points[0]?.at) || 'start'}</span>
            <span>{relativeLabel(points[points.length - 1]?.at) || 'latest'}</span>
          </div>
        </div>
      ) : (
        <EmptyState>No indexed PnL series yet.</EmptyState>
      )}
    </Panel>
  );
}

function FundHistoryPanel({ earnings }: { earnings: EarningsRow[] }) {
  return (
    <Panel title="FUND HISTORY" tag={`${earnings.length} ROWS`} icon={<History className="h-4 w-4" />}>
      {earnings.length === 0 ? (
        <EmptyState>No deposits, buy-ins, prizes, or cashouts indexed yet.</EmptyState>
      ) : (
        <div className="divide-y divide-white/[0.05]">
          {earnings.slice(0, 10).map((row, index) => {
            const amount = earningAmount(row);
            return (
              <div key={row._id || index} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-bone">
                    {rowString(row, ['kind', 'type'], 'session').replaceAll('_', ' ')}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[9px] text-boneDim/55">
                    {relativeLabel(row.ts ?? row.timestamp) || shortWallet(rowString(row, ['table', 'tablePda'], 'table'))}
                  </div>
                </div>
                <div className={cn('shrink-0 font-mono text-[11px] tabular-nums', toneClass(amount.tone))}>{amount.label}</div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function JackpotsPanel({ rows, stats }: { rows: unknown[]; stats: PublicOnChainProfile }) {
  const hitCount = rows.length;
  const largest = rows.reduce<number>((max, row) => Math.max(max, jackpotLamports(row)), 0);
  const grandCount = rows.filter(jackpotGrandHit).length;
  return (
    <Panel title="JACKPOTS" tag={`${hitCount} HITS`} icon={<Trophy className="h-4 w-4" />}>
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Hits" value={numberFmt.format(hitCount)} tone="amber" />
        <StatTile label="Largest" value={formatLamports(largest)} tone="emerald" />
        <StatTile label="Grand/Royal" value={numberFmt.format(grandCount)} tone="orange" />
        <StatTile label="Made hands" value={numberFmt.format(stats.indexerRoyalCount + stats.indexerStraightFlushCount + stats.indexerQuadsCount)} />
      </div>
      {rows.length > 0 && (
        <div className="divide-y divide-white/[0.05] border-t border-white/[0.05]">
          {rows.slice(0, 5).map((row, index) => (
            <div key={index} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-bone">
                  {rowString(row, ['kind', 'jackpotType', 'type'], 'jackpot')}
                </div>
                <div className="mt-0.5 truncate font-mono text-[9px] text-boneDim/55">
                  {relativeLabel(rowField(row, ['timestamp', 'ts', 'createdAt', 'settledAt'])) || shortWallet(rowString(row, ['table', 'tablePda'], 'table'))}
                </div>
              </div>
              <div className="font-mono text-[11px] text-emerald-300">{formatLamports(jackpotLamports(row))}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function AchievementIcon({ achievement }: { achievement: AchievementDef }) {
  const style = ACHIEVEMENT_TIER_STYLE[achievement.tier];
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border"
      style={{
        color: achievement.earned ? style.color : 'rgba(245,241,230,0.35)',
        borderColor: achievement.earned ? `${style.color}55` : 'rgba(255,255,255,0.06)',
        background: achievement.earned ? `${style.color}18` : 'rgba(16,20,26,0.6)',
      }}
    >
      <Medal className="h-4 w-4" />
    </div>
  );
}

function AchievementsPanel({ achievements }: { achievements: AchievementDef[] }) {
  const [filter, setFilter] = useState<'all' | 'earned' | 'locked'>('all');
  const earnedCount = achievements.filter((a) => a.earned).length;
  const filtered =
    filter === 'earned'
      ? achievements.filter((a) => a.earned)
      : filter === 'locked'
        ? achievements.filter((a) => !a.earned)
        : achievements;

  return (
    <Panel title="ACHIEVEMENTS" tag={`${earnedCount}/${achievements.length}`} icon={<Medal className="h-4 w-4" />}>
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-[180px] flex-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-ink/60">
              <div
                className="h-full rounded-full"
                style={{ width: `${achievements.length ? (earnedCount / achievements.length) * 100 : 0}%`, background: 'linear-gradient(90deg, #F26A1F, #FFC63A)' }}
              />
            </div>
          </div>
          <div className="hairline flex items-center gap-1 rounded-sm bg-ink/40 p-1">
            {(['all', 'earned', 'locked'] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={cn(
                  'rounded-sm px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.2em] transition',
                  filter === id ? 'bg-orange/20 text-orange' : 'text-boneDim/60 hover:text-bone',
                )}
              >
                {id}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((achievement) => {
            const style = ACHIEVEMENT_TIER_STYLE[achievement.tier];
            return (
              <div
                key={achievement.id}
                className={cn('hairline relative min-w-0 rounded-sm bg-ink/30 p-3', achievement.earned ? '' : 'opacity-70')}
                style={{ borderColor: achievement.earned ? `${style.color}35` : undefined }}
              >
                <div className="flex items-start gap-2.5">
                  <AchievementIcon achievement={achievement} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={cn('font-display text-sm leading-none', achievement.earned ? 'text-bone' : 'text-boneDim/65')}>{achievement.name}</span>
                      <span className="font-mono text-[8px] uppercase tracking-[0.22em]" style={{ color: achievement.earned ? style.color : 'rgba(245,241,230,0.35)' }}>
                        · {achievement.tier}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] leading-snug text-boneDim/60">{achievement.sub}</div>
                    {!achievement.earned && typeof achievement.progress === 'number' && (
                      <div className="mt-2">
                        <div className="h-1 overflow-hidden rounded-full bg-ink/60">
                          <div className="h-full rounded-full bg-boneDim/50" style={{ width: `${achievement.progress * 100}%` }} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

function CreatorTablesPanel({ tables }: { tables: unknown[] }) {
  return (
    <Panel title="CREATOR TABLES" tag={`${tables.length} TABLES`} icon={<Table2 className="h-4 w-4" />}>
      {tables.length === 0 ? (
        <EmptyState>No indexed creator tables for this wallet.</EmptyState>
      ) : (
        <div className="grid gap-2 p-5 md:grid-cols-2">
          {tables.slice(0, 8).map((row, index) => (
            <div key={index} className="hairline rounded-sm bg-ink/30 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-mono text-[10px] tracking-[0.14em] text-bone">{shortWallet(rowString(row, ['pubkey', 'tablePda', '_id'], 'table'))}</span>
                <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-boneDim/60">{rowString(row, ['phase', 'status'], 'table')}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-boneDim/55">
                <span>{rowString(row, ['gameTypeName', 'gameType'], 'cash')}</span>
                <span>{rowNumber(row, ['currentPlayers', 'playerCount'])}/{rowNumber(row, ['maxPlayers']) || '-'}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function buildDerived(data: PublicProfileData) {
  const stats: PublicPlayerStats = data.stats ?? {};
  const onChain = data.onChain;
  const level = levelFromXp(data.xp);
  const xpInLevel = Math.max(0, data.xp - xpForLevel(level));
  const jackpotsHit = data.jackpots.length;
  const largestSingleHitLamports = data.jackpots.reduce<number>((max, row) => Math.max(max, jackpotLamports(row)), 0);
  const achievements = deriveAchievements({
    handsPlayed: onChain.handsPlayed,
    handsWon: onChain.handsWon,
    tournamentsPlayed: onChain.tournamentsPlayed,
    tournamentsWon: onChain.tournamentsWon,
    solBalance: onChain.solBalance,
    level,
    licenses: onChain.dealerLicenseCount,
    wallet: data.wallet,
    royalCount: onChain.indexerRoyalCount || asNumber(stats.royalCount),
    straightFlushCount: onChain.indexerStraightFlushCount || asNumber(stats.straightFlushCount),
    quadsCount: onChain.indexerQuadsCount || asNumber(stats.quadsCount),
    bestWinStreak: onChain.indexerBestWinStreak || asNumber(stats.bestWinStreak),
    bestActiveDayStreak: onChain.indexerBestActiveDayStreak || asNumber(stats.bestActiveDayStreak),
    doubledUp: onChain.indexerDoubledUp || !!stats.doubledUp,
    allInPreflopWins: onChain.indexerAllInPreflopWins || asNumber(stats.allInPreflopWins),
    jackpotsHit,
    grandsHit: data.jackpots.filter(jackpotGrandHit).length,
    largestSingleHitLamports,
  });
  return { level, xpInLevel, achievements };
}

export function PublicProfilePage({ address }: PublicProfilePageProps) {
  const [data, setData] = useState<PublicProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    let wallet: string;
    try {
      wallet = new PublicKey(address).toBase58();
    } catch {
      setData(null);
      setError('Invalid wallet address');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    loadPublicProfile(wallet)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [address]);

  useEffect(() => {
    reload();
  }, [reload]);

  const derived = useMemo(() => (data ? buildDerived(data) : null), [data]);

  if (loading) return <LoadingState />;

  if (error || !data || !derived) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-12">
        <div className="hairline rounded-md bg-ink/50 p-6">
          <div className="flex items-center gap-2 text-rose-300">
            <AlertCircle className="h-4 w-4" />
            <div className="font-display text-xl tracking-wide">Profile unavailable</div>
          </div>
          <p className="mt-2 text-sm text-boneDim">{error ?? 'Could not load this wallet profile.'}</p>
          <button
            type="button"
            onClick={reload}
            className="mt-5 inline-flex items-center gap-2 rounded-md border border-orange/35 bg-orange/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-orange hover:bg-orange/15"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-ink">
      <div className="mx-auto w-full max-w-[1280px] space-y-5 px-4 py-6 pb-16 md:px-6 md:py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-bone/10 bg-ink/30 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-boneDim/40" />
            <span className="truncate font-mono text-[10px] uppercase tracking-[0.2em] text-boneDim/60">
              Viewing <span className="text-bone/80">{data.wallet}</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/lobby"
              className="inline-flex items-center gap-2 rounded-md border border-bone/15 bg-ink/40 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-boneDim hover:border-bone/30 hover:text-bone"
            >
              <Table2 className="h-3.5 w-3.5" />
              Lobby
            </Link>
            <button
              type="button"
              onClick={reload}
              className="inline-flex items-center gap-2 rounded-md border border-orange/35 bg-orange/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-orange hover:bg-orange/15"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </div>

        <IdentityCard
          wallet={data.wallet}
          level={derived.level}
          xpInLevel={derived.xpInLevel}
          registeredAt={data.onChain.registeredAt}
          isRegistered={data.onChain.isRegistered}
        />

        <HoldingsPanel wallet={data.wallet} stats={data.onChain} />

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-5">
            <XpLadder level={derived.level} xpInLevel={derived.xpInLevel} />
            <CareerStatsPanel stats={data.onChain} />
            <PnlPanel earnings={data.earnings} />
            <FundHistoryPanel earnings={data.earnings} />
          </div>
          <div className="space-y-5">
            <JackpotsPanel rows={data.jackpots} stats={data.onChain} />
            <CreatorTablesPanel tables={data.tables} />
            <Panel title="INDEXER STATUS" tag={data.stats ? 'FULL' : 'ON-CHAIN'} icon={<Clock3 className="h-4 w-4" />}>
              <div className="grid grid-cols-2 gap-3 p-4">
                <StatTile label="Sessions" value={numberFmt.format(data.onChain.indexerSessionsPlayed)} />
                <StatTile label="Cash net" value={formatSol(data.onChain.indexerCashNetSol / 1e9)} tone={data.onChain.indexerCashNetSol >= 0 ? 'emerald' : 'rose'} />
              </div>
            </Panel>
            <Panel title="TOKENS" tag="READ ONLY" icon={<Coins className="h-4 w-4" />}>
              <div className="grid grid-cols-2 gap-3 p-4">
                <StatTile label="Pending SOL" value={formatSol(data.onChain.pendingSolRewards)} />
                <StatTile label="Pending $FP" value={`${data.onChain.pendingPokerRewards.toFixed(2)} $FP`} tone="amber" />
              </div>
            </Panel>
          </div>
        </div>

        {ACHIEVEMENTS_ENABLED && <AchievementsPanel achievements={derived.achievements} />}
      </div>
    </main>
  );
}

export function ConnectedProfileLanding() {
  const { publicKey, isConnected } = useUnifiedWallet();
  const { open } = useConnectModal();
  const searchParams = useSearchParams();
  const addressParam = searchParams.get('address');

  if (addressParam) {
    return <PublicProfilePage address={addressParam} />;
  }

  if (isConnected && publicKey) {
    return <PublicProfilePage address={publicKey.toBase58()} />;
  }

  return (
    <main className="mx-auto flex min-h-[62vh] w-full max-w-3xl items-center px-4 py-12">
      <div className="hairline w-full rounded-md bg-ink/50 p-6 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-orange/30 bg-orange/10 text-orange">
          <Wallet className="h-5 w-5" />
        </div>
        <h1 className="mt-5 font-display text-3xl tracking-wide text-bone">Connect a wallet</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-boneDim">
          Public profiles read on-chain XP, wallet balances, and optional self-hosted indexer stats.
        </p>
        <button
          type="button"
          onClick={() => open()}
          className="mt-5 inline-flex items-center gap-2 rounded-md border border-orange/35 bg-orange/10 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-orange hover:bg-orange/15"
        >
          <Wallet className="h-3.5 w-3.5" />
          Connect wallet
        </button>
      </div>
    </main>
  );
}
