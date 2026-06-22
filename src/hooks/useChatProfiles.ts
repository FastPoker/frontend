'use client';

import { useEffect, useRef, useState } from 'react';
import { PROFILE_API_ENABLED } from '@/lib/feature-flags';

export interface ChatProfile {
  username: string;
  avatarType: string;          // 'generated' | 'curated' | 'nft'
  avatarValue: string;
  avatarSeed: string;
  avatarImageUrl: string;      // resolved NFT/curated image (if any)
  avatarUrl?: string;          // legacy profile payload fallback
  avatarCollection: string;
  avatarCollectionColor: string;
  level: number;               // tier-frame level (0 = ROOKIE / no frame)
  xpInLevel: number;           // xp into current level (for ring fill)
  handsWon: number;
}

// Module-level cache so multiple ChatPanels mounted on the same page share a
// single batch fetch, and re-renders don't re-hit the API.
const cache = new Map<string, ChatProfile | null>(); // null = miss / no profile
const inflight = new Map<string, Promise<void>>();    // batch key -> request

async function batchLoad(missing: string[]): Promise<void> {
  // Skip wallets we already have an inflight request for
  const toFetch = missing.filter((w) => !inflight.has(w));
  if (toFetch.length === 0) return;

  // Public source release ships no /api/profile backend. Operators that add
  // their own compatible route can opt in with NEXT_PUBLIC_ENABLE_PROFILES=1.
  if (!PROFILE_API_ENABLED) {
    for (const w of toFetch) cache.set(w, null);
    return;
  }

  const promise = (async () => {
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallets: toFetch }),
      });
      if (!res.ok) {
        for (const w of toFetch) cache.set(w, null);
        return;
      }
      const data = (await res.json()) as { profiles?: Record<string, ChatProfile> };
      for (const w of toFetch) {
        cache.set(w, data.profiles?.[w] ?? null);
      }
    } catch {
      for (const w of toFetch) cache.set(w, null);
    }
  })();

  for (const w of toFetch) inflight.set(w, promise);
  await promise;
  for (const w of toFetch) inflight.delete(w);
}

export function useChatProfiles(wallets: string[]): Record<string, ChatProfile | null> {
  const [tick, setTick] = useState(0);
  // Avoid spamming requests when the wallet list churns rapidly.
  const lastKeyRef = useRef('');

  useEffect(() => {
    const unique = Array.from(new Set(wallets.filter((w) => w && w !== '11111111111111111111111111111111')));
    const missing = unique.filter((w) => !cache.has(w));
    if (missing.length === 0) return;

    const key = missing.sort().join(',');
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;

    let cancelled = false;
    void batchLoad(missing).then(() => {
      if (!cancelled) setTick((t) => t + 1);
    });
    return () => { cancelled = true; };
  }, [wallets]);

  const out: Record<string, ChatProfile | null> = {};
  for (const w of wallets) out[w] = cache.get(w) ?? null;
  return out;
  // tick is intentionally referenced to force re-render after batch resolves
  void tick;
}
