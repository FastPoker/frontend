/**
 * Module-level system-health bus. Callers report status per channel; the
 * `useSystemHealth` hook reads the aggregate snapshot.
 *
 * Channels:
 *   - 'indexer' — /api/indexer/* proxy + WS gateway
 *   - 'rpc'     — /rpc + /api/rpc/proxy upstream (Helius / fallback)
 *   - 'tee'     — /api/tee/token + ER WS
 *
 * Status values:
 *   - 'ok'        : last call succeeded
 *   - 'degraded'  : last call returned a partial failure / breaker half-open
 *   - 'down'      : breaker open or N consecutive failures
 *
 * Callers report via reportHealth(channel, status, detail).
 * The DegradedBanner subscribes via useSystemHealth() and renders at the
 * top of every non-bare layout when any channel != 'ok'.
 */

export type HealthChannel = 'indexer' | 'rpc' | 'tee';
export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface ChannelHealth {
  status: HealthStatus;
  detail?: string;
  lastChangeMs: number;
}

export interface SystemHealthSnapshot {
  indexer: ChannelHealth;
  rpc: ChannelHealth;
  tee: ChannelHealth;
  /** Worst status across all channels. */
  overall: HealthStatus;
}

const INITIAL_CHANNEL: ChannelHealth = { status: 'ok', lastChangeMs: 0 };

let snapshot: SystemHealthSnapshot = {
  indexer: { ...INITIAL_CHANNEL },
  rpc: { ...INITIAL_CHANNEL },
  tee: { ...INITIAL_CHANNEL },
  overall: 'ok',
};

const subscribers = new Set<(s: SystemHealthSnapshot) => void>();

function aggregate(s: SystemHealthSnapshot): HealthStatus {
  const states = [s.indexer.status, s.rpc.status, s.tee.status];
  if (states.includes('down')) return 'down';
  if (states.includes('degraded')) return 'degraded';
  return 'ok';
}

function publish(next: SystemHealthSnapshot) {
  next.overall = aggregate(next);
  snapshot = next;
  subscribers.forEach((fn) => fn(next));
}

/**
 * Report the health of a channel. Idempotent: only publishes when the status
 * actually changes (or the detail changes within the same status). This
 * keeps the banner from flickering on every fetch tick.
 */
export function reportHealth(
  channel: HealthChannel,
  status: HealthStatus,
  detail?: string,
): void {
  const prev = snapshot[channel];
  if (prev.status === status && prev.detail === detail) return;
  publish({
    ...snapshot,
    [channel]: { status, detail, lastChangeMs: Date.now() },
  });
  // Track every state transition as a counter so we can build a Sentry
  // dashboard of breaker trip frequency per subsystem.
  // Lazy-imported so this module stays usable in non-browser contexts.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('./sentry-metrics') as typeof import('./sentry-metrics');
    m.count(m.NAMES.SYSTEM_HEALTH_CHANGE, 1, { channel, state: status });
  } catch {
    /* metrics never crash health bus */
  }
}

/** Read the current snapshot synchronously. */
export function getSystemHealth(): SystemHealthSnapshot {
  return snapshot;
}

/** Subscribe; returns unsubscribe. */
export function subscribeSystemHealth(
  fn: (s: SystemHealthSnapshot) => void,
): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn) as unknown as void;
}

/**
 * Inspect a Response's X-*-Breaker headers and update the matching channel.
 * Call this from any fetch site that talks to a breaker-protected endpoint.
 */
export function reportFromResponse(channel: HealthChannel, res: Response): void {
  const headerName = `x-${channel}-breaker`;
  const breakerHeader = res.headers.get(headerName);
  if (breakerHeader === 'open') {
    reportHealth(channel, 'down', 'breaker open');
    return;
  }
  if (breakerHeader === 'half-open') {
    reportHealth(channel, 'degraded', 'breaker probing');
    return;
  }
  if (res.status === 503) {
    reportHealth(channel, 'down', 'service unavailable');
    return;
  }
  if (res.status >= 500) {
    reportHealth(channel, 'degraded', `upstream ${res.status}`);
    return;
  }
  if (res.ok) {
    reportHealth(channel, 'ok');
  }
}
