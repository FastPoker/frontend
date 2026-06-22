'use client';

import { useEffect, useState } from 'react';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { useConnectModal } from '@/components/wallet/FastPokerConnectModal';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { usePlayer } from '@/hooks/usePlayer';
import { SolIcon } from '@/components/ui/TokenIcon';
import { PRIVY_HAS_VISIBLE_LOGIN } from '@/lib/privy-config';

export interface RegisterModalProps {
  open: boolean;
  onClose: () => void;
  reason?: 'play' | 'sng' | 'cash' | null;
}

const ACCENT = '#F26A1F';

function shortAddr(a: string | undefined | null): string {
  return a ? `${a.slice(0, 4)}...${a.slice(-4)}` : '';
}

export function RegisterModal({ open, onClose, reason = null }: RegisterModalProps) {
  const { isConnected: connected, publicKey } = useUnifiedWallet();
  const { open: openConnect } = useConnectModal();
  const { player, register, isLoading } = usePlayer();

  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [handle, setHandle] = useState('');
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!connected) setStep(0);
    else if (!player?.isRegistered) setStep(1);
    else setStep(3);
  }, [open, connected, player?.isRegistered]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', h);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const addr = publicKey?.toBase58() ?? '';

  const doReserveHandle = () => {
    if (handle.length > 0 && handle.length < 3) return;
    setStep(2);
  };

  const doPay = async () => {
    setPaying(true);
    setError(null);
    try {
      const result = await register();
      if (result === 'already_registered' || typeof result === 'string') {
        setStep(3);
      } else {
        setStep(3);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPaying(false);
    }
  };

  const title =
    step === 0
      ? (PRIVY_HAS_VISIBLE_LOGIN ? 'SIGN IN' : 'CONNECT WALLET')
      : step === 1
        ? 'CREATE YOUR HANDLE'
        : step === 2
          ? 'ONE-TIME SETUP'
          : "YOU'RE IN.";

  const subtitle =
    reason === 'play'
      ? 'REGISTRATION REQUIRED TO PLAY'
      : reason === 'sng'
        ? 'REGISTRATION REQUIRED TO JOIN SNG'
        : reason === 'cash'
          ? 'REGISTRATION REQUIRED TO SIT'
          : 'ACCOUNT SETUP · ON-CHAIN RENT';

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink/80 backdrop-blur-md"
      />
      <div className="relative mx-4 my-6 fade-in" style={{ width: 480, maxWidth: 'calc(100vw - 32px)' }}>
        <div
          className="glass-room overflow-hidden rounded-md"
          style={{ boxShadow: '0 40px 80px rgba(0,0,0,0.7), 0 0 40px rgba(242,106,31,0.15)' }}
        >
          <div className="px-5 py-3.5 hairline-b flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="font-display text-bone text-lg leading-none tracking-wide">{title}</span>
              <span className="font-mono text-[10px] text-boneDim/70 tracking-wider">{subtitle}</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-boneDim hover:text-bone transition leading-none text-2xl -mt-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="px-5 pt-3">
            <div className="flex items-center gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="flex-1 h-1 rounded-full"
                  style={{
                    background: step >= i ? ACCENT : 'rgba(255,255,255,0.08)',
                    boxShadow: step === i ? `0 0 6px ${ACCENT}` : 'none',
                  }}
                />
              ))}
            </div>
          </div>

          <div className="px-5 py-4">
            {step === 0 && (
              <>
                <p className="text-sm text-boneDim leading-relaxed">
                  {PRIVY_HAS_VISIBLE_LOGIN
                    ? "Sign in with an enabled account method or connect a Solana wallet. We don't store anything. Your account is your login."
                    : "Connect a Solana wallet. We don't store anything. Your wallet is your login."}
                </p>
                <div className="mt-5">
                  <button
                    type="button"
                    onClick={() => openConnect()}
                    className="btn-orange w-full font-mono tracking-[0.22em] text-[11px] font-bold py-3 rounded-sm"
                  >
                    {PRIVY_HAS_VISIBLE_LOGIN ? 'SIGN IN' : 'CONNECT WALLET'}
                  </button>
                </div>
                <div className="mt-3 font-mono text-[10px] text-boneDim/55 leading-relaxed">
                  {PRIVY_HAS_VISIBLE_LOGIN
                    ? 'Enabled account methods · or Phantom / Backpack / Solflare.'
                    : 'Phantom / Backpack / Solflare.'}
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <div
                  className="flex items-center gap-2 mb-4 p-2.5 rounded-sm hairline bg-emerald-400/[0.06]"
                  style={{ borderColor: 'rgba(52,211,153,0.25)' }}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="font-mono text-[10px] text-emerald-300 tracking-wider">CONNECTED</span>
                  <span className="font-mono text-[10px] text-boneDim tabular-nums ml-auto">
                    {shortAddr(addr)}
                  </span>
                </div>
                <p className="text-sm text-boneDim leading-relaxed">
                  Optional. What should other players see at the table? If you skip, we'll use your wallet address.
                </p>
                <div className="mt-4 flex items-center rounded-sm overflow-hidden hairline bg-ink/40">
                  <span className="pl-3 font-mono text-[11px] text-boneDim/45">@</span>
                  <input
                    autoFocus
                    value={handle}
                    onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_\-]/g, ''))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') doReserveHandle();
                    }}
                    placeholder={shortAddr(addr)}
                    maxLength={16}
                    className="flex-1 bg-transparent px-2 py-3 font-display text-xl outline-none text-bone"
                  />
                  {handle.length >= 3 && (
                    <span className="pr-3 inline-flex items-center gap-1 font-mono text-[9px] text-emerald-400 tracking-[0.2em]">
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M2 5l2 2 4-4" />
                      </svg>
                      OPEN
                    </span>
                  )}
                </div>
                <div className="mt-3 font-mono text-[10px] text-boneDim/55 leading-relaxed">
                  3-16 characters · letters, numbers, - and _ · free to change later
                </div>
                <div className="mt-5 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setHandle('');
                      doReserveHandle();
                    }}
                    className="flex-1 px-4 py-2.5 rounded-sm border border-bone/15 hover:border-bone/30 font-mono text-[11px] tracking-[0.22em] text-boneDim hover:text-bone transition"
                  >
                    SKIP
                  </button>
                  <button
                    type="button"
                    onClick={doReserveHandle}
                    disabled={handle.length > 0 && handle.length < 3}
                    className="flex-[2] btn-orange px-5 py-2.5 rounded-sm font-mono text-[11px] tracking-[0.22em] font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    CONTINUE →
                  </button>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <p className="text-sm text-boneDim leading-relaxed">
                  One-time, on-chain. This pays Solana's rent for your profile account. We don't receive a cent, and you get
                  it back if you ever close your account.
                </p>
                <div className="mt-4 p-4 rounded-sm hairline bg-ink/40 space-y-2">
                  {[
                    { l: 'Profile PDA rent', v: '0.00089 SOL' },
                    { l: 'Tx fee (priority)', v: '0.00005 SOL' },
                    { l: 'Reclaim on close', v: '+0.00089 SOL', tone: 'emerald' as const },
                  ].map((r) => (
                    <div key={r.l} className="flex items-center justify-between">
                      <span className="font-mono text-[11px] text-bone/80">{r.l}</span>
                      <span
                        className={cn(
                          'font-mono text-[11px] tabular-nums',
                          r.tone === 'emerald' ? 'text-emerald-300' : 'text-bone'
                        )}
                      >
                        {r.v}
                      </span>
                    </div>
                  ))}
                  <div className="h-px my-2 bg-white/10" />
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] tracking-[0.22em] text-boneDim/55">TOTAL NOW</span>
                    <span className="font-display text-2xl tabular-nums inline-flex items-center gap-1" style={{ color: ACCENT }}>
                      0.00094 <SolIcon size={18} />
                    </span>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2 font-mono text-[10px] text-boneDim/60">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="6" cy="6" r="5" />
                    <path d="M6 3v3M6 8v.01" />
                  </svg>
                  Paid to Solana, not Fast Poker.
                </div>
                {error && (
                  <div className="mt-3 font-mono text-[10px] text-rose-300 leading-relaxed">{error}</div>
                )}
                <button
                  type="button"
                  onClick={doPay}
                  disabled={paying || isLoading}
                  className="mt-5 w-full btn-orange px-5 py-3 rounded-sm font-mono text-[11px] tracking-[0.22em] font-bold disabled:opacity-70"
                >
                  {paying ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-ink animate-pulse" />
                      CONFIRMING IN WALLET…
                    </span>
                  ) : (
                    'CONFIRM IN WALLET →'
                  )}
                </button>
              </>
            )}

            {step === 3 && (
              <div className="text-center py-6">
                <div
                  className="w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-4"
                  style={{ background: `${ACCENT}20`, border: `1.5px solid ${ACCENT}` }}
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2">
                    <path d="M4 12l5 5 11-11" />
                  </svg>
                </div>
                <div className="font-display text-3xl tracking-wide text-bone">
                  WELCOME{handle ? `, @${handle}` : ''}
                </div>
                <p className="mt-2 text-sm text-boneDim">Your seat is live. Head to the lobby to sit down.</p>
                <div className="mt-5 flex gap-2 justify-center">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-5 py-2.5 rounded-sm border border-bone/15 hover:border-bone/30 font-mono text-[11px] tracking-[0.22em] text-boneDim hover:text-bone transition"
                  >
                    CLOSE
                  </button>
                  <Link
                    href="/lobby"
                    onClick={onClose}
                    className="btn-orange px-5 py-2.5 rounded-sm font-mono text-[11px] tracking-[0.22em] font-bold inline-flex items-center gap-2"
                  >
                    ENTER LOBBY →
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
