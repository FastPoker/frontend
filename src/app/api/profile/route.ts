import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import { getL1Rpc } from '@/lib/rpc-config';
import { PLAYER_ACCOUNT_OFFSETS, levelFromXp } from '@/lib/constants';
import { getPlayerPda } from '@/lib/pda';
import { getIndexerBaseUrl, indexerReadsEnabled } from '@/lib/indexer-env';

export const dynamic = 'force-dynamic';

const INDEXER_BASE = getIndexerBaseUrl();
const INDEXER_ENABLED = indexerReadsEnabled();
const MAX_BATCH = 50;

type IndexerStats = Record<string, unknown>;

function shortWallet(addr: string, n = 4): string {
  return `${addr.slice(0, n)}...${addr.slice(-n)}`;
}

function xpForLevel(level: number): number {
  const thresholds = [0, 0, 100, 300, 600, 1100, 2000, 3500, 6000, 10000, 20000, 40000, 80000, 150000];
  if (level <= 0) return 0;
  if (level < thresholds.length) return thresholds[level];
  const last = thresholds[thresholds.length - 1];
  return Math.round(last * Math.pow(1.4, level - (thresholds.length - 1)));
}

function numberField(stats: IndexerStats | null, key: string): number {
  const value = stats?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseWallet(value: string | null): PublicKey | null {
  if (!value) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

async function fetchIndexerStats(wallet: string): Promise<IndexerStats | null> {
  if (!INDEXER_ENABLED || !INDEXER_BASE) return null;
  try {
    const res = await fetch(new URL(`/player/${wallet}/stats`, INDEXER_BASE).toString(), {
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' ? body as IndexerStats : null;
  } catch {
    return null;
  }
}

async function fetchOnChainXp(walletPk: PublicKey): Promise<number> {
  let rpc: string;
  try {
    rpc = getL1Rpc();
  } catch {
    return 0;
  }
  try {
    const [playerPda] = getPlayerPda(walletPk);
    const info = await new Connection(rpc, 'confirmed').getAccountInfo(playerPda, 'confirmed');
    if (!info || info.data.length < PLAYER_ACCOUNT_OFFSETS.XP + 8) return 0;
    return Number(Buffer.from(info.data).readBigUInt64LE(PLAYER_ACCOUNT_OFFSETS.XP));
  } catch {
    return 0;
  }
}

async function buildProfile(walletPk: PublicKey) {
  const wallet = walletPk.toBase58();
  const [stats, xp] = await Promise.all([
    fetchIndexerStats(wallet),
    fetchOnChainXp(walletPk),
  ]);
  const level = levelFromXp(xp);
  const xpInLevel = Math.max(0, xp - xpForLevel(level));
  const handle = shortWallet(wallet);

  return {
    wallet,
    username: handle,
    handle,
    avatarType: 'generated',
    avatarValue: wallet,
    avatarSeed: wallet,
    avatarImageUrl: '',
    avatarUrl: '',
    avatarCollection: '',
    avatarCollectionColor: '',
    level,
    xp,
    xpInLevel,
    handsWon: numberField(stats, 'handReportsWon') || numberField(stats, 'handsWon'),
    stats: stats ?? {},
    source: stats ? 'indexer' : 'wallet',
  };
}

export async function GET(request: NextRequest) {
  const walletPk = parseWallet(request.nextUrl.searchParams.get('wallet'));
  if (!walletPk) {
    return NextResponse.json({ error: 'invalid wallet' }, { status: 400 });
  }
  return NextResponse.json(await buildProfile(walletPk));
}

export async function PUT(request: NextRequest) {
  let wallets: unknown;
  try {
    wallets = (await request.json())?.wallets;
  } catch {
    wallets = [];
  }
  const parsed = Array.isArray(wallets)
    ? wallets
      .filter((w): w is string => typeof w === 'string')
      .slice(0, MAX_BATCH)
      .map((w) => parseWallet(w))
      .filter((w): w is PublicKey => !!w)
    : [];

  const profiles: Record<string, Awaited<ReturnType<typeof buildProfile>>> = {};
  await Promise.all(parsed.map(async (walletPk) => {
    profiles[walletPk.toBase58()] = await buildProfile(walletPk);
  }));

  return NextResponse.json({ profiles });
}
