'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useFundWallet } from '@privy-io/react-auth/solana';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { makeL1Connection, IS_MAINNET } from '@/lib/constants';
import { PRIVY_AUTH_ENABLED } from '@/lib/privy-config';

interface OpenArgs {
  reason?: string;
  required: number; // lamports
  have?: number;
  address?: string;
  /** Optional title override. When the SOL shortfall is for fees/rent on
   *  an SPL-token table, pass e.g. "SOL needed for fees" so the user
   *  doesn't misread the modal as "buy more of the table's token". */
  title?: string;
  /** Optional symbol of the table's currency (e.g., "POKER", "USDC").
   *  When set, the modal adds an explanatory line that the shortfall is
   *  SOL for fees, not the table token itself. */
  tableTokenSymbol?: string;
}

interface InsufficientFundsCtx {
  open: (args: OpenArgs) => void;
  close: () => void;
  isOpen: boolean;
}

const Ctx = createContext<InsufficientFundsCtx | null>(null);

export function useInsufficientFundsModal(): InsufficientFundsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useInsufficientFundsModal must be used inside InsufficientFundsProvider');
  return v;
}

/**
 * Convenience wrapper for catch blocks: pass any caught error and this routes
 * INSUFFICIENT_FUNDS errors to the global modal. Returns true if the error was
 * handled so callers can short-circuit their own toast/error UI.
 *
 *   try { ... } catch (e) {
 *     if (handleFundsError(e)) return;
 *     showToast(...);
 *   }
 */
export function useFundsErrorHandler() {
  const { open } = useInsufficientFundsModal();
  return useCallback(
    (e: unknown): boolean => {
      const err = e as {
        code?: string;
        required?: number;
        have?: number;
        address?: string;
        reason?: string;
        title?: string;
        tableTokenSymbol?: string;
      } | null;
      if (!err || err.code !== 'INSUFFICIENT_FUNDS' || typeof err.required !== 'number') return false;
      open({
        reason: err.reason ?? 'This action needs SOL.',
        required: err.required,
        have: err.have,
        address: err.address,
        title: err.title,
        tableTokenSymbol: err.tableTokenSymbol,
      });
      return true;
    },
    [open],
  );
}

type PrivyFundHook = ReturnType<typeof useFundWallet> | null;

function usePrivyFundHookEnabled(): PrivyFundHook {
  return useFundWallet();
}

function usePrivyFundHookDisabled(): PrivyFundHook {
  return null;
}

const usePrivyFundHook: () => PrivyFundHook =
  PRIVY_AUTH_ENABLED ? usePrivyFundHookEnabled : usePrivyFundHookDisabled;

export function InsufficientFundsProvider({ children }: { children: React.ReactNode }) {
  const [args, setArgs] = useState<OpenArgs | null>(null);
  const open = useCallback((a: OpenArgs) => setArgs(a), []);
  const close = useCallback(() => setArgs(null), []);
  return (
    <Ctx.Provider value={{ open, close, isOpen: !!args }}>
      {children}
      {args && <InsufficientFundsModal args={args} onClose={close} />}
    </Ctx.Provider>
  );
}

function InsufficientFundsModal({ args, onClose }: { args: OpenArgs; onClose: () => void }) {
  const w = useUnifiedWallet();
  const fundHook = usePrivyFundHook();
  const [copied, setCopied] = useState(false);
  const [liveBalance, setLiveBalance] = useState<number | undefined>(args.have);
  const address = args.address ?? w.address ?? '';
  const requiredSol = args.required / 1e9;

  // Poll balance live so user sees funds arrive without leaving the modal.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const conn = makeL1Connection();
    let id: ReturnType<typeof setInterval> | null = null;
    (async () => {
      const { PublicKey } = await import('@solana/web3.js');
      const pk = new PublicKey(address);
      const fetchBal = async () => {
        try {
          const lamports = await conn.getBalance(pk, 'confirmed');
          if (!cancelled) setLiveBalance(lamports);
        } catch { /* ignore */ }
      };
      fetchBal();
      id = setInterval(fetchBal, 4000);
    })();
    return () => { cancelled = true; if (id) clearInterval(id); };
  }, [address]);

  // ESC closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-close once balance crosses the threshold.
  useEffect(() => {
    if (liveBalance === undefined) return;
    if (liveBalance >= args.required) {
      const t = setTimeout(onClose, 800);
      return () => clearTimeout(t);
    }
  }, [liveBalance, args.required, onClose]);

  const haveSol = useMemo(() => (liveBalance !== undefined ? liveBalance / 1e9 : null), [liveBalance]);
  const funded = liveBalance !== undefined && liveBalance >= args.required;

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
  };

  const fund = async () => {
    if (!fundHook || !address) return;
    try {
      await fundHook.fundWallet({ address, options: { amount: '0.05', cluster: { name: 'devnet' } as any } as any });
    } catch (e) {
      console.warn('[Fund] failed', e);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center px-4"
      style={{ background: 'rgba(4,6,9,0.78)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="mx-auto w-full max-w-md"
        style={{
          background: 'linear-gradient(180deg, #10131B 0%, #0A0D14 100%)',
          border: '1px solid rgba(242,106,31,0.20)',
          borderTopColor: 'rgba(242,106,31,0.36)',
          borderRadius: '12px',
          boxShadow: '0 30px 80px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.03)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-4 hairline-b flex items-start justify-between">
          <div>
            <div className="font-mono text-[9px] tracking-[0.22em] text-orange/80 mb-1">◆ FUND WALLET</div>
            <div className="font-display text-bone text-xl tracking-[0.06em] uppercase">
              {funded
                ? 'Funded'
                : args.title ?? (args.tableTokenSymbol ? 'SOL needed for fees' : 'Wallet needs SOL')}
            </div>
            <div className="font-mono text-[11px] text-boneDim/65 mt-1">
              {funded
                ? 'Balance reached. Closing…'
                : args.reason ?? `Send at least ${requiredSol.toFixed(3)} SOL to your address to continue.`}
            </div>
            {!funded && args.tableTokenSymbol && (
              <div className="font-mono text-[10px] text-amber-300/80 mt-1.5 leading-relaxed">
                This is a <span className="text-amber-300 font-bold">{args.tableTokenSymbol}</span> table. Every Solana action also costs a tiny amount of SOL for network fees and rent — that&rsquo;s what&rsquo;s short, not your {args.tableTokenSymbol} balance.
              </div>
            )}
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

        <div className="px-6 py-5 space-y-4">
          {/* Required vs current */}
          <div className="grid grid-cols-2 gap-2">
            <div
              className="rounded-sm p-3"
              style={{ background: 'rgba(7,9,11,0.55)', border: '1px solid rgba(242,106,31,0.12)' }}
            >
              <div className="font-mono text-[9px] tracking-[0.22em] text-boneDim/55">REQUIRED</div>
              <div className="font-display text-bone text-2xl tabular-nums leading-none mt-1">
                {requiredSol.toFixed(3)}
              </div>
              <div className="font-mono text-[9px] text-boneDim/45 mt-1">SOL</div>
            </div>
            <div
              className="rounded-sm p-3"
              style={{
                background: funded ? 'rgba(52,211,153,0.06)' : 'rgba(7,9,11,0.55)',
                border: `1px solid ${funded ? 'rgba(52,211,153,0.30)' : 'rgba(242,106,31,0.12)'}`,
              }}
            >
              <div className="font-mono text-[9px] tracking-[0.22em] text-boneDim/55">CURRENT</div>
              <div className={`font-display text-2xl tabular-nums leading-none mt-1 ${funded ? 'text-emerald-300' : 'text-bone'}`}>
                {haveSol === null ? '—' : haveSol.toFixed(6)}
              </div>
              <div className="font-mono text-[9px] text-boneDim/45 mt-1">SOL</div>
            </div>
          </div>

          {/* Address */}
          <div>
            <div className="font-mono text-[9px] tracking-[0.22em] text-boneDim/55 mb-1.5">YOUR ADDRESS</div>
            <button
              onClick={copy}
              className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-sm transition group"
              style={{ background: 'rgba(7,9,11,0.55)', border: '1px solid rgba(242,106,31,0.12)' }}
            >
              <span className="font-mono text-[11px] text-bone tabular-nums break-all flex-1">{address}</span>
              <span className={`font-mono text-[9px] tracking-[0.22em] shrink-0 ${copied ? 'text-emerald-400' : 'text-orange/60 group-hover:text-orange'}`}>
                {copied ? 'COPIED' : 'COPY'}
              </span>
            </button>
          </div>

          {/* Actions */}
          {!funded && (
            <div className="flex gap-2">
              {fundHook && w.source?.startsWith('privy') && (
                <button
                  onClick={fund}
                  className="btn-orange flex-1 h-10 rounded-sm font-mono text-[11px] tracking-[0.20em] uppercase"
                  style={{ borderRadius: '4px' }}
                >
                  Fund via Privy
                </button>
              )}
              <button
                onClick={onClose}
                className="flex-1 h-10 rounded-sm font-mono text-[11px] tracking-[0.20em] uppercase text-boneDim/70 hover:text-bone transition"
                style={{ background: 'rgba(7,9,11,0.55)', border: '1px solid rgba(242,106,31,0.18)' }}
              >
                I’ll send manually
              </button>
            </div>
          )}

          {!funded && (
            <div className="font-mono text-[10px] text-boneDim/55 leading-relaxed">
              {IS_MAINNET ? (
                <>Send SOL to this address from any wallet or exchange. Balance updates every 4s.</>
              ) : (
                <>
                  Devnet SOL is free —{' '}
                  <a
                    href="https://faucet.solana.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-orange/80 hover:text-orange underline-offset-2 hover:underline"
                  >
                    solana faucet
                  </a>{' '}
                  or{' '}
                  <code className="text-orange/80">solana airdrop 0.05 {address.slice(0, 6)}… --url devnet</code>.
                  Balance updates every 4s.
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
