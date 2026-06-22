'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PublicKey } from '@solana/web3.js';
import {
  AlertCircle,
  BarChart3,
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
import { AvatarRing, LEVEL_XP, levelFromXp, tierForLevel, xpForLevel } from '@/components/progression/AvatarRing';
import { PixelAvatar } from '@/components/profile/avatars/PixelAvatar';
import { ACHIEVEMENT_TIER_STYLE, deriveAchievements } from '@/lib/profile-data';
import { ACHIEVEMENTS_ENABLED } from '@/lib/feature-flags';
import { loadPublicProfile, shortWallet, type PublicPlayerStats, type PublicProfileData } from '@/lib/public-profile';
import { cn } from '@/lib/utils';

interface PublicProfilePageProps {
  address: string;
}

const numberFmt = new Intl.NumberFormat('en-US');
const solFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

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

function formatPoker(value: number): string {
  if (!value) return '0 $FP';
  return `${numberFmt.format(value / 1_000_000)} $FP`;
}

function timestampLabel(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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

function ProfileStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="hairline bg-ink/45 rounded-md px-3 py-3 min-w-0">
      <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-boneDim/60">{label}</div>
      <div className="mt-2 font-display text-[22px] leading-none tracking-wide text-bone tabular-nums truncate">{value}</div>
      {sub && <div className="mt-1 font-mono text-[9px] tracking-wider text-boneDim/55 truncate">{sub}</div>}
    </div>
  );
}

function Panel({
  title,
  icon,
  right,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md border border-bone/15 bg-ink/60 text-orange">{icon}</span>
        <h2 className="font-mono text-[10px] uppercase tracking-[0.24em] text-boneDim/75">{title}</h2>
        <div className="h-px flex-1 bg-bone/10" />
        {right}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="hairline rounded-md bg-ink/35 px-4 py-6 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-boneDim/55">
      {label}
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

export function PublicProfilePage({ address }: PublicProfilePageProps) {
  const [data, setData] = useState<PublicProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
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
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const derived = useMemo(() => {
    if (!data) return null;
    const stats: PublicPlayerStats = data.stats ?? {};
    const level = levelFromXp(data.xp);
    const xpInLevel = Math.max(0, data.xp - xpForLevel(level));
    const tier = tierForLevel(level);
    const handsPlayed = asNumber(stats.handReportsPlayed ?? stats.sessionsPlayed);
    const handsWon = asNumber(stats.handReportsWon);
    const jackpotsHit = data.jackpots.length;
    const largestSingleHitLamports = data.jackpots.reduce<number>((max, row) => Math.max(max, jackpotLamports(row)), 0);
    const achievements = deriveAchievements({
      handsPlayed,
      handsWon,
      tournamentsPlayed: asNumber(stats.tournamentsPlayed),
      tournamentsWon: asNumber(stats.tournamentsWon),
      solBalance: 0,
      level,
      licenses: 0,
      wallet: data.wallet,
      royalCount: asNumber(stats.royalCount),
      straightFlushCount: asNumber(stats.straightFlushCount),
      quadsCount: asNumber(stats.quadsCount),
      bestWinStreak: asNumber(stats.bestWinStreak),
      bestActiveDayStreak: asNumber(stats.bestActiveDayStreak),
      doubledUp: !!stats.doubledUp,
      allInPreflopWins: asNumber(stats.allInPreflopWins),
      jackpotsHit,
      grandsHit: data.jackpots.filter(jackpotGrandHit).length,
      largestSingleHitLamports,
    });
    return { level, xpInLevel, tier, handsPlayed, handsWon, jackpotsHit, largestSingleHitLamports, achievements };
  }, [data]);

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

  const earned = derived.achievements.filter((a) => a.earned);
  const recentEarned = earned.slice(0, 8);
  const nextAchievements = derived.achievements
    .filter((a) => !a.earned)
    .sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0))
    .slice(0, 6);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-7 md:py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-orange/80">Profile</div>
          <h1 className="mt-2 font-display text-4xl leading-none tracking-wide text-bone sm:text-5xl">
            {shortWallet(data.wallet)}
          </h1>
          <div className="mt-2 max-w-full truncate font-mono text-[10px] tracking-[0.14em] text-boneDim/65">{data.wallet}</div>
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

      <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <section className="hairline rounded-md bg-ink/55 p-5">
            <div className="flex items-center gap-4">
              <AvatarRing
                size={92}
                level={derived.level}
                xp={derived.xpInLevel}
                seed={data.wallet}
                innerNode={<PixelAvatar seed={data.wallet} size={92} />}
              />
              <div className="min-w-0">
                <div className="font-display text-2xl leading-none tracking-wide text-bone">@{shortWallet(data.wallet)}</div>
                <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: derived.tier.color }}>
                  LVL {derived.level} · {derived.tier.name}
                </div>
              </div>
            </div>
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-boneDim/65">
                <span>XP</span>
                <span>{numberFmt.format(derived.xpInLevel)} / {numberFmt.format(LEVEL_XP(derived.level))}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-bone/10">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(0, Math.min(100, (derived.xpInLevel / LEVEL_XP(derived.level)) * 100))}%`,
                    background: `linear-gradient(90deg, ${derived.tier.color}, ${derived.tier.glow})`,
                  }}
                />
              </div>
            </div>
          </section>

          <Panel title="Career" icon={<User className="h-3.5 w-3.5" />}>
            <div className="grid grid-cols-2 gap-2">
              <ProfileStat label="Hands" value={numberFmt.format(derived.handsPlayed)} />
              <ProfileStat label="Won" value={numberFmt.format(derived.handsWon)} />
              <ProfileStat label="SNGs" value={numberFmt.format(data.stats?.tournamentsPlayed ?? 0)} />
              <ProfileStat label="Wins" value={numberFmt.format(data.stats?.tournamentsWon ?? 0)} />
            </div>
          </Panel>

          <Panel title="Net" icon={<BarChart3 className="h-3.5 w-3.5" />}>
            <div className="grid grid-cols-1 gap-2">
              <ProfileStat label="Cash net" value={formatSol(data.stats?.cashNetSol ?? 0)} />
              <ProfileStat label="SNG profit" value={formatSol(data.stats?.sngProfitSol ?? 0)} />
              <ProfileStat label="$FP earned" value={formatPoker(data.stats?.tournamentPokerEarned ?? 0)} />
            </div>
          </Panel>
        </aside>

        <div className="space-y-6 min-w-0">
          {ACHIEVEMENTS_ENABLED && (
            <Panel
              title="Achievements"
              icon={<Medal className="h-3.5 w-3.5" />}
              right={<span className="font-mono text-[9px] uppercase tracking-[0.18em] text-orange/75">{earned.length}/{derived.achievements.length}</span>}
            >
              {earned.length === 0 && nextAchievements.length === 0 ? (
                <EmptyState label="No indexed achievements yet" />
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {[...recentEarned, ...nextAchievements].map((achievement) => {
                    const style = ACHIEVEMENT_TIER_STYLE[achievement.tier];
                    return (
                      <div
                        key={achievement.id}
                        className={cn(
                          'hairline rounded-md bg-ink/45 px-3 py-3 min-w-0',
                          achievement.earned ? 'border-orange/35' : 'opacity-70',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-display text-[16px] leading-none tracking-wide text-bone truncate">{achievement.name}</div>
                          <span className="font-mono text-[8px] uppercase tracking-[0.18em]" style={{ color: style.color }}>
                            {achievement.earned ? 'earned' : `${Math.round((achievement.progress ?? 0) * 100)}%`}
                          </span>
                        </div>
                        <div className="mt-1 line-clamp-2 text-[12px] leading-snug text-boneDim/70">{achievement.sub}</div>
                        {!achievement.earned && (
                          <div className="mt-2 h-1 overflow-hidden rounded-full bg-bone/10">
                            <div className="h-full rounded-full" style={{ width: `${Math.round((achievement.progress ?? 0) * 100)}%`, background: style.color }} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          )}

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel title="Recent Earnings" icon={<History className="h-3.5 w-3.5" />}>
              {data.earnings.length === 0 ? (
                <EmptyState label="No indexed earnings yet" />
              ) : (
                <div className="hairline rounded-md bg-ink/35">
                  {data.earnings.slice(0, 8).map((row, index) => {
                    const net = rowNumber(row, ['netSol', 'profitSol', 'amountSol']);
                    return (
                      <div key={index} className="flex items-center justify-between gap-3 border-b border-bone/10 px-3 py-2.5 last:border-b-0">
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-bone">{rowString(row, ['type', 'kind'], 'session')}</div>
                          <div className="mt-0.5 truncate font-mono text-[9px] text-boneDim/55">{timestampLabel(rowField(row, ['timestamp', 'createdAt', 'endedAt'])) || shortWallet(rowString(row, ['table', 'tablePda'], data.wallet))}</div>
                        </div>
                        <div className={cn('font-mono text-[11px] tabular-nums', net >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                          {net >= 0 ? '+' : ''}{formatSol(net)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>

            <Panel title="Jackpots" icon={<Trophy className="h-3.5 w-3.5" />}>
              <div className="grid grid-cols-2 gap-2">
                <ProfileStat label="Hits" value={numberFmt.format(derived.jackpotsHit)} />
                <ProfileStat label="Largest" value={formatSol(derived.largestSingleHitLamports / 1_000_000_000)} />
                <ProfileStat label="Royal hands" value={numberFmt.format(data.stats?.royalCount ?? 0)} />
                <ProfileStat label="Quads" value={numberFmt.format(data.stats?.quadsCount ?? 0)} />
              </div>
            </Panel>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel title="Tables" icon={<Table2 className="h-3.5 w-3.5" />}>
              {data.tables.length === 0 ? (
                <EmptyState label="No indexed tables yet" />
              ) : (
                <div className="grid gap-2">
                  {data.tables.slice(0, 6).map((row, index) => (
                    <div key={index} className="hairline rounded-md bg-ink/35 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate font-mono text-[10px] tracking-[0.14em] text-bone">{shortWallet(rowString(row, ['pubkey', 'tablePda', '_id'], data.wallet))}</span>
                        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-boneDim/60">{rowString(row, ['phase', 'status'], 'table')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Tournaments" icon={<Wallet className="h-3.5 w-3.5" />}>
              {data.tournaments.length === 0 ? (
                <EmptyState label="No indexed tournaments yet" />
              ) : (
                <div className="grid gap-2">
                  {data.tournaments.slice(0, 6).map((row, index) => (
                    <div key={index} className="hairline rounded-md bg-ink/35 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate font-mono text-[10px] tracking-[0.14em] text-bone">{rowString(row, ['name', 'tablePda', '_id'], 'SNG')}</span>
                        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-boneDim/60">{rowString(row, ['result', 'status', 'place'], 'played')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </div>
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
          Public profiles are wallet-bound and read from on-chain XP plus the operator's standalone indexer.
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
