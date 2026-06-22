import { NextRequest, NextResponse } from 'next/server';
import { getL1Rpc } from '@/lib/rpc-config';
import { createBreaker } from '@/lib/circuit-breaker';

// Circuit breaker — trip after 8 consecutive 5xx/network errors in 10s, stay
// open 30s, then probe. RPC is the most load-bearing upstream; tripping fast
// is critical so the client sees 503 and falls back to cached state instead
// of hanging on a dead provider.
const RPC_COOLDOWN_MS = 30_000;
const rpcBreaker = createBreaker('rpc-proxy', {
  tripThreshold: 8,
  tripWindowMs: 10_000,
  cooldownMs: RPC_COOLDOWN_MS,
});

/**
 * Transparent JSON-RPC passthrough.
 *
 * Used by the `/rpc` rewrite (see next.config.js). The browser POSTs JSON-RPC
 * payloads to `/rpc`, Next forwards to here, and we forward to the real L1
 * upstream with sanitized headers so providers like Helius don't reject the
 * forwarded request based on the original `Origin` header.
 *
 * Key behaviors:
 *   - Strips `origin`, `referer`, `host`, and hop-by-hop headers before
 *     forwarding to the upstream.
 *   - Forwards request body verbatim (single-call or batch JSON-RPC).
 *   - Pipes the upstream response body and status back unchanged.
 *   - Adds `Cache-Control: no-store` so responses don't get cached anywhere.
 *
 * No origin-restrictions on the browser side: the response is served from
 * the same origin as the page, so CORS never applies.
 */

export const dynamic = 'force-dynamic';
// Use the Node runtime (not edge) so `fetch` against the upstream goes
// through the standard Node stack with full keep-alive support.
export const runtime = 'nodejs';

/** Headers that should never be forwarded upstream. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-length',
  // x-forwarded-* leaks deployment topology to upstream; not useful for RPC
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-vercel-forwarded-for',
  'x-vercel-ip-country',
  'x-vercel-ip-country-region',
  'x-vercel-ip-city',
]);

/** Headers we drop from the upstream response before returning to the browser. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-expose-headers',
  'access-control-max-age',
]);

function buildForwardHeaders(req: NextRequest): Headers {
  const forwarded = new Headers();
  req.headers.forEach((value, key) => {
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) return;
    forwarded.set(key, value);
  });
  // Ensure JSON-RPC default content type if the browser didn't set one.
  if (!forwarded.has('content-type')) {
    forwarded.set('content-type', 'application/json');
  }
  return forwarded;
}

async function passthrough(req: NextRequest, body: BodyInit | null) {
  let upstream: string;
  try {
    upstream = getL1Rpc();
  } catch (err) {
    return NextResponse.json(
      { error: { code: -32603, message: (err as Error).message || 'RPC not configured' } },
      { status: 500 },
    );
  }

  // Fail-fast when breaker is open — clients get an immediate 503 instead of
  // burning their per-request timeout on a known-dead upstream.
  if (rpcBreaker.shouldShortCircuit()) {
    return NextResponse.json(
      {
        error: {
          code: -32603,
          message: 'RPC breaker open',
          data: { retryAfterMs: RPC_COOLDOWN_MS },
        },
      },
      { status: 503, headers: { 'X-Rpc-Breaker': 'open', 'Cache-Control': 'no-store' } },
    );
  }

  const headers = buildForwardHeaders(req);
  try {
    const upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body,
      // Streaming the body avoids loading large batch responses into memory.
      // Solana JSON-RPC payloads are typically small, but program-account
      // queries can be hefty.
      // @ts-expect-error -- duplex is required for streamed bodies in Node 18+
      duplex: 'half',
      // No redirect; the upstream RPC shouldn't redirect and following one
      // could expose a different host to the client.
      redirect: 'manual',
      cache: 'no-store',
    });

    if (upstreamRes.status >= 500) rpcBreaker.recordFailure();
    else rpcBreaker.recordSuccess();

    const responseHeaders = new Headers();
    upstreamRes.headers.forEach((value, key) => {
      if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) return;
      responseHeaders.set(key, value);
    });
    responseHeaders.set('Cache-Control', 'no-store');
    responseHeaders.set('X-Rpc-Breaker', rpcBreaker.state());

    return new NextResponse(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    rpcBreaker.recordFailure();
    return NextResponse.json(
      {
        error: {
          code: -32603,
          message: 'Upstream RPC fetch failed',
          data: { detail: (err as Error)?.message?.slice(0, 200) },
        },
      },
      { status: 502, headers: { 'X-Rpc-Breaker': rpcBreaker.state() } },
    );
  }
}

export async function POST(request: NextRequest) {
  // Read the body as a buffer to safely forward without re-encoding.
  const body = await request.arrayBuffer();
  return passthrough(request, body);
}

export async function GET(request: NextRequest) {
  // Some clients use GET for cluster info / health checks. Forward without body.
  return passthrough(request, null);
}

export async function OPTIONS() {
  // Pre-flight isn't strictly needed (same-origin) but answer it cleanly so
  // any browser that probes gets a 204 instead of a method-not-allowed.
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
