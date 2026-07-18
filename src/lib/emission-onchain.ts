// On-chain emission truth. The client-side emission twin (lib/emission.ts) reproduces
// base x tier x supply-decay but CANNOT know the governor multiplier or idle boost
// (time-varying on-chain state, emission_ctrl.rs). Showing the twin's number while the
// contract snapshots the governed one made pools appear to emit at different rates.
//
// - parseSngJackpotTableState: the funded truth. Once `grandFunded`, `normalUnrefined`
//   (gross minus the 10% grand skim) IS the table's $FP player pool.
// - parseEmissionCtrl + computeRawMultBps: replicate EmissionCtrl::decay_to + raw_mult_bps
//   so unfunded tables/lobby can show the CURRENT governed rate honestly.

import { PublicKey } from '@solana/web3.js';
import { ANCHOR_PROGRAM_ID, SNG_JACKPOT_TABLE_STATE_SEED } from './constants';

export const EMISSION_CTRL_SEED = 'emission_ctrl';
const EMISSION_POOL_COUNT = 21;
const NORMAL_ACTIVITY_RAW_MULT_BPS = 5_000n;
const SUB_KNEE_BPS = 1_000n;
const DEFAULT_SUB_KNEE_EXP_QUARTERS = 3;
const BPS = 10_000n;
const MAX_DECAY_HOURS = 24n * 14n;

export function getSngJackpotTableStatePda(table: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SNG_JACKPOT_TABLE_STATE_SEED), table.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
}

export function getEmissionCtrlPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(EMISSION_CTRL_SEED)], ANCHOR_PROGRAM_ID);
}

export interface SngJackpotTableStateLite {
  table: PublicKey;
  grossUnrefined: bigint;
  grandUnrefined: bigint;
  normalUnrefined: bigint;
  grandFunded: boolean;
}

/** state/jackpot.rs SngJackpotTableState: 8 disc + table(32) + 9 u64 + entries_closed + grand_funded + bump = 115. */
export function parseSngJackpotTableState(data: Buffer): SngJackpotTableStateLite {
  if (data.length < 115) throw new Error(`SngJackpotTableState too small: ${data.length}`);
  return {
    table: new PublicKey(data.subarray(8, 40)),
    grossUnrefined: data.readBigUInt64LE(48),
    grandUnrefined: data.readBigUInt64LE(56),
    normalUnrefined: data.readBigUInt64LE(64),
    grandFunded: data.readUInt8(113) !== 0,
  };
}

export interface EmissionCtrlLite {
  targetRakeLamports: bigint;
  minRawMultBps: number;
  slowRetainBpsPerHour: number;
  fastRetainBpsPerHour: number;
  signalBlendSlowBps: number;
  slowSignalLamports: bigint;
  fastSignalLamports: bigint;
  lastUpdateTs: bigint;
  subKneeExpQuarters: number;
}

function readU128LE(data: Buffer, o: number): bigint {
  return data.readBigUInt64LE(o) + (data.readBigUInt64LE(o + 8) << 64n);
}

/** state/emission_ctrl.rs EmissionCtrl layout (fields in declaration order). */
export function parseEmissionCtrl(data: Buffer): EmissionCtrlLite {
  // 8 disc + authority(32)=40 + target(8)=48 + min_raw(2)=50 + max_idle(2)=52 + idle_cap(8)=60
  // + slow_retain(2)=62 + fast_retain(2)=64 + blend(2)=66 + idle_retain(2)=68 + rolling_cap(8)=76
  // + pool_caps(8*21)=244 + slow_sig(16)=260 + fast_sig(16)=276 + idle_usage(16)=292
  // + last_update(8)=300 + last_idle(8)=308 + bump(1)
  if (data.length < 309) throw new Error(`EmissionCtrl too small: ${data.length}`);
  const capsEnd = 76 + 8 * EMISSION_POOL_COUNT; // 244
  return {
    targetRakeLamports: data.readBigUInt64LE(40),
    minRawMultBps: data.readUInt16LE(48),
    slowRetainBpsPerHour: data.readUInt16LE(60),
    fastRetainBpsPerHour: data.readUInt16LE(62),
    signalBlendSlowBps: data.readUInt16LE(64),
    slowSignalLamports: readU128LE(data, capsEnd),
    fastSignalLamports: readU128LE(data, capsEnd + 16),
    lastUpdateTs: data.readBigInt64LE(capsEnd + 48),
    subKneeExpQuarters: data.length > capsEnd + 65 ? data.readUInt8(capsEnd + 65) : 0,
  };
}

/** Twin of emission_ctrl.rs decay_value: hourly retain factor + linear partial hour. */
function decayValue(value: bigint, dtSeconds: bigint, retainBpsPerHour: number): bigint {
  const retain = BigInt(retainBpsPerHour);
  if (value === 0n || dtSeconds <= 0n || retain >= BPS) return value;
  let v = value;
  let remaining = dtSeconds;
  const fullHours = remaining / 3_600n > MAX_DECAY_HOURS ? MAX_DECAY_HOURS : remaining / 3_600n;
  for (let i = 0n; i < fullHours; i++) v = (v * retain) / BPS;
  if (fullHours === MAX_DECAY_HOURS) return v;
  remaining %= 3_600n;
  if (remaining > 0n) {
    const partialDrop = ((BPS - retain) * remaining) / 3_600n;
    v = (v * (BPS - partialDrop)) / BPS;
  }
  return v;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n / 2n + 1n;
  let y = (x + n / x) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

function effectiveSubKneeExpQuarters(ctrl: EmissionCtrlLite): number {
  return ctrl.subKneeExpQuarters && ctrl.subKneeExpQuarters !== 0
    ? ctrl.subKneeExpQuarters
    : DEFAULT_SUB_KNEE_EXP_QUARTERS;
}

function bendSubKneeRawMultBps(rawBps: bigint, expQuarters: number): bigint {
  if (rawBps >= SUB_KNEE_BPS || expQuarters === 4) return rawBps;
  const scale = 1_000_000n;
  const xScaled = (rawBps * scale) / SUB_KNEE_BPS;
  let bentScaled: bigint;
  if (expQuarters === 2) {
    bentScaled = isqrt(xScaled * scale);
  } else if (expQuarters === 3) {
    bentScaled = isqrt(isqrt(xScaled * xScaled * xScaled * scale));
  } else {
    throw new Error(`Invalid sub-knee exponent quarters: ${expQuarters}`);
  }
  return (SUB_KNEE_BPS * bentScaled) / scale;
}

/**
 * Twin of state/jackpot.rs `grand_trigger_denominator` (deployed 2026-07-02): the Royal/Grand
 * trigger odds are contribution-weighted per (format, tier) cell, anchored at Gold 9max ==
 * base denominator. CEILING division mirrors the contract. Keep in lockstep with the Rust.
 */
export function grandTriggerDenominator(baseDenominator: number, gameType: number, tier: number): number {
  const UNITS: Record<number, bigint> = { 0: 80n, 1: 720n, 2: 1_620n }; // base/seat x seats
  const TIER_BPS = [1_000n, 2_000n, 5_000n, 10_000n, 20_000n, 40_000n, 100_000n];
  const units = UNITS[gameType];
  const tierBps = TIER_BPS[tier];
  if (units === undefined || tierBps === undefined) return Math.max(1, baseDenominator);
  const ANCHOR = 1_620n * 10_000n;
  const cell = units * tierBps;
  if (cell === 0n) return Number.MAX_SAFE_INTEGER;
  const num = BigInt(Math.max(1, baseDenominator)) * ANCHOR;
  const scaled = (num + cell - 1n) / cell; // ceiling, same as the contract
  return Number(scaled);
}

/** Twin of EmissionCtrl::decay_to + raw_mult_bps: the CURRENT governed multiplier (bps). */
export function computeRawMultBps(ctrl: EmissionCtrlLite, nowTs: number): number {
  const dt = BigInt(nowTs) - ctrl.lastUpdateTs;
  const slow = decayValue(ctrl.slowSignalLamports, dt, ctrl.slowRetainBpsPerHour);
  const fast = decayValue(ctrl.fastSignalLamports, dt, ctrl.fastRetainBpsPerHour);
  const slowW = BigInt(ctrl.signalBlendSlowBps);
  const signal = (slow * slowW + fast * (BPS - slowW)) / BPS;
  if (signal === 0n) return 10_000;
  const raw = (ctrl.targetRakeLamports * NORMAL_ACTIVITY_RAW_MULT_BPS) / signal;
  const bent = bendSubKneeRawMultBps(raw, effectiveSubKneeExpQuarters(ctrl));
  const clamped = bent > BPS ? BPS : bent < BigInt(ctrl.minRawMultBps) ? BigInt(ctrl.minRawMultBps) : bent;
  return Number(clamped);
}
