// API client for backend services - protects API keys server-side

export interface RpcResponse<T> {
  result?: T;
  error?: string;
}

export interface AccountInfo {
  data: string; // base64
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch: number;
}

export interface SitNGoQueue {
  id: string;
  type: 'heads_up' | '6max' | '9max';
  currentPlayers: number;
  maxPlayers: number;
  buyIn: number;
  tier: number;  // SnGTier enum: 0=Copper,...6=Black
  status: 'waiting' | 'starting' | 'in_progress';
  tablePda?: string;
  players?: string[];
  onChainPlayers?: number; // actual seated players on-chain (may differ from queue)
  emptySeats?: number[];   // seat indices that are open for joining
}

export interface SngPool {
  gameType: number;
  gameTypeName: 'heads_up' | '6max' | '9max';
  tier: number;
  tierName: string;
  maxPlayers: number;
  entryAmount: number;    // lamports
  feeAmount: number;      // lamports
  pageRentContributionLamports?: number; // lamports
  totalBuyIn: number;     // lamports
  queueCount: number;     // waitingCount from the on-chain paged queue
  queue: string[];         // waiting wallet pubkeys discovered from queue pages
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

// RPC API calls (server handles Helius API key)
export async function rpcGetAccountInfo(pubkey: string): Promise<AccountInfo | null> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getAccountInfo', params: [pubkey] }),
  });
  const data: RpcResponse<AccountInfo | null> = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result ?? null;
}

export async function rpcGetBalance(pubkey: string): Promise<number> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getBalance', params: [pubkey] }),
  });
  const data: RpcResponse<number> = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result ?? 0;
}

export async function rpcGetLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getLatestBlockhash', params: [] }),
  });
  const data: RpcResponse<{ blockhash: string; lastValidBlockHeight: number }> = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result!;
}

export async function rpcSendTransaction(txBase64: string): Promise<string> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'sendRawTransaction', params: [txBase64] }),
  });
  const data: RpcResponse<string> = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result!;
}

export async function rpcGetMultipleAccounts(pubkeys: string[]): Promise<(AccountInfo | null)[]> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getMultipleAccountsInfo', params: [pubkeys] }),
  });
  const data: RpcResponse<(AccountInfo | null)[]> = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result ?? [];
}

// Back-compat wrapper: the public source build reads SNG queue state directly
// from chain instead of relying on a node `/api/sitngos` route.
export async function getQueues(): Promise<{ queues: SitNGoQueue[]; pools: SngPool[] }> {
  return getQueuesOnChain();
}

// Standalone: read SNG tiers DIRECTLY from chain (no backend). One getMultipleAccounts
// over the 21 deterministic pool PDAs, plus the connected wallet's queue-marker PDAs to
// know which tiers it has joined. Other players' queue wallets are not enumerated (only
// the count, via on-chain waitingCount), which is all the tier lobby needs.
const SNG_TIER_NAMES = ['Copper', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Black'];
const SNG_GAMETYPE_NAMES = ['heads_up', '6max', '9max'] as const;

// Shared cache + single-flight so multiple pollers (lobby + ActiveTableBar) share ONE
// on-chain read per window instead of each hammering free RPCs.
const QUEUES_TTL_MS = 20_000;
let queuesCache: { wallet: string; at: number; value: { queues: SitNGoQueue[]; pools: SngPool[] } } | null = null;
let queuesInflight: Promise<{ queues: SitNGoQueue[]; pools: SngPool[] }> | null = null;

export async function getQueuesOnChain(
  myWallet?: string,
): Promise<{ queues: SitNGoQueue[]; pools: SngPool[] }> {
  const w = myWallet || '';
  const now = Date.now();
  if (queuesCache && queuesCache.wallet === w && now - queuesCache.at < QUEUES_TTL_MS) return queuesCache.value;
  if (queuesInflight) return queuesInflight;
  queuesInflight = (async () => {
    try {
      const value = await fetchQueuesOnChainUncached(myWallet);
      queuesCache = { wallet: w, at: Date.now(), value };
      return value;
    } finally {
      queuesInflight = null;
    }
  })();
  return queuesInflight;
}

async function fetchQueuesOnChainUncached(
  myWallet?: string,
): Promise<{ queues: SitNGoQueue[]; pools: SngPool[] }> {
  const { makeL1Connection } = await import('./constants');
  const { fetchAllSngPools, getSngQueueMarkerPda, getMultipleAccountsInfoChunked } = await import('./onchain-game');
  const { PublicKey } = await import('@solana/web3.js');
  const conn = makeL1Connection();

  const all = await fetchAllSngPools(conn);
  const live = all.filter((p) => p.state);

  const mine = new Set<string>();
  if (myWallet) {
    try {
      const me = new PublicKey(myWallet);
      // One queue marker per live pool (~21) — chunk it or the free pool 403s
      // the whole read and we never detect that the wallet is in a pool
      // (showing JOIN instead of VIEW QUEUE / LEAVE).
      const markers = live.map((p) => getSngQueueMarkerPda(p.pda, me)[0]);
      const infos = await getMultipleAccountsInfoChunked(conn, markers);
      infos.forEach((info, i) => {
        if (info) mine.add(`${live[i].gameType}:${live[i].tier}`);
      });
    } catch { /* marker read is best-effort */ }
  }

  const pools: SngPool[] = live.map((p) => {
    const s = p.state!;
    const entry = Number(s.entryAmount);
    const fee = Number(s.feeAmount);
    const joined = !!myWallet && mine.has(`${p.gameType}:${p.tier}`);
    return {
      gameType: p.gameType,
      gameTypeName: SNG_GAMETYPE_NAMES[p.gameType] ?? '9max',
      tier: p.tier,
      tierName: SNG_TIER_NAMES[p.tier] ?? `Tier ${p.tier}`,
      maxPlayers: s.maxPlayers,
      entryAmount: entry,
      feeAmount: fee,
      pageRentContributionLamports: Number(s.pageRentContributionLamports ?? 0),
      totalBuyIn: entry + fee,
      queueCount: s.waitingCount,
      queue: joined && myWallet ? [myWallet] : [],
      queueEntries: [],
      waitingCount: s.waitingCount,
      headPageIndex: s.headPageIndex,
      tailPageIndex: s.tailPageIndex,
      activeMatchSet: s.activeMatchSet,
      matchEligibleAt: Number(s.matchEligibleAt),
      pda: p.pda.toBase58(),
      poolBalanceLamports: 0,
    };
  });

  // The connected lobby builds tier cards from `queues` (SitNGoQueue) joined with
  // `pools`. Derive queues from the same on-chain pools so the cards populate.
  const queues: SitNGoQueue[] = live.map((p) => {
    const s = p.state!;
    return {
      id: `${p.gameType}-${p.tier}`,
      type: SNG_GAMETYPE_NAMES[p.gameType] ?? '9max',
      currentPlayers: s.waitingCount,
      maxPlayers: s.maxPlayers,
      buyIn: Number(s.entryAmount + s.feeAmount) / 1e9,
      tier: p.tier,
      status: 'waiting',
      onChainPlayers: s.waitingCount,
    };
  });

  return { queues, pools };
}

export interface MySngTableRow {
  tablePda: string;
  type: 'heads_up' | '6max' | '9max';
  maxPlayers: number;
  tier: number;
  phase: number;
}

// Detect the SNG tables this wallet is seated at — on-chain, no backend.
// Each pool's tables are deterministic (sha256('sng_table'|pool|index)); a
// PlayerTableMarker PDA exists per (player, table) while seated. We derive the
// candidate tables for each pool's slots, batch-read the markers, and read the
// matched tables. Bounded per-wallet (a player sits at 0-1 tables); capped.
export async function getMySngTablesOnChain(myWallet: string): Promise<MySngTableRow[]> {
  const { makeL1Connection, ANCHOR_PROGRAM_ID } = await import('./constants');
  const { fetchAllSngPools, getPlayerTableMarkerPda, getSeatPda, getMultipleAccountsInfoChunked } = await import('./onchain-game');
  const { PublicKey } = await import('@solana/web3.js');
  const { sha256 } = await import('@noble/hashes/sha256');
  const conn = makeL1Connection();
  const me = new PublicKey(myWallet);

  const all = await fetchAllSngPools(conn);
  const live = all.filter((p) => p.state);

  const MAX_CANDIDATES = 600;
  const candidates: { table: InstanceType<typeof PublicKey>; gameType: number; tier: number }[] = [];
  for (const p of live) {
    const next = p.state!.nextTableIndex;
    for (let i = 0; i < next && candidates.length < MAX_CANDIDATES; i++) {
      const tableId = sha256(new Uint8Array([...Buffer.from('sng_table'), ...p.pda.toBytes(), i]));
      const table = PublicKey.findProgramAddressSync(
        [Buffer.from('table'), Buffer.from(tableId)],
        ANCHOR_PROGRAM_ID,
      )[0];
      candidates.push({ table, gameType: p.gameType, tier: p.tier });
    }
  }
  if (candidates.length === 0) return [];

  // Batch-read the player's markers. Read the marker DATA: it stores the
  // seat_number (offset 72). Markers are NOT closed on leave/reuse, so existence
  // alone is stale — we must validate the seat below. Chunked so the free pool
  // (PublicNode blocks getMultipleAccounts >10 accounts) doesn't 403 the read.
  const markers = candidates.map((c) => getPlayerTableMarkerPda(me, c.table)[0]);
  const matched: { idx: number; seat: number }[] = [];
  const markerInfos = await getMultipleAccountsInfoChunked(conn, markers);
  markerInfos.forEach((info, j) => {
    if (info && info.data.length > 72) matched.push({ idx: j, seat: info.data[72] });
  });
  if (matched.length === 0) return [];

  // Read each matched table + the player's seat at it (parallel). Keep a table ONLY
  // when the seat at the marker's seat_number is STILL the player's (wallet match,
  // status not Empty/Eliminated) AND the table isn't Complete. On reuse the seat
  // wallet is reset to the default (111111…), so seat-wallet==me uniquely picks the
  // player's CURRENT table out of all the stale markers. We deliberately do NOT
  // require the on-chain IS_DELEGATED byte: when a table is delegated to the TEE its
  // L1 owner becomes the delegation program and that byte reads 0 on the frozen
  // snapshot, so requiring it threw away the live table. This is what fixes
  // "TAKE SEAT on every tier / wrong table / not finding my game".
  const matchTables = matched.map((m) => candidates[m.idx].table);
  const matchSeats = matched.map((m) => getSeatPda(candidates[m.idx].table, m.seat)[0]);
  const [tableInfos, seatInfos] = await Promise.all([
    getMultipleAccountsInfoChunked(conn, matchTables),
    getMultipleAccountsInfoChunked(conn, matchSeats),
  ]);
  const meBuf = Buffer.from(me.toBytes());
  const GT: Array<'heads_up' | '6max' | '9max'> = ['heads_up', '6max', '9max'];
  const out: MySngTableRow[] = [];
  matched.forEach((m, k) => {
    const tInfo = tableInfos[k];
    const sInfo = seatInfos[k];
    if (!tInfo || tInfo.data.length < 175 || !sInfo || sInfo.data.length < 228) return;
    const td = Buffer.from(tInfo.data);
    const phase = td[160];             // PHASE (7 = Complete)
    const maxPlayers = td[121];        // MAX_PLAYERS
    const seatWallet = Buffer.from(sInfo.data).subarray(8, 40); // SEAT_WALLET_OFFSET
    const status = sInfo.data[227];    // 0 Empty .. 5 Eliminated
    const seatedHere = seatWallet.equals(meBuf) && status !== 0 && status !== 5;
    if (seatedHere && phase !== 7) {
      const c = candidates[m.idx];
      out.push({ tablePda: c.table.toBase58(), type: GT[c.gameType] ?? '9max', maxPlayers, tier: c.tier, phase });
    }
  });
  return out;
}

export async function getTableState(tablePda: string): Promise<any> {
  const res = await fetch(`/api/table-account?pubkey=${encodeURIComponent(tablePda)}`, {
    cache: 'no-store',
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.table;
}
