/**
 * Jackpot display helpers.
 *
 * On-chain fields keep the original `mini` / `grand` names, but the player
 * facing product language is:
 *
 *   - Lucky Jackpot: SOL add-on jackpot.
 *   - Royal Jackpot: $FP jackpot paid as Raw Yield.
 *   - Raw Yield: earned FP that stays in the yield-bearing position.
 *   - $FP: extra FP earned by holding Raw Yield while others claim.
 *
 * Lucky and Royal are different currencies and CANNOT be summed into a single
 * number. Combo hits (`mini_hit && grand_hit` on the same hand) must render as
 * two distinct amounts.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000;
/**
 * Royal Jackpot amounts are denominated in **unrefined POKER**, the Steel
 * staking lane's pre-conversion unit which uses **6 decimals**. The JPV1
 * `grandUnrefinedAmount` field is captured BEFORE the
 * `UNREFINED_TO_SPL_SCALE = 1000` claim-time conversion to the 9-decimal
 * SPL $FP mint, so display divides by 1e6 here. This matches the
 * project's other unrefined surfaces (`lib/emission.ts`, `lib/stake.ts`,
 * `components/profile/FundHistoryPanel.tsx`).
 *
 * `grandUnrefinedAmount = 8_000_000` renders as `8 Raw Yield`, not 0.008.
 */
export const FP_PER_TOKEN = 1_000_000;

export const LUCKY_JACKPOT_NAME = 'Lucky Jackpot';
export const ROYAL_JACKPOT_NAME = 'Royal Jackpot';
/**
 * Pre-refinement, escrowed emission balance earned from SNG play. Subject
 * to a 10% refinement fee when refined. Holders earn liquid $FP distributions
 * from OTHER players' refinement fees while they keep holding.
 *
 * Name: "Raw $FP" (not "Raw Yield" - Yield refers to the SOL+$FP earnings
 * stream from bonded positions, which is a separate concept).
 */
export const RAW_YIELD_NAME = 'Raw $FP';
/**
 * Liquid, transferable $FP token. Post-refinement form. Also the asset
 * paid out to Raw Yield holders as their share of other refiners' fees.
 */
export const LIQUID_FP_NAME = 'Earned $FP';
// Note: "Bonded Yield" is the narrative term we use in copy and the
// flywheel explainer to describe the SOL + $FP earnings stream that
// burn-to-stake positions accrue. It's not a code-level token type, just
// an umbrella name for the existing staker rewards. No constant needed.

/**
 * "1st of 9", "2nd of 6", "9th of 9". Used on SNG end screens and the
 * career-stats panel to show finishing position in tournament context.
 * Falls back to a generic "Xth" when `max` is unknown.
 */
export function formatPlace(place: number, max?: number): string {
  const suffix =
    place === 1 ? 'st' :
    place === 2 ? 'nd' :
    place === 3 ? 'rd' :
    'th';
  const head = `${place}${suffix}`;
  return max && max > 0 ? `${head} of ${max}` : head;
}

/** Trim trailing zeros and the dot on a fixed-decimal numeric string. */
function trimTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/** Format lamports as a SOL decimal string without a unit suffix. */
function lamportsToSolString(lamports: number, maxDecimals: number): string {
  const sol = lamports / LAMPORTS_PER_SOL;
  return trimTrailingZeros(sol.toFixed(maxDecimals));
}

/** Format raw POKER smallest-units as an FP decimal string without a suffix. */
function rawToFpString(rawAmount: number, maxDecimals: number): string {
  const fp = rawAmount / FP_PER_TOKEN;
  return trimTrailingZeros(fp.toFixed(maxDecimals));
}

/**
 * Format lamports as "<n> SOL" with up to `maxDecimals` decimals.
 * Negative inputs are clamped to 0.
 */
export function formatSol(lamports: number, maxDecimals = 4): string {
  const v = Number.isFinite(lamports) && lamports > 0 ? lamports : 0;
  return `${lamportsToSolString(v, maxDecimals)} SOL`;
}

/**
 * Format raw POKER smallest-units as "<n> Raw Yield".
 * This is intended for Royal Jackpot receipts and SNG reward surfaces.
 */
export function formatFp(rawAmount: number, maxDecimals = 6): string {
  const v = Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : 0;
  return `${rawToFpString(v, maxDecimals)} ${RAW_YIELD_NAME}`;
}

/**
 * Returns the display label for a receipt's hit kind. `null` when neither flag
 * is set, which should not happen for a real receipt.
 */
export function getKindLabel(
  miniHit: boolean,
  grandHit: boolean,
): 'LUCKY' | 'ROYAL' | 'LUCKY + ROYAL' | null {
  if (miniHit && grandHit) return 'LUCKY + ROYAL';
  if (grandHit) return 'ROYAL';
  if (miniHit) return 'LUCKY';
  return null;
}

/**
 * Badge accent color:
 *   - lucky-only: #F26A1F
 *   - royal-only: #B990FF
 *   - both: #FFC63A
 */
export function getKindColor(miniHit: boolean, grandHit: boolean): string {
  if (miniHit && grandHit) return '#FFC63A';
  if (grandHit) return '#B990FF';
  return '#F26A1F';
}

/**
 * Compact amount string for a receipt:
 *   - lucky-only: "0.0109 SOL"
 *   - royal-only: "8 Raw Yield"
 *   - both: "0.0109 SOL / 8 Raw Yield"
 */
export function formatJackpotAmount(receipt: {
  miniHit: boolean;
  miniPaidTotal: number;
  grandHit: boolean;
  grandUnrefinedAmount: number;
}): string {
  const parts: string[] = [];
  if (receipt.miniHit && receipt.miniPaidTotal > 0) {
    parts.push(formatSol(receipt.miniPaidTotal, 4));
  }
  if (receipt.grandHit && receipt.grandUnrefinedAmount > 0) {
    parts.push(formatFp(receipt.grandUnrefinedAmount, 6));
  }
  if (parts.length === 0) {
    if (receipt.grandHit) return formatFp(0, 6);
    return formatSol(0, 4);
  }
  return parts.join(' / ');
}
