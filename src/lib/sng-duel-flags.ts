// SnG Duels UI (2026-07-17): NOT gated. The bounty/duel design is the frontend - there is
// exactly one version of the app on every environment, no env flags, no variants.
// These helpers remain only so ~40 call sites don't need touching in one pass; they are
// constants now and can be inlined away over time (D2 cleanup).

/** Bounty + maturity UI (Bounty Bank, payout redesign, level HUD, post-game breakdown). Always on. */
export function sngDuelsEnabled(): boolean {
  return true;
}

/** Duel-round UI (duel overlay/modal flow). Always on. */
export function sngDuelRoundsEnabled(): boolean {
  return true;
}

/** Pre-game bounty copy (lobby drawer/disclosure). Rides the master gate: always on. */
export function bountyShieldCopyEnabled(): boolean {
  return sngDuelsEnabled();
}
