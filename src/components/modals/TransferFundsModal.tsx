'use client';

/**
 * Transfer Funds — send SOL / USDC / $FP from the connected wallet (Privy
 * embedded or external) to any other wallet.
 *
 * Named "Transfer Funds", NOT "Withdraw": these are self-custodied wallets,
 * we never hold user funds, and "withdraw" wrongly implies custody.
 *
 * Balances are read directly on-chain when the modal opens (a funds-moving
 * surface must not trust a cached indexer snapshot). SPL sends create the
 * recipient's ATA idempotently, paid by the sender.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import { ModalShell } from '@/components/modals/ModalShell';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { refreshWalletBalances } from '@/hooks/useWalletBalances';
import { makeL1Connection, POKER_MINT, USDC_MINT, IS_MAINNET } from '@/lib/constants';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { confirmFundsAction } from '@/lib/funds-confirmation';
import { cn } from '@/lib/utils';

interface TokenDef {
  key: 'SOL' | 'USDC' | 'FP';
  label: string;
  icon: string;
  decimals: number;
  mint: PublicKey | null; // null = native SOL
}

const TOKENS: TokenDef[] = [
  { key: 'SOL', label: 'SOL', icon: '/tokens/sol.svg', decimals: 9, mint: null },
  { key: 'USDC', label: 'USDC', icon: '/tokens/usdc.svg', decimals: 6, mint: USDC_MINT },
  { key: 'FP', label: '$FP', icon: '/brand/app-icon.png', decimals: 9, mint: POKER_MINT },
];

// Keep enough SOL behind for the transfer fee plus one possible recipient-ATA
// rent when MAXing out (worst case is an SPL send; for SOL itself the buffer
// just prevents an unfundable follow-up fee).
const SOL_FEE_BUFFER = 0.003;

function fmtBal(v: number | null, decimals: number): string {
  if (v === null) return '…';
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return v.toLocaleString(undefined, { maximumFractionDigits: Math.min(decimals, 6) });
}

export function TransferFundsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { isConnected, publicKey, sendTransaction } = useUnifiedWallet();
  // Portal to <body>: this modal mounts inside the ProfilePill, whose navbar
  // ancestors carry transforms/backdrop-filters that become the containing
  // block for `fixed` — without the portal the dialog rendered off-center and
  // clipped (title + token row cut off above the visible area). Same pattern
  // as SessionModal.
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => { setPortalReady(true); }, []);
  const [token, setToken] = useState<TokenDef>(TOKENS[0]);
  const [balances, setBalances] = useState<Record<string, number | null>>({ SOL: null, USDC: null, FP: null });
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneSig, setDoneSig] = useState<string | null>(null);

  // Fresh on-chain balances every time the modal opens.
  useEffect(() => {
    if (!open || !publicKey) return;
    let cancelled = false;
    setBalances({ SOL: null, USDC: null, FP: null });
    (async () => {
      const conn = makeL1Connection();
      const next: Record<string, number | null> = { SOL: 0, USDC: 0, FP: 0 };
      try { next.SOL = (await conn.getBalance(publicKey, 'confirmed')) / LAMPORTS_PER_SOL; } catch { next.SOL = null; }
      for (const t of TOKENS) {
        if (!t.mint) continue;
        try {
          const ata = await getAssociatedTokenAddress(t.mint, publicKey);
          const bal = await conn.getTokenAccountBalance(ata, 'confirmed');
          next[t.key] = Number(bal.value.uiAmount ?? 0);
        } catch { next[t.key] = 0; /* no ATA = zero balance */ }
      }
      if (!cancelled) setBalances(next);
    })();
    return () => { cancelled = true; };
  }, [open, publicKey, doneSig]);

  // Reset transient state when closed.
  useEffect(() => {
    if (open) return;
    setRecipient(''); setAmount(''); setError(null); setDoneSig(null); setBusy(false);
  }, [open]);

  const balance = balances[token.key];

  const recipientCheck = useMemo((): { pk: PublicKey | null; error: string | null } => {
    const raw = recipient.trim();
    if (!raw) return { pk: null, error: null };
    let pk: PublicKey;
    try { pk = new PublicKey(raw); } catch { return { pk: null, error: 'Not a valid Solana address.' }; }
    if (publicKey && pk.equals(publicKey)) return { pk: null, error: 'That is your own wallet.' };
    // Block off-curve addresses: those are program accounts (table PDAs, vaults),
    // not wallets. Sending there strands funds. Poker users have lots of PDAs on
    // their clipboard, so this foot-gun is real.
    if (!PublicKey.isOnCurve(pk.toBytes())) return { pk: null, error: 'That address is a program account, not a wallet.' };
    return { pk, error: null };
  }, [recipient, publicKey]);

  const amountNum = Number(amount);
  const maxSendable = useMemo(() => {
    if (balance === null) return 0;
    if (token.key === 'SOL') return Math.max(0, balance - SOL_FEE_BUFFER);
    return balance;
  }, [balance, token.key]);

  const amountError =
    !amount ? null :
    !Number.isFinite(amountNum) || amountNum <= 0 ? 'Enter a valid amount.' :
    amountNum > maxSendable ? `Max ${fmtBal(maxSendable, token.decimals)} ${token.label}` :
    null;

  const canSend = !!recipientCheck.pk && !recipientCheck.error && !amountError && amountNum > 0 && !busy && isConnected;

  const handleSend = useCallback(async () => {
    if (!publicKey || !sendTransaction || !recipientCheck.pk || !canSend) return;
    setBusy(true);
    setError(null);
    try {
      const conn = makeL1Connection();
      const units = BigInt(Math.round(amountNum * 10 ** token.decimals));
      const tx = new Transaction();
      if (!token.mint) {
        tx.add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: recipientCheck.pk, lamports: Number(units) }));
      } else {
        const fromAta = await getAssociatedTokenAddress(token.mint, publicKey);
        const toAta = await getAssociatedTokenAddress(token.mint, recipientCheck.pk);
        tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, toAta, recipientCheck.pk, token.mint));
        tx.add(createTransferCheckedInstruction(fromAta, token.mint, toAta, publicKey, units, token.decimals));
      }
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await getLatestBlockhashClient(conn)).blockhash;

      const short = `${recipientCheck.pk.toBase58().slice(0, 4)}…${recipientCheck.pk.toBase58().slice(-4)}`;
      const okToSend = await confirmFundsAction({
        title: 'Confirm Transfer',
        action: `Send ${amountNum} ${token.label} to ${short}`,
        details: [
          `Token: ${token.label}`,
          `Amount: ${amountNum}`,
          `To: ${recipientCheck.pk.toBase58()}`,
          'Transfers are final and cannot be reversed.',
        ],
        transaction: tx,
      });
      if (!okToSend) { setBusy(false); return; }

      const sig = await sendTransaction(tx, conn);
      await conn.confirmTransaction(sig, 'confirmed');
      setDoneSig(sig);
      setAmount('');
      refreshWalletBalances();
    } catch (e: any) {
      const m = e?.message || 'Transfer failed.';
      setError(m.includes('insufficient') || m.includes('0x1') ? 'Insufficient balance to cover the transfer and fee.' : m.slice(0, 160));
    } finally {
      setBusy(false);
    }
  }, [publicKey, sendTransaction, recipientCheck.pk, canSend, amountNum, token]);

  const explorerUrl = doneSig
    ? `https://solscan.io/tx/${doneSig}${IS_MAINNET ? '' : '?cluster=devnet'}`
    : null;

  if (!portalReady || typeof document === 'undefined') return null;
  return createPortal(
    <ModalShell open={open} onClose={onClose} title="TRANSFER FUNDS" subtitle="Send from your wallet to any Solana address" width={440}>
      {doneSig ? (
        <div className="text-center py-4">
          <div className="font-display text-bone text-lg mb-2">Transfer sent.</div>
          <a
            href={explorerUrl!}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] text-orange underline break-all"
          >
            {doneSig.slice(0, 20)}…
          </a>
          <div className="mt-5 flex gap-2 justify-center">
            <button type="button" onClick={() => setDoneSig(null)} className="px-4 py-2 rounded-md hairline font-mono text-[11px] tracking-[0.18em] text-bone/80 hover:text-bone">
              SEND ANOTHER
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2 btn-orange rounded-md font-mono text-[11px] tracking-[0.18em] font-bold">
              DONE
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Token select */}
          <div>
            <div className="font-mono text-[9px] tracking-[0.22em] text-boneDim/55 mb-1.5">TOKEN</div>
            <div className="grid grid-cols-3 gap-2">
              {TOKENS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => { setToken(t); setAmount(''); setError(null); }}
                  className={cn(
                    'flex items-center gap-2 px-2.5 py-2 rounded-md transition text-left',
                    token.key === t.key ? 'border border-orange/60 bg-orange/[0.08]' : 'hairline bg-ink/40 hover:bg-ink/60',
                  )}
                >
                  <Image src={t.icon} alt={t.label} width={16} height={16} className="rounded-full" />
                  <div className="min-w-0 leading-none">
                    <div className="font-mono text-[11px] text-bone">{t.label}</div>
                    <div className="font-mono text-[9px] text-boneDim/60 tabular-nums mt-0.5 truncate">
                      {fmtBal(balances[t.key], t.decimals)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Recipient */}
          <div>
            <div className="font-mono text-[9px] tracking-[0.22em] text-boneDim/55 mb-1.5">RECIPIENT ADDRESS</div>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Solana wallet address"
              spellCheck={false}
              className="w-full px-3 py-2.5 rounded-md bg-ink/60 hairline font-mono text-[12px] text-bone placeholder:text-boneDim/40 outline-none focus:border-orange/50"
            />
            {recipientCheck.error && (
              <div className="font-mono text-[10px] text-rose-300/90 mt-1.5">{recipientCheck.error}</div>
            )}
          </div>

          {/* Amount */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-mono text-[9px] tracking-[0.22em] text-boneDim/55">AMOUNT</span>
              <button
                type="button"
                onClick={() => setAmount(String(maxSendable))}
                className="font-mono text-[9px] tracking-[0.18em] text-orange/70 hover:text-orange"
              >
                MAX {fmtBal(maxSendable, token.decimals)}
              </button>
            </div>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0.00"
              inputMode="decimal"
              className="w-full px-3 py-2.5 rounded-md bg-ink/60 hairline font-mono text-[14px] text-bone tabular-nums placeholder:text-boneDim/40 outline-none focus:border-orange/50"
            />
            {amountError && <div className="font-mono text-[10px] text-rose-300/90 mt-1.5">{amountError}</div>}
          </div>

          {error && (
            <div className="px-3 py-2 rounded-md border border-rose-400/30 bg-rose-500/[0.06] font-mono text-[10px] text-rose-200/90 leading-relaxed">
              {error}
            </div>
          )}

          <button
            type="button"
            disabled={!canSend}
            onClick={handleSend}
            className="w-full px-4 py-3 btn-orange rounded-md font-mono text-[11px] tracking-[0.22em] font-bold disabled:opacity-40 disabled:pointer-events-none"
          >
            {busy ? 'SENDING…' : `SEND ${token.label}`}
          </button>

          <div className="font-mono text-[9px] text-boneDim/50 leading-relaxed">
            Sends directly from your wallet on Solana. Double-check the address:
            transfers are final. SPL sends create the recipient&apos;s token
            account if needed (small one-time rent, paid by you).
          </div>
        </div>
      )}
    </ModalShell>,
    document.body,
  );
}
