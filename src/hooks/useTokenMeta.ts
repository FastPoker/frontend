import { useEffect, useState } from 'react';
import {
  type TokenMeta,
  getCachedTokenMeta,
  fetchTokenMeta,
} from '@/lib/tokens/metadata';

const DEFAULT_FALLBACK_LOGO = '/tokens/sol.svg';

export function useTokenMeta(mint?: string): TokenMeta | null {
  const [meta, setMeta] = useState<TokenMeta | null>(() =>
    mint ? (getCachedTokenMeta(mint) ?? null) : null
  );
  useEffect(() => {
    if (!mint) {
      setMeta(null);
      return;
    }
    const cached = getCachedTokenMeta(mint);
    if (cached !== undefined) {
      setMeta(cached ?? fallback(mint));
      return;
    }
    let active = true;
    fetchTokenMeta([mint]).then((r) => {
      if (active) setMeta(r[mint] ?? fallback(mint));
    });
    return () => {
      active = false;
    };
  }, [mint]);
  return meta;
}

export function useTokenMetaBatch(mints: string[]): Record<string, TokenMeta> {
  const [metas, setMetas] = useState<Record<string, TokenMeta>>({});
  useEffect(() => {
    if (mints.length === 0) {
      setMetas({});
      return;
    }
    let active = true;
    fetchTokenMeta(mints).then((r) => {
      if (active) setMetas(r);
    });
    return () => {
      active = false;
    };
  }, [mints.join(',')]);
  return metas;
}

function fallback(mint: string): TokenMeta {
  return {
    mint,
    symbol: mint.slice(0, 4),
    name: mint.slice(0, 4),
    decimals: 0,
    logoURI: DEFAULT_FALLBACK_LOGO,
  };
}
