'use client';

import { useEffect, useState } from 'react';

/**
 * Per-table display name lookup. Returns `null` for tables that haven't
 * claimed a name (caller falls back to an auto-generated friendly name).
 *
 * Standalone source release: table labels are local browser preferences, not
 * indexer-owned global claims. Callers fall back to generated names when absent.
 */

interface CacheEntry {
  names: Record<string, string | null>;
  fetchedAtMs: number;
}

const CACHE_TTL_MS = 60_000;
const REFRESH_MS = 30_000;
const STORAGE_KEY = 'fastpoker.tableNames.v1';
const STORAGE_EVENT = 'fastpoker:table-names-updated';
const moduleCache = new Map<string, CacheEntry>();
const inflight: Map<string, Promise<Record<string, string | null>>> = new Map();

function cacheKeyFor(pdas: string[]): string {
  return [...pdas].sort().join(',');
}

async function fetchNames(pdas: string[]): Promise<Record<string, string | null>> {
  if (pdas.length === 0) return {};
  const key = cacheKeyFor(pdas);
  const cached = moduleCache.get(key);
  if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) return cached.names;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      const stored = typeof window === 'undefined'
        ? {}
        : JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, string>;
      const names: Record<string, string | null> = {};
      for (const pda of pdas) names[pda] = stored[pda] ?? null;
      moduleCache.set(key, { names, fetchedAtMs: Date.now() });
      return names;
    } catch {
      return {} as Record<string, string | null>;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function useTableNames(pdas: readonly string[]): {
  names: Record<string, string | null>;
  loading: boolean;
} {
  const sortedKey = [...pdas].sort().join(',');
  const [names, setNames] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (pdas.length === 0) {
      setNames({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      const result = await fetchNames([...pdas]);
      if (!cancelled) {
        setNames(result);
        setLoading(false);
      }
    };
    void run();
    const id = window.setInterval(run, REFRESH_MS);
    window.addEventListener(STORAGE_EVENT, run);
    window.addEventListener('storage', run);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener(STORAGE_EVENT, run);
      window.removeEventListener('storage', run);
    };
    // sortedKey is the canonical dependency — array identity changes on every
    // render but content stability is what we actually want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedKey]);

  return { names, loading };
}

/** One-shot availability ping for the create-table / rename forms. */
export async function checkNameAvailable(name: string): Promise<{ ok: boolean; available: boolean }> {
  const lower = name.trim().toLowerCase();
  if (!NAME_PATTERN.test(name.trim())) return { ok: false, available: false };
  if (typeof window === 'undefined') return { ok: true, available: true };
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, string>;
    const taken = Object.values(stored).some((v) => v.toLowerCase() === lower);
    return { ok: true, available: !taken };
  } catch {
    return { ok: true, available: true };
  }
}

/** Client-side validation mirror (3-20 chars, [A-Za-z0-9_-]). */
export const NAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;
export { STORAGE_EVENT as TABLE_NAMES_STORAGE_EVENT, STORAGE_KEY as TABLE_NAMES_STORAGE_KEY };
