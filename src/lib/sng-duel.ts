// SnG Duels Bounty Rewards - on-chain data layer (frontend twin of programs/fastpoker/src/state/sng_duel.rs).
// Reads the SngDuelState sidecar. Keep the math helpers in lockstep with the contract.

import { PublicKey } from '@solana/web3.js';
import { ANCHOR_PROGRAM_ID } from '@/lib/constants';

export const SNG_DUEL_SEED = 'sng_duel';
export const SNG_DUEL_VERSION = 1;

// Contract constants (sng_duel.rs). SOL splits 50/50 bounty/ITM; $FP is pure bounty.
export const SOL_BOUNTY_BPS = 5_000;
export const BOUNTY_UNIT = 1_000_000n; // one knockout == BOUNTY_UNIT of credit
export const MATURITY_BPS_PER_LEVEL = 2_500; // maturity = min(10000, (level+1)*2500)
export const SNG_DUEL_TIMEOUT_SECONDS = 20;
export const SNG_DUEL_MAX_ROUND = 3;

export const DuelChoice = { None: 0, CallIn: 1, Fold: 2 } as const;
export const SEAT_NONE = 255;

// ---- Flat Bounty (the only SnG Duel ruleset) ----
// Reserved-byte registry (sng_duel.rs): [0..8) duel_deadline_ts i64 LE,
// [8] points_seeded, [9] ruleset (1 = flat bounty), [10] seeded_count,
// [16..24) duel_pause_started_ts i64 LE; all other bytes unused.
// Arrays: knockout_credit_units = HELD points (SOL weight), fp_bounty_weight_units
// = FP mirror; eliminated_bounty_units is layout-retained and stays zero (points
// are conserved - knockouts move them, nothing burns).
export const SNG_DUEL_RULESET_FLAT_BOUNTY = 1;
export const SNG_STARTING_CHIPS = 1_500;
/** Duel stake twin (sng_duel.rs scheduled_duel_stake): the symmetric chips both duelists
 *  risk. FLOOR division to match on-chain exactly; caller caps at each stack.
 *  With the real blind schedule the 8xBB term dominates at every duel-legal level. */
export function bountyExposedStake(blindLevel: number, bigBlind: number): number {
  const step = Math.max(0, blindLevel - 3);
  const curve = Math.floor((SNG_STARTING_CHIPS / 4) * (2 + step) / 2);
  return Math.max(curve, 8 * bigBlind);
}
// 8 disc + 32 + 1+1+1+1+1 + 8+8 + 72+72+72 + 9 + 18 + 1+1+1+1+1+1+1 + 8 + 32 + 64
export const SNG_DUEL_SIZE = 415;

export interface SngDuelState {
  table: PublicKey;
  version: number;
  bump: number;
  maxPlayers: number;
  paid: boolean;
  finalBlindLevel: number;
  creditedHandNumber: bigint;
  lastAccountedHand: bigint;
  knockoutCreditUnits: bigint[]; // [9] SOL bounty weight each seat EARNED
  fpBountyWeightUnits: bigint[]; // [9] $FP bounty weight each seat EARNED
  eliminatedBountyUnits: bigint[]; // [9] bounty ON each seat's head
  eliminationLevel: number[]; // [9] blind level each seat busted at
  foldCounts: number[]; // [9]
  lastDuelBlindLevel: number;
  duelActive: boolean;
  duelRound: number; // 1..3
  duelSeatA: number; // 255 == none
  duelSeatB: number;
  duelChoiceA: number; // 0 none / 1 call-in / 2 fold
  duelChoiceB: number;
  duelStartedHand: bigint;
  duelEntropy: Uint8Array; // 32
  duelDeadlineTs: bigint; // stored in reserved[0..8] as i64 LE
  // ---- Flat Bounty reserved-byte fields ----
  pointsSeeded: boolean; // reserved[8]
  ruleset: number; // always 1 (flat bounty); raw zero decodes the same
  seededCount: number; // reserved[10]
  duelPauseStartedTs: bigint; // reserved[16..24) i64 LE; nonzero only mid duel
}

export function getSngDuelPda(table: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SNG_DUEL_SEED), table.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
}

export function parseSngDuelState(data: Buffer): SngDuelState {
  if (data.length < SNG_DUEL_SIZE) {
    throw new Error(`SngDuelState account too small: ${data.length}`);
  }
  let o = 8; // discriminator
  const table = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const version = data.readUInt8(o); o += 1;
  const bump = data.readUInt8(o); o += 1;
  const maxPlayers = data.readUInt8(o); o += 1;
  const paid = data.readUInt8(o) !== 0; o += 1;
  const finalBlindLevel = data.readUInt8(o); o += 1;
  const creditedHandNumber = data.readBigUInt64LE(o); o += 8;
  const lastAccountedHand = data.readBigUInt64LE(o); o += 8;

  const readU64x9 = (): bigint[] => {
    const out: bigint[] = [];
    for (let i = 0; i < 9; i++) { out.push(data.readBigUInt64LE(o)); o += 8; }
    return out;
  };
  const knockoutCreditUnits = readU64x9();
  const fpBountyWeightUnits = readU64x9();
  const eliminatedBountyUnits = readU64x9();

  const eliminationLevel: number[] = [];
  for (let i = 0; i < 9; i++) { eliminationLevel.push(data.readUInt8(o)); o += 1; }
  const foldCounts: number[] = [];
  for (let i = 0; i < 9; i++) { foldCounts.push(data.readUInt16LE(o)); o += 2; }

  const lastDuelBlindLevel = data.readUInt8(o); o += 1;
  const duelActive = data.readUInt8(o) !== 0; o += 1;
  const duelRound = data.readUInt8(o); o += 1;
  const duelSeatA = data.readUInt8(o); o += 1;
  const duelSeatB = data.readUInt8(o); o += 1;
  const duelChoiceA = data.readUInt8(o); o += 1;
  const duelChoiceB = data.readUInt8(o); o += 1;
  const duelStartedHand = data.readBigUInt64LE(o); o += 8;
  const duelEntropy = new Uint8Array(data.subarray(o, o + 32)); o += 32;
  const reserved = data.subarray(o, o + 64);
  const duelDeadlineTs = reserved.readBigInt64LE(0);
  const pointsSeeded = reserved.readUInt8(8) !== 0;
  const ruleset = SNG_DUEL_RULESET_FLAT_BOUNTY;
  const seededCount = reserved.readUInt8(10);
  const duelPauseStartedTs = reserved.readBigInt64LE(16);

  return {
    table, version, bump, maxPlayers, paid, finalBlindLevel,
    creditedHandNumber, lastAccountedHand,
    knockoutCreditUnits, fpBountyWeightUnits, eliminatedBountyUnits,
    eliminationLevel, foldCounts,
    lastDuelBlindLevel, duelActive, duelRound, duelSeatA, duelSeatB,
    duelChoiceA, duelChoiceB, duelStartedHand, duelEntropy, duelDeadlineTs,
    pointsSeeded, ruleset, seededCount, duelPauseStartedTs,
  };
}

// ---- math helpers (twins of sng_duel.rs; keep in lockstep) ----

/** maturity in bps = min(10000, (finalBlindLevel + 1) * 2500). blind_level is 0-indexed on-chain. */
export function maturityBps(finalBlindLevel: number): number {
  return Math.min(10_000, (finalBlindLevel + 1) * MATURITY_BPS_PER_LEVEL);
}

export function sumUnits(units: bigint[], maxPlayers: number): bigint {
  return units.slice(0, maxPlayers).reduce((a, b) => a + b, 0n);
}

/** Integer floor share of a pool by a seat's units. */
export function seatShare(pool: bigint, seatUnits: bigint, totalUnits: bigint): bigint {
  if (totalUnits === 0n) return 0n;
  return (pool * seatUnits) / totalUnits;
}
