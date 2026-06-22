/**
 * Server-side TEE token endpoint.
 * Returns a TEE auth token for client-side reads (no wallet popup needed).
 * Uses the authority keypair to authenticate — safe for non-private reads (table, seats).
 * Hole cards still need player-specific auth via wallet signMessage.
 *
 * Proxy support inherited from tee-auth-server.ts (TEE_PROXY env var).
 */
import { NextResponse } from 'next/server';
import { getTeeToken } from '@/lib/tee-auth-server';
import { createBreaker } from '@/lib/circuit-breaker';

const DEFAULT_TEE_BASE =
  process.env.TEE_RPC ||
  process.env.NEXT_PUBLIC_DEFAULT_TEE_RPC ||
  'https://mainnet-tee.magicblock.app';
const PUBLIC_TEE_BASE = process.env.NEXT_PUBLIC_DEFAULT_TEE_RPC || DEFAULT_TEE_BASE;

// Allowed validator URLs (whitelist to prevent SSRF)
const ALLOWED_VALIDATORS = new Set([
  'https://devnet-tee.magicblock.app',
  'https://mainnet-tee.magicblock.app',
]);

function isTeeProxyUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.pathname.startsWith('/api/tee/rpc');
  } catch {
    return value.startsWith('/api/tee/rpc');
  }
}

// TEE token issuance — invoked at session start and on token rotation, so
// failures here cascade into table-state polling collapse. Trip the breaker
// faster than RPC (smaller threshold) because the failure mode is usually
// "TEE down for a few minutes" and we want clients to see 503 immediately
// and surface the degraded banner.
const TEE_COOLDOWN_MS = 20_000;
const teeBreaker = createBreaker('tee-token', {
  tripThreshold: 4,
  tripWindowMs: 10_000,
  cooldownMs: TEE_COOLDOWN_MS,
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedValidator = url.searchParams.get('validator');
  const teeBase =
    requestedValidator && (ALLOWED_VALIDATORS.has(requestedValidator) || isTeeProxyUrl(requestedValidator))
      ? requestedValidator
      : PUBLIC_TEE_BASE;
  const tokenBase = isTeeProxyUrl(teeBase) ? DEFAULT_TEE_BASE : teeBase;

  if (teeBreaker.shouldShortCircuit()) {
    return NextResponse.json(
      { error: 'tee breaker open', retryAfterMs: TEE_COOLDOWN_MS },
      { status: 503, headers: { 'X-Tee-Breaker': 'open' } },
    );
  }

  try {
    const token = await getTeeToken(tokenBase);
    teeBreaker.recordSuccess();
    return NextResponse.json(
      { token, teeBase },
      { headers: { 'X-Tee-Breaker': teeBreaker.state() } },
    );
  } catch (e: any) {
    teeBreaker.recordFailure();
    console.error('TEE token error:', e.message);
    return NextResponse.json(
      { error: e.message },
      { status: 500, headers: { 'X-Tee-Breaker': teeBreaker.state() } },
    );
  }
}
