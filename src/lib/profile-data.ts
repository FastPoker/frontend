// Curated hand-crafted pixel avatars, handle suggestions, tier unlock ladder,
// and off-chain achievement definitions. Ported 1:1 from Mockup 1.4.
// NFT allowlist is NOT here — it is server-configurable; see /api/nft-allowlist.

export interface CuratedAvatarData {
  id: string;
  name: string;
  colors: string[]; // palette: [bg, c1, c2, c3, ...]
  grid: string;     // 64 chars, each a palette index (0 = transparent). 8×8.
}

export const CURATED_AVATARS: CuratedAvatarData[] = [
  { id: 'ace-spades', name: 'ACE OF SPADES',
    colors: ['#0F1117', '#F5F1E8', '#0A0B10', '#F26A1F'],
    grid:
      '00000000'+'01111110'+'01122110'+'01122110'+
      '01122110'+'01222210'+'01111110'+'00000000' },
  { id: 'king-diamonds', name: 'KING DIAMOND',
    colors: ['#0F1117', '#CC3E3E', '#F5F1E8', '#FFC63A'],
    grid:
      '00033000'+'00311300'+'03122130'+'31222213'+
      '03122130'+'00311300'+'00033000'+'00000000' },
  { id: 'skull', name: 'THE GRIM',
    colors: ['#0F1117', '#F5F1E8', '#0A0B10', '#F26A1F'],
    grid:
      '00111100'+'01111110'+'12211221'+'12211221'+
      '01122110'+'01212110'+'01212110'+'01111110' },
  { id: 'shark', name: 'SHARK',
    colors: ['#0F1117', '#4B607E', '#F5F1E8', '#1B1D26'],
    grid:
      '00111000'+'01111100'+'11111110'+'11212110'+
      '13131310'+'01313100'+'00131000'+'00010000' },
  { id: 'cowboy', name: 'THE COWBOY',
    colors: ['#0F1117', '#7A5A3A', '#F5F1E8', '#2A1D15'],
    grid:
      '00111100'+'11111111'+'00311300'+'02222200'+
      '02122120'+'02122120'+'02222220'+'00322300' },
  { id: 'visor', name: 'HOUSE DEALER',
    colors: ['#0F1117', '#0F5E3A', '#F5F1E8', '#F26A1F'],
    grid:
      '00111100'+'01111110'+'11111111'+'02222220'+
      '00202200'+'00222200'+'00020200'+'00202000' },
  { id: 'chips', name: 'CHIP STACK',
    colors: ['#0F1117', '#CC3E3E', '#1E4E8C', '#F5F1E8'],
    grid:
      '00333300'+'03333330'+'00111100'+'01111110'+
      '00222200'+'02222220'+'00333300'+'03333330' },
  { id: 'ghost', name: 'GHOST',
    colors: ['#0F1117', '#F5F1E8', '#0A0B10'],
    grid:
      '00111100'+'01111110'+'11121211'+'11111111'+
      '11111111'+'11111111'+'10101010'+'01010101' },
  { id: 'cat', name: 'CAT',
    colors: ['#0F1117', '#FFC63A', '#0A0B10', '#F26A1F'],
    grid:
      '01000010'+'01100110'+'01111110'+'12121210'+
      '11131110'+'01111110'+'01111110'+'00110110' },
  { id: 'alien', name: 'ALIEN',
    colors: ['#0F1117', '#6EE7F0', '#0A0B10', '#F26A1F'],
    grid:
      '00111100'+'01111110'+'11211211'+'11111111'+
      '11222211'+'11111111'+'01111110'+'00110110' },
  { id: 'bot', name: 'BOT',
    colors: ['#0F1117', '#6a6578', '#F5F1E8', '#F26A1F'],
    grid:
      '00333300'+'01111110'+'12121211'+'11111111'+
      '11222211'+'01111110'+'01010110'+'01111110' },
  { id: 'knight', name: 'KNIGHT',
    colors: ['#0F1117', '#B8B4A8', '#0A0B10', '#CC3E3E'],
    grid:
      '00011100'+'00111110'+'01121110'+'01112110'+
      '01111110'+'00111100'+'00111000'+'01110000' },
  { id: 'owl', name: 'OWL',
    colors: ['#0F1117', '#7A5A3A', '#F5F1E8', '#FFC63A'],
    grid:
      '01111110'+'12111121'+'12323231'+'12323231'+
      '11121111'+'11111111'+'01111110'+'00110110' },
  { id: 'fox', name: 'FOX',
    colors: ['#0F1117', '#F26A1F', '#F5F1E8', '#0A0B10'],
    grid:
      '10011001'+'11111111'+'12113121'+'11111111'+
      '11311311'+'11211211'+'01212110'+'00111100' },
  { id: 'rabbit', name: 'RABBIT',
    colors: ['#0F1117', '#F5F1E8', '#0A0B10', '#CC3E3E'],
    grid:
      '01001010'+'01001010'+'01101110'+'01111110'+
      '12111211'+'11131111'+'01111110'+'00110110' },
  { id: 'pirate', name: 'PIRATE',
    colors: ['#0F1117', '#F5F1E8', '#0A0B10', '#CC3E3E'],
    grid:
      '00333300'+'03333330'+'01111110'+'12221211'+
      '11111111'+'01111110'+'01333310'+'00131300' },
  { id: 'chad', name: 'CHAD',
    colors: ['#0F1117', '#F5E0C0', '#0A0B10', '#FFC63A'],
    grid:
      '00333300'+'03111130'+'31111113'+'31211213'+
      '31111113'+'03111130'+'00111100'+'00131300' },
  { id: 'joker', name: 'JOKER',
    colors: ['#0F1117', '#B990FF', '#F5F1E8', '#FFC63A'],
    grid:
      '13000031'+'01300310'+'00122100'+'01212210'+
      '11222211'+'11131311'+'01222210'+'00121200' },
];

export const HANDLE_SUGGESTIONS = [
  'paradice_fan', 'chipslinger', 'coldcaller', 'hero_call',
  'thinkingtank', 'solgrinder', 'flopit', 'nitwhisper',
];

export interface TierUnlock {
  key: string;
  name: string;
  level: number;
  unlock: string;
}

export const TIER_UNLOCKS: TierUnlock[] = [
  { key: 'bronze', name: 'BRONZE',   level: 1,  unlock: 'Default frame' },
  { key: 'silver', name: 'SILVER',   level: 5,  unlock: 'NFT avatars' },
  { key: 'gold',   name: 'GOLD',     level: 10, unlock: 'Gold ring + emotes' },
  { key: 'plat',   name: 'PLATINUM', level: 20, unlock: 'Animated ring' },
  { key: 'diam',   name: 'DIAMOND',  level: 35, unlock: 'Particle fx' },
  { key: 'obs',    name: 'OBSIDIAN', level: 50, unlock: 'Obsidian aura' },
];

// NFT tab unlock — keep in sync with the level cutoff that gates wallet NFT picks.
export const NFT_AVATAR_UNLOCK_LEVEL = 5;

export type AchievementTier = 'common' | 'rare' | 'epic' | 'legendary';
export type AchievementIcon =
  | 'hand' | 'pot' | 'trophy' | 'hundred' | 'grind' | 'infinity'
  | 'royal' | 'quads' | 'sflush' | 'allin' | 'mask' | 'license'
  | 'monster' | 'spark' | 'flame' | 'spear' | 'double' | 'bank'
  | 'crown' | 'star' | 'pfp-thumb';

export interface AchievementDef {
  id: string;
  name: string;
  sub: string;
  tier: AchievementTier;
  icon: AchievementIcon;
  /** Path to badge PNG under /badges/, when art is available. Falls back to icon SVG if absent. */
  badge?: string;
  earned: boolean;
  earnedAt?: string;
  progress?: number; // 0..1 for locked
}

export const ACHIEVEMENTS: AchievementDef[] = [
  // Waitlist exclusive — earned by confirming on the launch waitlist.
  // Unlocks the 28 Early Bird PFPs in the avatar picker (see avatars.ts).
  { id: 'early-bird',    name: 'EARLY BIRD',       sub: 'Confirmed on the launch waitlist.',  tier: 'legendary', icon: 'pfp-thumb', badge: '/badges/_0005_Early-Bird.png',       earned: false, progress: 0 },
  // BLACK TIER — reserved for 10 SOL+ SNG buy-ins. Unlocks hype-beast + billionaire PFPs
  // and the all-black matte ring treatment. Currently gated by a wallet whitelist
  // until the on-chain tier exists; see deriveAchievements.
  { id: 'black-tier',    name: 'BLACK TIER',       sub: 'Buy in to a 10 SOL Sit & Go.',        tier: 'legendary', icon: 'crown',     badge: '/avatars/new/billionaire.png', earned: false, progress: 0 },
  { id: 'first-hand',    name: 'FIRST HAND',       sub: 'Play your first cash hand.',         tier: 'common',    icon: 'hand',      badge: '/badges/_0028_First-Hand.png',       earned: false, progress: 0 },
  { id: 'first-sng',     name: 'FIRST SIT & GO',   sub: 'Register for any tournament.',       tier: 'common',    icon: 'trophy',    badge: '/badges/_0027_First-Sit-and-Go.png', earned: false, progress: 0 },
  { id: 'hundo',         name: 'CENTURION',        sub: 'Play 100 hands.',                     tier: 'common',    icon: 'hundred',   badge: '/badges/_0026_Centurion.png',        earned: false, progress: 0 },
  { id: 'first-win',     name: 'FIRST BLOOD',      sub: 'Win your first pot.',                 tier: 'common',    icon: 'spark',     badge: '/badges/_0025_First-Blood.png',      earned: false, progress: 0 },
  { id: 'monster-pot',   name: 'MONSTER POT',      sub: 'Win a pot > 100 BB.',                 tier: 'rare',      icon: 'monster',   badge: '/badges/_0022_Monster-Pot.png',      earned: false, progress: 0 },
  { id: 'itm',           name: 'IN THE MONEY',     sub: 'Cash in any sit & go.',               tier: 'common',    icon: 'pot',       badge: '/badges/_0024_In-The-Money.png',     earned: false, progress: 0 },
  { id: 'first-win-sng', name: 'WIRE TO WIRE',     sub: 'Win a sit & go.',                     tier: 'rare',      icon: 'trophy',    badge: '/badges/_0021_Wire-to-Wire-.png',    earned: false, progress: 0 },
  { id: 'streak-7',      name: '7-DAY GRIND',      sub: 'Play hands 7 days in a row.',          tier: 'rare',      icon: 'grind',     badge: '/badges/_0020_7-Day-Grind-.png',     earned: false, progress: 0 },
  { id: 'allin-win',     name: 'ALL IN',           sub: 'Win a hand going all-in preflop.',    tier: 'rare',      icon: 'allin',     badge: '/badges/_0019_All-In.png',           earned: false, progress: 0 },
  { id: 'bounty-1',      name: 'BOUNTY HUNTER',    sub: 'Claim your first bounty.',            tier: 'rare',      icon: 'spear',     badge: '/badges/_0018_Bounty-Hunter.png',    earned: false, progress: 0 },
  { id: 'doubleup',      name: 'DOUBLE UP',        sub: 'Double a starting stack.',            tier: 'common',    icon: 'double',    badge: '/badges/_0023_Double-Up.png',        earned: false, progress: 0 },
  { id: 'bankroll-5',    name: 'BANKROLL BUILDER', sub: 'Hold 5+ SOL bankroll.',               tier: 'rare',      icon: 'bank',      badge: '/badges/_0017_Bankroll-Builder.png', earned: false, progress: 0 },
  { id: 'quads',         name: 'QUADS',            sub: 'Hit four of a kind at showdown.',     tier: 'epic',      icon: 'quads',     badge: '/badges/_0013_Quads-.png',           earned: false, progress: 0 },
  { id: 'royal',         name: 'ROYAL',            sub: 'Hit a royal flush.',                  tier: 'legendary', icon: 'royal',     badge: '/badges/_0004_Royal.png',            earned: false, progress: 0 },
  { id: 'straight-flush', name: 'STRAIGHT FLUSH',  sub: 'Hit a straight flush.',               tier: 'epic',      icon: 'sflush',    badge: '/badges/_0012_Straight-Flush-.png',  earned: false, progress: 0 },
  { id: 'grind-k',       name: 'K-HAND GRINDER',   sub: 'Play 1,000 hands.',                   tier: 'rare',      icon: 'grind',     badge: '/badges/_0016_K-Hand-Grinder.png',   earned: false, progress: 0 },
  { id: 'infinite',      name: 'INFINITE GRIND',   sub: 'Play 10,000 hands.',                  tier: 'legendary', icon: 'infinity',  badge: '/badges/_0003_Infinite-Grind-.png',  earned: false, progress: 0 },
  { id: 'bluff-master',  name: 'BLUFF MASTER',     sub: 'Win 10 hands with 7-2 offsuit.',      tier: 'epic',      icon: 'mask',      badge: '/badges/_0011_Bluff-Master.png',     earned: false, progress: 0 },
  { id: 'heater',        name: 'HEATER',           sub: '15-hand winning streak.',             tier: 'epic',      icon: 'flame',     badge: '/badges/_0010_Heater.png',           earned: false, progress: 0 },
  { id: 'dealer',        name: 'HOUSE EDGE',       sub: 'Own a Dealer License.',               tier: 'epic',      icon: 'license',   badge: '/badges/_0009_House-Edge.png',       earned: false, progress: 0 },
  { id: 'silver',        name: 'SILVER TIER',      sub: 'Reach level 5.',                      tier: 'rare',      icon: 'star',      badge: '/badges/_0015_Silver-Tier.png',      earned: false, progress: 0 },
  { id: 'gold',          name: 'GOLD TIER',        sub: 'Reach level 10.',                     tier: 'epic',      icon: 'crown',     badge: '/badges/_0008_Gold-Tier.png',        earned: false, progress: 0 },
  { id: 'plat',          name: 'PLATINUM TIER',    sub: 'Reach level 20.',                     tier: 'legendary', icon: 'crown',     badge: '/badges/_0002_Platinum-Tier.png',    earned: false, progress: 0 },
  { id: 'obsidian',      name: 'OBSIDIAN',         sub: 'Reach level 50.',                     tier: 'legendary', icon: 'crown',     badge: '/badges/_0001_Obsidian.png',         earned: false, progress: 0 },
  // Jackpot achievements (JPV1-driven, see project_jpv1_emission)
  { id: 'first-jackpot', name: 'FIRST HIT',        sub: 'Hit any jackpot: Lucky or Royal.',   tier: 'rare',      icon: 'pot',       badge: '/badges/_0014_First-Hit-.png',       earned: false, progress: 0 },
  { id: 'grand-slam',    name: 'ROYAL HIT',        sub: 'Hit your first Royal Jackpot.',      tier: 'epic',      icon: 'crown',     badge: '/badges/_0007_Royal-Hit.png',        earned: false, progress: 0 },
  { id: 'jackpot-hunter', name: 'JACKPOT HUNTER',  sub: 'Hit 5+ jackpots lifetime.',          tier: 'epic',      icon: 'spark',     badge: '/badges/_0006_Jackpot-Hunter.png',   earned: false, progress: 0 },
  { id: 'big-one',       name: 'THE BIG ONE',      sub: 'Land a single hit ≥ 1 SOL.',          tier: 'legendary', icon: 'monster',   badge: '/badges/_0000_The-Big-One.png',      earned: false, progress: 0 },
];

export const ACHIEVEMENT_TIER_STYLE: Record<AchievementTier, { color: string; glow: string }> = {
  common:    { color: '#B8B4A8', glow: '#D4CCAE' },
  rare:      { color: '#6EE7F0', glow: '#9DF0F5' },
  epic:      { color: '#B990FF', glow: '#D4B8FF' },
  legendary: { color: '#FFC63A', glow: '#FFD96A' },
};

// ───────────────────────────────────────────────────────────────────────
// FRAMES — cosmetic ring/halo treatments that overlay on AvatarRing.
// Default falls back to the auto-tier decoration tied to player level.
// Frames unlock via level threshold OR a specific achievement id.
// ───────────────────────────────────────────────────────────────────────

export type FrameId =
  | 'default'
  | 'silver-ring'
  | 'gold-laurel'
  | 'plat-octogram'
  | 'prism-diamond'
  | 'matte-black'
  | 'royal-flush'
  | 'monster-bone'
  | 'infinite-loop'
  | 'early-bird';

export interface FrameDef {
  id: FrameId;
  name: string;
  sub: string;
  /** How the frame is unlocked. */
  unlock:
    | { kind: 'always' }
    | { kind: 'level'; level: number }
    | { kind: 'achievement'; achievementId: string };
}

export const FRAMES: FrameDef[] = [
  { id: 'default',        name: 'DEFAULT',          sub: 'Auto-tier ring · scales with your level.', unlock: { kind: 'always' } },
  { id: 'matte-black',    name: 'MATTE BLACK',      sub: 'Reserved for the Black Tier.',             unlock: { kind: 'achievement', achievementId: 'black-tier' } },
  { id: 'silver-ring',    name: 'SILVER RING',      sub: 'Pin the silver micro-tick ring.',          unlock: { kind: 'level', level: 5 } },
  { id: 'gold-laurel',    name: 'GOLD LAUREL',      sub: 'Pin the gold laurel-arc ring.',            unlock: { kind: 'level', level: 10 } },
  { id: 'plat-octogram',  name: 'PLATINUM OCTOGRAM',sub: 'Pin the octogram + corner pips.',          unlock: { kind: 'level', level: 20 } },
  { id: 'prism-diamond',  name: 'PRISM DIAMOND',    sub: 'Pin the rotating prism + beacon.',         unlock: { kind: 'level', level: 35 } },
  { id: 'early-bird',     name: 'EARLY BIRD',       sub: 'Amber waitlist pulse.',                    unlock: { kind: 'achievement', achievementId: 'early-bird' } },
  { id: 'royal-flush',    name: 'ROYAL FLUSH',      sub: 'Crimson pulse with crown beacon.',         unlock: { kind: 'achievement', achievementId: 'royal' } },
  { id: 'monster-bone',   name: 'MONSTER BONE',     sub: 'Heavy bone ring + monster glow.',          unlock: { kind: 'achievement', achievementId: 'big-one' } },
  { id: 'infinite-loop',  name: 'INFINITE LOOP',    sub: 'Counter-rotating double dashed ring.',     unlock: { kind: 'achievement', achievementId: 'infinite' } },
];

/** Returns true when the player has unlocked the given frame. */
export function isFrameUnlocked(
  frame: FrameDef,
  ctx: { level: number; earnedAchievements: ReadonlySet<string> },
): boolean {
  switch (frame.unlock.kind) {
    case 'always': return true;
    case 'level':  return ctx.level >= frame.unlock.level;
    case 'achievement': return ctx.earnedAchievements.has(frame.unlock.achievementId);
  }
}

/**
 * Lifetime jackpot stats consumed by the achievement deriver. Optional so
 * callers that don't yet wire jackpots in won't break — the four jackpot
 * achievements just stay locked at 0% progress.
 */
export interface JackpotStatsInput {
  jackpotsHit?: number;
  grandsHit?: number;
  largestSingleHitLamports?: number;
}

const ONE_SOL_LAMPORTS = 1_000_000_000;

/**
 * Wallets manually unlocked for the BLACK TIER achievement until the
 * 10 SOL+ SNG tier ships on-chain. Add wallets here for testing only.
 */
const BLACK_TIER_WHITELIST: ReadonlySet<string> = new Set([
  '2KskcmUNXDoL2nD1T7DcgVYmxUYUtTyP4RTmPcJRc9xP',
]);

// Mutate earned state from on-chain stats (caller derives progress from handsPlayed etc.)
export function deriveAchievements(stats: {
  handsPlayed: number;
  handsWon: number;
  tournamentsPlayed: number;
  tournamentsWon: number;
  solBalance: number;
  level: number;
  licenses: number;
  /** True when the user is on the confirmed launch waitlist. */
  earlyBird?: boolean;
  /** Caller's wallet pubkey (base58). Used by manual BLACK TIER whitelist. */
  wallet?: string;
  /** Number of 10 SOL+ Black Tier SNGs the wallet has bought into (lifetime). */
  blackTierEntries?: number;
  /** Made-hand counters from indexer (shown showdowns). */
  royalCount?: number;
  straightFlushCount?: number;
  quadsCount?: number;
  /** Streak / cash-out counters from indexer (recomputeMadeHands). */
  bestWinStreak?: number;       // HEATER — consecutive won hands
  bestActiveDayStreak?: number; // 7-DAY GRIND — consecutive play days
  doubledUp?: boolean;          // DOUBLE UP — cashed out >= 2x buy-in
  allInPreflopWins?: number;    // ALL IN — won a hand after a preflop all-in
  /** Achievement ids already persisted on the user's profile. Sticky:
   *  an id here is treated as earned even if it can't be re-derived now. */
  persistedEarned?: string[];
} & JackpotStatsInput): AchievementDef[] {
  const jackpotsHit = stats.jackpotsHit ?? 0;
  const grandsHit = stats.grandsHit ?? 0;
  const biggestHit = stats.largestSingleHitLamports ?? 0;
  const earlyBird = stats.earlyBird ?? false;
  const blackTier =
    (stats.blackTierEntries ?? 0) >= 1 ||
    (!!stats.wallet && BLACK_TIER_WHITELIST.has(stats.wallet));
  const royalCount = stats.royalCount ?? 0;
  const straightFlushCount = stats.straightFlushCount ?? 0;
  const quadsCount = stats.quadsCount ?? 0;
  const bestWinStreak = stats.bestWinStreak ?? 0;
  const bestActiveDayStreak = stats.bestActiveDayStreak ?? 0;
  const doubledUp = stats.doubledUp ?? false;
  const allInPreflopWins = stats.allInPreflopWins ?? 0;
  const persistedEarned = new Set(stats.persistedEarned ?? []);

  return ACHIEVEMENTS.map(a => {
    const next = { ...a };
    switch (a.id) {
      case 'early-bird':    next.earned = earlyBird;                       next.progress = earlyBird ? 1 : 0; break;
      case 'black-tier':    next.earned = blackTier;                       next.progress = blackTier ? 1 : 0; break;
      case 'first-hand':    next.earned = stats.handsPlayed >= 1;          next.progress = Math.min(1, stats.handsPlayed / 1); break;
      case 'first-sng':     next.earned = stats.tournamentsPlayed >= 1;    next.progress = Math.min(1, stats.tournamentsPlayed / 1); break;
      case 'hundo':         next.earned = stats.handsPlayed >= 100;        next.progress = Math.min(1, stats.handsPlayed / 100); break;
      case 'first-win':     next.earned = stats.handsWon >= 1;             next.progress = Math.min(1, stats.handsWon / 1); break;
      case 'itm':           next.earned = stats.tournamentsWon >= 1 || stats.tournamentsPlayed >= 3; next.progress = 0; break;
      case 'first-win-sng': next.earned = stats.tournamentsWon >= 1;       next.progress = Math.min(1, stats.tournamentsWon / 1); break;
      case 'bankroll-5':    next.earned = stats.solBalance >= 5;           next.progress = Math.min(1, stats.solBalance / 5); break;
      case 'grind-k':       next.earned = stats.handsPlayed >= 1000;       next.progress = Math.min(1, stats.handsPlayed / 1000); break;
      case 'infinite':      next.earned = stats.handsPlayed >= 10000;      next.progress = Math.min(1, stats.handsPlayed / 10000); break;
      case 'silver':        next.earned = stats.level >= 5;                next.progress = Math.min(1, stats.level / 5); break;
      case 'gold':          next.earned = stats.level >= 10;               next.progress = Math.min(1, stats.level / 10); break;
      case 'plat':          next.earned = stats.level >= 20;               next.progress = Math.min(1, stats.level / 20); break;
      case 'obsidian':      next.earned = stats.level >= 50;               next.progress = Math.min(1, stats.level / 50); break;
      case 'dealer':        next.earned = stats.licenses >= 1;             next.progress = Math.min(1, stats.licenses / 1); break;
      // Made hands. A royal flush is also a straight flush, so it satisfies both.
      case 'royal':          next.earned = royalCount >= 1;                 next.progress = Math.min(1, royalCount / 1); break;
      case 'straight-flush': next.earned = (straightFlushCount + royalCount) >= 1; next.progress = Math.min(1, (straightFlushCount + royalCount) / 1); break;
      case 'quads':          next.earned = quadsCount >= 1;                 next.progress = Math.min(1, quadsCount / 1); break;
      // Streak / cash-out badges (indexer-derived counters).
      case 'heater':         next.earned = bestWinStreak >= 15;             next.progress = Math.min(1, bestWinStreak / 15); break;
      case 'streak-7':       next.earned = bestActiveDayStreak >= 7;        next.progress = Math.min(1, bestActiveDayStreak / 7); break;
      case 'doubleup':       next.earned = doubledUp;                       next.progress = doubledUp ? 1 : 0; break;
      case 'allin-win':      next.earned = allInPreflopWins >= 1;           next.progress = Math.min(1, allInPreflopWins / 1); break;
      case 'first-jackpot':  next.earned = jackpotsHit >= 1;                next.progress = Math.min(1, jackpotsHit / 1); break;
      case 'grand-slam':     next.earned = grandsHit >= 1;                  next.progress = Math.min(1, grandsHit / 1); break;
      case 'jackpot-hunter': next.earned = jackpotsHit >= 5;                next.progress = Math.min(1, jackpotsHit / 5); break;
      case 'big-one':        next.earned = biggestHit >= ONE_SOL_LAMPORTS;  next.progress = Math.min(1, biggestHit / ONE_SOL_LAMPORTS); break;
      default: break;
    }
    // Sticky: anything persisted on the profile stays earned even if the
    // derived check above couldn't reproduce it (e.g. a manually-granted badge).
    if (persistedEarned.has(a.id)) { next.earned = true; next.progress = 1; }
    return next;
  });
}
