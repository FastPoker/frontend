/**
 * Generic per-route circuit breaker.
 *
 * Same semantics as the original indexer-proxy breaker:
 *   - `recordFailure()` N times within `tripWindowMs` → state = OPEN.
 *   - While OPEN, `shouldShortCircuit()` returns true and callers must skip
 *     the upstream call (and ideally fall back to cached/stale data).
 *   - After `cooldownMs`, the next `shouldShortCircuit()` flips to HALF-OPEN
 *     and returns false (one probe is allowed through). A successful probe
 *     closes the breaker; a failed probe re-opens it for another `cooldownMs`.
 *   - `recordSuccess()` from a closed breaker resets the failure counter.
 *
 * Per-instance state — call `createBreaker(name, opts)` once at module scope
 * for each protected upstream.
 *
 * Sentry: state transitions emit a Sentry metric (count + log) so we can chart
 * trip rate per upstream. No PII — only the breaker `name` as the channel label.
 */
import * as M from '@/lib/sentry-metrics';

function metricNameForBreaker(name: string): string {
  // Map breaker name → metric name. Falls back to a generic counter for any
  // breaker we haven't classified yet, keeping cardinality bounded.
  if (name.startsWith('rpc')) return M.NAMES.RPC_BREAKER_TRIP;
  if (name.startsWith('indexer')) return M.NAMES.INDEXER_BREAKER_TRIP;
  if (name.startsWith('tee')) return M.NAMES.TEE_BREAKER_TRIP;
  return M.NAMES.RPC_BREAKER_TRIP; // safe default; covers misc upstream breakers
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Consecutive failures within tripWindowMs that flip CLOSED → OPEN. */
  tripThreshold?: number;
  /** Window (ms) over which consecutive failures are counted. */
  tripWindowMs?: number;
  /** How long to stay OPEN before allowing a HALF-OPEN probe. */
  cooldownMs?: number;
}

export interface Breaker {
  readonly name: string;
  recordSuccess(): void;
  recordFailure(): void;
  shouldShortCircuit(): boolean;
  state(): BreakerState;
  /** Read-only diagnostics (last 30s). */
  snapshot(): {
    name: string;
    state: BreakerState;
    consecutiveFailures: number;
    openedAt: number;
  };
}

export function createBreaker(name: string, opts: BreakerOptions = {}): Breaker {
  const tripThreshold = opts.tripThreshold ?? 5;
  const tripWindowMs = opts.tripWindowMs ?? 10_000;
  const cooldownMs = opts.cooldownMs ?? 30_000;

  let state: BreakerState = 'closed';
  let consecutiveFailures = 0;
  let lastFailureAt = 0;
  let openedAt = 0;

  return {
    name,
    state: () => state,
    snapshot: () => ({ name, state, consecutiveFailures, openedAt }),

    recordSuccess(): void {
      consecutiveFailures = 0;
      if (state !== 'closed') {
        console.log(`[breaker:${name}] CLOSED (was ${state})`);
        state = 'closed';
      }
    },

    recordFailure(): void {
      const now = Date.now();
      if (now - lastFailureAt > tripWindowMs) consecutiveFailures = 0;
      consecutiveFailures += 1;
      lastFailureAt = now;
      if (state === 'closed' && consecutiveFailures >= tripThreshold) {
        state = 'open';
        openedAt = now;
        console.error(`[breaker:${name}] OPEN after ${tripThreshold} failures (cooldown ${cooldownMs}ms)`);
        M.count(metricNameForBreaker(name), 1, { channel: name, state: 'open' });
      } else if (state === 'half-open') {
        state = 'open';
        openedAt = now;
        console.warn(`[breaker:${name}] probe failed; back to OPEN`);
        M.count(metricNameForBreaker(name), 1, { channel: name, state: 'reopen' });
      }
    },

    shouldShortCircuit(): boolean {
      if (state === 'closed') return false;
      if (state === 'open' && Date.now() - openedAt > cooldownMs) {
        state = 'half-open';
        console.log(`[breaker:${name}] HALF-OPEN (probing)`);
        return false;
      }
      return state === 'open';
    },
  };
}

/**
 * Tiny helper: wrap fetch() with an abort-on-timeout. Used by every proxy
 * route that wires a breaker, so the breaker can record a failure when the
 * upstream blows past its budget.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const ctrl = new AbortController();
  const timeoutMs = init.timeoutMs ?? 4_000;
  let timedOut = false;
  const id = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  try {
    const { timeoutMs: _ignore, ...rest } = init;
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } catch (e) {
    // On abort, fetch rejects with an AbortError DOMException whose `message`
    // is a getter with no setter. Rethrow a plain Error (writable message) so
    // error loggers/instrumentation that mutate `err.message` (e.g. Next's dev
    // deobfuscator) don't throw a secondary "Cannot set property message ...
    // which has only a getter" TypeError.
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(timedOut ? `fetch timed out after ${timeoutMs}ms: ${url}` : `fetch aborted: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(id);
  }
}
