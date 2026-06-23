'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { cn } from '@/lib/utils';
import { ClaimableDropdown } from '@/components/claimable/ClaimableDropdown';
import { useClaimableTotals } from '@/hooks/useClaimableTotals';
import { usePokerSupply } from '@/hooks/usePokerSupply';
import { usePoolHealth } from '@/hooks/usePoolHealth';
import { usePrices } from '@/hooks/usePrices';
import { SessionModal, SESSION_MODAL_OPEN_EVENT } from './SessionModal';
import { SessionRenewModal, SESSION_RENEW_MODAL_OPEN_EVENT } from './SessionRenewModal';
import { EmissionGaugeMini } from '@/components/lobby/EmissionGauge';
import { RAW_YIELD_NAME } from '@/lib/jackpot-format';
import { POKER_MINT } from '@/lib/constants';
import { hasUserRpc, isPoolForced, getRequestLevel, type RequestLevel } from '@/lib/user-config';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import type { HealthStatus } from '@/lib/system-health';

// Compact request-level label for the footer RPC chip.
const LEVEL_SHORT: Record<RequestLevel, string> = { mvr: 'MIN', higher: 'HIGH', full: 'FULL' };
// RPC health → dot color. Green healthy, amber flapping/failover, red unreachable.
const RPC_DOT: Record<HealthStatus, string> = {
  ok: 'bg-emerald-400',
  degraded: 'bg-amber',
  down: 'bg-red-500',
};

interface EcoStatProps {
  label: string;
  value: string;
  tone?: 'bone' | 'amber' | 'orange';
  className?: string;
}

function EcoStat({ label, value, tone = 'bone', className }: EcoStatProps) {
  const color = tone === 'amber' ? 'text-amber' : tone === 'orange' ? 'text-orange' : 'text-bone';
  return (
    <div className={cn('flex items-baseline gap-1', className)} title={`${label}: ${value} $FP`}>
      <span className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em]">{label}</span>
      <span className={cn('font-mono text-[10px] tabular-nums', color)}>{value}</span>
    </div>
  );
}

interface PriceTickerProps {
  symbol: 'SOL' | 'FP';
  price: string;
  delta: string;
  up: boolean;
  placeholder?: boolean;
  /** External token info / charts page (e.g. Jupiter). Renders the ticker as a link. */
  href?: string;
}

function PriceTicker({ symbol, price, delta, up, placeholder, href }: PriceTickerProps) {
  const iconSrc = symbol === 'SOL' ? '/tokens/sol.svg' : '/brand/app-icon.png';
  const body = (
    <>
      <Image
        src={iconSrc}
        alt={symbol === 'SOL' ? 'SOL' : '$FP'}
        width={14}
        height={14}
        className={cn('rounded-full', placeholder && 'opacity-70')}
      />
      <span className={cn('font-mono text-[10px] tabular-nums', placeholder ? 'text-bone/55' : 'text-bone')}>
        {price}
      </span>
      {!placeholder && delta && (
        <span className={cn('font-mono text-[9px] tabular-nums', up ? 'text-emerald-400' : 'text-orange')}>
          {up ? '▲' : '▼'}{delta}
        </span>
      )}
    </>
  );
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={`$${symbol} charts and token info`}
        className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
      >
        {body}
      </a>
    );
  }
  return <div className="flex items-center gap-1.5">{body}</div>;
}

function fmtFp(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function shortWallet(addr?: string): string {
  if (!addr) return '-';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function FooterStrip() {
  const { isConnected: connected, publicKey } = useUnifiedWallet();
  const [sessionHover, setSessionHover] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  // Any deep flow can pop the TEE auth modal by dispatching events from
  // SessionModal.tsx / SessionRenewModal.tsx. Used when quick-play /
  // game-join / claim hits ensurePlayerAuth() === false so the user can
  // authorize without hunting for the panel.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const openFull = () => setSessionOpen(true);
    const openRenew = () => setRenewOpen(true);
    window.addEventListener(SESSION_MODAL_OPEN_EVENT, openFull);
    window.addEventListener(SESSION_RENEW_MODAL_OPEN_EVENT, openRenew);
    return () => {
      window.removeEventListener(SESSION_MODAL_OPEN_EVENT, openFull);
      window.removeEventListener(SESSION_RENEW_MODAL_OPEN_EVENT, openRenew);
    };
  }, []);
  const claimBtnRef = useRef<HTMLButtonElement>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimRect, setClaimRect] = useState<DOMRect | null>(null);

  // RPC chip state. Read from localStorage after mount (not during render) so
  // the server-rendered markup matches the first client paint. Settings saves
  // reload the page, so a one-shot read is enough — no live subscription.
  // Truthful provider label: forced free pool, a custom endpoint, the build's
  // host default (e.g. env Helius), or the free pool when nothing's configured.
  const [rpcLabel, setRpcLabel] = useState('free pool');
  const [reqLevel, setReqLevel] = useState<RequestLevel>('mvr');
  useEffect(() => {
    const envRpc = (process.env.NEXT_PUBLIC_L1_RPC_URL || '').trim();
    const envSet = !!envRpc;
    const isServerRpc = envRpc === '/rpc' || envRpc.startsWith('/rpc/');
    setRpcLabel(
      isPoolForced()
        ? 'free pool'
        : hasUserRpc()
          ? 'your endpoint'
          : envSet
            ? isServerRpc ? 'server RPC' : 'host default'
            : 'free pool',
    );
    setReqLevel(getRequestLevel());
  }, []);
  const rpcStatus = useSystemHealth().rpc.status;

  const { solPrice, solChange24h, fpPrice, fpChange24h, fpIsLive, fpIndicative } = usePrices();
  const supply = usePokerSupply();
  const pool = usePoolHealth();
  // CIRC = live SPL mint supply; BURNED = live stake-pool total.
  // Raw Yield = global total_unrefined from Steel Pool PDA (byte offset 144).
  const eco = useMemo(() => ({
    fpCirculating: supply.wholeSupply,
    fpUnrefined: pool.totalUnrefined,
    fpBurned: pool.totalPoolStaked,
    supplyLoading: supply.loading,
    poolLoading: pool.loading,
    solPrice,
    fpPrice,
  }), [supply.wholeSupply, supply.loading, pool.totalPoolStaked, pool.totalUnrefined, pool.loading, solPrice, fpPrice]);

  const walletLabel = connected ? shortWallet(publicKey?.toBase58()) : 'CONNECT';

  const { totals: baseTotals, hasClaimable: hasClaimableRaw, onClaim: onClaimableAction } = useClaimableTotals();
  const claimable = useMemo(() => ({
    ...baseTotals,
    solPrice: eco.solPrice,
    fpPrice: eco.fpPrice,
  }), [baseTotals, eco.solPrice, eco.fpPrice]);
  const claimableSol = claimable.sngSol + claimable.stakingSol;
  const claimablePoker = claimable.pokerUnrefined + claimable.pokerRefined;
  const hasClaimable = connected && hasClaimableRaw;

  const openClaim = () => {
    if (claimBtnRef.current) setClaimRect(claimBtnRef.current.getBoundingClientRect());
    setClaimOpen(true);
  };

  return (
    <div
      className="block sticky bottom-0 z-20 bg-ink/85 backdrop-blur-xl [@media(orientation:landscape)_and_(max-height:500px)]:hidden"
      style={{ borderTop: '1px solid rgba(242,106,31,0.12)' }}
    >
      <div className="max-w-[1440px] mx-auto px-3 md:px-5 h-10 flex items-center justify-between gap-2 md:gap-4">
        {/* LEFT: session + wallet + claimable */}
        <div className="flex items-center gap-3 md:gap-4 min-w-0">
          <button
            onMouseEnter={() => setSessionHover(true)}
            onMouseLeave={() => setSessionHover(false)}
            onClick={() => setSessionOpen(true)}
            className="flex items-center gap-1.5 hover:text-bone group shrink-0"
            title="Open session status"
          >
            <span
              className={cn(
                'inline-block w-1.5 h-1.5 rounded-full',
                connected ? 'bg-emerald-400' : 'bg-boneDim/40',
              )}
            />
            <span className="font-mono text-[10px] text-boneDim group-hover:text-bone tracking-wider">
              {connected ? 'SESSION · ACTIVE' : 'SESSION · IDLE'}
            </span>
            <span className="font-mono text-[9px] text-boneDim/50">↗</span>
          </button>

          <div className="h-3 w-px bg-orange/15 shrink-0" />

          <div
            className="flex items-center gap-1.5 font-mono text-[10px] tracking-wider shrink-0"
            title={publicKey?.toBase58()}
          >
            <span className="text-boneDim/55 uppercase">wallet</span>
            <span className={cn(
              'tabular-nums',
              connected ? 'text-bone' : 'text-boneDim/55',
            )}>{walletLabel}</span>
          </div>

          {connected && (
            <>
              <div className="h-3 w-px bg-orange/15 shrink-0 hidden lg:block" />
              <button
                ref={claimBtnRef}
                onClick={openClaim}
                className={cn(
                  'relative hidden lg:flex items-center gap-1.5 group px-1.5 py-[3px] rounded-sm transition',
                  claimOpen
                    ? 'bg-emerald-400/10 border border-emerald-400/40'
                    : hasClaimable
                      ? 'hover:bg-emerald-400/5 border border-emerald-400/25'
                      : 'border border-transparent opacity-70 hover:opacity-100',
                )}
                title="Claimable SOL + $FP across SNG and staking"
              >
                {hasClaimable && (
                  <span className="absolute -top-1 -right-1 flex items-center justify-center">
                    <span className="absolute w-3 h-3 rounded-full bg-emerald-400/40 animate-ping" />
                    <span className="relative w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 6px rgba(52,211,153,0.9)' }} />
                  </span>
                )}
                <svg className="w-3 h-3 text-emerald-400 group-hover:scale-110 transition" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M3 8l3 3 7-7" />
                </svg>
                <span className="font-mono text-[10px] text-boneDim group-hover:text-bone tracking-wider">CLAIMABLE</span>
                <span className="flex items-center gap-1">
                  <Image src="/tokens/sol.svg" alt="SOL" width={11} height={11} className="rounded-full" />
                  <span className="font-mono text-[10px] text-emerald-300 tabular-nums">{claimableSol.toFixed(3)}</span>
                </span>
                <span className="flex items-center gap-1">
                  <Image src="/brand/app-icon.png" alt="$FP" width={11} height={11} className="rounded-full" />
                  <span className="font-mono text-[10px] text-amber tabular-nums">{claimablePoker.toFixed(0)}</span>
                </span>
              </button>
            </>
          )}
        </div>

        {/* RIGHT: supply stats + prices + version */}
        <div className="flex items-center gap-3.5 shrink-0">
          <EcoStat label="CIRC" value={eco.supplyLoading ? '--' : fmtFp(eco.fpCirculating)} tone="bone" className="hidden xl:flex" />
          <EcoStat label={RAW_YIELD_NAME.toUpperCase()} value={eco.poolLoading ? '--' : fmtFp(eco.fpUnrefined)} tone="amber" className="hidden xl:flex" />
          <EcoStat label="BURNED" value={eco.poolLoading ? '--' : fmtFp(eco.fpBurned)} tone="orange" className="hidden xl:flex" />
          <div className="h-3 w-px bg-orange/15 hidden xl:block" />

          <div className="hidden xl:flex">
            <EmissionGaugeMini circulatingSupply={eco.fpCirculating} />
          </div>
          <div className="h-3 w-px bg-orange/15 hidden xl:block" />

          <div className="hidden md:flex items-center gap-3.5">
            <PriceTicker
              symbol="SOL"
              price={eco.solPrice > 0 ? `$${eco.solPrice.toFixed(2)}` : '...'}
              delta={eco.solPrice > 0 ? `${solChange24h >= 0 ? '+' : ''}${solChange24h.toFixed(2)}%` : ''}
              up={solChange24h >= 0}
              placeholder={eco.solPrice <= 0}
            />
            <div className="h-3 w-px bg-orange/15" />
            <PriceTicker
              symbol="FP"
              // `~` marks an indicative quote (only thin-pool liquidity); its 24h
              // change is meaningless so we suppress the delta in that case.
              price={fpIsLive ? `${fpIndicative ? '~' : ''}$${eco.fpPrice.toFixed(2)}` : 'soon'}
              delta={fpIsLive && !fpIndicative ? `${fpChange24h >= 0 ? '+' : ''}${fpChange24h.toFixed(2)}%` : ''}
              up={fpChange24h >= 0}
              placeholder={!fpIsLive}
              href={`https://jup.ag/tokens/${POKER_MINT.toBase58()}`}
            />
          </div>

          <span className="font-mono text-[9px] text-boneDim/50 tracking-wider hidden lg:inline">
            {process.env.NEXT_PUBLIC_SOLANA_CLUSTER || 'devnet'}
          </span>

          <div className="h-3 w-px bg-orange/15 hidden md:block" />

          {/* RPC control. The dot is a live health check (green ok / amber
              flapping / red unreachable) from the 'rpc' system-health channel;
              the chip shows the request level. Tooltip carries provenance
              (your endpoint vs free pool). Opens RpcSettings. */}
          <button
            onClick={() => window.dispatchEvent(new Event('fp:open-rpc-settings'))}
            className="flex items-center gap-1.5 group shrink-0"
            title={`RPC ${rpcStatus.toUpperCase()} · ${rpcLabel} · ${LEVEL_SHORT[reqLevel]} requests`}
          >
            <span className={cn('inline-block w-1.5 h-1.5 rounded-full', RPC_DOT[rpcStatus], rpcStatus === 'down' && 'animate-pulse')} />
            <span className="font-mono text-[10px] text-boneDim group-hover:text-bone tracking-wider">RPC</span>
            <span className="font-mono text-[9px] text-orange/70 tracking-[0.14em]">{LEVEL_SHORT[reqLevel]}</span>
          </button>
        </div>
      </div>

      {sessionHover && (
        <div className="absolute left-4 bottom-11 glass-pop hairline rounded-md px-3 py-2 text-[10px] font-mono text-boneDim/80 tracking-wide pointer-events-none fade-in">
          {connected ? 'TEE attested · validator live' : 'Connect a wallet to open a session'}
        </div>
      )}

      <ClaimableDropdown
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        anchorRect={claimRect}
        align="left"
        totals={claimable}
        onClaim={onClaimableAction}
      />

      <SessionModal open={sessionOpen} onClose={() => setSessionOpen(false)} />
      <SessionRenewModal open={renewOpen} onClose={() => setRenewOpen(false)} />
    </div>
  );
}
