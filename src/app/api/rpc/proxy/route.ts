import { NextRequest, NextResponse } from 'next/server';
import { getL1Rpc } from '@/lib/rpc-config';
import { createBreaker } from '@/lib/circuit-breaker';
import {
  MAX_BODY_BYTES,
  chargeBudgets,
  checkPayload,
  checkProvenance,
  clientIp,
  type Rejection,
} from '@/lib/rpc-proxy-guard';

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
 * Guarded JSON-RPC proxy for this site's own pages.
 *
 * Used by the `/rpc` rewrite (see next.config.js). The browser POSTs JSON-RPC
 * payloads to `/rpc`, and we forward them to the real L1 upstream, whose URL
 * (and provider key) never leaves the server.
 *
 * This is deliberately NOT a general-purpose RPC endpoint — every request
 * passes `rpc-proxy-guard` first (same-origin browser provenance, method
 * allowlist, parameter limits, per-IP and global budgets).
 *
 * Nothing from the browser request is forwarded except the validated body,
 * and nothing from the upstream response is returned except status, content
 * type and body — so neither side can smuggle headers through.
 */

export const dynamic = 'force-dynamic';
// Use the Node runtime (not edge) so `fetch` against the upstream goes
// through the standard Node stack with full keep-alive support.
export const runtime = 'nodejs';

function rpcError(status: number, message: string, headers: Record<string, string> = {}) {
  return NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code: status === 429 ? -32005 : -32600, message } },
    { status, headers: { 'Cache-Control': 'no-store', ...headers } },
  );
}

function reject(r: Rejection) {
  return rpcError(
    r.status,
    r.message,
    r.retryAfterSec ? { 'Retry-After': String(r.retryAfterSec) } : {},
  );
}

function isRejection(v: unknown): v is Rejection {
  return typeof (v as Rejection)?.status === 'number';
}

/** Reads the body up to MAX_BODY_BYTES; null when it is larger. */
async function readBody(req: NextRequest): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

export async function POST(req: NextRequest) {
  const provenance = checkProvenance(req);
  if (provenance) return reject(provenance);

  const body = await readBody(req);
  if (!body) return rpcError(413, 'Request body too large');

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return rpcError(400, 'Invalid JSON');
  }

  const parsed = checkPayload(payload);
  if (isRejection(parsed)) return reject(parsed);

  const limited = chargeBudgets(clientIp(req), parsed);
  if (limited) return reject(limited);

  let upstream: string;
  try {
    upstream = getL1Rpc();
  } catch {
    return rpcError(500, 'RPC not configured');
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

  try {
    const upstreamRes = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body as BodyInit,
      // The upstream RPC shouldn't redirect, and a redirect target could carry
      // the provider URL — never follow one and never relay it.
      redirect: 'manual',
      cache: 'no-store',
    });

    if (upstreamRes.status >= 500) rpcBreaker.recordFailure();
    else rpcBreaker.recordSuccess();

    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      return rpcError(502, 'Upstream RPC returned an unexpected redirect', {
        'X-Rpc-Breaker': rpcBreaker.state(),
      });
    }

    return new NextResponse(upstreamRes.body, {
      status: upstreamRes.status,
      headers: {
        'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
        'X-Rpc-Breaker': rpcBreaker.state(),
      },
    });
  } catch {
    rpcBreaker.recordFailure();
    // No error detail: fetch failures can describe the upstream endpoint.
    return NextResponse.json(
      { error: { code: -32603, message: 'Upstream RPC fetch failed' } },
      { status: 502, headers: { 'X-Rpc-Breaker': rpcBreaker.state(), 'Cache-Control': 'no-store' } },
    );
  }
}

// JSON-RPC is POST-only. No GET passthrough and no CORS pre-flight answer:
// cross-origin callers are not supported, so a pre-flight simply fails.
