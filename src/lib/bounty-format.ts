// Player-facing copy for SnG Duels Bounty Rewards.
// Mirror of lib/jackpot-format.ts: internal contract names are never shown; the framing is an
// aggressive bounty/duel format. NEVER surface "anti-collusion", "seat integrity", "fair play",
// or "coordination" - that is the internal threat model, not the product.

export const DUEL_FORMAT_NAME = 'SnG Duels';
export const DUEL_FORMAT_TAGLINE = 'Bounty knockouts. Blind-level duels.';

export const BOUNTY_NAME = 'Bounty';
export const KNOCKOUT_NAME = 'Knockout';
export const KNOCKOUT_SHORT = 'KO';
export const BOUNTY_BANK_NAME = 'Bounty Bank';
export const MATURITY_NAME = 'Maturity';
export const DUEL_RANK_NAME = 'Duel Rank';

export const DUEL_STATE_LABEL = {
  warmup: 'Duels: warm-up',
  live: 'Duels LIVE',
  pending: 'Duel incoming',
  active: 'Duel LIVE',
} as const;

export const COPY = {
  bountySplit:
    'SOL: 50% knockout bounties + 50% finish-rank (ITM). $FP: 100% bounties, scaled by Maturity.',
  fpPureBounty: '$FP is pure bounty - earn it by knocking players out, not by placing.',
  maturity:
    'Your $FP bounties grow with the blind level - the deeper the game runs, the more they pay.',
  duelWarmup: 'Warm-up duels (Levels 1-2): no chips at risk.',
  duelLive: 'Live duels (Level 3+): symmetric blind-scaled chip stakes.',
  earnPerKo: 'Earn extra SOL and $FP for every opponent you knock out.',
  bankPersists:
    'Your Bounty Bank keeps growing even after you bust - it settles at the final Maturity.',
} as const;

/** Player-facing duel-choice label (contract: 0 none / 1 accept deal / 2 redeal).
 *  Flat-bounty (2026-07-14): the stake is symmetric and NEITHER action opts out -
 *  choice 1 accepts the current cards, choice 2 asks for the next deal. */
export function duelChoiceLabel(choice: number): string {
  switch (choice) {
    case 1: return 'PLAY';
    case 2: return 'NEXT CARDS';
    default: return '...';
  }
}

// ---- Flat Bounty copy (2026-07-14 rework) ----
// Every player is seeded 1 bounty point. Points move ONLY on an actual knockout:
// the victim's point goes to the winner(s) eligible for the side pot holding the
// victim's contribution, and tied winners split it fractionally. Scheduled duels
// are symmetric blind-scaled chip contests; a duel moves a point only if it busts
// the loser. Points pay the bounty pools pro-rata at the end.
export const SHIELD_RULESET_NAME = 'Flat Bounty';
export const POINT_NAME = 'Point';
export const POINTS_NAME = 'Points';

export const SHIELD_COPY = {
  bountySplit:
    'SOL: 50% bounty points + 50% finish-rank (ITM). $FP: 100% points, scaled by Maturity.',
  points:
    'Everyone starts with 1 bounty point. Points move only on knockouts - bust a player and their point is yours. Tied winners split the point.',
  duel:
    'Each blind level, two players duel for a symmetric chip stake. PLAY accepts the deal, NEXT CARDS redeals - either way the stake is on.',
  duelBust:
    'A duel moves chips, not points - unless it busts the loser. A duel knockout takes their bounty point like any other.',
  splits:
    'Tied knockout pots split the bounty point between the eligible winners - half each, or a third each three ways.',
  bankPersists:
    'Points you hold when you bust still pay out at settlement - the bank survives the felt.',
} as const;

/** Hero CTA for accepting the duel deal. The stake is symmetric, so both
 *  buttons carry the same wager; the label says what accepting costs. */
export function duelActionLabel(stake?: number): string {
  return stake ? `PLAY FOR ${stake.toLocaleString()}` : 'PLAY';
}

/** One-line stakes description for the duel overlay (flat bounty).
 *  Same wording for duelists and spectators - the stake is symmetric, so there
 *  is no hero-oriented asymmetry to phrase around. "Up to" covers the cap at
 *  the shorter stack. */
export function duelStakesLine(stake: number): string {
  return `Both risk up to ${stake.toLocaleString()} chips - a knockout also takes a bounty point`;
}

/** Blinds row above the stakes line: the duel hand posts the live blinds, and those
 *  chips count toward the symmetric stake. */
export function duelBlindsLine(smallBlind: number, bigBlind: number): string {
  return `Blinds ${smallBlind.toLocaleString()}/${bigBlind.toLocaleString()} committed`;
}
