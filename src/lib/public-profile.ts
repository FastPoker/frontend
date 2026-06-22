'use client';

import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import {
  makeL1Connection,
  PLAYER_ACCOUNT_OFFSETS,
  POKER_MINT,
  POOL_PDA,
  STEEL_PROGRAM_ID,
} from '@/lib/constants';
import { getPlayerPda } from '@/lib/pda';
import { getLicensePda } from '@/lib/dealer-license';
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
  _id?: string;
  timestamp?: string | number;
  ts?: string | number;
  table?: string;
  kind?: string;
  type?: string;
  amount?: number;
  amountSol?: number;
  netSol?: number;
  profitSol?: number;
  tokenMint?: string;
  pokerEarned?: number;
}

export interface PublicOnChainProfile {
  isRegistered: boolean;
  handsPlayed: number;
  handsWon: number;
  tournamentsPlayed: number;
  tournamentsWon: number;
  xp: number;
  registeredAt: number;
  claimableSol: number;
  solBalance: number;
  pokerBalance: number;
  stakedAmount: number;
  unrefinedAmount: number;
  refinedAmount: number;
  pendingSolRewards: number;
  pendingPokerRewards: number;
  dealerLicenseCount: number;
  indexerSessionsPlayed: number;
  indexerCashSessions: number;
  indexerTotalInvested: number;
  indexerTotalWinnings: number;
  indexerCashNetSol: number;
  indexerSngProfitSol: number;
  indexerItmCount: number;
  indexerTournamentPokerEarned: number;
  indexerRoyalCount: number;
  indexerStraightFlushCount: number;
  indexerQuadsCount: number;
  indexerBestWinStreak: number;
  indexerBestActiveDayStreak: number;
  indexerDoubledUp: boolean;
  indexerAllInPreflopWins: number;
}

export interface PublicProfileData {
  wallet: string;
  stats: PublicPlayerStats | null;
  onChain: PublicOnChainProfile;
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
  return rowsFromAny(body, [key]);
}

function rowsFromAny(body: unknown, keys: string[]): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) return value;
    }
    const rows = record.rows;
    if (Array.isArray(rows)) return rows;
  }
  return [];
}

const PLAYER_CLAIMABLE_SOL_OFFSET = 91;

function numberFromStats(stats: PublicPlayerStats | null, key: keyof PublicPlayerStats): number {
  const value = stats?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function defaultOnChainProfile(): PublicOnChainProfile {
  return {
    isRegistered: false,
    handsPlayed: 0,
    handsWon: 0,
    tournamentsPlayed: 0,
    tournamentsWon: 0,
    xp: 0,
    registeredAt: 0,
    claimableSol: 0,
    solBalance: 0,
    pokerBalance: 0,
    stakedAmount: 0,
    unrefinedAmount: 0,
    refinedAmount: 0,
    pendingSolRewards: 0,
    pendingPokerRewards: 0,
    dealerLicenseCount: 0,
    indexerSessionsPlayed: 0,
    indexerCashSessions: 0,
    indexerTotalInvested: 0,
    indexerTotalWinnings: 0,
    indexerCashNetSol: 0,
    indexerSngProfitSol: 0,
    indexerItmCount: 0,
    indexerTournamentPokerEarned: 0,
    indexerRoyalCount: 0,
    indexerStraightFlushCount: 0,
    indexerQuadsCount: 0,
    indexerBestWinStreak: 0,
    indexerBestActiveDayStreak: 0,
    indexerDoubledUp: false,
    indexerAllInPreflopWins: 0,
  };
}

export async function readOnChainProfile(wallet: string): Promise<PublicOnChainProfile> {
  const out = defaultOnChainProfile();
  try {
    const walletPk = new PublicKey(wallet);
    const [playerPda] = getPlayerPda(walletPk);
    const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, walletPk);
    const [stakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('stake'), walletPk.toBuffer()],
      STEEL_PROGRAM_ID,
    );
    const [unrefinedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('unrefined'), walletPk.toBuffer()],
      STEEL_PROGRAM_ID,
    );
    const [licensePda] = getLicensePda(walletPk);
    const infos = await makeL1Connection().getMultipleAccountsInfo(
      [playerPda, tokenAccount, stakePda, unrefinedPda, POOL_PDA, walletPk, licensePda],
      'confirmed',
    );
    const [playerInfo, tokenInfo, stakeInfo, unrefinedInfo, poolInfo, walletInfo, licenseInfo] = infos;

    out.solBalance = (walletInfo?.lamports ?? 0) / 1e9;
    out.dealerLicenseCount = licenseInfo && licenseInfo.data.length > 0 ? 1 : 0;

    if (playerInfo && playerInfo.data.length >= 90) {
      const d = Buffer.from(playerInfo.data);
      out.isRegistered = d[40] === 1;
      out.handsPlayed = Number(d.readBigUInt64LE(42));
      out.handsWon = Number(d.readBigUInt64LE(50));
      out.tournamentsPlayed = d.readUInt32LE(74);
      out.tournamentsWon = d.readUInt32LE(78);
      out.xp =
        d.length >= PLAYER_ACCOUNT_OFFSETS.XP + 8
          ? Number(d.readBigUInt64LE(PLAYER_ACCOUNT_OFFSETS.XP))
          : 0;
      out.registeredAt = Number(d.readBigInt64LE(82));
      out.claimableSol =
        d.length >= PLAYER_CLAIMABLE_SOL_OFFSET + 8
          ? Number(d.readBigUInt64LE(PLAYER_CLAIMABLE_SOL_OFFSET))
          : 0;
    }

    if (tokenInfo && tokenInfo.data.length >= 72) {
      out.pokerBalance = Number(Buffer.from(tokenInfo.data).readBigUInt64LE(64)) / 1e9;
    }

    let burnedRaw = BigInt(0);
    let solRewardDebt = BigInt(0);
    let storedPendingSol = BigInt(0);
    if (stakeInfo && stakeInfo.data.length >= 72) {
      const sd = Buffer.from(stakeInfo.data);
      burnedRaw = sd.readBigUInt64LE(40);
      out.stakedAmount = Number(burnedRaw) / 1e9;
      const debtLo = sd.readBigUInt64LE(48);
      const debtHi = sd.readBigUInt64LE(56);
      solRewardDebt = (debtHi << BigInt(64)) | debtLo;
      storedPendingSol = sd.readBigUInt64LE(64);
    }

    let unrefinedRaw = BigInt(0);
    let storedRefined = BigInt(0);
    let refinedDebt = BigInt(0);
    if (unrefinedInfo && unrefinedInfo.data.length >= 72) {
      const ud = Buffer.from(unrefinedInfo.data);
      unrefinedRaw = ud.readBigUInt64LE(40);
      storedRefined = ud.readBigUInt64LE(48);
      const debtLo = ud.readBigUInt64LE(56);
      const debtHi = ud.readBigUInt64LE(64);
      refinedDebt = (debtHi << BigInt(64)) | debtLo;
      out.unrefinedAmount = Number(unrefinedRaw) / 1e6;
    }

    if (poolInfo && poolInfo.data.length >= 168) {
      const pd = Buffer.from(poolInfo.data);
      const accSolPerToken = (pd.readBigUInt64LE(104) << BigInt(64)) | pd.readBigUInt64LE(96);
      if (burnedRaw > BigInt(0)) {
        const accumulated = burnedRaw * accSolPerToken;
        const lazyPending =
          accumulated > solRewardDebt
            ? (accumulated - solRewardDebt) / BigInt(1_000_000_000_000)
            : BigInt(0);
        out.pendingSolRewards = Number(storedPendingSol + lazyPending) / 1e9;
      } else {
        out.pendingSolRewards = Number(storedPendingSol) / 1e9;
      }

      if (stakeInfo && stakeInfo.data.length >= 96 && burnedRaw > BigInt(0)) {
        const sd = Buffer.from(stakeInfo.data);
        const pokerRewardDebt = (sd.readBigUInt64LE(80) << BigInt(64)) | sd.readBigUInt64LE(72);
        const storedPendingPoker = sd.readBigUInt64LE(88);
        const accPokerPerToken = (pd.readBigUInt64LE(136) << BigInt(64)) | pd.readBigUInt64LE(128);
        const accumulated = burnedRaw * accPokerPerToken;
        const lazyPending =
          accumulated > pokerRewardDebt
            ? (accumulated - pokerRewardDebt) / BigInt(1_000_000_000_000)
            : BigInt(0);
        out.pendingPokerRewards = Number(storedPendingPoker + lazyPending) / 1e9;
      }

      if (unrefinedRaw > BigInt(0)) {
        const accRefined = (pd.readBigUInt64LE(160) << BigInt(64)) | pd.readBigUInt64LE(152);
        const pending = Number(
          (unrefinedRaw * accRefined - refinedDebt) / BigInt(1_000_000_000_000),
        );
        out.refinedAmount = (Number(storedRefined) + pending) / 1e6;
      } else {
        out.refinedAmount = Number(storedRefined) / 1e6;
      }
    } else {
      out.refinedAmount = Number(storedRefined) / 1e6;
      out.pendingSolRewards = Number(storedPendingSol) / 1e9;
    }

    return out;
  } catch {
    return out;
  }
}

export async function readPlayerXp(wallet: string): Promise<number> {
  return (await readOnChainProfile(wallet)).xp;
}

export async function loadPublicProfile(wallet: string): Promise<PublicProfileData> {
  const safeWallet = new PublicKey(wallet).toBase58();
  const [stats, earningsBody, tablesBody, tournamentsBody, jackpotsBody, onChain] = await Promise.all([
    fetchJson<PublicPlayerStats>(`player/${safeWallet}/stats`),
    fetchJson<unknown>(`player/${safeWallet}/earnings?limit=25`),
    fetchJson<unknown>(`player/${safeWallet}/tables?limit=20`),
    fetchJson<unknown>(`player/${safeWallet}/tournaments?limit=20`),
    fetchJson<unknown>(`jackpots/wallet/${safeWallet}?limit=200`),
    readOnChainProfile(safeWallet),
  ]);

  onChain.tournamentsPlayed = numberFromStats(stats, 'tournamentsPlayed') || onChain.tournamentsPlayed;
  onChain.tournamentsWon = numberFromStats(stats, 'tournamentsWon') || onChain.tournamentsWon;
  onChain.indexerSessionsPlayed = numberFromStats(stats, 'sessionsPlayed');
  onChain.indexerCashSessions = numberFromStats(stats, 'cashSessions');
  onChain.indexerTotalInvested = numberFromStats(stats, 'totalInvested');
  onChain.indexerTotalWinnings = numberFromStats(stats, 'totalWinnings');
  onChain.indexerCashNetSol = numberFromStats(stats, 'cashNetSol');
  onChain.indexerSngProfitSol = numberFromStats(stats, 'sngProfitSol');
  onChain.indexerItmCount = numberFromStats(stats, 'itmCount');
  onChain.indexerTournamentPokerEarned = numberFromStats(stats, 'tournamentPokerEarned');
  onChain.indexerRoyalCount = numberFromStats(stats, 'royalCount');
  onChain.indexerStraightFlushCount = numberFromStats(stats, 'straightFlushCount');
  onChain.indexerQuadsCount = numberFromStats(stats, 'quadsCount');
  onChain.indexerBestWinStreak = numberFromStats(stats, 'bestWinStreak');
  onChain.indexerBestActiveDayStreak = numberFromStats(stats, 'bestActiveDayStreak');
  onChain.indexerDoubledUp = !!stats?.doubledUp;
  onChain.indexerAllInPreflopWins = numberFromStats(stats, 'allInPreflopWins');
  onChain.handsPlayed = Math.max(onChain.handsPlayed, numberFromStats(stats, 'handReportsPlayed'));
  onChain.handsWon = Math.max(onChain.handsWon, numberFromStats(stats, 'handReportsWon'));

  return {
    wallet: safeWallet,
    stats,
    onChain,
    earnings: rowsFrom(earningsBody, 'earnings') as EarningsRow[],
    tables: rowsFrom(tablesBody, 'tables'),
    tournaments: rowsFrom(tournamentsBody, 'tournaments'),
    jackpots: rowsFromAny(jackpotsBody, ['hits', 'jackpots']),
    xp: onChain.xp,
  };
}
