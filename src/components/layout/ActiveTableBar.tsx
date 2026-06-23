'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Transaction } from '@solana/web3.js';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { usePathname, useSearchParams } from 'next/navigation';
import { BRAND } from '@/lib/branding';
import Link from 'next/link';
import { ANCHOR_PROGRAM_ID, makeL1Connection } from '@/lib/constants';
import { useMyActiveTables, setMyActiveTablesBoost } from '@/hooks/useMyActiveTables';
import { SFX } from '@/lib/sfx';
import { getQueuesOnChain, type SngPool } from '@/lib/api';
import { getSngPoolPda, getSngQueueMarkerPda, buildLeaveSngPoolInstruction } from '@/lib/onchain-game';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { confirmFundsAction } from '@/lib/funds-confirmation';
import { useToast } from '@/components/toast/ToastProvider';
import { levelAtLeast } from '@/lib/user-config';
import { STATIC_EXPORT } from '@/lib/runtime-mode';

function sngTypeShort(name: SngPool['gameTypeName']): string {
  return name === 'heads_up' ? 'HU' : name === '6max' ? '6-Max' : '9-Max';
}

const ACTIVE_GAMES_KEY = 'fastpoker_active_games';
export const ACTIVE_GAMES_EVENT = 'fastpoker_active_games_changed';
const CURRENT_PROGRAM_ID = ANCHOR_PROGRAM_ID.toBase58();

export interface ActiveGameInfo {
  tablePda: string;
  type: 'cash' | 'sng';
  blinds?: string;
  label?: string;
  maxPlayers?: number;
  timestamp: number;
  programId?: string;
}

type UnfinishedTableCreation = {
  pubkey: string;
  smallBlind?: number;
  bigBlind?: number;
  maxPlayers?: number;
  tokenSymbol?: string;
};

// ── Helpers ──

function loadGames(): ActiveGameInfo[] {
  try {
    const raw = localStorage.getItem(ACTIVE_GAMES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveGames(games: ActiveGameInfo[]) {
  localStorage.setItem(ACTIVE_GAMES_KEY, JSON.stringify(games));
  window.dispatchEvent(new CustomEvent(ACTIVE_GAMES_EVENT));
}

export function addActiveGame(info: Omit<ActiveGameInfo, 'timestamp' | 'programId'>) {
  const games = loadGames().filter(g => g.tablePda !== info.tablePda);
  games.push({ ...info, timestamp: Date.now(), programId: CURRENT_PROGRAM_ID });
  saveGames(games);
}

export function removeActiveGame(tablePda: string) {
  saveGames(loadGames().filter(g => g.tablePda !== tablePda));
}

export function getActiveGames(): ActiveGameInfo[] {
  return loadGames();
}

export function reconcileActiveGames(liveTablePdas: string[]) {
  const live = new Set(liveTablePdas);
  const games = loadGames();
  // Only reconcile SNG games against the server's live list. The L1 PlayerSeat
  // scan that produces `liveTablePdas` can't see a CASH seat while the table is
  // delegated/mid-hand (the seat lives in ER state not yet committed to L1), so
  // the server list is NOT authoritative for cash — pruning against it wiped the
  // cash table the player is actively on. Cash games are client-tracked
  // (setActiveTable on seat) and removed explicitly via removeActiveGame on leave.
  const next = games.filter(g => g.type === 'cash' || live.has(g.tablePda));
  if (next.length !== games.length) saveGames(next);
}

// ── Backward-compatible single-table API (used by cash game page) ──

export interface ActiveTableInfo {
  tablePda: string;
  blinds?: string;
  maxPlayers?: number;
}

export function setActiveTable(info: ActiveTableInfo | null) {
  if (info) {
    addActiveGame({ tablePda: info.tablePda, type: 'cash', blinds: info.blinds, maxPlayers: info.maxPlayers, label: info.blinds ? `Cash ${info.blinds}` : 'Cash Game' });
  } else {
    const games = loadGames();
    const cashIdx = games.findIndex(g => g.type === 'cash');
    if (cashIdx >= 0) {
      games.splice(cashIdx, 1);
      saveGames(games);
    }
  }
}

export function getActiveTable(): ActiveTableInfo | null {
  const games = loadGames();
  const cash = games.find(g => g.type === 'cash');
  return cash ? { tablePda: cash.tablePda, blinds: cash.blinds, maxPlayers: cash.maxPlayers } : null;
}

// ── Component ──

/**
 * Mockup 1.4 tokens: orange-on-ink, thin 44px banner on mobile that sits
 * ABOVE the 56px BottomTabBar (bottom-14 + safe-area), full desktop width
 * under the Navbar. Collapsible.
 */
export function ActiveTableBar() {
  const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  // The game route is /game?table=<pda>, so "the table I'm currently viewing"
  // comes from the query string (not the path).
  const currentTablePda = pathname === '/game' ? (searchParams.get('table') || null) : null;
  const { isConnected: connected, publicKey, sendTransaction } = useUnifiedWallet();
  const { showToast } = useToast();
  const wallet = publicKey?.toBase58() ?? null;
  const [games, setGames] = useState<ActiveGameInfo[]>([]);
  const [queued, setQueued] = useState<SngPool[]>([]);
  const [unfinished, setUnfinished] = useState<UnfinishedTableCreation[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const [leavingKey, setLeavingKey] = useState<string | null>(null);
  // Seated takeover alert: the only surface that used to announce "you're
  // seated" was the SNG join modal. Close it, switch tabs, or refresh while
  // queued and the seating was silent: players blinded out without knowing
  // their game had started. This alert is layout-level, so it reaches the
  // user on every page.
  const [seatAlert, setSeatAlert] = useState<{ tablePda: string; label: string } | null>(null);
  const alertedRef = useRef<Set<string>>(new Set());
  const prevTablesRef = useRef<{ loaded: boolean; pdas: Set<string> }>({ loaded: false, pdas: new Set() });

  // Leave an SNG pool queue from the active-table bar (mirrors the lobby's
  // handleLeavePool): there is no "lobby" inside My Tables, so the queued row's
  // action is LEAVE — it sends the on-chain leave_sng_pool (refund) and strips
  // the row optimistically. pageIndex is read from the on-chain queue_marker
  // (cached SngPool can be stale after a CompactPages / new joins).
  const leaveQueue = useCallback(async (gameType: number, tier: number) => {
    if (!publicKey || !sendTransaction) return;
    const key = `${gameType}-${tier}`;
    setLeavingKey(key);
    try {
      const connection = makeL1Connection();
      const [poolPda] = getSngPoolPda(gameType, tier);
      const [queueMarkerPda] = getSngQueueMarkerPda(poolPda, publicKey);
      const markerInfo = await connection.getAccountInfo(queueMarkerPda, 'confirmed');
      if (!markerInfo) {
        showToast('You are not in this pool queue.', 'info');
        setQueued((prev) => prev.filter((p) => !(p.gameType === gameType && p.tier === tier)));
        return;
      }
      // queue_marker: 8 disc + 32 pool + 32 player + u16 page_index → offset 72
      const pageIndex = markerInfo.data.readUInt16LE(72);
      const tx = new Transaction().add(buildLeaveSngPoolInstruction(publicKey, gameType, tier, pageIndex));
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
      if (!(await confirmFundsAction({
        title: 'Confirm Pool Leave',
        action: 'Leave SNG pool and request refund',
        details: [`Pool: game type ${gameType}, tier ${tier}`],
        transaction: tx,
      }))) {
        return;
      }
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      showToast('Left pool. Refund sent.', 'success');
      setQueued((prev) => prev.filter((p) => !(p.gameType === gameType && p.tier === tier)));
    } catch (e) {
      showToast('Failed to leave pool. Try again.', 'error');
    } finally {
      setLeavingKey(null);
    }
  }, [publicKey, sendTransaction, showToast]);

  const refresh = useCallback(() => setGames(loadGames()), []);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    const onActiveGamesChanged = () => refresh();
    const onStorage = (e: StorageEvent) => { if (e.key === ACTIVE_GAMES_KEY) refresh(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener(ACTIVE_GAMES_EVENT, onActiveGamesChanged);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(ACTIVE_GAMES_EVENT, onActiveGamesChanged);
      window.removeEventListener('storage', onStorage);
    };
  }, [pathname, refresh]);

  // Authoritative table list comes from the shared `useMyActiveTables`
  // singleton — one poll loop, fanned out to every consumer. The verifier
  // block used to live here AND in Lobby.tsx with independent 20s timers.
  const my = useMyActiveTables();
  useEffect(() => {
    if (!connected || !publicKey) {
      if (loadGames().length > 0) saveGames([]);
      setGames([]);
      return;
    }
    if (!my.loaded) return;
    const existing = loadGames();
    const serverPdas = new Set(my.tables.map((t) => t.tablePda).filter(Boolean));
    const serverGames = my.tables
      .filter((t) => t.tablePda)
      .map((t) => {
        const prev = existing.find((g) => g.tablePda === t.tablePda);
        if (prev) return { ...prev, programId: CURRENT_PROGRAM_ID };
        const isCash = t.type === 'cash';
        const typeLabel =
          t.type === 'heads_up' ? 'HU' :
          t.type === '6max'     ? '6-Max' :
          t.type === '9max'     ? '9-Max' : '';
        return {
          tablePda: t.tablePda,
          type: isCash ? 'cash' : 'sng',
          maxPlayers: t.maxPlayers,
          label: isCash ? 'Cash Game' : `SNG ${typeLabel || 'Game'}`,
          timestamp: Date.now(),
          programId: CURRENT_PROGRAM_ID,
        } satisfies ActiveGameInfo;
      });
    // The L1 PlayerSeat scan behind my.tables can miss a CASH seat while the
    // table is delegated/mid-hand (the on-L1 seats_occupied snapshot is stale,
    // so the "am I still seated" bit check drops it). The cash game page writes
    // its own entry via setActiveTable on seat, so keep any client-tracked cash
    // game the server list doesn't report — without this the server poll wiped
    // it and the table never showed at the top. It's pruned explicitly by
    // removeActiveGame() on leave; SNG still trusts the server list (auto-prune).
    const clientCashExtras = existing.filter(
      (g) => g.type === 'cash' && !serverPdas.has(g.tablePda),
    );
    const next = [...serverGames, ...clientCashExtras];
    saveGames(next);
    setGames(next);
  }, [connected, publicKey, my.tables, my.loaded, my.asOfMs]);

  // Detect a NEW seat in the authoritative list and fire the takeover alert
  // (banner + sound + browser notification + auto-redirect countdown). Each
  // table alerts at most once per session. On the first loaded snapshot after
  // a page load we only alert for tables still in phase ≤ 1 (Waiting/Starting,
  // the game can still be made); a mid-hand table after a reload just shows in
  // the bar as before. Cash seats are client-initiated from the table page, so
  // they never need a "you got seated" alert.
  useEffect(() => {
    if (!connected || !my.loaded) return;
    const prev = prevTablesRef.current;
    const pdas = new Set(my.tables.map((t) => t.tablePda));
    const firstLoad = !prev.loaded;
    for (const t of my.tables) {
      if (!t.tablePda || t.type === 'cash' || alertedRef.current.has(t.tablePda)) continue;
      if (currentTablePda === t.tablePda) { alertedRef.current.add(t.tablePda); continue; }
      const isNew = !firstLoad && !prev.pdas.has(t.tablePda);
      const recoverable = firstLoad && (t.phase ?? 99) <= 1;
      alertedRef.current.add(t.tablePda);
      if (!isNew && !recoverable) continue;
      const typeLabel =
        t.type === 'heads_up' ? 'HU' :
        t.type === '6max'     ? '6-Max' :
        t.type === '9max'     ? '9-Max' : 'Game';
      setSeatAlert({ tablePda: t.tablePda, label: `SNG ${typeLabel}` });
      try { SFX.play('tourney-win'); } catch { /* sfx is best-effort */ }
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(`${BRAND.name}: you are seated`, {
            body: 'Your Sit & Go is starting. Take your seat now.',
          });
        }
      } catch { /* notifications are best-effort */ }
      break;
    }
    prevTablesRef.current = { loaded: true, pdas };
  }, [connected, my.loaded, my.tables, my.asOfMs, currentTablePda]);

  // No auto-redirect (user decision: yanking the page mid-read is worse than
  // the risk of ignoring the alert). The floater stays until the player clicks
  // through, dismisses it, or reaches the game page any other way.
  useEffect(() => {
    if (seatAlert && currentTablePda === seatAlert.tablePda) setSeatAlert(null);
  }, [seatAlert, currentTablePda]);

  // While queued for an SNG, seating must surface fast even with the join
  // modal closed: boost the shared poll (5s, cache-bypassing) and ask for
  // notification permission right after the user took the join action, the
  // one moment they clearly want to be interrupted later.
  useEffect(() => {
    setMyActiveTablesBoost(queued.length > 0);
    if (queued.length > 0) {
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
          void Notification.requestPermission();
        }
      } catch { /* notifications are best-effort */ }
    }
    return () => setMyActiveTablesBoost(false);
  }, [queued.length]);

  // Pools the user is QUEUED into but that haven't started a table yet. Surfaced
  // here so players don't "queue and forget" (then get blinded out). Light 20s
  // poll; the lobby owns the precise join/leave UX. Deps are the wallet STRING
  // (not the publicKey object) to keep this effect from re-running every render.
  useEffect(() => {
    if (!connected || !wallet) { setQueued((p) => (p.length ? [] : p)); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const { pools } = await getQueuesOnChain(wallet);
        if (cancelled) return;
        const mine = pools.filter((p) => p.queue?.includes(wallet));
        setQueued((prev) => {
          const key = (arr: SngPool[]) => arr.map((p) => `${p.gameType}/${p.tier}/${p.queueCount}`).join(',');
          return key(prev) === key(mine) ? prev : mine;
        });
      } catch {
        /* leave last-known queued list in place on a transient failure */
      }
    };
    poll();
    const iv = setInterval(poll, 20_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [connected, wallet]);

  useEffect(() => {
    if (!connected || !wallet) {
      setUnfinished((prev) => (prev.length ? [] : prev));
      return;
    }
    let cancelled = false;
    const poll = async () => {
      if (!levelAtLeast('full')) { setUnfinished((prev) => (prev.length ? [] : prev)); return; }
      try {
        let rows: any[] = [];
        if (STATIC_EXPORT) {
          const { discoverLobbyTables } = await import('@/lib/table-discovery');
          rows = await discoverLobbyTables({ creator: wallet, gameType: 3 });
        } else {
          const res = await fetch(`/api/tables/list?creator=${wallet}&gameType=3`, { cache: 'no-store' });
          if (!res.ok) return;
          const data = await res.json();
          if (data?.serverRpcConfigured === false) {
            const { discoverLobbyTables } = await import('@/lib/table-discovery');
            rows = await discoverLobbyTables({ creator: wallet, gameType: 3 });
          } else {
            rows = Array.isArray(data.tables) ? data.tables : [];
          }
        }
        if (cancelled) return;
        const next: UnfinishedTableCreation[] = rows
          .filter((t: any) => !t.isDelegated && (t.currentPlayers ?? 0) === 0)
          .map((t: any) => ({
            pubkey: String(t.pubkey),
            smallBlind: Number(t.smallBlind ?? 0),
            bigBlind: Number(t.bigBlind ?? 0),
            maxPlayers: Number(t.maxPlayers ?? 0),
            tokenSymbol: typeof t.tokenSymbol === 'string' ? t.tokenSymbol : undefined,
          }));
        setUnfinished((prev) => {
          const key = (arr: UnfinishedTableCreation[]) => arr.map((t) => `${t.pubkey}/${t.bigBlind}/${t.maxPlayers}`).join(',');
          return key(prev) === key(next) ? prev : next;
        });
      } catch {
        /* leave last-known unfinished list in place on a transient failure */
      }
    };
    poll();
    const iv = setInterval(poll, 20_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [connected, wallet]);

  const visible = games.filter(g => g.tablePda !== currentTablePda && g.programId === CURRENT_PROGRAM_ID);

  if (visible.length === 0 && queued.length === 0 && unfinished.length === 0 && !seatAlert) return null;

  const headerParts: string[] = [];
  if (visible.length > 0) headerParts.push(`${visible.length} active game${visible.length !== 1 ? 's' : ''}`);
  if (queued.length > 0) headerParts.push(`${queued.length} queued`);
  if (unfinished.length > 0) headerParts.push(`${unfinished.length} unfinished table creation${unfinished.length !== 1 ? 's' : ''}`);

  const seatAlertBanner = seatAlert ? (
    <div className="fixed inset-x-0 top-16 z-50 flex justify-center px-4 pointer-events-none">
      {/* flex-wrap + truncate keep this inside a 360px phone: the buttons drop
          to a second row instead of pushing past the viewport edge. */}
      <div className="pointer-events-auto bg-ink border border-orange/40 rounded-lg shadow-[0_8px_40px_rgba(0,0,0,0.85),0_0_30px_rgba(242,106,31,0.35)] px-4 py-3 flex items-center flex-wrap gap-x-4 gap-y-2 max-w-lg w-full">
        <span className="w-2 h-2 rounded-full bg-orange active-breath shrink-0" />
        <div className="min-w-0 flex-1 basis-44">
          <div className="text-bone text-sm font-bold uppercase tracking-wider truncate">
            You&apos;re seated · {seatAlert.label}
          </div>
          <div className="text-boneDim text-xs truncate">
            Your game is starting
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          <button
            type="button"
            onClick={() => setSeatAlert(null)}
            className="px-2.5 py-1.5 rounded-md border border-bone/20 text-[11px] text-boneDim hover:text-bone hover:border-bone/40 transition-colors"
          >
            Dismiss
          </button>
          <Link
            href={`/game?table=${seatAlert.tablePda}`}
            onClick={() => setSeatAlert(null)}
            className="px-3 py-1.5 rounded-md btn-orange text-xs font-bold whitespace-nowrap"
          >
            Go to table →
          </Link>
        </div>
      </div>
    </div>
  ) : null;

  if (visible.length === 0 && queued.length === 0 && unfinished.length === 0) {
    return seatAlertBanner;
  }

  // Bar is static / in-flow at the top (just under the navbar) on every
  // breakpoint. Previously fixed to the bottom on mobile; moved up so seated
  // tables sit at the top of the page on phones too, matching desktop. Bonus:
  // no longer overlays the BettingControls on /game/ pages.
  return (
    <>
    {seatAlertBanner}
    <div className="glass-panel hairline-b static left-0 right-0 z-30">
      <div className="max-w-7xl mx-auto px-4">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full py-1.5 flex items-center justify-between text-xs"
        >
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-orange active-breath" />
            <span className="text-boneDim uppercase tracking-wider">
              {headerParts.join(' · ')}
            </span>
          </div>
          <svg
            className={`w-3 h-3 text-orange/70 transition-transform ${collapsed ? '' : 'rotate-180'}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {!collapsed && (
          <div className="pb-2 space-y-1">
            {visible.map(g => (
              <div key={g.tablePda} className="flex items-center justify-between py-1 px-2 rounded-md hairline bg-ink/40">
                <div className="flex items-center gap-2 text-xs min-w-0">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                    g.type === 'sng'
                      ? 'bg-amber/15 text-amber border border-amber/25'
                      : 'bg-orange/10 text-orange border border-orange/25'
                  }`}>
                    {g.type === 'sng' ? 'SNG' : 'Cash'}
                  </span>
                  <span className="text-bone truncate">
                    {g.label || g.tablePda.slice(0, 8) + '...'}
                  </span>
                  {g.blinds && <span className="text-boneDim">{g.blinds}</span>}
                </div>
                <Link
                  href={`/game?table=${g.tablePda}`}
                  className="shrink-0 ml-2 px-2.5 py-1 rounded-md btn-orange text-[11px]"
                >
                  Go to →
                </Link>
              </div>
            ))}
            {queued.map(p => (
              <div key={`q-${p.gameType}-${p.tier}`} className="flex items-center justify-between py-1 px-2 rounded-md hairline bg-ink/40">
                <div className="flex items-center gap-2 text-xs min-w-0">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber/10 text-amber/80 border border-amber/20">
                    Queued
                  </span>
                  <span className="text-bone truncate">SNG {sngTypeShort(p.gameTypeName)} · {p.tierName}</span>
                  <span className="text-boneDim tabular-nums">{p.queueCount}/{p.maxPlayers} waiting</span>
                </div>
                <button
                  type="button"
                  onClick={() => leaveQueue(p.gameType, p.tier)}
                  disabled={leavingKey === `${p.gameType}-${p.tier}`}
                  title="Leave this SNG queue (refund sent)"
                  className="shrink-0 ml-2 px-2.5 py-1 rounded-md border border-red-400/25 text-[11px] text-red-300/80 hover:text-red-300 hover:border-red-400/50 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                >
                  {leavingKey === `${p.gameType}-${p.tier}` ? 'Leaving…' : 'Leave'}
                </button>
              </div>
            ))}
            {unfinished.map(t => (
              <div key={`u-${t.pubkey}`} className="flex items-center justify-between py-1 px-2 rounded-md hairline bg-amber/10 border border-amber/25">
                <div className="flex items-center gap-2 text-xs min-w-0">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber/15 text-amber border border-amber/35">
                    Unfinished
                  </span>
                  <span className="text-bone truncate">Table creation</span>
                  <span className="text-boneDim tabular-nums">
                    {t.maxPlayers ? `${t.maxPlayers}-max · ` : ''}{t.pubkey.slice(0, 4)}…{t.pubkey.slice(-4)}
                  </span>
                </div>
                <Link
                  href={`/my-tables/create?resume=${t.pubkey}`}
                  className="shrink-0 ml-2 px-2.5 py-1 rounded-md btn-orange text-[11px] shadow-[0_0_14px_rgba(255,198,58,0.45)] animate-pulse"
                >
                  Finish Setup →
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
    </>
  );
}
