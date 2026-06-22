'use client';

import { useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { POKER_MINT, USDC_MAINNET_MINT, USDC_DEVNET_MINT } from '@/lib/constants';

/**
 * A token that has been listed through the fastpoker_registry (auction win).
 * These are the *real* tokens a creator can spin a table in — the cash lobby's
 * "Pick a Token" autocomplete uses this instead of a hardcoded popular-token
 * list so it never suggests tokens that aren't actually on the protocol.
 */
export interface ListedTokenLite {
  mint: string;
  symbol: string;
  icon: string | null; // logoURI
  listedAt: number;
}

// Module-level cache so multiple lobby surfaces share one fetch. Listings
// change rarely (auction cadence), so a 5-min TTL is plenty.
let cache: ListedTokenLite[] | null = null;
let cacheAt = 0;
let inflight: Promise<ListedTokenLite[]> | null = null;
const TTL_MS = 5 * 60 * 1000;

async function fetchListed(): Promise<ListedTokenLite[]> {
  // Mints from the indexer-backed /api/listed-tokens proxy (subscription-fed, with
  // a server-side getProgramAccounts fallback). Replaces the per-client gPA that
  // every browser used to run on the registry every 5 min.
  const mints: string[] = [];
  const listedAt: Record<string, number> = {};
  try {
    const r = await fetch('/api/listed-tokens', { cache: 'no-store' });
    if (r.ok) {
      const body = (await r.json()) as { tokens?: Array<{ mint: string; listedAt: number }> };
      for (const t of body.tokens ?? []) {
        if (t?.mint && !(t.mint in listedAt)) {
          mints.push(t.mint);
          listedAt[t.mint] = t.listedAt ?? 0;
        }
      }
    }
  } catch { /* leave empty — caller keeps its last good cache */ }
  if (mints.length === 0) return [];

  // Resolve human symbols + logos (same metadata endpoint the create page uses).
  const meta = await fetch(`/api/token-meta?mints=${mints.join(',')}`)
    .then((r) => (r.ok ? r.json() : ({})))
    .catch(() => ({})) as Record<string, { name?: string; symbol?: string; logoURI?: string }>;

  const out: ListedTokenLite[] = mints.map((m) => ({
    mint: m,
    symbol: meta[m]?.symbol || m.slice(0, 4) + '…',
    icon: meta[m]?.logoURI || null,
    listedAt: listedAt[m] ?? 0,
  }));
  out.sort((a, b) => b.listedAt - a.listedAt);
  return out;
}

export function useListedTokens(): ListedTokenLite[] {
  const [tokens, setTokens] = useState<ListedTokenLite[]>(cache ?? []);
  useEffect(() => {
    let cancelled = false;
    if (cache && Date.now() - cacheAt < TTL_MS) {
      setTokens(cache);
      return;
    }
    if (!inflight) {
      inflight = fetchListed()
        .then((r) => { cache = r; cacheAt = Date.now(); inflight = null; return r; })
        .catch(() => { inflight = null; return cache ?? []; });
    }
    inflight.then((r) => { if (!cancelled) setTokens(r); });
    return () => { cancelled = true; };
  }, []);
  return tokens;
}

// Well-known tokens not in the auction registry (native / system). This is now
// the ONE place they're hardcoded: useTokenMeta is the single mint→symbol/icon
// resolver the lobby chips, table rows, and filter all share, so a listed token
// like $HYPE resolves identically everywhere — no more truncated-mint mismatches
// that hid tables or duplicated chips.
const KNOWN_TOKENS: Record<string, { symbol: string; icon: string | null }> = {
  [PublicKey.default.toBase58()]: { symbol: 'SOL', icon: '/tokens/sol.svg' },
  [POKER_MINT.toBase58()]: { symbol: '$FP', icon: '/brand/app-icon.png' },
  [USDC_MAINNET_MINT.toBase58()]: { symbol: 'USDC', icon: '/tokens/usdc.svg' },
  [USDC_DEVNET_MINT.toBase58()]: { symbol: 'USDC', icon: '/tokens/usdc.svg' },
};

export interface TokenMetaResolver {
  /** Symbol for a mint: known native token → registry (token-meta) → short mint. */
  symbolFor: (mint: string) => string;
  /** Logo for a mint, or null (caller renders a monogram fallback). */
  iconFor: (mint: string) => string | null;
}

/**
 * Unified mint → symbol/icon resolver, backed by the on-chain registry
 * (useListedTokens, which is now indexer-fed). Replaces the ~6 scattered
 * hardcoded getTokenSymbol/tokenSymbolFor copies so every cash-lobby surface
 * agrees on a token's symbol — required for the filter, chips, and rows to match.
 */
export function useTokenMeta(): TokenMetaResolver {
  const listed = useListedTokens();
  return useMemo(() => {
    const byMint = new Map(listed.map((t) => [t.mint, t] as const));
    return {
      symbolFor: (mint: string): string =>
        KNOWN_TOKENS[mint]?.symbol ?? byMint.get(mint)?.symbol ?? (mint ? mint.slice(0, 4) + '…' : '?'),
      iconFor: (mint: string): string | null =>
        KNOWN_TOKENS[mint]?.icon ?? byMint.get(mint)?.icon ?? null,
    };
  }, [listed]);
}
