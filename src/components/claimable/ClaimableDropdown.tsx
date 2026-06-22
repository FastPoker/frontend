'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import { RAW_YIELD_NAME, LIQUID_FP_NAME } from '@/lib/jackpot-format';

export interface ClaimableTotals {
  /** Raw Yield from the caller's SNG emissions. Internal name: unrefined. */
  pokerUnrefined: number;
  /** $FP = passive share of other players' Raw Yield claim fees. */
  pokerRefined: number;
  /** SOL paid out from SNG prize pools. */
  sngSol: number;
  /** SOL paid out from staked $FP APY. */
  stakingSol: number;
  /** Optional price context for header USD line. */
  solPrice?: number;
  fpPrice?: number;
  /** Unix ms timestamp of the source snapshot. 0 means no data yet. The
   *  dropdown surfaces this as "as of Xs ago" so the user knows the values
   *  may be slightly stale (15s indexer cache). The Claim button forces a
   *  live read before submitting, so on-chain ix never runs on stale data. */
  asOfMs?: number;
}

export const ZERO_CLAIMABLE: ClaimableTotals = {
  pokerUnrefined: 0,
  pokerRefined: 0,
  sngSol: 0,
  stakingSol: 0,
};

interface Props {
  open: boolean;
  onClose: () => void;
  anchorRect: DOMRect | null;
  align?: 'left' | 'right';
  totals: ClaimableTotals;
  onClaim?: (key: 'poker' | 'sng' | 'stake') => Promise<void> | void;
}

type RowState = 'ready' | 'pending' | 'done';

export function ClaimableDropdown({ open, onClose, anchorRect, align = 'left', totals, onClaim }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [claiming, setClaiming] = useState<'poker' | 'sng' | 'stake' | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});
  // Server timestamp at the moment each row was claimed. Used to recognise a
  // FRESH claim of the same type later: once the totals snapshot has advanced
  // past this timestamp AND a positive amount appears, we clear `done` so the
  // button is clickable again. Without this, the just-claimed row stays in the
  // `done` state forever and a new claim of the same kind looks unclaimable.
  const [claimedAtMs, setClaimedAtMs] = useState<Record<string, number>>({});
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Clear `done` for any row whose totals snapshot has refreshed past the
  // claim time and now reports a positive amount: that's a NEW claim, not the
  // stale post-claim snapshot. Compare server-side `asOfMs` against the
  // (server-side) Date.now() recorded at claim time; for typical clock skew
  // (seconds, not hours) this is reliable enough.
  useEffect(() => {
    if (!totals.asOfMs) return;
    setDone(prev => {
      const next = { ...prev };
      let changed = false;
      const check = (key: 'poker' | 'sng' | 'stake', current: number) => {
        const claimedMs = claimedAtMs[key] || 0;
        if (next[key] && totals.asOfMs! > claimedMs && current > 0) {
          delete next[key];
          changed = true;
        }
      };
      check('poker', totals.pokerUnrefined + totals.pokerRefined);
      check('sng', totals.sngSol);
      check('stake', totals.stakingSol);
      return changed ? next : prev;
    });
  }, [totals.asOfMs, totals.pokerUnrefined, totals.pokerRefined, totals.sngSol, totals.stakingSol, claimedAtMs]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  const { pokerUnrefined, pokerRefined, sngSol, stakingSol, solPrice = 0, fpPrice = 0, asOfMs } = totals;
  const ageSeconds =
    typeof asOfMs === 'number' && asOfMs > 0
      ? Math.max(0, Math.floor((Date.now() - asOfMs) / 1000))
      : null;
  const pokerTotal = pokerUnrefined + pokerRefined;
  const totalSol = sngSol + stakingSol;
  const totalSolUsd = (totalSol * solPrice).toFixed(2);
  const pokerUsd = (pokerTotal * fpPrice).toFixed(2);

  const popStyle: React.CSSProperties = { position: 'fixed', width: 360, zIndex: 70 };
  if (anchorRect) {
    const popW = 360;
    const left = align === 'right'
      ? Math.min(window.innerWidth - popW - 12, anchorRect.right - popW)
      : Math.max(12, anchorRect.left);
    popStyle.left = left;
    const dropDown = anchorRect.top < window.innerHeight * 0.5;
    if (dropDown) popStyle.top = anchorRect.bottom + 8;
    else popStyle.bottom = window.innerHeight - anchorRect.top + 8;
  } else {
    popStyle.left = 12;
    popStyle.bottom = 56;
  }

  const runClaim = async (key: 'poker' | 'sng' | 'stake') => {
    setClaiming(key);
    try {
      if (onClaim) await onClaim(key);
      else await new Promise(r => setTimeout(r, 900));
      // Stamp the claim time so the totals-watcher above can recognise a fresh
      // claim later (asOfMs > claimedAtMs[key] && amount > 0 -> clear done).
      setClaimedAtMs(s => ({ ...s, [key]: Date.now() }));
      setDone(s => ({ ...s, [key]: true }));
    } finally {
      setClaiming(null);
    }
  };

  return createPortal(
    <div ref={ref} className="fade-in glass-pop overflow-hidden rounded-md shadow-2xl" style={popStyle}>
      {/* Header: total SOL + total $FP claimable */}
      <div className="px-4 py-3 hairline-b flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow mb-1 text-orange/80 flex items-center gap-2">
            <span>CLAIMABLE</span>
            {ageSeconds !== null && (
              <span className="font-mono text-[8px] tracking-[0.18em] text-boneDim/40">
                AS OF {ageSeconds < 60 ? `${ageSeconds}S` : `${Math.floor(ageSeconds / 60)}M`} AGO
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Image src="/tokens/sol.svg" alt="SOL" width={18} height={18} className="rounded-full" />
            <span className="font-display text-emerald-300 text-[22px] leading-none tabular-nums">
              {totalSol.toFixed(4)}
            </span>
            <span className="font-mono text-[10px] text-boneDim/60 tabular-nums">SOL · ${totalSolUsd}</span>
          </div>
          <div className="flex items-baseline gap-2 flex-wrap mt-1">
            <span className="font-display text-amber text-[15px] leading-none tabular-nums">
              {pokerTotal.toFixed(2)}
            </span>
            <span className="font-mono text-[9px] text-amber/70 tracking-[0.2em]">$FP · ${pokerUsd}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-boneDim/50 hover:text-bone font-mono text-[14px] leading-none mt-1"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <ClaimRow
        title="$FP from SNG"
        blurb={`${RAW_YIELD_NAME} is your held SNG FP. ${LIQUID_FP_NAME} is paid with it when you Claim All.`}
        token="POKER"
        taxInfo
        rows={[
          { label: RAW_YIELD_NAME, note: 'your SNG emissions', amount: pokerUnrefined, tone: 'amber' },
          { label: LIQUID_FP_NAME, note: 'from other claims', amount: pokerRefined, tone: 'emerald' },
        ]}
        total={pokerTotal}
        tokenLabel="$FP"
        state={claiming === 'poker' ? 'pending' : done.poker ? 'done' : 'ready'}
        onClaim={() => runClaim('poker')}
      />

      <ClaimRow
        title="SOL from SNG"
        blurb="SOL prize pool winnings from SNG games. Available from every tier."
        token="SOL"
        rows={[
          { label: 'Prize pool', note: 'your SNG winnings', amount: sngSol, tone: 'emerald' },
        ]}
        total={sngSol}
        tokenLabel="SOL"
        state={claiming === 'sng' ? 'pending' : done.sng ? 'done' : 'ready'}
        onClaim={() => runClaim('sng')}
      />

      <ClaimRow
        title="SOL from Staking"
        blurb="APY on staked $FP. SPL vault tokens live on the earn page."
        token="SOL"
        rows={[
          { label: 'Staking APY', note: 'accrued rewards', amount: stakingSol, tone: 'emerald' },
        ]}
        total={stakingSol}
        tokenLabel="SOL"
        state={claiming === 'stake' ? 'pending' : done.stake ? 'done' : 'ready'}
        onClaim={() => runClaim('stake')}
        last
      />

      <div className="px-4 py-2.5 bg-ink/60">
        <div className="font-mono text-[9px] text-boneDim/55 leading-relaxed">
          Claims are gas-free via TEE session key. Claim All refines your Raw $FP into liquid $FP and pays out the $FP you've earned from other refiners' 10% refinement fees, both in one transaction. The refinement fee paces emission against fee revenue. Burn $FP to bond and earn bonded yield from protocol vaults.
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ClaimRow({
  title, blurb, token, rows, total, tokenLabel, state, onClaim, last, taxInfo,
}: {
  title: string;
  blurb: string;
  token: 'POKER' | 'SOL';
  rows: { label: string; note: string; amount: number; tone: 'amber' | 'emerald' }[];
  total: number;
  tokenLabel: string;
  state: RowState;
  onClaim: () => void;
  last?: boolean;
  taxInfo?: boolean;
}) {
  const disabled = total < 0.00001;
  const isPoker = token === 'POKER';
  const [taxOpen, setTaxOpen] = useState(false);
  const iconSrc = isPoker ? '/brand/app-icon.png' : '/tokens/sol.svg';

  return (
    <div className={cn('px-4 py-3', !last && 'hairline-b')}>
      <div className="flex items-center gap-2 mb-1.5">
        <Image src={iconSrc} alt={token} width={14} height={14} className="rounded-full" />
        <span className="font-display text-bone text-[13px] leading-none">{title}</span>
        {taxInfo && (
          <div className="relative ml-auto" onMouseEnter={() => setTaxOpen(true)} onMouseLeave={() => setTaxOpen(false)}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setTaxOpen(v => !v); }}
              className="flex items-center gap-1 px-1.5 py-[2px] rounded-sm border border-amber/30 bg-amber/5 hover:bg-amber/10 text-amber font-mono text-[9px] tracking-[0.18em] leading-none"
              title="Tax info"
            >
              <svg className="w-2.5 h-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="5" cy="5" r="4" />
                <path d="M5 4.2v2.4M5 3.1v.1" />
              </svg>
              <span>10% TAX</span>
            </button>
            {taxOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-[240px] z-[80] glass-pop px-2.5 py-2 shadow-xl rounded-md">
                <div className="font-mono text-[9px] text-amber tracking-[0.2em] mb-1">CLAIM FEE</div>
                <div className="font-mono text-[10px] text-bone/85 leading-relaxed">
                  Claiming <span className="text-amber">{RAW_YIELD_NAME}</span> pays a <span className="text-amber">10%</span> fee.
                  The fee feeds <span className="text-emerald-300">{LIQUID_FP_NAME}</span> for players who keep holding {RAW_YIELD_NAME}.
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="font-mono text-[9px] text-boneDim/55 leading-relaxed mb-2">{blurb}</div>

      <div className="space-y-1 mb-2.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className={cn('w-1 h-1 rounded-full shrink-0', r.tone === 'emerald' ? 'bg-emerald-400' : 'bg-amber')} />
              <span className="font-mono text-[10px] text-bone/85 tracking-wider truncate">{r.label}</span>
              <span className="font-mono text-[9px] text-boneDim/45 tracking-wider truncate">· {r.note}</span>
            </div>
            <span className={cn('flex items-center gap-1 font-mono text-[10px] tabular-nums shrink-0', r.tone === 'emerald' ? 'text-emerald-300' : 'text-amber')}>
              {isPoker ? (
                r.amount.toFixed(2)
              ) : (
                <>
                  <Image src="/tokens/sol.svg" alt="SOL" width={9} height={9} className="rounded-full" />
                  <span>{r.amount.toFixed(4)}</span>
                </>
              )}
            </span>
          </div>
        ))}
      </div>

      <button
        onClick={onClaim}
        disabled={disabled || state !== 'ready'}
        className={cn(
          'w-full py-2 rounded-md font-mono text-[10px] tracking-[0.2em] font-bold transition flex items-center justify-center gap-1.5',
          state === 'done' && 'bg-emerald-500/30 text-emerald-200 hairline',
          state === 'pending' && 'bg-amber/20 text-amber hairline',
          state === 'ready' && (isPoker ? 'btn-orange' : 'bg-emerald-500/90 hover:bg-emerald-400 text-ink'),
          disabled && state === 'ready' && 'opacity-30 cursor-not-allowed',
        )}
      >
        {state === 'done' ? (
          <span>CLAIMED ✓</span>
        ) : state === 'pending' ? (
          <span>CLAIMING…</span>
        ) : disabled ? (
          <span>{`NO ${tokenLabel} TO CLAIM`}</span>
        ) : isPoker ? (
          <>
            <span>CLAIM ALL</span>
            <span className="tabular-nums">{total.toFixed(2)}</span>
            <Image src="/brand/app-icon.png" alt="$FP" width={10} height={10} className="rounded-full" />
            <span>$FP</span>
          </>
        ) : (
          <>
            <span>CLAIM</span>
            <Image src="/tokens/sol.svg" alt="SOL" width={10} height={10} className="rounded-full" />
            <span className="tabular-nums">{total.toFixed(4)}</span>
            <span>SOL</span>
          </>
        )}
      </button>
    </div>
  );
}
