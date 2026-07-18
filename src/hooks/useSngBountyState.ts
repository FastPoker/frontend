'use client';

import { useEffect, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { makeL1Connection } from '@/lib/constants';
import { computeRawMultBps, getEmissionCtrlPda, getSngJackpotTableStatePda, parseEmissionCtrl, parseSngJackpotTableState } from '@/lib/emission-onchain';
import { getSngDuelPda, parseSngDuelState, type SngDuelState } from '@/lib/sng-duel';

// JSON shape returned by /api/sitngos/bounty-state (bigints as decimal strings).
export interface SngBountySnapshot {
  table: string;
  maxPlayers: number;
  paid: boolean;
  finalBlindLevel: number;
  creditedHandNumber: string;
  lastAccountedHand: string;
  knockoutCreditUnits: string[]; // [9] SOL bounty weight each seat EARNED
  fpBountyWeightUnits: string[]; // [9] $FP bounty weight each seat EARNED
  eliminatedBountyUnits: string[]; // [9] bounty ON each seat's head
  eliminationLevel: number[]; // [9]
  foldCounts: number[]; // [9]
  lastDuelBlindLevel: number;
  duelActive: boolean;
  duelRound: number;
  duelSeatA: number;
  duelSeatB: number;
  duelChoiceA: number;
  duelChoiceB: number;
  duelStartedHand: string;
  duelDeadlineTs: string;
  // ---- Flat Bounty (ruleset 1) ----
  // Arrays: knockoutCreditUnits = HELD points (SOL weight), fpBountyWeightUnits
  // = FP mirror; eliminatedBountyUnits is layout-retained and stays zero.
  pointsSeeded: boolean;
  ruleset: number; // always 1 (flat bounty)
  seededCount: number;
  duelPauseStartedTs: string;
}

/** The table's on-chain $FP pool truth (SngJackpotTableState) + current governor rate. */
export interface SngPoolSnapshot {
  grandFunded: boolean;
  grossUnrefined: string;
  normalUnrefined: string;
}

interface BountyApiResponse {
  success: boolean;
  source?: 'TEE' | 'L1';
  initialized?: boolean;
  pda?: string;
  fetchedAt?: number;
  state?: SngBountySnapshot;
  pool?: SngPoolSnapshot | null;
  emissionRateBps?: number | null;
  error?: string;
}

// Short cache: duel state mutates on the ER second-to-second; a 5s floor made every consumer
// (including the 1.2s duel-overlay poll) read stale data and feel laggy/out of sync.
const CACHE_MS = 1_200;
const cache = new Map<string, { body: BountyApiResponse; at: number; inflight?: Promise<BountyApiResponse> }>();

function serializeState(s: SngDuelState): SngBountySnapshot {
  return {
    table: s.table.toBase58(), maxPlayers: s.maxPlayers, paid: s.paid,
    finalBlindLevel: s.finalBlindLevel, creditedHandNumber: s.creditedHandNumber.toString(),
    lastAccountedHand: s.lastAccountedHand.toString(),
    knockoutCreditUnits: s.knockoutCreditUnits.map(String),
    fpBountyWeightUnits: s.fpBountyWeightUnits.map(String),
    eliminatedBountyUnits: s.eliminatedBountyUnits.map(String),
    eliminationLevel: s.eliminationLevel, foldCounts: s.foldCounts,
    lastDuelBlindLevel: s.lastDuelBlindLevel, duelActive: s.duelActive,
    duelRound: s.duelRound, duelSeatA: s.duelSeatA, duelSeatB: s.duelSeatB,
    duelChoiceA: s.duelChoiceA, duelChoiceB: s.duelChoiceB,
    duelStartedHand: s.duelStartedHand.toString(), duelDeadlineTs: s.duelDeadlineTs.toString(),
    pointsSeeded: s.pointsSeeded, ruleset: s.ruleset, seededCount: s.seededCount,
    duelPauseStartedTs: s.duelPauseStartedTs.toString(),
  };
}

/** Static/LIGHT fallback: reads active state through the player's TEE session. */
async function loadBountyDirect(tableStr: string, teeConnection?: Connection | null): Promise<BountyApiResponse> {
  const table = new PublicKey(tableStr);
  const [duelPda] = getSngDuelPda(table);
  const [jackpotPda] = getSngJackpotTableStatePda(table);
  const [emissionCtrlPda] = getEmissionCtrlPda();
  const keys = [duelPda, jackpotPda, emissionCtrlPda];
  let accounts: Awaited<ReturnType<Connection['getMultipleAccountsInfo']>> | null = null;
  let source: 'TEE' | 'L1' = 'L1';

  if (teeConnection) {
    try {
      accounts = await teeConnection.getMultipleAccountsInfo(keys, 'confirmed');
      if (accounts[0]) source = 'TEE';
    } catch {
      // Undelegated tables and a not-yet-ready player session are read from L1 below.
    }
  }

  if (!accounts || accounts.some((account) => !account)) {
    const l1Accounts = await makeL1Connection().getMultipleAccountsInfo(keys, 'confirmed');
    accounts = accounts
      ? accounts.map((account, index) => account ?? l1Accounts[index])
      : l1Accounts;
  }

  const [duelAccount, jackpotAccount, emissionCtrlAccount] = accounts;
  let pool: SngPoolSnapshot | null = null;
  let emissionRateBps: number | null = null;
  try {
    if (jackpotAccount) {
      const jackpot = parseSngJackpotTableState(Buffer.from(jackpotAccount.data));
      pool = {
        grandFunded: jackpot.grandFunded,
        grossUnrefined: jackpot.grossUnrefined.toString(),
        normalUnrefined: jackpot.normalUnrefined.toString(),
      };
    }
  } catch { /* Legacy or absent jackpot state falls back to local estimates. */ }
  try {
    if (emissionCtrlAccount) {
      emissionRateBps = computeRawMultBps(
        parseEmissionCtrl(Buffer.from(emissionCtrlAccount.data)),
        Math.floor(Date.now() / 1000),
      );
    }
  } catch { /* Controller is optional for a local pool estimate. */ }

  if (!duelAccount) {
    return { success: true, initialized: false, pda: duelPda.toBase58(), source, pool, emissionRateBps, fetchedAt: Date.now() };
  }
  return {
    success: true, initialized: true, pda: duelPda.toBase58(), source, pool, emissionRateBps,
    fetchedAt: Date.now(), state: serializeState(parseSngDuelState(Buffer.from(duelAccount.data))),
  };
}

async function loadBounty(table: string, teeConnection?: Connection | null, force = false): Promise<BountyApiResponse> {
  const now = Date.now();
  const entry = cache.get(table);
  if (!force && entry && now - entry.at < CACHE_MS) return entry.body;
  if (!force && entry?.inflight) return entry.inflight;

  const inflight = fetch(`/api/sitngos/bounty-state?table=${encodeURIComponent(table)}`, { cache: 'no-store' })
    .then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) throw new Error((body as BountyApiResponse | null)?.error || 'Bounty API unavailable');
      return body as BountyApiResponse;
    })
    .catch(() => loadBountyDirect(table, teeConnection))
    .then((body) => {
      cache.set(table, { body, at: Date.now() });
      logDuelTransitions(table, body);
      return body;
    })
    .finally(() => {
      const e = cache.get(table);
      if (e) e.inflight = undefined;
    });

  cache.set(table, { body: entry?.body ?? { success: false }, at: entry?.at ?? 0, inflight });
  return inflight;
}

// #6 debugging: every duel sidecar transition lands in FP-DEBUG with wall-clock deltas, so
// "it went super fast" turns into exact numbers (activation -> choices -> resolve as SEEN by
// this client, which is what the overlay can render). One log per fetch, not per consumer.
const duelTrace = new Map<
  string,
  { active: boolean; round: number; choiceA: number; choiceB: number; sinceMs: number }
>();

function logDuelTransitions(table: string, body: BountyApiResponse) {
  const s = body?.state;
  if (!s) return;
  const prev = duelTrace.get(table);
  const now = Date.now();
  const cur = {
    active: !!s.duelActive,
    round: s.duelRound ?? 0,
    choiceA: s.duelChoiceA ?? 0,
    choiceB: s.duelChoiceB ?? 0,
    sinceMs: prev?.active && s.duelActive ? prev.sinceMs : now,
  };
  if (!prev) {
    duelTrace.set(table, cur);
    return;
  }
  Promise.all([import('@/lib/fp-debug'), import('@/lib/fp-events')])
    .then(([{ fpDebug }, { fpEvent }]) => {
      const src = (body as { source?: string }).source ?? '?';
      if (!prev.active && cur.active) {
        const dl = Number(s.duelDeadlineTs || 0);
        const deadlineInS = dl > 0 ? dl - Math.floor(now / 1000) : null;
        fpDebug(`duel.start seats=${s.duelSeatA}/${s.duelSeatB} round=${cur.round} src=${src} deadlineIn=${deadlineInS ?? 'none'}s`);
        fpEvent('duel.chain.start', { seatA: s.duelSeatA, seatB: s.duelSeatB, round: cur.round, deadlineInS, src }, 'poll');
      } else if (prev.active && cur.active) {
        if (prev.round !== cur.round) {
          fpDebug(`duel.round ${prev.round}->${cur.round} +${now - cur.sinceMs}ms`);
          fpEvent('duel.chain.round', { from: prev.round, to: cur.round, sinceStartMs: now - cur.sinceMs, src }, 'poll');
        }
        if (prev.choiceA !== cur.choiceA) {
          fpDebug(`duel.choiceA=${cur.choiceA} +${now - cur.sinceMs}ms`);
          fpEvent('duel.chain.choice', { side: 'A', choice: cur.choiceA, sinceStartMs: now - cur.sinceMs, src }, 'poll');
        }
        if (prev.choiceB !== cur.choiceB) {
          fpDebug(`duel.choiceB=${cur.choiceB} +${now - cur.sinceMs}ms`);
          fpEvent('duel.chain.choice', { side: 'B', choice: cur.choiceB, sinceStartMs: now - cur.sinceMs, src }, 'poll');
        }
      } else if (prev.active && !cur.active) {
        fpDebug(`duel.resolved seenForMs=${now - prev.sinceMs} lastChoices=${prev.choiceA}/${prev.choiceB} lastLvl=${s.lastDuelBlindLevel}`);
        fpEvent('duel.chain.resolved', { seenForMs: now - prev.sinceMs, choiceA: prev.choiceA, choiceB: prev.choiceB, lastLvl: s.lastDuelBlindLevel, src }, 'poll');
      }
    })
    .catch(() => {});
  duelTrace.set(table, cur);
}

export function useSngBountyState(
  table: string | null | undefined,
  refreshMs = 5_000,
  teeConnection?: Connection | null,
) {
  const [snapshot, setSnapshot] = useState<BountyApiResponse | null>(
    table ? cache.get(table)?.body ?? null : null,
  );
  const [loading, setLoading] = useState(!!table);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!table) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    let alive = true;
    const refresh = (force = false) => {
      loadBounty(table, teeConnection, force)
        .then((body) => {
          if (!alive) return;
          setSnapshot((prev) => {
            // Sticky TEE: the API falls back to the L1 copy when a TEE read fails
            // (frequent under RPC 429s). Mid-game the L1 copy is STALE - it has no
            // duel or staged-tiebreak state - so one bad poll would unmount the duel
            // overlay / TIEBREAK QUEUED chip for a cycle (seen live 2026-07-12). Keep a
            // recent TEE snapshot over an L1 regression; accept L1 once it's the truth
            // again (post-settlement paid, or the TEE snapshot has aged out).
            const prevSrc = (prev as { source?: string } | null)?.source;
            const newSrc = (body as { source?: string }).source;
            if (
              prev?.success && prev.initialized && prevSrc === 'TEE' && newSrc === 'L1' &&
              !body?.state?.paid &&
              Date.now() - (prev.fetchedAt ?? 0) < 20_000
            ) {
              return prev;
            }
            return body;
          });
          setError(body.success ? null : body.error || 'Bounty state unavailable');
        })
        .catch((e: any) => {
          if (!alive) return;
          setError(e?.message || 'Bounty state unavailable');
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    };
    refresh();
    // Timer refreshes are live reads. The shared 5s cache is useful for duplicate
    // components on the same render, but it made the 1.2s duel overlay poll stale
    // during the actual choice window.
    const id = window.setInterval(() => refresh(true), refreshMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [table, refreshMs, teeConnection]);

  return {
    state: snapshot?.initialized ? snapshot.state ?? null : null,
    initialized: !!snapshot?.initialized,
    loading,
    error,
    pda: snapshot?.pda ?? null,
    pool: snapshot?.pool ?? null,
    emissionRateBps: snapshot?.emissionRateBps ?? null,
    fetchedAt: snapshot?.fetchedAt ?? null,
  };
}
