import { useState, useEffect } from 'react';

const SOL_DEFAULT_B58 = '11111111111111111111111111111111';
const POKER_MINT_B58 = 'FP111dxqjLRqtuoknQ8L6aaZjqqyFRT6FcAnaCPytJ3';
const USDC_MAINNET_MINT_B58 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DEVNET_MINT_B58 = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

function getTokenImageFallback(mint?: string): string {
  if (!mint || mint === SOL_DEFAULT_B58) return '/tokens/sol.svg';
  if (mint === POKER_MINT_B58) return '/brand/app-icon.png';
  if (mint === USDC_MAINNET_MINT_B58 || mint === USDC_DEVNET_MINT_B58) return '/tokens/usdc.svg';
  return '/tokens/sol.svg';
}

const tokenLogoCache = new Map<string, string>();

export function useTokenLogo(mint?: string): string {
  const fallback = getTokenImageFallback(mint);
  const isKnown =
    !mint ||
    mint === SOL_DEFAULT_B58 ||
    mint === POKER_MINT_B58 ||
    mint === USDC_MAINNET_MINT_B58 ||
    mint === USDC_DEVNET_MINT_B58;
  const isCustom = !isKnown;
  const [logo, setLogo] = useState(() => isCustom ? (tokenLogoCache.get(mint!) || fallback) : fallback);
  useEffect(() => {
    if (!isCustom || !mint) return;
    if (tokenLogoCache.has(mint)) { setLogo(tokenLogoCache.get(mint)!); return; }
    let active = true;
    fetch(`/api/token-meta?mints=${mint}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!active || !data?.[mint]?.logoURI) return;
        tokenLogoCache.set(mint, data[mint].logoURI);
        setLogo(data[mint].logoURI);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [mint, isCustom]);
  return logo;
}
