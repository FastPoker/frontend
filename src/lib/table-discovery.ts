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
import { PublicKey, type Connection } from '@solana/web3.js';
import { makeL1Connection, ANCHOR_PROGRAM_ID } from './constants';
import { parseTableState, OnChainGameType, getMultipleAccountsInfoChunked, type TableState } from './onchain-game';

const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const SEAT_WALLET_OFFSET = 8;
const SEAT_TABLE_OFFSET = 72;
const TABLE_CREATOR_OFFSET = 290;
const TABLE_ALLOC_SIZE = 478;

export interface DiscoveredTable {
  pubkey: string;
  state: TableState;
  /** Owned by the delegation program on L1 = currently delegated (in play). */
  isDelegated: boolean;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; tables: DiscoveredTable[] }>();
const inflight = new Map<string, Promise<DiscoveredTable[]>>();

async function gpaPubkeys(conn: Connection, program: PublicKey, filters: any[]): Promise<string[]> {
  try {
    const accts = await conn.getProgramAccounts(program, { filters, dataSlice: { offset: 0, length: 0 } });
    return accts.map((a) => a.pubkey.toBase58());
  } catch {
    return []; // free pool blocks gPA
  }
}

async function run(wallet: string): Promise<DiscoveredTable[]> {
  const conn = makeL1Connection();
  const pdas = new Set<string>();

  for (const program of [ANCHOR_PROGRAM_ID, DELEGATION_PROGRAM_ID]) {
    // (a) tables I'm SEATED at: seat.wallet@8 → read seat.table@72
    try {
      const seats = await conn.getProgramAccounts(program, {
        filters: [{ memcmp: { offset: SEAT_WALLET_OFFSET, bytes: wallet } }],
        dataSlice: { offset: SEAT_TABLE_OFFSET, length: 32 },
      });
      for (const s of seats) {
        if (s.account.data.length >= 32) {
          pdas.add(new PublicKey(Buffer.from(s.account.data).subarray(0, 32)).toBase58());
        }
      }
    } catch {
      /* gPA blocked (free pool) */
    }
    // (b) tables I CREATED: table.creator@290 (idle tables have no seat rows)
    for (const p of await gpaPubkeys(conn, program, [
      { dataSize: TABLE_ALLOC_SIZE },
      { memcmp: { offset: TABLE_CREATOR_OFFSET, bytes: wallet } },
    ])) {
      pdas.add(p);
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
      out.push({ pubkey: list[i], state, isDelegated: !info.owner.equals(ANCHOR_PROGRAM_ID) });
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
