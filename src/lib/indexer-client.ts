import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import { ANCHOR_PROGRAM_ID } from './constants';

/**
 * Server-side helpers for calling the local indexer service.
 *
 * The optional indexer runs out-of-process (Indexer, port 3001) and owns
 * discovery of FastPoker tables. API routes that previously did their own
 * getProgramAccounts scans should prefer these helpers — each indexer call
 * replaces ~17k Helius credits with a single HTTP request + one batched
 * getMultipleAccountsInfo. Every helper falls back transparently when the
 * indexer is unreachable or empty, so the route degrades safely.
 */

const PROGRAM_ID = ANCHOR_PROGRAM_ID;
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const INDEXER_BASE_URL = process.env.INDEXER_BASE_URL || '';

export type TablePubkey = string;
export interface TableEntry {
  pubkey: PublicKey;
  account: { data: Buffer; lamports: number; owner: PublicKey };
}

interface RawIndexerTable {
  pubkey: string;
  owner: string;
  dataB64: string;
  lamports?: number;
}

/**
 * Return the pubkey list for non-closed tables known to the indexer. Use
 * `creator` or `gameType` to filter server-side. Returns null when the
 * indexer is empty, unreachable, or times out — the caller should fall back
 * to its own discovery path in that case.
 */
export async function discoverViaIndexer(opts: {
  creator?: string;
  gameType?: number;
  timeoutMs?: number;
} = {}): Promise<TablePubkey[] | null> {
  try {
    const url = new URL('/tables/live', INDEXER_BASE_URL);
    if (opts.creator) url.searchParams.set('creator', opts.creator);
    if (opts.gameType !== undefined) url.searchParams.set('gameType', String(opts.gameType));
    const res = await fetch(url.toString(), {
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2500),
    });
    if (!res.ok) return null;
    const body = await res.json() as { tables?: Array<{ _id: string }> };
    const pubkeys = (body.tables || []).map(t => t._id).filter(Boolean);
    return pubkeys.length > 0 ? pubkeys : null;
  } catch {
    return null;
  }
}

/**
 * Fetch live account data for a list of table pubkeys via batched
 * getMultipleAccountsInfo (100 per RPC call). Splits the results into
 * delegated (DELEGATION_PROGRAM_ID-owned) vs. undelegated (PROGRAM_ID-owned)
 * buckets so callers can apply the right overlay logic.
 */
export async function fetchTablesByPubkey(
  conn: Connection,
  pubkeys: TablePubkey[],
): Promise<{ delegated: TableEntry[]; undelegated: TableEntry[]; orphan: TableEntry[] }> {
  const delegated: TableEntry[] = [];
  const undelegated: TableEntry[] = [];
  const orphan: TableEntry[] = [];
  const keys = pubkeys.map(pk => new PublicKey(pk));
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(batch, 'confirmed').catch(() => null);
    if (!infos) continue;
    for (let j = 0; j < batch.length; j++) {
      const info = infos[j];
      if (!info) continue;
      const entry: TableEntry = {
        pubkey: batch[j],
        account: {
          data: Buffer.from(info.data),
          lamports: info.lamports,
          owner: info.owner,
        },
      };
      if (info.owner.equals(DELEGATION_PROGRAM_ID)) delegated.push(entry);
      else if (info.owner.equals(PROGRAM_ID)) undelegated.push(entry);
      else orphan.push(entry);
    }
  }
  return { delegated, undelegated, orphan };
}

/**
 * Fetch raw live Table accounts directly from the source indexer's push-fed table
 * cache. This is the cheapest FULL path: no program-account scan and no follow-up
 * getMultipleAccountsInfo. Returns null when the indexer is not configured/cold.
 */
export async function fetchRawTablesViaIndexer(opts: {
  timeoutMs?: number;
} = {}): Promise<TableEntry[] | null> {
  if (!INDEXER_BASE_URL) return null;
  try {
    const res = await fetch(new URL('/v1/tables', INDEXER_BASE_URL).toString(), {
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2500),
    });
    if (!res.ok) return null;
    const body = await res.json() as { tables?: RawIndexerTable[] };
    const rows = Array.isArray(body.tables) ? body.tables : [];
    const out: TableEntry[] = [];
    for (const row of rows) {
      if (!row?.pubkey || !row.owner || !row.dataB64) continue;
      try {
        out.push({
          pubkey: new PublicKey(row.pubkey),
          account: {
            data: Buffer.from(row.dataB64, 'base64'),
            lamports: Number(row.lamports ?? 0),
            owner: new PublicKey(row.owner),
          },
        });
      } catch {
        // Skip malformed cache rows; the route can still fall back.
      }
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * One-stop discovery: indexer-first pubkey fetch + batched live state read.
 * Returns combined delegated+undelegated entries; returns null if the
 * indexer is empty/unreachable so callers can fall back.
 */
export async function discoverTables(
  conn: Connection,
  opts?: { creator?: string; gameType?: number },
): Promise<TableEntry[] | null> {
  const pubkeys = await discoverViaIndexer(opts ?? {});
  if (!pubkeys) return null;
  const { delegated, undelegated } = await fetchTablesByPubkey(conn, pubkeys);
  return [...delegated, ...undelegated];
}

/**
 * Process-local single-flight cache around conn.getLatestBlockhash. Kept under
 * the old export name so existing route code does not churn.
 */
type BlockhashResult = { blockhash: string; lastValidBlockHeight: number };

// Short-lived process cache + single-flight dedupe for the L1 blockhash.
// Single-flight makes N concurrent callers share one upstream fetch; the 2s TTL
// collapses back-to-back calls. 2s of staleness is irrelevant to tx validity
// (a blockhash is good ~60-90s, and a slightly-aged one is LESS likely to hit
// "blockhash not found" on a lagging node than a brand-new one), so this is safe
// for every caller including tx-building routes.
// This helper is L1-only by contract (ER/TEE callers use their own connection's
// getLatestBlockhash directly), so the cache never crosses clusters. Only
// successful results are cached, keyed by commitment; failures retry.
const BLOCKHASH_TTL_MS = 2000;
const blockhashCache = new Map<Commitment, { value: BlockhashResult; ts: number }>();
const blockhashInflight = new Map<Commitment, Promise<BlockhashResult>>();

export async function getLatestBlockhashViaIndexer(
  conn: Connection,
  commitment: Commitment = 'confirmed',
  _opts: { timeoutMs?: number } = {},
): Promise<BlockhashResult> {
  const cached = blockhashCache.get(commitment);
  if (cached && Date.now() - cached.ts < BLOCKHASH_TTL_MS) return cached.value;

  const existing = blockhashInflight.get(commitment);
  if (existing) return existing;

  const fetchFresh = (async (): Promise<BlockhashResult> => {
    return conn.getLatestBlockhash(commitment);
  })();

  blockhashInflight.set(commitment, fetchFresh);
  try {
    const result = await fetchFresh;
    blockhashCache.set(commitment, { value: result, ts: Date.now() });
    return result;
  } finally {
    blockhashInflight.delete(commitment);
  }
}
