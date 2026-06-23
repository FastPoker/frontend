import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import { getTeeConnection } from '@/lib/tee-auth-server';
import { getL1Rpc } from '@/lib/rpc-config';
import { ACCOUNT_DISC } from '@/lib/discriminators';
import {
  discoverViaIndexer,
  fetchRawTablesViaIndexer,
  fetchTablesByPubkey,
  type TableEntry,
  type RawTablesIndexerStatus,
} from '@/lib/indexer-client';
import { attachTokenDecimals } from '@/lib/mint-decimals';
import { getTableBlacklist } from '@/lib/table-blacklist';
import { ANCHOR_PROGRAM_ID } from '@/lib/constants';
import { indexerReadsEnabled } from '@/lib/indexer-env';
import { decodeV2Accounts, getProgramAccountsV2 } from '@/lib/helius-tx';

export const dynamic = 'force-dynamic';

const PROGRAM_ID = ANCHOR_PROGRAM_ID;
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const TABLE_DISC = ACCOUNT_DISC.Table;

const OFF = {
  TABLE_ID:          8,
  AUTHORITY:        40,
  GAME_TYPE:       104,
  SMALL_BLIND:     105,
  BIG_BLIND:       113,
  MAX_PLAYERS:     121,
  CURRENT_PLAYERS: 122,
  HAND_NUMBER:     123,
  POT:             131,
  RAKE_ACCUMULATED: 147,
  PHASE:           160,
  LAST_ACTION_SLOT: 166,
  TIER:            360,
  TOKEN_ESCROW:    258,
  CREATOR:         290,
  IS_USER_CREATED: 322,
  CREATOR_RAKE_TOTAL: 323,
  TOKEN_MINT:      385,
  BUY_IN_TYPE:     417,
  RAKE_CAP:        418,
  IS_PRIVATE:      426,
} as const;

const discFilter = {
  memcmp: {
    offset: 0,
    bytes: Buffer.from(TABLE_DISC).toString('base64'),
    encoding: 'base64' as const,
  },
};

let responseCache: { data: any; ts: number } | null = null;
let backgroundRefreshInProgress = false;
let backgroundIntervalStarted = false;
let backgroundRefreshPromise: Promise<void> | null = null;
const REFRESH_INTERVAL_MS = 60_000;

type TableSnapshot = {
  snapshotId: string;
  filterHash: string;
  rows: any[];
  createdAt: number;
};

const SNAPSHOT_TTL_MS = 60_000;
const SNAPSHOT_MAX = 100;
const tableSnapshots = new Map<string, TableSnapshot>();

type TeeOverlayResult = {
  attempted: number;
  updated: number;
  stale: number;
  error?: string;
};

const emptyTeeOverlay: TeeOverlayResult = { attempted: 0, updated: 0, stale: 0 };

function getL1Connection(): Connection | null {
  try {
    return new Connection(getL1Rpc(), 'confirmed');
  } catch {
    return null;
  }
}

function getL1RpcUrl(): string {
  try {
    return getL1Rpc();
  } catch {
    return '';
  }
}

async function getProgramAccountPubkeys(
  rpcUrl: string,
  l1: Connection,
  programId: PublicKey,
  filters: any[],
): Promise<PublicKey[]> {
  try {
    const accounts = await l1.getProgramAccounts(programId, {
      filters,
      dataSlice: { offset: 0, length: 0 },
    });
    return accounts.map((account) => account.pubkey);
  } catch {
    if (!rpcUrl) return [];
  }

  const out: PublicKey[] = [];
  let paginationKey: string | undefined;
  try {
    do {
      const page = await getProgramAccountsV2(rpcUrl, {
        programId: programId.toBase58(),
        filters,
        dataSlice: { offset: 0, length: 0 },
        paginationKey,
      });
      for (const account of page.accounts) {
        try { out.push(new PublicKey(account.pubkey)); } catch {}
      }
      paginationKey = page.paginationKey ?? undefined;
    } while (paginationKey);
  } catch {
    return [];
  }
  return out;
}

async function getProgramAccountEntries(
  rpcUrl: string,
  l1: Connection,
  programId: PublicKey,
  filters: any[],
): Promise<TableEntry[]> {
  try {
    const accounts = await l1.getProgramAccounts(programId, { filters });
    return accounts.map((a) => ({
      pubkey: a.pubkey,
      account: {
        data: Buffer.from(a.account.data),
        lamports: a.account.lamports,
        owner: a.account.owner,
      },
    }));
  } catch {
    if (!rpcUrl) return [];
  }

  const out: TableEntry[] = [];
  let paginationKey: string | undefined;
  try {
    do {
      const page = await getProgramAccountsV2(rpcUrl, {
        programId: programId.toBase58(),
        filters,
        paginationKey,
      });
      for (const account of decodeV2Accounts(page.accounts)) {
        try {
          out.push({
            pubkey: new PublicKey(account.pubkey),
            account: {
              data: account.data,
              lamports: account.lamports,
              owner: new PublicKey(account.owner),
            },
          });
        } catch {}
      }
      paginationKey = page.paginationKey ?? undefined;
    } while (paginationKey);
  } catch {
    return [];
  }
  return out;
}

function parseTable(pubkey: PublicKey, data: Buffer, isDelegated: boolean) {
  if (data.length < 256 || Buffer.compare(data.subarray(0, 8), TABLE_DISC) !== 0) return null;
  const snapshotCurrentPlayers = data[OFF.CURRENT_PLAYERS];
  const snapshotPot = Number(data.readBigUInt64LE(OFF.POT));
  return {
    pubkey: pubkey.toBase58(),
    phase: data[OFF.PHASE],
    currentPlayers: isDelegated ? 0 : snapshotCurrentPlayers,
    snapshotCurrentPlayers,
    maxPlayers: data[OFF.MAX_PLAYERS],
    smallBlind: Number(data.readBigUInt64LE(OFF.SMALL_BLIND)),
    bigBlind: Number(data.readBigUInt64LE(OFF.BIG_BLIND)),
    gameType: data[OFF.GAME_TYPE],
    tier: data.length > OFF.TIER ? data[OFF.TIER] : 0,
    pot: isDelegated ? 0 : snapshotPot,
    snapshotPot,
    handNumber: Number(data.readBigUInt64LE(OFF.HAND_NUMBER)),
    lastActionSlot: data.length >= OFF.LAST_ACTION_SLOT + 8
      ? Number(data.readBigUInt64LE(OFF.LAST_ACTION_SLOT)) : 0,
    isDelegated,
    authority: new PublicKey(data.subarray(OFF.AUTHORITY, OFF.AUTHORITY + 32)).toBase58(),
    creator: data.length > OFF.CREATOR + 32
      ? new PublicKey(data.subarray(OFF.CREATOR, OFF.CREATOR + 32)).toBase58() : '',
    tokenEscrow: data.length > OFF.TOKEN_ESCROW + 32
      ? new PublicKey(data.subarray(OFF.TOKEN_ESCROW, OFF.TOKEN_ESCROW + 32)).toBase58() : '',
    isUserCreated: data.length > OFF.IS_USER_CREATED ? data[OFF.IS_USER_CREATED] === 1 : false,
    rakeAccumulated: data.length > OFF.RAKE_ACCUMULATED + 8
      ? Number(data.readBigUInt64LE(OFF.RAKE_ACCUMULATED)) : 0,
    creatorRakeTotal: data.length >= OFF.CREATOR_RAKE_TOTAL + 8
      ? Number(data.readBigUInt64LE(OFF.CREATOR_RAKE_TOTAL)) : 0,
    tokenMint: data.length > OFF.TOKEN_MINT + 32
      ? new PublicKey(data.subarray(OFF.TOKEN_MINT, OFF.TOKEN_MINT + 32)).toBase58() : '',
    buyInType: data.length > OFF.BUY_IN_TYPE ? data[OFF.BUY_IN_TYPE] : 0,
    rakeCap: data.length >= OFF.RAKE_CAP + 8
      ? Number(data.readBigUInt64LE(OFF.RAKE_CAP)) : 0,
    isPrivate: data.length > OFF.IS_PRIVATE ? data[OFF.IS_PRIVATE] === 1 : false,
    location: isDelegated ? 'TEE' : 'L1',
    liveStateSource: isDelegated ? 'tee-pending' : 'l1',
    liveStateStale: isDelegated,
    decimals: 9,
  };
}

function isCurrentProgramTablePda(pubkey: PublicKey, data: Buffer): boolean {
  if (data.length < 72 || Buffer.compare(data.subarray(0, 8), TABLE_DISC) !== 0) return false;
  try {
    const tableIdBytes = data.subarray(OFF.TABLE_ID, OFF.TABLE_ID + 32);
    const [expectedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('table'), tableIdBytes],
      PROGRAM_ID,
    );
    return expectedPda.equals(pubkey);
  } catch {
    return false;
  }
}

function splitEntries(entries: TableEntry[]): {
  delegatedAccounts: TableEntry[];
  undelegatedAccounts: TableEntry[];
} {
  return {
    delegatedAccounts: entries.filter((e) => e.account.owner.equals(DELEGATION_PROGRAM_ID)),
    undelegatedAccounts: entries.filter((e) => e.account.owner.equals(PROGRAM_ID)),
  };
}

async function scanProgramTables(l1: Connection): Promise<{
  delegatedAccounts: TableEntry[];
  undelegatedAccounts: TableEntry[];
}> {
  const rpcUrl = getL1RpcUrl();
  const [delKeys, undKeys] = await Promise.all([
    getProgramAccountPubkeys(rpcUrl, l1, DELEGATION_PROGRAM_ID, [discFilter]),
    getProgramAccountPubkeys(rpcUrl, l1, PROGRAM_ID, [discFilter]),
  ]);
  const fetchEntries = async (keys: PublicKey[]): Promise<TableEntry[]> => {
    const out: TableEntry[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const batch = keys.slice(i, i + 100);
      const infos = await l1.getMultipleAccountsInfo(batch, 'confirmed').catch(() => null);
      if (!infos) continue;
      for (let j = 0; j < batch.length; j += 1) {
        const info = infos[j];
        if (!info) continue;
        out.push({
          pubkey: batch[j],
          account: { data: Buffer.from(info.data), lamports: info.lamports, owner: info.owner },
        });
      }
    }
    return out;
  };
  const [del, und] = await Promise.all([
    fetchEntries(delKeys),
    fetchEntries(undKeys),
  ]);
  return {
    delegatedAccounts: del,
    undelegatedAccounts: und,
  };
}

async function scanCreatorTables(l1: Connection, creator: PublicKey): Promise<{
  delegatedAccounts: TableEntry[];
  undelegatedAccounts: TableEntry[];
}> {
  const rpcUrl = getL1RpcUrl();
  const creatorFilter = { memcmp: { offset: OFF.CREATOR, bytes: creator.toBase58() } };
  const filters = [discFilter, creatorFilter];
  const [del, und] = await Promise.all([
    getProgramAccountEntries(rpcUrl, l1, DELEGATION_PROGRAM_ID, filters),
    getProgramAccountEntries(rpcUrl, l1, PROGRAM_ID, filters),
  ]);
  return {
    delegatedAccounts: del,
    undelegatedAccounts: und,
  };
}

function mergeFetchedAccounts(...groups: TableEntry[][]): TableEntry[] {
  const merged = new Map<string, TableEntry>();
  for (const group of groups) {
    for (const entry of group) merged.set(entry.pubkey.toBase58(), entry);
  }
  return Array.from(merged.values());
}

async function getIndexedOrScannedAccounts(l1: Connection | null): Promise<{
  delegatedAccounts: TableEntry[];
  undelegatedAccounts: TableEntry[];
  indexerStatus?: RawTablesIndexerStatus;
}> {
  if (indexerReadsEnabled()) {
    const raw = await fetchRawTablesViaIndexer({});
    if (raw?.entries.length) {
      return { ...splitEntries(raw.entries), indexerStatus: raw.status };
    }

    const indexerPubkeys = await discoverViaIndexer({});
    if (indexerPubkeys && l1) {
      const split = await fetchTablesByPubkey(l1, indexerPubkeys);
      return { delegatedAccounts: split.delegated, undelegatedAccounts: split.undelegated };
    }
  }

  if (l1) return scanProgramTables(l1);
  return { delegatedAccounts: [], undelegatedAccounts: [] };
}

function markDelegatedStateStale(table: any, source = 'tee-unavailable') {
  if (!table?.isDelegated) return;
  table.currentPlayers = 0;
  table.pot = 0;
  table.liveStateSource = source;
  table.liveStateStale = true;
}

function parseRows(delegatedAccounts: TableEntry[], undelegatedAccounts: TableEntry[]): any[] {
  const tables: any[] = [];
  for (const { pubkey, account } of delegatedAccounts) {
    const data = Buffer.from(account.data);
    if (!isCurrentProgramTablePda(pubkey, data)) continue;
    const parsed = parseTable(pubkey, data, true);
    if (parsed) tables.push(parsed);
  }
  for (const { pubkey, account } of undelegatedAccounts) {
    const data = Buffer.from(account.data);
    if (!isCurrentProgramTablePda(pubkey, data)) continue;
    const parsed = parseTable(pubkey, data, false);
    if (parsed) tables.push(parsed);
  }
  return tables;
}

async function overlayDelegatedTableState(tables: any[]): Promise<TeeOverlayResult> {
  const delegatedTables = tables.filter((t) => t.isDelegated);
  if (delegatedTables.length === 0) return emptyTeeOverlay;
  const result: TeeOverlayResult = { attempted: delegatedTables.length, updated: 0, stale: 0 };
  try {
    const tee = await getTeeConnection();
    for (let i = 0; i < delegatedTables.length; i += 100) {
      const chunk = delegatedTables.slice(i, i + 100);
      const infos = await tee.getMultipleAccountsInfo(chunk.map((t: any) => new PublicKey(t.pubkey))).catch(() => null);
      if (!infos) {
        for (const t of chunk) markDelegatedStateStale(t);
        result.stale += chunk.length;
        continue;
      }
      for (let j = 0; j < chunk.length; j++) {
        const info = infos[j];
        const t = chunk[j];
        if (!info || info.data.length < 256) {
          markDelegatedStateStale(t);
          result.stale += 1;
          continue;
        }
        const d = Buffer.from(info.data);
        t.currentPlayers = d[OFF.CURRENT_PLAYERS];
        t.phase = d[OFF.PHASE];
        t.pot = Number(d.readBigUInt64LE(OFF.POT));
        t.handNumber = Number(d.readBigUInt64LE(OFF.HAND_NUMBER));
        t.lastActionSlot = Number(d.readBigUInt64LE(OFF.LAST_ACTION_SLOT));
        t.liveStateSource = 'tee';
        t.liveStateStale = false;
        result.updated += 1;
      }
    }
  } catch (e: any) {
    for (const t of delegatedTables) markDelegatedStateStale(t);
    result.updated = 0;
    result.stale = delegatedTables.length;
    result.error = e?.message ? String(e.message).slice(0, 160) : 'TEE overlay unavailable';
  }
  return result;
}

async function refreshCacheInBackground() {
  try {
    const l1 = getL1Connection();
    let { delegatedAccounts, undelegatedAccounts, indexerStatus } = await getIndexedOrScannedAccounts(l1);
    let tables = parseRows(delegatedAccounts, undelegatedAccounts);

    if (tables.length === 0 && l1 && (delegatedAccounts.length > 0 || undelegatedAccounts.length > 0)) {
      const scanned = await scanProgramTables(l1);
      delegatedAccounts = scanned.delegatedAccounts;
      undelegatedAccounts = scanned.undelegatedAccounts;
      tables = parseRows(delegatedAccounts, undelegatedAccounts);
    }

    const teeOverlay = await overlayDelegatedTableState(tables);

    const tableBlacklist = getTableBlacklist();
    const hiddenCount = tables.filter((t: any) => tableBlacklist.has(t.pubkey)).length;
    tables = tables.filter((t: any) => !tableBlacklist.has(t.pubkey));
    if (l1) {
      try { await attachTokenDecimals(l1, tables); } catch {}
    }

    const prevCount = responseCache?.data?.tables?.length || 0;
    const emptyRegression = !!responseCache && tables.length === 0 && prevCount > 0;
    if (!emptyRegression) {
      responseCache = {
        data: {
          tables,
          delegatedCount: delegatedAccounts.length,
          undelegatedCount: undelegatedAccounts.length,
          hiddenCount,
          indexerStatus,
          teeOverlay,
          serverRpcConfigured: !!l1,
          indexerEnabled: indexerReadsEnabled(),
        },
        ts: Date.now(),
      };
    }
  } catch (e: any) {
    console.warn('[tables/list] background refresh failed:', e?.message?.slice(0, 120));
  }
}

function runBackgroundRefresh(): Promise<void> {
  if (backgroundRefreshPromise) return backgroundRefreshPromise;
  backgroundRefreshInProgress = true;
  backgroundRefreshPromise = refreshCacheInBackground().finally(() => {
    backgroundRefreshInProgress = false;
    backgroundRefreshPromise = null;
  });
  return backgroundRefreshPromise;
}

function ensureBackgroundRefresh() {
  if (backgroundIntervalStarted) return;
  backgroundIntervalStarted = true;
  if (!backgroundRefreshInProgress) void runBackgroundRefresh();
  setInterval(() => {
    if (backgroundRefreshInProgress) return;
    void runBackgroundRefresh();
  }, REFRESH_INTERVAL_MS);
}

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

function parseCursor(cursor: string | null): { snapshotId: string; offset: number; filterHash: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed?.snapshotId || !Number.isFinite(parsed.offset) || !parsed.filterHash) return null;
    return { snapshotId: String(parsed.snapshotId), offset: Math.max(0, Number(parsed.offset)), filterHash: String(parsed.filterHash) };
  } catch {
    return null;
  }
}

function filterHashFor(url: URL): string {
  const entries = Array.from(url.searchParams.entries())
    .filter(([key]) => key !== 'cursor' && key !== 'limit')
    .sort(([a], [b]) => a.localeCompare(b));
  return base64url(JSON.stringify(entries));
}

function pruneSnapshots(now = Date.now()) {
  for (const [key, snap] of Array.from(tableSnapshots.entries())) {
    if (now - snap.createdAt > SNAPSHOT_TTL_MS) tableSnapshots.delete(key);
  }
  while (tableSnapshots.size > SNAPSHOT_MAX) {
    const oldest = Array.from(tableSnapshots.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    tableSnapshots.delete(oldest[0]);
  }
}

function rankTables(tables: any[]): any[] {
  return [...tables].sort((a, b) => {
    const active = Number((b.currentPlayers ?? 0) > 0) - Number((a.currentPlayers ?? 0) > 0);
    if (active) return active;
    const fillA = a.maxPlayers > 0 ? a.currentPlayers / a.maxPlayers : 0;
    const fillB = b.maxPlayers > 0 ? b.currentPlayers / b.maxPlayers : 0;
    if (fillA !== fillB) return fillB - fillA;
    if ((a.pot ?? 0) !== (b.pot ?? 0)) return (b.pot ?? 0) - (a.pot ?? 0);
    return String(a.pubkey).localeCompare(String(b.pubkey));
  });
}

function pageTables(tables: any[], url: URL): NextResponse | { tables: any[]; nextCursor: string | null; snapshotId: string | null } {
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw) || 60)) : 0;
  const cursor = parseCursor(url.searchParams.get('cursor'));
  const hash = filterHashFor(url);
  const now = Date.now();
  pruneSnapshots(now);

  if (cursor) {
    const snapshot = tableSnapshots.get(cursor.snapshotId);
    if (!snapshot || snapshot.filterHash !== cursor.filterHash || now - snapshot.createdAt > SNAPSHOT_TTL_MS) {
      return NextResponse.json({ error: 'SNAPSHOT_EXPIRED', code: 'SNAPSHOT_EXPIRED' }, { status: 409 });
    }
    tableSnapshots.delete(snapshot.snapshotId);
    tableSnapshots.set(snapshot.snapshotId, { ...snapshot, createdAt: now });
    const rows = snapshot.rows.slice(cursor.offset, cursor.offset + (limit || 60));
    const nextOffset = cursor.offset + rows.length;
    return {
      tables: rows,
      nextCursor: nextOffset < snapshot.rows.length
        ? base64url(JSON.stringify({ snapshotId: snapshot.snapshotId, offset: nextOffset, filterHash: snapshot.filterHash }))
        : null,
      snapshotId: snapshot.snapshotId,
    };
  }

  const ranked = rankTables(tables);
  if (!limit) return { tables: ranked, nextCursor: null, snapshotId: null };

  const snapshotId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  tableSnapshots.set(snapshotId, { snapshotId, filterHash: hash, rows: ranked, createdAt: now });
  pruneSnapshots(now);
  const rows = ranked.slice(0, limit);
  return {
    tables: rows,
    nextCursor: rows.length < ranked.length
      ? base64url(JSON.stringify({ snapshotId, offset: rows.length, filterHash: hash }))
      : null,
    snapshotId,
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const creatorFilter = url.searchParams.get('creator');
    const gameTypeFilter = url.searchParams.get('gameType');

    if (creatorFilter) return await fetchCreatorTables(creatorFilter, gameTypeFilter);

    if (responseCache && responseCache.data.indexerEnabled !== indexerReadsEnabled()) {
      responseCache = null;
    }
    if (!responseCache) await runBackgroundRefresh();

    ensureBackgroundRefresh();
    if (!responseCache) {
      const serverRpcConfigured = !!getL1Connection();
      const indexerEnabled = indexerReadsEnabled();
      return NextResponse.json({
        tables: [],
        delegatedCount: 0,
        undelegatedCount: 0,
        hiddenCount: 0,
        loading: serverRpcConfigured || indexerEnabled,
        serverRpcConfigured,
        indexerEnabled,
      });
    }

    const cashOnly = gameTypeFilter !== null && Number(gameTypeFilter) === 3;
    let tables = responseCache.data.tables.filter((t: any) => cashOnly ? true : t.isDelegated);
    if (gameTypeFilter !== null) {
      const gt = Number(gameTypeFilter);
      if (Number.isFinite(gt)) tables = tables.filter((t: any) => t.gameType === gt);
    }
    const paged = pageTables(tables, url);
    if (paged instanceof NextResponse) return paged;
    const playersOnline = (responseCache.data.tables as Array<{ isDelegated?: boolean; liveStateStale?: boolean; currentPlayers?: number }>)
      .filter((t) => t.isDelegated && !t.liveStateStale)
      .reduce((sum, t) => sum + (t.currentPlayers || 0), 0);
    return NextResponse.json({
      ...responseCache.data,
      tables: paged.tables,
      playersOnline,
      cached: true,
      nextCursor: paged.nextCursor,
      snapshotId: paged.snapshotId,
      serverRpcConfigured: responseCache.data.serverRpcConfigured ?? true,
      indexerEnabled: responseCache.data.indexerEnabled ?? indexerReadsEnabled(),
    });
  } catch (error: any) {
    console.error('[tables/list] error:', error);
    return NextResponse.json({ error: error?.message || 'table list failed', tables: [] }, { status: 500 });
  }
}

async function fetchCreatorTables(creatorFilter: string, gameTypeFilter: string | null) {
  let creatorPk: PublicKey;
  try {
    creatorPk = new PublicKey(creatorFilter);
  } catch {
    return NextResponse.json({
      error: 'Invalid creator wallet',
      tables: [],
      serverRpcConfigured: !!getL1Connection(),
      indexerEnabled: indexerReadsEnabled(),
    }, { status: 400 });
  }

  const l1 = getL1Connection();
  const indexerEnabled = indexerReadsEnabled();
  const raw = indexerEnabled ? await fetchRawTablesViaIndexer({}) : null;
  let indexerDelegated: TableEntry[] = [];
  let indexerUndelegated: TableEntry[] = [];
  if (raw?.entries.length) {
    const split = splitEntries(raw.entries);
    indexerDelegated = split.delegatedAccounts;
    indexerUndelegated = split.undelegatedAccounts;
  } else if (l1 && indexerReadsEnabled()) {
    const indexerPubkeys = await discoverViaIndexer({ creator: creatorFilter });
    if (indexerPubkeys) {
      const split = await fetchTablesByPubkey(l1, indexerPubkeys);
      indexerDelegated = split.delegated;
      indexerUndelegated = split.undelegated;
    }
  }

  const scanned = l1 ? await scanCreatorTables(l1, creatorPk) : { delegatedAccounts: [], undelegatedAccounts: [] };
  const delegatedAccounts = mergeFetchedAccounts(indexerDelegated, scanned.delegatedAccounts);
  const undelegatedAccounts = mergeFetchedAccounts(indexerUndelegated, scanned.undelegatedAccounts);
  const tables = parseRows(delegatedAccounts, undelegatedAccounts)
    .filter((t: any) => t.creator === creatorFilter);
  const teeOverlay = await overlayDelegatedTableState(tables);
  if (l1) {
    try { await attachTokenDecimals(l1, tables); } catch {}
  }

  let filtered = tables;
  if (gameTypeFilter !== null) {
    const gt = Number(gameTypeFilter);
    if (Number.isFinite(gt)) filtered = filtered.filter((t: any) => t.gameType === gt);
  }
  return NextResponse.json({
    tables: filtered,
    delegatedCount: delegatedAccounts.length,
    undelegatedCount: undelegatedAccounts.length,
    teeOverlay,
    serverRpcConfigured: !!l1,
    indexerEnabled,
  });
}
