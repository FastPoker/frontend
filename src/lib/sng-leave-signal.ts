/**
 * Tracks recent voluntary leaves from SNG pools so the SngPoolCard's
 * "pending match" sticky doesn't fire when the user themselves clicked
 * Leave (vs being matched into a game).
 *
 * Without this, the lobby's leave flow looks like:
 *   - Optimistic update: sngPools removes the wallet → isInPool flips false
 *   - SngPoolCard sees isInPool: true → false with no matched table
 *   - Pending-match sticky fires → "MATCHING" pill shows for up to 60s
 * That sticky exists for the legitimate case where the pool drops a wallet
 * because a hand started, but it can't distinguish that from a leave. This
 * module-level signal lets the leave handler stamp a marker so the card
 * suppresses the sticky for a brief window.
 */

// Longer than the polling interval (15s) + worst-case indexer lag so the
// voluntary intent survives until the upstream catches up to chain state.
// Was 8s, then 12s — both too short.
const SIGNAL_WINDOW_MS = 30_000;

const leftAt = new Map<string, number>();
const joinedAt = new Map<string, number>();

function keyOf(gameType: number, tier: number): string {
  return `${gameType}:${tier}`;
}

/** Call from the lobby's leave handler right after the on-chain tx confirms. */
export function markPoolLeaveVoluntary(gameType: number, tier: number): void {
  leftAt.set(keyOf(gameType, tier), Date.now());
}

/** True if the user just clicked Leave on this pool within the suppress window. */
export function isPoolLeaveVoluntary(gameType: number, tier: number): boolean {
  const at = leftAt.get(keyOf(gameType, tier));
  if (!at) return false;
  const fresh = Date.now() - at < SIGNAL_WINDOW_MS;
  if (!fresh) leftAt.delete(keyOf(gameType, tier));
  return fresh;
}

/** Call from the lobby's join handler right after the on-chain tx confirms.
 *  Used to suppress the pending-match sticky when the user just joined and
 *  the local optimistic update flips isInPool=true→false→true while the
 *  server-cached /api/sitngos response catches up. */
export function markPoolJoinVoluntary(gameType: number, tier: number): void {
  joinedAt.set(keyOf(gameType, tier), Date.now());
}

/** True if the user just clicked Join on this pool within the suppress window. */
export function isPoolJoinVoluntary(gameType: number, tier: number): boolean {
  const at = joinedAt.get(keyOf(gameType, tier));
  if (!at) return false;
  const fresh = Date.now() - at < SIGNAL_WINDOW_MS;
  if (!fresh) joinedAt.delete(keyOf(gameType, tier));
  return fresh;
}
