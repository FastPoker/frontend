/**
 * Client-side token metadata resolver.
 *
 * Per Q3 the Earn surfaces resolve token symbol/logo/decimals on the
 * client without a new backend dependency. This module wraps the
 * existing /api/token-meta endpoint (Jupiter strict list + Metaplex
 * fallback on the server) and adds a tiny in-memory LRU so repeated
 * queries do not re-hit the network.
 */

export interface TokenMeta {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

const SOL_DEFAULT_B58 = '11111111111111111111111111111111';
const POKER_MINT_B58 = 'FP111dxqjLRqtuoknQ8L6aaZjqqyFRT6FcAnaCPytJ3';
const USDC_MAINNET_MINT_B58 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DEVNET_MINT_B58 = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const NATIVE_SOL: TokenMeta = {
  mint: SOL_DEFAULT_B58,
  symbol: 'SOL',
  name: 'Solana',
  decimals: 9,
  logoURI: '/tokens/sol.svg',
};

const POKER: TokenMeta = {
  mint: POKER_MINT_B58,
  symbol: 'FP',
  name: '$FP',
  decimals: 9,
  logoURI: '/brand/app-icon.png',
};

const USDC: Omit<TokenMeta, 'mint'> = {
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: '/tokens/usdc.svg',
};

const cache = new Map<string, TokenMeta | null>();
cache.set(SOL_DEFAULT_B58, NATIVE_SOL);
cache.set(POKER_MINT_B58, POKER);
cache.set(USDC_MAINNET_MINT_B58, { mint: USDC_MAINNET_MINT_B58, ...USDC });
cache.set(USDC_DEVNET_MINT_B58, { mint: USDC_DEVNET_MINT_B58, ...USDC });

export function getCachedTokenMeta(mint: string): TokenMeta | null | undefined {
  return cache.get(mint);
}

export function shortenMint(mint: string, chars = 4): string {
  if (mint.length <= chars * 2 + 3) return mint;
  return `${mint.slice(0, chars)}...${mint.slice(-chars)}`;
}

type Server = Record<
  string,
  { symbol?: string; name?: string; decimals?: number; logoURI?: string } | null
>;

export async function fetchTokenMeta(mints: string[]): Promise<Record<string, TokenMeta>> {
  const missing = mints.filter((m) => !cache.has(m));
  if (missing.length === 0) {
    return Object.fromEntries(
      mints.map((m) => [m, cache.get(m) ?? fallbackUnknown(m)])
    );
  }
  try {
    const res = await fetch(`/api/token-meta?mints=${missing.join(',')}`);
    if (res.ok) {
      const data = (await res.json()) as Server;
      for (const m of missing) {
        const s = data[m];
        if (s && s.symbol) {
          cache.set(m, {
            mint: m,
            symbol: s.symbol,
            name: s.name ?? s.symbol,
            decimals: s.decimals ?? 0,
            logoURI: s.logoURI,
          });
        } else {
          cache.set(m, null);
        }
      }
    } else {
      for (const m of missing) cache.set(m, null);
    }
  } catch {
    for (const m of missing) cache.set(m, null);
  }
  return Object.fromEntries(
    mints.map((m) => [m, cache.get(m) ?? fallbackUnknown(m)])
  );
}

function fallbackUnknown(mint: string): TokenMeta {
  return {
    mint,
    symbol: shortenMint(mint),
    name: shortenMint(mint),
    decimals: 0,
  };
}

export { NATIVE_SOL, POKER };
