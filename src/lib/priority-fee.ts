import { ComputeBudgetProgram, Transaction } from '@solana/web3.js';
import { L1_RPC, ANCHOR_PROGRAM_ID } from './constants';

/**
 * L1 priority fees (mainnet). Mirrors the crank's proven approach
 * (dealer-service): ask Helius `getPriorityFeeEstimate` for a
 * micro-lamports-per-CU figure, cache it briefly, and stamp it onto L1
 * transactions via ComputeBudgetProgram.setComputeUnitPrice.
 *
 * IMPORTANT: only call this for L1 (Solana) transactions. Gameplay runs on the
 * MagicBlock ER (TEE) which is gasless and REJECTS ComputeBudget instructions
 * (500). So this is wired into table creation, staking deposits, and claims —
 * never into the per-hand action path.
 *
 * On devnet there is no real fee market, so `getPriorityFeeEstimate` returns
 * ~0 and this is effectively a no-op; the real behaviour kicks in on mainnet.
 *
 * The user's preference is read from localStorage (`fp.priorityFee`) so the
 * Phase-2 settings modal only has to write that key.
 */

const REFRESH_MS = 5_000;
const FALLBACK_MICROLAMPORTS = 10_000; // used only if the estimate call fails
const MAX_MICROLAMPORTS = 2_000_000; // hard ceiling so a congested slot can't drain a wallet
const PREF_KEY = 'fp.priorityFee';

type FeeMode = 'auto' | 'fast' | 'custom';
interface FeePref {
  mode: FeeMode;
  customMicro: number; // used when mode === 'custom'
  maxMicro: number; // user cap (still clamped by MAX_MICROLAMPORTS)
}

function readPref(): FeePref {
  if (typeof window === 'undefined') return { mode: 'auto', customMicro: 0, maxMicro: MAX_MICROLAMPORTS };
  try {
    const raw = window.localStorage.getItem(PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      const mode: FeeMode = p.mode === 'fast' || p.mode === 'custom' ? p.mode : 'auto';
      return {
        mode,
        customMicro: Math.max(0, Number(p.customMicro) || 0),
        maxMicro: Math.min(MAX_MICROLAMPORTS, Math.max(0, Number(p.maxMicro) || MAX_MICROLAMPORTS)),
      };
    }
  } catch { /* ignore malformed pref */ }
  return { mode: 'auto', customMicro: 0, maxMicro: MAX_MICROLAMPORTS };
}

// Cache keyed by priority level so 'auto' (Medium) and 'fast' (High) don't
// clobber each other.
const cache = new Map<string, { value: number; at: number }>();
const inflight = new Map<string, Promise<number>>();

async function fetchEstimate(level: 'Medium' | 'High'): Promise<number> {
  try {
    const res = await fetch(L1_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'priority-fee',
        method: 'getPriorityFeeEstimate',
        params: [{
          accountKeys: [ANCHOR_PROGRAM_ID.toBase58()],
          options: { priorityLevel: level, includeAllPriorityFeeLevels: false },
        }],
      }),
    });
    const j = await res.json();
    const fee = Number(j?.result?.priorityFeeEstimate);
    if (!Number.isFinite(fee) || fee < 0) return FALLBACK_MICROLAMPORTS;
    return Math.floor(fee);
  } catch {
    return FALLBACK_MICROLAMPORTS;
  }
}

async function estimateCached(level: 'Medium' | 'High'): Promise<number> {
  const now = Date.now();
  const hit = cache.get(level);
  if (hit && now - hit.at < REFRESH_MS) return hit.value;
  if (!inflight.has(level)) {
    inflight.set(level, fetchEstimate(level)
      .then((v) => { cache.set(level, { value: v, at: Date.now() }); inflight.delete(level); return v; })
      .catch(() => { inflight.delete(level); return hit?.value ?? FALLBACK_MICROLAMPORTS; }));
  }
  // Serve a stale value immediately and refresh in the background.
  if (hit) return hit.value;
  return inflight.get(level)!;
}

/**
 * Resolve the priority fee (micro-lamports per CU) to use for the next L1 tx,
 * honoring the user's stored preference and the hard ceiling.
 */
export async function getPriorityFeeMicroLamports(): Promise<number> {
  const pref = readPref();
  let micro: number;
  if (pref.mode === 'custom') micro = pref.customMicro;
  else micro = await estimateCached(pref.mode === 'fast' ? 'High' : 'Medium');
  return Math.min(micro, pref.maxMicro, MAX_MICROLAMPORTS);
}

const SET_LIMIT_DISC = 0x02; // ComputeBudgetInstruction::SetComputeUnitLimit
const SET_PRICE_DISC = 0x03; // ComputeBudgetInstruction::SetComputeUnitPrice
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111';

function hasComputeBudgetIx(tx: Transaction, disc: number): boolean {
  return tx.instructions.some(
    (ix) => ix.programId.toBase58() === COMPUTE_BUDGET_ID && ix.data[0] === disc,
  );
}

/**
 * Prepend ComputeBudget priority-fee instructions to an L1 legacy Transaction,
 * in place. Adds a compute-unit PRICE (the priority fee); also adds a LIMIT
 * only when `unitLimit` is given and the tx doesn't already set one (callers
 * that tuned their own limit keep it). No-op when the fee resolves to 0
 * (e.g. devnet). NEVER call on TEE/ER transactions.
 */
export async function applyPriorityFee(
  tx: Transaction,
  opts?: { unitLimit?: number },
): Promise<void> {
  const micro = await getPriorityFeeMicroLamports();
  const pre = [];
  if (opts?.unitLimit !== undefined && !hasComputeBudgetIx(tx, SET_LIMIT_DISC)) {
    pre.push(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.unitLimit }));
  }
  if (micro > 0 && !hasComputeBudgetIx(tx, SET_PRICE_DISC)) {
    pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }));
  }
  if (pre.length) tx.instructions.unshift(...pre);
}
