/**
 * Thin wrapper over Sentry's metrics API.
 *
 * Goals:
 *  - Inert (no-op) when the SDK isn't initialized (no DSN env var set in
 *    `instrumentation-client.ts`). Lets us sprinkle metric calls everywhere
 *    without import-time crashes in dev mode without Sentry configured.
 *  - One-line typed helpers per metric kind. Keep attribute cardinality
 *    bounded — never include wallet pubkeys, signatures, or per-user IDs
 *    as label values. Sentry bills metrics by unique attribute combinations;
 *    one wallet-per-label would explode the bill.
 *  - Stable metric name registry below — every metric used in the app is
 *    declared once here so we can audit cardinality and rename safely.
 *
 * Usage:
 *   import * as M from '@/lib/sentry-metrics';
 *   M.count(M.NAMES.SNG_JOIN_ATTEMPT, 1, { result: 'success', tier: 'micro' });
 */
import * as Sentry from '@sentry/nextjs';

/**
 * Allowed attribute keys. Adding here is fine; never add `wallet`, `sig`, etc.
 *
 * Index signature satisfies Sentry's `MetricOptions.attributes: Record<string,
 * unknown>` shape while keeping the named keys as documentation of "what we
 * actually use" — callers get IntelliSense on these names but the SDK accepts
 * any string key under the hood.
 */
export interface MetricAttrs {
  /** 'success' | 'failure' | 'cancelled' — outcome of the operation */
  result?: 'success' | 'failure' | 'cancelled';
  /** SNG tier slug: 'micro' | 'bronze' | 'silver' | ... — bounded set */
  tier?: string;
  /** Game type: 'hu' | '6max' | '9max' | 'cash' — bounded set */
  gameType?: string;
  /** Generic kind/category */
  kind?: string;
  /** HTTP-ish status class: '2xx' | '4xx' | '5xx' */
  status?: string;
  /** System health channel state, for breaker events */
  channel?: string;
  state?: string;
  /** Source page where the event originated, e.g. 'lobby' | 'profile' | 'earn' */
  surface?: string;
  /** Escape hatch — never add wallet/sig/IP here. */
  [key: string]: unknown;
}

function safe<T extends unknown[]>(fn: ((...args: T) => void) | undefined, ...args: T): void {
  try {
    fn?.(...args);
  } catch {
    // Never let a metric call crash the page.
  }
}

/** Increment a counter. value defaults to 1. */
export function count(name: string, value = 1, attributes?: MetricAttrs): void {
  safe(Sentry.metrics?.count, name, value, attributes ? { attributes } : undefined);
}

/** Set a gauge to the current value. */
export function gauge(name: string, value: number, attributes?: MetricAttrs, unit?: string): void {
  safe(Sentry.metrics?.gauge, name, value, attributes || unit ? { attributes, unit } : undefined);
}

/** Record a value for a distribution (percentiles, durations). */
export function distribution(
  name: string,
  value: number,
  attributes?: MetricAttrs,
  unit?: string,
): void {
  safe(Sentry.metrics?.distribution, name, value, attributes || unit ? { attributes, unit } : undefined);
}

/** Time-block helper. Wraps an async fn, records its duration to a distribution. */
export async function timed<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: MetricAttrs,
): Promise<T> {
  const t0 = performance.now();
  try {
    const result = await fn();
    distribution(name, performance.now() - t0, { ...attributes, result: 'success' }, 'millisecond');
    return result;
  } catch (e) {
    distribution(name, performance.now() - t0, { ...attributes, result: 'failure' }, 'millisecond');
    throw e;
  }
}

/**
 * Stable metric names. Keep this list curated — pick descriptive snake_case
 * names with a `fp.` prefix so they're easy to identify in Sentry's UI.
 */
export const NAMES = {
  // ─── SNG pool ───
  SNG_JOIN_ATTEMPT: 'fp.sng.join_attempt',
  SNG_LEAVE_ATTEMPT: 'fp.sng.leave_attempt',
  SNG_QUEUE_DEPTH: 'fp.sng.queue_depth', // gauge

  // ─── Cash table ───
  CASH_SEAT_ATTEMPT: 'fp.cash.seat_attempt',
  CASH_LEAVE_TABLE: 'fp.cash.leave_table',

  // ─── Claims ───
  CLAIM_ATTEMPT: 'fp.claim.attempt', // attributes: kind=poker|sng|stake, result

  // ─── Wallet ───
  // Intentionally NOT instrumented. Sentry's default global error handler
  // already captures wallet connect failures, and event-level "connect happened"
  // signals would force us to also label which provider was used (privy-email,
  // privy-social, external-wallet…) — useful telemetry, but the cardinality +
  // privacy surface isn't worth the small gain for a real-money product. See
  // 2026-05-16 discussion: wallet metrics removed by design.

  // ─── System health (driven by reportHealth) ───
  SYSTEM_HEALTH_CHANGE: 'fp.system.health_change', // attributes: channel, state

  // ─── Frontend perf ───
  PAGE_LOAD: 'fp.page.load', // distribution of TTI/etc per surface

  // ─── Errors that we intentionally classify (not Sentry-issue noise) ───
  RPC_BREAKER_TRIP: 'fp.rpc.breaker_trip',
  INDEXER_BREAKER_TRIP: 'fp.indexer.breaker_trip',
  TEE_BREAKER_TRIP: 'fp.tee.breaker_trip',
} as const;
