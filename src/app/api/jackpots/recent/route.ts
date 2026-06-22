/**
 * GET /api/jackpots/recent?limit=50
 *
 * Returns the most recent JPV1 jackpot receipts emitted by the FastPoker
 * program where `miniHit || grandHit`. Newest-first.
 *
 * Query params:
 *   - limit: 1..200 (default 50)
 *
 * Response: { receipts: JackpotReceipt[] }
 *
 * Cache: 5s in-memory cache per `limit` bucket (see jackpot-scanner.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRecentReceipts } from '@/lib/jackpot-scanner';
import { requireRateLimit } from '@/lib/api-rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Let Cloudflare absorb this endpoint: serve from edge for 15s and keep serving
// the stale copy for another 60s while it revalidates. The underlying data
// changes slowly (jackpot hits), so the origin is hit at most ~once/15s
// globally — which neutralises the "uncached dynamic response" DoS vector even
// on the slow on-chain fallback path (when the indexer is unreachable).
const CACHE_HEADER = 'public, s-maxage=15, stale-while-revalidate=60';

export async function GET(req: NextRequest) {
  // Per-IP cap as defence-in-depth (the CDN cache is the primary shield).
  const limited = requireRateLimit(req, 'jackpots-recent', '', 60, 60_000);
  if (limited) return limited;

  const limitParam = req.nextUrl.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return NextResponse.json({ error: 'Invalid limit (must be 1..200)' }, { status: 400 });
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  try {
    const receipts = await getRecentReceipts(limit);
    return NextResponse.json({ receipts }, { headers: { 'Cache-Control': CACHE_HEADER } });
  } catch (e: any) {
    return NextResponse.json(
      { error: `Failed to fetch jackpot receipts: ${e?.message?.slice(0, 200) ?? 'unknown error'}` },
      { status: 502 },
    );
  }
}
