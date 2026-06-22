import { PublicKey, Connection, type Commitment } from '@solana/web3.js';
import { getDefaultValidator } from './validator-registry';
import { L1_RPC_CLIENT, L1_WS_RPC_CLIENT } from './rpc-config';
import { shouldUsePool, makePublicPoolConnection, makeHealthFetch } from './rpc-pool';
import { getEffectiveRpcUrl, getEffectiveWsUrl } from './user-config';

// RPC Endpoints
// Resolved from NEXT_PUBLIC_L1_RPC_URL at build time. WARNING: because that var
// is NEXT_PUBLIC_*, whatever URL you set (key and all) is INLINED into the
// browser bundle — so a keyed endpoint here IS readable in the shipped JS. For a
// public build, leave it BLANK (→ free pool) and let users bring their own RPC
// via the in-app modal (localStorage, never compiled in).
// For server-side (API routes), import getL1Rpc() from './rpc-config'.
export const L1_RPC = L1_RPC_CLIENT;
export const L1_WS_RPC = L1_WS_RPC_CLIENT;
export const L1_RPC_DIRECT = L1_RPC;

/**
 * Build an L1 Connection that subscribes over the configured WebSocket
 * (L1_WS_RPC) instead of letting web3.js derive a ws:// URL from the HTTP
 * endpoint. This matters whenever L1_RPC is the same-origin `/rpc` proxy: the
 * proxy is HTTP-only, so a derived `ws://<origin>/rpc` socket fails forever,
 * spams the console, AND makes `confirmTransaction` (which waits on a WS
 * signature subscription) time out at 30s even when the tx actually landed.
 * Mirrors providers.tsx connectionConfig so ad-hoc connections behave exactly
 * like the app's main one. Prefer this over `new Connection(L1_RPC, ...)` in
 * all browser code.
 */
export function makeL1Connection(commitment: Commitment = 'confirmed'): Connection {
  // Standalone MVP: when no single RPC is configured (NEXT_PUBLIC_L1_RPC_URL
  // blank), use the rotating public pool with failover so it works on free
  // public APIs out of the box. A user-supplied RPC bypasses the pool.
  if (shouldUsePool()) return makePublicPoolConnection(commitment);
  // Single configured RPC: frontend (localStorage) override wins over the env.
  const rpc = getEffectiveRpcUrl() || L1_RPC;
  const ws = getEffectiveWsUrl();
  // Report liveness into the 'rpc' health channel so the footer dot reflects a
  // BYO endpoint's health too (the pool path reports inline in rpc-pool).
  const fetchWithHealth = makeHealthFetch();
  return new Connection(rpc, ws
    ? { commitment, wsEndpoint: ws, fetch: fetchWithHealth }
    : { commitment, fetch: fetchWithHealth });
}
export const MAGIC_ROUTER_RPC = 'https://devnet-router.magicblock.app'; // Auto-routes L1 <-> ER
// Regional ER (US) — legacy, kept for backward compat
export const ER_RPC = 'https://devnet-us.magicblock.app';
// TEE endpoint — resolved from validator registry (see validator-registry.ts)
// For existing tables, use detectDelegation() to find the correct endpoint.
export const TEE_RPC_URL = getDefaultValidator().rpcUrl;

// Program IDs
//
// Resolution: read env first, fall back to the hardcoded value. Env vars are
// `NEXT_PUBLIC_*` so they're inlined into the browser bundle at build time —
// the deploy script must `export` them BEFORE `npm run build`, not at runtime.
//
// Invalid env values throw at module load (better than silently using a bad
// pubkey deep in some request handler).
function programIdFromEnv(envName: string, fallback: string): PublicKey {
  const raw = process.env[envName];
  if (raw && raw.trim()) {
    try {
      return new PublicKey(raw.trim());
    } catch {
      throw new Error(
        `Invalid ${envName} env var: "${raw}" is not a valid base58 pubkey`,
      );
    }
  }
  return new PublicKey(fallback);
}

// FastPoker main program — rotates on every redeploy. Always set this env var
// in CI/prod so a contract redeploy is one config change, not 40 file edits.
export const ANCHOR_PROGRAM_ID = programIdFromEnv(
  'NEXT_PUBLIC_FASTPOKER_PROGRAM_ID',
  'PokerXYdXL2SKNnfGbv1WE7vJHipTpNsfZbZeVvoJLn',
);
// Registry program — rotates rarely.
export const FASTPOKER_REGISTRY_PROGRAM_ID = programIdFromEnv(
  'NEXT_PUBLIC_FASTPOKER_REGISTRY_PROGRAM_ID',
  'pokerQBdo685uLSkpVSyZ1vWooPYYTUhGkeKAHyCmax',
);
// Magicblock permission program — external, stable.
export const PERMISSION_PROGRAM_ID = programIdFromEnv(
  'NEXT_PUBLIC_PERMISSION_PROGRAM_ID',
  'ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1',
);
// Steel staking program — external dependency, stable.
export const STEEL_PROGRAM_ID = programIdFromEnv(
  'NEXT_PUBLIC_STEEL_PROGRAM_ID',
  'FASTPjXb68fPW9JRYSBS3EDoaT6inz84GoqkPK52dsA9',
);
// TEE validator — resolved from validator registry (see validator-registry.ts)
// For existing tables, use detectDelegation() to find the actual validator.
export const TEE_VALIDATOR = getDefaultValidator().pubkey;
export const ER_VALIDATOR = TEE_VALIDATOR;

// Crank service pubkey — included in seatCards permissions so crank can reference
// seatCards in TEE transactions (start_game, tee_deal, settle) without 403.
// (programIdFromEnv validates any base58 pubkey; reused for non-program keys so a
// fork pointing at its own deployment overrides these via env.)
export const CRANK_PUBKEY = programIdFromEnv(
  'NEXT_PUBLIC_CRANK_PUBKEY',
  'EgNQUJgmhCzzm5pB9J8osKBXsdK86MjzLmyNKzsNteLz',
);

// Token & Pool
export const POKER_MINT = programIdFromEnv(
  'NEXT_PUBLIC_POKER_MINT',
  'FP111dxqjLRqtuoknQ8L6aaZjqqyFRT6FcAnaCPytJ3',
);
export const USDC_MAINNET_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
// Default to mainnet when unset. The free RPC pool (rpc-pool.ts) and the
// fallback program IDs are mainnet, so a blank-env run must resolve mainnet too
// — otherwise the app reads mainnet pools as a devnet client (empty/broken
// lobby with no error). Operators targeting devnet set NEXT_PUBLIC_SOLANA_CLUSTER.
const SOLANA_CLUSTER = (
  process.env.NEXT_PUBLIC_SOLANA_CLUSTER ||
  process.env.SOLANA_CLUSTER ||
  'mainnet'
).toLowerCase();
export const IS_MAINNET = SOLANA_CLUSTER === 'mainnet' || SOLANA_CLUSTER === 'mainnet-beta';
export const USDC_MINT = IS_MAINNET ? USDC_MAINNET_MINT : USDC_DEVNET_MINT;
export const POOL_PDA = programIdFromEnv(
  'NEXT_PUBLIC_POOL_PDA',
  'D59fCY6tXeUTDtJ83xnyhJBjQPBe1p4nxwAvWAbCQnXC',
);
export const TREASURY = programIdFromEnv(
  'NEXT_PUBLIC_TREASURY',
  '62N4ubkb4Pv7FhTmUMTZbeRPYW3jm3TSdYpXx5Hh7AAV',
);

export function isUsdcMint(mint: PublicKey): boolean {
  return mint.equals(USDC_MAINNET_MINT) || mint.equals(USDC_DEVNET_MINT);
}

export function isPremiumTokenMint(mint: PublicKey): boolean {
  return mint.equals(PublicKey.default) || mint.equals(POKER_MINT) || isUsdcMint(mint);
}

export function requiresTokenTierConfig(mint: PublicKey): boolean {
  return mint.equals(PublicKey.default) || isUsdcMint(mint);
}

// PDA Seeds
export const TABLE_SEED = 'table';
export const SEAT_SEED = 'seat';
export const PROTOCOL_GUARD_SEED = 'protocol_guard';
export const SEAT_CARDS_SEED = 'seat_cards';
export const PLAYER_SEED = 'player';
export const STAKE_SEED = 'stake';
export const VAULT_SEED = 'vault';
export const RECEIPT_SEED = 'receipt';
export const DEPOSIT_PROOF_SEED = 'deposit_proof';
export const DECK_STATE_SEED = 'deck_state';
export const GLOBAL_ENTROPY_SEED = 'global_entropy_v2';
export const CRANK_TALLY_ER_SEED = 'crank_tally_er';
export const CRANK_TALLY_L1_SEED = 'crank_tally_l1';
export const TIER_CONFIG_SEED = 'tier_config';

// SNG Pool System
export const SNG_POOL_SEED = 'sng_pool';
export const SNG_POOL_VAULT_SEED = 'sng_pool_vault';
export const SNG_QUEUE_PAGE_SEED = 'sng_queue_page';
export const SNG_QUEUE_MARKER_SEED = 'sng_queue_marker';
export const SNG_MATCH_SEED = 'sng_match';
export const SNG_TABLE_SEED = 'sng_table';
export const CRANK_OPERATOR_SEED = 'crank';
export const JACKPOT_GLOBAL_SEED = 'jackpot_global';
export const JACKPOT_BUCKET_SEED = 'jackpot_bucket';
export const JACKPOT_ENTRY_SEED = 'jackpot_entry';
export const SNG_JACKPOT_TABLE_STATE_SEED = 'sng_jackpot_table';
export const SNG_JACKPOT_SETTLEMENT_SEED = 'sng_jackpot_settlement';
export const SNG_MINI_ADDON_LAMPORTS = 10_000_000;

// Dealer License System
export const DEALER_REGISTRY_SEED = 'dealer_registry';
export const DEALER_LICENSE_SEED = 'dealer_license';
export const DEALER_LICENSE_FREE_RESERVE = 26;            // license #0 + 25 giveaways
export const DEALER_LICENSE_PAID_SUPPLY = 9_901;
export const DEALER_LICENSE_TOTAL_SUPPLY = 9_927;
export const DEALER_LICENSE_BASE_PRICE = 1_000_000_000;   // 1 SOL
export const DEALER_LICENSE_INCREMENT: number = 1_000_000;        // +0.001 SOL per paid license
export const DEALER_LICENSE_MAX_PRICE = 10_000_000_000;   // 10 SOL cap

// Data Offsets for reading accounts
export const SEAT_CARDS_OFFSETS = {
  DISCRIMINATOR: 0,
  TABLE: 8,
  SEAT_INDEX: 40,
  PLAYER: 41,
  CARD1: 73,
  CARD2: 74,
  BUMP: 75,
};

// Card constants
export const CARD_NOT_DEALT = 255;

// Table account data offsets (matches Table::SIZE = 458)
export const TABLE_OFFSETS = {
  DISCRIMINATOR: 0,        // 8 bytes
  TABLE_ID: 8,             // 32 bytes
  AUTHORITY: 40,           // 32 bytes (PDA)
  POOL: 72,                // 32 bytes
  GAME_TYPE: 104,          // 1 byte (0=SitAndGoHU, 1=SitAndGo6Max, 2=SitAndGo9Max, 3=CashGame)
  SMALL_BLIND: 105,        // 8 bytes (u64 LE)
  BIG_BLIND: 113,          // 8 bytes (u64 LE)
  MAX_PLAYERS: 121,        // 1 byte
  CURRENT_PLAYERS: 122,    // 1 byte
  HAND_NUMBER: 123,        // 8 bytes (u64 LE)
  POT: 131,                // 8 bytes (u64 LE)
  MIN_BET: 139,            // 8 bytes (u64 LE)
  RAKE_ACCUMULATED: 147,   // 8 bytes (u64 LE)
  COMMUNITY_CARDS: 155,    // 5 bytes
  PHASE: 160,              // 1 byte
  CURRENT_PLAYER: 161,     // 1 byte
  IS_DELEGATED: 174,       // 1 byte (bool)
  SEATS_OCCUPIED: 250,     // 2 bytes (u16 LE)
  CREATOR: 290,            // 32 bytes (Pubkey)
  IS_USER_CREATED: 322,    // 1 byte (bool)
  CREATOR_RAKE_TOTAL: 323, // 8 bytes (u64 LE)
  LAST_RAKE_EPOCH: 331,    // 8 bytes (u64 LE)
  PRIZES_DISTRIBUTED: 339, // 1 byte (bool)
  BUMP: 341,               // 1 byte
  TOKEN_MINT: 385,           // 32 bytes (Pubkey) — after prize_pool(377+8=385)
  BUY_IN_TYPE: 417,          // 1 byte (0=Normal 20-100BB, 1=Deep 50-250BB)
  RAKE_CAP: 418,             // 8 bytes (u64 LE) — rake cap in token units (0=no cap)
  IS_PRIVATE: 426,           // 1 byte (bool) — private table (whitelist-only)
  CRANK_POOL_ACCUMULATED: 427, // 8 bytes (u64 LE) — monotonic crank pool (always active)
};
export const TABLE_ACCOUNT_SIZE = 459; // +1 byte for table_index (was 458)

// ─── SNG Tier System ───
// Mirrors programs/fastpoker/src/constants.rs SnGTier enum
// Mainnet-simulated deploy: no devnet discount.
export const TIER_SCALE: number = 1;
export const SNG_MAINNET_MIN_FEE_LAMPORTS = 50_000_000; // 0.05 SOL
export const SNG_DEVNET_MIN_FEE_LAMPORTS = 10_000_000; // 0.01 SOL
export const SNG_MIN_FEE_LAMPORTS =
  TIER_SCALE === 10 ? SNG_DEVNET_MIN_FEE_LAMPORTS : SNG_MAINNET_MIN_FEE_LAMPORTS;

export enum SnGTier {
  Micro = 0,
  Bronze = 1,
  Silver = 2,
  Gold = 3,
  Platinum = 4,
  Diamond = 5,
  Black = 6,
}

export interface TierInfo {
  id: SnGTier;
  name: string;
  /** Total gameplay buy-in in lamports (entry + fee; excludes page rent reserve contribution). */
  totalBuyIn: number;
  /** Entry amount in lamports (goes to prize pool) */
  entryAmount: number;
  /** Fee amount in lamports (goes to Steel treasury/stakers) */
  feeAmount: number;
  /** Display color class */
  color: string;
  /** Accent border/bg color */
  accent: string;
  /** Short description */
  desc: string;
}

export const SNG_PAGE_RENT_CONTRIBUTION_LAMPORTS = 615_000;

function sngTierAmounts(baseTotalLamports: number) {
  const totalBuyIn = baseTotalLamports / TIER_SCALE;
  const feeAmount = Math.floor(totalBuyIn / 10);
  return {
    totalBuyIn,
    entryAmount: totalBuyIn - feeAmount,
    feeAmount,
  };
}

export const TIERS: TierInfo[] = [
  {
    id: SnGTier.Micro, name: 'Copper',
    ...sngTierAmounts(50_000_000),           // 0.05 SOL mainnet
    color: 'text-[#A05A2C]', accent: 'border-[#A05A2C]/30 bg-[#A05A2C]/5',
    desc: '0.05 SOL buy-in',
  },
  {
    id: SnGTier.Bronze, name: 'Bronze',
    ...sngTierAmounts(100_000_000),          // 0.10 SOL mainnet
    color: 'text-amber-600', accent: 'border-amber-600/20 bg-amber-600/5',
    desc: '0.10 SOL buy-in',
  },
  {
    id: SnGTier.Silver, name: 'Silver',
    ...sngTierAmounts(250_000_000),          // 0.25 SOL mainnet
    color: 'text-slate-300', accent: 'border-slate-300/20 bg-slate-300/5',
    desc: '0.25 SOL buy-in',
  },
  {
    id: SnGTier.Gold, name: 'Gold',
    ...sngTierAmounts(500_000_000),          // 0.50 SOL mainnet
    color: 'text-amber', accent: 'border-amber/25 bg-amber/5',
    desc: '0.50 SOL buy-in',
  },
  {
    id: SnGTier.Platinum, name: 'Platinum',
    ...sngTierAmounts(1_000_000_000),        // 1 SOL mainnet
    color: 'text-orange', accent: 'border-orange/25 bg-orange/5',
    desc: '1 SOL buy-in',
  },
  {
    id: SnGTier.Diamond, name: 'Diamond',
    ...sngTierAmounts(2_000_000_000),        // 2 SOL mainnet
    color: 'text-rose-400', accent: 'border-rose-400/20 bg-rose-400/5',
    desc: '2 SOL buy-in',
  },
  {
    id: SnGTier.Black, name: 'Black',
    ...sngTierAmounts(5_000_000_000),        // 5 SOL mainnet
    color: 'text-zinc-100', accent: 'border-zinc-100/25 bg-zinc-100/5',
    desc: '5 SOL buy-in',
  },
];

export function getTierInfo(tier: SnGTier): TierInfo {
  return TIERS[tier] || TIERS[0];
}

/** Format lamports as SOL string */
export function lamportsToSol(lamports: number): string {
  return (lamports / 1e9).toFixed(lamports >= 1e9 ? 2 : lamports >= 1e8 ? 3 : 4);
}

// PlayerAccount data offsets
export const PLAYER_ACCOUNT_OFFSETS = {
  WALLET: 8,              // 32 bytes
  IS_REGISTERED: 40,      // 1 byte
  FREE_ENTRIES: 41,       // 1 byte
  HANDS_PLAYED: 42,       // 8 bytes (u64)
  HANDS_WON: 50,          // 8 bytes (u64)
  TOTAL_WINNINGS: 58,     // 8 bytes (u64)
  TOTAL_LOSSES: 66,       // 8 bytes (u64)
  TOURNAMENTS_PLAYED: 74, // 4 bytes (u32)
  TOURNAMENTS_WON: 78,    // 4 bytes (u32)
  REGISTERED_AT: 82,      // 8 bytes (i64)
  BUMP: 90,               // 1 byte
  CLAIMABLE_SOL: 91,      // 8 bytes (u64)
  XP: 99,                 // 8 bytes (u64)
  HAND_STREAK: 107,       // 2 bytes (u16)
};
export const PLAYER_CLAIMABLE_SOL_OFFSET = 91; // backwards compat

/** Calculate player level from XP (mirrors on-chain level_from_xp) */
export function levelFromXp(xp: number): number {
  if (xp < 100) return 1;
  if (xp < 300) return 2;
  if (xp < 600) return 3;
  if (xp < 1100) return 4;
  if (xp < 2000) return 5;
  if (xp < 3500) return 6;
  if (xp < 6000) return 7;
  if (xp < 10000) return 8;
  if (xp < 20000) return 9;
  if (xp < 40000) return 10;
  if (xp < 80000) return 11;
  if (xp < 150000) return 12;
  return 13;
}

/** XP needed for next level */
export function xpForNextLevel(xp: number): { current: number; next: number; progress: number } {
  const thresholds = [0, 100, 300, 600, 1100, 2000, 3500, 6000, 10000, 20000, 40000, 80000, 150000];
  const level = levelFromXp(xp);
  const current = thresholds[level - 1] || 0;
  const next = thresholds[level] || thresholds[thresholds.length - 1];
  const progress = next > current ? ((xp - current) / (next - current)) * 100 : 100;
  return { current, next, progress };
}

// Game types
export enum GameType {
  SitAndGoHeadsUp = 'sitAndGoHeadsUp',
  SitAndGo6Max = 'sitAndGo6Max',
  SitAndGo9Max = 'sitAndGo9Max',
  CashGame = 'cashGame',
}

// Rake Cap Tiers (matches on-chain TokenTierConfig SOL_TIER_BOUNDARIES)
export const RAKE_CAP_TIERS = [
  { name: 'Micro',    color: 'text-boneDim',    bg: 'bg-boneDim/8',    border: 'border-boneDim/15',    maxBB: 10_000_000 },
  { name: 'Low',      color: 'text-blue-400',    bg: 'bg-blue-400/8',    border: 'border-blue-400/15',    maxBB: 25_000_000 },
  { name: 'Mid-Low',  color: 'text-teal-400',    bg: 'bg-teal-400/8',    border: 'border-teal-400/15',    maxBB: 50_000_000 },
  { name: 'Mid',      color: 'text-emerald-400', bg: 'bg-emerald-400/8', border: 'border-emerald-400/15', maxBB: 100_000_000 },
  { name: 'Mid-High', color: 'text-amber-400',   bg: 'bg-amber-400/8',  border: 'border-amber-400/15',   maxBB: 500_000_000 },
  { name: 'High',     color: 'text-orange-400',  bg: 'bg-orange-400/8',  border: 'border-orange-400/15',  maxBB: 1_000_000_000 },
  { name: 'Whale',    color: 'text-rose-300',     bg: 'bg-rose-300/8',     border: 'border-rose-300/15',     maxBB: Infinity },
] as const;

export function getRakeCapTier(bigBlindLamports: number) {
  const idx = RAKE_CAP_TIERS.findIndex(t => bigBlindLamports <= t.maxBB);
  return RAKE_CAP_TIERS[idx >= 0 ? idx : RAKE_CAP_TIERS.length - 1];
}

// Stakes
export enum Stakes {
  Micro = 'micro',   // 1/2
  Low = 'low',       // 5/10
  Mid = 'mid',       // 25/50
  High = 'high',     // 100/200
}

// Game phases
export enum GamePhase {
  Waiting = 'waiting',
  Preflop = 'preflop',
  Flop = 'flop',
  Turn = 'turn',
  River = 'river',
  Showdown = 'showdown',
}

// Player actions
export enum PlayerAction {
  Fold = 'fold',
  Check = 'check',
  Call = 'call',
  Bet = 'bet',
  Raise = 'raise',
  AllIn = 'allIn',
}
