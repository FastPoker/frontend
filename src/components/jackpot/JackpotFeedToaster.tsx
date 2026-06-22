'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { JackpotReceipt } from '@/lib/jpv1';
import { subscribeIndexerTopic, isIndexerWsEnabled } from '@/hooks/useIndexerTopic';
import { formatJackpotAmount, getKindLabel, getKindColor } from '@/lib/jackpot-format';

/**
 * Global jackpot toaster — primes from `/api/jackpots/recent` for the cold
 * paint, then subscribes to the indexer WS fanout's `jackpot_receipt` topic
 * for new JPV1 receipts. Each push fires a single toast.
 *
 * Previously this opened its own Helius `logsSubscribe` WS per client — at
 * 1000 CCU that exhausted the per-key WSS cap (100 on the free tier). The
 * fanout consolidates that to one server-side LaserStream ingest fanned out
 * to N anonymous clients on the same `/ws` socket the rest of the app uses.
 *
 * Polling fallback: if the indexer WS is unset (NEXT_PUBLIC_INDEXER_WS_URL
 * missing) OR no receipts arrive within WS_GRACE_MS, fall back to the 10s
 * `/api/jackpots/recent` poll loop.
 *
 * Mounted once in LayoutShell (renders nothing on bare/iframe routes —
 * same suppression as the rest of the chrome). Toasts auto-dismiss after 8s.
 */

const POLL_INTERVAL_MS = 10_000;
const POLL_LIMIT = 10;
const TOAST_TTL_MS = 8_000;
const MAX_VISIBLE = 3;
const WS_GRACE_MS = 30_000;

interface Toast {
  id: string;             // `${txSig}:${handNumber}` (stable)
  receipt: JackpotReceipt;
  expiresAt: number;
}

function shortKey(key: string): string {
  if (!key) return '';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function JackpotFeedToaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seenSigsRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let wsLastSeen: number | null = null;
    let wsUnsubscribe: (() => void) | null = null;

    const recordReceipt = (r: JackpotReceipt) => {
      const id = `${r.txSig}:${r.handNumber}`;
      if (seenSigsRef.current.has(id)) return;
      seenSigsRef.current.add(id);
      const now = Date.now();
      setToasts(prev => {
        const next: Toast = { id, receipt: r, expiresAt: now + TOAST_TTL_MS };
        const merged = [next, ...prev]; // newest first
        return merged.slice(0, MAX_VISIBLE);
      });
    };

    const startPolling = () => {
      if (pollTimer) return;
      const tick = async () => {
        if (cancelled) return;
        try {
          const r = await fetch(`/api/jackpots/recent?limit=${POLL_LIMIT}`, { cache: 'no-store' });
          if (!r.ok) return;
          const body = (await r.json()) as { receipts: JackpotReceipt[] };
          if (cancelled) return;
          const receipts = body.receipts || [];

          if (!primedRef.current) {
            for (const rec of receipts) {
              seenSigsRef.current.add(`${rec.txSig}:${rec.handNumber}`);
            }
            primedRef.current = true;
            return;
          }

          // Replay newest first so toast ordering stays consistent.
          for (let i = receipts.length - 1; i >= 0; i--) {
            recordReceipt(receipts[i]);
          }
        } catch {
          /* swallow — polling is best-effort */
        }
      };
      console.log('[jackpot-feed] starting polling fallback');
      tick();
      pollTimer = setInterval(tick, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    // Cold prime: fetch the existing recent feed once so historical hits
    // don't fire toasts, even before the WS attaches.
    (async () => {
      try {
        const r = await fetch(`/api/jackpots/recent?limit=50`, { cache: 'no-store' });
        if (!r.ok) return;
        const body = (await r.json()) as { receipts: JackpotReceipt[] };
        if (cancelled) return;
        for (const rec of body.receipts || []) {
          seenSigsRef.current.add(`${rec.txSig}:${rec.handNumber}`);
        }
        primedRef.current = true;
      } catch {
        /* prime is best-effort; WS subscription proceeds either way */
      }
    })();

    // Subscribe to the indexer's `jackpot_receipt` fanout topic. Falls back
    // to polling if the WS is unset (env-gated) or sits silent past grace.
    if (isIndexerWsEnabled()) {
      wsUnsubscribe = subscribeIndexerTopic('jackpot_receipt', (data) => {
        if (cancelled || !data) return;
        wsLastSeen = Date.now();
        stopPolling();
        recordReceipt(data as JackpotReceipt);
      });

      // Safety net: if we don't see anything within grace AND the cached
      // snapshot is empty, kick the poller. Some sessions can load right
      // after a hit so we'd otherwise rely entirely on push.
      const graceCheck = setTimeout(() => {
        if (cancelled) return;
        if (wsLastSeen === null) startPolling();
      }, WS_GRACE_MS);

      return () => {
        cancelled = true;
        clearTimeout(graceCheck);
        stopPolling();
        if (wsUnsubscribe) {
          try { wsUnsubscribe(); } catch { /* ignore */ }
          wsUnsubscribe = null;
        }
      };
    }

    // No WS configured — go straight to polling.
    startPolling();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, []);

  // Reaper — drop expired toasts every second.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setToasts(prev => prev.filter(t => t.expiresAt > now));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[80] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <JackpotToastCard
          key={t.id}
          receipt={t.receipt}
          onClose={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
        />
      ))}
    </div>
  );
}

function JackpotToastCard({
  receipt,
  onClose,
}: {
  receipt: JackpotReceipt;
  onClose: () => void;
}) {
  const accent = getKindColor(receipt.miniHit, receipt.grandHit);
  const kindLabel = getKindLabel(receipt.miniHit, receipt.grandHit) ?? 'LUCKY';
  const amountText = formatJackpotAmount(receipt);

  return (
    <Link
      href={`/verify?table=${receipt.table}&hand=${receipt.handNumber}`}
      className="pointer-events-auto rounded-sm hairline backdrop-blur-md px-3 py-2.5 flex items-start gap-2.5 max-w-[320px] hover:bg-white/[0.04] transition relative overflow-hidden"
      style={{
        background: 'rgba(14,14,22,0.85)',
        borderColor: `${accent}55`,
        boxShadow: `0 4px 24px ${accent}22`,
      }}
    >
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
      />
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5"
        style={{
          background: `radial-gradient(circle, ${accent}30, ${accent}10)`,
          border: `1px solid ${accent}`,
        }}
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke={accent} strokeWidth="1.6">
          <path d="M12 2l2.5 6 6.5.5-5 4.5 1.5 6.5L12 17l-5.5 3.5L8 14l-5-4.5 6.5-.5L12 2z" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className="font-mono text-[8px] tracking-[0.22em] leading-none"
            style={{ color: accent }}
          >
            {kindLabel}
          </span>
          <span className="font-mono text-[8px] text-boneDim/40 tracking-[0.22em] leading-none">
            HIT #{receipt.hitSequence}
          </span>
        </div>
        <div className="font-display text-bone text-sm tabular-nums leading-tight mt-0.5">
          {amountText}
        </div>
        <div className="font-mono text-[9px] text-boneDim/55 mt-0.5 truncate">
          Hand #<span className="tabular-nums">{receipt.handNumber}</span>{' '}
          <span className="text-boneDim/35">·</span>{' '}
          <span className="tabular-nums">{shortKey(receipt.table)}</span>
        </div>
      </div>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        className="font-mono text-[10px] text-boneDim/45 hover:text-bone transition shrink-0 leading-none mt-0.5"
        aria-label="Dismiss"
      >
        ×
      </button>
    </Link>
  );
}
