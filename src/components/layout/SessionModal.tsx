'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSessionContext } from '@/hooks/useSession';
import { useGameAuth } from '@/hooks/useGameAuth';
import {
  clearAllSuppressedFundsConfirms,
  listSuppressedFundsConfirms,
  SUPPRESS_CHANGE_EVENT,
  unsuppressFundsConfirm,
} from '@/lib/funds-confirm-suppress';

/**
 * Global helper any component can call to pop the TEE auth / session manager.
 * Useful when a deeper flow (quick-play, game join, claim) hits an auth
 * failure and the user needs to authorize the TEE before they can continue.
 *
 * The FooterStrip-mounted SessionModal listens for this event and opens.
 * Safe to call from anywhere — falls back to a no-op if no listener exists.
 */
export const SESSION_MODAL_OPEN_EVENT = 'fastpoker:open-session-modal';

export function requestOpenSessionModal(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_MODAL_OPEN_EVENT));
}

interface SessionModalProps {
  open: boolean;
  onClose: () => void;
}

function formatTimeRemaining(expiresAtMs: number): string {
  const remaining = expiresAtMs - Date.now();
  if (remaining <= 0) return 'Expired';
  const mins = Math.floor(remaining / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  return rm > 0 ? `${hrs}h ${rm}m` : `${hrs}h`;
}

export function SessionModal({ open, onClose }: SessionModalProps) {
  const { session, isLoading: sessionLoading, createSession, reclaimSession } = useSessionContext();
  const {
    status: authStatus,
    teeTokenType,
    isTeeAuthenticating,
    isPlayerReady,
    teeTokenExpiresAt,
    authenticatePlayer,
    forceRefresh,
  } = useGameAuth();

  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Tick every 10s to update TEE countdown
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const iv = setInterval(() => setTick(t => t + 1), 10_000);
    return () => clearInterval(iv);
  }, [open]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Suppressed confirmation prompts — users can re-enable individual entries
  // here after they checked "Don't show again" on the wallet approval modal.
  const [suppressedConfirms, setSuppressedConfirms] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    const refresh = () => setSuppressedConfirms(listSuppressedFundsConfirms());
    refresh();
    window.addEventListener(SUPPRESS_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(SUPPRESS_CHANGE_EVENT, refresh);
  }, [open]);

  if (!open || !mounted) return null;

  const doAction = async (label: string, fn: () => Promise<any>) => {
    if (actionLoading) return;
    setActionLoading(label);
    setActionError(null);
    // Force one paint frame so the disabled/"Signing..." state is visible even
    // when fn() resolves synchronously (cached token) or via a headless Privy
    // embedded signature — otherwise React batches the loading flag on->off in
    // a single render and the button never appears disabled.
    await new Promise(requestAnimationFrame);
    try {
      await fn();
    } catch (e: any) {
      const msg = e.message?.toLowerCase() || '';
      if (msg.includes('user rejected') || msg.includes('cancelled')) {
        // User cancelled — not an error
      } else {
        setActionError(e.message?.slice(0, 100) || 'Unknown error');
      }
    } finally {
      setActionLoading(null);
    }
  };

  // ─── TEE Auth Status ───
  const teeExpiry = teeTokenExpiresAt > 0 ? formatTimeRemaining(teeTokenExpiresAt) : null;
  const teeStatusColor =
    teeTokenType === 'player' && teeTokenExpiresAt > Date.now()
      ? 'text-emerald-400'
      : teeTokenType === 'authority'
      ? 'text-orange'
      : 'text-boneDim/70';
  const teeStatusDot =
    teeTokenType === 'player' && teeTokenExpiresAt > Date.now()
      ? 'bg-emerald-400'
      : teeTokenType === 'authority'
      ? 'bg-orange'
      : isTeeAuthenticating
      ? 'bg-boneDim animate-pulse'
      : 'bg-boneDim/60';
  const teeStatusLabel =
    isTeeAuthenticating
      ? 'Authenticating...'
      : teeTokenType === 'player' && teeTokenExpiresAt > Date.now()
      ? 'Player Token Active'
      : teeTokenType === 'authority'
      ? 'Authority Only'
      : 'Not Authenticated';

  // ─── Session Key Status ───
  const hasKey = session.isActive && !!session.sessionKey;
  const keyPubkey = session.sessionKey?.publicKey.toBase58() || '';

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-ink/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 bg-ink border border-white/10 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-bold text-white">Connection Status</h2>
          <button onClick={onClose} className="text-boneDim/70 hover:text-boneDim transition-colors text-lg leading-none">&times;</button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* ─── TEE Authentication Section ─── */}
          <div>
            <h3 className="text-xs font-semibold text-boneDim uppercase tracking-wider mb-2">TEE Authentication</h3>
            <div className="bg-ink/50 rounded-lg border border-white/[0.06] p-3 space-y-2">
              {/* Status row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${teeStatusDot}`} />
                  <span className={`text-xs font-medium ${teeStatusColor}`}>{teeStatusLabel}</span>
                </div>
                {teeExpiry && teeTokenExpiresAt > Date.now() && (
                  <span className="text-[10px] text-boneDim/70 font-mono">{teeExpiry} left</span>
                )}
              </div>

              {/* Info rows */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <div className="text-boneDim/70">Token Type</div>
                <div className="text-boneDim text-right capitalize">{teeTokenType === 'none' ? '—' : teeTokenType}</div>
                <div className="text-boneDim/70">Hole Cards</div>
                <div className={`text-right ${isPlayerReady ? 'text-emerald-400' : 'text-boneDim/70'}`}>
                  {isPlayerReady ? 'Accessible' : 'Not Available'}
                </div>
              </div>

              {/* TEE Actions */}
              <div className="flex gap-2 pt-1">
                {teeTokenType !== 'player' && (
                  <button
                    onClick={() => doAction('tee_auth', authenticatePlayer)}
                    disabled={isTeeAuthenticating || actionLoading === 'tee_auth'}
                    className="flex-1 px-3 py-1.5 rounded-md text-xs font-medium bg-orange/15 border border-orange/25 text-orange hover:bg-orange/25 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === 'tee_auth' ? 'Signing...' : 'Authenticate Player'}
                  </button>
                )}
                <button
                  onClick={() => doAction('tee_refresh', forceRefresh)}
                  disabled={isTeeAuthenticating || actionLoading === 'tee_refresh'}
                  className="flex-1 px-3 py-1.5 rounded-md text-xs font-medium bg-ink/50 border border-white/10 text-boneDim hover:bg-ink/60 transition-colors disabled:opacity-50"
                >
                  {actionLoading === 'tee_refresh' ? 'Refreshing...' : 'Refresh Token'}
                </button>
              </div>
            </div>
          </div>

          {/* ─── Session Key Section ─── */}
          <div>
            <h3 className="text-xs font-semibold text-boneDim uppercase tracking-wider mb-2">Session Key</h3>
            <div className="bg-ink/50 rounded-lg border border-white/[0.06] p-3 space-y-3">
              {/* Status row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${hasKey ? 'bg-emerald-400' : 'bg-rose-300'}`} />
                  <span className={`text-xs font-medium ${hasKey ? 'text-emerald-400' : 'text-rose-300'}`}>
                    {session.status === 'loading' ? 'Loading...' : hasKey ? 'Active' : 'No Key'}
                  </span>
                </div>
                {hasKey && (
                  <span className="text-[10px] text-boneDim/70 font-mono">No expiry</span>
                )}
              </div>

              {/* Key info */}
              {hasKey && (
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
                  <div className="text-boneDim/70">Public Key</div>
                  <div className="text-boneDim text-right font-mono text-[10px] truncate" title={keyPubkey}>
                    {keyPubkey.slice(0, 12)}...{keyPubkey.slice(-8)}
                  </div>
                  <div className="text-boneDim/70">Storage</div>
                  <div className="text-boneDim text-right">IndexedDB</div>
                  <div className="text-boneDim/70">TX Fees</div>
                  <div className="text-emerald-400 text-right">Gasless (TEE)</div>
                </div>
              )}

              {/* No-key explanation */}
              {!hasKey && session.status !== 'loading' && (
                <div className="text-[11px] text-boneDim/70 leading-relaxed">
                  A session key lets you play without wallet popups. One is created automatically when you join a game.
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                {!hasKey && session.status !== 'loading' && (
                  <button
                    onClick={() => doAction('create', createSession)}
                    disabled={sessionLoading || !!actionLoading}
                    className="flex-1 px-3 py-1.5 rounded-md text-xs font-medium bg-orange/15 border border-orange/25 text-orange hover:bg-orange/25 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === 'create' ? 'Creating...' : 'Generate Key'}
                  </button>
                )}
                {hasKey && (
                  <button
                    onClick={() => doAction('reset', reclaimSession)}
                    disabled={sessionLoading || !!actionLoading}
                    className="flex-1 px-3 py-1.5 rounded-md text-xs font-medium bg-ink/50 border border-white/10 text-boneDim hover:bg-ink/60 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === 'reset' ? 'Resetting...' : 'Reset Key'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ─── Overall Status ─── */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-boneDim/60 uppercase tracking-wider">Overall</span>
              <span className={`text-xs font-medium ${
                authStatus === 'ready' ? 'text-emerald-400' :
                authStatus === 'browse' ? 'text-orange' :
                authStatus === 'degraded' ? 'text-amber-400' :
                authStatus === 'connecting' ? 'text-boneDim' :
                'text-boneDim/60'
              }`}>
                {authStatus === 'ready' ? 'Ready to Play' :
                 authStatus === 'browse' ? 'Browse Only' :
                 authStatus === 'degraded' ? 'Degraded' :
                 authStatus === 'connecting' ? 'Connecting...' :
                 'Disconnected'}
              </span>
            </div>
          </div>

          {/* ─── Suppressed Confirmation Prompts ─── */}
          {suppressedConfirms.length > 0 && (
            <div className="rounded-md border border-white/10 bg-black/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-boneDim/60">
                  Silenced confirmations
                </span>
                <button
                  type="button"
                  onClick={clearAllSuppressedFundsConfirms}
                  className="font-mono text-[9px] uppercase tracking-[0.18em] text-orange/80 hover:text-orange"
                >
                  Re-enable all
                </button>
              </div>
              <p className="font-mono text-[10px] text-boneDim/55 leading-relaxed">
                You'll skip the wallet-approval modal for these action types. Re-enable any to bring the prompt back.
              </p>
              <ul className="space-y-1">
                {suppressedConfirms.map((title) => (
                  <li
                    key={title}
                    className="flex items-center justify-between gap-3 rounded-sm border border-white/[0.06] bg-white/[0.02] px-2 py-1.5"
                  >
                    <span className="font-mono text-[11px] text-bone/80 truncate">{title}</span>
                    <button
                      type="button"
                      onClick={() => unsuppressFundsConfirm(title)}
                      className="shrink-0 font-mono text-[9px] uppercase tracking-[0.18em] text-orange/80 hover:text-orange"
                    >
                      Re-enable
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Error display */}
          {actionError && (
            <div className="px-3 py-2 rounded-md bg-red-500/10 border border-red-500/20 text-red-300 text-xs">
              {actionError}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
