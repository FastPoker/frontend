'use client';

import { useEffect, useState } from 'react';
import { POKER_MINT } from '@/lib/constants';

const POKER_MINT_STR = POKER_MINT.toBase58();
const SOL_MINT_STR = 'So11111111111111111111111111111111111111112';

// $FP live USD price comes from /api/price (Jupiter-backed). It stays 0 with
// fpIsLive=false until the token has a market, so the UI shows no price rather
// than a hardcoded placeholder.

export interface PriceView {
  solPrice: number;
  /** 24h % change for SOL. Positive = up. From CoinGecko via /api/price. */
  solChange24h: number;
  fpPrice: number;
  fpChange24h: number;
  fpIsLive: boolean;
  /** True when $FP's only quote is a thin pool — show it flagged, not as a firm mark. */
  fpIndicative: boolean;
  loading: boolean;
}

const DEFAULT: PriceView = {
  solPrice: 0,
  solChange24h: 0,
  fpPrice: 0,
  fpChange24h: 0,
  fpIsLive: false,
  fpIndicative: false,
  loading: true,
};

let cached: { view: PriceView; ts: number } | null = null;
const TTL = 20_000;

/**
 * Shared price feed hook. SOL price + 24h change are pulled from /api/price
 * (CoinGecko-backed, server-side cached 60s). $FP is hardcoded until the
 * token has a live market; fpChange24h stays 0 until then.
 */
export function usePrices(): PriceView {
  const [view, setView] = useState<PriceView>(cached?.view ?? DEFAULT);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (cached && Date.now() - cached.ts < TTL) {
        setView(cached.view);
        return;
      }
      setView((v) => ({ ...v, loading: false }));
      // Both SOL + $FP come from DexScreener — free, CORS-enabled, no key, no RPC
      // budget, and no CoinGecko/Jupiter browser-CORS/rate-limit wall. One call
      // for both mints; per mint we take the most-liquid pair's USD price + 24h
      // change. Loads at every request level (including Minimal).
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT_STR},${POKER_MINT_STR}`);
        const json = await res.json();
        const pairs: any[] = Array.isArray(json?.pairs) ? json.pairs : [];
        const pick = (mint: string) =>
          pairs
            .filter((p) => p?.baseToken?.address === mint && p?.priceUsd)
            .sort((a, b) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0))[0];
        const solPair = pick(SOL_MINT_STR);
        const fpPair = pick(POKER_MINT_STR);
        const solUsd = solPair ? Number(solPair.priceUsd) || 0 : 0;
        const solChange = solPair ? Number(solPair.priceChange?.h24 ?? 0) : 0;
        const fpUsd = fpPair ? Number(fpPair.priceUsd) || 0 : 0;
        const fpChange = fpPair ? Number(fpPair.priceChange?.h24 ?? 0) : 0;
        if (!Number.isFinite(solUsd) || solUsd <= 0) throw new Error('no sol price');
        const fpLive = fpUsd > 0;
        const next: PriceView = {
          solPrice: solUsd,
          solChange24h: Number.isFinite(solChange) ? solChange : 0,
          fpPrice: fpUsd,
          fpChange24h: Number.isFinite(fpChange) ? fpChange : 0,
          fpIsLive: fpLive,
          fpIndicative: !fpLive,
          loading: false,
        };
        cached = { view: next, ts: Date.now() };
        if (!cancelled) setView(next);
      } catch {
        if (!cancelled) setView((v) => ({ ...v, loading: false }));
      }
    };
    load();
    // Jittered initial phase: stagger refresh wall-clock so multiple mounts
    // (FooterStrip + Navbar + landing) + multiple tabs don't all hit
    // CoinGecko at the same second.
    const jitter = Math.random() * TTL;
    let id: ReturnType<typeof setInterval> | null = null;
    const startTimer = setTimeout(() => {
      load();
      id = setInterval(load, TTL);
    }, jitter);
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      if (id) clearInterval(id);
    };
  }, []);

  return view;
}
