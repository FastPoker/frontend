'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useGameAuth } from '@/hooks/useGameAuth';

/**
 * Focused session-renewal modal. Use this when an automated flow
 * (Quick Play / SNG join / claim) hits ensurePlayerAuth() === false
 * and needs to gently prompt the user for the TEE session signature.
 *
 * Single button "SIGN TO CONTINUE" → triggers authenticatePlayer →
 * wallet sign popup → on success the modal auto-closes.
 *
 * For the full session-management UI, use the standard SessionModal.
 */

export const SESSION_RENEW_MODAL_OPEN_EVENT = 'fastpoker:open-session-renew-modal';

export function requestOpenSessionRenewModal(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_RENEW_MODAL_OPEN_EVENT));
}

interface SessionRenewModalProps {
  open: boolean;
  onClose: () => void;
}

export function SessionRenewModal({ open, onClose }: SessionRenewModalProps) {
  const { authenticatePlayer, isTeeAuthenticating, isPlayerReady } = useGameAuth();

  const [signing, setSigning] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Auto-close once auth is ready after the user signed.
  useEffect(() => {
    if (!open) return;
    if (isPlayerReady) {
      const t = setTimeout(() => { onClose(); }, 400);
      return () => clearTimeout(t);
    }
  }, [open, isPlayerReady, onClose]);

  // Reset transient state each open.
  useEffect(() => {
    if (open) {
      setSigning(false);
      setErrMsg(null);
    }
  }, [open]);

  if (!open || !mounted) return null;

  const onSign = async () => {
    if (signing) return;
    setSigning(true);
    setErrMsg(null);
    // authenticatePlayer() can resolve synchronously (cached token) or near-
    // instantly (headless Privy embedded signing, no popup). Without a paint
    // yield, React batches setSigning(true)->(false) into one render and the
    // disabled/"WAITING" state never becomes visible. Force one frame so the
    // busy state always shows.
    await new Promise(requestAnimationFrame);
    try {
      await authenticatePlayer();
    } catch (e: unknown) {
      const msg = (e as Error)?.message?.toLowerCase?.() || '';
      if (!msg.includes('user rejected') && !msg.includes('cancelled')) {
        setErrMsg((e as Error)?.message?.slice(0, 140) || 'Sign failed');
      }
    } finally {
      setSigning(false);
    }
  };

  const busy = signing || isTeeAuthenticating;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Renew TEE session"
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      style={{ background: 'rgba(7,9,11,0.86)' }}
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        className="glass-room hairline w-[92vw] max-w-[440px] rounded-xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 hairline-b flex items-center justify-between">
          <div>
            <div className="font-display text-bone text-base tracking-wide">TEE SESSION</div>
            <div className="font-mono text-[10px] text-boneDim/55 tracking-[0.18em] mt-0.5">
              REQUIRED TO CONTINUE
            </div>
          </div>
          {!busy && (
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-sm hover:bg-bone/5 flex items-center justify-center text-boneDim/55 hover:text-bone"
              aria-label="Close"
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          )}
        </div>

        <div className="px-5 py-5 space-y-3">
          <div className="rounded-sm px-3 py-2 bg-amber/[0.08] border border-amber/35 flex items-start gap-2">
            <svg className="w-3.5 h-3.5 text-amber shrink-0 mt-[1px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="font-mono text-[10px] text-amber tracking-[0.08em] leading-relaxed font-bold">
              YOU WILL NOT BE ABLE TO SEE YOUR HOLE CARDS UNTIL YOU AUTHENTICATE.
            </span>
          </div>
          <p className="font-mono text-[11px] text-boneDim/80 leading-relaxed">
            We need to authenticate your <span className="text-orange">TEE session</span> before continuing.
            The wallet popup that follows is a <span className="text-bone">signature only</span>:
            no transaction is sent and no SOL is spent.
          </p>
          <ul className="font-mono text-[10px] text-boneDim/65 tracking-wide leading-relaxed list-disc pl-5 space-y-1">
            <li>Unlocks reading your hole cards from the TEE.</li>
            <li>Lets you act on hands without re-signing each move.</li>
            <li>Auto-refreshes every 45 minutes while you are active.</li>
          </ul>

          {errMsg && (
            <div className="rounded-sm px-3 py-2 bg-rose-500/10 border border-rose-500/30 font-mono text-[10px] text-rose-300">
              {errMsg}
            </div>
          )}

          {isPlayerReady && (
            <div className="rounded-sm px-3 py-2 bg-emerald-500/10 border border-emerald-500/30 font-mono text-[10px] text-emerald-300">
              SESSION READY — closing...
            </div>
          )}
        </div>

        <div className="px-5 py-4 hairline-t flex items-center justify-between gap-3">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-sm hairline font-mono text-[10px] tracking-[0.18em] text-boneDim/70 hover:text-bone transition disabled:opacity-40"
          >
            CANCEL
          </button>
          <button
            onClick={onSign}
            disabled={busy || isPlayerReady}
            className="btn-orange px-5 py-2 rounded-sm font-mono text-[10px] tracking-[0.22em] disabled:opacity-50"
          >
            {busy ? 'WAITING FOR WALLET...' : isPlayerReady ? 'DONE' : 'AUTHENTICATE TO CONTINUE'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
