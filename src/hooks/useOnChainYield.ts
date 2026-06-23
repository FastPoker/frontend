'use client';

import { useEffect, useRef, useState } from 'react';
import { Connection } from '@solana/web3.js';

import { makeL1Connection, POOL_PDA } from '@/lib/constants';
import { shouldUsePool } from '@/lib/rpc-pool';

/**
 * Chain-derived pool yield stats, 100% client-side. Every user sees identical
 * numbers from public signature history.
 *
 * Read path: a direct signature walk of the pool PDA on the configured RPC
 * (getSignaturesForAddress + getParsedTransactions). This is a heavy read —
 * thousands of signatures and parsed-tx batches — so it is intentionally
 * skipped on the free public pool, where getParsedTransactions throughput is
 * throttled and the walk would hang. In that case the hook degrades to
 * `hasData: false`; surfaces should show a "connect your own RPC" hint rather
 * than a spinner. No indexer, no server route.
 */

export interface DayBar {
  day: string;
  sol: number;
}

export interface OnChainYield {
  lifetimeDays: number;
  trackedSol: number;
  avgDailySol: number;
  avgDailySol7d: number;
  annualSolPerFp: number;
  bars: DayBar[];
  loading: boolean;
  hasData: boolean;
  /** True when the heavy scan was skipped because we're on the free pool. */
  degraded: boolean;
}

const INITIAL: OnChainYield = {
  lifetimeDays: 0,
  trackedSol: 0,
  avgDailySol: 0,
  avgDailySol7d: 0,
  annualSolPerFp: 0,
  bars: [],
  loading: true,
  hasData: false,
  degraded: false,
};

const SIGNATURE_PAGE_SIZE = 200;
const MAX_SIGS = 3000;
const PARSE_BATCH = 20;
const CACHE_TTL_MS = 5 * 60_000;
const CHART_DAYS = 14;

interface Cache {
  fetchedAt: number;
  value: OnChainYield;
}

let _cache: Cache | null = null;
let _inflight: Promise<OnChainYield> | null = null;

function utcDay(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function fetchOnChainYieldRpc(conn: Connection, totalStaked: number): Promise<OnChainYield> {
  const pool = POOL_PDA;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const chartStart = new Date(today);
  chartStart.setUTCDate(chartStart.getUTCDate() - (CHART_DAYS - 1));
  const chartStartSec = Math.floor(chartStart.getTime() / 1000);

  const sigs: Awaited<ReturnType<Connection['getSignaturesForAddress']>> = [];
  let before: string | undefined;
  while (sigs.length < MAX_SIGS) {
    const page = await conn.getSignaturesForAddress(pool, {
      limit: Math.min(SIGNATURE_PAGE_SIZE, MAX_SIGS - sigs.length),
      before,
    });
    if (page.length === 0) break;
    sigs.push(...page);
    before = page[page.length - 1]?.signature;
    const oldestBlockTime = [...page].reverse().find((s) => s.blockTime)?.blockTime;
    if (oldestBlockTime && oldestBlockTime < chartStartSec) break;
    if (page.length < SIGNATURE_PAGE_SIZE) break;
  }
  if (sigs.length === 0) return { ...INITIAL, loading: false };

  const windowedSigs = sigs.filter((s) => !s.blockTime || s.blockTime >= chartStartSec);
  const signatures = windowedSigs.map((s) => s.signature);
  const parsed: Array<Awaited<ReturnType<Connection['getParsedTransaction']>>> = [];
  for (let i = 0; i < signatures.length; i += PARSE_BATCH) {
    const chunk = signatures.slice(i, i + PARSE_BATCH);
    const res = await conn.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0 });
    parsed.push(...res);
  }

  const poolStr = pool.toBase58();
  const dayMap = new Map<string, number>();
  let oldestTime = Number.POSITIVE_INFINITY;
  for (let i = 0; i < windowedSigs.length; i++) {
    const meta = parsed[i]?.meta;
    const blockTime = windowedSigs[i].blockTime;
    if (!meta || !blockTime) continue;
    if (blockTime < oldestTime) oldestTime = blockTime;
    const keys = parsed[i]?.transaction.message.accountKeys;
    if (!keys) continue;
    const poolIdx = keys.findIndex((k) => {
      const pk = typeof k === 'string' ? k : (k as { pubkey?: { toBase58?: () => string } }).pubkey?.toBase58?.() ?? '';
      return pk === poolStr;
    });
    if (poolIdx < 0) continue;
    const pre = meta.preBalances[poolIdx];
    const post = meta.postBalances[poolIdx];
    if (pre === undefined || post === undefined) continue;
    const delta = post - pre;
    if (delta <= 0) continue;
    const sol = delta / 1e9;
    const key = utcDay(blockTime);
    dayMap.set(key, (dayMap.get(key) ?? 0) + sol);
  }

  const bars: DayBar[] = [];
  for (let offset = CHART_DAYS - 1; offset >= 0; offset--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - offset);
    const key = utcDay(d.getTime() / 1000);
    bars.push({ day: key, sol: dayMap.get(key) ?? 0 });
  }
  const trackedSol = Array.from(dayMap.values()).reduce((s, v) => s + v, 0);
  const now = Math.floor(Date.now() / 1000);
  const oldest = Number.isFinite(oldestTime) ? oldestTime : now;
  const lifetimeDays = Math.max(1, (now - oldest) / 86_400);
  const avgDailySol = trackedSol / lifetimeDays;
  const last7 = bars.slice(-7);
  const avgDailySol7d = last7.length > 0 ? last7.reduce((s, b) => s + b.sol, 0) / last7.length : avgDailySol;
  const annualSolPerFp = totalStaked > 0 ? (avgDailySol7d * 365) / totalStaked : 0;

  return {
    lifetimeDays,
    trackedSol,
    avgDailySol,
    avgDailySol7d,
    annualSolPerFp,
    bars,
    loading: false,
    hasData: trackedSol > 0,
    degraded: false,
  };
}

async function loadOnce(totalStaked: number): Promise<OnChainYield> {
  // The signature-walk + parsed-tx scan is too heavy for the free public pool.
  // When no dedicated RPC is configured, skip it and report a degraded state so
  // the UI can prompt the user to connect their own endpoint instead of hanging.
  if (shouldUsePool()) {
    return { ...INITIAL, loading: false, degraded: true };
  }
  const conn = makeL1Connection();
  return fetchOnChainYieldRpc(conn, totalStaked);
}

export function useOnChainYield(totalStaked: number): OnChainYield {
  const [state, setState] = useState<OnChainYield>(() => _cache?.value ?? INITIAL);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const now = Date.now();
    if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
      setState(_cache.value);
      return;
    }

    const run = async () => {
      if (_inflight) {
        const v = await _inflight;
        if (mountedRef.current) setState(v);
        return;
      }
      _inflight = loadOnce(totalStaked)
        .then((v) => {
          _cache = { fetchedAt: Date.now(), value: v };
          return v;
        })
        .catch((err) => {
          console.error('useOnChainYield: load failed', err);
          return { ...INITIAL, loading: false, degraded: true };
        })
        .finally(() => {
          _inflight = null;
        });
      const v = await _inflight;
      if (mountedRef.current) setState(v);
    };

    void run();
    const id = setInterval(run, CACHE_TTL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-recompute annualSolPerFp when totalStaked changes without a refetch.
  if (state.hasData && totalStaked > 0 && state.avgDailySol7d > 0) {
    const annualSolPerFp = (state.avgDailySol7d * 365) / totalStaked;
    if (annualSolPerFp !== state.annualSolPerFp) {
      return { ...state, annualSolPerFp };
    }
  }

  return state;
}
