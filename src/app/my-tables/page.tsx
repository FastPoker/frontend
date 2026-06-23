'use client';

// ══════════════════════════════════════════════════════════════════════
// MY TABLES · the cash tables this wallet created (and the rake they earned).
//
// Standalone wallet-created table list. The hosted app can read this from a
// private indexer route; the standalone discovers wallet tables ON-CHAIN via
// discoverMyCashTables
// (gPA scan, cached 60s) and read the rake accounting fields straight off each
// Table account with TABLE_OFFSETS. No server, the creator's own wallet only.
//
// Caveat: the on-chain discovery needs a gPA-capable RPC (Helius/QuickNode). On
// the free public pool gPA is blocked, so the list comes back empty — the page
// surfaces a hint to set a BYO RPC. "Pending next sweep" (the indexer-only
// pending-rake figure) is not derivable client-side, so it's omitted.
// ══════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PublicKey } from '@solana/web3.js';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { useConnectModal } from '@/components/wallet/FastPokerConnectModal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { makeL1Connection, TABLE_OFFSETS, POKER_MINT, isUsdcMint } from '@/lib/constants';
import { discoverMyCashTables } from '@/lib/table-discovery';
import { getMultipleAccountsInfoChunked } from '@/lib/onchain-game';

interface CreatorTable {
  tablePda: string;
  maxPlayers: number;
  playerCount: number;
  smallBlind: number;
  bigBlind: number;
  isPrivate: boolean;
  isLive: boolean;
  tokenMint: string;
  tokenSymbol: string;
  decimals: number;
  rakeCap: number;
  lifetimeRake: number; // creator_rake_total (on-chain, never resets)
}

// Resolve a display symbol + decimals from a token mint. SOL/$FP are 9-decimal,
// USDC is 6. Anything else (listed SPL) we can't name cheaply client-side, so
// fall back to a short mint + a safe 9 decimals (display only).
function tokenMeta(mint: string): { symbol: string; decimals: number } {
  if (mint === PublicKey.default.toBase58()) return { symbol: 'SOL', decimals: 9 };
  if (mint === POKER_MINT.toBase58()) return { symbol: '$FP', decimals: 9 };
  try {
    if (isUsdcMint(new PublicKey(mint))) return { symbol: 'USDC', decimals: 6 };
  } catch { /* ignore */ }
  return { symbol: mint.slice(0, 4) + '…', decimals: 9 };
}

// Token-aware formatter. SOL/$FP get up to 4 decimals, USDC 2; trailing zeros
// are stripped so "0.5000 SOL" reads "0.5".
function fmtAmt(raw: number, decimals: number): string {
  const v = raw / 10 ** decimals;
  if (v === 0) return '0';
  const maxDp = decimals >= 9 ? 4 : 2;
  const s = v.toFixed(v < 1 ? maxDp : 2);
  return s.replace(/\.?0+$/, '');
}

function tableSizeLabel(maxPlayers: number): string {
  if (maxPlayers === 2) return 'Heads-Up';
  return `${maxPlayers}-Max`;
}

function MetricStat({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="font-mono text-[9px] uppercase tracking-wider text-boneDim/60">{label}</span>
      <span className={`font-display tracking-wide tabular-nums text-lg leading-none ${accent ? 'text-orangeHi' : 'text-bone'}`}>
        {value}
        {unit ? <span className="text-[11px] text-boneDim ml-1 font-mono tracking-normal">{unit}</span> : null}
      </span>
    </div>
  );
}

export default function MyTablesPage() {
  const { publicKey, isConnected: connected } = useUnifiedWallet();
  const { open: openConnect } = useConnectModal();
  const [tables, setTables] = useState<CreatorTable[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const wallet = publicKey?.toBase58() ?? null;

  useEffect(() => {
    if (!wallet) { setTables(null); return; }
    let cancelled = false;
    setLoading(true);
    setErr(null);

    (async () => {
      try {
        // 1) On-chain discovery: cash tables this wallet created or sits at.
        const discovered = await discoverMyCashTables(wallet, { force: true });
        // Keep only tables this wallet CREATED (discovery also returns seated-at).
        const mine = discovered.filter((t) => t.state.creator.toBase58() === wallet);
        if (mine.length === 0) {
          if (!cancelled) setTables([]);
          return;
        }

        // 2) Re-read each Table account to pull the rake accounting fields that
        //    aren't on the parsed TableState (creator_rake_total / rake_cap).
        const conn = makeL1Connection();
        const infos = await getMultipleAccountsInfoChunked(
          conn,
          mine.map((t) => new PublicKey(t.pubkey)),
        );

        const rows: CreatorTable[] = mine.map((t, i) => {
          const meta = tokenMeta(t.state.tokenMint);
          let lifetimeRake = 0;
          let rakeCap = 0;
          const info = infos[i];
          if (info) {
            const data = Buffer.from(info.data);
            const O = TABLE_OFFSETS;
            if (data.length >= O.CREATOR_RAKE_TOTAL + 8) lifetimeRake = Number(data.readBigUInt64LE(O.CREATOR_RAKE_TOTAL));
            if (data.length >= O.RAKE_CAP + 8) rakeCap = Number(data.readBigUInt64LE(O.RAKE_CAP));
          }
          return {
            tablePda: t.pubkey,
            maxPlayers: t.state.maxPlayers,
            playerCount: t.state.currentPlayers,
            smallBlind: t.state.smallBlind,
            bigBlind: t.state.bigBlind,
            isPrivate: t.state.isPrivate,
            isLive: t.isDelegated,
            tokenMint: t.state.tokenMint,
            tokenSymbol: meta.symbol,
            decimals: meta.decimals,
            rakeCap,
            lifetimeRake,
          };
        });
        if (!cancelled) setTables(rows);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [wallet]);

  // Lifetime rake totals, grouped by token symbol (can't sum SOL + $FP).
  const totalsByToken = useMemo(() => {
    const acc: Record<string, { decimals: number; lifetime: number }> = {};
    for (const t of tables ?? []) {
      const cur = acc[t.tokenSymbol] ?? { decimals: t.decimals, lifetime: 0 };
      cur.lifetime += t.lifetimeRake;
      acc[t.tokenSymbol] = cur;
    }
    return acc;
  }, [tables]);

  return (
    <main className="max-w-[1100px] mx-auto px-5 md:px-8 py-10 pb-16">
      <SectionHeader
        eyebrow="Creator"
        title="My Tables"
        subtitle="Tables you created and the lifetime rake they've earned you. Rake pays out to your wallet automatically (no claim step) roughly every minute."
        right={
          <Link href="/my-tables/create" className="btn-orange px-4 py-2 text-sm font-display tracking-wide rounded-md whitespace-nowrap">
            + Create table
          </Link>
        }
      />

      {!connected || !wallet ? (
        <div className="glass-room px-6 py-12 text-center">
          <p className="text-bone/70 mb-4">Connect your wallet to see the tables you&apos;ve created.</p>
          <button onClick={openConnect} className="btn-orange px-5 py-2.5 text-sm font-display tracking-wide rounded-md">
            Connect wallet
          </button>
        </div>
      ) : loading && tables === null ? (
        <div className="glass-room px-5 py-10 text-center text-xs text-bone/50 font-mono">Loading your tables…</div>
      ) : err ? (
        <div className="glass-room px-5 py-10 text-center text-xs text-red-300/80 font-mono">Couldn&apos;t load tables: {err}</div>
      ) : (tables?.length ?? 0) === 0 ? (
        <div className="glass-room px-6 py-12 text-center">
          <p className="text-bone/70 mb-1.5 font-display text-lg tracking-wide">No tables yet</p>
          <p className="text-boneDim text-sm mb-5">Create a cash table and you&apos;ll earn 50% of every hand&apos;s rake, paid straight to your wallet.</p>
          <Link href="/my-tables/create" className="btn-orange px-5 py-2.5 text-sm font-display tracking-wide rounded-md">
            Create your first table
          </Link>
          <p className="mt-5 text-[10px] leading-relaxed text-boneDim/50 font-mono">
            Table discovery reads the chain directly and needs a gPA-capable RPC. If you&apos;re on the free public
            pool, set your own RPC in settings and your tables will appear here.
          </p>
        </div>
      ) : (
        <>
          {/* Summary: lifetime rake earned per token */}
          <div className="glass-sub rounded-lg px-5 py-4 mb-5 flex flex-wrap items-center gap-x-8 gap-y-4">
            <MetricStat label="Tables" value={String(tables!.length)} />
            <div className="w-px self-stretch bg-white/[0.06] hidden sm:block" />
            {Object.entries(totalsByToken).map(([sym, t]) => (
              <MetricStat key={`life-${sym}`} label="Lifetime rake" value={fmtAmt(t.lifetime, t.decimals)} unit={sym} accent />
            ))}
          </div>

          {/* Table cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {tables!.map((t) => {
              const capLabel = t.rakeCap > 0
                ? `cap ${fmtAmt(t.rakeCap, t.decimals)} ${t.tokenSymbol}`
                : 'uncapped';
              return (
                <Link
                  key={t.tablePda}
                  href={`/game?table=${t.tablePda}`}
                  className="glass-room hairline rounded-lg p-4 hover:border-orange/40 transition-colors group"
                >
                  {/* Header row: size + token + status */}
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-display tracking-wide text-bone text-base">{tableSizeLabel(t.maxPlayers)}</span>
                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-boneDim">
                        {fmtAmt(t.smallBlind, t.decimals)}/{fmtAmt(t.bigBlind, t.decimals)} {t.tokenSymbol}
                      </span>
                      {t.isPrivate && (
                        <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.05] text-boneDim/70">Private</span>
                      )}
                    </div>
                    <span className={`flex items-center gap-1.5 font-mono text-[10px] whitespace-nowrap ${t.isLive ? 'text-emerald-300/90' : 'text-boneDim/70'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${t.isLive ? 'bg-emerald-400 animate-pulse' : 'bg-boneDim/40'}`} />
                      {t.isLive ? 'Live' : 'Idle'}
                      <span className="text-boneDim/50">· {t.playerCount}/{t.maxPlayers}</span>
                    </span>
                  </div>

                  {/* Rake accounting */}
                  <div className="flex items-end justify-between gap-4 mb-3">
                    <MetricStat label="Lifetime rake earned" value={fmtAmt(t.lifetimeRake, t.decimals)} unit={t.tokenSymbol} accent />
                  </div>

                  {/* Footer: rake rule + open hint */}
                  <div className="flex items-center justify-between gap-3 pt-2 hairline-t">
                    <span className="font-mono text-[10px] text-boneDim/70">
                      5% rake · {capLabel} · you keep 50%
                    </span>
                    <span className="font-mono text-[10px] text-orange/70 group-hover:text-orangeHi transition-colors">Open →</span>
                  </div>
                </Link>
              );
            })}
          </div>

          <p className="mt-5 text-[11px] leading-relaxed text-boneDim/60 font-mono">
            Lifetime rake = total earned across every hand (on-chain, never resets). Your 50% share is transferred to
            your wallet automatically on each crank sweep, no claim needed. Rake splits 50% creator / 20% dealers /
            20% stakers / 10% Platform Fee.
          </p>
        </>
      )}
    </main>
  );
}
