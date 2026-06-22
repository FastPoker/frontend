'use client';

/**
 * Lightweight cash-tables surface for the standalone build.
 *
 * The standalone has no backend/indexer, so it does NOT enumerate every cash
 * table on chain (a getProgramAccounts scan free RPCs choke on). Instead:
 *   - SEARCH: paste a table address (PDA) → read that one account → if it's a
 *     cash game, show it and let you open it.
 *   - YOUR TABLES: every cash table you open / find is remembered in
 *     localStorage and re-read on chain here, so your own tables persist
 *     without any server. Dead/non-cash entries self-prune on load.
 *
 * Cost is bounded: one getMultipleAccounts for the saved list + one
 * getAccountInfo per search. Works on the free pool at any request level.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { PublicKey } from '@solana/web3.js';
import { cn } from '@/lib/utils';
import { makeL1Connection, POKER_MINT, USDC_MINT } from '@/lib/constants';
import { parseTableState, OnChainGameType, getMultipleAccountsInfoChunked, type TableState } from '@/lib/onchain-game';
import { discoverMyCashTables } from '@/lib/table-discovery';

const LS_KEY = 'fp.cashTables.v1';
const MAX_SAVED = 50;
const SOL_MINT = PublicKey.default.toBase58();
const PHASE_NAMES = ['Waiting', 'Starting', 'Preflop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete'];

function loadSaved(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const a = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function persist(list: string[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

/** Record a cash table PDA so it shows up under the user's Cash tab next time. */
export function rememberCashTable(pda: string): void {
  const cur = loadSaved();
  if (cur.includes(pda)) return;
  persist([pda, ...cur]);
}

function tokenMeta(mint: string): { symbol: string; decimals: number; icon?: string } {
  if (mint === SOL_MINT) return { symbol: 'SOL', decimals: 9, icon: '/tokens/sol.svg' };
  if (mint === POKER_MINT.toBase58()) return { symbol: '$FP', decimals: 9, icon: '/brand/app-icon.png' };
  if (mint === USDC_MINT.toBase58()) return { symbol: 'USDC', decimals: 6, icon: '/tokens/usdc.svg' };
  return { symbol: 'TOKEN', decimals: 9 };
}
function fmtBB(bb: number, decimals: number): string {
  const v = bb / 10 ** decimals;
  if (v >= 1) return v.toFixed(v % 1 === 0 ? 0 : 2);
  return parseFloat(v.toPrecision(3)).toString();
}

interface Row {
  pda: string;
  sb: number;
  bb: number;
  players: number;
  max: number;
  mint: string;
  phase: number;
  isPrivate: boolean;
  mine: boolean;
}

export function CashStandalone({ myWallet }: { myWallet?: string | null }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const rowFromState = useCallback(
    (pda: string, ts: TableState | null): Row | null => {
      if (!ts || ts.gameType !== OnChainGameType.CashGame) return null;
      return {
        pda,
        sb: ts.smallBlind,
        bb: ts.bigBlind,
        players: ts.currentPlayers,
        max: ts.maxPlayers,
        mint: ts.tokenMint,
        phase: ts.phase,
        isPrivate: ts.isPrivate,
        mine: !!myWallet && ts.creator.toBase58() === myWallet,
      };
    },
    [myWallet],
  );

  // Load the user's cash tables:
  //   (1) AUTO-DISCOVER created + seated tables via the shared, CACHED helper
  //       (one getProgramAccounts sweep per 60s, not per tab-open — that's the
  //       credit win). Pre-parsed, so no second read. Free pool → returns [].
  //   (2) MERGE with locally-saved (paste-by-address) tables not already found,
  //       which we read individually.
  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const discovered = myWallet ? await discoverMyCashTables(myWallet, { force }).catch(() => []) : [];
      const discoveredRows = discovered.map((d) => rowFromState(d.pubkey, d.state)).filter((r): r is Row => !!r);
      const found = new Set(discoveredRows.map((r) => r.pda));

      // Saved PDAs the discovery didn't surface (added via search) — read them.
      const savedExtra = loadSaved().filter((p) => !found.has(p));
      let savedRows: Row[] = [];
      if (savedExtra.length) {
        const conn = makeL1Connection();
        const keys = savedExtra
          .map((s) => { try { return new PublicKey(s); } catch { return null; } })
          .filter((k): k is PublicKey => k !== null);
        const infos = await getMultipleAccountsInfoChunked(conn, keys);
        savedRows = infos
          .map((info, i) => (info ? rowFromState(keys[i].toBase58(), parseTableState(Buffer.from(info.data))) : null))
          .filter((r): r is Row => !!r);
      }

      const rows = [...discoveredRows, ...savedRows];
      persist([...new Set(rows.map((r) => r.pda))]); // keep discovered + valid saved; prune dead
      setRows(rows);
    } catch {
      /* leave whatever we had; transient RPC failure */
    } finally {
      setLoading(false);
    }
  }, [myWallet, rowFromState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doSearch = useCallback(async () => {
    const raw = search.trim();
    if (!raw) return;
    let key: PublicKey;
    try {
      key = new PublicKey(raw);
    } catch {
      setSearchErr('Not a valid Solana address.');
      return;
    }
    setSearching(true);
    setSearchErr(null);
    try {
      const conn = makeL1Connection();
      const info = await conn.getAccountInfo(key);
      if (!info) {
        setSearchErr('No account exists at that address.');
        return;
      }
      const r = rowFromState(key.toBase58(), parseTableState(Buffer.from(info.data)));
      if (!r) {
        setSearchErr('That address is not a cash table.');
        return;
      }
      rememberCashTable(r.pda);
      setRows((prev) => [r, ...prev.filter((x) => x.pda !== r.pda)]);
      setSearch('');
    } catch {
      setSearchErr('Lookup failed (RPC). Try again.');
    } finally {
      setSearching(false);
    }
  }, [search, rowFromState]);

  const open = (pda: string) => {
    rememberCashTable(pda);
    router.push(`/game?table=${pda}`);
  };
  const forget = (pda: string) => {
    persist(loadSaved().filter((p) => p !== pda));
    setRows((prev) => prev.filter((r) => r.pda !== pda));
  };

  return (
    <div className="mx-auto max-w-3xl px-1">
      {/* Search by address */}
      <div className="rounded-xl border border-orange/15 bg-black/30 p-4 sm:p-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-orange/80 mb-2">Open a cash table</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSearchErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doSearch();
            }}
            placeholder="Paste a cash table address (PDA)…"
            spellCheck={false}
            className="flex-1 rounded-lg border border-bone/15 bg-black/40 px-3 py-2 font-mono text-[12px] text-bone outline-none focus:border-orange/50"
          />
          <button
            onClick={() => void doSearch()}
            disabled={searching || !search.trim()}
            className="rounded-lg bg-orange px-4 py-2 text-[12px] font-bold text-black hover:bg-orangeHi disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {searching ? 'Looking…' : 'Find'}
          </button>
        </div>
        {searchErr && <div className="mt-2 font-mono text-[11px] text-red-400">{searchErr}</div>}
        <p className="mt-3 font-mono text-[10px] leading-relaxed text-boneDim/50">
          This lightweight build doesn&apos;t list every cash table. Paste a table&apos;s address to open it, or open
          one and it&apos;s saved below. Share a table by sending its address.
        </p>
      </div>

      {/* Your / saved tables */}
      <div className="mt-5 flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-boneDim/60">Your cash tables</div>
        <button
          onClick={() => void refresh(true)}
          disabled={loading}
          className="font-mono text-[9px] uppercase tracking-[0.16em] text-boneDim/50 hover:text-bone disabled:opacity-40"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="mt-3 rounded-xl border border-bone/10 bg-black/20 px-6 py-10 text-center">
          <div className="font-mono text-[12px] text-boneDim/70">
            {loading ? 'Reading your tables…' : 'No saved cash tables yet.'}
          </div>
          {!loading && (
            <div className="mt-1 font-mono text-[10px] text-boneDim/45">
              Find one by address above to add it here.
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {rows.map((r) => {
            const tok = tokenMeta(r.mint);
            const live = r.phase !== 0 && r.phase !== 7;
            return (
              <div
                key={r.pda}
                className="flex items-center gap-3 rounded-lg border border-bone/10 bg-black/25 px-3 py-2.5 hover:border-orange/30 transition"
              >
                <div className="flex items-center gap-1.5 shrink-0">
                  {tok.icon ? (
                    <Image src={tok.icon} alt={tok.symbol} width={16} height={16} className="rounded-full" />
                  ) : (
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-bone/30 text-[7px] font-bold text-bone/70">
                      {tok.symbol.slice(0, 1)}
                    </span>
                  )}
                  <span className="font-mono text-[12px] tabular-nums text-bone">
                    {fmtBB(r.bb, tok.decimals)}
                  </span>
                  <span className="font-mono text-[9px] text-boneDim/50">{tok.symbol} BB</span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-bone/80 truncate">
                      {r.pda.slice(0, 4)}…{r.pda.slice(-4)}
                    </span>
                    {r.mine && (
                      <span className="rounded bg-orange/15 px-1.5 py-[1px] text-[8px] font-bold uppercase tracking-wider text-orange">
                        yours
                      </span>
                    )}
                    {r.isPrivate && (
                      <span className="rounded bg-bone/10 px-1.5 py-[1px] text-[8px] font-bold uppercase tracking-wider text-boneDim/70">
                        private
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[9px] text-boneDim/50 tracking-wider">
                    {r.players}/{r.max} seated · {PHASE_NAMES[r.phase] ?? '—'}
                    {live && <span className="ml-1 text-emerald-400">live</span>}
                  </div>
                </div>

                <button
                  onClick={() => router.push(`/game?table=${r.pda}&spectate=1`)}
                  className="shrink-0 rounded-md border border-bone/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-boneDim/70 hover:text-bone transition"
                >
                  Watch
                </button>
                <button
                  onClick={() => open(r.pda)}
                  className="shrink-0 rounded-md bg-orange/90 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-black hover:bg-orange transition"
                >
                  Open
                </button>
                <button
                  onClick={() => forget(r.pda)}
                  title="Forget this table"
                  className="shrink-0 text-boneDim/40 hover:text-red-400 text-[14px] leading-none px-1"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
