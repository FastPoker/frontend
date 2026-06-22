'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { IS_MAINNET } from '@/lib/constants';
import {
  PRIVY_APPLE_ENABLED,
  PRIVY_EMAIL_ENABLED,
  PRIVY_GOOGLE_ENABLED,
  PRIVY_HAS_VISIBLE_LOGIN,
  PRIVY_X_ENABLED,
} from '@/lib/privy-config';

interface ConnectModalCtx {
  open: () => void;
  close: () => void;
  isOpen: boolean;
}

const Ctx = createContext<ConnectModalCtx | null>(null);

export function useConnectModal(): ConnectModalCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useConnectModal must be used inside ConnectModalProvider');
  return v;
}

export function ConnectModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  return (
    <Ctx.Provider value={{ open, close, isOpen }}>
      {children}
      <FastPokerConnectModal open={isOpen} onClose={close} />
    </Ctx.Provider>
  );
}

function shortAddr(a: string | null) {
  if (!a) return '';
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

// Official Google "G" mark, 4-color SVG. Centered on white background per
// Google brand guidelines.
function GoogleMark() {
  return (
    <div
      className="w-9 h-9 rounded-sm flex items-center justify-center"
      style={{ background: '#fff' }}
    >
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden focusable="false">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      </svg>
    </div>
  );
}

function XMono() {
  return (
    <div className="w-9 h-9 rounded-sm flex items-center justify-center font-display text-base" style={{ background: '#0a0d10', color: '#fff', border: '1px solid rgba(245,241,230,0.18)' }}>𝕏</div>
  );
}

function AppleMark() {
  return (
    <div className="w-9 h-9 rounded-sm flex items-center justify-center font-display text-lg" style={{ background: '#f5f1e6', color: '#0a0d10' }}>
      
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin"
      aria-hidden
    />
  );
}

function FastPokerConnectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useUnifiedWallet();
  // Pending login method. Disables every auth button and shows a spinner the
  // instant one is clicked, so it can't be re-clicked or look idle while Privy
  // spins up its own flow.
  const [busy, setBusy] = useState<null | 'email' | 'google' | 'twitter' | 'apple' | 'wallet'>(null);

  // Auto-close on successful connection.
  useEffect(() => {
    if (open && w.isConnected) {
      const t = setTimeout(onClose, 500);
      return () => clearTimeout(t);
    }
  }, [open, w.isConnected, onClose]);

  // ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Drop the pending state when the modal (re)opens or a connection lands.
  useEffect(() => { if (!open || w.isConnected) setBusy(null); }, [open, w.isConnected]);

  const run = useCallback(
    async (method: 'email' | 'google' | 'twitter' | 'apple' | 'wallet', fn: () => Promise<void> | void) => {
      if (busy || !w.isReady) return;
      setBusy(method);
      // CRITICAL (iOS): call fn() SYNCHRONOUSLY within the click gesture. The
      // Privy OAuth popup / wallet sheet uses window.open, which iOS Safari only
      // permits inside the originating user gesture. Awaiting anything first
      // (even a requestAnimationFrame to paint the spinner) consumes the gesture
      // and Safari silently blocks the popup — which is why Google/X and wallet
      // connect failed on iPhone while desktop (lenient post-await popups) worked.
      // setBusy above still re-renders the spinner; we just don't await before fn.
      try {
        await fn();
      } catch {
        /* user dismissed the Privy or wallet sheet; fall through to re-enable */
      } finally {
        // On success w.isConnected flips and the modal auto-closes; this clears
        // the spinner on the cancel or try-again path.
        setBusy(null);
      }
    },
    [busy, w.isReady],
  );

  if (!open) return null;

  const sourceLabel =
    w.source === 'privy-embedded' ? 'Privy · embedded' :
    w.source === 'privy-external' ? 'Privy · external' :
    w.source === 'wallet-adapter' ? 'Wallet adapter' : null;
  const hasSocialLogin = PRIVY_GOOGLE_ENABLED || PRIVY_X_ENABLED || PRIVY_APPLE_ENABLED;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4"
      style={{ background: 'rgba(4,6,9,0.78)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="mx-auto w-full max-w-md md:max-w-3xl"
        style={{
          background: 'linear-gradient(180deg, #10131B 0%, #0A0D14 100%)',
          border: '1px solid rgba(242,106,31,0.20)',
          borderTopColor: 'rgba(242,106,31,0.36)',
          borderRadius: '12px',
          boxShadow: '0 30px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grid grid-cols-1 md:grid-cols-[40%_60%]">
          {/* LEFT brand panel — hidden on mobile to keep auth panel readable */}
          <div
            className="hidden md:flex relative px-7 py-8 flex-col justify-between"
            style={{
              background: 'linear-gradient(155deg, rgba(255,138,61,0.95) 0%, rgba(242,106,31,0.85) 35%, rgba(184,69,21,0.92) 100%)',
              borderRight: '1px solid rgba(242,106,31,0.55)',
              borderRadius: '11px 0 0 11px',
              color: '#0a0d10',
            }}
          >
            <div className="absolute inset-0 overflow-hidden select-none pointer-events-none" aria-hidden style={{ borderRadius: '11px 0 0 11px' }}>
              <img
                src="/brand/app-icon.png"
                alt=""
                className="absolute"
                style={{
                  right: '-18%',
                  bottom: '-22%',
                  width: '85%',
                  opacity: 0.18,
                  filter: 'blur(2px) saturate(0.85)',
                  mixBlendMode: 'soft-light',
                  maskImage: 'radial-gradient(ellipse at 30% 30%, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0) 85%)',
                  WebkitMaskImage: 'radial-gradient(ellipse at 30% 30%, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0) 85%)',
                }}
              />
            </div>

            <div className="relative">
              <div className="font-mono text-[10px] tracking-[0.32em] mb-4" style={{ color: 'rgba(10,13,16,0.65)' }}>
                ◆ {IS_MAINNET ? 'MAINNET' : 'DEVNET'} · v1.4
              </div>
              <div
                className="font-display text-5xl leading-[0.92] tracking-[0.02em] uppercase"
                style={{ color: '#0a0d10', textShadow: '0 1px 0 rgba(255,255,255,0.18)' }}
              >
                Fast<br />Poker
              </div>
              <div className="font-mono text-[11px] mt-4 max-w-[200px] leading-relaxed" style={{ color: 'rgba(10,13,16,0.78)' }}>
                Trustless poker on Solana. Verifiable shuffles. Instant payouts.
              </div>
            </div>

            <div className="relative font-mono text-[10px] tracking-[0.18em]" style={{ color: 'rgba(10,13,16,0.55)' }}>
              ──────<br />Built for the felt.
            </div>
          </div>

          {/* RIGHT auth panel */}
          <div className="px-7 py-7 flex flex-col">
            <div className="flex items-start justify-between mb-5">
              <div>
                <div className="font-display text-bone text-xl tracking-[0.06em] uppercase">
                  {w.isConnected ? 'You’re in' : 'Take a seat'}
                </div>
                <div className="font-mono text-[11px] text-boneDim/65 mt-1">
                  {w.isConnected
                    ? sourceLabel
                    : busy
                      ? 'Connecting…'
                      : w.isReady
                        ? (PRIVY_HAS_VISIBLE_LOGIN ? 'Sign in to start playing.' : 'Connect a Solana wallet to start playing.')
                        : 'Loading…'}
                </div>
              </div>
              <button
                onClick={onClose}
                className="w-7 h-7 rounded-sm flex items-center justify-center font-mono text-xs text-boneDim/50 hover:text-bone hover:bg-orange/10 transition"
                style={{ border: '1px solid rgba(242,106,31,0.10)' }}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="flex-1 space-y-4">
              {w.isConnected ? (
                <div
                  className="rounded-sm p-4 flex items-start gap-3"
                  style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.28)' }}
                >
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.35)' }}
                  >
                    <span className="font-display text-base" style={{ color: '#34D399' }}>✓</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-bone text-sm tracking-[0.10em] uppercase">Connected</div>
                    <div className="font-mono text-[10px] text-boneDim/70 mt-0.5">{sourceLabel}</div>
                    <div className="font-mono text-[10px] text-orange/85 mt-1 tracking-wider tabular-nums break-all">{shortAddr(w.address)}</div>
                  </div>
                </div>
              ) : PRIVY_HAS_VISIBLE_LOGIN ? (
                <>
                  {PRIVY_EMAIL_ENABLED && (
                    <button
                      disabled={!w.isReady || busy !== null}
                      onClick={() => run('email', () => w.loginEmail())}
                      className="btn-orange w-full h-11 rounded-sm font-mono text-[11px] tracking-[0.20em] uppercase disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
                      style={{ borderRadius: '4px' }}
                    >
                      {busy === 'email' ? (<><Spinner /> Connecting…</>) : 'Continue with email'}
                    </button>
                  )}

                  {PRIVY_EMAIL_ENABLED && hasSocialLogin && (
                    <div className="flex items-center gap-3 my-1">
                      <div className="flex-1 h-px bg-orange/12" />
                      <span className="font-mono text-[9px] tracking-[0.22em] text-boneDim/40">OR</span>
                      <div className="flex-1 h-px bg-orange/12" />
                    </div>
                  )}

                  {hasSocialLogin && (
                    <div className="flex items-center justify-center gap-3">
                      {PRIVY_GOOGLE_ENABLED && (
                        <button disabled={!w.isReady || busy !== null} onClick={() => run('google', () => w.loginSocial('google'))} aria-label="Continue with Google" className="relative disabled:opacity-50 disabled:cursor-not-allowed">
                          <GoogleMark />
                          {busy === 'google' && <span className="absolute inset-0 flex items-center justify-center rounded-sm bg-black/45 text-bone"><Spinner /></span>}
                        </button>
                      )}
                      {PRIVY_X_ENABLED && (
                        <button disabled={!w.isReady || busy !== null} onClick={() => run('twitter', () => w.loginSocial('twitter'))} aria-label="Continue with X" className="relative disabled:opacity-50 disabled:cursor-not-allowed">
                          <XMono />
                          {busy === 'twitter' && <span className="absolute inset-0 flex items-center justify-center rounded-sm bg-black/45 text-bone"><Spinner /></span>}
                        </button>
                      )}
                      {PRIVY_APPLE_ENABLED && (
                        <button disabled={!w.isReady || busy !== null} onClick={() => run('apple', () => w.loginSocial('apple'))} aria-label="Continue with Apple" className="relative disabled:opacity-50 disabled:cursor-not-allowed">
                          <AppleMark />
                          {busy === 'apple' && <span className="absolute inset-0 flex items-center justify-center rounded-sm bg-black/45 text-bone"><Spinner /></span>}
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div
                  className="rounded-sm p-4"
                  style={{ background: 'rgba(7,9,11,0.55)', border: '1px solid rgba(242,106,31,0.12)' }}
                >
                  <button
                    disabled={!w.isReady || busy !== null}
                    onClick={() => run('wallet', () => w.openExternalWalletModal())}
                    className="btn-orange w-full h-11 rounded-sm font-mono text-[11px] tracking-[0.20em] uppercase disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
                    style={{ borderRadius: '4px' }}
                  >
                    {busy === 'wallet' ? (<><Spinner /> Opening…</>) : 'Connect wallet'}
                  </button>
                  <div className="mt-3 font-mono text-[10px] text-boneDim/55 leading-relaxed text-center">
                    Phantom · Backpack · Solflare
                  </div>
                </div>
              )}
            </div>

            {!w.isConnected && PRIVY_HAS_VISIBLE_LOGIN && (
              <div className="pt-4 mt-4 hairline-t flex items-center justify-between font-mono text-[10px] tracking-wider text-boneDim/55">
                <span>Already on Solana?</span>
                <button disabled={busy !== null} onClick={() => run('wallet', () => w.openExternalWalletModal())} className="text-orange/85 hover:text-orange disabled:opacity-50 disabled:cursor-not-allowed">{busy === 'wallet' ? 'Opening…' : 'Use a wallet →'}</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
