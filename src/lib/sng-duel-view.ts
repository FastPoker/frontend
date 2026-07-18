// Pure derivation from SngBountySnapshot -> display view models. No React; consumed by components.

import type { SngBountySnapshot } from '@/hooks/useSngBountyState';
import {
  BOUNTY_UNIT,
  SOL_BOUNTY_BPS,
  maturityBps,
  seatShare,
} from '@/lib/sng-duel';

function big(s: string | undefined): bigint {
  try { return BigInt(s ?? '0'); } catch { return 0n; }
}

export interface SeatBountyView {
  seat: number;
  koCount: number; // FLOOR of held points - use `points` for display (fractions are real)
  /** Held bounty points as a fraction (flat-bounty 2026-07-14: tied side-pot winners
   *  split a victim's point, e.g. 0.5 or 0.33). Display via formatPoints(). */
  points: number;
  koCreditUnits: bigint;
  fpWeightUnits: bigint;
  eliminated: boolean;
  eliminationLevel: number | null;
}

/** "1", "0.5", "0.33", "2.67" - fractions trimmed to 2dp, integers bare. */
export function formatPoints(points: number): string {
  if (Number.isInteger(points)) return String(points);
  return points.toFixed(2).replace(/\.?0+$/, '');
}

/** Duel sidecar snapshots use flat-bounty arrays: held points / FP mirror.
 *  Tolerates snapshots from an older API build that lack the field. */
export function isFlatBounty(snap: SngBountySnapshot): boolean {
  return (snap.ruleset ?? 1) === 1;
}

export function seatViews(snap: SngBountySnapshot): SeatBountyView[] {
  const flat = isFlatBounty(snap);
  const out: SeatBountyView[] = [];
  for (let seat = 0; seat < snap.maxPlayers; seat++) {
    const koCredit = big(snap.knockoutCreditUnits[seat]);
    const elimBounty = big(snap.eliminatedBountyUnits[seat]);
    // Bust detection: elimination_level is stamped on bust, but a level-0 bust
    // is indistinguishable from a live seat here - callers cross-check the
    // table's seated players. (eliminated_bounty_units is layout-retained and
    // stays zero; points are conserved.)
    const eliminated = flat
      ? (snap.eliminationLevel[seat] ?? 0) > 0 || elimBounty > 0n
      : elimBounty > 0n;
    out.push({
      seat,
      koCreditUnits: koCredit,
      fpWeightUnits: big(snap.fpBountyWeightUnits[seat]),
      koCount: Number(koCredit / BOUNTY_UNIT), // floor; fractions live in `points`
      points: Number(koCredit) / Number(BOUNTY_UNIT),
      eliminated,
      eliminationLevel: eliminated ? snap.eliminationLevel[seat] ?? null : null,
    });
  }
  return out;
}

export interface BountyBankView {
  koCount: number; // floor; use `points` for display
  points: number;
  koCreditUnits: bigint;
  fpWeightUnits: bigint;
  maturityBps: number; // live/projected, or final if settled
  settled: boolean;
  projectedFpUnrefined: bigint | null; // needs pokerPoolUnrefined
  projectedSolLamports: bigint | null; // needs solPrizePoolLamports
}

/**
 * Hero's Bounty Bank. `currentBlindLevel` (0-indexed, live) drives the projected maturity; once
 * `snap.paid` the settled finalBlindLevel is used. Pass pool sizes to project real values.
 */
export function bountyBankView(
  snap: SngBountySnapshot,
  heroSeat: number | null,
  currentBlindLevel: number,
  opts?: { pokerPoolUnrefined?: bigint; solPrizePoolLamports?: bigint },
): BountyBankView {
  const settled = snap.paid;
  const level = settled ? snap.finalBlindLevel : currentBlindLevel;
  const mBps = maturityBps(level);

  const koCredit = heroSeat != null ? big(snap.knockoutCreditUnits[heroSeat]) : 0n;
  const fpWeight = heroSeat != null ? big(snap.fpBountyWeightUnits[heroSeat]) : 0n;

  const totalFp = snap.fpBountyWeightUnits.slice(0, snap.maxPlayers).reduce((a, s) => a + big(s), 0n);
  const totalKo = snap.knockoutCreditUnits.slice(0, snap.maxPlayers).reduce((a, s) => a + big(s), 0n);

  // Flat-bounty points are conserved from seeding: live Sum(knockout_credit_units)
  // = seeded x UNIT and is the settlement denominator at every moment.
  // Never use maxPlayers-1; a full 6-max seeds 6 points, not 5.
  const flat = isFlatBounty(snap);
  let koDenom: bigint;
  let fpDenom: bigint;
  if (flat) {
    koDenom = totalKo;
    fpDenom = totalFp;
  } else {
    const expectedTotal = BOUNTY_UNIT * BigInt(Math.max(1, snap.maxPlayers - 1));
    koDenom = settled ? totalKo : (expectedTotal > totalKo ? expectedTotal : totalKo);
    fpDenom = settled ? totalFp : (expectedTotal > totalFp ? expectedTotal : totalFp);
  }

  let projectedFpUnrefined: bigint | null = null;
  if (opts?.pokerPoolUnrefined != null && fpDenom > 0n) {
    const matured = (opts.pokerPoolUnrefined * BigInt(mBps)) / 10_000n;
    projectedFpUnrefined = seatShare(matured, fpWeight, fpDenom);
  }
  let projectedSolLamports: bigint | null = null;
  if (opts?.solPrizePoolLamports != null && koDenom > 0n) {
    const solBountyPool = (opts.solPrizePoolLamports * BigInt(SOL_BOUNTY_BPS)) / 10_000n;
    projectedSolLamports = seatShare(solBountyPool, koCredit, koDenom);
  }

  return {
    koCount: Number(koCredit / BOUNTY_UNIT),
    points: Number(koCredit) / Number(BOUNTY_UNIT),
    koCreditUnits: koCredit,
    fpWeightUnits: fpWeight,
    maturityBps: mBps,
    settled,
    projectedFpUnrefined,
    projectedSolLamports,
  };
}

export type DuelPhase = 'none' | 'warmup' | 'live';

export interface DuelView {
  active: boolean;
  round: number; // 1..3
  maxRound: number;
  seatA: number;
  seatB: number;
  choiceA: number; // 0 none / 1 all-in / 2 fold
  choiceB: number;
  deadlineTs: number; // unix seconds
  phase: DuelPhase; // warmup (design L1-2 / code level 0-1) vs live (design L3+ / code level >=2)
  heroInDuel: boolean;
  heroNeedsAction: boolean;
}

export function duelView(snap: SngBountySnapshot, heroSeat: number | null): DuelView {
  const level = snap.lastDuelBlindLevel; // 0-indexed
  const phase: DuelPhase = !snap.duelActive
    ? 'none'
    : level >= 2 ? 'live' : 'warmup';
  const heroInDuel =
    heroSeat != null && (heroSeat === snap.duelSeatA || heroSeat === snap.duelSeatB);
  const heroChoice =
    heroSeat === snap.duelSeatA ? snap.duelChoiceA : heroSeat === snap.duelSeatB ? snap.duelChoiceB : 0;
  return {
    active: snap.duelActive,
    round: snap.duelRound,
    maxRound: 3,
    seatA: snap.duelSeatA,
    seatB: snap.duelSeatB,
    choiceA: snap.duelChoiceA,
    choiceB: snap.duelChoiceB,
    deadlineTs: Number(big(snap.duelDeadlineTs)),
    phase,
    heroInDuel,
    heroNeedsAction: snap.duelActive && heroInDuel && heroChoice === 0,
  };
}
