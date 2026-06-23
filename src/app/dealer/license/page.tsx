'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { PublicKey, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Link from 'next/link';

import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { useConnectModal } from '@/components/wallet/FastPokerConnectModal';
import { sendWalletTx } from '@/lib/send-wallet-tx';
import { applyPriorityFee } from '@/lib/priority-fee';
import { confirmFundsAction } from '@/lib/funds-confirmation';
import { ConsentModal, DealerConsentBody } from '@/components/legal/ConsentModal';
import { SFX } from '@/lib/sfx';
import { BRAND } from '@/lib/branding';
import {
  makeL1Connection,
  IS_MAINNET,
  FASTPOKER_REGISTRY_PROGRAM_ID,
  DEALER_LICENSE_BASE_PRICE,
  DEALER_LICENSE_FREE_RESERVE,
  DEALER_LICENSE_INCREMENT,
  DEALER_LICENSE_MAX_PRICE,
  DEALER_LICENSE_TOTAL_SUPPLY,
} from '@/lib/constants';
import {
  buildPurchaseLicenseIx,
  calcLicensePrice,
  getLicensePda,
  getRegistryPda,
  isDealerLicenseSaleOpen,
  parseLicense,
  parseRegistry,
  LICENSE_NUMBER_OFFSET,
  type DealerLicenseView,
  type DealerRegistryView,
} from '@/lib/dealer-license';

const PROGRAM_ID = FASTPOKER_REGISTRY_PROGRAM_ID;

// Per-license artwork lives on Arweave — the same image the on-chain NFT metadata
// points at — so licenses render correctly with no bundled files and on any host
// (static / IPFS included). License N -> FP_<4-digit>.jpg. Falls back to a bundled
// brand image only if Arweave is unreachable or the license number isn't known yet.
const LICENSE_ART_BASE = 'https://arweave.net/dLf9Ut-KgCyEbKEMuLe-pzgG3ijngxjNy0hwk9sr-hU';
const LICENSE_ART_FALLBACK = '/brand/dealer_lic.png';

function licenseArtUrl(licenseNumber: number | null | undefined): string {
  if (licenseNumber == null || !Number.isFinite(licenseNumber)) return LICENSE_ART_FALLBACK;
  return `${LICENSE_ART_BASE}/FP_${String(licenseNumber).padStart(4, '0')}.jpg`;
}

// Loads the Arweave license art; swaps to the bundled fallback once if it fails
// (guarded against an onError loop).
function LicenseArt({ licenseNumber, alt, className }: { licenseNumber: number | null | undefined; alt: string; className: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={licenseArtUrl(licenseNumber)}
      alt={alt}
      className={className}
      onError={(e) => {
        const img = e.currentTarget;
        if (img.dataset.fb !== '1') { img.dataset.fb = '1'; img.src = LICENSE_ART_FALLBACK; }
      }}
    />
  );
}

const FEE_BUFFER = 0.01;

function priceSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

function fmtSol(sol: number, dp = 3): string {
  return sol.toFixed(dp);
}

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function cx(...xs: (string | boolean | undefined | null)[]): string {
  return xs.filter(Boolean).join(' ');
}

function isDealerLicensePriceMovedError(message: string): boolean {
  return /DealerLicensePriceExceeded|price exceeds caller maximum|price exceeds/i.test(message) ||
    /custom program error:\s*0x1789/i.test(message) ||
    /Custom["']?\s*:\s*6025/i.test(message) ||
    /Custom:6025/i.test(message);
}

function describePurchaseError(error: unknown): string {
  const message = (error as Error)?.message || String(error || 'Transaction failed');
  if (isDealerLicensePriceMovedError(message)) {
    return 'Price moved while you were confirming. Refresh and try again, or increase price protection.';
  }
  return message;
}

type RegistryState = DealerRegistryView;
type LicenseState = DealerLicenseView;

// Catmull-Rom -> cubic-bezier smoothing for the bonding-curve line.
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

// ─── Bonding Curve Chart (SVG) ───
function BondingCurveChart({ totalSold, height = 180 }: { totalSold: number; height?: number }) {
  const W = 640;
  const H = height;
  const pad = { top: 14, right: 16, bottom: 24, left: 48 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const N = 56;

  const curvePts = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= N; i++) {
      const sold = (i / N) * DEALER_LICENSE_TOTAL_SUPPLY;
      const price = calcLicensePrice(Math.floor(sold));
      const x = pad.left + (i / N) * chartW;
      const y = pad.top + chartH - ((price - DEALER_LICENSE_BASE_PRICE) / (DEALER_LICENSE_MAX_PRICE - DEALER_LICENSE_BASE_PRICE)) * chartH;
      pts.push({ x, y });
      if (price >= DEALER_LICENSE_MAX_PRICE) break;
    }
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartW, chartH]);

  const pathData = useMemo(() => smoothPath(curvePts), [curvePts]);

  const cursorPct = Math.min(totalSold / DEALER_LICENSE_TOTAL_SUPPLY, 1);
  const cursorX = pad.left + cursorPct * chartW;
  const currentPrice = calcLicensePrice(totalSold);
  const cursorY = pad.top + chartH - ((currentPrice - DEALER_LICENSE_BASE_PRICE) / (DEALER_LICENSE_MAX_PRICE - DEALER_LICENSE_BASE_PRICE)) * chartH;

  const fillD = useMemo(() => {
    const cutoff = Math.floor(cursorPct * N);
    const sub = curvePts.slice(0, cutoff + 1);
    sub.push({ x: cursorX, y: cursorY });
    const baseY = (pad.top + chartH).toFixed(1);
    return `${smoothPath(sub)} L${cursorX.toFixed(1)},${baseY} L${pad.left.toFixed(1)},${baseY} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curvePts, cursorX, cursorY, cursorPct]);

  const priceTicks = [0, 1, 2, 3, 4].map(
    (i) => DEALER_LICENSE_BASE_PRICE + (i / 4) * (DEALER_LICENSE_MAX_PRICE - DEALER_LICENSE_BASE_PRICE),
  );
  const soldTicks = [0, 2500, 5000, 7500, DEALER_LICENSE_TOTAL_SUPPLY];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="bcLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#F26A1F" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#FFC63A" />
        </linearGradient>
        <linearGradient id="bcFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F26A1F" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#F26A1F" stopOpacity="0" />
        </linearGradient>
      </defs>
      {priceTicks.map((p, i) => {
        const y = pad.top + chartH - ((p - DEALER_LICENSE_BASE_PRICE) / (DEALER_LICENSE_MAX_PRICE - DEALER_LICENSE_BASE_PRICE)) * chartH;
        return (
          <g key={`y${i}`}>
            <line x1={pad.left} y1={y} x2={W - pad.right} y2={y} stroke="rgba(242,106,31,0.08)" strokeWidth="0.5" />
            <text x={pad.left - 6} y={y + 3} textAnchor="end" fill="rgba(245,241,230,0.35)" fontSize="9" fontFamily="JetBrains Mono, monospace">{fmtSol(priceSol(p))}</text>
          </g>
        );
      })}
      {soldTicks.map((s, i) => {
        const x = pad.left + (s / DEALER_LICENSE_TOTAL_SUPPLY) * chartW;
        return (
          <g key={`x${i}`}>
            <line x1={x} y1={pad.top} x2={x} y2={pad.top + chartH} stroke="rgba(242,106,31,0.05)" strokeWidth="0.5" />
            <text x={x} y={pad.top + chartH + 14} textAnchor="middle" fill="rgba(245,241,230,0.35)" fontSize="9" fontFamily="JetBrains Mono, monospace">
              {s >= 1000 ? `${(s / 1000).toFixed(1)}k` : s}
            </text>
          </g>
        );
      })}
      <text x={pad.left - 38} y={pad.top - 4} fill="rgba(245,241,230,0.4)" fontSize="8" fontFamily="JetBrains Mono, monospace" letterSpacing="1">SOL</text>
      <text x={W - pad.right} y={H - 4} textAnchor="end" fill="rgba(245,241,230,0.4)" fontSize="8" fontFamily="JetBrains Mono, monospace" letterSpacing="1">LICENSES ISSUED</text>

      <line x1={pad.left} y1={pad.top} x2={W - pad.right} y2={pad.top} stroke="rgba(242,106,31,0.4)" strokeWidth="0.5" strokeDasharray="2 3" />
      <text x={W - pad.right - 2} y={pad.top + 9} textAnchor="end" fill="rgba(242,106,31,0.6)" fontSize="8" fontFamily="JetBrains Mono, monospace">CAP · {fmtSol(priceSol(DEALER_LICENSE_MAX_PRICE))} SOL</text>

      <path d={fillD} fill="url(#bcFill)" />
      <path d={pathData} fill="none" stroke="url(#bcLine)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

      <line x1={cursorX} y1={pad.top} x2={cursorX} y2={pad.top + chartH} stroke="rgba(245,241,230,0.25)" strokeDasharray="2 3" strokeWidth="0.5" />
      <circle cx={cursorX} cy={cursorY} r={4} fill="#FFC63A" stroke="#F26A1F" strokeWidth="1" />
      <circle cx={cursorX} cy={cursorY} r={9} fill="none" stroke="rgba(255,198,58,0.4)" strokeWidth="0.5">
        <animate attributeName="r" values="5;12;5" dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.6;0;0.6" dur="2s" repeatCount="indefinite" />
      </circle>

      <g transform={`translate(${Math.min(cursorX + 12, W - 140)}, ${Math.max(cursorY - 32, pad.top + 6)})`}>
        <rect x="0" y="0" width="130" height="34" rx="2" fill="#10141A" stroke="#F26A1F" strokeOpacity="0.5" strokeWidth="0.5" />
        <text x="8" y="13" fill="rgba(245,241,230,0.5)" fontSize="8" fontFamily="JetBrains Mono, monospace" letterSpacing="1.2">NEXT LICENSE</text>
        <text x="8" y="27" fill="#FFC63A" fontSize="13" fontFamily="JetBrains Mono, monospace" fontWeight="600">
          #{totalSold} · {fmtSol(priceSol(calcLicensePrice(totalSold)))} SOL
        </text>
      </g>
    </svg>
  );
}

// ─── Panel shell ───
function PanelShell({
  title,
  tag,
  tagAccent = 'orange',
  children,
}: {
  title: string;
  tag?: React.ReactNode;
  tagAccent?: 'orange' | 'emerald' | 'amber';
  children: React.ReactNode;
}) {
  const tagCls =
    tagAccent === 'emerald'
      ? 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30'
      : tagAccent === 'amber'
        ? 'bg-amber/10 text-amber border-amber/30'
        : 'bg-orange/10 text-orange border-orange/30';
  return (
    <div className="glass-room overflow-hidden">
      <div className="px-5 py-3 border-b border-orange/10 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-orange shrink-0" />
          <span className="font-display text-bone text-sm tracking-wide">{title}</span>
        </div>
        {tag && (
          <span className={cx('font-mono text-[9px] tracking-[0.18em] px-2 py-1 rounded-sm border shrink-0', tagCls)}>
            {tag}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── Stats strip ───
function StatsStrip({ registry }: { registry: RegistryState }) {
  const price = calcLicensePrice(registry.totalSold);
  const remaining = Math.max(0, DEALER_LICENSE_TOTAL_SUPPLY - registry.totalSold);
  const pct = (registry.totalSold / DEALER_LICENSE_TOTAL_SUPPLY) * 100;
  const revenueSol = registry.totalRevenue / LAMPORTS_PER_SOL;
  const saleOpen = isDealerLicenseSaleOpen(registry.totalSold);
  const saleComplete = registry.totalSold >= DEALER_LICENSE_TOTAL_SUPPLY;
  const freeLeft = Math.max(0, DEALER_LICENSE_FREE_RESERVE - registry.totalSold);
  const priceLabel = saleOpen ? `${fmtSol(priceSol(price))} SOL` : saleComplete ? 'SOLD OUT' : 'RESERVED';
  const priceSub = saleOpen
    ? `next: ${fmtSol(priceSol(calcLicensePrice(registry.totalSold + 1)))} SOL`
    : saleComplete
      ? 'paid supply sold out'
      : `${freeLeft} free left`;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-orange/10 rounded-sm overflow-hidden border border-orange/15">
      <StatCell label="LICENSES ISSUED" value={registry.totalSold.toLocaleString()} sub={`of ${DEALER_LICENSE_TOTAL_SUPPLY.toLocaleString()}`} accent="bone" />
      <StatCell label="CURRENT PRICE" value={priceLabel} sub={priceSub} accent="orange" />
      <StatCell label="TOTAL REVENUE" value={`${revenueSol.toFixed(2)} SOL`} sub="50% stakers · 50% Platform Fee" accent="emerald" />
      <StatCell label="CURVE PROGRESS" value={`${pct.toFixed(1)}%`} sub={`${remaining.toLocaleString()} left before cap`} accent="amber" />
    </div>
  );
}

function StatCell({
  label,
  value,
  sub,
  accent = 'bone',
}: {
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  accent?: 'bone' | 'orange' | 'emerald' | 'amber';
}) {
  const valueCls = {
    bone: 'text-bone',
    orange: 'text-orange',
    emerald: 'text-emerald-300',
    amber: 'text-amber',
  }[accent];
  return (
    <div className="bg-inkA px-4 py-3.5">
      <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em] mb-1">{label}</div>
      <div className={cx('font-display text-2xl leading-none tabular-nums tracking-wide', valueCls)}>{value}</div>
      <div className="font-mono text-[9px] text-boneDim/50 mt-1">{sub}</div>
    </div>
  );
}

// ─── What You Get ───
function WhatYouGet() {
  const items = [
    {
      k: '20% CASH RAKE POOL',
      v: 'The full 20% slice is split pro-rata across all licensed cranks, weighted by the actions your crank processes on user-created tables.',
      accent: 'amber',
    },
    {
      k: '45% SNG FEE POOL',
      v: 'Same pro-rata split for tournament entry fees. Cranks that process more deal/settle calls earn a larger share.',
      accent: 'emerald',
    },
    {
      k: 'NOT PASSIVE',
      v: 'Holding a license alone earns nothing. You must run a crank service · open-source, self-hosted · to accrue weight. That means your own VM/server, an RPC endpoint, and funds to cover priority fees and running costs.',
      accent: 'orange',
    },
    {
      k: 'ON-CHAIN ENFORCED',
      v: 'Current payout paths verify your license PDA before rewards move. Unlicensed operators get zero share.',
      accent: 'violet',
    },
  ] as const;

  const accentCls = (a: string) =>
    ({
      amber: 'text-amber bg-amber/5',
      emerald: 'text-emerald-300 bg-emerald-400/5',
      orange: 'text-orange bg-orange/5',
      violet: 'text-violet-300 bg-violet-400/5',
    }[a] ?? 'text-bone bg-white/5');

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {items.map((it) => (
        <div key={it.k} className="rounded-sm border border-white/[0.07] bg-inkA p-4 flex flex-col gap-2">
          <span className={cx('self-start font-display text-sm tracking-wide px-2 py-0.5 rounded-sm', accentCls(it.accent))}>
            {it.k}
          </span>
          <div className="font-mono text-[11px] text-boneDim/75 leading-relaxed">{it.v}</div>
        </div>
      ))}
    </div>
  );
}

// ─── How It Works ───
function HowItWorks() {
  const steps = [
    { n: '1', k: 'MINT', v: 'Buy a wallet-bound license at the current bonding curve price. License PDA is derived from the recipient wallet.' },
    { n: '2', k: 'CRANK', v: 'Set up a crank service (open source, self-hosted) that processes deal / settle / distribute actions across L1 + Ephemeral Rollup.' },
    { n: '3', k: 'ACCRUE', v: 'Your action count is tallied on-chain. Both TEE and L1 actions count; L1 actions count 2x (they cost real gas).' },
    { n: '4', k: 'DISTRIBUTE', v: 'Cash rake is claimed through the current pull-claim lane. SNG operator fees settle before the table resets.' },
  ];
  return (
    <div className="rounded-sm border border-white/[0.07] bg-inkA p-5">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {steps.map((s, i) => (
          <div key={s.n} className="relative">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-7 h-7 rounded-sm flex items-center justify-center font-display text-orange bg-orange/15 border border-orange/40">
                {s.n}
              </span>
              <span className="font-display text-bone text-sm tracking-wide">{s.k}</span>
            </div>
            <div className="font-mono text-[10px] text-boneDim/70 leading-relaxed">{s.v}</div>
            {i < steps.length - 1 && (
              <span className="hidden md:block absolute top-3.5 -right-2 text-orange/40 font-mono">
                &#x2192;
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── FAQ ───
function FAQ() {
  const items = [
    {
      q: 'Is there a time limit on the sale?',
      a: 'No time limit, but a fixed supply. There are 9,927 total licenses: license #0 plus 25 free reserved licenses, then 9,901 paid licenses. Paid pricing starts at 1 SOL, rises by 0.001 SOL per paid license, and caps at 10 SOL.',
    },
    {
      q: 'Can I transfer or sell my license?',
      a: 'Not during the sale. After all licenses are issued, active holders can wrap a license into an MPL Core NFT, transfer or sell it, and the new holder can burn it back into an active license.',
    },
    {
      q: 'Where does my SOL go?',
      a: 'When you buy, 50% goes to the staker pool and 50% to Platform Fee. No middlemen, enforced by the program.',
    },
    {
      q: 'How much can I earn?',
      a: 'Depends on table volume, competition, RPC quality, priority fees, and how many hands your service processes. Your operator dashboard shows your live costs, rewards, and claimable earnings.',
    },
    {
      q: 'Do I need to code to run a crank?',
      a: 'Run the crank/dealer service on your own machine or VM. Configure your operator wallet, RPCs, fee settings, and table filters from its dashboard.',
    },
    {
      q: 'Can the protocol revoke my license?',
      a: 'No mechanism exists to revoke licenses. They are PDAs owned by the program and stay in existence indefinitely.',
    },
  ];
  return (
    <div className="rounded-sm border border-white/[0.07] bg-inkA p-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
        {items.map((it, i) => (
          <div key={i}>
            <div className="flex items-start gap-2 mb-1">
              <span className="font-display text-orange/70 text-xs tabular-nums tracking-wider mt-0.5">
                Q{String(i + 1).padStart(2, '0')}
              </span>
              <div className="font-display text-bone text-sm leading-snug">{it.q}</div>
            </div>
            <div className="font-mono text-[10px] text-boneDim/65 leading-relaxed pl-8">{it.a}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DealerLicensePage() {
  const { publicKey, signTransaction, sendTransaction, isConnected: connected } = useUnifiedWallet();
  const { open: openConnect } = useConnectModal();
  const [registry, setRegistry] = useState<RegistryState | null>(null);
  const [ownLicense, setOwnLicense] = useState<LicenseState | null>(null);
  const [useCustom] = useState(false);
  const [customLicense] = useState<LicenseState | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [txSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [mintTermsAccepted, setMintTermsAccepted] = useState(false);
  const [showDealerConsent, setShowDealerConsent] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // ─── Bulk mint state (F1 design) ───
  // Max IXs per TX given the legacy Transaction byte budget (~10 fits in 1232).
  const BULK_MAX_PER_TX = 10;
  const [bulkText, setBulkText] = useState('');
  const [slippageBuffer, setSlippageBuffer] = useState(5);
  type BulkOutcome =
    | { type: 'idle' }
    | { type: 'success'; sig: string; mintedRows: { wallet: string; licenseNumber: number; pricePaid: number }[] }
    | { type: 'priceMoved'; newPriceLamports: number; previousAttemptCount: number };
  const [bulkOutcome, setBulkOutcome] = useState<BulkOutcome>({ type: 'idle' });
  const [mintingMore, setMintingMore] = useState(false);
  const showMintForm = !ownLicense || mintingMore;

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const conn = useMemo(() => makeL1Connection(), []);

  const loadRegistry = useCallback(async (): Promise<RegistryState | null> => {
    const [registryPda] = getRegistryPda();
    const info = await conn.getAccountInfo(registryPda);
    if (!info) return null;
    return parseRegistry(Buffer.from(info.data));
  }, [conn]);

  const fetchRegistry = useCallback(async () => {
    try {
      setRegistry(await loadRegistry());
    } catch (e) {
      console.error('Failed to fetch registry:', e);
      setRegistry(null);
    }
    setLoading(false);
  }, [loadRegistry]);

  const checkLicense = useCallback(
    async (wallet: PublicKey): Promise<LicenseState | null> => {
      try {
        const [pda] = getLicensePda(wallet);
        const info = await conn.getAccountInfo(pda);
        if (!info) return null;
        return parseLicense(Buffer.from(info.data));
      } catch {
        return null;
      }
    },
    [conn],
  );

  useEffect(() => {
    if (!publicKey) {
      setOwnLicense(null);
      setSolBalance(0);
      return;
    }
    (async () => {
      const [lic, bal] = await Promise.all([
        checkLicense(publicKey),
        conn.getBalance(publicKey).catch(() => 0),
      ]);
      setOwnLicense(lic);
      setSolBalance(bal);
    })();
  }, [publicKey, checkLicense, conn, registry]);

  useEffect(() => {
    fetchRegistry();
    const iv = setInterval(fetchRegistry, 10_000);
    return () => clearInterval(iv);
  }, [fetchRegistry]);

  const targetHasLicense = useCustom ? customLicense : ownLicense;
  void targetHasLicense;
  const currentPriceLamports = registry ? calcLicensePrice(registry.totalSold) : DEALER_LICENSE_BASE_PRICE;
  const saleOpen = registry ? isDealerLicenseSaleOpen(registry.totalSold) : false;
  const saleComplete = registry ? registry.totalSold >= DEALER_LICENSE_TOTAL_SUPPLY : false;
  const canAfford = solBalance / LAMPORTS_PER_SOL >= priceSol(currentPriceLamports) + FEE_BUFFER;

  // ─── Bulk mint computed (parse + dedupe + validate) ───
  const bulkParsed = useMemo(() => {
    const lines = bulkText.split(/\s|,|;/).map(s => s.trim()).filter(Boolean);
    const seen = new Set<string>();
    let invalid = 0;
    let duplicate = 0;
    const validUnique: string[] = [];
    for (const l of lines) {
      try {
        new PublicKey(l);
      } catch {
        invalid++;
        continue;
      }
      if (seen.has(l)) {
        duplicate++;
        continue;
      }
      seen.add(l);
      validUnique.push(l);
    }
    return { lines, validUnique, invalidCount: invalid, duplicateCount: duplicate };
  }, [bulkText]);

  const [recipientLicenseMap, setRecipientLicenseMap] = useState<Record<string, number | null>>({});
  const [checkingRecipients, setCheckingRecipients] = useState(false);

  const myAddress = publicKey?.toBase58() || '';
  const includesMe = !!myAddress && bulkParsed.validUnique.includes(myAddress);
  const startingLicenseNumber = registry?.totalSold ?? 0;
  const mintableCount = bulkParsed.validUnique.reduce((n, w) => {
    return n + (recipientLicenseMap[w] != null ? 0 : 1);
  }, 0);
  const bulkExpectedLamports = useMemo(() => {
    let sum = 0;
    for (let i = 0; i < mintableCount; i++) {
      sum += calcLicensePrice(startingLicenseNumber + i);
    }
    return sum;
  }, [mintableCount, startingLicenseNumber]);
  const bulkMaxLamports = useMemo(() => {
    let sum = 0;
    for (let i = 0; i < mintableCount; i++) {
      sum += calcLicensePrice(startingLicenseNumber + i + slippageBuffer);
    }
    return sum;
  }, [mintableCount, startingLicenseNumber, slippageBuffer]);
  const overBatchCap = mintableCount > BULK_MAX_PER_TX;
  const canAffordBulk = solBalance >= bulkMaxLamports + Math.ceil(FEE_BUFFER * LAMPORTS_PER_SOL);

  const addMyWallet = useCallback(() => {
    if (!myAddress || includesMe) return;
    const trimmed = bulkText.trim();
    setBulkText(trimmed ? `${trimmed}\n${myAddress}` : myAddress);
  }, [myAddress, includesMe, bulkText]);

  const removeWallet = useCallback((wallet: string) => {
    const filtered = bulkText.split(/[\s,;]+/).filter(s => s.trim() !== wallet && s.trim() !== '');
    setBulkText(filtered.join('\n'));
  }, [bulkText]);

  // ─── Live recipient-license pre-flight ───
  // For each unique valid recipient, batch-fetch the license PDA so we can flag
  // "ALREADY OWNS #N" inline. Uses getMultipleAccountsInfo (chunked under the
  // hood by the RPC layer) — single-account PDA reads, NOT a getProgramAccounts
  // scan — so it stays free-pool safe.
  useEffect(() => {
    const list = bulkParsed.validUnique;
    if (list.length === 0) {
      setRecipientLicenseMap({});
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setCheckingRecipients(true);
      try {
        const pdas = list.map(w => getLicensePda(new PublicKey(w))[0]);
        const accounts = await conn.getMultipleAccountsInfo(pdas);
        if (cancelled) return;
        const next: Record<string, number | null> = {};
        list.forEach((w, i) => {
          const acct = accounts[i];
          if (acct && acct.data.length >= LICENSE_NUMBER_OFFSET + 4) {
            next[w] = Buffer.from(acct.data).readUInt32LE(LICENSE_NUMBER_OFFSET);
          } else {
            next[w] = null;
          }
        });
        setRecipientLicenseMap(next);
      } catch {
        /* keep last results on transient errors */
      } finally {
        if (!cancelled) setCheckingRecipients(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bulkParsed.validUnique, conn]);

  const collidingRecipients = useMemo(
    () => bulkParsed.validUnique.filter(w => recipientLicenseMap[w] != null),
    [bulkParsed.validUnique, recipientLicenseMap],
  );
  const hasCollisions = collidingRecipients.length > 0;

  // ─── Bulk mint handler (F1) ───
  // Player-signed: the buyer's wallet signs one legacy Transaction with N
  // purchase_dealer_license IXs (price climbs +increment per mint, enforced
  // on-chain). No helper authority. Mirrors auctions/create tx flow:
  // getLatestBlockhashClient → applyPriorityFee → confirmFundsAction →
  // sendWalletTx → confirmTransaction.
  const handleBulkPurchase = useCallback(async () => {
    if (!publicKey || !signTransaction) return;
    if (bulkParsed.validUnique.length === 0) return;
    if (!mintTermsAccepted) {
      setError('Accept the Dealer License terms before minting.');
      return;
    }
    if (overBatchCap) {
      setError(`Batch capped at ${BULK_MAX_PER_TX} licenses per transaction. Remove some and try again.`);
      return;
    }
    setError(null);
    setBulkOutcome({ type: 'idle' });
    setPurchasing(true);

    try {
      const latestRegistry = await loadRegistry();
      if (!latestRegistry) throw new Error('Dealer registry is not initialized on-chain yet.');
      if (!isDealerLicenseSaleOpen(latestRegistry.totalSold)) {
        throw new Error(
          latestRegistry.totalSold < DEALER_LICENSE_FREE_RESERVE
            ? 'Paid sale is not open until the reserved/free licenses are issued.'
            : 'Dealer license paid supply is sold out.',
        );
      }
      setRegistry(latestRegistry);

      const recipientPks = bulkParsed.validUnique.map(s => new PublicKey(s));
      const existingChecks = await Promise.all(recipientPks.map(pk => checkLicense(pk).catch(() => null)));
      const collisions = existingChecks
        .map((lic, i) => (lic ? { wallet: bulkParsed.validUnique[i], licenseNumber: lic.licenseNumber } : null))
        .filter(Boolean) as { wallet: string; licenseNumber: number }[];
      if (collisions.length > 0) {
        const names = collisions.map(c => `${c.wallet.slice(0, 4)}…${c.wallet.slice(-4)} (#${c.licenseNumber})`).join(', ');
        throw new Error(`These wallets already hold licenses: ${names}. Remove them and try again.`);
      }

      const balance = await conn.getBalance(publicKey).catch(() => solBalance);
      setSolBalance(balance);
      let latestBulkMaxLamports = 0;
      for (let i = 0; i < recipientPks.length; i++) {
        latestBulkMaxLamports += calcLicensePrice(latestRegistry.totalSold + i + slippageBuffer);
      }

      const required = latestBulkMaxLamports + Math.ceil(FEE_BUFFER * LAMPORTS_PER_SOL);
      if (balance < required) {
        throw new Error(
          `Insufficient balance for price cap. Need ${fmtSol(required / LAMPORTS_PER_SOL, 4)} SOL ` +
          `(${fmtSol(latestBulkMaxLamports / LAMPORTS_PER_SOL, 4)} max + fee buffer). You have ${fmtSol(balance / LAMPORTS_PER_SOL, 4)}.`,
        );
      }

      // Build N IXs, one per recipient. The on-chain handler reads
      // registry.current_price() at IX execution time, so the per-IX climb is
      // automatic; we pass an ascending max_total_sold per IX as the cap.
      const tx = new Transaction();
      for (let i = 0; i < recipientPks.length; i++) {
        const beneficiary = recipientPks[i];
        const maxTotalSold = latestRegistry.totalSold + i + slippageBuffer;
        tx.add(buildPurchaseLicenseIx(publicKey, beneficiary, maxTotalSold));
      }
      tx.feePayer = publicKey;
      const latestBlockhash = await getLatestBlockhashClient(conn, 'confirmed');
      tx.recentBlockhash = latestBlockhash.blockhash;
      await applyPriorityFee(tx);

      if (!(await confirmFundsAction({
        title: 'Confirm Dealer License',
        action: recipientPks.length === 1
          ? (recipientPks[0].equals(publicKey) ? 'Purchase dealer license' : 'Purchase dealer license for another wallet')
          : `Purchase ${recipientPks.length} dealer licenses`,
        amount: `${fmtSol(bulkExpectedLamports / LAMPORTS_PER_SOL, 6).replace(/\.?0+$/, '')} SOL`,
        details: [
          `Recipients: ${recipientPks.length}`,
          `Max accepted total: ${fmtSol(latestBulkMaxLamports / LAMPORTS_PER_SOL, 6).replace(/\.?0+$/, '')} SOL`,
          'Payment split: 50% stakers / 50% Platform Fee (on-chain).',
        ],
        transaction: tx,
      }))) {
        return;
      }

      const sig = await sendWalletTx(tx, conn, { sendTransaction, signTransaction });
      await conn.confirmTransaction({ signature: sig, ...latestBlockhash }, 'confirmed');

      const mintedRows = await Promise.all(
        recipientPks.map(async (pk) => {
          const lic = await checkLicense(pk).catch(() => null);
          return {
            wallet: pk.toBase58(),
            licenseNumber: lic?.licenseNumber ?? 0,
            pricePaid: lic?.pricePaid ?? 0,
          };
        }),
      );

      SFX.play('tip-success');
      setBulkOutcome({ type: 'success', sig, mintedRows });
      setBulkText('');
      await fetchRegistry();
      if (recipientPks.some(pk => pk.equals(publicKey))) {
        const lic = await checkLicense(publicKey);
        setOwnLicense(lic);
      }
    } catch (e: unknown) {
      console.error('Bulk purchase failed:', e);
      const msg = (e as Error)?.message || 'Transaction failed';
      if (isDealerLicensePriceMovedError(msg) && registry) {
        const latest = await loadRegistry().catch(() => null);
        const newPrice = latest ? calcLicensePrice(latest.totalSold) : currentPriceLamports;
        if (latest) setRegistry(latest);
        setBulkOutcome({
          type: 'priceMoved',
          newPriceLamports: newPrice,
          previousAttemptCount: bulkParsed.validUnique.length,
        });
      } else {
        setError(describePurchaseError(e));
      }
    } finally {
      setPurchasing(false);
    }
  }, [
    publicKey, signTransaction, sendTransaction, bulkParsed.validUnique, bulkExpectedLamports,
    overBatchCap, conn, registry, currentPriceLamports, checkLicense, loadRegistry,
    fetchRegistry, solBalance, slippageBuffer, mintTermsAccepted,
  ]);

  // ─── Render ───
  return (
    <div className="min-h-screen bg-ink">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-orange/[0.05] rounded-full blur-[140px]" />
      </div>

      <div className="relative max-w-[1200px] mx-auto px-5 py-5 pb-16 space-y-4">
        {/* Hero */}
        <div className="relative overflow-hidden rounded-sm border border-white/[0.07] bg-inkA">
          <div
            className="absolute inset-0 pointer-events-none opacity-60"
            style={{ background: 'radial-gradient(ellipse at right, rgb(var(--brand-primary)/0.18), transparent 60%)' }}
          />
          <div className="relative">
            <div className="p-5 lg:p-6 flex flex-col lg:flex-row items-stretch gap-4">
              <div className="shrink-0 flex flex-col justify-center">
                <div className="self-start inline-flex items-center gap-2 px-2.5 py-1 rounded-sm border border-orange/30 bg-orange/10 mb-4">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange animate-pulse" />
                  <span className="font-mono text-[9px] text-orange tracking-[0.22em]">NOW MINTING</span>
                </div>
                <h1 className="font-display text-bone text-5xl lg:text-6xl leading-[0.92] tracking-wide">
                  DEAL<br />
                  <span className="italic text-orange">TO EARN</span>
                </h1>
                <p className="font-mono text-[11px] text-boneDim/75 mt-4 max-w-md leading-relaxed">
                  A wallet-bound operator license for the {BRAND.name} network. Run a crank
                  service and earn your share of{' '}
                  <span className="text-amber">20% cash rake</span> and{' '}
                  <span className="text-emerald-300">45% SNG fees</span>.
                  Permissionless. Operator-controlled after sellout.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {['SPL-TOKEN-AGNOSTIC', 'PDA-SEALED', 'OPERATOR-CONTROLLED'].map((chip) => (
                    <span
                      key={chip}
                      className="font-mono text-[9px] tracking-[0.22em] text-orange/80 px-2 py-1 rounded-sm bg-orange/5 border border-orange/25"
                    >
                      {chip}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex-1 min-w-0 self-stretch flex items-center min-h-[140px]">
                <LicenseArt
                  licenseNumber={ownLicense?.licenseNumber ?? registry?.totalSold ?? null}
                  alt="Dealer License"
                  className="w-full max-h-[320px] object-contain"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Stats strip */}
        {registry && <StatsStrip registry={registry} />}

        {/* Loading */}
        {loading && (
          <div className="text-center py-12">
            <div className="inline-block w-5 h-5 border-2 border-orange/30 border-t-orange rounded-full animate-spin" />
            <p className="font-mono text-[11px] text-boneDim/60 tracking-wider mt-3">LOADING REGISTRY...</p>
          </div>
        )}

        {/* Registry not initialized */}
        {!loading && !registry && (
          <div className="rounded-sm border border-amber/20 bg-amber/[0.04] p-6 text-center">
            <div className="font-display text-amber text-xl tracking-wide leading-none mb-2">REGISTRY NOT INITIALIZED</div>
            <p className="font-mono text-[11px] text-boneDim/70 leading-relaxed">
              The Dealer Registry has not been created yet, or this RPC could not read it.
              An admin needs to call{' '}
              <code className="text-[10px] bg-white/[0.06] px-1.5 py-0.5 rounded text-orange">
                init_dealer_registry
              </code>{' '}
              first. If you are on the free public RPC, try your own endpoint.
            </p>
          </div>
        )}

        {/* Main 2-col layout */}
        {registry && (
          <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-4">
            {/* Left: Purchase + What You Get + How It Works */}
            <div className="space-y-4">
              <PanelShell
                title="PURCHASE A LICENSE"
                tag={ownLicense ? `LICENSE #${ownLicense.licenseNumber}` : txSig ? 'CONFIRMED' : saleOpen ? `LICENSE #${registry.totalSold}` : saleComplete ? 'SOLD OUT' : 'RESERVED'}
                tagAccent={ownLicense || txSig ? 'emerald' : 'orange'}
              >
                <div className="p-5 space-y-4">
                  {!connected ? (
                    <div className="flex flex-col items-center gap-4 py-6 text-center">
                      <svg className="w-10 h-10 text-orange/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="3" y="7" width="18" height="12" rx="2" />
                        <path d="M3 11h18M7 15h4" />
                        <circle cx="17" cy="15" r="1" fill="currentColor" />
                      </svg>
                      <div>
                        <div className="font-display text-bone text-lg tracking-wide">Connect your wallet</div>
                        <div className="font-mono text-[10px] text-boneDim/60 mt-1 max-w-sm leading-relaxed">
                          Any Solana wallet. You will sign one transaction to purchase.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={openConnect}
                        className="btn-orange px-5 py-2.5 rounded-sm font-display text-base tracking-wide"
                      >
                        CONNECT WALLET
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div id="dealer-license-purchase-layout" className="flex flex-col sm:flex-row gap-4 sm:items-start">
                        {/* Per-license art from Arweave (same image the NFT metadata points at) */}
                        <div className="shrink-0 w-full aspect-square sm:w-[190px] sm:aspect-auto sm:h-[190px]">
                          <LicenseArt
                            licenseNumber={ownLicense?.licenseNumber ?? registry?.totalSold ?? null}
                            alt={ownLicense ? `Dealer License #${ownLicense.licenseNumber}` : 'Next dealer license to mint'}
                            className="w-full h-full object-cover rounded-sm border border-orange/25 shadow-[0_4px_18px_rgba(242,106,31,0.2)]"
                          />
                        </div>
                        <div className="flex-1 min-w-0 space-y-4">
                          {/* Wallet identity row */}
                          <div className="flex items-center gap-3 px-3.5 py-2.5 glass-sub rounded-sm">
                            <div className="w-8 h-8 rounded-sm bg-gradient-to-br from-orange/30 to-amber/30 border border-orange/40 flex items-center justify-center font-display text-orange text-xs">
                              {publicKey?.toBase58().slice(0, 2).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em]">CONNECTED</div>
                              <div className="font-mono text-[10px] text-bone truncate">{publicKey?.toBase58()}</div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em]">BALANCE</div>
                              <div className={cx('font-mono text-[11px] tabular-nums', canAfford ? 'text-bone' : 'text-rose-400')}>
                                {(solBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL
                              </div>
                            </div>
                          </div>

                          {/* Already owns - docs view */}
                          {ownLicense && !mintingMore && (
                            <div className="glass-sub p-3 space-y-2">
                              <div className="flex items-baseline justify-between">
                                <span className="font-display text-bone text-sm tracking-wide">RUN YOUR CRANK</span>
                                <span className="font-mono text-[9px] tracking-[0.22em] text-emerald-300/80">LIVE</span>
                              </div>
                              <p className="font-mono text-[10px] text-boneDim/75 leading-relaxed">
                                Your license is active. Run a crank service that signs hand-processing IXs for tables on the network; configure your RPC + operator wallet and the dealer starts picking up work.
                              </p>
                              <a
                                href={BRAND.social.docs}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block text-center py-2 rounded-sm border border-white/[0.06] bg-inkB hover:bg-ink font-mono text-[10px] tracking-[0.22em] text-boneDim/70 hover:text-bone transition"
                              >
                                CRANK DOCS &#x2197;
                              </a>
                            </div>
                          )}

                          {/* Buy flow */}
                          {showMintForm && bulkOutcome.type === 'idle' && (
                            <>
                              {ownLicense && mintingMore && (
                                <button
                                  onClick={() => setMintingMore(false)}
                                  className="inline-flex items-center gap-1 font-mono text-[9px] tracking-[0.18em] text-boneDim/70 hover:text-bone transition"
                                >
                                  ‹ BACK TO MY LICENSE
                                </button>
                              )}
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-[9px] tracking-[0.22em] text-boneDim min-w-0 truncate">RECIPIENTS · paste public keys</span>
                                <button
                                  onClick={addMyWallet}
                                  disabled={includesMe}
                                  className={cx(
                                    'font-mono text-[9px] tracking-[0.16em] px-3 py-1.5 rounded-sm shrink-0 whitespace-nowrap',
                                    includesMe
                                      ? 'border border-emerald-400/40 bg-emerald-400/[0.06] text-emerald-300/70 cursor-default'
                                      : 'btn-orange',
                                  )}
                                >
                                  {includesMe ? '✓ YOU INCLUDED' : '+ ADD MY WALLET'}
                                </button>
                              </div>

                              <textarea
                                ref={textareaRef}
                                value={bulkText}
                                onChange={e => setBulkText(e.target.value)}
                                placeholder={`Paste one public key per line`}
                                rows={4}
                                className={cx(
                                  'w-full px-2.5 py-2 font-mono text-[10px] text-bone placeholder:text-boneDim/30 outline-none resize-none rounded-sm border bg-black/40 backdrop-blur-sm transition-colors',
                                  bulkParsed.validUnique.length === 0 ? 'border-orange' : 'border-orange/20',
                                )}
                              />
                            </>
                          )}
                        </div>
                      </div>

                      {/* Mint more */}
                      {ownLicense && !mintingMore && (
                        <button
                          onClick={() => setMintingMore(true)}
                          className="btn-orange w-full py-3 rounded-sm font-display text-base tracking-[0.18em] font-bold"
                        >
                          MINT MORE LICENSES
                        </button>
                      )}

                      {/* Per-row preview list */}
                      {showMintForm && bulkOutcome.type === 'idle' && bulkParsed.validUnique.length > 0 && (
                        <div className="space-y-1 glass-sub p-2 max-h-56 overflow-auto">
                          <div className="flex items-center justify-between px-1">
                            <span className="font-mono text-[9px] tracking-[0.22em] text-boneDim/55">YOU WILL MINT</span>
                            {checkingRecipients && (
                              <span className="font-mono text-[9px] text-boneDim/45 tracking-[0.16em]">CHECKING…</span>
                            )}
                          </div>
                          {(() => {
                            let lane = 0;
                            return bulkParsed.validUnique.map((p, i) => {
                              const isMe = p === myAddress;
                              const existingLic = recipientLicenseMap[p];
                              const collides = existingLic != null;
                              let licenseNumber: number | null = null;
                              let priceLamports = 0;
                              if (!collides) {
                                licenseNumber = startingLicenseNumber + lane;
                                priceLamports = calcLicensePrice(licenseNumber);
                                lane++;
                              }
                              return (
                                <div
                                  key={`${p}-${i}`}
                                  className={cx(
                                    'flex items-center justify-between px-2 py-1 rounded-sm font-mono text-[10px]',
                                    collides ? 'bg-rose-500/[0.08] border border-rose-400/30'
                                      : isMe ? 'bg-orange/[0.08] border border-orange/30'
                                        : 'bg-bone/[0.02]',
                                  )}
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    {isMe && <span className={cx('text-[9px] tracking-[0.18em] font-bold', collides ? 'text-rose-300/80' : 'text-orange/80')}>YOU</span>}
                                    <span className={cx('truncate', collides ? 'text-rose-200/80 line-through' : isMe ? 'text-bone' : 'text-emerald-200')}>{shortAddr(p)}</span>
                                  </div>
                                  <div className="flex items-center gap-3 shrink-0">
                                    {collides ? (
                                      <span className="text-rose-300 font-bold tracking-[0.14em]">ALREADY OWNS #{existingLic}</span>
                                    ) : (
                                      <>
                                        <span className="text-boneDim">#{licenseNumber}</span>
                                        <span className="text-bone">{fmtSol(priceSol(priceLamports))} SOL</span>
                                      </>
                                    )}
                                    <button
                                      onClick={() => removeWallet(p)}
                                      className="ml-1 w-4 h-4 flex items-center justify-center rounded-sm text-boneDim/40 hover:text-rose-300 hover:bg-rose-500/10 transition"
                                      aria-label="Remove wallet"
                                    >
                                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.6">
                                        <path d="M1 1l6 6M7 1L1 7" />
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      )}

                      {showMintForm && bulkOutcome.type === 'idle' && (
                        <>
                          <label className="flex items-start gap-2.5 rounded-sm border border-orange/20 bg-orange/[0.04] px-3 py-2.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={mintTermsAccepted}
                              onChange={() => {
                                if (mintTermsAccepted) setMintTermsAccepted(false);
                                else if (isMobile) setMintTermsAccepted(true);
                                else setShowDealerConsent(true);
                              }}
                              className="mt-0.5 h-4 w-4 accent-orange"
                            />
                            <span className="font-mono text-[10px] leading-snug text-boneDim/75">
                              I agree to the{' '}
                              <Link href="/terms" className="text-orange hover:text-orangeHi underline decoration-orange/30">
                                Terms of Service
                              </Link>
                              {' '}and understand Dealer License mint payments split 50% to stakers and 50% to Platform Fee.
                            </span>
                          </label>
                          <ConsentModal
                            open={showDealerConsent}
                            onClose={() => setShowDealerConsent(false)}
                            onAccept={() => setMintTermsAccepted(true)}
                            title={`${BRAND.name} Dealer Operator: Read Before Registering`}
                            body={<DealerConsentBody />}
                            checkboxLabel={<>I have read, understood, and accept the <Link href="/terms" className="text-orange underline decoration-orange/30">Terms of Service</Link> and <Link href="/privacy" className="text-orange underline decoration-orange/30">Privacy Policy</Link>.</>}
                            acceptLabel="I ACCEPT"
                          />

                          {/* MINT button */}
                          <button
                            onClick={() => mintableCount === 0 ? textareaRef.current?.focus() : handleBulkPurchase()}
                            disabled={purchasing || !saleOpen || overBatchCap || hasCollisions || (!mintTermsAccepted && mintableCount > 0) || (!canAffordBulk && mintableCount > 0)}
                            className={cx(
                              'btn-orange w-full py-3 rounded-sm font-display text-base tracking-[0.18em] font-bold transition-opacity',
                              mintableCount === 0 && 'opacity-40',
                            )}
                          >
                            {purchasing ? (
                              <span className="flex items-center justify-center gap-2">
                                <span className="w-4 h-4 border-2 border-bone/30 border-t-bone/70 rounded-full animate-spin" />
                                <span>MINTING…</span>
                              </span>
                            ) : saleComplete ? (
                              'SOLD OUT'
                            ) : !saleOpen ? (
                              'SALE NOT OPEN'
                            ) : mintableCount === 0 ? (
                              'PASTE WALLET TO GET STARTED'
                            ) : !mintTermsAccepted ? (
                              'ACCEPT TERMS TO MINT'
                            ) : hasCollisions ? (
                              'REMOVE LICENSED WALLETS FIRST'
                            ) : !canAffordBulk ? (
                              `INSUFFICIENT FUNDS · NEED ${fmtSol((bulkMaxLamports + FEE_BUFFER * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL, 3)} SOL`
                            ) : (
                              `MINT ${mintableCount} · ${fmtSol(bulkExpectedLamports / LAMPORTS_PER_SOL, 3)} SOL`
                            )}
                          </button>

                          {/* Price-protection slider */}
                          {bulkParsed.validUnique.length > 0 && (
                            <div className="space-y-1.5 px-2.5 py-2 rounded-sm border border-orange/25 bg-orange/[0.04]">
                              <div className="flex items-center justify-between">
                                <span className="font-mono text-[10px] tracking-[0.16em] text-orange/85">PRICE PROTECTION · +{slippageBuffer} mint{slippageBuffer === 1 ? '' : 's'}</span>
                                <span className="font-mono text-[10px] text-orange font-bold">MAX {fmtSol(bulkMaxLamports / LAMPORTS_PER_SOL, 3)} SOL</span>
                              </div>
                              <input
                                type="range"
                                min={0}
                                max={20}
                                value={slippageBuffer}
                                onChange={e => setSlippageBuffer(Number(e.target.value))}
                                className="w-full accent-orange"
                              />
                              <p className="font-mono text-[9px] text-orange/70 leading-snug">
                                On-chain max price protects against {slippageBuffer} other mint{slippageBuffer === 1 ? '' : 's'} landing first. If more land, the batch reverts cleanly and you re-sign at the new price.
                              </p>
                            </div>
                          )}

                          {/* Warnings */}
                          <div className="rounded-sm border border-orange/30 bg-orange/[0.04] p-3 space-y-1.5">
                            <div className="flex items-start gap-2 font-mono text-[10px] text-orange/90 leading-snug">
                              <svg className="w-3.5 h-3.5 shrink-0 mt-[1px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                                <line x1="12" y1="9" x2="12" y2="13" />
                                <line x1="12" y1="17" x2="12.01" y2="17" />
                              </svg>
                              <span>Paste <span className="font-bold">PUBLIC keys only</span>. Never paste a private key.</span>
                            </div>
                            <div className="flex items-start gap-2 font-mono text-[10px] text-orange/90 leading-snug">
                              <svg className="w-3.5 h-3.5 shrink-0 mt-[1px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                                <line x1="12" y1="9" x2="12" y2="13" />
                                <line x1="12" y1="17" x2="12.01" y2="17" />
                              </svg>
                              <span>Licenses are locked to the recipient wallet during the sale. Transfers unlock after all {DEALER_LICENSE_TOTAL_SUPPLY.toLocaleString()} are issued via MPL Core wrap - and require the holder&apos;s signature.</span>
                            </div>
                          </div>

                          {/* Invalid / duplicate counts */}
                          {(bulkParsed.invalidCount > 0 || bulkParsed.duplicateCount > 0) && (
                            <div className="space-y-1">
                              {bulkParsed.invalidCount > 0 && (
                                <div className="px-2.5 py-1.5 rounded-sm border border-rose-400/30 bg-rose-500/[0.05] font-mono text-[10px] text-rose-300">
                                  {bulkParsed.invalidCount} invalid line{bulkParsed.invalidCount === 1 ? '' : 's'} ignored. Each line must be a Base58 wallet address.
                                </div>
                              )}
                              {bulkParsed.duplicateCount > 0 && (
                                <div className="px-2.5 py-1.5 rounded-sm border border-orange/30 bg-orange/[0.06] font-mono text-[10px] text-orange">
                                  {bulkParsed.duplicateCount} duplicate{bulkParsed.duplicateCount === 1 ? '' : 's'} skipped. A wallet can only hold one license - repeats are dropped.
                                </div>
                              )}
                            </div>
                          )}

                          {/* Batch-cap warning */}
                          {overBatchCap && (
                            <div className="px-2.5 py-1.5 rounded-sm border border-orange/40 bg-orange/[0.08] font-mono text-[10px] text-orange">
                              Batch capped at {BULK_MAX_PER_TX} licenses per transaction. Remove some recipients or split into multiple batches.
                            </div>
                          )}

                          {/* Collision warning */}
                          {hasCollisions && (
                            <div className="px-2.5 py-1.5 rounded-sm border border-rose-400/30 bg-rose-500/[0.05] font-mono text-[10px] text-rose-300 leading-snug">
                              {collidingRecipients.length} recipient{collidingRecipients.length === 1 ? '' : 's'} already hold{collidingRecipients.length === 1 ? 's' : ''} a license. Remove the highlighted row{collidingRecipients.length === 1 ? '' : 's'} from the textarea to continue - each wallet can only hold one license.
                            </div>
                          )}

                          {/* Insufficient SOL hint */}
                          {mintableCount > 0 && !canAffordBulk && (
                            <div className="px-2.5 py-1.5 rounded-sm border border-rose-500/30 bg-rose-500/[0.05] font-mono text-[10px] text-rose-300">
                              Need {fmtSol((bulkMaxLamports + FEE_BUFFER * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL, 3)} SOL (max + fee). You have {(solBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL.
                            </div>
                          )}

                          {/* Split disclosure */}
                          <div className="pt-3 border-t border-orange/10">
                            <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em] mb-2">YOUR SOL IS SPLIT</div>
                            <div className="flex h-1.5 rounded-sm overflow-hidden mb-1.5">
                              <div style={{ width: '50%', background: '#34D399' }} />
                              <div style={{ width: '50%', background: '#A78BFA' }} />
                            </div>
                            <div className="flex justify-between font-mono text-[9px] text-boneDim/60">
                              <span><span className="text-emerald-300">50%</span> staker pool</span>
                              <span><span className="text-violet-300">50%</span> Platform Fee</span>
                            </div>
                          </div>
                        </>
                      )}

                      {/* Success state */}
                      {bulkOutcome.type === 'success' && (
                        <div className="space-y-3">
                          <div className="flex items-baseline justify-between">
                            <span className="font-display text-emerald-300 text-base tracking-wide">MINTED ✓</span>
                            <span className="font-mono text-[10px] text-emerald-300/70">
                              {bulkOutcome.mintedRows.length} / {bulkOutcome.mintedRows.length}
                            </span>
                          </div>
                          <div className="space-y-1 max-h-72 overflow-auto">
                            {bulkOutcome.mintedRows.map(row => {
                              const isMe = row.wallet === myAddress;
                              return (
                                <div
                                  key={row.wallet}
                                  className={cx(
                                    'flex items-center justify-between px-2 py-1.5 rounded-sm font-mono text-[10px]',
                                    isMe ? 'bg-emerald-500/[0.10] border border-emerald-400/35' : 'bg-emerald-500/[0.06] border border-emerald-400/25',
                                  )}
                                >
                                  <div className="flex flex-col min-w-0">
                                    <span className={cx(isMe ? 'text-orange font-bold' : 'text-emerald-200')}>
                                      {isMe ? 'YOU · ' : ''}{shortAddr(row.wallet)} · #{row.licenseNumber}
                                    </span>
                                  </div>
                                  <span className="text-bone">{fmtSol(row.pricePaid / LAMPORTS_PER_SOL, 3)} SOL</span>
                                </div>
                              );
                            })}
                          </div>
                          <div className="pt-2 border-t border-bone/10 flex justify-between font-mono text-[10px]">
                            <span className="text-boneDim">TOTAL PAID</span>
                            <span className="text-bone font-bold">
                              {fmtSol(bulkOutcome.mintedRows.reduce((s, r) => s + r.pricePaid, 0) / LAMPORTS_PER_SOL, 3)} SOL
                            </span>
                          </div>
                          <div className="flex gap-2">
                            <a
                              href={`https://explorer.solana.com/tx/${bulkOutcome.sig}${IS_MAINNET ? '' : '?cluster=devnet'}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-1 text-center py-2 rounded-sm border border-bone/15 font-mono text-[10px] tracking-[0.2em] text-boneDim hover:text-bone transition"
                            >
                              VIEW ON EXPLORER
                            </a>
                            <button
                              onClick={() => setBulkOutcome({ type: 'idle' })}
                              className="flex-1 py-2 rounded-sm border border-orange/40 bg-orange/10 hover:bg-orange/20 font-mono text-[10px] tracking-[0.2em] text-orange transition"
                            >
                              MINT MORE
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Price-moved state */}
                      {bulkOutcome.type === 'priceMoved' && (
                        <div className="space-y-3">
                          <div className="flex items-baseline justify-between">
                            <span className="font-display text-amber text-base tracking-wide">PRICE MOVED</span>
                            <span className="font-mono text-[10px] text-amber/70">BATCH REVERTED · 0 SOL SPENT</span>
                          </div>
                          <div className="px-2.5 py-2 rounded-sm bg-amber/[0.08] border border-amber/30 space-y-1.5 font-mono text-[10px] leading-snug">
                            <p className="text-amber">
                              Other mints landed between your sign and confirm. Your on-chain price cap was exceeded so the whole batch reverted with no licenses bought.
                            </p>
                            <p className="text-bone">
                              <span className="text-boneDim">NEW PRICE · </span>
                              <span className="font-bold">{fmtSol(bulkOutcome.newPriceLamports / LAMPORTS_PER_SOL, 3)} SOL</span>
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => setBulkOutcome({ type: 'idle' })}
                              className="flex-1 py-2 rounded-sm border border-bone/15 font-mono text-[10px] tracking-[0.2em] text-boneDim hover:text-bone"
                            >
                              EDIT LIST
                            </button>
                            <button
                              onClick={() => { setBulkOutcome({ type: 'idle' }); handleBulkPurchase(); }}
                              disabled={purchasing}
                              className="flex-1 py-2 rounded-sm border border-orange/60 bg-orange/20 hover:bg-orange/30 font-mono text-[10px] tracking-[0.2em] text-orange font-bold disabled:opacity-50"
                            >
                              RESIGN AT NEW PRICE
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Error */}
                      {error && (
                        <div className="rounded-sm border border-rose-500/30 bg-rose-500/[0.04] p-4">
                          <div className="font-display text-rose-300 text-sm tracking-wide mb-1">PURCHASE FAILED</div>
                          <p className="font-mono text-[10px] text-boneDim/70 break-all leading-relaxed">{error}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </PanelShell>

              <WhatYouGet />
              <HowItWorks />
            </div>

            {/* Right: Curve card + NFT transfer */}
            <div className="space-y-5">
              <PanelShell title="BONDING CURVE" tag={`CAP · ${fmtSol(priceSol(DEALER_LICENSE_MAX_PRICE))} SOL`} tagAccent="amber">
                <div className="p-4">
                  <BondingCurveChart totalSold={registry.totalSold} height={200} />

                  <div className="mt-4">
                    <div className="h-1.5 rounded-sm bg-white/[0.04] overflow-hidden">
                      <div
                        className="h-full rounded-sm bg-orange transition-all duration-700"
                        style={{ width: `${Math.min((registry.totalSold / DEALER_LICENSE_TOTAL_SUPPLY) * 100, 100)}%` }}
                      />
                    </div>
                    <div className="flex justify-between mt-1 font-mono text-[9px] text-boneDim/50">
                      <span>{fmtSol(priceSol(DEALER_LICENSE_BASE_PRICE), 4)} SOL</span>
                      <span>{registry.totalSold} / {DEALER_LICENSE_TOTAL_SUPPLY.toLocaleString()}</span>
                      <span>{fmtSol(priceSol(DEALER_LICENSE_MAX_PRICE))} SOL</span>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-sm bg-ink/40 border border-white/[0.04] p-2.5">
                      <div className="font-mono text-[9px] text-boneDim/55 tracking-wider">
                        {DEALER_LICENSE_INCREMENT === 0 ? 'DEV PRICE' : 'PER SALE'}
                      </div>
                      <div className="font-display text-orange text-sm mt-0.5">
                        {DEALER_LICENSE_INCREMENT === 0
                          ? `${fmtSol(priceSol(DEALER_LICENSE_BASE_PRICE), 5)} SOL`
                          : `+${fmtSol(priceSol(DEALER_LICENSE_INCREMENT))} SOL`}
                      </div>
                    </div>
                    <div className="rounded-sm bg-ink/40 border border-white/[0.04] p-2.5">
                      <div className="font-mono text-[9px] text-boneDim/55 tracking-wider">SPLIT</div>
                      <div className="font-display text-emerald-300 text-sm mt-0.5">50 / 50</div>
                    </div>
                  </div>
                </div>
              </PanelShell>

              {/* NFT Transfer (CONVERT TO NFT is gated: no wrap builder in onchain-game.ts) */}
              <PanelShell
                title="NFT TRANSFER"
                tag={!ownLicense ? 'NO LICENSE' : saleComplete ? 'UNLOCKED' : 'LOCKED'}
                tagAccent={!ownLicense ? 'orange' : saleComplete ? 'emerald' : 'amber'}
              >
                <div className="p-4 space-y-3">
                  {!ownLicense ? (
                    <>
                      <div className="text-center py-3 space-y-1">
                        <div className="font-display text-bone text-4xl tracking-wide">{(DEALER_LICENSE_TOTAL_SUPPLY - registry.totalSold).toLocaleString()}</div>
                        <div className="font-mono text-[10px] text-boneDim/70 tracking-[0.18em]">LICENSES UNTIL UNLOCK</div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between font-mono text-[9px] text-boneDim/45 mb-1">
                          <span>{registry.totalSold.toLocaleString()} sold</span>
                          <span>{((registry.totalSold / DEALER_LICENSE_TOTAL_SUPPLY) * 100).toFixed(1)}%</span>
                          <span>{DEALER_LICENSE_TOTAL_SUPPLY.toLocaleString()} total</span>
                        </div>
                        <div className="h-1.5 rounded-sm bg-ink/60 overflow-hidden">
                          <div className="h-full bg-bone/20" style={{ width: `${Math.min((registry.totalSold / DEALER_LICENSE_TOTAL_SUPPLY) * 100, 100)}%` }} />
                        </div>
                      </div>
                      <p className="font-mono text-[10px] text-boneDim/65 leading-relaxed">
                        Mint a license above first. Once you own one, you&apos;ll be able to transfer it (by converting to an NFT) after the sale completes.
                      </p>
                    </>
                  ) : !saleComplete ? (
                    <>
                      <div className="text-center py-3 space-y-1">
                        <div className="font-display text-bone text-4xl tracking-wide">{(DEALER_LICENSE_TOTAL_SUPPLY - registry.totalSold).toLocaleString()}</div>
                        <div className="font-mono text-[10px] text-boneDim/70 tracking-[0.18em]">LICENSES UNTIL UNLOCK</div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between font-mono text-[9px] text-boneDim/55 mb-1">
                          <span>{registry.totalSold.toLocaleString()} sold</span>
                          <span>{((registry.totalSold / DEALER_LICENSE_TOTAL_SUPPLY) * 100).toFixed(1)}%</span>
                          <span>{DEALER_LICENSE_TOTAL_SUPPLY.toLocaleString()} total</span>
                        </div>
                        <div className="h-2 rounded-sm bg-ink/60 overflow-hidden">
                          <div className="h-full bg-orange/75 transition-all" style={{ width: `${Math.min((registry.totalSold / DEALER_LICENSE_TOTAL_SUPPLY) * 100, 100)}%` }} />
                        </div>
                      </div>
                      <div className="px-2.5 py-2 glass-sub font-mono text-[10px] text-boneDim/70 leading-snug">
                        Your License <span className="text-bone">#{ownLicense.licenseNumber}</span> stays active and earns. To transfer it later you&apos;ll convert it to an NFT - that path opens the moment the last paid license is minted.
                      </div>
                      <button disabled className="w-full py-2.5 rounded-sm border border-bone/15 bg-bone/[0.04] font-mono text-[11px] tracking-[0.22em] text-boneDim/40 cursor-not-allowed">
                        UNLOCKS AT SELLOUT
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="flex items-baseline justify-between">
                        <span className="font-display text-emerald-300 text-base tracking-wide">UNLOCKED</span>
                        <span className="font-mono text-[10px] text-emerald-300/70 tracking-[0.18em]">{DEALER_LICENSE_TOTAL_SUPPLY.toLocaleString()} / {DEALER_LICENSE_TOTAL_SUPPLY.toLocaleString()}</span>
                      </div>
                      <p className="font-mono text-[10px] text-boneDim/75 leading-relaxed">
                        Converting License #{ownLicense.licenseNumber} to an NFT is how it&apos;s transferred - the registry license closes and a tradable NFT mints in its place. Earnings pause while it&apos;s an NFT; the buyer burns the NFT to restore an active license.
                      </p>
                      <div className="flex items-start gap-2 px-2.5 py-1.5 rounded-sm border border-amber/30 bg-amber/[0.08] font-mono text-[10px] text-amber leading-snug">
                        <svg className="w-3.5 h-3.5 shrink-0 mt-[1px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                          <line x1="12" y1="9" x2="12" y2="13" />
                          <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <span>Claim any pending rewards before converting - claims pause while the license is an NFT.</span>
                      </div>
                      <button
                        disabled
                        title="Convert-to-NFT requires the wrap instruction, which is not available in this standalone build."
                        className="w-full py-2.5 rounded-sm border border-orange/60 bg-orange/15 font-mono text-[11px] tracking-[0.22em] text-orange font-bold opacity-60 cursor-not-allowed"
                      >
                        CONVERT TO NFT
                      </button>
                    </>
                  )}
                </div>
              </PanelShell>
            </div>
          </div>
        )}

        {/* FAQ */}
        {registry && (
          <>
            <div>
              <div className="font-mono text-[9px] text-boneDim/50 tracking-[0.22em] mb-3">FAQ</div>
              <FAQ />
            </div>

            <div className="flex items-center justify-between px-1 pt-2 font-mono text-[9px] text-boneDim/35 tracking-wider">
              <span>program · {PROGRAM_ID.toBase58().slice(0, 8)}...{PROGRAM_ID.toBase58().slice(-8)}</span>
              <span>registry · read-only · refreshes every 10s</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
