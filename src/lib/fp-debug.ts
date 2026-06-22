'use client';
/**
 * On-device debug log for diagnosing game-state bugs (stale board, missed river,
 * showdown timing, blind/button positions) that reproduce on MOBILE or in a
 * wallet in-app browser — where there is no console to open and read.
 *
 * Two ingestion paths feed one ring buffer:
 *   1. fpDebug(msg)  — prod-safe. It pushes to the buffer directly and writes to
 *      the ORIGINAL console.log (captured before any wrapping), so it survives
 *      next.config `removeConsole` only insofar as the buffer is concerned, and
 *      never double-logs through the mirror below.
 *   2. installFpDebugConsoleMirror() wraps console.log once so the EXISTING
 *      scattered `console.log('[FP-DEBUG ...]')` calls land in the same buffer
 *      with no call-site edits. (Those raw console.log calls are stripped from
 *      production builds, so in practice this path is dev-only — which is where
 *      we test the tunnel/webview anyway.)
 *
 * Enable with `?debug=1` on the URL (persisted to localStorage so it survives
 * navigation) or localStorage `fp.debug`='1'. `?debug=0` clears it.
 *
 * This module is intentionally standalone: it does NOT import or touch any
 * wallet, session-key, or action-signing code.
 */

export type FpDebugLine = { t: number; msg: string; n: number };

const MAX_LINES = 140;
const buffer: FpDebugLine[] = [];
const listeners = new Set<() => void>();
let mirrorInstalled = false;

// Capture the real console.log up front so fpDebug() output never re-enters the
// mirror (which would double-record each line).
const origLog: (...args: unknown[]) => void =
  typeof console !== 'undefined' ? console.log.bind(console) : () => {};

function notify(): void {
  listeners.forEach((l) => { try { l(); } catch { /* ignore */ } });
}

function push(msg: string): void {
  const last = buffer[buffer.length - 1];
  if (last && last.msg === msg) {
    // Collapse consecutive duplicates (e.g. a per-render log) into a count.
    last.n += 1;
    notify();
    return;
  }
  buffer.push({ t: Date.now(), msg, n: 1 });
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  notify();
}

/** Debug log: buffered for the on-device overlay + echoed to the console, but
 *  ONLY when debug is explicitly enabled (?debug=1 / localStorage fp.debug).
 *  In production with the flag off this is a no-op, so [FP-DEBUG] never leaks
 *  to the live console. */
export function fpDebug(msg: string): void {
  if (!isFpDebugEnabled()) return;
  push(msg);
  origLog(`[FP-DEBUG] ${msg}`);
}

export function getFpDebugLines(): FpDebugLine[] {
  return buffer;
}

export function clearFpDebug(): void {
  buffer.length = 0;
  notify();
}

export function subscribeFpDebug(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

let enabledCache: boolean | null = null;

export function isFpDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (enabledCache !== null) return enabledCache;
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get('debug');
    if (process.env.NODE_ENV === 'production') {
      // PRODUCTION: the overlay must never linger for regular users. Enable
      // strictly per page load via ?debug=1 on the CURRENT URL — no
      // localStorage persistence, so it cannot survive navigation or ride
      // along after a shared link. Also clear any flag persisted by older
      // builds.
      window.localStorage.removeItem('fp.debug');
      enabledCache = q === '1';
      return enabledCache;
    }
    // Dev: sticky across navigation (persisted) for HMR-heavy debugging.
    if (q === '1') window.localStorage.setItem('fp.debug', '1');
    else if (q === '0') window.localStorage.removeItem('fp.debug');
    enabledCache = window.localStorage.getItem('fp.debug') === '1';
  } catch {
    enabledCache = false;
  }
  return enabledCache;
}

export function setFpDebugEnabled(on: boolean): void {
  try {
    if (on) window.localStorage.setItem('fp.debug', '1');
    else window.localStorage.removeItem('fp.debug');
  } catch { /* ignore */ }
  enabledCache = on;
}

/**
 * Mirror existing `console.log('[FP-DEBUG ...]')` calls into the buffer once.
 * Safe to call repeatedly; only the first call wraps. Always forwards to the
 * real console so normal logging is unchanged.
 */
export function installFpDebugConsoleMirror(): void {
  if (mirrorInstalled || typeof window === 'undefined' || typeof console === 'undefined') return;
  mirrorInstalled = true;
  console.log = (...args: unknown[]) => {
    try {
      const first = args[0];
      if (typeof first === 'string' && first.startsWith('[FP-DEBUG')) {
        push(args.map((a) => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' '));
      }
    } catch { /* ignore */ }
    origLog(...args);
  };
}
