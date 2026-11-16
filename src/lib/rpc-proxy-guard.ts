/**
 * Abuse guard for the same-origin `/rpc` JSON-RPC proxy (server-only).
 *
 * The proxy spends the operator's metered RPC credits, so it must not be a
 * general-purpose Solana RPC for the internet. Layers, cheapest first:
 *
 *   1. Browser provenance — the request must carry an `Origin` that is this
 *      site (or an explicitly allowed origin), and when the browser sends
 *      Fetch Metadata it must say `same-origin`. This stops other websites and
 *      naive scripts. It is NOT authentication: a custom client can forge
 *      these headers, which is why the layers below exist.
 *   2. Method allowlist — only the JSON-RPC methods this frontend calls.
 *   3. Parameter limits — getProgramAccounts only against this app's programs,
 *      bounded batch size, bounded body size.
 *   4. Budgets — a per-IP credit budget, a tighter per-IP send budget, and a
 *      global ceiling that holds even if per-IP limits are evaded.
 *
 * Budgets are in-process. A multi-instance / serverless deployment gets one
 * budget per instance; put a shared limiter (CDN/WAF rule) in front for those.
 */
import type { NextRequest } from 'next/server';
import {
  ANCHOR_PROGRAM_ID,
  FASTPOKER_REGISTRY_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  STEEL_PROGRAM_ID,
} from './constants';
import { DELEGATION_PROGRAM_ID } from './validator-registry';

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function envList(name: string): string[] {
  return (process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export const MAX_BODY_BYTES = envInt('RPC_PROXY_MAX_BODY_BYTES', 128 * 1024);
const MAX_BATCH = envInt('RPC_PROXY_MAX_BATCH', 100);
const WINDOW_MS = 60_000;
/** Credits one IP may spend per minute. */
const IP_CREDITS_PER_MIN = envInt('RPC_PROXY_IP_CREDITS_PER_MIN', 600);
/** Transaction sends one IP may make per minute. */
const IP_SENDS_PER_MIN = envInt('RPC_PROXY_IP_SENDS_PER_MIN', 30);
/** Credits the whole proxy may spend per minute (0 disables the ceiling). */
const GLOBAL_CREDITS_PER_MIN = envInt('RPC_PROXY_GLOBAL_CREDITS_PER_MIN', 6000);

/**
 * Methods the frontend actually calls, with an approximate credit cost.
 * Anything not listed is rejected. Extend with RPC_PROXY_EXTRA_METHODS
 * (comma-separated, each costed at 1).
 */
const METHOD_COST: Record<string, number> = {
  getAccountInfo: 1,
  getMultipleAccounts: 1,
  getBalance: 1,
  getTokenAccountBalance: 1,
  getTokenSupply: 1,
  getLatestBlockhash: 1,
  isBlockhashValid: 1,
  getSignatureStatuses: 1,
  getSlot: 1,
  getBlockHeight: 1,
  getBlockTime: 1,
  getEpochInfo: 1,
  getGenesisHash: 1,
  getVersion: 1,
  getHealth: 1,
  getMinimumBalanceForRentExemption: 1,
  getFeeForMessage: 1,
  getRecentPrioritizationFees: 1,
  getPriorityFeeEstimate: 1,
  getTransaction: 1,
  getSignaturesForAddress: 1,
  simulateTransaction: 1,
  sendTransaction: 1,
  getTokenAccountsByOwner: 10,
  getProgramAccounts: 10,
  getProgramAccountsV2: 10,
};
for (const m of envList('RPC_PROXY_EXTRA_METHODS')) {
  if (!(m in METHOD_COST)) METHOD_COST[m] = 1;
}

const PROGRAM_SCAN_METHODS = new Set(['getProgramAccounts', 'getProgramAccountsV2']);

/** Programs getProgramAccounts may scan. Extend with RPC_PROXY_GPA_PROGRAMS. */
const SCANNABLE_PROGRAMS = new Set<string>([
  ANCHOR_PROGRAM_ID.toBase58(),
  FASTPOKER_REGISTRY_PROGRAM_ID.toBase58(),
  PERMISSION_PROGRAM_ID.toBase58(),
  STEEL_PROGRAM_ID.toBase58(),
  DELEGATION_PROGRAM_ID.toBase58(),
  ...envList('RPC_PROXY_GPA_PROGRAMS'),
]);

export interface Rejection {
  status: number;
  message: string;
  retryAfterSec?: number;
}

// ── 1. Browser provenance ─────────────────────────────────────────────────

function configuredOrigins(): Set<string> {
  const out = new Set<string>();
  const raws = [
    process.env.APP_ORIGIN,
    process.env.NEXT_PUBLIC_APP_URL,
    ...envList('RPC_PROXY_ALLOWED_ORIGINS'),
  ];
  for (const raw of raws) {
    if (!raw) continue;
    try { out.add(new URL(raw).origin); } catch { /* ignore malformed entry */ }
  }
  return out;
}

export function checkProvenance(req: NextRequest): Rejection | null {
  const rawOrigin = req.headers.get('origin');
  if (!rawOrigin) return { status: 403, message: 'Origin required' };

  let origin: URL;
  try { origin = new URL(rawOrigin); } catch { return { status: 403, message: 'Invalid Origin' }; }

  // Same-origin: the page's origin host is the host this request was sent to.
  // Behind a reverse proxy the public host arrives as x-forwarded-host.
  const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || '')
    .split(',')[0].trim().toLowerCase();
  const sameHost = !!host && origin.host.toLowerCase() === host;

  if (!sameHost && !configuredOrigins().has(origin.origin)) {
    return { status: 403, message: 'Origin not allowed' };
  }

  // Fetch Metadata is set by the browser and cannot be overridden by page
  // script. Older browsers omit it, so only reject when it is present and wrong.
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') {
    return { status: 403, message: 'Cross-site request not allowed' };
  }
  return null;
}

// ── 2 + 3. Method allowlist and parameter limits ──────────────────────────

export interface ParsedRpc {
  credits: number;
  sends: number;
}

function checkCall(call: unknown): { cost: number; send: boolean } | string {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return 'Invalid JSON-RPC request';
  const { method, params } = call as { method?: unknown; params?: unknown };
  if (typeof method !== 'string') return 'Invalid JSON-RPC request';
  if (!Object.prototype.hasOwnProperty.call(METHOD_COST, method)) {
    return `Method not allowed: ${method.slice(0, 64)}`;
  }
  if (PROGRAM_SCAN_METHODS.has(method)) {
    const program = Array.isArray(params) ? params[0] : undefined;
    if (typeof program !== 'string' || !SCANNABLE_PROGRAMS.has(program)) {
      return `${method} is limited to this app's programs`;
    }
  }
  return { cost: METHOD_COST[method], send: method === 'sendTransaction' };
}

/** Validates a decoded JSON-RPC body (single call or batch). */
export function checkPayload(payload: unknown): ParsedRpc | Rejection {
  const calls = Array.isArray(payload) ? payload : [payload];
  if (calls.length === 0) return { status: 400, message: 'Empty batch' };
  if (calls.length > MAX_BATCH) return { status: 400, message: `Batch too large (max ${MAX_BATCH})` };

  let credits = 0;
  let sends = 0;
  for (const call of calls) {
    const r = checkCall(call);
    if (typeof r === 'string') return { status: 403, message: r };
    credits += r.cost;
    if (r.send) sends += 1;
  }
  return { credits, sends };
}

// ── 4. Budgets ────────────────────────────────────────────────────────────

/**
 * Client IP for rate limiting.
 *
 * `x-forwarded-for` is a list each proxy appends to, so its LEFT side is
 * whatever the client typed. Only the entries added by your own proxies are
 * trustworthy: with N trusted proxies in front of Node, the client is the
 * N-th entry from the right (RPC_PROXY_TRUSTED_HOPS, default 1).
 *
 * If your edge provides a dedicated header (e.g. `cf-connecting-ip`), name it
 * in RPC_PROXY_CLIENT_IP_HEADER — only do so when Node is unreachable except
 * through that edge, otherwise the header is forgeable.
 */
export function clientIp(req: NextRequest): string {
  const header = (process.env.RPC_PROXY_CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (header) {
    const v = req.headers.get(header)?.trim();
    if (v) return v;
  }
  const hops = Math.max(1, envInt('RPC_PROXY_TRUSTED_HOPS', 1));
  const chain = (req.headers.get('x-forwarded-for') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (chain.length > 0) return chain[Math.max(0, chain.length - hops)];
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

interface Bucket { used: number; resetAt: number }
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000;
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < WINDOW_MS && buckets.size < MAX_BUCKETS) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  // Still full of live buckets (address-spray): drop everything rather than
  // grow without bound. The global ceiling keeps spend bounded meanwhile.
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

function peek(key: string, now: number): Bucket {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { used: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, b);
  }
  return b;
}

/** Charges the request against every budget, or rejects without charging. */
export function chargeBudgets(ip: string, rpc: ParsedRpc): Rejection | null {
  const now = Date.now();
  sweep(now);

  const charges: Array<[Bucket, number, number]> = [
    [peek(`ip:${ip}`, now), rpc.credits, IP_CREDITS_PER_MIN],
  ];
  if (rpc.sends > 0) charges.push([peek(`send:${ip}`, now), rpc.sends, IP_SENDS_PER_MIN]);
  if (GLOBAL_CREDITS_PER_MIN > 0) {
    charges.push([peek('global', now), rpc.credits, GLOBAL_CREDITS_PER_MIN]);
  }

  for (const [bucket, amount, limit] of charges) {
    if (bucket.used + amount > limit) {
      return {
        status: 429,
        message: 'Rate limited',
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }
  }
  for (const [bucket, amount] of charges) bucket.used += amount;
  return null;
}
