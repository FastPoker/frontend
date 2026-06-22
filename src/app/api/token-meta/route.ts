import { NextRequest, NextResponse } from 'next/server';
import { requireRateLimit } from '@/lib/api-rate-limit';

const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
// Full URL for the Helius DAS endpoint. Defaults to env-driven URL so the
// provider/cluster can be swapped without touching code. If only the key is
// set, we fall back to a Helius mainnet base for legacy deployments.
const HELIUS_DAS_BASE = process.env.HELIUS_DAS_URL || process.env.HELIUS_BASE_URL || '';

interface TokenMeta {
  name: string;
  symbol: string;
  logoURI: string | null;
  verified: boolean;
}

/**
 * GET /api/token-meta?mints=mint1,mint2,...
 * Server-side token metadata resolver. Tries multiple sources:
 * 1. Jupiter Token API (v1 legacy + v2 search)
 * 2. Helius DAS API (getAssetBatch)
 * Returns: { [mint]: TokenMeta }
 */
export async function GET(req: NextRequest) {
  // Per-IP cap: this endpoint fans out to up to 3 external APIs per uncached
  // mint, so randomized-mint flooding (cache-bust amplification) would burn our
  // Helius/Jupiter quota. 120/min is generous for real use (a page load batches
  // up to 50 mints per call and the client caches results).
  const limited = requireRateLimit(req, 'token-meta', '', 120, 60_000);
  if (limited) return limited;

  const mintsParam = req.nextUrl.searchParams.get('mints');
  if (!mintsParam) {
    return NextResponse.json({}, { status: 400 });
  }

  // Only accept well-formed base58 mint addresses. The values are interpolated
  // into upstream Jupiter/Helius URLs, so reject anything that could deform the
  // request path (slashes, dots, query/url control chars) before it leaves us.
  const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const mints = mintsParam.split(',').filter((m) => BASE58_MINT.test(m)).slice(0, 50);
  if (mints.length === 0) {
    return NextResponse.json({}, { status: 400 });
  }
  const results: Record<string, TokenMeta> = {};

  // ── Attempt 1: Jupiter Token API (try multiple endpoints) ──
  const unfetched: string[] = [];
  
  // Try batch via Jupiter v1 (still works for many tokens)
  try {
    for (const mint of mints) {
      try {
        // Try the legacy single-token endpoint
        const res = await fetch(`https://tokens.jup.ag/token/${mint}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const j = await res.json();
          results[mint] = {
            name: j.name || 'Unknown',
            symbol: j.symbol || '???',
            logoURI: j.logoURI || j.icon || null,
            verified: j.isVerified === true || (Array.isArray(j.tags) && j.tags.includes('verified')),
          };
          continue;
        }
      } catch { /* try next */ }
      unfetched.push(mint);
    }
  } catch { /* continue to next source */ }

  // ── Attempt 2: Jupiter v1 API alt endpoint ──
  if (unfetched.length > 0) {
    const stillMissing: string[] = [];
    for (const mint of unfetched) {
      try {
        const res = await fetch(`https://api.jup.ag/tokens/v1/${mint}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const j = await res.json();
          results[mint] = {
            name: j.name || 'Unknown',
            symbol: j.symbol || '???',
            logoURI: j.logoURI || j.icon || null,
            verified: j.isVerified === true || (Array.isArray(j.tags) && j.tags.includes('verified')),
          };
          continue;
        }
      } catch { /* continue */ }
      stillMissing.push(mint);
    }
    unfetched.length = 0;
    unfetched.push(...stillMissing);
  }

  // ── Attempt 3: Helius DAS API (getAssetBatch) ──
  // HELIUS_DAS_URL may already include the full `?api-key=<key>`. Only append
  // the key when the base doesn't already carry it — otherwise the key gets
  // doubled (`?api-key=KEYKEY`), the DAS call 401s, and every token without a
  // Jupiter listing silently falls back to mint+"???" (no name/image).
  const dasUrl = HELIUS_DAS_BASE
    ? (/[?&]api-key=/.test(HELIUS_DAS_BASE) ? HELIUS_DAS_BASE : `${HELIUS_DAS_BASE}${HELIUS_KEY}`)
    : '';
  if (unfetched.length > 0 && dasUrl) {
    try {
      const res = await fetch(dasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'token-meta',
          method: 'getAssetBatch',
          params: { ids: unfetched },
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.result && Array.isArray(json.result)) {
          for (const asset of json.result) {
            if (!asset || !asset.id) continue;
            const mint = asset.id;
            const meta = asset.content?.metadata;
            const links = asset.content?.links;
            const jsonUri = asset.content?.json_uri;
            
            results[mint] = {
              name: meta?.name || 'Unknown',
              symbol: meta?.symbol || '???',
              logoURI: links?.image || null,
              verified: false, // Helius metadata does not include the aggregator verification flag
            };

            // If no image from DAS, try fetching the json_uri for image
            if (!results[mint].logoURI && jsonUri) {
              try {
                const uriRes = await fetch(jsonUri, { signal: AbortSignal.timeout(3000) });
                if (uriRes.ok) {
                  const uriJson = await uriRes.json();
                  if (uriJson.image) {
                    results[mint].logoURI = uriJson.image;
                  }
                }
              } catch { /* skip */ }
            }
          }
        }
      }
    } catch { /* skip */ }
  }

  // Fill remaining with fallbacks
  for (const mint of mints) {
    if (!results[mint]) {
      results[mint] = {
        name: mint.slice(0, 6) + '...' + mint.slice(-4),
        symbol: '???',
        logoURI: null,
        verified: false,
      };
    }
  }

  return NextResponse.json(results, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
  });
}
