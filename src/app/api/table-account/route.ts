import { NextResponse } from 'next/server';
import { getIndexerBaseUrl } from '@/lib/indexer-env';

// Thin proxy to the indexer's push-fresh Table cache (/v1/tables?pubkey=). Used by
// the game poll's owner/delegation check so the common per-poll L1 getAccountInfo
// (the largest dashboard line) becomes a 0-RPC indexer hit. Returns {table:null}
// on any miss/cold/unreachable so the CLIENT falls back to a direct RPC read —
// the stale-TEE-shadow guard stays on the client, never weakened here.
const INDEXER_BASE = getIndexerBaseUrl();

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const pubkey = new URL(request.url).searchParams.get('pubkey');
  if (!pubkey) return NextResponse.json({ table: null }, { status: 400 });
  if (INDEXER_BASE) {
    try {
      const res = await fetch(
        new URL(`/v1/tables?pubkey=${encodeURIComponent(pubkey)}`, INDEXER_BASE).toString(),
        { cache: 'no-store', signal: AbortSignal.timeout(1500) },
      );
      if (res.ok) {
        const body = (await res.json()) as { table?: unknown; asOfMs?: number };
        return NextResponse.json({ table: body.table ?? null, asOfMs: body.asOfMs ?? 0 });
      }
    } catch { /* cold / unreachable — client falls back to direct RPC */ }
  }
  return NextResponse.json({ table: null, asOfMs: 0 });
}
