'use client';

import { PublicKey } from '@solana/web3.js';
import { makeL1Connection, PLAYER_ACCOUNT_OFFSETS } from '@/lib/constants';
import { getPlayerPda } from '@/lib/pda';
import { INDEXER_API_ENABLED } from '@/lib/feature-flags';

export interface PublicPlayerStats {
  _id?: string;
  registeredAt?: string | number;
  lastActive?: string | number;
  cashSessions?: number;
  sngSessions?: number;
  sessionsPlayed?: number;
  totalInvested?: number;
  totalWinnings?: number;
  cashNetSol?: number;
  tournamentsPlayed?: number;
  tournamentsWon?: number;
  itmCount?: number;
  sngProfitSol?: number;
  tournamentPokerEarned?: number;
  royalCount?: number;
  straightFlushCount?: number;
  quadsCount?: number;
  bestWinStreak?: number;
  bestActiveDayStreak?: number;
  doubledUp?: boolean;
  allInPreflopWins?: number;
  handReportsPlayed?: number;
  handReportsWon?: number;
}

export interface EarningsRow {
  timestamp?: string | number;
  table?: string;
  type?: string;
  amountSol?: number;
  netSol?: number;
  profitSol?: number;
  pokerEarned?: number;
}

export interface PublicProfileData {
  wallet: string;
  stats: PublicPlayerStats | null;
  earnings: EarningsRow[];
  tables: unknown[];
  tournaments: unknown[];
  jackpots: unknown[];
  xp: number;
}

export function shortWallet(addr: string, n = 4): string {
  return `${addr.slice(0, n)}...${addr.slice(-n)}`;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  if (!INDEXER_API_ENABLED) return null;
  try {
    const res = await fetch(`/api/indexer/${path}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

function rowsFrom(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const value = (body as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
    const rows = (body as Record<string, unknown>).rows;
    if (Array.isArray(rows)) return rows;
  }
  return [];
}

export async function readPlayerXp(wallet: string): Promise<number> {
  try {
    const walletPk = new PublicKey(wallet);
    const [playerPda] = getPlayerPda(walletPk);
    const info = await makeL1Connection().getAccountInfo(playerPda, 'confirmed');
    if (!info || info.data.length < PLAYER_ACCOUNT_OFFSETS.XP + 8) return 0;
    return Number(Buffer.from(info.data).readBigUInt64LE(PLAYER_ACCOUNT_OFFSETS.XP));
  } catch {
    return 0;
  }
}

export async function loadPublicProfile(wallet: string): Promise<PublicProfileData> {
  const safeWallet = new PublicKey(wallet).toBase58();
  const [stats, earningsBody, tablesBody, tournamentsBody, jackpotsBody, xp] = await Promise.all([
    fetchJson<PublicPlayerStats>(`player/${safeWallet}/stats`),
    fetchJson<unknown>(`player/${safeWallet}/earnings?limit=25`),
    fetchJson<unknown>(`player/${safeWallet}/tables?limit=20`),
    fetchJson<unknown>(`player/${safeWallet}/tournaments?limit=20`),
    fetchJson<unknown>(`jackpots/wallet/${safeWallet}?limit=200`),
    readPlayerXp(safeWallet),
  ]);

  return {
    wallet: safeWallet,
    stats,
    earnings: rowsFrom(earningsBody, 'earnings') as EarningsRow[],
    tables: rowsFrom(tablesBody, 'tables'),
    tournaments: rowsFrom(tournamentsBody, 'tournaments'),
    jackpots: rowsFrom(jackpotsBody, 'jackpots'),
    xp,
  };
}
