/**
 * Discover the cash tables a wallet created or is seated at — on-chain, no
 * backend. Scans seats (Seat.wallet @8 → Seat.table @72) and created tables
 * (Table.creator @290) across BOTH the poker program and the delegation program
 * (in-play tables are delegated, so they only show under the delegation program).
 *
 * getProgramAccounts is the expensive call (≈10 Helius credits each), and this
 * fires ~4 of them per discovery. So results are CACHED (60s) + single-flighted
 * so reopening the Cash / My Tables tabs doesn't re-bill the scan every time.
 * Needs a gPA-capable RPC (Helius/QuickNode); the free pool blocks gPA, so this
 * returns [] gracefully and callers fall back to paste/saved.
 *
 * Shared by CashStandalone and the Lobby creator-tables effect (previously each
 * had its own copy of this logic).
 */
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { makeL1Connection, ANCHOR_PROGRAM_ID, USDC_DEVNET_MINT, USDC_MAINNET_MINT } from './constants';
import { ACCOUNT_DISC } from './discriminators';
import { parseTableState, OnChainGameType, getMultipleAccountsInfoChunked, TABLE_OFFSETS, type TableState } from './onchain-game';
import { decodeV2Accounts, getProgramAccountsV2 } from './helius-tx';
import { getEffectiveRpcUrl } from './user-config';

const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const SEAT_WALLET_OFFSET = 8;
const SEAT_TABLE_OFFSET = 72;
const TABLE_CREATOR_OFFSET = 290;
const TABLE_DISC = ACCOUNT_DISC.Table;
const SEAT_DISC = ACCOUNT_DISC.PlayerSeat;

export interface DiscoveredTable {
  pubkey: string;
  state: TableState;
  /** Owned by the delegation program on L1 = currently delegated (in play). */
  isDelegated: boolean;
  isSeated: boolean;
  isCreated: boolean;
}

export interface LobbyDiscoveredTable {
  pubkey: string;
  phase: number;
  currentPlayers: number;
  snapshotCurrentPlayers: number;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  gameType: number;
  tier: number;
  pot: number;
  snapshotPot: number;
  handNumber: number;
  lastActionSlot: number;
  isDelegated: boolean;
  authority: string;
  creator: string;
  tokenEscrow: string;
  isUserCreated: boolean;
  rakeAccumulated: number;
  creatorRakeTotal: number;
  tokenMint: string;
  buyInType: number;
  rakeCap: number;
  isPrivate: boolean;
  location: 'L1' | 'TEE';
  liveStateSource: 'l1' | 'tee-pending';
  liveStateStale: boolean;
  decimals: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; tables: DiscoveredTable[] }>();
const inflight = new Map<string, Promise<DiscoveredTable[]>>();
const LOBBY_CACHE_TTL_MS = 30_000;
const lobbyCache = new Map<string, { at: number; tables: LobbyDiscoveredTable[] }>();
const lobbyInflight = new Map<string, Promise<LobbyDiscoveredTable[]>>();

const tableDiscFilter = {
  memcmp: {
    offset: 0,
    bytes: Buffer.from(TABLE_DISC).toString('base64'),
    encoding: 'base64' as const,
  },
};
const seatDiscFilter = {
  memcmp: {
    offset: 0,
    bytes: Buffer.from(SEAT_DISC).toString('base64'),
    encoding: 'base64' as const,
  },
};

function u8Filter(offset: number, value: number) {
  return {
    memcmp: {
      offset,
      bytes: Buffer.from([value]).toString('base64'),
      encoding: 'base64' as const,
    },
  };
}

async function getProgramAccountPubkeysViaV2(program: PublicKey, filters: any[]): Promise<string[]> {
  const rpcUrl = getEffectiveRpcUrl();
  if (!rpcUrl || rpcUrl === 'pool') return [];
  const out: string[] = [];
  let paginationKey: string | undefined;
  try {
    do {
      const page = await getProgramAccountsV2(rpcUrl, {
        programId: program.toBase58(),
        filters,
        dataSlice: { offset: 0, length: 0 },
        paginationKey,
      });
      for (const account of page.accounts) out.push(account.pubkey);
      paginationKey = page.paginationKey ?? undefined;
    } while (paginationKey);
  } catch {
    return [];
  }
  return out;
}

async function gpaPubkeys(conn: Connection, program: PublicKey, filters: any[]): Promise<string[]> {
  try {
    const accts = await conn.getProgramAccounts(program, { filters, dataSlice: { offset: 0, length: 0 } });
    return accts.map((a) => a.pubkey.toBase58());
  } catch {
    return getProgramAccountPubkeysViaV2(program, filters);
  }
}

async function gpaSeatTablePubkeys(conn: Connection, program: PublicKey, wallet: string): Promise<string[]> {
  const filters: any[] = [seatDiscFilter, { memcmp: { offset: SEAT_WALLET_OFFSET, bytes: wallet } }];
  try {
    const seats = await conn.getProgramAccounts(program, {
      filters,
      dataSlice: { offset: SEAT_TABLE_OFFSET, length: 32 },
    });
    return seats
      .filter((seat) => seat.account.data.length >= 32)
      .map((seat) => new PublicKey(Buffer.from(seat.account.data).subarray(0, 32)).toBase58());
  } catch {
    const rpcUrl = getEffectiveRpcUrl();
    if (!rpcUrl || rpcUrl === 'pool') return [];
    const out: string[] = [];
    let paginationKey: string | undefined;
    try {
      do {
        const page = await getProgramAccountsV2(rpcUrl, {
          programId: program.toBase58(),
          filters,
          dataSlice: { offset: SEAT_TABLE_OFFSET, length: 32 },
          paginationKey,
        });
        for (const account of decodeV2Accounts(page.accounts)) {
          if (account.data.length >= 32) {
            out.push(new PublicKey(account.data.subarray(0, 32)).toBase58());
          }
        }
        paginationKey = page.paginationKey ?? undefined;
      } while (paginationKey);
    } catch {
      return [];
    }
    return out;
  }
}

function isCurrentProgramTablePda(pubkey: PublicKey, data: Buffer): boolean {
  if (data.length < TABLE_OFFSETS.TABLE_ID + 32 || Buffer.compare(data.subarray(0, 8), TABLE_DISC) !== 0) {
    return false;
  }
  try {
    const tableIdBytes = data.subarray(TABLE_OFFSETS.TABLE_ID, TABLE_OFFSETS.TABLE_ID + 32);
    const [expectedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('table'), tableIdBytes],
      ANCHOR_PROGRAM_ID,
    );
    return expectedPda.equals(pubkey);
  } catch {
    return false;
  }
}

async function gpaTablePubkeys(
  conn: Connection,
  program: PublicKey,
  opts: { creator?: string; gameType?: number } = {},
): Promise<PublicKey[]> {
  const filters: any[] = [tableDiscFilter];
  if (opts.gameType !== undefined) filters.push(u8Filter(TABLE_OFFSETS.GAME_TYPE, opts.gameType));
  if (opts.creator) filters.push({ memcmp: { offset: TABLE_CREATOR_OFFSET, bytes: opts.creator } });
  try {
    const accounts = await conn.getProgramAccounts(program, {
      filters,
      dataSlice: { offset: 0, length: 0 },
    });
    return accounts.map((account) => account.pubkey);
  } catch {
    return (await getProgramAccountPubkeysViaV2(program, filters))
      .map((pubkey) => {
        try { return new PublicKey(pubkey); } catch { return null; }
      })
      .filter((pubkey): pubkey is PublicKey => !!pubkey);
  }
}

async function getMultipleAccountsInfoSmall(
  conn: Connection,
  keys: PublicKey[],
): Promise<Array<AccountInfo<Buffer> | null>> {
  const out: Array<AccountInfo<Buffer> | null> = [];
  const chunkSize = 25;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const infos = await conn.getMultipleAccountsInfo(keys.slice(i, i + chunkSize), 'confirmed');
    for (const info of infos) out.push(info as AccountInfo<Buffer> | null);
  }
  return out;
}

function defaultDecimalsForMint(mint: string): number {
  return mint === USDC_MAINNET_MINT.toBase58() || mint === USDC_DEVNET_MINT.toBase58() ? 6 : 9;
}

function readU64(data: Buffer, offset: number): number {
  return data.length >= offset + 8 ? Number(data.readBigUInt64LE(offset)) : 0;
}

function readPubkey(data: Buffer, offset: number): string {
  return data.length >= offset + 32 ? new PublicKey(data.subarray(offset, offset + 32)).toBase58() : '';
}

function parseLobbyTable(pubkey: PublicKey, info: AccountInfo<Buffer>): LobbyDiscoveredTable | null {
  const data = Buffer.from(info.data);
  if (!isCurrentProgramTablePda(pubkey, data)) return null;
  const state = parseTableState(data);
  if (!state) return null;

  const isDelegated = info.owner.equals(DELEGATION_PROGRAM_ID);
  const tokenMint = state.tokenMint || PublicKey.default.toBase58();
  return {
    pubkey: pubkey.toBase58(),
    phase: state.phase,
    currentPlayers: isDelegated ? 0 : state.currentPlayers,
    snapshotCurrentPlayers: state.currentPlayers,
    maxPlayers: state.maxPlayers,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    gameType: state.gameType,
    tier: state.tier,
    pot: isDelegated ? 0 : state.pot,
    snapshotPot: state.pot,
    handNumber: state.handNumber,
    lastActionSlot: state.lastActionTime,
    isDelegated,
    authority: state.authority.toBase58(),
    creator: state.creator.toBase58(),
    tokenEscrow: readPubkey(data, TABLE_OFFSETS.TOKEN_ESCROW),
    isUserCreated: data.length > TABLE_OFFSETS.IS_USER_CREATED ? data[TABLE_OFFSETS.IS_USER_CREATED] === 1 : false,
    rakeAccumulated: readU64(data, TABLE_OFFSETS.RAKE_ACCUMULATED),
    creatorRakeTotal: readU64(data, TABLE_OFFSETS.CREATOR_RAKE_TOTAL),
    tokenMint,
    buyInType: data.length > TABLE_OFFSETS.BUY_IN_TYPE ? data[TABLE_OFFSETS.BUY_IN_TYPE] : 0,
    rakeCap: readU64(data, TABLE_OFFSETS.RAKE_CAP),
    isPrivate: state.isPrivate,
    location: isDelegated ? 'TEE' : 'L1',
    liveStateSource: isDelegated ? 'tee-pending' : 'l1',
    liveStateStale: isDelegated,
    decimals: defaultDecimalsForMint(tokenMint),
  };
}

function rankLobbyTables(tables: LobbyDiscoveredTable[]): LobbyDiscoveredTable[] {
  return [...tables].sort((a, b) => {
    const active = Number((b.currentPlayers ?? 0) > 0) - Number((a.currentPlayers ?? 0) > 0);
    if (active) return active;
    const fillA = a.maxPlayers > 0 ? a.currentPlayers / a.maxPlayers : 0;
    const fillB = b.maxPlayers > 0 ? b.currentPlayers / b.maxPlayers : 0;
    if (fillA !== fillB) return fillB - fillA;
    if ((a.pot ?? 0) !== (b.pot ?? 0)) return (b.pot ?? 0) - (a.pot ?? 0);
    return a.pubkey.localeCompare(b.pubkey);
  });
}

async function runLobbyScan(opts: { creator?: string; gameType?: number; limit?: number }): Promise<LobbyDiscoveredTable[]> {
  const conn = makeL1Connection();
  const pubkeys = new Map<string, PublicKey>();
  const [delegatedPubkeys, undelegatedPubkeys] = await Promise.all([
    gpaTablePubkeys(conn, DELEGATION_PROGRAM_ID, opts),
    gpaTablePubkeys(conn, ANCHOR_PROGRAM_ID, opts),
  ]);
  for (const key of [...delegatedPubkeys, ...undelegatedPubkeys]) pubkeys.set(key.toBase58(), key);
  const keys = Array.from(pubkeys.values());
  if (keys.length === 0) return [];

  const infos = await getMultipleAccountsInfoSmall(conn, keys);
  const tables: LobbyDiscoveredTable[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const info = infos[i];
    if (!info) continue;
    if (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(ANCHOR_PROGRAM_ID)) continue;
    const parsed = parseLobbyTable(keys[i], info);
    if (!parsed) continue;
    if (opts.creator && parsed.creator !== opts.creator) continue;
    if (opts.gameType !== undefined && parsed.gameType !== opts.gameType) continue;
    tables.push(parsed);
  }
  const ranked = rankLobbyTables(tables);
  return opts.limit ? ranked.slice(0, opts.limit) : ranked;
}

async function run(wallet: string): Promise<DiscoveredTable[]> {
  const conn = makeL1Connection();
  const pdas = new Set<string>();
  const sources = new Map<string, { seat: boolean; creator: boolean }>();
  const mark = (pubkey: string, source: 'seat' | 'creator') => {
    pdas.add(pubkey);
    const current = sources.get(pubkey) ?? { seat: false, creator: false };
    current[source] = true;
    sources.set(pubkey, current);
  };

  for (const program of [ANCHOR_PROGRAM_ID, DELEGATION_PROGRAM_ID]) {
    // (a) tables I'm SEATED at: seat.wallet@8 → read seat.table@72
    for (const p of await gpaSeatTablePubkeys(conn, program, wallet)) {
      mark(p, 'seat');
    }

    // (b) tables I CREATED: table.creator@290 (idle tables have no seat rows)
    for (const p of await gpaPubkeys(conn, program, [
      tableDiscFilter,
      u8Filter(TABLE_OFFSETS.GAME_TYPE, OnChainGameType.CashGame),
      { memcmp: { offset: TABLE_CREATOR_OFFSET, bytes: wallet } },
    ])) {
      mark(p, 'creator');
    }
  }

  const list = [...pdas];
  const out: DiscoveredTable[] = [];
  if (list.length) {
    const infos = await getMultipleAccountsInfoChunked(conn, list.map((p) => new PublicKey(p)));
    infos.forEach((info, i) => {
      if (!info) return;
      const state = parseTableState(Buffer.from(info.data));
      if (!state || state.gameType !== OnChainGameType.CashGame) return;
      const source = sources.get(list[i]) ?? { seat: false, creator: false };
      out.push({
        pubkey: list[i],
        state,
        isDelegated: !info.owner.equals(ANCHOR_PROGRAM_ID),
        isSeated: source.seat,
        isCreated: source.creator,
      });
    });
  }
  return out;
}

/** Cash tables this wallet created or is seated at. Cached 60s + single-flight. */
export async function discoverMyCashTables(
  wallet: string,
  opts?: { force?: boolean },
): Promise<DiscoveredTable[]> {
  if (!opts?.force) {
    const hit = cache.get(wallet);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tables;
    const pending = inflight.get(wallet);
    if (pending) return pending;
  }
  const p = run(wallet)
    .then((tables) => {
      cache.set(wallet, { at: Date.now(), tables });
      return tables;
    })
    .finally(() => {
      inflight.delete(wallet);
    });
  inflight.set(wallet, p);
  return p;
}

/** Drop the cache (e.g. right after the user creates/joins a table). */
export function invalidateMyCashTables(wallet?: string): void {
  if (wallet) cache.delete(wallet);
  else cache.clear();
}

/**
 * Lobby-wide table registry for standalone FULL mode when `/api/tables/list`
 * cannot scan because the operator did not configure a server RPC. It uses the
 * player/browser RPC selected in Settings, keeps the gPA payload small by first
 * fetching pubkeys only, then reads table accounts in small batches.
 */
export async function discoverLobbyTables(
  opts: { creator?: string; gameType?: number; limit?: number; force?: boolean } = {},
): Promise<LobbyDiscoveredTable[]> {
  const key = JSON.stringify({ creator: opts.creator || '', gameType: opts.gameType ?? null, limit: opts.limit ?? 0 });
  if (!opts.force) {
    const hit = lobbyCache.get(key);
    if (hit && Date.now() - hit.at < LOBBY_CACHE_TTL_MS) return hit.tables;
    const pending = lobbyInflight.get(key);
    if (pending) return pending;
  }
  const p = runLobbyScan(opts)
    .catch(() => [])
    .then((tables) => {
      lobbyCache.set(key, { at: Date.now(), tables });
      return tables;
    })
    .finally(() => {
      lobbyInflight.delete(key);
    });
  lobbyInflight.set(key, p);
  return p;
}
