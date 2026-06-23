'use client';

import { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import { LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { makeL1Connection, FASTPOKER_REGISTRY_PROGRAM_ID } from '@/lib/constants';
import { shouldUsePool } from '@/lib/rpc-pool';
import { BRAND } from '@/lib/branding';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { applyPriorityFee } from '@/lib/priority-fee';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { confirmFundsAction } from '@/lib/funds-confirmation';
import { sendWalletTx } from '@/lib/send-wallet-tx';
import {
  getCurrentAuctionEpoch,
  getAuctionEndTime,
  getAuctionPda,
  getAuctionConfigPda,
  parseAuctionConfig,
  parseGlobalTokenBid,
  parseAuctionRank,
  GLOBAL_BID_DATA_SIZE,
  AUCTION_RANK_DATA_SIZE,
  buildPlaceBidInstruction,
  getAuctionRankPda,
  getMultipleAccountsInfoChunked,
} from '@/lib/onchain-game';

// ─── Constants ───
const EPOCH_SECS = 259_200; // 3-day launch fallback
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// ─── Types ───

interface AuctionInfo {
  epoch: bigint;
  startTime: number;
  endTime: number;
  status: number; // 0=Active, 1=Resolved
  winningMint: string;
  totalBid: bigint;
  tokenCount: number;
}

interface GlobalBidInfo {
  tokenMint: string;
  totalAmount: bigint;
  bidderCount: number;
  firstBidAt: number;
}

// ─── Parsers ───

function parseAuction(data: Buffer): AuctionInfo | null {
  if (data.length < 76) return null;
  return {
    epoch: data.readBigUInt64LE(8),
    startTime: Number(data.readBigInt64LE(16)),
    endTime: Number(data.readBigInt64LE(24)),
    status: data[32],
    winningMint: new PublicKey(data.subarray(33, 65)).toBase58(),
    totalBid: data.readBigUInt64LE(65),
    tokenCount: data.readUInt16LE(73),
  };
}

// ─── Helpers ───

const ZERO_PUBKEY = PublicKey.default.toBase58();

function sortAuctionBids<T extends { tokenMint: string; totalAmount: bigint; firstBidAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.totalAmount !== b.totalAmount) return a.totalAmount > b.totalAmount ? -1 : 1;
    if (a.firstBidAt !== b.firstBidAt) return a.firstBidAt - b.firstBidAt;
    return getAuctionRankPda(new PublicKey(a.tokenMint))
      .toBase58()
      .localeCompare(getAuctionRankPda(new PublicKey(b.tokenMint)).toBase58());
  });
}

function short(key: string): string {
  if (key === '11111111111111111111111111111111') return 'None';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

function formatSol(lamports: bigint): string {
  const val = Number(lamports) / 1e9;
  if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
  if (val >= 1) return val.toFixed(val % 1 === 0 ? 0 : 2);
  if (val === 0) return '0';
  return parseFloat(val.toPrecision(3)).toString();
}

function parseSolToLamports(input: string): bigint {
  const raw = input.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error('Enter a valid SOL amount.');
  const [wholeRaw, fracRaw = ''] = raw.split('.');
  if (fracRaw.length > 9) throw new Error('Use 9 decimals or fewer.');
  return BigInt(wholeRaw || '0') * BigInt(LAMPORTS_PER_SOL) +
    BigInt((fracRaw + '0'.repeat(9)).slice(0, 9));
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function epochDateRange(epoch: bigint, startMs?: number | null, endMs?: number | null): string {
  if (startMs && endMs) {
    const startStr = fmtDate(Math.floor(startMs / 1000));
    const endStr = fmtDate(Math.floor(endMs / 1000) - 1);
    return `${startStr} to ${endStr}`;
  }
  const start = Number(epoch) * EPOCH_SECS;
  const end = (Number(epoch) + 1) * EPOCH_SECS;
  const startStr = fmtDate(start);
  const endStr = fmtDate(end - 1);
  return `${startStr} to ${endStr}`;
}

function useCountdown(targetMs: number): { label: string; secondsLeft: number } {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const diff = Math.max(0, targetMs - now);
  const totalSecs = Math.floor(diff / 1000);
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (diff <= 0) return { label: 'CLOSED', secondsLeft: 0 };
  if (d > 0) return { label: `${d}d ${h}h ${m}m`, secondsLeft: totalSecs };
  return { label: `${h}h ${m}m ${s}s`, secondsLeft: totalSecs };
}

// ─── SOL glyph ───

function SolMark({ size = 11 }: { size?: number }) {
  const uid = useId();
  const gid = `sgm-${uid}`;
  return (
    <span className="inline-flex items-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 32 32" width={size} height={size}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#9945FF" />
            <stop offset="100%" stopColor="#14F195" />
          </linearGradient>
        </defs>
        <path fill={`url(#${gid})`} d="M5 22.5l4-3.5h18l-4 3.5H5zm22-13L23 13H5l4-3.5h18zM5 16l4-3.5h18l-4 3.5H5z" />
      </svg>
    </span>
  );
}

// ─── Panel Shell ───

function PanelShell({
  title,
  tag,
  tagAccent = 'orange',
  highlight = false,
  children,
}: {
  title: string;
  tag?: string;
  tagAccent?: 'orange' | 'emerald' | 'rose' | 'amber';
  highlight?: boolean;
  children: React.ReactNode;
}) {
  const tagCls = {
    orange: 'bg-orange/10 text-orange border-orange/30',
    emerald: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
    rose: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
    amber: 'bg-amber/10 text-amber border-amber/30',
  }[tagAccent];
  return (
    <div className={highlight ? 'rounded-sm fp-input-module overflow-hidden' : 'rounded-sm hairline bg-inkA overflow-hidden'}>
      <div className="px-5 py-3 hairline-b flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-orange" />
          <span className="font-display text-bone text-sm tracking-wide">{title}</span>
        </div>
        {tag && (
          <span className={`font-mono text-[9px] tracking-[0.18em] px-2 py-1 rounded-sm border ${tagCls}`}>{tag}</span>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── Countdown Pill ───

function CountdownPill({ secondsLeft, label }: { secondsLeft: number; label?: string }) {
  const isCritical = secondsLeft > 0 && secondsLeft < 1800;
  const isClosed = secondsLeft === 0;

  let display: string;
  if (isClosed) {
    display = 'CLOSED';
  } else {
    const h = Math.floor(secondsLeft / 3600);
    const m = Math.floor((secondsLeft % 3600) / 60);
    const s = secondsLeft % 60;
    if (h > 0) display = `${h}h ${String(m).padStart(2, '0')}m`;
    else if (m > 0) display = `${m}m ${String(s).padStart(2, '0')}s`;
    else display = `${s}s`;
  }

  const cls = isClosed
    ? 'border-amber/60 text-amber'
    : isCritical
    ? 'border-rose-500/70 text-rose-300'
    : 'border-orange/55 text-orange';

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm border tabular-nums bg-black/75 backdrop-blur-md shadow-[0_2px_10px_rgba(0,0,0,0.55)] ${cls}`}>
      {isCritical && <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />}
      {label && <span className="font-mono text-[9px] tracking-[0.18em] opacity-75">{label}</span>}
      <span className="font-mono text-[11px] font-semibold text-bone">{display}</span>
    </span>
  );
}

// ─── Marquee Bulbs ───

function MarqueeBulbs() {
  return (
    <div className="mx-3 sm:mx-4 my-2 flex rounded-sm border border-orange/30 bg-black/35 shadow-[inset_0_0_18px_rgba(242,106,31,0.12),0_0_18px_rgba(242,106,31,0.10)] overflow-hidden">
      {Array.from({ length: 48 }).map((_, i) => (
        <div key={i} className="flex-1 h-5 sm:h-6 flex items-center justify-center border-r border-orange/[0.08] last:border-r-0">
          <span
            className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full"
            style={{
              background:
                i % 2 === 0
                  ? 'radial-gradient(circle at center, #FFF0A8 0%, #FFD36A 28%, #F26A1F 58%, rgba(242,106,31,0.16) 100%)'
                  : 'radial-gradient(circle at center, #FFE1A0 0%, #FF8A3D 34%, #F26A1F 62%, rgba(242,106,31,0.14) 100%)',
              boxShadow:
                '0 0 5px rgba(255,211,106,0.95), 0 0 12px rgba(242,106,31,0.72), 0 0 22px rgba(242,106,31,0.32)',
              filter: 'saturate(1.22)',
              animation: `bulb${i % 3} 2s ease-in-out infinite`,
              animationDelay: `${i * 0.04}s`,
            }}
          />
        </div>
      ))}
      <style>{`
        @keyframes bulb0 { 0%,100% { opacity: 0.9 } 50% { opacity: 0.3 } }
        @keyframes bulb1 { 0%,100% { opacity: 0.5 } 50% { opacity: 1 } }
        @keyframes bulb2 { 0%,100% { opacity: 0.3 } 50% { opacity: 0.9 } }
      `}</style>
    </div>
  );
}

// ─── Stat Cell ───

function StatCell({
  label,
  value,
  accent = 'bone',
  sub,
}: {
  label: string;
  value: React.ReactNode;
  accent?: 'bone' | 'orange' | 'amber' | 'emerald';
  sub?: string;
}) {
  const cls = { bone: 'text-bone', orange: 'text-orange', amber: 'text-amber', emerald: 'text-emerald-300' }[accent];
  return (
    <div className="bg-inkA px-4 py-3">
      <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em] mb-1">{label}</div>
      <div className={`font-display text-xl tabular-nums leading-none inline-flex items-center ${cls}`}>{value}</div>
      {sub && <div className="font-mono text-[9px] text-boneDim/50 mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Token Medallion (mint-derived avatar, no metadata dependency) ───

function TokenMedallion({ mint, size = 36 }: { mint: string; size?: number }) {
  // Fully client-side: no logo URI lookup (would need an indexer/metadata API).
  // Render a deterministic monogram from the mint so each token reads distinctly.
  const label = mint === '11111111111111111111111111111111' ? '?' : mint.slice(0, 3).toUpperCase();
  return (
    <div
      className="rounded-full shrink-0 flex items-center justify-center bg-inkA border border-orange/20"
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.3) }}
    >
      <span className="font-display text-boneDim/70 tracking-wide">{label}</span>
    </div>
  );
}

// ─── Copy contract address ───

function CopyMint({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        try {
          navigator.clipboard?.writeText(mint);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
      title={`Copy contract address\n${mint}`}
      className="font-mono inline-flex items-center gap-1 hover:text-orange transition-colors align-baseline"
    >
      <span>{short(mint)}</span>
      {copied ? (
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5 opacity-50" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.4" />
          <path d="M3 10.5V4A1.5 1.5 0 014.5 2.5H10.5" strokeLinecap="round" />
        </svg>
      )}
      <span className="sr-only">{copied ? 'Copied' : 'Copy contract address'}</span>
    </button>
  );
}

// ─── How It Works ───

function HowItWorks() {
  const steps = [
    {
      n: '01',
      k: 'OPEN',
      d: 'Each epoch, one token wins a CASH-table listing slot. Anyone can pool SOL on any SPL token. The token at #1 when the timer hits zero wins.',
    },
    {
      n: '02',
      k: 'POOL',
      d: 'Contributions are cumulative. Total SOL pooled on a token is what matters, not who pooled it. Communities pile in together.',
    },
    {
      n: '03',
      k: 'CARRY',
      d: 'Only #1 wins. Every other token keeps its pooled SOL and rank position into the next epoch. #2 today starts first tomorrow before any new bids.',
    },
    {
      n: '04',
      k: 'LIST',
      d: `Winning token unlocks for one full epoch. Anyone can open a CASH table denominated in it. SOL and ${BRAND.tokenSymbol} are always allowed; this auction gates everything else.`,
    },
  ];
  return (
    <div>
      <SectionHeader
        eyebrow="HOW IT WORKS"
        title="The listing"
        subtitle="Community tokens pool SOL to win one cash-table listing slot per epoch. Winner unlocks CASH tables denominated in its token for one full epoch; losers roll their pool into the next. Four steps below."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {steps.map((s) => (
          <div key={s.n} className="p-4 rounded-sm hairline bg-inkA">
            <div className="font-display text-orange text-4xl leading-none tabular-nums mb-2">{s.n}</div>
            <div className="font-display text-bone text-lg tracking-wide">{s.k}</div>
            <p className="font-mono text-[10px] text-boneDim/70 mt-1.5 leading-relaxed">{s.d}</p>
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
      q: 'Why only one winner per epoch?',
      a: 'Scarcity. One slot per epoch keeps the auction meaningful. Every token has to genuinely outpace every other community to earn a listing. Multiple winners would devalue the slot.',
    },
    {
      q: 'What happens to losing tokens?',
      a: 'Their pool and rank carry into the next epoch. If a token is #2 today with 142 SOL pooled, it starts #1 tomorrow with 142 SOL already in before anyone contributes a single new bid.',
    },
    {
      q: `Why bid in SOL and not ${BRAND.tokenSymbol}?`,
      a: `SOL is the universal collateral on Solana. Communities do not need to acquire ${BRAND.tokenSymbol} to participate. They pool the asset everyone already holds.`,
    },
    {
      q: 'Is anything burned?',
      a: 'No. All pooled SOL flows to the protocol (50% Platform Fee, 50% stakers). Nothing is burned.',
    },
    {
      q: 'Can I withdraw my contribution?',
      a: 'No. Contributions are non-refundable the moment they hit the on-chain PDA. Bids are sticky across epochs and wait with their token.',
    },
    {
      q: 'Does identity matter?',
      a: 'No. Only the total SOL pooled per token counts. Any wallet, any size adds to the same number. The leaderboard is what matters.',
    },
    {
      q: 'Can existing listed tokens be bumped off?',
      a: 'No. This auction adds new listings on top of the existing roster. Winning a slot means one full epoch of CASH-table availability for your token.',
    },
    {
      q: 'When does my SOL flow to the protocol?',
      a: 'When the token finally wins. A token sitting at #4 can pool indefinitely. SOL only releases when its token climbs to #1 at an epoch close.',
    },
  ];
  const [open, setOpen] = useState(-1);
  return (
    <div>
      <SectionHeader
        eyebrow="COMMON QUESTIONS"
        title="FAQ"
        subtitle="Everything you might be wondering about how the listing auction works, where bids go, and why scarcity is enforced."
      />
      <div className="rounded-sm hairline bg-inkA overflow-hidden">
        {items.map((item, i) => (
          <div key={i} className="hairline-b last:border-b-0">
            <button
              onClick={() => setOpen(open === i ? -1 : i)}
              className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-orange/[0.02] transition"
            >
              <span className="font-display text-bone text-base tracking-wide">{item.q}</span>
              <span className={`font-display text-orange text-xl transition-transform ${open === i ? 'rotate-45' : ''}`}>
                +
              </span>
            </button>
            {open === i && (
              <div className="px-5 pb-4 -mt-1 fade-in">
                <p className="font-mono text-[11px] text-boneDim/75 leading-relaxed max-w-3xl">{item.a}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ───

export default function AuctionsPage() {
  const { publicKey, sendTransaction, signTransaction, isConnected: connected } = useUnifiedWallet();
  const conn = useMemo(() => makeL1Connection(), []);

  // Config-driven epoch (adaptive duration) with wall-clock fallback
  const [configEpoch, setConfigEpoch] = useState<bigint | null>(null);
  const [configEndMs, setConfigEndMs] = useState<number | null>(null);
  const [configDurationDays, setConfigDurationDays] = useState<number>(3);

  const currentEpoch = configEpoch ?? getCurrentAuctionEpoch();
  const endTimeMs = configEndMs ?? getAuctionEndTime(currentEpoch);
  const { secondsLeft } = useCountdown(endTimeMs);

  const [auction, setAuction] = useState<AuctionInfo | null>(null);
  const [bids, setBids] = useState<GlobalBidInfo[]>([]);
  const [pastAuctions, setPastAuctions] = useState<AuctionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  // Set when the free public pool can't scan program accounts (listing book).
  const [listingUnavailable, setListingUnavailable] = useState(false);

  // Bid form
  const [candidateMint, setCandidateMint] = useState('');
  const [bidAmount, setBidAmount] = useState('');
  const [bidStatus, setBidStatus] = useState<string | null>(null);
  const [bidding, setBidding] = useState(false);

  // Quick-add state (inline bid on leaderboard)
  const [quickAddMint, setQuickAddMint] = useState<string | null>(null);
  const [quickAddAmt, setQuickAddAmt] = useState('');
  const quickAddRef = useRef<HTMLInputElement>(null);

  // Fetch current auction and bids — 100% client-side, free-pool aware.
  const fetchData = useCallback(async () => {
    try {
      // AuctionConfig PDA: single getAccountInfo, free-pool safe.
      const configPda = getAuctionConfigPda();
      const configInfo = await conn.getAccountInfo(configPda);
      let activeEpoch = currentEpoch;
      if (configInfo && configInfo.data.length >= 41) {
        const cfg = parseAuctionConfig(Buffer.from(configInfo.data));
        activeEpoch = cfg.currentEpoch;
        setConfigEpoch(cfg.currentEpoch);
        setConfigEndMs((cfg.currentEpochStart + cfg.currentEpochDuration) * 1000);
        setConfigDurationDays(Math.round(cfg.currentEpochDuration / 86_400));
      }

      // Current epoch's AuctionState (epoch-level stats): single getAccountInfo.
      const auctionPda = getAuctionPda(activeEpoch);
      const auctionInfo = await conn.getAccountInfo(auctionPda);
      if (auctionInfo && auctionInfo.data.length >= 76) {
        setAuction(parseAuction(Buffer.from(auctionInfo.data)));
      } else {
        setAuction(null);
      }

      // Listing book: requires a full program-account scan. getProgramAccounts is
      // BLOCKED on the free public pool, so only attempt it when the operator has
      // configured their own RPC. Otherwise degrade gracefully to an empty book
      // with a "bring your own RPC" hint — never crash or hang.
      if (shouldUsePool()) {
        setListingUnavailable(true);
        setBids([]);
      } else {
        setListingUnavailable(false);
        const rankAccounts = await conn.getProgramAccounts(FASTPOKER_REGISTRY_PROGRAM_ID, {
          filters: [{ dataSize: AUCTION_RANK_DATA_SIZE }],
        });
        const activeRanks = rankAccounts
          .map(({ account }) => parseAuctionRank(Buffer.from(account.data)))
          .filter((rank): rank is NonNullable<ReturnType<typeof parseAuctionRank>> =>
            !!rank && rank.active && rank.totalAmount > BigInt(0),
          );

        const bidderCounts = new Map<string, number>();
        try {
          const bidAccounts = await conn.getProgramAccounts(FASTPOKER_REGISTRY_PROGRAM_ID, {
            filters: [{ dataSize: GLOBAL_BID_DATA_SIZE }],
          });
          for (const { account } of bidAccounts) {
            const bid = parseGlobalTokenBid(Buffer.from(account.data));
            if (bid) bidderCounts.set(bid.tokenMint, bid.bidderCount);
          }
        } catch {
          /* bidder counts are optional — leaderboard still renders without them */
        }

        const allParsed: GlobalBidInfo[] = activeRanks.map((rank) => ({
          tokenMint: rank.tokenMint,
          totalAmount: rank.totalAmount,
          bidderCount: bidderCounts.get(rank.tokenMint) ?? 0,
          firstBidAt: rank.firstBidAt,
        }));
        setBids(sortAuctionBids(allParsed));
      }

      // Past epoch winners (AuctionState w/ status=Resolved). Chunked
      // getMultipleAccountsInfo is free-pool safe (≤10 per request).
      const pastEpochCount = Math.min(20, Number(activeEpoch));
      const pastPdas: PublicKey[] = [];
      for (let i = 1; i <= pastEpochCount; i++) {
        const pastEpoch = activeEpoch - BigInt(i);
        if (pastEpoch < BigInt(0)) break;
        pastPdas.push(getAuctionPda(pastEpoch));
      }
      const past: AuctionInfo[] = [];
      if (pastPdas.length > 0) {
        try {
          const infos = await getMultipleAccountsInfoChunked(conn, pastPdas);
          for (const info of infos) {
            if (info && info.data.length >= 76) {
              const a = parseAuction(Buffer.from(info.data));
              if (a && a.status === 1) past.push(a);
            }
          }
        } catch { /* skip batch fetch failures */ }
      }
      setPastAuctions(past);
    } catch (e) {
      console.warn('Auction fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, [conn, currentEpoch]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  // Place bid (full form or quick-add) — player-signed, client-side.
  const submitBid = async (mintStr: string, solAmount: number) => {
    if (!publicKey || !connected) {
      setBidStatus('Connect wallet first');
      return;
    }

    setBidding(true);
    setBidStatus(null);
    try {
      const mint = new PublicKey(mintStr);
      const amountLamports = parseSolToLamports(String(solAmount));
      if (amountLamports <= BigInt(0)) throw new Error('Enter a SOL amount above zero.');

      // Pre-validate: check the mint is a real SPL token on-chain
      const mintAcct = await conn.getAccountInfo(mint);
      if (!mintAcct) {
        setBidStatus('Error: Account not found - enter a valid token mint address');
        setBidding(false);
        return;
      }
      if (mintAcct.owner.toBase58() === TOKEN_2022_PROGRAM_ID) {
        setBidStatus('Error: Token-2022 mints are not currently supported');
        setBidding(false);
        return;
      }
      if (!mintAcct.owner.equals(TOKEN_PROGRAM_ID)) {
        setBidStatus('Error: Not a valid SPL token mint');
        setBidding(false);
        return;
      }
      if (mintAcct.data.length < 82 || mintAcct.data[45] !== 1) {
        setBidStatus('Error: Not an initialized SPL token mint');
        setBidding(false);
        return;
      }
      // Check freeze authority (bytes 46-49 = COption tag, 0 = None)
      const freezeTag =
        mintAcct.data[46] |
        (mintAcct.data[47] << 8) |
        (mintAcct.data[48] << 16) |
        (mintAcct.data[49] << 24);
      if (freezeTag !== 0) {
        setBidStatus('Error: Token has freeze authority - not allowed');
        setBidding(false);
        return;
      }

      // Refresh epoch from on-chain config to avoid stale closure
      let bidEpoch = currentEpoch;
      try {
        const configInfo = await conn.getAccountInfo(getAuctionConfigPda());
        if (configInfo && configInfo.data.length >= 41) {
          bidEpoch = parseAuctionConfig(Buffer.from(configInfo.data)).currentEpoch;
        }
      } catch { /* fallback to currentEpoch */ }

      // Wallet balance pre-check (amount + fee buffer)
      const balance = await conn.getBalance(publicKey);
      if (BigInt(balance) < amountLamports + BigInt(20_000)) {
        setBidStatus(`Insufficient balance: have ${(balance / 1e9).toFixed(4)} SOL, need ~${solAmount.toFixed(4)}`);
        setBidding(false);
        return;
      }

      const existingBid = bids.find((b) => b.tokenMint === mint.toBase58());
      const newTotal = (existingBid?.totalAmount ?? BigInt(0)) + amountLamports;
      const firstBidAt = existingBid?.firstBidAt ?? Math.floor(Date.now() / 1000);
      const ranked = sortAuctionBids([
        ...bids.filter((b) => b.totalAmount > BigInt(0) && b.tokenMint !== mint.toBase58()),
        {
          tokenMint: mint.toBase58(),
          totalAmount: newTotal,
          bidderCount: existingBid?.bidderCount ?? 0,
          firstBidAt,
        },
      ]);
      const rankIndex = ranked.findIndex((b) => b.tokenMint === mint.toBase58());
      const insertPrevMint = rankIndex > 0 ? new PublicKey(ranked[rankIndex - 1].tokenMint) : null;
      const insertNextMint = rankIndex >= 0 && rankIndex < ranked.length - 1 ? new PublicKey(ranked[rankIndex + 1].tokenMint) : null;

      const extraRankMints: PublicKey[] = [];
      try {
        const rankInfo = await conn.getAccountInfo(getAuctionRankPda(mint));
        const rank = rankInfo ? parseAuctionRank(Buffer.from(rankInfo.data)) : null;
        if (rank?.active) {
          if (rank.prevMint !== ZERO_PUBKEY) extraRankMints.push(new PublicKey(rank.prevMint));
          if (rank.nextMint !== ZERO_PUBKEY) extraRankMints.push(new PublicKey(rank.nextMint));
        }
      } catch {
        // Missing/stale rank just means this is a first bid or the user should retry after refresh.
      }

      const ix = buildPlaceBidInstruction(publicKey, mint, amountLamports, bidEpoch, {
        insertPrevMint,
        insertNextMint,
        extraRankMints,
      });

      const latestBlockhash = await getLatestBlockhashClient(conn, 'confirmed');
      const tx = new Transaction({
        feePayer: publicKey,
        recentBlockhash: latestBlockhash.blockhash,
      }).add(ix);
      await applyPriorityFee(tx);

      if (!(await confirmFundsAction({
        title: 'Confirm Auction Bid',
        action: 'Place SOL bid for token listing',
        amount: `${solAmount.toFixed(4).replace(/\.?0+$/, '')} SOL`,
        details: [`Mint: ${mint.toBase58()}`],
        transaction: tx,
      }))) {
        setBidding(false);
        return;
      }

      const sig = await sendWalletTx(tx, conn, { sendTransaction, signTransaction });
      await conn.confirmTransaction({ signature: sig, ...latestBlockhash }, 'confirmed');
      setBidStatus(`Bid placed! Tx: ${sig.slice(0, 12)}...`);
      setCandidateMint('');
      setBidAmount('');
      setQuickAddMint(null);
      setQuickAddAmt('');
      fetchData();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      setBidStatus(`Error: ${msg.slice(0, 80)}`);
    } finally {
      setBidding(false);
    }
  };

  const handleBid = () => {
    if (!candidateMint || candidateMint.length < 32) {
      setBidStatus('Enter a valid token mint address');
      return;
    }
    const amount = parseFloat(bidAmount);
    if (!amount || amount <= 0) {
      setBidStatus('Enter a valid bid amount');
      return;
    }
    submitBid(candidateMint, amount);
  };

  const handleQuickAdd = (mint: string) => {
    const amount = parseFloat(quickAddAmt);
    if (!amount || amount <= 0) {
      setBidStatus('Enter a valid SOL amount');
      return;
    }
    submitBid(mint, amount);
  };

  // Focus input when quick-add opens
  useEffect(() => {
    if (quickAddMint && quickAddRef.current) quickAddRef.current.focus();
  }, [quickAddMint]);

  const topBid = bids.length > 0 ? bids[0] : null;
  const runnerUp = bids.length > 1 ? bids[1] : null;
  const configStartMs = configEndMs && configDurationDays ? configEndMs - configDurationDays * 86_400_000 : null;
  const dateRange = epochDateRange(currentEpoch, configStartMs, configEndMs);
  const totalPooledLamports = bids.reduce((sum, b) => sum + b.totalAmount, BigInt(0));
  const lead = topBid && runnerUp ? Number(topBid.totalAmount - runnerUp.totalAmount) / 1e9 : null;

  return (
    <div className="min-h-screen text-bone antialiased">
      <main className="max-w-[1280px] mx-auto w-full px-3 sm:px-5 space-y-6 pb-16">

        {/* ── HERO: Spotlight + Live Leaderboard ── */}
        <div className="rounded-sm hairline bg-ink overflow-hidden">
          {/* Spotlight strip */}
          <div
            id="auction-banner-spotlight"
            className="relative overflow-hidden bg-[length:100%_auto] bg-center bg-no-repeat bg-[url('/brand/auction_banner_mobile.png')] lg:bg-[url('/brand/auction_banner_5.png')]"
            style={{
              backdropFilter: 'blur(14px) saturate(1.05)',
              WebkitBackdropFilter: 'blur(14px) saturate(1.05)',
            }}
          >
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ background: 'radial-gradient(ellipse at center top, rgba(242,106,31,0.18), transparent 60%)' }}
            />
            <MarqueeBulbs />
            <div id="auction-banner-grid" className="relative px-0 lg:px-10 py-8 grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-6 items-center">
              {/* Left */}
              <div id="auction-banner-left-col" className="self-start flex flex-col items-center text-center lg:items-end lg:text-right rounded-sm px-6 py-5" style={{
                background: 'rgba(6,4,6,0.68)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                }}>
                <div className="font-mono text-[10px] tracking-[0.3em] text-amber/80">
                  - EPOCH #{currentEpoch.toString()} · LIVE -
                </div>
                <div id="auction-banner-left-headline" className="mt-3 font-display text-bone text-4xl lg:text-5xl leading-[0.95] tracking-wide">
                  One token<br /><span className="text-orange">wins the<br />
                  <span className="italic">listing.</span></span>
                </div>
                <p className="mt-4 font-mono text-[11px] text-boneDim/70 leading-relaxed lg:text-right">
                  Pool SOL on any SPL token. #1 at epoch close earns a CASH-table listing.{' '}
                  <span className="text-amber">Losers carry pool + rank to next round.</span>
                </p>
              </div>

              {/* Center banner token */}
              <div id="auction-banner-center-col" className="flex flex-col items-center gap-4">
                <img
                  id="auction-banner-center-token"
                  src="/brand/auction_banner_token.gif"
                  alt="Auction token"
                  className="w-[180px] h-[180px] lg:w-[220px] lg:h-[220px] mx-auto select-none"
                />
                <CountdownPill secondsLeft={secondsLeft} label="ENDS" />
              </div>

              {/* Right */}
              <div id="auction-banner-right-col" className="self-start flex flex-col items-center text-center lg:items-start lg:text-left rounded-sm px-6 py-5" style={{
                background: 'rgba(6,4,6,0.68)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                }}>
                <div className="font-mono text-[10px] tracking-[0.3em] text-amber/80">CURRENT LEADER</div>
                {topBid ? (
                  <>
                    <div
                      className="mt-2 pt-2 font-display leading-[0.85] tracking-tight text-bone inline-flex items-center gap-2"
                      style={{ fontSize: 'clamp(36px, 4.5vw, 60px)', textShadow: '0 0 40px rgba(232,226,214,0.35)' }}
                    >
                      <SolMark size={24} />{formatSol(topBid.totalAmount)}
                    </div>
                    <div className="mt-1.5 font-mono text-[11px] text-boneDim/75">
                      <span className="text-bone">{short(topBid.tokenMint)}</span>
                      {lead !== null && (
                        <> leads by <span className="text-emerald-300">{lead.toFixed(2)} SOL</span></>
                      )}
                      {' '}&middot; {topBid.bidderCount} backers
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-boneDim/55">
                      Epoch {dateRange} &middot; {configDurationDays}d epoch
                    </div>
                  </>
                ) : (
                  <div className="mt-2 font-mono text-[11px] text-boneDim/50">
                    {listingUnavailable ? 'Leaderboard needs your own RPC.' : 'No bids placed yet.'}
                  </div>
                )}

                {/* Stat strip */}
                <div className="grid grid-cols-2 gap-px bg-orange/15 rounded-sm overflow-hidden hairline mt-5">
                  <StatCell
                    label="TOTAL POOLED"
                    value={<><SolMark size={12} />&nbsp;{formatSol(totalPooledLamports)}</>}
                    accent="orange"
                  />
                  <StatCell
                    label="TOKENS COMPETING"
                    value={<>{bids.length}</>}
                    accent="bone"
                    sub={`${configDurationDays}d epoch`}
                  />
                </div>
              </div>
            </div>
            <MarqueeBulbs />
          </div>

          {/* Live Leaderboard below spotlight */}
          <div className="px-4 lg:px-6 py-5">
            <div className="flex items-end justify-between mb-3 px-1">
              <div>
                <div className="font-mono text-[10px] tracking-[0.22em] text-orange/80 mb-1">LIVE LEADERBOARD</div>
                <div className="font-display text-bone text-xl">Back any token with one click.</div>
              </div>
              <div className="font-mono text-[10px] text-boneDim/60 text-right">
                {bids.length} candidates<br />
                <span className="text-amber">losers carry pool + rank to next epoch</span>
              </div>
            </div>

            {loading ? (
              <div className="py-8 text-center font-mono text-[11px] text-boneDim/50 tracking-wider">
                LOADING BIDS...
              </div>
            ) : listingUnavailable ? (
              <div className="rounded-sm border border-amber/35 bg-amber/[0.06] px-5 py-8 text-center">
                <div className="font-display text-bone text-lg tracking-wide mb-2">Leaderboard needs a dedicated RPC</div>
                <p className="font-mono text-[11px] text-boneDim/70 leading-relaxed max-w-xl mx-auto">
                  Scanning the listing book requires a full program-account scan, which the free public RPC pool
                  blocks. Configure your own RPC endpoint in settings to load the live leaderboard. Bidding still works
                  directly from your wallet using the form below.
                </p>
              </div>
            ) : bids.length === 0 ? (
              <div className="py-8 text-center font-mono text-[11px] text-boneDim/50">
                No bids yet. Be the first to bid for a token listing.
              </div>
            ) : (
              <div className="relative overflow-hidden rounded-sm hairline bg-inkA">
                <div className="max-h-[min(58vh,620px)] overflow-auto overscroll-contain scroll-smooth pr-1">
                  <div className="min-w-0 sm:min-w-[680px]">
                    {/* Header */}
                    <div className="sticky top-0 z-20 grid grid-cols-[40px_minmax(0,1fr)_auto_auto] sm:grid-cols-[56px_minmax(0,1fr)_130px_70px_180px] gap-3 px-4 py-2.5 hairline-b bg-ink/95 backdrop-blur font-mono text-[9px] text-boneDim/55 tracking-[0.2em] shadow-[0_8px_18px_rgba(0,0,0,0.28)]">
                      <span className="text-center">RANK</span>
                      <span>TOKEN</span>
                      <span className="text-right">POOLED</span>
                      <span className="text-right hidden sm:block">BACKERS</span>
                      <span className="text-right">BID</span>
                    </div>

                    {bids.map((bid, idx) => {
                      const isFirst = idx === 0;
                      const isQuickOpen = quickAddMint === bid.tokenMint;
                      const pct = topBid ? (Number(bid.totalAmount) / Number(topBid.totalAmount)) * 100 : 0;

                      return (
                        <div key={bid.tokenMint}>
                          <div
                            className={`grid grid-cols-[40px_minmax(0,1fr)_auto_auto] sm:grid-cols-[56px_minmax(0,1fr)_130px_70px_180px] gap-3 px-4 py-3 items-center hairline-b last:border-b-0 transition relative ${
                              isFirst ? 'bg-amber/[0.05]' : 'hover:bg-orange/[0.03]'
                            }`}
                          >
                            {/* Progress bar background */}
                            <div
                              className="absolute inset-y-0 left-0 pointer-events-none"
                              style={{
                                width: `${pct}%`,
                                background: 'linear-gradient(90deg, rgba(242,106,31,0.08), rgba(242,106,31,0.02))',
                              }}
                            />

                            {/* Rank */}
                            <div className="relative flex flex-col items-center justify-center">
                              <span
                                className={`font-display tabular-nums leading-none ${
                                  isFirst ? 'text-amber text-4xl' : idx < 3 ? 'text-bone text-2xl' : 'text-boneDim/50 text-xl'
                                }`}
                              >
                                {idx + 1}
                              </span>
                            </div>

                            {/* Token */}
                            <div className="relative flex items-center gap-3 min-w-0">
                              <TokenMedallion mint={bid.tokenMint} size={isFirst ? 36 : 28} />
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="font-display text-bone text-base leading-none truncate">
                                    {short(bid.tokenMint)}
                                  </span>
                                  {isFirst && (
                                    <span className="inline-flex items-center gap-1 rounded-sm border border-amber/40 bg-amber/10 px-2 py-0.5 font-mono text-[8px] uppercase tracking-[0.16em] text-amber shadow-[0_0_14px_rgba(255,198,58,0.16)]">
                                      <span className="h-1.5 w-1.5 rounded-full bg-amber animate-pulse" />
                                      Live #1
                                    </span>
                                  )}
                                </div>
                                <div className="font-mono text-[10px] text-boneDim/55 mt-0.5 tabular-nums">
                                  {bid.bidderCount} bidder{bid.bidderCount !== 1 ? 's' : ''} &middot;{' '}
                                  <CopyMint mint={bid.tokenMint} />
                                </div>
                              </div>
                            </div>

                            {/* Pooled */}
                            <div className="relative text-right">
                              <div
                                className={`font-display tabular-nums leading-none inline-flex items-center justify-end gap-1.5 ${
                                  isFirst ? 'text-amber text-2xl' : 'text-bone text-xl'
                                }`}
                              >
                                <SolMark size={isFirst ? 14 : 12} />{formatSol(bid.totalAmount)}
                              </div>
                              {auction && auction.totalBid > BigInt(0) && (
                                <div className="font-mono text-[9px] text-boneDim/50 mt-0.5 tabular-nums">
                                  {((Number(bid.totalAmount) * 100) / Number(auction.totalBid)).toFixed(1)}%
                                </div>
                              )}
                            </div>

                            {/* Backers — hidden on mobile; count is already in the token sub-line. */}
                            <div className="relative text-right hidden sm:block">
                              <div className="font-mono text-[11px] text-bone tabular-nums">{bid.bidderCount}</div>
                              <div className="font-mono text-[9px] text-boneDim/50 mt-0.5">community</div>
                            </div>

                            {/* Quick-add bid button */}
                            <div className="relative flex items-center justify-end">
                              <button
                                onClick={() => {
                                  setQuickAddMint(isQuickOpen ? null : bid.tokenMint);
                                  setQuickAddAmt('');
                                }}
                                className={`px-3 py-1.5 rounded-sm font-mono text-[10px] tracking-wider transition inline-flex items-center gap-1 border ${
                                  isQuickOpen
                                    ? 'bg-orange/25 text-orange border-orange/30'
                                    : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25 hover:bg-emerald-500/25'
                                }`}
                                title={`Bid SOL on ${short(bid.tokenMint)}`}
                              >
                                <SolMark size={10} />BID
                              </button>
                            </div>
                          </div>

                          {/* Quick-add inline form */}
                          {isQuickOpen && (
                            <div className="flex flex-wrap items-center gap-2 px-4 py-2 hairline-b bg-inkA/60">
                              <input
                                ref={quickAddRef}
                                type="number"
                                value={quickAddAmt}
                                onChange={(e) => setQuickAddAmt(e.target.value)}
                                placeholder="0.00"
                                min="0.001"
                                step="0.001"
                                className="flex-1 min-w-[110px] px-3 py-1.5 rounded-sm hairline bg-ink text-bone placeholder-boneDim/40 font-mono text-[11px] outline-none focus:border-orange/40 tabular-nums"
                                onKeyDown={(e) => e.key === 'Enter' && handleQuickAdd(bid.tokenMint)}
                              />
                              <span className="font-mono text-[10px] text-boneDim/50">SOL</span>
                              {[0.05, 0.1, 0.5].map((v) => (
                                <button
                                  key={v}
                                  onClick={() => setQuickAddAmt(v.toString())}
                                  className="px-2 py-1.5 rounded-sm hairline bg-inkB font-mono text-[10px] text-boneDim/70 hover:text-bone hover:bg-orange/10 hover:border-orange/40 transition"
                                >
                                  {v}
                                </button>
                              ))}
                              <button
                                onClick={() => handleQuickAdd(bid.tokenMint)}
                                disabled={bidding || !connected}
                                className="px-4 py-1.5 rounded-sm btn-orange font-mono text-[10px] disabled:opacity-40 transition-all"
                              >
                                {bidding ? '...' : 'BID'}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Footer note */}
                    <div className="px-4 py-2.5 hairline-t bg-ink/30 font-mono text-[9px] text-boneDim/55 tracking-wider text-center flex items-center justify-between flex-wrap gap-2">
                      <span>
                        <span className="text-amber">★</span> Winner resets to 0 next epoch. Others carry pool + rank forward.
                      </span>
                      <span className="text-orange/70">
                        Persistent leaderboard. Bids carry across epochs until your token wins.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Past Epoch Winners ── */}
        {pastAuctions.length > 0 && (
          <PanelShell title={`RECENT WINNERS · LISTING HISTORY`} tag={`${pastAuctions.length} EPOCHS`}>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
              {pastAuctions.slice(0, 8).map((a, i) => {
                const hasWinner = a.winningMint !== '11111111111111111111111111111111';
                const isLast = i === 0;
                return (
                  <div
                    key={a.epoch.toString()}
                    className={`px-3 py-3 hairline-r last:border-r-0 text-center ${isLast ? 'bg-amber/[0.04]' : ''}`}
                  >
                    <div className="font-mono text-[9px] text-boneDim/55 tracking-wider mb-1.5">
                      EPOCH #{a.epoch.toString()}
                    </div>
                    <div className="flex justify-center mb-2">
                      <TokenMedallion mint={a.winningMint} size={36} />
                    </div>
                    <div className="font-display text-bone text-base truncate">
                      {hasWinner ? short(a.winningMint) : 'No winner'}
                    </div>
                    {hasWinner && (
                      <div className="font-mono text-[9px] text-boneDim/55 mt-0.5 flex justify-center">
                        <CopyMint mint={a.winningMint} />
                      </div>
                    )}
                    <div className="font-mono text-[10px] text-amber tabular-nums mt-0.5 inline-flex items-center gap-1 justify-center">
                      <SolMark size={9} />{formatSol(a.totalBid)}
                    </div>
                    {isLast && (
                      <div className="font-mono text-[8px] text-amber tracking-wider mt-1">★ LISTED</div>
                    )}
                  </div>
                );
              })}
            </div>
          </PanelShell>
        )}

        {/* ── Place a Bid (new token / custom amount) ── */}
        <PanelShell title="BID NEW TOKEN" tag={auction?.status === 0 ? 'ACTIVE' : 'LIVE'} tagAccent="orange" highlight>
          <div className="p-5 space-y-4">
            <div className="font-mono text-[10px] text-boneDim/65 leading-relaxed">
              Don&apos;t see your token on the leaderboard? Stake SOL to list it. Your bid creates a new row. Rally your
              community to climb to #1.
            </div>

            <div className="space-y-3">
              <div>
                <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em] mb-1.5">SPL MINT ADDRESS</div>
                <input
                  type="text"
                  value={candidateMint}
                  onChange={(e) => setCandidateMint(e.target.value.trim())}
                  placeholder="e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                  className="w-full px-3 py-2.5 rounded-sm hairline bg-ink/40 font-mono text-[11px] text-bone placeholder-boneDim/40 outline-none focus:border-orange/60"
                />
                <div className="font-mono text-[9px] text-boneDim/50 mt-1">
                  Verified on-chain. Must be an initialized SPL token mint without freeze authority.
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em]">OPENING STAKE (SOL)</span>
                </div>
                <div className="rounded-sm hairline bg-ink/40 flex items-center overflow-hidden">
                  <span className="pl-4 pr-2">
                    <SolMark size={14} />
                  </span>
                  <input
                    type="number"
                    value={bidAmount}
                    onChange={(e) => setBidAmount(e.target.value)}
                    placeholder="0.00"
                    min="0.001"
                    step="0.001"
                    className="flex-1 bg-transparent py-2.5 font-display text-2xl text-bone tabular-nums outline-none w-full placeholder:text-boneDim/25"
                  />
                  <span className="pr-4 font-mono text-[10px] text-boneDim/50 tracking-wider">SOL</span>
                </div>
                <div className="flex gap-1.5 mt-1.5">
                  {[0.1, 0.5, 1, 5].map((v) => (
                    <button
                      key={v}
                      onClick={() => setBidAmount(String(v))}
                      className="flex-1 py-1.5 rounded-sm hairline bg-inkB hover:bg-orange/10 hover:border-orange/40 font-mono text-[9px] tracking-[0.18em] text-boneDim/70 hover:text-orange transition"
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              onClick={handleBid}
              disabled={bidding || !connected}
              className={`w-full py-3.5 rounded-sm font-display text-sm tracking-[0.22em] transition inline-flex items-center justify-center gap-2 ${
                bidding || !connected
                  ? 'bg-inkB hairline text-boneDim/40 cursor-not-allowed'
                  : 'btn-orange'
              }`}
            >
              {bidding ? 'BIDDING...' : `BID ${bidAmount ? bidAmount + ' SOL' : 'SOL'}`}
            </button>

            {bidStatus && (
              <div
                className={`px-3 py-2.5 rounded-sm font-mono text-[10px] leading-relaxed ${
                  bidStatus.startsWith('Error')
                    ? 'bg-rose-500/[0.06] border border-rose-500/30 text-rose-300'
                    : 'bg-emerald-500/[0.05] border border-emerald-500/30 text-emerald-300'
                }`}
              >
                {bidStatus}
              </div>
            )}

            <div className="flex items-start gap-2 pt-1">
              <svg
                className="w-3.5 h-3.5 text-boneDim/50 shrink-0 mt-0.5"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="6" cy="6" r="5" />
                <path d="M6 4v3M6 8.5v.01" />
              </svg>
              <div className="font-mono text-[9px] text-boneDim/55 leading-relaxed">
                Contributions are <span className="text-bone">non-refundable</span>. If your token loses, its pool and
                rank carry into the next epoch. SOL flows to protocol (50% Platform Fee, 50% stakers) when the token wins.
              </div>
            </div>
          </div>
        </PanelShell>

        {/* ── How It Works ── */}
        <HowItWorks />

        {/* ── FAQ ── */}
        <FAQ />
      </main>
    </div>
  );
}
