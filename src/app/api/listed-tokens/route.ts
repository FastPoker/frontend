import { NextResponse } from 'next/server';
import { Connection } from '@solana/web3.js';
import { getL1Rpc } from '@/lib/rpc-config';
import { FASTPOKER_REGISTRY_PROGRAM_ID } from '@/lib/constants';
import { LISTED_TOKEN_DATA_SIZE, parseListedToken } from '@/lib/onchain-game';
import { getIndexerBaseUrl } from '@/lib/indexer-env';

// Listed-token mints. Indexer-first (push-updated /v1/tokens, 0 RPC), falling back
// to a direct getProgramAccounts on the registry only when the indexer is cold or
// unreachable — so the per-client gPA in useListedTokens becomes one shared,
// usually-free server hop. Symbols/logos are still resolved client-side via
// /api/token-meta; this only owns the mint set.
const INDEXER_BASE = getIndexerBaseUrl();

export const dynamic = 'force-dynamic';

type TokenLite = { mint: string; listedAt: number };

export async function GET() {
  // 1) indexer cache (subscription-backed)
  if (INDEXER_BASE) {
    try {
      const res = await fetch(new URL('/v1/tokens', INDEXER_BASE).toString(), {
        cache: 'no-store',
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as { tokens?: TokenLite[] };
        if (Array.isArray(body?.tokens)) {
          return NextResponse.json({ tokens: body.tokens }, {
            headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' },
          });
        }
      }
    } catch { /* indexer cold / unreachable — fall through */ }
  }

  // 2) fallback: direct registry scan (today's behavior; one server-side gPA)
  try {
    const conn = new Connection(getL1Rpc(), 'confirmed');
    const accounts = await conn.getProgramAccounts(FASTPOKER_REGISTRY_PROGRAM_ID, {
      filters: [{ dataSize: LISTED_TOKEN_DATA_SIZE }],
    });
    const tokens: TokenLite[] = [];
    for (const { account } of accounts) {
      const parsed = parseListedToken(Buffer.from(account.data));
      if (parsed) tokens.push({ mint: parsed.tokenMint, listedAt: parsed.listedAt });
    }
    return NextResponse.json({ tokens });
  } catch (e: any) {
    return NextResponse.json({ tokens: [], error: e?.message }, { status: 200 });
  }
}
