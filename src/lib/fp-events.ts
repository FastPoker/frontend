'use client';
/**
 * [FP-EVT] structured event stream - the timing-truth companion to fp-debug's prose.
 *
 * fp-debug answers "what happened" for a human reading the on-device overlay.
 * THIS stream answers "in what order, and how far apart" for a machine: every
 * meaningful transition emits one JSON line to the console with a monotonic
 * clock and a session-scoped sequence number, so a Playwright run can capture
 * console output to JSONL and assert ordered timelines with tolerances
 * (tests/timing/). Screenshots cannot see time; this can.
 *
 * Shape (one line): [FP-EVT] {"t":12345.6,"seq":42,"handId":298,"event":"duel.overlay_shown","detail":{...},"source":"ui"}
 *   t      - performance.now(), ms, monotonic within the page session
 *   seq    - gap-free per-session counter; a gap in captured seq = dropped console line
 *   handId - last hand number seen by the game sync (set via setFpEventHand)
 *   source - "ui" render/animation, "poll" HTTP poll, "ws" websocket, "timer" wall-clock, "chain" derived on-chain fact
 *
 * Gating mirrors fp-debug (?debug=1 / localStorage fp.debug): no-op in production
 * with the flag off, so nothing leaks to live consoles. Standalone on purpose:
 * imports nothing from wallet/session/action-signing code.
 */

import { isFpDebugEnabled } from './fp-debug';

export type FpEventSource = 'ui' | 'ws' | 'timer' | 'poll' | 'chain';

export interface FpEvent {
  t: number;
  seq: number;
  handId?: number;
  event: string;
  detail?: Record<string, unknown>;
  source: FpEventSource;
}

let seq = 0;
let currentHand: number | undefined;
const listeners = new Set<(e: FpEvent) => void>();

// Original console.log captured up front (same trick as fp-debug) so prod
// console stripping / wrapping can't double-log or swallow the stream in dev.
const origLog: (...args: unknown[]) => void =
  typeof console !== 'undefined' ? console.log.bind(console) : () => {};

/** The game-sync layer stamps the active hand so every event correlates to it. */
export function setFpEventHand(hand: number | undefined): void {
  currentHand = hand;
}

export function fpEvent(
  event: string,
  detail?: Record<string, unknown>,
  source: FpEventSource = 'ui',
): void {
  if (!isFpDebugEnabled()) return;
  const e: FpEvent = {
    t: Math.round(performance.now() * 10) / 10,
    seq: ++seq,
    handId: currentHand,
    event,
    detail,
    source,
  };
  try {
    origLog(`[FP-EVT] ${JSON.stringify(e)}`);
  } catch {
    /* detail not serializable - still deliver to listeners */
  }
  listeners.forEach((l) => {
    try {
      l(e);
    } catch {
      /* listener errors never break the emitter */
    }
  });
}

/** In-page subscription (e.g. a future dev HUD); returns unsubscribe. */
export function onFpEvent(listener: (e: FpEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
