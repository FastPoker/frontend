import { PublicKey } from '@solana/web3.js';

/**
 * Operator frontend fee (standalone self-host).
 *
 * Anyone running this build can collect a small convenience fee on top of each
 * entry. It is appended as a plain `SystemProgram.transfer` to the operator's
 * wallet inside the SAME transaction as the on-chain join/deposit, so it is
 * fully disclosed in the funds-confirmation modal and the player signs the
 * buy-in and the fee together, atomically.
 *
 * This is a FRONTEND fee, NOT a protocol fee:
 *   - It only exists in builds the operator chooses to ship with it configured.
 *   - It goes to the operator's own wallet, entirely separate from the on-chain
 *     buy-in / prize pool / Steel treasury fee.
 *   - It is inherently optional for the player: a user who builds the join tx
 *     themselves (bypassing this frontend) simply doesn't pay it. That's fine —
 *     it's the price of using the operator's hosted convenience layer.
 *
 * Every value below is read from build-time `NEXT_PUBLIC_*` env, so it is fixed
 * in the deployed bundle. There is deliberately NO localStorage / runtime
 * override: that would let a player set their own fee to zero, defeating the
 * purpose, and would also let a hostile page redirect the fee elsewhere.
 *
 * Config (set before `npm run build`):
 *   NEXT_PUBLIC_OPERATOR_FEE_WALLET   base58 pubkey that receives the fee. Unset/invalid → fee disabled.
 *   NEXT_PUBLIC_SNG_FEE_BPS           SNG fee in basis points (100 = 1%), on the buy-in. Default 0.
 *   NEXT_PUBLIC_SNG_FEE_FLAT_SOL      SNG flat fee in SOL, added on top of the % part. Default 0.
 *   NEXT_PUBLIC_CASH_FEE_BPS          Cash fee in basis points, on the deposit/seat amount. Default 0.
 *   NEXT_PUBLIC_CASH_FEE_FLAT_SOL     Cash flat fee in SOL. Default 0.
 *   NEXT_PUBLIC_OPERATOR_FEE_CAP_SOL  Absolute ceiling on the computed fee, in SOL. 0 = no cap. Default 0.
 */

// Hard ceiling on the percentage knob so a mis-typed config (e.g. "5000")
// can't silently 50x a player's buy-in. 10% is already generous for a
// convenience fee; an operator who wants more must edit this constant.
const MAX_FEE_BPS = 1000; // 10%

function parseWallet(raw: string | undefined): PublicKey | null {
  if (!raw || !raw.trim()) return null;
  try {
    return new PublicKey(raw.trim());
  } catch {
    // A bad pubkey disables the fee rather than throwing at module load —
    // a typo in an operator's env must never brick the whole lobby.
    return null;
  }
}

function parseNonNegNumber(raw: string | undefined): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function solToLamports(sol: number): number {
  return Math.floor(sol * 1e9);
}

// Resolved once at module load. NEXT_PUBLIC_* must be referenced statically so
// Next inlines them into the client bundle at build time.
const FEE_WALLET = parseWallet(process.env.NEXT_PUBLIC_OPERATOR_FEE_WALLET);
const SNG_FEE_BPS = Math.min(MAX_FEE_BPS, Math.floor(parseNonNegNumber(process.env.NEXT_PUBLIC_SNG_FEE_BPS)));
const CASH_FEE_BPS = Math.min(MAX_FEE_BPS, Math.floor(parseNonNegNumber(process.env.NEXT_PUBLIC_CASH_FEE_BPS)));
const SNG_FEE_FLAT_LAMPORTS = solToLamports(parseNonNegNumber(process.env.NEXT_PUBLIC_SNG_FEE_FLAT_SOL));
const CASH_FEE_FLAT_LAMPORTS = solToLamports(parseNonNegNumber(process.env.NEXT_PUBLIC_CASH_FEE_FLAT_SOL));
const FEE_CAP_LAMPORTS = solToLamports(parseNonNegNumber(process.env.NEXT_PUBLIC_OPERATOR_FEE_CAP_SOL));

/** The operator wallet that receives the fee, or null if no valid wallet is configured. */
export function operatorFeeWallet(): PublicKey | null {
  return FEE_WALLET;
}

/** True if a fee wallet is set AND at least one fee knob is non-zero. */
export function operatorFeeEnabled(): boolean {
  if (!FEE_WALLET) return false;
  return SNG_FEE_BPS > 0 || CASH_FEE_BPS > 0 || SNG_FEE_FLAT_LAMPORTS > 0 || CASH_FEE_FLAT_LAMPORTS > 0;
}

function applyCap(lamports: number): number {
  return FEE_CAP_LAMPORTS > 0 ? Math.min(lamports, FEE_CAP_LAMPORTS) : lamports;
}

function compute(baseLamports: number, bps: number, flatLamports: number): number {
  if (!FEE_WALLET) return 0;
  const base = Math.max(0, Math.floor(baseLamports));
  const pct = Math.floor((base * bps) / 10_000);
  const fee = pct + flatLamports;
  return fee > 0 ? applyCap(fee) : 0;
}

/** Operator fee in lamports for an SNG buy-in (entry + protocol fee). */
export function computeSngFeeLamports(buyInLamports: number): number {
  return compute(buyInLamports, SNG_FEE_BPS, SNG_FEE_FLAT_LAMPORTS);
}

/** Operator fee in lamports for a cash deposit / self-seat amount. */
export function computeCashFeeLamports(amountLamports: number): number {
  return compute(amountLamports, CASH_FEE_BPS, CASH_FEE_FLAT_LAMPORTS);
}

function describe(bps: number, flatLamports: number): string | null {
  if (!FEE_WALLET) return null;
  const parts: string[] = [];
  if (bps > 0) parts.push(`${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`);
  if (flatLamports > 0) parts.push(`${(flatLamports / 1e9).toFixed(6).replace(/\.?0+$/, '')} SOL`);
  return parts.length ? parts.join(' + ') : null;
}

/** Short human label for the SNG fee, e.g. "1%", "0.001 SOL", "1% + 0.001 SOL", or null when off. */
export function describeSngFee(): string | null {
  return describe(SNG_FEE_BPS, SNG_FEE_FLAT_LAMPORTS);
}

/** Short human label for the cash fee, or null when off. */
export function describeCashFee(): string | null {
  return describe(CASH_FEE_BPS, CASH_FEE_FLAT_LAMPORTS);
}

/** Format a lamports fee as a trimmed SOL string, e.g. "0.001 SOL". */
export function feeSolLabel(lamports: number): string {
  return `${(lamports / 1e9).toFixed(6).replace(/\.?0+$/, '')} SOL`;
}
