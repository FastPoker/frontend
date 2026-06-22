import { NextRequest, NextResponse } from 'next/server';
import { createBreaker, fetchWithTimeout, type BreakerState } from '@/lib/circuit-breaker';
import { getIndexerBaseUrl, indexerReadsEnabled } from '@/lib/indexer-env';

/**
 * FULL-mode only. Read proxy from `/api/indexer/*` to the operator's
 * Indexer service (default port 3001). Keeps the browser talking to
 * the same origin (no CORS).
 *
 * LIGHT mode (the default, no backend) does not need this route. Callers either
 * skip indexed reads until FULL is selected or fall back to direct RPC where
 * that is supported. So in a LIGHT node build this route simply sits idle.
 * NOTE: it must be excluded if/when the LIGHT build flips to `output: 'export'`
 * (static export forbids route handlers) — it only belongs in the node-server
 * FULL build.
 *
 * Target indexer is `INDEXER_BASE_URL` (server-side env, never exposed to the
 * browser), for example `http://localhost:3001` when running the source indexer
 * on the same host.
 *
 * Circuit breaker: if the indexer fails (5xx or network error) N times in a row,
 * trip the breaker and short-circuit subsequent requests to 503 for COOLDOWN_MS
 * so callers apply their fallback (direct RPC) instead of each request burning a
 * timeout. A half-open probe lets a recovered indexer reseal the breaker.
 */
const INDEXER_BASE = getIndexerBaseUrl();
const INDEXER_ENABLED = indexerReadsEnabled();

export const dynamic = 'force-dynamic';

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const FETCH_TIMEOUT_MS = 4_000;
const COOLDOWN_MS = 30_000;
const breaker = createBreaker('indexer-proxy', {
  tripThreshold: 5,
  tripWindowMs: 10_000,
  cooldownMs: COOLDOWN_MS,
});

function sanitizeSegments(segments: string[]): string[] | null {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 8) return null;
  for (const s of segments) {
    if (typeof s !== 'string' || s.length === 0 || s.length > 64) return null;
    if (!SEGMENT_RE.test(s)) return null;
  }
  return segments;
}

// ─── Single-flight dedupe ────────────────────────────────────────────────────
// Concurrent identical GETs collapse into one upstream call. The breaker state
// is still updated per upstream call, not per caller.

interface UpstreamSnapshot {
  status: number;
  body: string;
  contentType: string;
  cacheControl: string | null;
  breakerSnapshot: BreakerState;
}

const inflight = new Map<string, Promise<UpstreamSnapshot>>();

async function fetchUpstream(target: string, method: string, body?: string): Promise<UpstreamSnapshot> {
  const upstream = await fetchWithTimeout(target, {
    method,
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    timeoutMs: FETCH_TIMEOUT_MS,
    ...(body !== undefined ? { body } : {}),
  });
  if (upstream.status >= 500) breaker.recordFailure();
  else breaker.recordSuccess();
  return {
    status: upstream.status,
    body: await upstream.text(),
    contentType: upstream.headers.get('content-type') || 'application/json',
    cacheControl: upstream.headers.get('cache-control'),
    breakerSnapshot: breaker.state(),
  };
}

async function proxy(req: NextRequest, params: { path: string[] }): Promise<NextResponse> {
  if (!INDEXER_ENABLED || !INDEXER_BASE) {
    return NextResponse.json(
      { error: 'indexer disabled', detail: 'Set INDEXER_BASE_URL and NEXT_PUBLIC_ENABLE_INDEXER=true to enable indexed reads.' },
      { status: 503 },
    );
  }

  const clean = sanitizeSegments(params.path);
  if (!clean) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  if (breaker.shouldShortCircuit()) {
    return NextResponse.json(
      { error: 'indexer breaker open', retryAfterMs: COOLDOWN_MS },
      { status: 503, headers: { 'X-Indexer-Breaker': 'open' } },
    );
  }

  const tail = clean.join('/');
  const search = req.nextUrl.search || '';
  const target = `${INDEXER_BASE}/${tail}${search}`;

  const dedupeKey = target;

  try {
    let snapshot: UpstreamSnapshot;
    if (dedupeKey && inflight.has(dedupeKey)) {
      snapshot = await inflight.get(dedupeKey)!;
    } else {
      const promise = fetchUpstream(target, 'GET');
      if (dedupeKey) {
        inflight.set(dedupeKey, promise);
        // Detach the cleanup chain. `promise.finally(cb)` returns a NEW promise
        // that rejects with the same reason when `promise` rejects; with no
        // handler that becomes an unhandled rejection even though the actual
        // error is already handled by `await promise` below. The trailing
        // `.catch()` keeps the cleanup but swallows the duplicated rejection.
        promise
          .finally(() => {
            if (inflight.get(dedupeKey) === promise) inflight.delete(dedupeKey);
          })
          .catch(() => {});
      }
      snapshot = await promise;
    }
    return new NextResponse(snapshot.body, {
      status: snapshot.status,
      headers: {
        'Content-Type': snapshot.contentType,
        'X-Indexer-Breaker': snapshot.breakerSnapshot,
        ...(snapshot.cacheControl ? { 'Cache-Control': snapshot.cacheControl } : {}),
      },
    });
  } catch (e) {
    breaker.recordFailure();
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: 'indexer unreachable', detail: msg },
      { status: 502, headers: { 'X-Indexer-Breaker': breaker.state() } },
    );
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  return proxy(req, await params);
}
