import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import { getL1Rpc } from '@/lib/rpc-config';
import { ACCOUNT_DISC } from '@/lib/discriminators';
import { ANCHOR_PROGRAM_ID } from '@/lib/constants';
import { getProgramAccountsV2, decodeV2Accounts } from '@/lib/helius-tx';

export const dynamic = 'force-dynamic';

const PROGRAM_ID = ANCHOR_PROGRAM_ID;
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const SEAT_DISC = ACCOUNT_DISC.PlayerSeat;
const TABLE_DISC = ACCOUNT_DISC.Table;

const SEAT_OFF = {
  WALLET: 8,
  TABLE: 72,
  SEAT_NUMBER: 226,
  STATUS: 227,
} as const;

const TABLE_OFF = {
  TABLE_ID: 8,
  GAME_TYPE: 104,
  MAX_PLAYERS: 121,
  PHASE: 160,
  SEATS_OCCUPIED: 250,
  TIER: 360,
} as const;

type SeatEntry = { tablePda: string; seatNumber: number };
type ActiveTableRow = {
  tablePda: string;
  gameType: number;
  maxPlayers: number;
  phase: number;
  tier: number;
  type: 'heads_up' | '6max' | '9max' | 'cash';
};

const cache = new Map<string, { tables: ActiveTableRow[]; ts: number }>();

function getRpcAndConnection(): { rpcUrl: string; conn: Connection } | null {
  try {
    const rpcUrl = getL1Rpc();
    return { rpcUrl, conn: new Connection(rpcUrl, 'confirmed') };
  } catch {
    return null;
  }
}

async function gpaAll(
  rpcUrl: string,
  conn: Connection,
  programId: PublicKey,
  filters: Array<{ memcmp: { offset: number; bytes: string; encoding?: 'base58' | 'base64' } }>,
): Promise<Array<{ pubkey: string; data: Buffer }>> {
  const out: Array<{ pubkey: string; data: Buffer }> = [];
  let paginationKey: string | undefined;
  try {
    do {
      const page = await getProgramAccountsV2(rpcUrl, {
        programId: programId.toBase58(),
        filters,
        paginationKey,
      });
      for (const account of decodeV2Accounts(page.accounts)) {
        out.push({ pubkey: account.pubkey, data: account.data });
      }
      paginationKey = page.paginationKey ?? undefined;
    } while (paginationKey);
    return out;
  } catch {
    // Non-Helius RPCs usually do not implement getProgramAccountsV2.
  }

  const accounts = await conn.getProgramAccounts(programId, { filters }).catch(() => []);
  return accounts.map((account) => ({
    pubkey: account.pubkey.toBase58(),
    data: Buffer.from(account.account.data),
  }));
}

function tableType(gameType: number): ActiveTableRow['type'] {
  return gameType === 0 ? 'heads_up' : gameType === 1 ? '6max' : gameType === 2 ? '9max' : 'cash';
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const wallet = url.searchParams.get('wallet');
    if (!wallet) return NextResponse.json({ tables: [] });

    const force = url.searchParams.has('force');
    if (!force) {
      const entry = cache.get(wallet);
      if (entry && Date.now() - entry.ts < 30_000) {
        return NextResponse.json({ tables: entry.tables, cached: true, serverRpcConfigured: true });
      }
    }

    const rpc = getRpcAndConnection();
    if (!rpc) {
      return NextResponse.json({ tables: [], serverRpcConfigured: false });
    }

    const walletPk = new PublicKey(wallet);
    const seatFilters = [
      { memcmp: { offset: 0, bytes: Buffer.from(SEAT_DISC).toString('base64'), encoding: 'base64' as const } },
      { memcmp: { offset: SEAT_OFF.WALLET, bytes: walletPk.toBase58() } },
    ];

    const [delegatedSeats, undelegatedSeats] = await Promise.all([
      gpaAll(rpc.rpcUrl, rpc.conn, DELEGATION_PROGRAM_ID, seatFilters),
      gpaAll(rpc.rpcUrl, rpc.conn, PROGRAM_ID, seatFilters),
    ]);

    const seatEntries: SeatEntry[] = [];
    for (const { data } of [...delegatedSeats, ...undelegatedSeats]) {
      if (data.length < 228) continue;
      const status = data[SEAT_OFF.STATUS];
      if (status === 0 || status === 5 || status === 6) continue;
      seatEntries.push({
        tablePda: new PublicKey(data.subarray(SEAT_OFF.TABLE, SEAT_OFF.TABLE + 32)).toBase58(),
        seatNumber: data[SEAT_OFF.SEAT_NUMBER],
      });
    }

    if (seatEntries.length === 0) {
      cache.set(wallet, { tables: [], ts: Date.now() });
      return NextResponse.json({ tables: [], serverRpcConfigured: true });
    }

    const uniqueTablePdas = Array.from(new Set(seatEntries.map((entry) => entry.tablePda)));
    const keys = uniqueTablePdas.map((pda) => new PublicKey(pda));
    const tableInfos = await rpc.conn.getMultipleAccountsInfo(keys).catch(() => keys.map(() => null));

    const tableMeta: Record<string, {
      gameType: number;
      maxPlayers: number;
      phase: number;
      seatsOccupied: number;
      tier: number;
    }> = {};

    for (let i = 0; i < keys.length; i += 1) {
      const info = tableInfos[i];
      if (!info) continue;
      const data = Buffer.from(info.data);
      if (data.length < 256 || Buffer.compare(data.subarray(0, 8), TABLE_DISC) !== 0) continue;
      if (!info.owner.equals(PROGRAM_ID) && !info.owner.equals(DELEGATION_PROGRAM_ID)) continue;
      try {
        const tableIdBytes = data.subarray(TABLE_OFF.TABLE_ID, TABLE_OFF.TABLE_ID + 32);
        const [expectedPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('table'), tableIdBytes],
          PROGRAM_ID,
        );
        if (!expectedPda.equals(keys[i])) continue;
      } catch {
        continue;
      }
      tableMeta[keys[i].toBase58()] = {
        gameType: data[TABLE_OFF.GAME_TYPE],
        maxPlayers: data[TABLE_OFF.MAX_PLAYERS],
        phase: data[TABLE_OFF.PHASE],
        seatsOccupied: data.readUInt16LE(TABLE_OFF.SEATS_OCCUPIED),
        tier: data.length > TABLE_OFF.TIER ? data[TABLE_OFF.TIER] : 0,
      };
    }

    const keptTablePdas = new Set<string>();
    for (const entry of seatEntries) {
      const meta = tableMeta[entry.tablePda];
      if (!meta) continue;
      if ((meta.seatsOccupied & (1 << entry.seatNumber)) === 0) continue;
      keptTablePdas.add(entry.tablePda);
    }

    const tables: ActiveTableRow[] = [];
    for (const tablePda of keptTablePdas) {
      const meta = tableMeta[tablePda];
      tables.push({
        tablePda,
        gameType: meta.gameType,
        maxPlayers: meta.maxPlayers,
        phase: meta.phase,
        tier: meta.tier,
        type: tableType(meta.gameType),
      });
    }

    cache.set(wallet, { tables, ts: Date.now() });
    return NextResponse.json({ tables, serverRpcConfigured: true });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'active table lookup failed', tables: [] }, { status: 500 });
  }
}
