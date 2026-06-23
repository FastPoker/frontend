'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { toast } from 'sonner';

import { PageHeadline } from '@/components/ui/PageHeadline';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { applyPriorityFee } from '@/lib/priority-fee';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { confirmFundsAction } from '@/lib/funds-confirmation';
import { makeL1Connection, FASTPOKER_REGISTRY_PROGRAM_ID } from '@/lib/constants';
import { sendWalletTx } from '@/lib/send-wallet-tx';
import {
  AUCTION_RANK_DATA_SIZE,
  GLOBAL_BID_DATA_SIZE,
  buildPlaceBidInstruction,
  getAuctionConfigPda,
  getAuctionEndTime,
  getAuctionRankPda,
  getCurrentAuctionEpoch,
  parseAuctionConfig,
  parseAuctionRank,
  parseGlobalTokenBid,
} from '@/lib/onchain-game';

const ZERO_PUBKEY = PublicKey.default.toBase58();
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

interface AuctionBid {
  tokenMint: string;
  totalAmount: bigint;
  bidderCount: number;
  firstBidAt: number;
}

function short(addr: string): string {
  if (!addr) return '';
  if (addr === ZERO_PUBKEY) return 'None';
  return `${addr.slice(0, 5)}...${addr.slice(-4)}`;
}

function parseSolToLamports(input: string): bigint {
  const raw = input.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error('Enter a valid SOL amount.');
  const [wholeRaw, fracRaw = ''] = raw.split('.');
  if (fracRaw.length > 9) throw new Error('Use 9 decimals or fewer.');
  return BigInt(wholeRaw || '0') * BigInt(LAMPORTS_PER_SOL) +
    BigInt((fracRaw + '0'.repeat(9)).slice(0, 9));
}

function formatSol(lamports: bigint): string {
  const value = Number(lamports) / LAMPORTS_PER_SOL;
  if (!Number.isFinite(value)) return '--';
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return value.toFixed(value % 1 === 0 ? 0 : 3);
  if (value === 0) return '0';
  return value.toPrecision(3).replace(/\.?0+$/, '');
}

function formatCountdown(endMs: number): string {
  const diff = Math.max(0, endMs - Date.now());
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (diff <= 0) return 'closed';
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function sortAuctionBids<T extends AuctionBid>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.totalAmount !== b.totalAmount) return a.totalAmount > b.totalAmount ? -1 : 1;
    if (a.firstBidAt !== b.firstBidAt) return a.firstBidAt - b.firstBidAt;
    return getAuctionRankPda(new PublicKey(a.tokenMint))
      .toBase58()
      .localeCompare(getAuctionRankPda(new PublicKey(b.tokenMint)).toBase58());
  });
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-sm hairline bg-inkA px-4 py-3">
      <div className="font-mono text-[9px] tracking-[0.2em] text-boneDim/55 uppercase">
        {label}
      </div>
      <div className="mt-2 font-display text-bone text-3xl leading-none tabular-nums">
        {value}
      </div>
      {sub && <div className="mt-1 font-mono text-[10px] text-boneDim/55">{sub}</div>}
    </div>
  );
}

export default function AuctionsPage() {
  const connection = useMemo(() => makeL1Connection(), []);
  const { publicKey, isConnected, sendTransaction, signTransaction } = useUnifiedWallet();
  const [bids, setBids] = useState<AuctionBid[]>([]);
  const [epoch, setEpoch] = useState(getCurrentAuctionEpoch());
  const [endMs, setEndMs] = useState(getAuctionEndTime(getCurrentAuctionEpoch()));
  const [durationDays, setDurationDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [readWarning, setReadWarning] = useState<string | null>(null);
  const [candidateMint, setCandidateMint] = useState('');
  const [bidAmount, setBidAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadAuctions = useCallback(async () => {
    setLoading(true);
    setReadWarning(null);
    try {
      let activeEpoch = getCurrentAuctionEpoch();
      let activeEndMs = getAuctionEndTime(activeEpoch);
      let activeDurationDays: number | null = null;

      const configInfo = await connection.getAccountInfo(getAuctionConfigPda());
      if (configInfo && configInfo.data.length >= 68) {
        const cfg = parseAuctionConfig(Buffer.from(configInfo.data));
        activeEpoch = cfg.currentEpoch;
        activeEndMs = (cfg.currentEpochStart + cfg.currentEpochDuration) * 1000;
        activeDurationDays = Math.max(1, Math.round(cfg.currentEpochDuration / 86_400));
      }
      setEpoch(activeEpoch);
      setEndMs(activeEndMs);
      setDurationDays(activeDurationDays);

      const rankAccounts = await connection.getProgramAccounts(
        FASTPOKER_REGISTRY_PROGRAM_ID,
        { filters: [{ dataSize: AUCTION_RANK_DATA_SIZE }] },
      );
      const activeRanks = rankAccounts
        .map(({ account }) => parseAuctionRank(Buffer.from(account.data)))
        .filter((rank): rank is NonNullable<ReturnType<typeof parseAuctionRank>> =>
          !!rank && rank.active && rank.totalAmount > BigInt(0),
        );

      const bidderCounts = new Map<string, number>();
      try {
        const bidAccounts = await connection.getProgramAccounts(
          FASTPOKER_REGISTRY_PROGRAM_ID,
          { filters: [{ dataSize: GLOBAL_BID_DATA_SIZE }] },
        );
        for (const { account } of bidAccounts) {
          const bid = parseGlobalTokenBid(Buffer.from(account.data));
          if (bid) bidderCounts.set(bid.tokenMint, bid.bidderCount);
        }
      } catch {
        setReadWarning('Leaderboard loaded, but bidder counts need a stronger RPC.');
      }

      setBids(sortAuctionBids(activeRanks.map((rank) => ({
        tokenMint: rank.tokenMint,
        totalAmount: rank.totalAmount,
        firstBidAt: rank.firstBidAt,
        bidderCount: bidderCounts.get(rank.tokenMint) ?? 0,
      }))));
    } catch (err) {
      console.warn('[auctions] read failed', err);
      setBids([]);
      setReadWarning(
        'Auction leaderboard scans require getProgramAccounts. Use a paid/dedicated RPC or operator indexer if the free pool cannot load this page.',
      );
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    void loadAuctions();
    const id = setInterval(loadAuctions, 30_000);
    return () => clearInterval(id);
  }, [loadAuctions]);

  const submitBid = useCallback(async () => {
    if (!publicKey) {
      toast.error('Connect wallet first.');
      return;
    }
    setSubmitting(true);
    try {
      const mint = new PublicKey(candidateMint.trim());
      const amountLamports = parseSolToLamports(bidAmount);
      if (amountLamports <= BigInt(0)) throw new Error('Enter a SOL amount above zero.');

      const mintAcct = await connection.getAccountInfo(mint);
      if (!mintAcct) throw new Error('Token mint account not found.');
      if (mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        throw new Error('Token-2022 mints are not currently supported.');
      }
      if (!mintAcct.owner.equals(TOKEN_PROGRAM_ID)) {
        throw new Error('Account is not an SPL token mint.');
      }
      if (mintAcct.data.length < 82 || mintAcct.data[45] !== 1) {
        throw new Error('SPL token mint is not initialized.');
      }
      const freezeTag =
        mintAcct.data[46] |
        (mintAcct.data[47] << 8) |
        (mintAcct.data[48] << 16) |
        (mintAcct.data[49] << 24);
      if (freezeTag !== 0) throw new Error('Token has freeze authority and cannot be listed.');

      let bidEpoch = epoch;
      try {
        const configInfo = await connection.getAccountInfo(getAuctionConfigPda());
        if (configInfo && configInfo.data.length >= 68) {
          bidEpoch = parseAuctionConfig(Buffer.from(configInfo.data)).currentEpoch;
        }
      } catch {
        // Use the loaded epoch.
      }

      const balance = await connection.getBalance(publicKey);
      if (BigInt(balance) < amountLamports + BigInt(20_000)) {
        throw new Error(`Insufficient SOL balance. Need ${formatSol(amountLamports)} SOL plus network fees.`);
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
      const insertNextMint =
        rankIndex >= 0 && rankIndex < ranked.length - 1
          ? new PublicKey(ranked[rankIndex + 1].tokenMint)
          : null;

      const extraRankMints: PublicKey[] = [];
      try {
        const rankInfo = await connection.getAccountInfo(getAuctionRankPda(mint));
        const rank = rankInfo ? parseAuctionRank(Buffer.from(rankInfo.data)) : null;
        if (rank?.active) {
          if (rank.prevMint !== ZERO_PUBKEY) extraRankMints.push(new PublicKey(rank.prevMint));
          if (rank.nextMint !== ZERO_PUBKEY) extraRankMints.push(new PublicKey(rank.nextMint));
        }
      } catch {
        // First bids have no existing rank account.
      }

      const ix = buildPlaceBidInstruction(publicKey, mint, amountLamports, bidEpoch, {
        insertPrevMint,
        insertNextMint,
        extraRankMints,
      });
      const latestBlockhash = await getLatestBlockhashClient(connection, 'confirmed');
      const tx = new Transaction({
        feePayer: publicKey,
        recentBlockhash: latestBlockhash.blockhash,
      }).add(ix);
      await applyPriorityFee(tx);

      if (!(await confirmFundsAction({
        title: 'Confirm Auction Bid',
        action: 'Place SOL bid for token listing',
        amount: `${formatSol(amountLamports)} SOL`,
        details: [`Token mint: ${mint.toBase58()}`],
        transaction: tx,
      }))) {
        return;
      }

      const sig = await sendWalletTx(tx, connection, { sendTransaction, signTransaction });
      await connection.confirmTransaction({ signature: sig, ...latestBlockhash }, 'confirmed');
      toast.success(`Bid placed: ${sig.slice(0, 8)}...`);
      setCandidateMint('');
      setBidAmount('');
      await loadAuctions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bid failed.');
    } finally {
      setSubmitting(false);
    }
  }, [
    bidAmount,
    bids,
    candidateMint,
    connection,
    epoch,
    loadAuctions,
    publicKey,
    sendTransaction,
    signTransaction,
  ]);

  const topBid = bids[0] ?? null;
  const runnerUp = bids[1] ?? null;
  const totalPooled = bids.reduce((sum, bid) => sum + bid.totalAmount, BigInt(0));
  const lead = topBid && runnerUp ? topBid.totalAmount - runnerUp.totalAmount : null;

  return (
    <main className="max-w-[1180px] mx-auto w-full px-3 sm:px-5 py-7 md:py-10 space-y-8">
      <PageHeadline
        lineOne="Token"
        lineTwo="Auctions"
        subtitle="Bid SOL to list an SPL token for cash-game denominations. The wallet signs the bid directly; the source frontend does not need a helper wallet for auction bids."
        right={
          <button
            type="button"
            onClick={() => void loadAuctions()}
            className="h-9 px-3 rounded-sm border border-bone/15 bg-inkA font-mono text-[10px] tracking-[0.18em] text-bone hover:border-orange/60 transition"
          >
            REFRESH
          </button>
        }
      />

      <section>
        <SectionHeader
          eyebrow="Live"
          title="Listing Market"
          subtitle="The highest active bid wins the listing slot when the epoch resolves. Non-winning pooled bids remain ranked for later epochs."
        />
        {readWarning && (
          <div className="mb-4 rounded-sm border border-amber/35 bg-amber/10 px-4 py-3 font-mono text-[10px] text-amber leading-relaxed">
            {readWarning}
          </div>
        )}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Epoch" value={epoch.toString()} sub={durationDays ? `${durationDays} day window` : 'active window'} />
          <Stat label="Closes in" value={formatCountdown(endMs).toUpperCase()} sub={new Date(endMs).toLocaleString()} />
          <Stat label="Total pooled" value={`${formatSol(totalPooled)} SOL`} sub={`${bids.length} candidate tokens`} />
          <Stat label="Leader margin" value={lead ? `${formatSol(lead)} SOL` : '--'} sub={topBid ? short(topBid.tokenMint) : 'no bids'} />
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4 items-start">
        <div className="rounded-sm hairline bg-inkA overflow-hidden">
          <div className="px-4 py-3 border-b border-bone/10 flex items-center justify-between gap-3">
            <div className="font-display text-bone text-2xl leading-none tracking-wide">
              Leaderboard
            </div>
            <div className="font-mono text-[10px] text-boneDim/55">
              {loading ? 'LOADING' : `${bids.length} TOKENS`}
            </div>
          </div>
          <div className="divide-y divide-bone/10">
            {bids.length === 0 && (
              <div className="px-4 py-10 text-center font-mono text-[11px] text-boneDim/60">
                {loading ? 'Loading auction ranks...' : 'No active auction ranks loaded.'}
              </div>
            )}
            {bids.map((bid, index) => {
              const pct = topBid && topBid.totalAmount > BigInt(0)
                ? Math.max(4, Math.min(100, Number((bid.totalAmount * BigInt(10000)) / topBid.totalAmount) / 100))
                : 0;
              return (
                <div key={bid.tokenMint} className="px-4 py-3">
                  <div className="grid grid-cols-[32px_1fr_auto] gap-3 items-center">
                    <div className={`font-display text-2xl leading-none ${index === 0 ? 'text-orange' : 'text-boneDim/60'}`}>
                      #{index + 1}
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono text-[12px] text-bone truncate">
                        {bid.tokenMint}
                      </div>
                      <div className="mt-1 font-mono text-[9px] text-boneDim/50">
                        {bid.bidderCount} bidder{bid.bidderCount === 1 ? '' : 's'} · first bid {new Date(bid.firstBidAt * 1000).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="text-right font-display text-bone text-2xl leading-none tabular-nums">
                      {formatSol(bid.totalAmount)}
                      <span className="ml-1 font-mono text-[10px] text-boneDim/55">SOL</span>
                    </div>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-black/40 overflow-hidden">
                    <div className="h-full rounded-full bg-orange" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-sm hairline bg-inkA p-5">
          <div className="font-display text-bone text-2xl leading-none tracking-wide">
            Place Bid
          </div>
          <p className="mt-2 font-sans text-[12px] text-boneDim/70 leading-relaxed">
            Paste a standard SPL token mint and bid SOL. Token-2022 and freeze-authority mints are rejected before wallet approval.
          </p>
          <div className="mt-5 space-y-3">
            <label className="block">
              <span className="font-mono text-[9px] tracking-[0.18em] text-boneDim/60 uppercase">
                Token mint
              </span>
              <input
                value={candidateMint}
                onChange={(e) => setCandidateMint(e.target.value)}
                className="mt-1 h-11 w-full rounded-sm bg-black/35 border border-bone/15 px-3 font-mono text-[12px] text-bone outline-none focus:border-orange/60"
                placeholder="Mint address"
              />
            </label>
            <label className="block">
              <span className="font-mono text-[9px] tracking-[0.18em] text-boneDim/60 uppercase">
                SOL amount
              </span>
              <input
                value={bidAmount}
                onChange={(e) => setBidAmount(e.target.value)}
                inputMode="decimal"
                className="mt-1 h-11 w-full rounded-sm bg-black/35 border border-bone/15 px-3 font-mono text-[12px] text-bone outline-none focus:border-orange/60"
                placeholder="0.00"
              />
            </label>
            <button
              type="button"
              disabled={!isConnected || submitting || !candidateMint.trim() || !bidAmount.trim()}
              onClick={() => void submitBid()}
              className="h-11 w-full rounded-sm bg-orange text-black font-display text-lg tracking-wide disabled:opacity-45 disabled:cursor-not-allowed hover:brightness-110 transition"
            >
              {submitting ? 'BIDDING...' : 'BID SOL'}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
