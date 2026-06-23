'use client';

import { useEffect, useRef, useState } from 'react';
import type { JackpotReceipt } from '@/lib/jpv1';
import { subscribeIndexerTopic, isIndexerWsEnabled } from '@/hooks/useIndexerTopic';
import { STATIC_EXPORT } from '@/lib/runtime-mode';
import {
  LUCKY_JACKPOT_NAME,
  ROYAL_JACKPOT_NAME,
  formatSol,
  formatJackpotAmount,
  getKindColor,
} from '@/lib/jackpot-format';

/**
 * Table-scoped jackpot ceremony, shown briefly when a Lucky or Royal Jackpot
 * fires on the current table mid-tournament.
 *
 * Data path: WebSocket push (preferred) → 5s `/api/jackpots/recent` poll
 * fallback if the WS reports `disconnected`/`error` for >30s. The WS
 * stream is filtered client-side to the active `tablePda`.
 *
 * The first sweep primes the seen-set so historical hits don't fire a
 * stale ceremony when a player walks into a table mid-session.
 */

const POLL_INTERVAL_MS = 5_000;
const POLL_LIMIT = 20;
const CEREMONY_DURATION_MS = 4_500;
const WS_GRACE_MS = 30_000;

interface CeremonyState {
  receipt: JackpotReceipt;
  endsAt: number;
}

interface JackpotCeremonyOverlayProps {
  /** Active table PDA (base58). Pass null/empty to disable polling. */
  tablePda: string | null | undefined;
}

export function JackpotCeremonyOverlay({ tablePda }: JackpotCeremonyOverlayProps) {
  const [active, setActive] = useState<CeremonyState | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  const activeRef = useRef<CeremonyState | null>(null);
  activeRef.current = active;

  useEffect(() => {
    if (!tablePda) {
      setActive(null);
      seenRef.current.clear();
      primedRef.current = false;
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let wsLastSeen: number | null = null;
    let wsUnsubscribe: (() => void) | null = null;
    seenRef.current = new Set();
    primedRef.current = false;
    const canUseRecentApi = !STATIC_EXPORT;

    const tryFireCeremony = (r: JackpotReceipt) => {
      if (cancelled) return;
      if (r.table !== tablePda) return;
      const id = `${r.txSig}:${r.handNumber}`;
      if (seenRef.current.has(id)) return;
      seenRef.current.add(id);
      if (!activeRef.current) {
        setActive({ receipt: r, endsAt: Date.now() + CEREMONY_DURATION_MS });
      }
    };

    const startPolling = () => {
      if (!canUseRecentApi) return;
      if (pollTimer) return;
      const tick = async () => {
        if (cancelled) return;
        try {
          const res = await fetch(`/api/jackpots/recent?limit=${POLL_LIMIT}`, { cache: 'no-store' });
          if (!res.ok) return;
          const body = (await res.json()) as { receipts: JackpotReceipt[] };
          if (cancelled) return;
          const receipts = (body.receipts || []).filter(r => r.table === tablePda);

          if (!primedRef.current) {
            for (const r of receipts) seenRef.current.add(`${r.txSig}:${r.handNumber}`);
            primedRef.current = true;
            return;
          }

          for (const r of receipts) tryFireCeremony(r);
        } catch {
          /* swallow */
        }
      };
      console.log('[jackpot-feed] ceremony polling fallback active');
      tick();
      pollTimer = setInterval(tick, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    if (canUseRecentApi) {
      // Cold prime once on mount so historical hits never re-fire. Until this
      // completes, WS/poll pushes are treated as historical (recorded as seen,
      // NOT fired) — see the primedRef guards below.
      (async () => {
        try {
          const res = await fetch(`/api/jackpots/recent?limit=50`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const body = (await res.json()) as { receipts: JackpotReceipt[] };
            if (!cancelled) {
              for (const r of body.receipts || []) {
                if (r.table === tablePda) seenRef.current.add(`${r.txSig}:${r.handNumber}`);
              }
            }
          }
        } catch {
          /* prime is best-effort (incl. timeout) */
        } finally {
          // Always flip primed after the attempt — even on error/timeout — so the
          // feed can fire genuinely-new hits. Historical hits fetched above are
          // already in seenRef, so they won't re-fire.
          if (!cancelled) primedRef.current = true;
        }
      })();
    } else {
      primedRef.current = true;
    }

    // Subscribe to the indexer's jackpot_receipt fanout topic. Filtering by
    // tablePda happens inside tryFireCeremony, since the topic is global.
    if (isIndexerWsEnabled()) {
      wsUnsubscribe = subscribeIndexerTopic('jackpot_receipt', (data) => {
        if (cancelled || !data) return;
        wsLastSeen = Date.now();
        stopPolling();
        const r = data as JackpotReceipt;
        // Don't fire until the cold-prime has recorded historical hits. A push
        // that lands during priming — e.g. a retained/replayed receipt on a
        // fresh subscribe after refresh/join — is recorded as seen, NOT fired.
        // This is the fix for "ceremony pops when no jackpot hit" on reload.
        if (!primedRef.current) {
          if (r.table === tablePda) seenRef.current.add(`${r.txSig}:${r.handNumber}`);
          return;
        }
        tryFireCeremony(r);
      });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablePda]);

  // Auto-dismiss
  useEffect(() => {
    if (!active) return;
    const ms = Math.max(0, active.endsAt - Date.now());
    const id = setTimeout(() => setActive(null), ms);
    return () => clearTimeout(id);
  }, [active]);

  if (!active) return null;

  const r = active.receipt;
  const isBoth = r.miniHit && r.grandHit;
  const isGrand = r.grandHit && !r.miniHit;
  const accent = getKindColor(r.miniHit, r.grandHit);
  const kindLabel = isBoth
    ? 'LUCKY + ROYAL'
    : isGrand
      ? ROYAL_JACKPOT_NAME.toUpperCase()
      : LUCKY_JACKPOT_NAME.toUpperCase();
  const amountText = formatJackpotAmount(r);

  return (
    <div
      className="fixed inset-0 z-[100] pointer-events-none flex items-start justify-center pt-24"
      role="status"
      aria-live="polite"
    >
      <div
        className="relative pointer-events-auto rounded-lg overflow-hidden hairline px-8 py-6 backdrop-blur-md fade-in"
        style={{
          background: 'rgba(14,14,22,0.92)',
          borderColor: `${accent}77`,
          boxShadow: `0 0 48px ${accent}55, 0 16px 64px rgba(0,0,0,0.55)`,
          minWidth: 360,
          maxWidth: '90vw',
        }}
      >
        <div
          className="absolute top-0 left-0 right-0 h-[3px]"
          style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
        />
        <div
          className="absolute -top-32 left-1/2 -translate-x-1/2 w-80 h-80 rounded-full pointer-events-none opacity-25"
          style={{ background: `radial-gradient(circle, ${accent}, transparent 70%)` }}
        />
        <div className="relative flex flex-col items-center text-center gap-2">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center"
            style={{
              background: `radial-gradient(circle, ${accent}40, ${accent}10)`,
              border: `1.5px solid ${accent}`,
              boxShadow: `0 0 24px ${accent}77`,
            }}
          >
            <svg viewBox="0 0 24 24" className="w-9 h-9" fill="none" stroke={accent} strokeWidth="1.6">
              <path d="M12 2l2.5 6 6.5.5-5 4.5 1.5 6.5L12 17l-5.5 3.5L8 14l-5-4.5 6.5-.5L12 2z" />
            </svg>
          </div>
          <div
            className="font-mono text-[10px] tracking-[0.32em] mt-1"
            style={{ color: accent }}
          >
            {kindLabel} · HIT #{r.hitSequence}
          </div>
          <div className="font-display text-bone text-3xl tracking-wide leading-none">
            {amountText}
          </div>
          <div className="font-mono text-[10px] text-boneDim/65 tracking-wider mt-1">
            Hand #<span className="tabular-nums">{r.handNumber}</span>
            {r.miniHit && (
              <>
                <span className="text-boneDim/40 mx-2">·</span>
                <span className="text-bone/80">
                  {formatSol(r.miniPerSeatLamports, 4)} / opt-in seat
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
