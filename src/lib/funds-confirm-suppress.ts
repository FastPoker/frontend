/**
 * Per-action-type suppression for the wallet-approval modal.
 *
 * Users can check "Don't show this again for X" on the confirmation modal,
 * which writes the action's title to localStorage. confirmFundsAction()
 * reads from here BEFORE dispatching the modal event; if suppressed it
 * auto-resolves true.
 *
 * Re-enable surface lives in the TEE auth / Session modal so users have one
 * settings home for "how things sign on my behalf."
 *
 * Stored as a JSON-encoded object {[title]: true} so we can ship a "reset
 * all" button without iterating localStorage keys. Wallet-scoped per-key
 * isn't necessary because the suppressed titles are app-action types
 * ("Confirm $FP Claim", etc), not wallet-specific identifiers.
 */

const KEY = 'fastpoker:funds-confirm-suppressed:v1';

function readMap(): Record<string, true> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, true> = {};
    for (const k of Object.keys(parsed)) {
      if (parsed[k] === true) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, true>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
    // Broadcast so any open SessionModal that's listing suppressed actions
    // can refresh its view without a remount.
    window.dispatchEvent(new CustomEvent(SUPPRESS_CHANGE_EVENT));
  } catch {
    /* localStorage full / blocked — silent */
  }
}

export const SUPPRESS_CHANGE_EVENT = 'fastpoker:funds-confirm-suppress-change';

// Whether the active wallet signs HEADLESSLY with no native approval popup
// (Privy embedded wallets, showWalletUIs: false). When it does, our modal is
// the ONLY confirmation surface, so suppression must be ignored or the user
// signs funds-moving actions blind. Published by useUnifiedWallet on source
// change; read by confirmFundsAction.
let headlessSigner = false;

export function setHeadlessSigner(value: boolean): void {
  headlessSigner = value;
}

export function isHeadlessSigner(): boolean {
  return headlessSigner;
}

export function isFundsConfirmSuppressed(title: string): boolean {
  return readMap()[title] === true;
}

export function suppressFundsConfirm(title: string): void {
  const next = readMap();
  next[title] = true;
  writeMap(next);
}

export function unsuppressFundsConfirm(title: string): void {
  const next = readMap();
  delete next[title];
  writeMap(next);
}

export function listSuppressedFundsConfirms(): string[] {
  return Object.keys(readMap()).sort();
}

export function clearAllSuppressedFundsConfirms(): void {
  writeMap({});
}
