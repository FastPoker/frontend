/**
 * Helius `getTransactionsForAddress` JSON-RPC client.
 *
 * Replaces the legacy `getSignaturesForAddress + per-tx getTransaction` loop:
 *   - Old: 1 credit (sig page) + N credits (one getTransaction per tx). 1000
 *     txs = ~1,001 credits, ~1,000 round-trips.
 *   - New: 10 credits per 100 returned (minimum 10). 1000 txs = 100 credits,
 *     ONE round-trip. ~10× cheaper.
 *
 * Response per item matches the standard Solana transaction object + meta.
 *
 * Docs: https://www.helius.dev/docs/rpc/gettransactionsforaddress
 *
 * Shared shape with Indexer ingestion helpers.
 */

export interface HeliusTransactionsParams {
  address: string;
  transactionDetails?: 'full' | 'signatures';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  paginationToken?: string;
  commitment?: 'confirmed' | 'finalized';
  encoding?: 'json' | 'jsonParsed' | 'base64' | 'base58';
  filters?: {
    blockTime?: { gte?: number; lte?: number; gt?: number; lt?: number; eq?: number };
    slot?: { gte?: number; lte?: number; gt?: number; lt?: number; eq?: number };
    signature?: string;
    status?: 'succeeded' | 'failed' | 'any';
    tokenAccounts?: 'balanceChanged' | 'mentioned';
  };
}

export interface HeliusTransactionsResult {
  transactions: any[];
  paginationToken: string | null;
}

export async function getTransactionsForAddress(
  rpcUrl: string,
  params: HeliusTransactionsParams,
): Promise<HeliusTransactionsResult> {
  // Positional params per Helius docs: [address, options]. The first param is
  // the bare address string; the second is an options object. Sending a single
  // merged object yields `Invalid params: invalid type: map, expected a string`.
  // NOTE: Helius caps `limit` at 100 when transactionDetails === 'full' and at
  // 1000 when 'signatures'. We clamp accordingly so callers don't have to know.
  const txDetails = params.transactionDetails ?? 'full';
  const maxLimit = txDetails === 'full' ? 100 : 1000;
  const options: Record<string, unknown> = {
    transactionDetails: txDetails,
    sortOrder: params.sortOrder ?? 'desc',
    limit: Math.min(Math.max(1, params.limit ?? maxLimit), maxLimit),
    commitment: params.commitment ?? 'confirmed',
  };
  if (params.paginationToken) options.paginationToken = params.paginationToken;
  if (params.encoding) options.encoding = params.encoding;
  if (params.filters) options.filters = params.filters;
  const body = {
    jsonrpc: '2.0',
    id: 'getTransactionsForAddress',
    method: 'getTransactionsForAddress',
    params: [params.address, options],
  };
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`getTransactionsForAddress HTTP ${res.status}`);
  const json = (await res.json()) as { result?: any; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || 'getTransactionsForAddress error');
  const result = json.result ?? {};
  const transactions = Array.isArray(result.transactions) ? result.transactions : [];
  const paginationToken = typeof result.paginationToken === 'string' ? result.paginationToken : null;
  return { transactions, paginationToken };
}

/**
 * Iterate over all transactions matching params, yielding pages one at a time.
 * Stops when the address is exhausted or `maxTxs` is reached.
 */
// ─── getProgramAccountsV2 ──────────────────────────────────────────────────
// Helius v2 variant of standard `getProgramAccounts`. Same response shape,
// but billed at 1 credit per call instead of standard 10 — 10× cheaper at
// the API level. Recommended for any program-account scan where:
//   - The result set is bounded (paging via token, max 1000 per page)
//   - The caller can tolerate a small cursor-paged loop instead of "all"
//
// Docs: https://www.helius.dev/docs/rpc/getprogramaccountsv2
//
// Returns the standard `{ pubkey, account }` shape per item so callers can
// drop in the swap without changing parsers.

export interface ProgramAccountsV2Params {
  programId: string;
  filters?: Array<
    | { dataSize: number }
    | { memcmp: { offset: number; bytes: string; encoding?: 'base58' | 'base64' } }
  >;
  encoding?: 'base64' | 'base58' | 'jsonParsed';
  dataSlice?: { offset: number; length: number };
  paginationKey?: string;
  limit?: number;
  commitment?: 'confirmed' | 'finalized';
}

export interface ProgramAccountsV2Result {
  accounts: Array<{ pubkey: string; account: { data: [string, string] | string; owner: string; lamports: number; executable: boolean; rentEpoch: number } }>;
  paginationKey: string | null;
}

export async function getProgramAccountsV2(
  rpcUrl: string,
  params: ProgramAccountsV2Params,
): Promise<ProgramAccountsV2Result> {
  const cfg: any = {
    commitment: params.commitment ?? 'confirmed',
    encoding: params.encoding ?? 'base64',
    limit: Math.min(Math.max(1, params.limit ?? 1000), 1000),
  };
  if (params.filters) cfg.filters = params.filters;
  if (params.dataSlice) cfg.dataSlice = params.dataSlice;
  if (params.paginationKey) cfg.paginationKey = params.paginationKey;
  const body = {
    jsonrpc: '2.0',
    id: 'getProgramAccountsV2',
    method: 'getProgramAccountsV2',
    params: [params.programId, cfg],
  };
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`getProgramAccountsV2 HTTP ${res.status}`);
  const json = (await res.json()) as { result?: any; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || 'getProgramAccountsV2 error');
  const result = json.result ?? {};
  return {
    accounts: Array.isArray(result.accounts) ? result.accounts : [],
    paginationKey: typeof result.paginationKey === 'string' ? result.paginationKey : null,
  };
}

/** Convenience: decode the standard `{pubkey, account.data: Buffer}` shape
 *  consumers expect (matches @solana/web3.js's getProgramAccounts return). */
export function decodeV2Accounts(
  v2: ProgramAccountsV2Result['accounts'],
): Array<{ pubkey: string; data: Buffer; lamports: number; owner: string }> {
  return v2.map((a) => {
    let data: Buffer;
    if (Array.isArray(a.account.data)) {
      const [payload, enc] = a.account.data;
      data = Buffer.from(payload, enc === 'base58' ? 'base64' : (enc as BufferEncoding));
    } else {
      data = Buffer.from(a.account.data, 'base64');
    }
    return {
      pubkey: a.pubkey,
      data,
      lamports: a.account.lamports,
      owner: a.account.owner,
    };
  });
}

export async function* iterateTransactionsForAddress(
  rpcUrl: string,
  params: HeliusTransactionsParams,
  opts?: { maxTxs?: number },
): AsyncGenerator<any[], void, void> {
  let cursor: string | undefined = params.paginationToken;
  let yielded = 0;
  const cap = opts?.maxTxs ?? Infinity;
  // Page size depends on transactionDetails mode — full mode is capped at 100
  // by Helius; signatures mode supports 1000.
  const pageMax = (params.transactionDetails ?? 'full') === 'full' ? 100 : 1000;
  while (yielded < cap) {
    const limit = Math.min(pageMax, cap - yielded);
    const page = await getTransactionsForAddress(rpcUrl, {
      ...params,
      limit,
      paginationToken: cursor,
    });
    if (page.transactions.length === 0) return;
    yield page.transactions;
    yielded += page.transactions.length;
    if (!page.paginationToken) return;
    cursor = page.paginationToken;
  }
}
