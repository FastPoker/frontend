'use client';

/**
 * Subscribe to a topic on the indexer's WebSocket fanout gateway.
 *
 * Opens a single shared module-level WebSocket per browser tab and multiplexes
 * topic subscriptions across all consumers. When the WS is unavailable
 * (NEXT_PUBLIC_INDEXER_WS_URL unset, server down, etc.) this hook stays
 * dormant and the caller is expected to keep its existing HTTP/poll path as
 * a fallback.
 *
 * Topics today: 'jackpot_receipt' | 'sng_pools' | 'listed_tokens'.
 *
 * Wire protocol mirrors Indexer/src/ws-gateway.ts.
 */
import { useEffect, useState } from 'react';
import { INDEXER_API_ENABLED } from '@/lib/feature-flags';

type AnyData = unknown;

interface ConnectionState {
  socket: WebSocket | null;
  // refcount per topic — drives auto-unsub when last subscriber leaves
  refcount: Map<string, number>;
  // last seen snapshot per topic; pre-populated on connect/snapshot frame
  cache: Map<string, AnyData>;
  // subscriber callbacks per topic
  subs: Map<string, Set<(data: AnyData) => void>>;
  // backoff for reconnect attempts
  reconnectDelay: number;
  closed: boolean;
}

const state: ConnectionState = {
  socket: null,
  refcount: new Map(),
  cache: new Map(),
  subs: new Map(),
  reconnectDelay: 1_000,
  closed: false,
};

function wsUrl(): string | null {
  if (!INDEXER_API_ENABLED) return null;
  if (typeof window === 'undefined') return null;
  const explicit = process.env.NEXT_PUBLIC_INDEXER_WS_URL;
  // No default — feature is opt-in via env var. When unset, callers fall back
  // to their HTTP path. Set NEXT_PUBLIC_INDEXER_WS_URL=ws://localhost:3001/ws
  // in dev to enable.
  if (!explicit) return null;
  // Guard against a WS URL that can't work from the current page. The prod
  // build can ship the dev value (ws://localhost:3001/ws): opening a ws://
  // socket from an HTTPS origin throws "insecure WebSocket from HTTPS" on
  // every visitor (Sentry JAVASCRIPT-NEXTJS-1A/-16), and a localhost host is
  // unreachable from a remote browser regardless. In either case skip it and
  // let callers fall back to HTTP polling — the hook is built to be inert when
  // no socket is available. A correctly-set wss://<host>/ws passes untouched.
  try {
    const u = new URL(explicit);
    const host = u.hostname;
    const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const pageIsLocal =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isLocalHost && !pageIsLocal) return null;
    if (window.location.protocol === 'https:' && u.protocol === 'ws:') return null;
    return explicit;
  } catch {
    return null;
  }
}

function ensureConnection(): void {
  if (typeof window === 'undefined') return;
  if (state.socket && state.socket.readyState <= WebSocket.OPEN) return;
  const url = wsUrl();
  if (!url) return;

  try {
    const ws = new WebSocket(url);
    state.socket = ws;
    state.closed = false;

    ws.addEventListener('open', () => {
      state.reconnectDelay = 1_000;
      // Re-subscribe to all topics that still have refcount > 0.
      const topics = Array.from(state.refcount.entries())
        .filter(([, n]) => n > 0)
        .map(([t]) => t);
      if (topics.length > 0) {
        try { ws.send(JSON.stringify({ op: 'sub', topics })); } catch {}
      }
    });

    ws.addEventListener('message', (e) => {
      let msg: any;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.op !== 'snapshot' && msg.op !== 'update') return;
      const topic = String(msg.topic);
      state.cache.set(topic, msg.data);
      const subs = state.subs.get(topic);
      if (subs) for (const fn of subs) fn(msg.data);
    });

    const reconnect = () => {
      if (state.closed) return;
      state.socket = null;
      const delay = state.reconnectDelay;
      state.reconnectDelay = Math.min(delay * 1.5, 30_000);
      // Jittered delay (±30%) — without this, every connected client retries
      // at exactly the same millisecond after a server restart, slamming the
      // indexer with a synchronized 1000-client reconnect burst.
      const jittered = delay * (0.7 + Math.random() * 0.6);
      setTimeout(ensureConnection, jittered);
    };
    ws.addEventListener('close', reconnect);
    ws.addEventListener('error', () => {
      try { ws.close(); } catch {}
    });
  } catch {
    // Couldn't even create the WS — leave callers on their HTTP fallback.
  }
}

/**
 * Non-hook subscription. Domain-specific hooks (usePoolHealth, etc.) call
 * this from inside their own module-level subscription pattern so they can
 * merge WS push updates with their HTTP/poll fallback path. Returns an
 * unsubscribe function. Safe to call before the WS connection exists; the
 * callback fires once the first frame arrives (and immediately if a cached
 * snapshot is already present).
 */
export function subscribeIndexerTopic(topic: string, fn: (data: AnyData) => void): () => void {
  return subscribeTopic(topic, fn);
}

function subscribeTopic(topic: string, fn: (data: AnyData) => void): () => void {
  if (typeof window === 'undefined' || !wsUrl()) {
    return () => {};
  }
  let set = state.subs.get(topic);
  if (!set) { set = new Set(); state.subs.set(topic, set); }
  set.add(fn);
  const newCount = (state.refcount.get(topic) ?? 0) + 1;
  state.refcount.set(topic, newCount);

  ensureConnection();

  if (newCount === 1 && state.socket?.readyState === WebSocket.OPEN) {
    try { state.socket.send(JSON.stringify({ op: 'sub', topic })); } catch {}
  }

  // Immediately deliver the cached snapshot if we have one.
  const cached = state.cache.get(topic);
  if (cached !== undefined) fn(cached);

  return () => {
    const subs = state.subs.get(topic);
    if (subs) subs.delete(fn);
    const next = (state.refcount.get(topic) ?? 1) - 1;
    if (next <= 0) {
      state.refcount.delete(topic);
      if (state.socket?.readyState === WebSocket.OPEN) {
        try { state.socket.send(JSON.stringify({ op: 'unsub', topic })); } catch {}
      }
    } else {
      state.refcount.set(topic, next);
    }
  };
}

/**
 * Subscribe to a topic and return the latest snapshot. Returns null until
 * the first frame lands. The hook is inert when NEXT_PUBLIC_INDEXER_WS_URL
 * is unset, so callers must keep their HTTP fallback path.
 */
export function useIndexerTopic<T>(topic: string): T | null {
  const [data, setData] = useState<T | null>(() => {
    const cached = state.cache.get(topic);
    return cached === undefined ? null : (cached as T);
  });

  useEffect(() => {
    const unsub = subscribeTopic(topic, (d) => setData(d as T));
    return unsub;
  }, [topic]);

  return data;
}

/** True if the WS layer is configured. Callers can use this to disable their
 *  HTTP polling when WS is available. */
export function isIndexerWsEnabled(): boolean {
  return wsUrl() !== null;
}
