'use client';

/**
 * PokerTable — Mockup 1.4 Action-Hero Cockpit Rewrite (1:1 port)
 *
 * Every visual element comes from Fast Poker_UI_MOCKUP1.4/parts:
 *   - seat.jsx       → TurnTimer, PlayerSeat, HeroCockpit, InlineCeremony
 *   - actions.jsx    → BettingControls
 *   - cards.jsx      → PlayingCard, CommunityBoard, HoleCards
 *   - chips.jsx      → ChipStack, FlyingChip, PotDisplay, SidePotFan
 *   - log.jsx        → ActionLog, SngStandings
 *   - avatar.jsx     → PixelAvatar
 *   - progression.jsx → AvatarRing (tier-based ring w/ XP arc)
 *   - primitives.jsx → Eyebrow, TxPill, fmt, fmtCompact, shortWallet
 *
 * On-chain data contract (PokerTableProps) is preserved — only the visual
 * layer changed. `useOnChainGame` hook remains untouched.
 */

import { useState, useMemo, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { usePlayerNotes, type NoteColor } from '@/hooks/usePlayerNotes';
import { PlayerNoteModal } from '@/components/game/PlayerNoteModal';
import { useRouter } from 'next/navigation';
import { Connection } from '@solana/web3.js';
import { cn } from '@/lib/utils';
import { makeL1Connection, L1_RPC, TIERS } from '@/lib/constants';
import { claimRaw, claimAndStake, readUnrefinedMicros } from '@/lib/refine-claim';
import { evaluateHand, compareHands, HandRank, HandResult } from '@/lib/hand-evaluator';
import { useSoundEffects } from '@/hooks/useSoundEffects';
import { SFX } from '@/lib/sfx';
import { fpDebug, isFpDebugEnabled } from '@/lib/fp-debug';
import { getAvatarById } from '@/lib/avatars';
import { useTokenLogo } from '@/hooks/useTokenLogo';
import { usePrices } from '@/hooks/usePrices';
import { PROFILE_API_ENABLED } from '@/lib/feature-flags';
import { calculateSngPoolUnrefined } from '@/lib/emission';
import { Coins, Menu, Share2, Volume2, VolumeX, Lock, StickyNote, Link2 } from 'lucide-react';
import { requestOpenSessionRenewModal } from '@/components/layout/SessionRenewModal';
import {
  useCardPrefs,
  setCardPrefs,
  BET_PRESET_DEFAULTS,
  BET_PRESET_MIN_COUNT,
  BET_PRESET_MAX_COUNT,
  BET_PRESET_MIN_PCT,
  BET_PRESET_MAX_PCT,
  BET_PRESET_MIN_BB,
  BET_PRESET_MAX_BB,
  type BetPreset,
  type DeckColors,
  type CardFont,
  type HeroPosition,
  type CardSize as PrefCardSize,
} from '@/lib/card-prefs';

// Map the user-facing cardSize pref to the actual CARD_SIZES key used by
// HoleCards/PlayingCard. Different surfaces (rail / felt) have different
// base sizes — the pref shifts both up or down together.
function railCardSize(pref: PrefCardSize): CardSize {
  if (pref === 'small') return 'md';
  if (pref === 'large') return 'xl';
  if (pref === 'xl') return 'xl';
  return 'lg';
}
function feltCardSize(pref: PrefCardSize): CardSize {
  if (pref === 'small') return 'sm';
  if (pref === 'large') return 'lg';
  if (pref === 'xl') return 'xl';
  return 'md';
}
// Community board sizing. 9-max tables have less center real-estate so the
// base is one step smaller; 6-max / HU get the larger base. The user's
// S/M/L/XL pref shifts within each base.
function communityCardSize(pref: PrefCardSize, maxSeats: number): CardSize {
  const tight = maxSeats >= 9;
  if (tight) {
    if (pref === 'small') return 'sm';
    if (pref === 'large') return 'lg';
    if (pref === 'xl') return 'xl';
    return 'md';
  }
  if (pref === 'small') return 'md';
  if (pref === 'large') return 'xl';
  if (pref === 'xl') return 'xl';
  return 'lg';
}
// Negative top offset for rail-floated hero cards. Keeps the cards mostly
// ABOVE the rail (~30px peek into it) regardless of size so the identity
// row stays unobstructed. Calibrated against CARD_SIZES heights:
//   small  -> md card (74h), peek 30 -> -44
//   default-> lg card (92h), peek 30 -> -62
//   large  -> xl card (120h), peek 30 -> -90
function railCardTopOffsetStyle(pref: PrefCardSize): React.CSSProperties {
  const top = pref === 'small' ? -44
    : pref === 'large' ? -90
    : pref === 'xl' ? -90
    : -62;
  return { top };
}
// ReadyOverlay removed — SNG flow no longer has a ready-up gate.
import { GameEndOverlay, type GameEndResult } from './chrome';
import BountyDuelHud from '@/components/bounty/BountyDuelHud';
import DuelOverlay from '@/components/bounty/DuelOverlay';
import BountyHudBar from '@/components/bounty/BountyHudBar';
import SeatBountyBadge from '@/components/bounty/SeatBountyBadge';
import { fpEvent } from '@/lib/fp-events';
import { TokenMark } from '@/components/bounty/TokenMark';
import { useSngBountyState } from '@/hooks/useSngBountyState';
import { seatViews, formatPoints } from '@/lib/sng-duel-view';
import { maturityBps as duelMaturityBps, SOL_BOUNTY_BPS, BOUNTY_UNIT } from '@/lib/sng-duel';
import { sngDuelsEnabled } from '@/lib/sng-duel-flags';

const SOL_MINT = '11111111111111111111111111111111';
const POKER_MINT = 'FP111dxqjLRqtuoknQ8L6aaZjqqyFRT6FcAnaCPytJ3';
const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

function getTokenSymbol(mint?: string): string {
  if (!mint) return '';
  if (mint === SOL_MINT) return 'SOL';
  if (mint === POKER_MINT) return '$FP';
  if (mint === USDC_MAINNET_MINT || mint === USDC_DEVNET_MINT) return 'USDC';
  return mint.slice(0, 4) + '...';
}

function getTokenDecimals(mint?: string): number {
  if (mint === USDC_MAINNET_MINT || mint === USDC_DEVNET_MINT) return 6;
  return 9;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Types (data contract — do not break)
// ═══════════════════════════════════════════════════════════════════════════

interface Player {
  pubkey: string;
  chips: number;
  bet: number;
  folded: boolean;
  isActive: boolean;
  isAllIn?: boolean;
  isSittingOut?: boolean;
  isLeaving?: boolean;
  isDealer?: boolean;
  timeBankSeconds?: number;
  timeBankActive?: boolean;
  vaultReserve?: number;
  position?: 'SB' | 'BB' | 'BTN' | 'UTG' | 'MP' | 'CO';
  holeCards?: [number, number];
  /** Seat's on-chain approved_signer — used to verify a voluntary card show. */
  approvedSigner?: string;
  seatIndex: number;
  level?: number;
  missedSb?: boolean;
  missedBb?: boolean;
  waitingForBb?: boolean;
  totalBetThisHand?: number;
  xpProgress?: number;
}

interface HandAction {
  player: string;
  action: string;
  amount?: number;
  phase: string;
}

interface PlayerAction {
  seatIndex: number;
  action: string;
  timestamp: number;
}

type CeremonyKind =
  | 'hand-won' | 'all-in-won' | 'bluff' | 'itm' | 'heads-up'
  | 'bubble' | 'stack-doubled' | 'bad-beat' | 'first-hand' | 'level-up';

type CeremonyPayload = { kind: CeremonyKind; amount?: number; amountLabel?: string };

interface SidePot {
  amount: number;
  eligibleSeats?: number[];
}

type SngEndPlayer = {
  pubkey: string;
  seatIndex: number;
  chips: number;
  isActive: boolean;
};

type SngEndSnapshot = {
  players: SngEndPlayer[];
  maxPlayers: number;
  currentPlayers: number;
  seatsOccupied: number;
  eliminatedSeats: number[];
  eliminatedCount: number;
  tier: number;
  /** True only when the whole SNG is over (winner decided). False when the hero
   *  busted but the tournament is still running — prizes don't distribute until
   *  it finishes, so the overlay must say "claimable after the game finishes",
   *  not "distributing now". */
  tournamentOver: boolean;
};

interface PokerTableProps {
  tablePda: string;
  phase: string;
  pot: number;
  currentPlayer: number;
  communityCards: number[];
  players: Player[];
  myCards?: [number, number];
  /** Session pubkeys at this table that share a device (anti-collusion). A seat
   *  whose approvedSigner is in this set gets a "LINKED" nameplate badge. */
  linkedSigners?: Set<string>;
  /** Off-chain voluntary card shows for the current hand: seatIndex -> { cards,
   *  signer }. Only displayed when `signer` matches the seat's approvedSigner. */
  shownCards?: Record<number, { cards: [number, number]; signer: string }>;
  /** Relay the hero's own cards (post-hand only). */
  onShowCards?: (cards: [number, number]) => Promise<boolean>;
  /** Hero has already shown this hand. */
  revealedThisHand?: boolean;
  onAction?: (action: string, amount?: number) => void;
  /** SnG Duels: submit a Bell-duel choice (all-in/fold). Seats come from the sidecar. */
  onDuelAction?: (action: 'all-in' | 'fold', seatA: number, seatB: number) => Promise<string | null> | void;
  /** Player-authenticated TEE connection for standalone live duel reads. */
  bountyTeeConnection?: Connection | null;
  isMyTurn?: boolean;
  sessionClaimRequired?: boolean;
  sessionClaimDebug?: string | null;
  onClaimSeatSession?: () => void;
  blinds?: { small: number; big: number };
  dealerSeat?: number;
  maxSeats?: number;
  handHistory?: HandAction[];
  actionPending?: boolean;
  playerActions?: PlayerAction[];
  showdownPot?: number;
  // Per-player gross return at showdown, keyed by pubkey. Lets each winner in
  // an unequal all-in split show their REAL amount instead of an equal slice.
  showdownPayouts?: Record<string, number>;
  pastHands?: HandAction[][];
  viewingPastHand?: number | null;
  onHandNav?: (index: number | null) => void;
  tier?: number;
  prizePool?: number;
  maxPlayers?: number;
  currentPlayers?: number;
  seatsOccupied?: number;
  eliminatedSeats?: number[];
  eliminatedCount?: number;
  lastActionSlot?: number;
  blindLevel?: number;
  tournamentStartTime?: number;
  currentBet?: number;
  tokenMint?: string;
  /** Real token decimals (resolved from the mint by the page). Overrides the
   *  known-token guess so any listed token scales correctly. */
  tokenDecimals?: number;
  onSeatClick?: (seatIndex: number) => void;
  pendingJoinSeat?: number | null;
  reservedJoinSeat?: number | null;
  selectedJoinSeat?: number | null;
  reservedJoinSeats?: number[];
  joiningSeat?: number | null;
  debugClearingSeats?: number[];
  isCashGame?: boolean;
  handNumber?: number;
  blindDeadline?: number;
  blindsPosted?: number;
  smallBlindSeat?: number;
  bigBlindSeat?: number;
  onPostBlind?: () => void;
  isMeSittingOut?: boolean;
  autoPostBlinds?: boolean;
  setAutoPostBlinds?: (v: boolean) => void;
  onSitOut?: () => void;
  onSitIn?: (postMissedBlinds?: boolean) => void;
  isMaintenance?: boolean;
  verifyUrl?: string | null;
  sittingOutPending?: boolean;
  // ── Added to support mockup 1.4 ceremonies & side-pots ────────────────
  ceremony?: CeremonyPayload | null;
  sidePots?: SidePot[];
  onOpenTopUp?: () => void;
  // ── Mockup 1.4 TableInfoBar top-right pills ──────────────────────────
  onOpenTipJar?: () => void;
  tipJarBalance?: number;
  tipJarHands?: number;
  onShareTable?: () => void;
  onLeaveTable?: () => void;
  leavingTable?: boolean;
  /** Rake rate in basis points (cash games; 500 = 5%). */
  rakeBps?: number;
  /** Per-table rake cap in token base units (0 = uncapped). */
  rakeCap?: number;
  devSlot?: React.ReactNode;
  devMyPubkey?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Primitives (ported from primitives.jsx)
// ═══════════════════════════════════════════════════════════════════════════

function committedFor(player: Pick<Player, 'totalBetThisHand' | 'bet'>): number {
  return Math.max(0, player.totalBetThisHand ?? 0, player.bet ?? 0);
}

function isAllInPlayer(player: Player): boolean {
  return !!player.isAllIn || (!!player.isActive && !player.folded && (player.chips || 0) <= 0 && committedFor(player) > 0);
}

function reachableCommitFor(player: Player): number {
  return committedFor(player) + Math.max(0, player.chips || 0);
}

function uncalledReturnFor(player: Player, players: Player[]): number {
  if (!isAllInPlayer(player) || player.folded) return 0;

  const committed = committedFor(player);
  const largestOtherReach = players.reduce((max, other) => {
    if (!other || other.pubkey === player.pubkey || other.folded || !other.isActive) return max;
    return Math.max(max, reachableCommitFor(other));
  }, 0);

  return Math.max(0, committed - largestOtherReach);
}

function getPotUiAmounts(players: Player[], rawPot: number) {
  const uncalledByPubkey: Record<string, number> = {};
  let totalUncalled = 0;

  for (const player of players) {
    const uncalled = uncalledReturnFor(player, players);
    if (uncalled > 0) {
      uncalledByPubkey[player.pubkey] = uncalled;
      totalUncalled += uncalled;
    }
  }

  return {
    contestablePot: Math.max(0, rawPot - totalUncalled),
    uncalledByPubkey,
  };
}

function canRaiseAgainstLiveOpponent(players: Player[], hero: Player | undefined, isSng: boolean): boolean {
  if (!hero) return true;
  return players.some(player =>
    player.pubkey !== hero.pubkey &&
    !player.folded &&
    // SNG: a sitting-out opponent is still dealt and in the hand, and can match a
    // raise (auto-folds at the 5s floor or acts-to-return), so it's a valid raise
    // target. Cash sit-out seats are never dealt. An all-in opponent is never
    // raise-able regardless (you can only call their all-in).
    (player.isActive || (isSng && !!player.isSittingOut)) &&
    !isAllInPlayer(player) &&
    (player.chips || 0) > 0
  );
}

function firstSeatInMask(mask: number, maxSeats: number): number | null {
  for (let seat = 0; seat < maxSeats; seat++) {
    if ((mask & (1 << seat)) !== 0) return seat;
  }
  return null;
}

function getSngFinishPlace(snapshot: SngEndSnapshot, pubkey?: string): number | null {
  if (!pubkey) return null;

  const player = snapshot.players.find(p => p.pubkey === pubkey);
  if (!player) return null;

  const eliminatedOrder = snapshot.eliminatedSeats
    .slice(0, Math.min(snapshot.eliminatedCount, snapshot.maxPlayers))
    .filter(seat => seat >= 0 && seat < snapshot.maxPlayers);
  const winnerSeat = snapshot.currentPlayers <= 1
    ? firstSeatInMask(snapshot.seatsOccupied, snapshot.maxPlayers)
    : null;

  if (winnerSeat != null && player.seatIndex === winnerSeat) return 1;

  const eliminatedIdx = eliminatedOrder.indexOf(player.seatIndex);
  if (eliminatedIdx >= 0) return snapshot.maxPlayers - eliminatedIdx;

  const rankedFallback = [...snapshot.players].sort((a, b) => {
    const aWinner = winnerSeat != null && a.seatIndex === winnerSeat;
    const bWinner = winnerSeat != null && b.seatIndex === winnerSeat;
    if (aWinner !== bWinner) return aWinner ? -1 : 1;
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return (b.chips || 0) - (a.chips || 0);
  });

  const fallbackIdx = rankedFallback.findIndex(p => p.pubkey === pubkey);
  return fallbackIdx >= 0 ? fallbackIdx + 1 : null;
}

function fmt(n: number | null | undefined): string {
  if (n == null) return '';
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  return String(n);
}

function shortWallet(pk: string | null | undefined, head = 4): string {
  if (!pk) return '';
  return pk.slice(0, head) + '…' + pk.slice(-3);
}

function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('eyebrow', className)}>{children}</span>;
}

function TxPill({ id, label }: { id: string; label?: string }) {
  return (
    <span className="tx-pill inline-flex items-center gap-1">
      {label && <span className="text-gold/70">{label}</span>}
      <span>{id}</span>
    </span>
  );
}

// Deterministic FNV-1a hash + LCG rng (for PixelAvatar)
function hash32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822519);
    s = Math.imul(s ^ (s >>> 13), 3266489917);
    s ^= s >>> 16;
    return (s >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Card helpers
// ═══════════════════════════════════════════════════════════════════════════

const SUIT_NAMES = ['spade', 'heart', 'diamond', 'club'] as const;
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const SUIT_SVG: Record<string, string> = {
  spade:   'M12 2.5C9 6 4 9.5 4 14a5 5 0 0 0 7.2 4.5L10.5 22h3l-.7-3.5A5 5 0 0 0 20 14c0-4.5-5-8-8-11.5z',
  heart:   'M12 21.2C7 17 2.5 13.5 2.5 9c0-2.8 2.2-5 5-5 1.8 0 3.4 1 4.5 2.5C13.1 5 14.7 4 16.5 4c2.8 0 5 2.2 5 5 0 4.5-4.5 8-9.5 12.2z',
  diamond: 'M12 2.5L4 12l8 9.5L20 12z',
  // Classic club: three explicit circular lobes (top + two bottom-side) drawn
  // as separate arc subpaths so they render as perfect circles regardless of
  // scale, plus a tapered triangular stem widening at the base. Subpaths fill
  // with nonzero rule so overlaps unify into a single club silhouette.
  club:    'M12 4.5 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 Z M8 11.5 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 Z M16 11.5 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 Z M10 13 Q12 15.5 14 13 L15.4 21 L8.6 21 Z',
};

function Suit({ name, className }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d={SUIT_SVG[name] || SUIT_SVG.spade} />
    </svg>
  );
}

function cardToString(cardNum: number) {
  if (cardNum < 0 || cardNum > 51 || cardNum === 255) return null;
  const rankIdx = cardNum % 13;
  const suitIdx = Math.floor(cardNum / 13);
  return {
    rank: RANKS[rankIdx],
    suitName: SUIT_NAMES[suitIdx] || 'spade',
    isRed: suitIdx === 1 || suitIdx === 2,
  };
}

function cardShort(cardNum: number) {
  const card = cardToString(cardNum);
  if (!card) return '?';
  const suit = card.suitName === 'spade' ? 's'
    : card.suitName === 'heart' ? 'h'
    : card.suitName === 'diamond' ? 'd'
    : 'c';
  return `${card.rank}${suit}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Value formatter (lamports vs virtual chips)
// ═══════════════════════════════════════════════════════════════════════════

// When `usdRate` is supplied (only valid for SOL cash games today), the
// formatter converts lamports → USD using the live rate from usePrices().
// Non-SOL SPL games are unaffected — a price oracle for each SPL token would
// be needed to extend this. Toggle wired through useCardPrefs().showFiat.
function makeValueFormatter(_bigBlind: number, _mint?: string, isCashGame?: boolean, usdRate?: number, decimals?: number) {
  const isLamports = isCashGame === true;
  if (!isLamports) return (v: number) => v.toLocaleString();
  const tokenBase = 10 ** (decimals ?? getTokenDecimals(_mint));
  if (usdRate && usdRate > 0) {
    return (v: number) => {
      const usd = (v / tokenBase) * usdRate;
      if (usd === 0) return '$0';
      const formatted = usd >= 1 ? usd.toFixed(2) : usd >= 0.01 ? usd.toFixed(3) : usd.toFixed(4);
      return '$' + parseFloat(formatted).toString();
    };
  }
  return (v: number) => {
    const val = v / tokenBase;
    if (val === 0) return '0';
    const raw = val >= 1 ? val.toFixed(4) : val >= 0.01 ? val.toFixed(4) : val >= 0.0001 ? val.toFixed(6) : val.toFixed(9);
    return parseFloat(raw).toString();
  };
}

// Inverse of makeValueFormatter: parse a typed display string back into the
// internal bet amount (chips for SNG, token base units for cash). Returns null
// when the input isn't a number. Used by the custom bet-amount input so a typed
// value maps to the same units the slider/presets use.
function makeValueParser(_bigBlind: number, _mint?: string, isCashGame?: boolean, usdRate?: number, decimals?: number) {
  const isLamports = isCashGame === true;
  // SNG / chip tables: the display IS the raw chip count.
  if (!isLamports) {
    return (s: string): number | null => {
      const n = parseInt(s.replace(/[^0-9]/g, ''), 10);
      return Number.isNaN(n) ? null : n;
    };
  }
  const tokenBase = 10 ** (decimals ?? getTokenDecimals(_mint));
  // Cash with USD display: typed dollars → token base units via the rate.
  if (usdRate && usdRate > 0) {
    return (s: string): number | null => {
      const usd = parseFloat(s.replace(/[^0-9.]/g, ''));
      return Number.isNaN(usd) ? null : Math.round((usd / usdRate) * tokenBase);
    };
  }
  // Cash with token display (SOL / SPL): typed token units → base units.
  return (s: string): number | null => {
    const val = parseFloat(s.replace(/[^0-9.]/g, ''));
    return Number.isNaN(val) ? null : Math.round(val * tokenBase);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Playing cards (cards.jsx 1:1)
// ═══════════════════════════════════════════════════════════════════════════

type CardSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
// Bicycle "Large Print" / EZ See style — the only thing on each card is a
// jumbo rank + jumbo suit in two opposing corners. No center pip art. The
// rank + suit pair fills ~70-75% of the card height. The `pip` field is
// retained on the type for backwards-compat but no longer rendered.
// Each rank renders as an SVG with textLength forcing it into a fixed box,
// so single-char ranks (A/K/Q/J/2-9) and the two-char "10" all occupy the
// same width and the same visual height. Suit is absolutely positioned at
// a constant offset on every card. rankW × rankH define the rank slot;
// suitPx defines the suit svg size.
const CARD_SIZES: Record<CardSize, { w: number; h: number; rankW: number; rankH: number; suitPx: number; suitY: number }> = {
  // suitY = vertical offset of the suit from the top/bottom edge. Larger
  // values pull the suit toward the vertical center of the card, giving
  // the Bicycle Big Print look where the suit sits slightly inboard of
  // the rank rather than hugging the corner.
  xs: { w: 28, h: 40, rankW: 8,  rankH: 12, suitPx: 10, suitY: 6 },
  sm: { w: 44, h: 62, rankW: 16, rankH: 22, suitPx: 18, suitY: 10 },
  md: { w: 52, h: 74, rankW: 20, rankH: 28, suitPx: 22, suitY: 12 },
  lg: { w: 64, h: 92, rankW: 26, rankH: 36, suitPx: 28, suitY: 16 },
  xl: { w: 84, h: 120, rankW: 36, rankH: 50, suitPx: 38, suitY: 22 },
};

// Render the rank as SVG <text> with textLength + lengthAdjust so 2-char
// "10" squeezes into the same box as single-char "A"/"K"/etc. Without
// this, "10" either wraps, overflows the card, or has to shrink its
// font-size and end up visually shorter than the other ranks.
function RankGlyph({ rank, w, h }: { rank: string; w: number; h: number }) {
  // "J" is the only rank with a descender. Serif faces (especially Bitter
  // Black on the CARDS option) carry a deep hooked J that overflows a
  // standard glyph box and makes the J read ~25% larger than the other
  // ranks. We shrink J's fontSize and shift its baseline up so the whole
  // glyph — body + hook — fits in the same envelope as A/K/Q.
  const isJ = rank === 'J';
  const fontScale = isJ ? 0.68 : 0.88;
  const baselineY = isJ ? h * 0.70 : h * 0.80;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden style={{ overflow: 'hidden' }}>
      <text
        x={w / 2}
        y={baselineY}
        textAnchor="middle"
        fontSize={h * fontScale}
        fontWeight={800}
        textLength={w}
        lengthAdjust="spacingAndGlyphs"
        fill="currentColor"
        style={{ fontFamily: 'inherit' }}
      >
        {rank}
      </text>
    </svg>
  );
}

function PlayingCard({ cardNum, hidden = false, size = 'md', className, style, faceDown, outlineOnly, animate }: {
  cardNum?: number; hidden?: boolean; size?: CardSize; className?: string;
  style?: React.CSSProperties; faceDown?: boolean; outlineOnly?: boolean; animate?: string;
}) {
  // Pref opt-in to keep BOTH corner labels upright (so 6 and 9 don't look like
  // each other). When false (default): standard Bicycle layout, bottom corners
  // rotated 180°.
  const cardPrefs = useCardPrefs();
  const bottomTransform = cardPrefs.uprightCorners ? undefined : 'rotate(180deg)';
  const s = CARD_SIZES[size];
  if (outlineOnly) {
    return <div className={cn('rounded-md border border-gold/10 bg-ink/40', className)} style={{ width: s.w, height: s.h, ...style }} />;
  }
  if (hidden || faceDown) {
    return (
      <div id="playing-card-back-shell" className={cn('card-back relative overflow-hidden', animate, className)} style={{ width: s.w, height: s.h, ...style }}>
        <img src="/brand/card_back.png" alt="" aria-hidden className="absolute inset-0 w-full h-full" style={{ objectFit: 'fill' }} />
      </div>
    );
  }
  const card = cardNum != null ? cardToString(cardNum) : null;
  if (!card) return <div className={cn('rounded-md', className)} style={{ width: s.w, height: s.h, ...style }} />;
  const colorClass = `suit-${card.suitName}`;
  // Bicycle Big Print layout — 4 quadrants:
  //   • Top-left: rank glyph
  //   • Top-right: suit pip
  //   • Bottom-left: suit pip rotated 180°
  //   • Bottom-right: rank glyph rotated 180°
  // Suit sits at a constant absolute offset on every card. Rank is rendered
  // via RankGlyph (SVG textLength) so 2-char "10" fills the same slot as
  // single-char ranks and every card lines up identically in a row.
  return (
    <div
      className={cn('card-face relative font-display font-semibold', colorClass, animate, className)}
      style={{ width: s.w, height: s.h, ...style }}
    >
      <div style={{ position: 'absolute', top: 4, left: 4 }}>
        <RankGlyph rank={card.rank} w={s.rankW} h={s.rankH} />
      </div>
      <div style={{ position: 'absolute', top: s.suitY, right: 4, width: s.suitPx, height: s.suitPx }}>
        <Suit name={card.suitName} className="w-full h-full" />
      </div>
      <div style={{ position: 'absolute', bottom: s.suitY, left: 4, width: s.suitPx, height: s.suitPx, transform: bottomTransform }}>
        <Suit name={card.suitName} className="w-full h-full" />
      </div>
      <div style={{ position: 'absolute', bottom: 4, right: 4, transform: bottomTransform }}>
        <RankGlyph rank={card.rank} w={s.rankW} h={s.rankH} />
      </div>
    </div>
  );
}

function CommunityBoard({ cards, size = 'md', animateKey = 0 }: { cards: number[]; size?: CardSize; animateKey?: number }) {
  const slots = [0, 1, 2, 3, 4];
  return (
    <div className="flex items-center gap-1.5">
      {slots.map(i => {
        const n = cards[i];
        const dealt = n != null && n !== 255 && n >= 0 && n <= 51;
        const delay = i < 3 ? i * 80 : (i - 2) * 120;
        const key = `${animateKey}-${i}-${n}`;
        if (!dealt) return <PlayingCard key={key} outlineOnly size={size} />;
        return (
          <PlayingCard
            key={key}
            cardNum={n}
            size={size}
            animate="deal-in"
            style={{ animationDelay: `${delay}ms`, ['--dx' as any]: `${-60 + i * 15}px`, ['--dy' as any]: '-60px', ['--rz' as any]: '-12deg' }}
          />
        );
      })}
    </div>
  );
}

function HoleCards({ cards, size = 'md', revealed = true, className, stagger = 0, fan = false, animate = true, overlap = false }: {
  cards?: [number, number]; size?: CardSize; revealed?: boolean; className?: string; stagger?: number; fan?: boolean; animate?: boolean;
  // overlap: tuck the 2nd card partway behind the 1st (no rotation) so the pair
  // takes ~60% of the side-by-side width. Used for opponent seat cards to save
  // horizontal room on mobile/landscape. `fan` (hero) takes precedence.
  overlap?: boolean;
}) {
  const [a, b] = cards || [255, 255];
  const tuck = overlap && !fan ? -Math.round(CARD_SIZES[size].w * 0.42) : 0;
  const base1: React.CSSProperties | undefined = fan
    ? { transform: 'rotate(-6deg)' }
    : tuck ? { position: 'relative', zIndex: 1 } : undefined;
  const base2: React.CSSProperties | undefined = fan
    ? { transform: 'rotate(6deg)', marginLeft: -10 }
    : tuck ? { marginLeft: tuck } : undefined;
  const anim = animate ? 'deal-in' : undefined;
  return (
    <div className={cn('flex items-end', overlap && !fan ? 'gap-0' : 'gap-1', className)}>
      <PlayingCard cardNum={a} hidden={!revealed} size={size} animate={anim} style={{ animationDelay: `${stagger}ms`, ...base1 }} />
      <PlayingCard cardNum={b} hidden={!revealed} size={size} animate={anim} style={{ animationDelay: `${stagger + 120}ms`, ...base2 }} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Chips (chips.jsx 1:1)
// ═══════════════════════════════════════════════════════════════════════════

interface ChipDenom { v: number; cls: string; label: string; }

function chipDenomsForBlind(bigBlind: number): ChipDenom[] {
  const bb = Math.max(1, Math.floor(bigBlind || 1));
  return [
    { v: bb * 100, cls: 'chip-gold', label: '100BB' },
    { v: bb * 25,  cls: 'chip-bone', label: '25BB' },
    { v: bb * 5,   cls: 'chip-red',  label: '5BB' },
    { v: bb,       cls: 'chip-blu',  label: '1BB' },
    { v: Math.max(1, Math.floor(bb / 4)), cls: 'chip-ink', label: '<1BB' },
  ];
}

function breakdownChips(amount: number, bigBlind: number = 1): ChipDenom[] {
  if (amount <= 0) return [];
  const out: ChipDenom[] = [];
  let left = Math.max(1, Math.floor(amount));
  for (const d of chipDenomsForBlind(bigBlind)) {
    while (left >= d.v && out.length < 14) {
      out.push(d);
      left -= d.v;
    }
  }
  return out;
}

function ChipStack({ amount, size = 'md', label, layout = 'auto', showLabel = true, className, style, fmtVal, bigBlind = 1 }: {
  amount: number; size?: 'sm' | 'md' | 'lg'; label?: string;
  layout?: 'auto' | 'single' | 'triple' | 'double'; showLabel?: boolean;
  className?: string; style?: React.CSSProperties; fmtVal?: (v: number) => string; bigBlind?: number;
}) {
  const chips = useMemo(() => breakdownChips(amount, bigBlind), [amount, bigBlind]);
  if (!chips.length) return null;
  const cellW = size === 'lg' ? 20 : size === 'sm' ? 12 : 16;
  const thick = size === 'lg' ? 5 : size === 'sm' ? 2.5 : 3.5;
  const columns = layout === 'single' ? 1 :
                  layout === 'triple' ? 3 :
                  layout === 'double' ? 2 :
                  chips.length > 10 ? 3 : chips.length > 5 ? 2 : 1;
  const perCol = Math.ceil(chips.length / columns);
  const cols: ChipDenom[][] = [];
  for (let c = 0; c < columns; c++) cols.push(chips.slice(c * perCol, (c + 1) * perCol));

  const stackWithLabel = showLabel && amount > 0;
  return (
    // With a label the value sits directly BELOW the chip stack (column);
    // label-less stacks (pot / side pots) stay a tidy bottom-aligned row.
    <div className={cn(stackWithLabel ? 'inline-flex flex-col items-center gap-0.5' : 'inline-flex items-end gap-1.5', className)} style={style}>
      <div className="flex items-end gap-[2px]">
        {cols.map((col, ci) => (
          <div key={ci} className="flex flex-col-reverse items-center" style={{ width: cellW }}>
            {col.map((chip, i) => (
              <div
                key={i}
                className={cn('chip chip-in', chip.cls)}
                style={{
                  width: cellW,
                  height: cellW,
                  marginTop: i === 0 ? 0 : -(cellW - thick),
                  animationDelay: `${(ci * perCol + i) * 40}ms`,
                }}
              />
            ))}
          </div>
        ))}
      </div>
      {stackWithLabel && (
        <span className="font-mono text-gold text-[11px] font-semibold tabular-nums leading-none">
          {fmtVal ? fmtVal(amount) : fmt(amount)}
        </span>
      )}
    </div>
  );
}

function FlyingChip({ sx, sy, denom = 'chip-red', delay = 0, size = 14, direction = 'to-pot' }: {
  sx: number; sy: number; denom?: string; delay?: number; size?: number; direction?: 'to-pot' | 'to-seat';
}) {
  return (
    <div
      className={cn('absolute chip', direction === 'to-seat' ? 'chip-arc-to-seat' : 'chip-arc')}
      style={{
        width: size, height: size,
        top: '50%', left: '50%',
        ['--sx' as any]: `${sx}px`,
        ['--sy' as any]: `${sy}px`,
        animationDelay: `${delay}ms`,
      }}
    >
      <div className={cn('chip w-full h-full', denom)} />
    </div>
  );
}

function PotDisplay({ amount, pulsing, size = 'md', fmtVal, bigBlind = 1 }: {
  amount: number; pulsing?: boolean; size?: 'md' | 'lg'; fmtVal: (v: number) => string; bigBlind?: number;
}) {
  if (amount <= 0) return null;
  const labelSize = size === 'lg' ? 'text-[13px]' : 'text-[11px]';
  const valSize = size === 'lg' ? 'text-2xl' : 'text-lg';
  return (
    <div className={cn('flex flex-col items-center gap-1.5', pulsing && 'pot-pulse')}>
      <div className="flex items-center gap-1.5">
        <ChipStack amount={amount} size={size} showLabel={false} layout="triple" fmtVal={fmtVal} bigBlind={bigBlind} />
      </div>
      <div className="flex items-baseline gap-1.5">
        <Eyebrow className={labelSize}>Pot</Eyebrow>
        <span className={cn('font-display font-semibold text-bone tabular-nums', valSize)}>
          {fmtVal(amount)}
        </span>
      </div>
    </div>
  );
}

function SidePotFan({ mainPot, sidePots, fmtVal, bigBlind = 1 }: {
  mainPot: number; sidePots?: SidePot[]; fmtVal: (v: number) => string; bigBlind?: number;
}) {
  if (!sidePots?.length) return <PotDisplay amount={mainPot} fmtVal={fmtVal} bigBlind={bigBlind} />;
  return (
    <div className="flex items-end gap-3">
      <div className="flex flex-col items-center gap-1 sidepot-fan">
        <ChipStack amount={mainPot} size="md" showLabel={false} layout="triple" fmtVal={fmtVal} bigBlind={bigBlind} />
        <div className="flex items-baseline gap-1.5">
          <Eyebrow>Main</Eyebrow>
          <span className="font-display font-semibold text-bone tabular-nums text-base">{fmtVal(mainPot)}</span>
        </div>
      </div>
      {sidePots.map((sp, i) => (
        <div key={i} className="flex flex-col items-center gap-1 sidepot-fan">
          <ChipStack amount={sp.amount} size="sm" showLabel={false} layout="double" fmtVal={fmtVal} bigBlind={bigBlind} />
          <div className="flex items-baseline gap-1.5">
            <Eyebrow>Side {i + 1}</Eyebrow>
            <span className="font-display font-semibold text-bone/80 tabular-nums text-sm">{fmtVal(sp.amount)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  PixelAvatar (avatar.jsx 1:1) — deterministic 8×8 symmetric pixel face
// ═══════════════════════════════════════════════════════════════════════════

const AVATAR_PALETTES = [
  { bg: '#1a1a2a', fg: '#C9A84C', accent: '#E2C36A', eye: '#070710' },
  { bg: '#0e1a1a', fg: '#8FB39A', accent: '#C8D9C6', eye: '#070710' },
  { bg: '#1a0e1a', fg: '#B98FB3', accent: '#D9C6D4', eye: '#070710' },
  { bg: '#1a1210', fg: '#C9965C', accent: '#E2B97C', eye: '#070710' },
  { bg: '#0e1420', fg: '#8FA5C9', accent: '#C6D2E2', eye: '#070710' },
  { bg: '#20140e', fg: '#C98F5C', accent: '#E2B47C', eye: '#070710' },
  { bg: '#1a1a20', fg: '#A89AC9', accent: '#C6C0E2', eye: '#070710' },
  { bg: '#10201a', fg: '#5CC99C', accent: '#7CE2B4', eye: '#070710' },
];

function PixelAvatar({ seed = 'x', size = 40, gridSize = 8, className, style }: {
  seed?: string; size?: number; gridSize?: number; className?: string; style?: React.CSSProperties;
}) {
  const cells = useMemo(() => {
    const r = rng(hash32(seed || 'x'));
    const pal = AVATAR_PALETTES[Math.floor(r() * AVATAR_PALETTES.length)];
    const half = Math.ceil(gridSize / 2);
    const grid: (string | null)[][] = [];
    for (let y = 0; y < gridSize; y++) {
      const row: (string | null)[] = [];
      for (let x = 0; x < half; x++) {
        const edge = x === 0 || y === 0 || y === gridSize - 1;
        const p = edge ? 0.35 : 0.55;
        const on = r() < p;
        const accent = on && r() < 0.12;
        row.push(on ? (accent ? 'a' : 'f') : null);
      }
      const mirrored = [...row].reverse().slice(gridSize % 2 === 0 ? 0 : 1);
      grid.push(row.concat(mirrored));
    }
    const eyeRow = Math.floor(gridSize * 0.4);
    const eyeCol = Math.floor(gridSize * 0.28);
    grid[eyeRow][eyeCol] = 'e';
    grid[eyeRow][gridSize - 1 - eyeCol] = 'e';
    return { grid, pal };
  }, [seed, gridSize]);

  return (
    <div
      className={cn('pixel-avatar relative overflow-hidden', className)}
      style={{ width: size, height: size, background: cells.pal.bg, borderRadius: Math.round(size * 0.22), ...style }}
    >
      <svg viewBox={`0 0 ${gridSize} ${gridSize}`} width={size} height={size} shapeRendering="crispEdges">
        {cells.grid.flatMap((row, y) =>
          row.map((v, x) => {
            if (!v) return null;
            const fill = v === 'f' ? cells.pal.fg : v === 'a' ? cells.pal.accent : cells.pal.eye;
            return <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={fill} />;
          })
        )}
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  AvatarRing (progression.jsx) — tier-based frame + XP progress arc
//  Simplified: ROOKIE/BRONZE/SILVER/GOLD/PLATINUM/DIAMOND with unique geometry
// ═══════════════════════════════════════════════════════════════════════════

const LEVEL_XP = (lvl: number) => Math.round(100 * Math.pow(1.4, lvl));

interface Tier { key: string; name: string; color: string; glow: string; ring: string; accent: string; minLevel: number; }
function tierForLevel(lvl: number): Tier {
  if (lvl >= 50) return { key: 'obsidian', name: 'OBSIDIAN', color: '#B990FF', glow: '#F0D6FF', ring: '#D8B4FE', accent: '#6EE7F0', minLevel: 50 };
  if (lvl >= 35) return { key: 'diamond', name: 'DIAMOND', color: '#6EE7F0', glow: '#9DF0F5', ring: '#BFF5FA', accent: '#B990FF', minLevel: 35 };
  if (lvl >= 20) return { key: 'platinum', name: 'PLATINUM', color: '#D9D9D9', glow: '#FFFFFF', ring: '#F5F5F5', accent: '#B3A8E0', minLevel: 20 };
  if (lvl >= 10) return { key: 'gold', name: 'GOLD', color: '#F2C36A', glow: '#FFD96A', ring: '#FFE08A', accent: '#F26A1F', minLevel: 10 };
  if (lvl >= 5)  return { key: 'silver', name: 'SILVER', color: '#C0C8D0', glow: '#E0E8F0', ring: '#D6DDE4', accent: '#8FA0B0', minLevel: 5 };
  if (lvl >= 1)  return { key: 'bronze', name: 'BRONZE', color: '#B98558', glow: '#D9A374', ring: '#D9A374', accent: '#8B5A2B', minLevel: 1 };
  return { key: 'none', name: 'ROOKIE', color: '#6a6578', glow: '#6a6578', ring: '#3a3a44', accent: '#3a3a44', minLevel: 0 };
}

type SeatFrameId =
  | 'default'
  | 'silver-ring' | 'gold-laurel' | 'plat-octogram' | 'prism-diamond'
  | 'matte-black' | 'royal-flush' | 'monster-bone' | 'infinite-loop' | 'early-bird';

function AvatarRing({ size = 46, level = 0, xp = 0, seed = 'x', frameAnim = 'subtle', avatarImage, avatarEmoji, frame = 'default', showLevelBadge = true }: {
  size?: number; level?: number; xp?: number; seed?: string;
  frameAnim?: 'off' | 'subtle' | 'full';
  avatarImage?: string | null; avatarEmoji?: string | null;
  frame?: SeatFrameId;
  /** Mobile seats render the level on the nameplate's outward side instead, so
   *  the on-avatar badge is suppressed there (the tier frame still shows). */
  showLevelBadge?: boolean;
}) {
  const tier = tierForLevel(level);
  const nextXp = LEVEL_XP(level);
  const pct = Math.max(0, Math.min(1, xp / nextXp));
  const pad = tier.key === 'obsidian' ? 17 : tier.key === 'diamond' ? 16 : tier.key === 'platinum' ? 14 : tier.key === 'gold' ? 12 : tier.key === 'silver' ? 10 : tier.key === 'bronze' ? 9 : 8;
  const outer = size + pad;
  const cx1 = outer / 2, cy1 = outer / 2;
  const xpR = outer * 0.47;
  const xpC = 2 * Math.PI * xpR;
  const animOn = frameAnim !== 'off';
  const seedSafe = (seed || 'x').replace(/[^a-zA-Z0-9]/g, '') || 'x';
  // Map level-tier frame overrides to tier.key so existing branches paint that tier.
  const overrideTierKey: string | null =
    frame === 'silver-ring' ? 'silver'
    : frame === 'gold-laurel' ? 'gold'
    : frame === 'plat-octogram' ? 'platinum'
    : frame === 'prism-diamond' ? 'diamond'
    : null;
  const renderTierKey = overrideTierKey ?? tier.key;
  const isCustomFrame = frame === 'matte-black' || frame === 'royal-flush' || frame === 'monster-bone' || frame === 'infinite-loop' || frame === 'early-bird';

  return (
    <div className="relative inline-block" style={{ width: outer, height: outer, verticalAlign: 'middle' }}>
      <svg width={outer} height={outer} className="absolute inset-0" style={{ pointerEvents: 'none', overflow: 'visible' }}>
        <defs>
          <linearGradient id={`xpg-${seedSafe}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={tier.ring} />
            <stop offset="100%" stopColor={tier.glow} />
          </linearGradient>
          <radialGradient id={`halo-${seedSafe}`}>
            <stop offset="0%" stopColor={tier.glow} stopOpacity="0.55" />
            <stop offset="70%" stopColor={tier.glow} stopOpacity="0.08" />
            <stop offset="100%" stopColor={tier.glow} stopOpacity="0" />
          </radialGradient>
          {(tier.key === 'diamond' || tier.key === 'obsidian') && (
            <linearGradient id={`prism-${seedSafe}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#6EE7F0" />
              <stop offset="33%" stopColor="#B990FF" />
              <stop offset="66%" stopColor="#FFD96A" />
              <stop offset="100%" stopColor="#6EE7F0" />
            </linearGradient>
          )}
        </defs>

        {!isCustomFrame && renderTierKey !== 'none' && (
          <circle cx={cx1} cy={cy1} r={outer * 0.5} fill={`url(#halo-${seedSafe})`} className={animOn ? 'xp-breathe' : ''} />
        )}

        {!isCustomFrame && renderTierKey === 'none' && (
          <circle cx={cx1} cy={cy1} r={xpR} fill="none" stroke={tier.color} strokeOpacity="0.35" strokeWidth={1.4} strokeDasharray="2 3" />
        )}

        {/* MATTE BLACK — Black Tier (no inner fill so the avatar shows through;
            matte bezel rings + white XP arc, no perimeter text). */}
        {frame === 'matte-black' && (
          <g>
            <circle cx={cx1} cy={cy1} r={xpR + 2.5} fill="none" stroke="#1a1a1a" strokeWidth={1.2} opacity={0.85} />
            <circle cx={cx1} cy={cy1} r={xpR} fill="none" stroke="#0a0a0a" strokeWidth={2.4} />
            <circle cx={cx1} cy={cy1} r={xpR} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={1.2} strokeLinecap="round" strokeDasharray={`${xpC * 0.18} ${xpC * 0.82}`} transform={`rotate(-135 ${cx1} ${cy1})`} style={{ filter: 'drop-shadow(0 0 2px rgba(255,255,255,0.12))' }} />
          </g>
        )}
        {/* ROYAL FLUSH */}
        {frame === 'royal-flush' && (
          <g>
            <circle cx={cx1} cy={cy1} r={outer * 0.5} fill="rgba(204,62,62,0.30)" className={animOn ? 'xp-breathe' : ''} />
            <circle cx={cx1} cy={cy1} r={xpR + 1.5} fill="none" stroke="#CC3E3E" strokeWidth={1} opacity={0.55} />
            <circle cx={cx1} cy={cy1} r={xpR} fill="none" stroke="#CC3E3E" strokeWidth={2.2} style={{ filter: 'drop-shadow(0 0 4px rgba(204,62,62,0.55))' }} />
            <g transform={`translate(${cx1}, ${cy1 - xpR - 4})`}>
              <path d="M -4 2 L -3 -2 L -1 0 L 0 -3 L 1 0 L 3 -2 L 4 2 Z" fill="#FFD96A" stroke="#CC3E3E" strokeWidth={0.6} />
            </g>
          </g>
        )}
        {/* MONSTER BONE */}
        {frame === 'monster-bone' && (
          <g>
            <circle cx={cx1} cy={cy1} r={outer * 0.5} fill="rgba(245,241,230,0.18)" className={animOn ? 'xp-breathe' : ''} />
            <circle cx={cx1} cy={cy1} r={xpR + 2} fill="none" stroke="#F5F1E6" strokeWidth={0.9} opacity={0.45} />
            <circle cx={cx1} cy={cy1} r={xpR} fill="none" stroke="#F5F1E6" strokeWidth={2.8} style={{ filter: 'drop-shadow(0 0 5px rgba(242,106,31,0.55))' }} />
            <circle cx={cx1} cy={cy1} r={xpR - 2.5} fill="none" stroke="rgba(242,106,31,0.35)" strokeWidth={1} />
          </g>
        )}
        {/* INFINITE LOOP */}
        {frame === 'infinite-loop' && (
          <g>
            <circle cx={cx1} cy={cy1} r={outer * 0.5} fill="rgba(110,231,240,0.16)" />
            <g className={animOn ? 'xp-rotate' : ''} style={{ transformOrigin: `${cx1}px ${cy1}px` }}>
              <circle cx={cx1} cy={cy1} r={xpR + 3} fill="none" stroke="#6EE7F0" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
            </g>
            <g style={{ transformOrigin: `${cx1}px ${cy1}px`, animation: animOn ? 'xp-rotate 18s linear infinite reverse' : 'none' }}>
              <circle cx={cx1} cy={cy1} r={xpR} fill="none" stroke="#9DF0F5" strokeWidth={1.4} strokeDasharray="2 4" opacity={0.85} />
            </g>
          </g>
        )}
        {/* EARLY BIRD */}
        {frame === 'early-bird' && (
          <g>
            <circle cx={cx1} cy={cy1} r={outer * 0.5} fill="rgba(255,198,58,0.28)" className={animOn ? 'xp-breathe' : ''} />
            <circle cx={cx1} cy={cy1} r={xpR + 1.5} fill="none" stroke="#FFC63A" strokeWidth={0.9} opacity={0.55} />
            <circle cx={cx1} cy={cy1} r={xpR} fill="none" stroke="#FFC63A" strokeWidth={1.8} style={{ filter: 'drop-shadow(0 0 4px rgba(255,198,58,0.55))' }} />
            <circle cx={cx1} cy={cy1 - xpR - 1} r={1.6} fill="#FFD96A" className={animOn ? 'xp-breathe' : ''} />
          </g>
        )}

        {!isCustomFrame && renderTierKey === 'bronze' && (
          <g>
            <circle cx={cx1} cy={cy1} r={xpR} fill="none" stroke={tier.color} strokeOpacity="0.35" strokeWidth={2.2} />
            {[0, 1, 2, 3].map(i => {
              const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
              const x1 = cx1 + Math.cos(a) * (xpR - 1);
              const y1 = cy1 + Math.sin(a) * (xpR - 1);
              const x2 = cx1 + Math.cos(a) * (xpR + 4);
              const y2 = cy1 + Math.sin(a) * (xpR + 4);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={tier.glow} strokeWidth={2.2} strokeLinecap="round" />;
            })}
          </g>
        )}

        {!isCustomFrame && renderTierKey === 'silver' && (
          <g>
            <circle cx={cx1} cy={cy1} r={xpR + 3} fill="none" stroke={tier.color} strokeOpacity="0.45" strokeWidth={1} />
            <circle cx={cx1} cy={cy1} r={xpR} fill="none" stroke={tier.color} strokeOpacity="0.3" strokeWidth={1.6} />
            {Array.from({ length: 16 }).map((_, i) => {
              const a = (i / 16) * Math.PI * 2;
              const x1 = cx1 + Math.cos(a) * (xpR + 0.5);
              const y1 = cy1 + Math.sin(a) * (xpR + 0.5);
              const x2 = cx1 + Math.cos(a) * (xpR + 2.5);
              const y2 = cy1 + Math.sin(a) * (xpR + 2.5);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={tier.glow} strokeWidth={0.8} opacity={0.55} />;
            })}
          </g>
        )}

        {!isCustomFrame && renderTierKey === 'gold' && (
          <g className={animOn ? 'xp-rotate' : ''} style={{ transformOrigin: `${cx1}px ${cy1}px` }}>
            <circle cx={cx1} cy={cy1} r={xpR} fill="none" stroke={tier.color} strokeOpacity="0.3" strokeWidth={2} />
            {Array.from({ length: 6 }).map((_, i) => {
              const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
              const lx = cx1 + Math.cos(a) * (xpR + 3);
              const ly = cy1 + Math.sin(a) * (xpR + 3);
              const tail = a + 0.28;
              const tx = cx1 + Math.cos(tail) * (xpR + 5);
              const ty = cy1 + Math.sin(tail) * (xpR + 5);
              return (
                <g key={i}>
                  <path d={`M ${cx1 + Math.cos(a) * xpR} ${cy1 + Math.sin(a) * xpR} Q ${lx} ${ly} ${tx} ${ty}`} stroke={tier.glow} strokeWidth={1.6} fill="none" strokeLinecap="round" />
                  <circle cx={lx} cy={ly} r={1.6} fill={tier.glow} />
                </g>
              );
            })}
          </g>
        )}

        {!isCustomFrame && renderTierKey === 'platinum' && (
          <g>
            <polygon
              points={Array.from({ length: 8 }).map((_, i) => {
                const a = (i / 8) * Math.PI * 2 - Math.PI / 8;
                return `${cx1 + Math.cos(a) * (xpR + 4)},${cy1 + Math.sin(a) * (xpR + 4)}`;
              }).join(' ')}
              fill="none" stroke={tier.color} strokeOpacity="0.55" strokeWidth={1.2}
            />
            {Array.from({ length: 8 }).map((_, i) => {
              const a = (i / 8) * Math.PI * 2 - Math.PI / 8;
              const x = cx1 + Math.cos(a) * (xpR + 4);
              const y = cy1 + Math.sin(a) * (xpR + 4);
              return (
                <g key={i}>
                  <circle cx={x} cy={y} r={1.8} fill={tier.glow} />
                  <circle cx={x} cy={y} r={0.8} fill={tier.accent} />
                </g>
              );
            })}
          </g>
        )}

        {!isCustomFrame && (renderTierKey === 'diamond' || renderTierKey === 'obsidian') && (
          <g>
            <g className={animOn ? 'xp-rotate' : ''} style={{ transformOrigin: `${cx1}px ${cy1}px` }}>
              <circle cx={cx1} cy={cy1} r={xpR + 4} fill="none" stroke={`url(#prism-${seedSafe})`} strokeWidth={1} strokeDasharray="3 2" opacity={0.85} />
              {Array.from({ length: 12 }).map((_, i) => {
                const a = (i / 12) * Math.PI * 2;
                const x = cx1 + Math.cos(a) * (xpR + 4);
                const y = cy1 + Math.sin(a) * (xpR + 4);
                return <circle key={i} cx={x} cy={y} r={0.9} fill={tier.glow} />;
              })}
            </g>
            <g transform={`translate(${cx1}, ${cy1 - xpR - 5})`}>
              <polygon points="0,-3 3,0 0,3 -3,0" fill={`url(#prism-${seedSafe})`} stroke={tier.glow} strokeWidth={0.6} />
            </g>
          </g>
        )}

        <circle
          cx={cx1} cy={cy1} r={xpR} fill="none"
          stroke={frame === 'matte-black' ? '#F5F1E6' : `url(#xpg-${seedSafe})`}
          strokeOpacity={frame === 'matte-black' ? 0.55 : 1}
          strokeWidth={2.4} strokeLinecap="round"
          strokeDasharray={`${xpC * pct} ${xpC}`}
          transform={`rotate(-90 ${cx1} ${cy1})`}
          style={{
            filter: frame === 'matte-black'
              ? 'drop-shadow(0 0 2px rgba(245,241,230,0.25))'
              : level >= 5 ? `drop-shadow(0 0 3px ${tier.glow}aa)` : 'none',
          }}
        />
      </svg>

      <div style={{ position: 'absolute', top: pad / 2, left: pad / 2, zIndex: 2 }}>
        {avatarImage ? (
          <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden' }}>
            <img src={avatarImage} alt="" className="w-full h-full object-cover" />
          </div>
        ) : avatarEmoji ? (
          <div
            className="flex items-center justify-center"
            style={{ width: size, height: size, fontSize: size * 0.55, background: '#1a1a2a', borderRadius: '50%' }}
          >
            {avatarEmoji}
          </div>
        ) : (
          <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden' }}>
            <PixelAvatar seed={seed} size={size} />
          </div>
        )}
      </div>

      {showLevelBadge && tier.key !== 'none' && (
        <div
          className="absolute flex items-center justify-center leading-none z-30"
          style={{
            bottom: -2,
            right: tier.key === 'obsidian' || tier.key === 'diamond' || tier.key === 'platinum' ? -4 : -2,
            padding: '1px 3px',
            minWidth: 18,
            background: tier.key === 'obsidian'
              ? `linear-gradient(135deg, #07090B, #201334)`
              : tier.key === 'diamond'
                ? `linear-gradient(135deg, #0A0D10, #1A2428)`
                : '#07090B',
            border: `1px solid ${tier.color}`,
            borderRadius: tier.key === 'platinum' || tier.key === 'diamond' || tier.key === 'obsidian' ? 0 : 3,
            clipPath: tier.key === 'platinum' || tier.key === 'obsidian' ? 'polygon(15% 0, 100% 0, 100% 85%, 85% 100%, 0 100%, 0 15%)' : undefined,
            boxShadow: tier.key === 'diamond' || tier.key === 'obsidian' ? `0 0 8px ${tier.glow}66` : 'none',
          }}
        >
          <span className="font-mono text-[8px] font-bold tabular-nums" style={{ color: tier.color }}>
            {level}
          </span>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  TurnTimer (seat.jsx 1:1) — ring variant only on floor, ring used in cockpit
// ═══════════════════════════════════════════════════════════════════════════

const TIME_BANK_CHUNK_SECONDS = 15;
const TIME_BANK_MAX_SECONDS = 60;

// Voluntary "show my cards" feature flag. DISABLED for now — the full relay +
// display path stays wired, but the trigger button never renders. Re-enable
// only once the post-hand gate is fully verified (must be impossible to show
// while a hand is live / mid-reveal). When true, the gate is phase === 'Complete'
// ONLY (the hand is fully over) — NOT isShowdown, which can be true mid-runout.
const SHOW_CARDS_ENABLED = false;

// Private-note color tags → swatch hex. 'none' (and unknown) map to undefined so
// no dot renders. Keep in lockstep with NOTE_COLORS in lib/player-notes.ts.
const NOTE_DOT: Record<string, string | undefined> = {
  none: undefined,
  red: '#ef4444',
  orange: '#F26A1F',
  yellow: '#F4A52A',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
};

function TurnTimer({
  style = 'ring', timeLeft = 0, timeoutSecs = 15,
  timeBankSecs = 30, timeBankActive = false, bankJustUsed = false, bankMax = TIME_BANK_MAX_SECONDS, size = 72,
  onUseTimebank, forceShowBankCta = false, showBankCta = true,
}: {
  style?: 'ring' | 'linear' | 'pips' | 'digit';
  timeLeft: number; timeoutSecs: number;
  timeBankSecs?: number; timeBankActive?: boolean; bankJustUsed?: boolean; bankMax?: number; size?: number;
  onUseTimebank?: () => void; forceShowBankCta?: boolean; showBankCta?: boolean;
}) {
  const pct = Math.max(0, Math.min(1, timeLeft / Math.max(1, timeoutSecs)));
  const secs = Math.max(0, Math.ceil(timeLeft));
  const crit = timeLeft <= 4;
  const tone = crit ? '#F26A1F' : timeLeft <= 8 ? '#FFC63A' : '#FFD96A';
  const bankSecs = Math.max(0, Math.ceil(timeBankSecs));
  const canUseTimebank = !timeBankActive && !bankJustUsed && bankSecs >= TIME_BANK_CHUNK_SECONDS && (timeLeft <= 6 || forceShowBankCta);

  if (style === 'ring') {
    const r = size * 0.42;
    const innerR = size * 0.32;
    const outerC = 2 * Math.PI * r;
    const innerC = 2 * Math.PI * innerR;
    const tbPct = Math.max(0, Math.min(1, bankSecs / bankMax));
    return (
      <div className="relative flex items-center justify-center select-none" style={{ width: size, height: size }}>
        <svg width={size} height={size} className={cn(crit && 'animate-pulse')}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(242,106,31,0.12)" strokeWidth={3} />
          <circle cx={size / 2} cy={size / 2} r={innerR} fill="none" stroke="rgba(255,198,58,0.1)" strokeWidth={2} strokeDasharray="2 3" />
          <circle
            cx={size / 2} cy={size / 2} r={innerR} fill="none"
            stroke={bankJustUsed || timeBankActive ? '#FFC63A' : '#FFC63A88'} strokeWidth={2}
            strokeDasharray={`${innerC * tbPct} ${innerC}`} strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            opacity={canUseTimebank || bankJustUsed || timeBankActive ? 1 : 0.55}
          />
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={tone} strokeWidth={3.5}
            strokeDasharray={`${outerC * pct} ${outerC}`} strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: 'stroke-dasharray 0.3s linear, stroke 0.2s' }}
            filter={crit ? 'drop-shadow(0 0 6px #F26A1F)' : 'drop-shadow(0 0 4px rgba(255,198,58,0.4))'}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display font-semibold tabular-nums leading-none" style={{ color: tone, fontSize: size * 0.35 }}>{secs}</span>
          {bankJustUsed ? (
            <span className="font-mono text-[8px] tracking-[0.2em] text-amber leading-none mt-0.5 animate-pulse">+15s</span>
          ) : timeBankActive ? (
            <span className="font-mono text-[8px] tracking-[0.2em] text-amber leading-none mt-0.5">BANK</span>
          ) : (
            <span className="font-mono text-[8px] tracking-[0.2em] text-boneDim/70 leading-none mt-0.5">SEC</span>
          )}
        </div>
        {showBankCta && canUseTimebank && onUseTimebank && (
          <button
            onClick={onUseTimebank}
            className="absolute -bottom-4 left-1/2 -translate-x-1/2 px-1.5 py-[1px] rounded-sm border border-amber/60 bg-amber/20 text-amber font-mono text-[8px] tracking-[0.22em] font-bold whitespace-nowrap animate-pulse"
          >
            +15s ({bankSecs}s bank)
          </button>
        )}
      </div>
    );
  }

  // Remaining variants are rendered the same way; fall through to a compact form.
  return (
    <div className="flex items-end gap-2">
      <span className="font-display font-semibold tabular-nums leading-none" style={{ color: tone, fontSize: 28 }}>{secs}</span>
      <span className="font-mono text-[10px] text-boneDim/70 leading-none mb-1">s</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  InlineCeremony (seat.jsx 1:1) — HeroCockpit overlay
// ═══════════════════════════════════════════════════════════════════════════

const CEREMONY_CONFIG: Record<CeremonyKind, { title: string; color: string; sub: string }> = {
  'hand-won':       { title: 'HAND WON',          color: '#FFC63A', sub: '' },
  'all-in-won':     { title: 'ALL-IN WON',        color: '#F26A1F', sub: '' },
  'bluff':          { title: 'BLUFF SUCCEEDED',   color: '#B990FF', sub: 'they folded' },
  'itm':            { title: 'IN THE MONEY',      color: '#FFD96A', sub: 'payout locked' },
  'heads-up':       { title: 'HEADS-UP',          color: '#FFC63A', sub: '1v1' },
  'bubble':         { title: 'BUBBLE',            color: '#F26A1F', sub: 'next cashes' },
  'stack-doubled':  { title: 'STACK DOUBLED',     color: '#FFD96A', sub: '2x' },
  'bad-beat':       { title: 'BAD BEAT',          color: '#6EE7F0', sub: 'strong hand cracked' },
  'first-hand':     { title: 'FIRST HAND',        color: '#F5F1E6', sub: 'welcome' },
  'level-up':       { title: 'LEVEL UP',          color: '#C8D9C6', sub: 'new tier' },
};

function InlineCeremony({ kind, amount, amountLabel, fmtVal }: CeremonyPayload & { fmtVal?: (v: number) => string }) {
  const base = CEREMONY_CONFIG[kind] || { title: String(kind).toUpperCase(), color: '#FFC63A', sub: '' };
  const sub = amountLabel
    ? `+${amountLabel.replace(/^\+/, '')}`
    : amount != null && amount > 0
      ? (kind === 'hand-won' || kind === 'all-in-won' || kind === 'bluff' ? `+${fmtVal ? fmtVal(amount) : amount.toLocaleString()}` : base.sub)
      : base.sub;
  const title = base.title;
  const color = base.color;
  return (
    <div className="absolute inset-0 flex items-center justify-end pr-4 pointer-events-none z-20 ceremony-pop">
      <div
        className="flex items-center gap-2.5 px-3.5 py-1.5 rounded-md"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${color}22 60%, ${color}44 100%)`,
          border: `1px solid ${color}66`,
          boxShadow: `0 0 30px ${color}55`,
        }}
      >
        <span className="font-display text-xl leading-none" style={{ color, textShadow: `0 0 10px ${color}99` }}>{title}</span>
        {sub && <span className="font-mono text-[10px] tracking-[0.2em] text-bone/80">/ {sub}</span>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Seat layouts — mirror mockup SEAT_POS
// ═══════════════════════════════════════════════════════════════════════════

type SeatPos = { top: string; left: string };
// Desktop seat coordinates anchor seats CLOSER to the felt edge than the
// previous layout. Wide screens have lots of horizontal room — push the
// side seats out so cards + bet chip + chip-stack each get their own
// real-estate slot instead of stacking on the felt.
const SEAT_LAYOUTS: Record<number, SeatPos[]> = {
  2: [
    { top: '92%', left: '50%' },
    { top: '8%',  left: '50%' },
  ],
  6: [
    { top: '92%', left: '50%' },
    { top: '80%', left: '10%' },
    { top: '20%', left: '10%' },
    { top: '6%',  left: '50%' },
    { top: '20%', left: '90%' },
    { top: '80%', left: '90%' },
  ],
  9: [
    { top: '93%', left: '50%' },
    { top: '85%', left: '19%' },
    // Side seats pulled in from 7%/9% (and 93%/91%): centered via translate(-50%),
    // they were spilling past the felt-wrap padding and getting clipped by the
    // page edge on 9-max. Kept symmetric.
    { top: '52%', left: '11%' },
    { top: '24%', left: '12%' },
    { top: '5%',  left: '31%' },
    { top: '5%',  left: '69%' },
    { top: '24%', left: '88%' },
    { top: '52%', left: '89%' },
    { top: '85%', left: '81%' },
  ],
};

const SEAT_LAYOUTS_MOBILE: Record<number, SeatPos[]> = {
  2: SEAT_LAYOUTS[2],
  6: [
    { top: '88%', left: '50%' },
    { top: '76%', left: '12%' },
    { top: '36%', left: '16%' },
    { top: '8%',  left: '50%' },
    { top: '36%', left: '84%' },
    { top: '76%', left: '88%' },
  ],
  9: [
    { top: '90%', left: '50%' },
    { top: '82%', left: '18%' },
    { top: '56%', left: '8%'  },
    { top: '36%', left: '14%' },
    { top: '8%',  left: '36%' },
    { top: '8%',  left: '64%' },
    { top: '36%', left: '86%' },
    { top: '56%', left: '92%' },
    { top: '82%', left: '82%' },
  ],
};

// Compact turn-timer ring for opponent + hero seat avatars.
// Sits *outside* the AvatarRing so the level frame stays visible.
//
// The avatar's visual outer is `size + tier_pad` (set inside AvatarRing), and
// that pad varies by tier — bronze=9, silver=10, gold=12, platinum=14,
// diamond=16, obsidian=17, none=8. Pinning to a fixed pixel size made the ring
// drift off-center on high-tier avatars. Anchoring with negative `inset` ties
// the ring to the parent wrapper's actual size, which already tracks the tier.
// Turn timer rendered as a DEPLETING BORDER hugging the nameplate (not a ring on
// the avatar). A conic-gradient is masked down to just a thin ring that follows
// the nameplate's exact rounded rectangle — so it sits ON the border with the
// same corner radius (no SVG aspect-stretch distortion). The colored arc sweeps
// from the top and shrinks as time runs out; --fp-timer-angle is a registered
// <angle> (see globals.css) so the sweep transitions smoothly between ticks.
// roundedClass MUST mirror the nameplate's own border-radius classes.
function TurnTimerBorder({ timeLeft, timeoutSecs, roundedClass = 'rounded-md' }: {
  timeLeft: number; timeoutSecs: number; roundedClass?: string;
}) {
  const pct = Math.max(0, Math.min(1, timeLeft / Math.max(1, timeoutSecs)));
  const secs = Math.max(0, Math.ceil(timeLeft));
  const crit = timeLeft <= 4;
  const tone = crit ? '#ef4444' : timeLeft <= 8 ? '#FFC63A' : '#F26A1F';
  return (
    <div
      className={cn('absolute inset-0 pointer-events-none', roundedClass)}
      aria-label={`${secs}s to act`}
      style={{
        padding: '1.5px', // ring thickness
        ['--fp-timer-angle' as string]: `${pct * 360}deg`,
        background: `conic-gradient(from -90deg, ${tone} var(--fp-timer-angle), rgba(255,255,255,0.08) var(--fp-timer-angle))`,
        WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
        WebkitMaskComposite: 'xor',
        maskComposite: 'exclude',
        transition: '--fp-timer-angle 0.5s linear, background 0.2s',
        filter: crit ? 'drop-shadow(0 0 4px rgba(239,68,68,0.55))' : 'drop-shadow(0 0 3px rgba(242,106,31,0.4))',
      }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  PlayerSeat — seat.jsx 1:1 (AvatarRing + glass-sub info box + seat-peek)
// ═══════════════════════════════════════════════════════════════════════════

function PlayerSeat({
  player, pos, isCurrent, seatIndex, isHero, isDealer, isSB, isBB, isCashGame,
  cardsDealt, isShowdown, handName, isWinner, showdownStage,
  timeLeft, timeoutSecs, lastAction, showdownPot, fmtVal, onSeatClick,
  pendingJoinSeat, reservedJoinSeat, selectedJoinSeat, reservedJoinSeats = [], joiningSeat, clearingSeats,
  profileAvatarImage, profileAvatarEmoji, profileName,
  amountThisStreet = 0, totalBet = 0, bigBlind = 40, uncalledReturn = 0,
  frame = 'default',
  heroCardsOnFelt = false,
  heroCards,
  timeBankActive = false,
  cardsPreRevealed = false,
  isRunout = false,
  noteColor = 'none',
  onOpenNotes,
  voluntaryShow = false,
  peekSuppressed = false,
  latchedFolded = false,
  linked = false,
  koCount = 0,
  bankedFp = 0,
  bankedSol = 0,
  duelSeat = false,
  duelReveal = false,
  duelLiveOnFelt = false,
  shieldMode = false,
}: {
  player: Player | null;
  pos: SeatPos;
  isCurrent: boolean;
  seatIndex: number;
  isHero: boolean;
  isDealer: boolean;
  isSB: boolean;
  isBB: boolean;
  cardsDealt: boolean;
  isShowdown: boolean;
  /** True during an all-in run-out (Flop/Turn/RiverRevealPending). The contract
   *  resets seats_folded mid-run-out, so a folded seat transiently reads
   *  !folded — treat the run-out like showdown for the card layer so a folded
   *  seat never renders phantom card backs. */
  isRunout?: boolean;
  handName?: string;
  isWinner?: boolean;
  showdownStage?: number;
  timeLeft?: number;
  timeoutSecs?: number;
  timeBankActive?: boolean;
  lastAction?: { action: string; timestamp: number } | null;
  showdownPot?: number;
  fmtVal: (v: number) => string;
  onSeatClick?: (seatIndex: number) => void;
  pendingJoinSeat?: number | null;
  reservedJoinSeat?: number | null;
  selectedJoinSeat?: number | null;
  reservedJoinSeats?: number[];
  joiningSeat?: number | null;
  isCashGame?: boolean;
  // Map of seatIndex -> timestamp when seat went Leaving->Empty. Seats in this
  // map render as CLEARING for ~4s so users don't race contract cleanup.
  clearingSeats?: Map<number, number>;
  profileAvatarImage?: string | null;
  profileAvatarEmoji?: string | null;
  profileName?: string;
  koCount?: number;
  bankedFp?: number;
  bankedSol?: number;
  /** SnG Duels: seat is an active-duel participant. Forces the card layer during the Waiting-phase
   *  duel (cardsDealt is false there) so duelists show backs while choosing, face-up on reveal. */
  duelSeat?: boolean;
  /** SnG Duels: the current duel round is resolved (both choices in) - only then may duelist cards
   *  flip face-up. Blocks STALE previous-hand revealed holeCards from leaking mid-duel. */
  duelReveal?: boolean;
  /** SnG Duels: ANY duel is live on the felt. Non-duel seats must never show face-up
   *  cards during the duel beat - holeCards can still hold the previous hand's showdown
   *  reveal until the next deal (live find 2026-07-04: a duel right after a showdown
   *  rendered THREE face-up hands - both stale showdown hands plus the duelists'). */
  duelLiveOnFelt?: boolean;
  /** Bounty Shield (ruleset 1): koCount is HELD POINTS - same ring dots, point nouns,
   *  and the pip count may DECREASE when a point is stolen or handed over. */
  shieldMode?: boolean;
  amountThisStreet?: number;
  totalBet?: number;
  bigBlind?: number;
  uncalledReturn?: number;
  frame?: SeatFrameId;
  /** Hero rendering cards on the felt (heroPosition='table' active).
   *  When true on the hero seat, the bet placement shifts to the right
   *  side of the avatar so chips don't collide with the floating cards. */
  heroCardsOnFelt?: boolean;
  /** Hero's hole cards, passed only to the hero seat. Powers the folded
   *  hover-peek: glimpse your own mucked cards, dimmed, by hovering your seat. */
  heroCards?: [number, number];
  /** This seat's hole cards were already revealed BEFORE showdown (all-in
   *  runout). Skips the showdown stage-gate so the already-up cards don't
   *  flip face-down for ~800ms at the Showdown edge. */
  cardsPreRevealed?: boolean;
  /** This player's private note color tag ('none' = no tag). Author-only. */
  noteColor?: string;
  /** Open the private-note editor for this (opponent) player. Omitted for the
   *  hero seat and empty seats. */
  onOpenNotes?: () => void;
  /** This seat's cards are a VOLUNTARY post-hand show (off-chain relay), not an
   *  on-chain showdown reveal — render a small "SHOWN" tag to distinguish. */
  voluntaryShow?: boolean;
  /** Suppress the stack/in-pot/wallet hover-peek (e.g. while a modal is open,
   *  where a sticky mobile-tap hover would otherwise overlap it). */
  peekSuppressed?: boolean;
  /** This seat folded during live betting this hand (latched). Used to keep the
   *  runout phantom-back guard targeted so contesting backs don't flicker. */
  latchedFolded?: boolean;
  /** This seat shares a device with another seat at the table (anti-collusion).
   *  Renders a visible "LINKED" badge so everyone can see they're co-located. */
  linked?: boolean;
}) {
  const [showAction, setShowAction] = useState<string | null>(null);
  // Hover-peek of the hero's own mucked cards after folding (desktop hover).
  const [peekMuck, setPeekMuck] = useState(false);
  useEffect(() => {
    // Label lifetime is PARENT-DRIVEN: the action stays visible for the whole
    // street it happened on, and the page clears playerActions the moment the
    // street's betting ends (phase change) or the hand ends. No local timeout:
    // a fixed 2s hide made the felt amnesiac mid-street, while letting labels
    // outlive their street made a flop CHECK read as a turn action.
    if (!lastAction) { setShowAction(null); return; }
    // Friendly labels — never show a raw enum like "USE_TIME_BANK". Map the
    // time-bank action to "+15s"; de-underscore anything else defensively.
    const raw = lastAction.action || '';
    const label = /time.?bank/i.test(raw) ? '+15s' : raw.replace(/_/g, ' ');
    setShowAction(label);
  }, [lastAction?.timestamp, lastAction]);
  // Mobile: 9-max edge seats clip because the seat is a 42px avatar + a 112px
  // plate side-by-side (~148px). Compact it on phones — smaller avatar tucked
  // deeper into a narrower plate (a sliver) so the whole seat fits on-screen.
  const seatIsMobile = useIsMobile();

  // [FP-EVT] KO pip timing: emit when this seat's knockout count changes so the
  // timeline can assert bust -> pip latency (bounded by the bounty poll cadence).
  // KO reward burst (user request 2026-07-04): the knockout beat must SAY what it
  // paid - float the banked delta (+$FP/+SOL) above the hunter's seat for a moment.
  // Bounty Shield: the SAME dots now track held points, which also DECREASE when a
  // point is stolen/handed over - emit the pip event with the delta both ways (the
  // ruleset-1 asserter branch keys on this), burst "POINT" framing on gains, and a
  // brief "-1 POINT" cue on losses.
  const prevKoRef = useRef(koCount);
  const prevBankRef = useRef({ fp: bankedFp, sol: bankedSol });
  const [koBurst, setKoBurst] = useState<{ fp: number; sol: number; delta: number } | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const delta = koCount - prevKoRef.current;
    if (delta !== 0) {
      fpEvent('seat.ko_pip', { seat: seatIndex, koCount, delta });
      const dFp = bankedFp - prevBankRef.current.fp;
      const dSol = bankedSol - prevBankRef.current.sol;
      if (delta > 0 ? (dFp > 0 || dSol > 0) : shieldMode) {
        setKoBurst({ fp: Math.max(0, dFp), sol: Math.max(0, dSol), delta });
        t = setTimeout(() => setKoBurst(null), 3600);
      }
    }
    prevKoRef.current = koCount;
    prevBankRef.current = { fp: bankedFp, sol: bankedSol };
    return () => { if (t) clearTimeout(t); };
  }, [koCount, seatIndex, bankedFp, bankedSol, shieldMode]);

  if (!player) {
    const isPendingSeat = pendingJoinSeat === seatIndex;
    const isReservedSeat = reservedJoinSeat === seatIndex;
    const isSelectedSeat = selectedJoinSeat === seatIndex;
    const isClearingSeat = !!clearingSeats && clearingSeats.has(seatIndex);
    // A seat that just went Leaving→Empty is being cleaned up, not joined. The
    // departing player's lingering DepositProof must not relabel it "JOINING",
    // so CLEARING takes precedence over a remote reservation on this seat.
    const isRemoteReservedSeat = reservedJoinSeats.includes(seatIndex) && !isPendingSeat && !isReservedSeat && !isSelectedSeat && !isClearingSeat;
    const isJoiningSeat = joiningSeat === seatIndex;
    const activeJoinSeat = pendingJoinSeat ?? reservedJoinSeat ?? selectedJoinSeat;
    const isBlockedByPendingJoin = activeJoinSeat != null && activeJoinSeat !== seatIndex;
    const label = isJoiningSeat
      ? 'SEATING'
      : isPendingSeat
        ? 'TAKE SEAT'
        : isSelectedSeat
          ? 'SELECTED'
          : isRemoteReservedSeat
            ? 'JOINING'
            : isClearingSeat
              ? 'CLEARING'
              : (isReservedSeat || isBlockedByPendingJoin)
                ? 'RESERVED'
                : (isCashGame === false ? 'BUSTED' : 'OPEN');
    // CLEARING seats: brief 4s lock after a Leaving→Empty transition so a new
    // joiner doesn't race the contract cleanup and eat a seat_player error.
    const canClick = !!onSeatClick && isCashGame !== false && !isJoiningSeat && !isBlockedByPendingJoin && !isRemoteReservedSeat && !isClearingSeat;
    return (
      <div className="absolute -translate-x-1/2 -translate-y-1/2 origin-center lg:scale-150" style={{ top: pos.top, left: pos.left }}>
        {canClick ? (
          <button
            onClick={() => { SFX.play('ui-tap'); onSeatClick(seatIndex); }}
            className={cn(
              'w-[74px] h-[44px] rounded-lg border border-dashed flex items-center justify-center transition-all group',
              isPendingSeat || isSelectedSeat
                ? 'border-orange/60 bg-orange/[0.12] hover:bg-orange/[0.2] hover:border-orange text-orange shadow-[0_0_18px_rgba(255,109,31,0.18)]'
                : 'border-gold/25 bg-gold/[0.02] hover:bg-gold/[0.08] hover:border-gold/50 seat-empty-pulse'
            )}
          >
            <span className={cn(
              'font-mono text-[9px] tracking-[0.14em] group-hover:text-gold',
              isPendingSeat || isSelectedSeat ? 'text-orange' : 'text-gold/60'
            )}>{label}</span>
          </button>
        ) : (
          <div className={cn(
            'w-[74px] h-[44px] rounded-lg border border-dashed flex items-center justify-center',
            isClearingSeat
              ? 'border-amber/50 bg-amber/[0.08] animate-pulse'
              : isJoiningSeat || isRemoteReservedSeat
                ? 'border-orange/40 bg-orange/[0.08]'
                : isBlockedByPendingJoin
                  ? 'border-bone/15 bg-bone/[0.03]'
                  : 'border-bone/10'
          )}
          title={isClearingSeat ? 'A player just left this seat — waiting for contract cleanup' : undefined}>
            <span className={cn(
              'font-mono text-[9px] tracking-[0.14em]',
              isClearingSeat ? 'text-amber/90' : isJoiningSeat || isRemoteReservedSeat ? 'text-orange/80' : isBlockedByPendingJoin ? 'text-bone/35' : 'text-bone/20'
            )}>{label}</span>
          </div>
        )}
      </div>
    );
  }

  const folded = player.folded;
  // Display name + auto-shrink for long handles so the plate doesn't truncate
  // common names. The plate width is fixed (mobile 9-max edge-clip constraint),
  // so we shrink the font instead of widening.
  const seatName = isHero ? 'YOU' : (profileName || shortWallet(player.pubkey));
  const nameSizeClass = seatName.length > 11 ? 'text-[8px]' : seatName.length > 8 ? 'text-[9px]' : 'text-[10px]';
  const allIn = isAllInPlayer(player);
  const sittingOut = player.isSittingOut;
  // A sitting-out player can still be the on-chain "current player" in an SNG
  // (the crank gives them a short sit-out window before auto-folding), but they
  // have NO decision to make — they will be folded regardless. Showing the
  // active-turn cues (breathing avatar, gold ring, depleting timer border) makes
  // it look like they're live and might time out. Gate every "it's your turn"
  // cue on this so a sit-out seat shows only its SIT OUT tag, never a live timer.
  const isActingTurn = isCurrent && !sittingOut && !isShowdown && !folded;
  const actionText = showAction;
  const level = player.level ?? 0;
  // Deterministic XP fill per wallet so avatars look lived-in
  const xpSeed = ((player.pubkey.charCodeAt(0) || 0) * 13) % 70;
  const xp = Math.floor(LEVEL_XP(level) * (0.15 + xpSeed / 100));
  const bbCount = bigBlind > 0 ? (player.chips / bigBlind).toFixed(0) : '0';
  const topPct = Number.parseFloat(String(pos.top));
  const leftPct = Number.parseFloat(String(pos.left));
  const toCenterX = 50 - (Number.isFinite(leftPct) ? leftPct : 50);
  const toCenterY = 50 - (Number.isFinite(topPct) ? topPct : 50);
  // ── Badge anchoring (mobile GG nameplate) ──────────────────────────────────
  // Indicator badges (SB/BB + dealer button) hug the nameplate corner that faces
  // the table CENTER; the level badge hugs the OUTWARD corner. The facing corner
  // is derived from BOTH axes so a badge always points inward regardless of where
  // the seat sits:
  //   vertical  — top-half seats (center is below) → bottom edge; bottom-half → top
  //   horizontal— right-side seats → left corner;  left-side seats → right corner
  // So: hero (bottom-center) → top-right, top-left seat → bottom-right, top-right
  // seat → bottom-left. Anchored right on the corner (negative inset) per design.
  // Full literal class strings so Tailwind's JIT scanner picks them up.
  const badgeInY = toCenterY > 0 ? '-bottom-1.5' : '-top-1.5'; // inward vertical edge
  const badgeInX = toCenterX < 0 ? '-left-1' : '-right-1'; // inward horizontal corner
  const badgeOutX = toCenterX < 0 ? '-right-1' : '-left-1'; // outward horizontal corner (level rides the top edge)
  // Blind badge (SB/BB) sits JUST ABOVE the plate's inward horizontal edge
  // (hero/bottom seats → above; top-row seats → mirrored below), pulled to the
  // inward corner. Lifting it clear of the plate (vs. the old corner overlap)
  // keeps it off the dealer button (inward bottom) and reads as "above, right".
  const blindBadgePos = toCenterY > 0
    ? cn('top-full mt-1', badgeInX)
    : cn('bottom-full mb-1', badgeInX);
  // WINS shows inside the nameplate during the showdown payout beat.
  const isWinnerDisplay = !!isWinner && (showdownStage ?? 0) >= 5 && showdownPot != null && showdownPot > 0;
  // Dealer-button placement. Alone → the inward corner. When this seat is ALSO
  // SB/BB it must not stack on that badge: for bottom-half seats the inward edge
  // is the TOP and the avatar sits right above it, so sliding the button along
  // the edge runs it under the avatar — drop it just BELOW the SB/BB badge at the
  // same corner instead. Top/side seats have clear room to sit beside the badge.
  const dealerSharesBadge = isSB || isBB;
  const dealerPosClass = dealerSharesBadge
    ? (toCenterY < 0
        ? cn('top-2.5', badgeInX)
        : cn(badgeInY, toCenterX < 0 ? 'left-5' : 'right-5'))
    : cn(badgeInY, badgeInX);
  // Bet-chip placement.
  //   - Hero with felt-cards: push right of the avatar so it doesn't collide
  //     with the floating felt cards.
  //   - Opponent with dealt cards (cards render ABOVE the avatar): never
  //     place the bet above — it would overlap the cards. Force sideways
  //     toward the center of the table.
  //   - Otherwise: vertical placement preferred, fallback to horizontal.
  const opponentCardsAbove =
    !isHero && cardsDealt && !folded && !player.waitingForBb && !((sittingOut || player.isLeaving) && player.bet === 0);
  // Side-seat bets anchor to the NAMEPLATE's vertical middle, not the whole
  // avatar+nameplate stack's middle. The GG stack (now on every viewport) puts
  // the avatar on top and the nameplate below, so the stack centre (50%) floats
  // the chip up by the avatar; drop it to ~the nameplate row so the wager reads
  // off the plate's inward edge.
  const sideBetTop = '72%';
  const betPlacement = isHero && heroCardsOnFelt
    ? { left: '100%', top: '50%', transform: 'translate(12px, -50%)' }
    : opponentCardsAbove
      // Cards sit ABOVE an opponent's avatar, so the bet can never go up. Send it
      // toward the pot instead of always sideways: a top-row seat (pot is below
      // it) drops the chip straight DOWN toward the pot; side/bottom seats push
      // sideways toward center. Keeps every wager pointing at the pot rather than
      // floating off to a random side — the scattered-chip confusion.
      ? (Math.abs(toCenterY) >= Math.abs(toCenterX) && toCenterY >= 0
          ? { top: '100%', left: '50%', transform: 'translate(-50%, 4px)' }
          : (toCenterX >= 0
              ? { left: '100%', top: sideBetTop, transform: 'translate(4px, -50%)' }
              : { right: '100%', top: sideBetTop, transform: 'translate(-4px, -50%)' }))
      : Math.abs(toCenterY) >= Math.abs(toCenterX)
        ? (toCenterY >= 0
            ? { top: '100%', left: '50%', transform: 'translate(-50%, 10px)' }
            : { bottom: '100%', left: '50%', transform: 'translate(-50%, -10px)' })
        : (toCenterX >= 0
            ? { left: '100%', top: sideBetTop, transform: 'translate(12px, -50%)' }
            : { right: '100%', top: sideBetTop, transform: 'translate(-12px, -50%)' });

  // When THIS opponent's cards are face-up (showdown reveal), lift the whole
  // seat above neighbouring seats so the revealed cards render ABOVE other
  // players' avatars/chips instead of tucking under them. Sibling seats all sit
  // at z-10 (each its own stacking context), so a per-card z-index can't cross
  // seat boundaries — the seat wrapper itself has to win.
  const seatCardsFaceUp = !isHero && cardsDealt && !folded && !player.waitingForBb && !(player.isLeaving && player.bet === 0)
    && !!(player.holeCards && player.holeCards[0] !== 255
          && (isShowdown ? ((showdownStage ?? 0) >= 1 || cardsPreRevealed) : true));

  return (
    <div
      tabIndex={0}
      onMouseEnter={isHero && folded ? () => setPeekMuck(true) : undefined}
      onMouseLeave={isHero && folded ? () => setPeekMuck(false) : undefined}
      className={cn('absolute -translate-x-1/2 -translate-y-1/2 seat-wrap focus:outline-none', seatCardsFaceUp ? 'z-30' : 'z-10')}
      style={{ top: pos.top, left: pos.left }}
    >
      {/* Desktop: scale the whole seat 1.5x — mobile keeps 1x. */}
      <div className="relative flex flex-col items-center origin-center lg:scale-150">
        {/* Hero folded-card peek: hover your own seat to glimpse your mucked
            cards, dimmed (grayscale + darkened). Only while folded with real
            cards — no live decision then, so revealing your own dead hand is safe. */}
        {isHero && folded && heroCards && heroCards[0] !== 255 && heroCards[0] <= 51 && heroCards[1] <= 51 && (
          <div
            className={cn(
              'absolute left-1/2 -translate-x-1/2 bottom-full pb-1 z-20 pointer-events-none transition-opacity duration-200',
              peekMuck ? 'opacity-100' : 'opacity-0',
            )}
            style={{ filter: 'grayscale(0.85) brightness(0.5)' }}
          >
            <HoleCards cards={heroCards} size="sm" revealed animate={false} />
          </div>
        )}
        {/* Opponent cards (above seat, not for hero — hero's cards float over
            cockpit / felt). ABSOLUTELY positioned so the avatar stays anchored
            at the same spot whether cards are dealt or not — cards overlay
            from above without shifting the seat layout. Removes the previous
            inline h-[62px] reserved row which pushed the avatar down only
            when cards were present. */}
        {/* A leaving player isn't dealt into the current hand (cardsDealt is a
            global phase flag, not per-seat), so don't render card backs for them. */}
        {(() => {
          const hasRevealedHole = !!(player.holeCards && player.holeCards[0] !== 255 && player.holeCards[0] <= 51 && player.holeCards[1] <= 51);
          // HERO with table-view ('table' card position): render own cards face-up
          // at the seat, IN FRONT of the avatar (z-20) but UNDER the nameplate
          // (z-30) — the same GG layering as opponents. Replaces the old
          // felt-center render that sat behind the whole seat (z-[5]).
          if (isHero) {
            if (!(heroCardsOnFelt && (cardsDealt || duelSeat) && !folded && heroCards && heroCards[0] !== 255 && heroCards[0] <= 51 && heroCards[1] <= 51)) return null;
            return (
              <div className={cn(
                'absolute left-1/2 -translate-x-1/2 pointer-events-none z-20 bottom-full',
                // Lifted a touch above the avatar; fanned for the tilted look.
                seatIsMobile ? 'translate-y-[48px]' : 'translate-y-[60px]',
              )}>
                <HoleCards cards={heroCards} size="sm" revealed fan animate={false} />
              </div>
            );
          }
          // Render the card layer for a normal in-hand seat, OR for ANY seat that
          // REVEALED hole cards at showdown — even if it is now folded / leaving /
          // sitting-out. Without the showdown clause, a player who reached showdown
          // and then started cashing out had folded=true (leaving maps to folded),
          // so their revealed hand never rendered — the "no cards show who had
          // cards" report on a stalled/leaving showdown.
          const showCardLayer = !isHero && !player.waitingForBb && (
            // Duelists keep their cards ON THE TABLE through the Waiting-phase duel.
            duelSeat
            || (cardsDealt && (
            ((isShowdown || isRunout) && hasRevealedHole)
            // Face-down backs during live betting AND the between-street
            // *RevealPending commit (isRunout) — so a contesting seat's backs do
            // NOT blink off every street transition (the "backs disappear then
            // reappear" flicker). The phantom-back case (a FOLDED seat reads
            // !folded while seats_folded is reset during showdown/runout, with
            // holeCards still 255) is excluded via `latchedFolded` — the seat's
            // folded state captured from live betting — so we no longer need to
            // blanket-hide every seat's backs during the runout. `!isShowdown`
            // still keeps the true-showdown layer on the face-up clause above.
            || (!isShowdown && !folded && !latchedFolded && !((sittingOut || player.isLeaving) && player.bet === 0))
            ))
          );
          if (!showCardLayer) return null;
          // A revealed leaver/folder isn't part of the staged flip, so show their
          // hand face-up immediately instead of gating on showdownStage (which can
          // be stuck in a stalled showdown). Normal contesting seats still flip via
          // showdownStage.
          const revealedLeaver = isShowdown && hasRevealedHole && (folded || player.isLeaving || sittingOut);
          const cardsFaceUp = duelSeat && !cardsDealt
            // Mid-duel: BACKS until this round resolves. holeCards can still hold the PREVIOUS
            // hand's showdown reveal, which must not leak while the duelist is deciding.
            ? (duelReveal && hasRevealedHole)
            : duelLiveOnFelt && !cardsDealt
              // Non-duelists during the duel beat: the previous hand is over; stale showdown
              // reveals must not sit face-up next to the duel (3-hands-on-felt live find).
              ? false
              : !!(player.holeCards && player.holeCards[0] !== 255 && (isShowdown ? ((showdownStage ?? 0) >= 1 || cardsPreRevealed || revealedLeaver) : true));
          return (
          <div className={cn(
            'absolute left-1/2 -translate-x-1/2 pointer-events-none',
            // Face-down backs tuck behind the plate (z-0); revealed cards lift
            // above it (z-20) so the showdown hands read clearly.
            // Mobile GG stack: backs sit IN FRONT of the avatar (z-20, avatar is z-10)
            // but UNDER the nameplate (z-30); revealed showdown cards lift to z-40.
            cardsFaceUp
              ? (seatIsMobile ? 'z-40 bottom-full translate-y-[58px] pb-1' : 'z-40 bottom-full translate-y-[70px] pb-1')
              : (seatIsMobile ? 'z-20 bottom-full translate-y-[58px]' : 'z-20 bottom-full translate-y-[70px]')
          )}>
            {cardsFaceUp ? (
              <HoleCards cards={player.holeCards} size="sm" revealed stagger={seatIndex * 180} animate={false} />
            ) : (
              <HoleCards size="sm" revealed={false} animate={false} overlap />
            )}
          </div>
          );
        })()}

        {/* No floating hand-name badge: the showdown result (WINS + amount +
            hand name) renders exclusively INSIDE the nameplate. The old badge
            duplicated the same text above every seat's cards. */}

        {/* Avatar + info box — GG-style vertical stack on EVERY viewport: round
            avatar ON TOP, nameplate pill below. Desktop just renders it larger
            (and the whole seat scales 150% via lg:scale-150 on the wrapper). The
            avatar sits BEHIND the nameplate + cards (z-10 < cards z-20 <
            nameplate z-30) so card backs read in front of the avatar but tuck
            under the nameplate pill. */}
        <div className={cn('relative flex flex-col items-center', folded && 'opacity-35')}>
          <div className="relative z-10">
            <div className={cn(
              'relative',
              isActingTurn && 'active-breath',
              isWinner && (showdownStage ?? 0) >= 5 && 'winner-pulse',
            )} style={{ borderRadius: '50%' }}>
              <AvatarRing
                size={seatIsMobile ? 34 : 42} level={level} xp={xp} seed={player.pubkey}
                frameAnim="subtle"
                avatarImage={profileAvatarImage}
                avatarEmoji={profileAvatarEmoji}
                frame={frame}
                showLevelBadge={false}
              />
              {/* SnG Duels: kill-marker pips over the target ring - one per held bounty point,
                  5+ collapses to pip + xN. koCount is only populated on duel-format tables
                  (seatKoBySeat), so this renders nothing everywhere else. Design pick 2026-07-02:
                  ring pips. Flat bounty (2026-07-14): points move only on knockouts and tied
                  winners split fractionally, so koCount can be FRACTIONAL (0.5, 1.33) - whole
                  points render as full dots, a fractional remainder as one dimmed dot. */}
              {koCount > 0 && (
                <div
                  className="pointer-events-none absolute -top-[7px] left-1/2 z-20 flex -translate-x-1/2 items-center gap-[3px]"
                  data-format="bounty"
                  title={shieldMode
                    ? `${formatPoints(koCount)} bounty point${koCount === 1 ? '' : 's'} held`
                    : `${koCount} knockout${koCount === 1 ? '' : 's'} (bounties collected)`}
                >
                  {koCount <= 4 ? (
                    <>
                      {Array.from({ length: Math.floor(koCount) }).map((_, i) => (
                        <span key={i} className="h-[5px] w-[5px] rounded-full bg-amber shadow-[0_0_4px_rgba(255,198,58,0.85)]" />
                      ))}
                      {koCount % 1 > 0 && (
                        <span className="h-[5px] w-[5px] rounded-full bg-amber/40 shadow-[0_0_3px_rgba(255,198,58,0.4)]" />
                      )}
                    </>
                  ) : (
                    <>
                      <span className="h-[5px] w-[5px] rounded-full bg-amber shadow-[0_0_4px_rgba(255,198,58,0.85)]" />
                      <span className="font-display text-[9px] leading-none text-amber drop-shadow-[0_0_3px_rgba(255,198,58,0.6)]">&times;{formatPoints(koCount)}</span>
                    </>
                  )}
                </div>
              )}
            </div>

          </div>

          <div className={cn(
            // Fixed width so the card does not grow/shrink with inner text
            // (action labels, ALL-IN, uncalled return). Only the viewport
            // size (via lg:scale-150) changes the rendered size. Inner text
            // truncates per-line; card itself does NOT clip so the SB/BB
            // badge at -top-1.5 and the dealer chip stay visible.
            // Vertical pill below the avatar on every viewport (overlap its bottom
            // so the plate tucks under it), symmetric padding, centered. Desktop
            // just renders a touch wider / taller for the larger 42px avatar.
            seatIsMobile
              ? 'relative z-30 mt-[-9px] px-2.5 py-1 w-[104px] rounded-md'
              : 'relative z-30 mt-[-11px] px-3 py-1.5 w-[116px] rounded-md',
            frame !== 'matte-black' && 'glass-sub hairline',
            frame !== 'matte-black' && isActingTurn && 'ring-gold',
          )}
          style={frame === 'matte-black' ? {
            // BLACK TIER seat-card treatment — opaque matte black + premium sheen.
            background:
              'linear-gradient(180deg, #050505 0%, #000000 100%), ' +
              'radial-gradient(ellipse 80% 60% at 0% 0%, rgba(255,255,255,0.10) 0%, transparent 60%)',
            backgroundBlendMode: 'screen, normal',
            border: '1px solid rgba(255,255,255,0.18)',
            boxShadow: isActingTurn
              ? 'inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(255,255,255,0.06), 0 0 18px rgba(255,255,255,0.28), 0 10px 24px rgba(0,0,0,0.95), 0 2px 6px rgba(0,0,0,0.9)'
              : 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(255,255,255,0.05), 0 10px 24px rgba(0,0,0,0.95), 0 2px 6px rgba(0,0,0,0.9)',
          } : undefined}>
            {/* Turn timer — depleting border around the nameplate (replaces the
                old ring on the avatar). roundedClass mirrors this plate's radius. */}
            {isActingTurn && timeLeft != null && timeoutSecs ? (
              <TurnTimerBorder timeLeft={timeLeft} timeoutSecs={timeoutSecs} roundedClass="rounded-md" />
            ) : null}
            {frame === 'matte-black' && (
              <>
                {/* Top sheen line — luxury polish */}
                <span
                  className="absolute top-0 left-2 right-2 h-px pointer-events-none"
                  style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)' }}
                />
                {/* Premium diamond glyph — power sign */}
                <span
                  className="absolute top-1 left-1.5 text-[7px] leading-none pointer-events-none"
                  style={{ color: '#F5F1E6', textShadow: '0 0 4px rgba(255,255,255,0.45)' }}
                >
                  ◆
                </span>
              </>
            )}
            {(isSB || isBB) && (
              <div className={cn(
                // Inward corner of the nameplate, facing the table center.
                // Color-coded for instant ID: SB = cool blue, BB = warm amber
                // (the dealer button is the separate white 'D' chip). A subtle
                // tinted fill + ring makes each blind its own glanceable token.
                'absolute z-30 px-1.5 py-[2px] rounded-sm font-mono text-[9px] font-extrabold tracking-wider leading-none border',
                blindBadgePos,
                isSB
                  ? 'bg-ink border-sky-400/60 text-sky-300 shadow-[0_0_8px_rgba(56,189,248,0.30)]'
                  : 'bg-ink border-amber/65 text-amber shadow-[0_0_8px_rgba(255,198,58,0.30)]',
              )}>
                {isSB ? 'SB' : 'BB'}
              </div>
            )}
            {/* Level # on the nameplate's OUTWARD side (away from the table
                center), top edge — right-side seats → right edge, left-side →
                left edge. The on-avatar badge is suppressed everywhere now
                (showLevelBadge={false}). */}
            {level > 0 && (
              <div className={cn(
                // Level always rides the TOP edge; outward horizontal side.
                'absolute -top-1.5 z-30 px-1 py-[1px] rounded-sm font-mono text-[8px] font-bold tabular-nums leading-none border bg-ink',
                badgeOutX,
                frame === 'matte-black' ? 'border-bone/30 text-bone' : 'border-gold/30 text-gold',
              )}>
                {level}
              </div>
            )}
            {/* Dealer button — inward bottom corner of the nameplate, same row as
                SB/BB. When this seat is ALSO SB/BB (e.g. heads-up), offset it inward
                so the two chips sit side by side instead of overlapping. */}
            {isDealer && (
              <div
                className={cn(
                  'absolute z-40 w-[18px] h-[18px] rounded-full flex items-center justify-center',
                  dealerPosClass,
                )}
                style={{
                  background: 'radial-gradient(circle at 35% 30%, #FFFFFF 0%, #F5F1E6 45%, #D6CFBC 100%)',
                  border: '1.5px solid #0A0D10',
                  boxShadow: '0 0 0 1px #FFD96A, 0 2px 4px rgba(0,0,0,0.8), inset 0 -1px 0 rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.6)',
                }}
              >
                <span className="font-display text-[10px] font-extrabold text-[#0A0D10] leading-none" style={{ textShadow: '0 1px 0 rgba(255,255,255,0.4)' }}>D</span>
              </div>
            )}
            {timeBankActive && !folded && (
              <div
                className="absolute -top-1.5 left-2 z-30 px-1.5 py-[1px] rounded-sm font-mono text-[8px] font-bold tracking-wider leading-none border bg-ink border-amber/50 text-amber animate-pulse"
                title="Time bank active (+15s)"
              >
                +15s
              </div>
            )}
            {voluntaryShow && !isHero && (
              <div
                className="absolute -top-1.5 left-1/2 -translate-x-1/2 z-30 px-1.5 py-[1px] rounded-sm font-mono text-[8px] font-bold tracking-wider leading-none border bg-ink border-sky-400/50 text-sky-300"
                title="This player chose to show these cards"
              >
                SHOWN
              </div>
            )}
            {linked && (
              <div
                className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 z-40 px-1.5 py-[1px] rounded-sm font-mono text-[8px] font-bold tracking-wider leading-none border bg-ink border-red-500/60 text-red-400 flex items-center gap-0.5"
                title="Shares a device with another player at this table"
              >
                <Link2 size={8} /> LINKED
              </div>
            )}

            <div className="text-center">
              <div className={cn(
                'font-mono tracking-wide leading-none mb-1.5 flex items-center justify-center gap-0.5 max-w-full',
                frame === 'matte-black' ? 'text-gold' : 'text-boneDim/80',
              )}>
                <span className={cn('truncate min-w-0', nameSizeClass)}>{seatName}</span>
                {!isHero && onOpenNotes && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); SFX.play('ui-tap'); onOpenNotes(); }}
                    className={cn(
                      'shrink-0 p-0.5 -my-1 -mr-0.5 leading-none transition-colors',
                      !NOTE_DOT[noteColor] && 'text-boneDim/40 hover:text-gold',
                    )}
                    style={NOTE_DOT[noteColor] ? { color: NOTE_DOT[noteColor] } : undefined}
                    title="Add a private note on this player"
                    aria-label="Add a private note"
                  >
                    <StickyNote size={10} />
                  </button>
                )}
              </div>
              {/* WINS renders IN the nameplate (animated), not as a floating
                  pill below it — the win amount + hand name take over the stack
                  line for the showdown beat. Like ALL-IN it's a one-shot
                  end-of-hand state, so its own multi-line height is acceptable. */}
              {isWinnerDisplay ? (
                <div className="flex flex-col items-center leading-none gap-0.5 winner-burst">
                  <div className="font-mono text-[9px] font-bold tracking-[0.2em] text-gold">WINS</div>
                  <div className="font-display font-bold text-[16px] tabular-nums text-gold drop-shadow-[0_0_6px_rgba(255,198,58,0.5)]">
                    +{fmtVal(showdownPot!)}
                  </div>
                  {handName && (
                    <div className="font-mono text-[7px] tracking-wider text-gold/70 truncate max-w-[88px]">{handName}</div>
                  )}
                </div>
              ) : allIn && !folded ? (
                <div className="flex flex-col items-center leading-none gap-0.5">
                  <div className="font-mono text-[9px] text-gold font-bold tracking-[0.18em]">ALL-IN</div>
                  {totalBet > 0 && (
                    <div className={cn(
                      'font-display font-semibold text-[11px] tabular-nums truncate max-w-full',
                      frame === 'matte-black' ? 'text-gold' : 'text-bone',
                    )}>
                      {fmtVal(totalBet)}
                    </div>
                  )}
                  {uncalledReturn > 0 && (
                    <div className="font-mono text-[8px] text-gold/80 tracking-wider">
                      + {fmtVal(uncalledReturn)} back
                    </div>
                  )}
                </div>
              ) : (
                <div className="h-[16px] flex items-center justify-center overflow-hidden">
                  {isShowdown && (showdownStage ?? 0) >= 5 && handName && !folded && !isWinnerDisplay ? (
                    // Loser's shown-down hand, inside the plate like the
                    // winner's (the floating badge that used to carry this is
                    // gone). Muted: result info, not a celebration.
                    <div className="font-mono text-[8px] tracking-wider text-boneDim/80 truncate max-w-[88px]">
                      {handName}
                    </div>
                  ) : showAction && !folded ? (
                    <div className={cn('font-mono text-[10px] font-bold tracking-wider tabular-nums animate-actionSlideIn truncate',
                      actionText?.startsWith('FOLD') ? 'text-[#c94c4c]' :
                      actionText?.startsWith('ALL') || actionText?.startsWith('RAISE') ? 'text-gold' :
                      actionText?.startsWith('CALL') ? (frame === 'matte-black' ? 'text-gold' : 'text-bone') :
                      actionText?.startsWith('SB') || actionText?.startsWith('BB') ? 'text-amber' :
                      (frame === 'matte-black' ? 'text-gold/80' : 'text-boneDim')
                    )}>
                      {actionText}
                    </div>
                  ) : (
                    <div className={cn('font-display font-semibold tabular-nums leading-none truncate',
                      folded
                        ? 'text-boneDim/40 text-[12px]'
                        : frame === 'matte-black' ? 'text-gold text-[15px]' : 'text-bone text-[15px]',
                    )}>
                      {fmtVal(player.chips)}
                    </div>
                  )}
                </div>
              )}
            </div>

            {isActingTurn && timeLeft != null && timeoutSecs && (
              <div className="absolute left-2 right-2 bottom-0 timer-track">
                <div
                  className={cn('timer-fill', timeLeft <= 4 && 'crit')}
                  style={{ width: `${Math.max(0, (timeLeft / timeoutSecs) * 100)}%` }}
                />
              </div>
            )}

            {folded && !sittingOut && (
              <div className="absolute inset-0 flex items-center justify-center rounded-r-lg rounded-l-sm bg-ink/30 fold-overlay">
                <span className="font-mono text-[10px] tracking-[0.2em] text-boneDim/70 fold-text">FOLD</span>
              </div>
            )}

            {sittingOut && (
              <div
                className={cn(
                  // Frosted-glass scrim: blur the balance/amount behind so the
                  // SIT OUT label is the only readable element. z-20 keeps the
                  // overlay above the inner text but below the SB/BB badge
                  // (z-30) and dealer chip (z-40).
                  // Bottom strip only (not inset-0): keep the NAME readable and
                  // dim just the stack line. The old full-cover scrim relied on
                  // backdrop-blur, which mobile browsers don't render — so it
                  // collapsed to a solid dark rectangle that hid the name (the
                  // "black bar"). A bottom tag works with or without blur.
                  'absolute inset-x-0 bottom-0 z-20 flex items-center justify-center rounded-b-sm backdrop-blur-[2px]',
                  frame === 'matte-black'
                    ? 'bg-black/45 ring-1 ring-inset ring-bone/10'
                    : 'bg-ink/45 ring-1 ring-inset ring-bone/10',
                )}
                style={{ WebkitBackdropFilter: 'blur(3px)' }}
              >
                <span
                  className={cn(
                    'font-mono text-[9px] tracking-[0.22em] font-bold',
                    frame === 'matte-black' ? 'text-gold' : 'text-bone/85',
                  )}
                  style={{ textShadow: '0 1px 2px rgba(0,0,0,0.85)' }}
                >
                  SIT OUT
                </span>
              </div>
            )}

            {player.isLeaving && (
              <div className="absolute inset-0 flex items-center justify-center rounded-r-lg rounded-l-sm bg-ink/50">
                <span className="font-mono text-[8px] tracking-wider text-rose-300/90">LEAVING</span>
              </div>
            )}
          </div>
        </div>

        {/* Bet chips sit on the felt-facing side of the seat, then collect into pot on street changes. */}
        {amountThisStreet > 0 && !folded && (
          <div
            className="absolute z-30 pointer-events-none fade-up whitespace-nowrap"
            style={betPlacement}
          >
            <ChipStack amount={amountThisStreet} size="sm" showLabel={true} fmtVal={fmtVal} bigBlind={bigBlind} />
          </div>
        )}

        {/* Winner payout now renders INSIDE the nameplate (see isWinnerDisplay
            above) — no floating pill below the seat. */}

        {/* KO reward burst: what THIS knockout banked for the hunter. Shield tables
            frame it as points (gains show the banked delta; losses show the point
            leaving so the dot change reads as an event, not a glitch). */}
        {koBurst && (
          <div className={cn(
            'absolute z-40 left-1/2 -translate-x-1/2 -top-10 fade-up pointer-events-none whitespace-nowrap rounded-md bg-black/85 px-2 py-1 font-mono text-[10px]',
            koBurst.delta > 0
              ? 'border border-amber/50 shadow-[0_0_14px_rgba(255,198,58,0.25)]'
              : 'border border-rose-500/40 shadow-[0_0_14px_rgba(244,63,94,0.2)]',
          )}>
            {koBurst.delta > 0 ? (
              <>
                <span className="text-amber font-bold tracking-[0.12em]">{shieldMode ? `+${formatPoints(koBurst.delta)} POINT ` : 'KO '}</span>
                {koBurst.fp > 0 && <span className="text-gold tabular-nums">+{Math.round(koBurst.fp)} $FP&nbsp;</span>}
                {koBurst.sol > 0 && <span className="inline-flex items-baseline gap-0.5 text-emerald-400 tabular-nums">+{koBurst.sol.toFixed(3)}<TokenMark t="sol" size={9} /></span>}
              </>
            ) : (
              <span className="text-rose-300 font-bold tracking-[0.12em]">{formatPoints(koBurst.delta)} POINT</span>
            )}
          </div>
        )}

        {/* Hover peek — stack / in-pot / wallet. Opponents only: the hero hovering
            their own avatar reveals their cards (the muck peek), not a stats panel
            about themselves. Viewport-aware: grows downward for top-row seats and
            flips its anchor edge so it never bleeds off. Suppressed while a modal
            (e.g. player notes) is open — a sticky mobile-tap hover would otherwise
            float this over the modal. */}
        {!isHero && !peekSuppressed && (
        <div
          id="seat-peek-card"
          className={cn(
            'seat-peek absolute z-[999] whitespace-nowrap min-w-[176px] rounded-md overflow-hidden',
            toCenterY > 0 ? 'top-full mt-2' : '-top-[76px]',
            toCenterX < -10 ? 'right-0' : toCenterX > 10 ? 'left-0' : 'left-1/2 -translate-x-1/2',
          )}
          style={{
            background: 'linear-gradient(180deg, #0d0f14 0%, #080a0e 100%)',
            border: '1px solid rgba(242,106,31,0.22)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.7), 0 2px 6px rgba(0,0,0,0.5)',
          }}
        >
          {toCenterY <= 0 && (
            <div className="h-[2px] w-full" style={{ background: 'linear-gradient(90deg, transparent, #F26A1F, transparent)' }} />
          )}
          <div className="px-3 py-2 flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-4">
              <span className="font-mono text-[9px] tracking-[0.16em] text-bone/45 uppercase">Stack</span>
              <span className="font-mono text-[11px] font-bold text-white tabular-nums">{fmtVal(player.chips)} <span className="text-bone/50 font-normal text-[9px]">{bbCount}bb</span></span>
            </div>
            <div className="h-px w-full" style={{ background: 'rgba(255,255,255,0.05)' }} />
            <div className="flex items-center justify-between gap-4">
              <span className="font-mono text-[9px] tracking-[0.16em] text-bone/45 uppercase">In pot</span>
              <span className="font-mono text-[11px] text-orange tabular-nums">{fmtVal(totalBet)}</span>
            </div>
            {koCount > 0 && (
              <>
                <div className="h-px w-full" style={{ background: 'rgba(255,255,255,0.05)' }} />
                {/* Duel-mode kill sheet (user ask 2026-07-03): the hover card is where you
                    size up an opponent - show their knockouts + banked bounty here.
                    Shield tables: the same number is their held points. */}
                <div className="flex items-center justify-between gap-4">
                  <span className="font-mono text-[9px] tracking-[0.16em] text-amber/70 uppercase">{shieldMode ? 'Points' : 'Knockouts'}</span>
                  <span className="font-mono text-[11px] tabular-nums text-amber">&times;{koCount}</span>
                </div>
                {(bankedFp > 0 || bankedSol > 0) && (
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-mono text-[9px] tracking-[0.16em] text-bone/45 uppercase">Banked</span>
                    <span className="inline-flex items-baseline gap-1.5 font-mono text-[10px] tabular-nums">
                      <span className="text-gold">{Math.round(bankedFp).toLocaleString()} FP</span>
                      <span className="inline-flex items-baseline gap-0.5 text-emerald-400">{bankedSol.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<TokenMark t="sol" size={9} /></span>
                    </span>
                  </div>
                )}
              </>
            )}
            <div className="h-px w-full" style={{ background: 'rgba(255,255,255,0.05)' }} />
            <div className="flex items-center justify-between gap-4">
              <span className="font-mono text-[9px] tracking-[0.16em] text-bone/45 uppercase">Wallet</span>
              <span className="font-mono text-[10px] text-gold/90">{shortWallet(player.pubkey)}</span>
            </div>
          </div>
          {toCenterY > 0 && (
            <div className="h-[2px] w-full" style={{ background: 'linear-gradient(90deg, transparent, #F26A1F, transparent)' }} />
          )}
        </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  HeroCockpit — seat.jsx FLOATING variant (the target)
// ═══════════════════════════════════════════════════════════════════════════

interface HeroScenario {
  isSng?: boolean;
  isHeroItm?: boolean;
  heroPlace?: number;
  bubblePlace?: number;
  pokerPool?: number;
  payouts?: number[];
  avgStack?: number;
  blinds?: { small: number; big: number };
}

function HeroCockpit({
  player, isCurrent, handName, timeLeft, timeoutSecs, fmtVal,
  isShowdown, onOpenTopUp, onUseTimeBank,
  ceremony, scenario, hasFloatingCards, myCards, folded,
  cardsLocked = false,
  uncalledReturn = 0,
}: {
  player: Player | null;
  isCurrent: boolean;
  handName?: string;
  timeLeft: number;
  timeoutSecs: number;
  fmtVal: (v: number) => string;
  isShowdown: boolean;
  onOpenTopUp?: () => void;
  onUseTimeBank?: () => void;
  ceremony?: CeremonyPayload | null;
  scenario?: HeroScenario;
  hasFloatingCards?: boolean;
  myCards?: [number, number];
  // True when the user is in an active hand and cards SHOULD be visible but
  // aren't, almost always because the TEE Player token is not active. We
  // render a clickable face-down placeholder that opens the auth modal.
  cardsLocked?: boolean;
  folded?: boolean;
  uncalledReturn?: number;
}) {
  // Per-player card customization (deck colors, font, hero card position).
  // Persisted via localStorage in lib/card-prefs.ts; identical across tables.
  const cardPrefs = useCardPrefs();
  const [bankJustUsed, setBankJustUsed] = useState(false);
  const timeBankSecs = player?.timeBankSeconds ?? 0;
  const timeBankActive = player?.timeBankActive ?? false;
  const canUseTimeBank = !timeBankActive && !bankJustUsed && timeBankSecs >= TIME_BANK_CHUNK_SECONDS;
  const timeBankUsedSecs = Math.max(0, TIME_BANK_MAX_SECONDS - Math.ceil(timeBankSecs));
  const bankTitle = timeBankActive
    ? `Time bank active (${Math.ceil(timeBankSecs)}s left after this use)`
    : canUseTimeBank
      ? `Use time bank (${Math.ceil(timeBankSecs)}s available)`
      : 'Time bank unavailable';

  const onUseTimebank = () => {
    if (!canUseTimeBank || !onUseTimeBank) return;
    onUseTimeBank();
    setBankJustUsed(true);
    SFX.play('timebank');
    setTimeout(() => setBankJustUsed(false), 900);
  };

  useEffect(() => {
    if (!isCurrent) setBankJustUsed(false);
  }, [isCurrent]);

  if (!player) return null;

  const bbSize = scenario?.blinds?.big || 40;
  const bbCount = bbSize > 0 ? (player.chips / bbSize).toFixed(0) : '0';
  // Project $FP earnings at the hero's current rank. Non-ITM finishers
  // also earn a trickle (BPS > 0 on places 4-7 in 9-max, 3-5 in 6-max),
  // so we no longer gate on isHeroItm — trailing zeros in the BPS table
  // naturally project 0 for last-out positions.
  const projectedPokerEarn = scenario?.isSng && scenario.pokerPool && scenario.payouts
    ? Math.round((scenario.pokerPool * (scenario.payouts[(scenario.heroPlace || 1) - 1] || 0)) / 10000)
    : 0;
  const placeSuffix = (n: number) => ['st', 'nd', 'rd'][n - 1] || 'th';

  return (
    <div
      className="glass-room relative px-3 md:px-4 flex flex-wrap md:flex-nowrap items-end gap-3 md:gap-4 overflow-visible pt-8 pb-3 h-[136px] md:h-[112px]"
    >
      {ceremony && <InlineCeremony kind={ceremony.kind} amount={ceremony.amount} amountLabel={ceremony.amountLabel} fmtVal={fmtVal} />}

      {/* Floating hole cards — fan over the rail edge (reserved slot stays
          even when empty). Position respects the user's heroPosition pref
          (left or center) so they get the same placement on every table. */}
      {hasFloatingCards && myCards && (
        <div
          className={cn(
            'absolute z-10',
            cardPrefs.heroPosition === 'center'
              ? 'left-1/2 -translate-x-1/2'
              : 'left-3 md:left-6',
            folded && 'opacity-40 grayscale',
          )}
          style={railCardTopOffsetStyle(cardPrefs.cardSize)}
        >
          <HoleCards cards={myCards} size={railCardSize(cardPrefs.cardSize)} revealed stagger={200} fan />
        </div>
      )}
      {/* Auth-locked placeholder. Cards are dealt but client can't read them
          because TEE Player token is not active. Render face-down cards with
          a Lock badge and route clicks to the auth modal so users have a
          direct path back to play without hunting through settings. */}
      {!myCards && cardsLocked && (
        <button
          type="button"
          onClick={() => { SFX.play('ui-click'); requestOpenSessionRenewModal(); }}
          className={cn(
            'absolute z-10 group cursor-pointer',
            cardPrefs.heroPosition === 'center'
              ? 'left-1/2 -translate-x-1/2'
              : 'left-3 md:left-6',
          )}
          style={railCardTopOffsetStyle(cardPrefs.cardSize)}
          title="Authenticate to see your hole cards"
          aria-label="Authenticate to see your hole cards"
        >
          <div className="relative blur-[1.5px] group-hover:blur-[1px] transition-[filter]">
            <HoleCards size={railCardSize(cardPrefs.cardSize)} revealed={false} stagger={0} fan animate={false} />
          </div>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm border border-orange/60 bg-ink/85 backdrop-blur-sm shadow-[0_2px_8px_rgba(0,0,0,0.6)] animate-pulse">
              <Lock className="w-3 h-3 text-orange" />
              <span className="font-mono text-[9px] tracking-[0.22em] text-orange font-bold uppercase">Tap to unlock</span>
            </div>
          </div>
        </button>
      )}

      {isCurrent && !isShowdown && (
        <button
          type="button"
          onClick={onUseTimebank}
          disabled={!canUseTimeBank}
          className="absolute right-3 top-2 z-20 md:hidden disabled:pointer-events-none"
          title={bankTitle}
        >
          <TurnTimer
            style="ring"
            timeLeft={timeLeft}
            timeoutSecs={timeoutSecs}
            timeBankSecs={timeBankSecs}
            timeBankActive={timeBankActive}
            bankJustUsed={bankJustUsed}
            size={52}
            forceShowBankCta={false}
            showBankCta={false}
          />
        </button>
      )}

      {/* Identity block — always offset to reserve space for cards, so layout stays stable */}
      <div className="flex flex-col gap-1 flex-1 min-w-0 ml-[148px] md:ml-[140px] pr-[56px] md:pr-0">
        <div className="flex items-baseline gap-2 flex-nowrap min-w-0">
          <span className="font-display text-bone text-lg leading-none">You</span>
          <span className="font-mono text-[10px] text-gold/70 tracking-wider truncate min-w-0">{shortWallet(player.pubkey)}</span>
          {scenario?.isSng && scenario.heroPlace != null && (
            <span className={cn(
              'px-1.5 py-[1px] rounded-sm border font-mono text-[9px] tracking-[0.2em] font-bold leading-none',
              scenario.isHeroItm
                ? 'border-gold/60 bg-gold/15 text-gold'
                : 'border-orange/40 bg-orange/10 text-orange'
            )}>
              {scenario.isHeroItm
                ? `ITM · ${scenario.heroPlace}${placeSuffix(scenario.heroPlace)}`
                : `${scenario.heroPlace}${placeSuffix(scenario.heroPlace)} · BUBBLE @ ${scenario.bubblePlace}`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <div className="flex items-baseline gap-1.5 min-w-0 whitespace-nowrap">
            <Eyebrow className="shrink-0">Stack</Eyebrow>
            <span className="font-mono text-bone text-[13px] sm:text-[14px] tabular-nums leading-none shrink-0">{fmtVal(player.chips)}</span>
            <span className="font-mono text-[10px] text-boneDim/60 leading-none">· {bbCount} bb</span>
            {uncalledReturn > 0 && (
              <span className="font-mono text-[10px] text-gold/90 tracking-wider leading-none">+ {fmtVal(uncalledReturn)} uncalled</span>
            )}
          </div>
          {scenario?.isSng && scenario.avgStack != null && (
            <>
              <div className="h-3 w-px bg-gold/15" />
              <div className="flex items-baseline gap-1.5">
                <Eyebrow>Avg</Eyebrow>
                <span className="font-mono text-[12px] tabular-nums text-boneDim leading-none">{scenario.avgStack.toLocaleString()}</span>
              </div>
            </>
          )}
          {projectedPokerEarn > 0 && (
            <>
              <div className="h-3 w-px bg-gold/15" />
              <div className="flex items-baseline gap-1.5">
                <Eyebrow>Proj</Eyebrow>
                <span className="font-display text-amber text-[13px] tabular-nums leading-none">+{projectedPokerEarn.toLocaleString()}</span>
                <span className="font-mono text-[9px] text-amber/70 tracking-wider leading-none">$FP</span>
              </div>
            </>
          )}
          {handName && (
            <>
              <div className="h-3 w-px bg-gold/15" />
              <span className="font-display text-gold/90 text-sm italic leading-none">{handName}</span>
            </>
          )}
          <div className="h-3 w-px bg-gold/15" />
          <div className="flex items-baseline gap-1.5 min-w-0 whitespace-nowrap">
            <Eyebrow className="shrink-0">Bank</Eyebrow>
            <span className="font-mono text-[11px] tabular-nums text-amber leading-none">{Math.ceil(timeBankSecs)}s</span>
            <span className="font-mono text-[9px] text-boneDim/60 tracking-wider leading-none">
              {timeBankActive ? 'using +15s' : timeBankUsedSecs > 0 ? `${timeBankUsedSecs}s used` : 'full'}
            </span>
          </div>
        </div>
      </div>

      {/* TOP UP / REBUY — available in cash games, not gated on turn. Hidden
          while all-in: chips===0 then means the stack is committed and the hand
          is still live, NOT busted, so prompting a rebuy/top-up is premature. */}
      {onOpenTopUp && !isShowdown && !player.isAllIn && (
        <div className="w-full md:w-auto md:ml-auto flex items-end gap-3 justify-end">
          <button
            onClick={() => { SFX.play('ui-click'); onOpenTopUp(); }}
            className={cn(
              'px-2.5 py-1 rounded-sm font-mono text-[10px] tracking-[0.2em] shrink-0 transition',
              player.chips === 0
                ? 'btn-orange font-bold text-ink'
                : 'hairline bg-inkB/50 hover:bg-inkB text-bone/80 hover:text-bone'
            )}
          >
            {player.chips === 0 ? 'REBUY' : 'TOP UP'}
          </button>
          {isCurrent && (
            <div className="hidden md:block">
              <TurnTimer
                style="ring"
                timeLeft={timeLeft}
                timeoutSecs={timeoutSecs}
                timeBankSecs={timeBankSecs}
                timeBankActive={timeBankActive}
                bankJustUsed={bankJustUsed}
                onUseTimebank={onUseTimebank}
                size={72}
                forceShowBankCta={true}
              />
            </div>
          )}
        </div>
      )}
      {(!onOpenTopUp || isShowdown) && isCurrent && !isShowdown && (
        <div className="hidden md:flex w-full md:w-auto md:ml-auto items-end gap-3 justify-end">
          <TurnTimer
            style="ring"
            timeLeft={timeLeft}
            timeoutSecs={timeoutSecs}
            timeBankSecs={timeBankSecs}
            timeBankActive={timeBankActive}
            bankJustUsed={bankJustUsed}
            onUseTimebank={onUseTimebank}
            size={72}
            forceShowBankCta={true}
          />
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  SpectatorCockpit — same chrome as HeroCockpit but no seat, no actions
// ═══════════════════════════════════════════════════════════════════════════

function SpectatorCockpit({
  isCashGame, players, maxSeats, onJoin, reservedByOthers = [],
}: {
  isCashGame: boolean;
  players: Player[];
  maxSeats: number;
  onJoin: () => void;
  /** Seats blocked by another player's in-flight DepositProof reservation. */
  reservedByOthers?: number[];
}) {
  const seated = players.length;
  // A seat counts as "truly open" only if no one is seated AND no one is mid-join.
  // Without this, "JOIN TABLE" would happily route to a seat showing JOINING.
  const taken = new Set(players.map(p => p.seatIndex));
  const reserved = new Set(reservedByOthers);
  let openCount = 0;
  for (let i = 0; i < maxSeats; i++) {
    if (!taken.has(i) && !reserved.has(i)) openCount++;
  }
  const hasOpenSeat = openCount > 0;
  const tableFull = seated + reservedByOthers.length >= maxSeats;
  const joinLabel = isCashGame ? 'JOIN TABLE' : 'JOIN POOL';
  // Cash needs a real open seat to buy into. SNG just routes to the lobby
  // (seats are filled from the pool/queue), so the button is always actionable.
  const canJoin = isCashGame ? hasOpenSeat : true;

  return (
    <div
      className="glass-room relative px-3 md:px-4 flex flex-wrap md:flex-nowrap items-center gap-3 md:gap-4 overflow-visible pt-8 pb-3 h-[136px] md:h-[112px]"
    >
      <div className="absolute top-2 left-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 px-1.5 py-[2px] rounded-sm border border-bone/25 bg-inkB/60 font-mono text-[9px] tracking-[0.3em] text-bone/80 leading-none">
          <span className="w-1.5 h-1.5 rounded-full bg-bone/70 animate-pulse" />
          SPECTATING
        </span>
      </div>

      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-display text-bone/90 text-lg leading-none">Observer</span>
          <span className="font-mono text-[10px] text-boneDim/60 tracking-wider">
            {seated}/{maxSeats} seated
          </span>
        </div>
        <span className="font-mono text-[10px] text-boneDim/60 tracking-wider">
          {canJoin
            ? (isCashGame ? 'Pick an open seat to buy in' : 'Join the pool from the lobby to compete')
            : (!hasOpenSeat
                ? (tableFull ? 'Table is full' : 'All open seats are mid-join')
                : 'Waiting for the current hand to finish')}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => { if (canJoin) { SFX.play('ui-click'); onJoin(); } }}
          disabled={!canJoin}
          className="px-4 py-2 rounded-md btn-orange font-mono text-[11px] tracking-[0.24em] font-bold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {joinLabel}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  BettingControls — actions.jsx 1:1
// ═══════════════════════════════════════════════════════════════════════════

// Pre-action (Check/Fold · Auto Check · Call Any) selections survive table
// switches (multi-tabling): keyed by table PDA + the hand they were set on, in a
// module-level map that outlives the component unmount on navigation. Scoping to
// the hand means a stale selection never carries into a different hand on return.
type PreActionKind = 'check-fold' | 'check' | 'call-any';
const preActionStore = new Map<string, { action: PreActionKind; hand: number }>();

// Sticky seat -> pubkey memory (finding 2026-07-04): the roster empties when the table
// resets for reuse, and anything resolving a seat name at that moment (TOP HUNTERS,
// standings OUT rows) regresses to "Seat N". Module-level so child components
// (SngStandings) resolve through it too; keyed per table, cleared on table switch.
const seatPubkeyMemo = new Map<number, string>();
let seatPubkeyMemoTable: string | null = null;
// Reload persistence (#24): the memo is per-tab session state, so a page reload
// mid-game must not lose it (names on OUT rows / Top Hunters, hero-seat recovery).
const seatMemoStorageKey = (tablePda: string) => `fp.seatmemo.${tablePda}`;
function persistSeatMemo(tablePda: string): void {
  try {
    sessionStorage.setItem(seatMemoStorageKey(tablePda), JSON.stringify([...seatPubkeyMemo]));
  } catch { /* storage full/blocked - memo still works in-memory */ }
}
function hydrateSeatMemo(tablePda: string): void {
  try {
    const raw = sessionStorage.getItem(seatMemoStorageKey(tablePda));
    if (!raw) return;
    for (const [seat, pubkey] of JSON.parse(raw) as Array<[number, string]>) {
      if (typeof seat === 'number' && typeof pubkey === 'string') seatPubkeyMemo.set(seat, pubkey);
    }
  } catch { /* corrupt entry - start clean */ }
}
function rememberSeatPubkeys(tablePda: string, players: { seatIndex: number; pubkey: string | null }[]): void {
  if (seatPubkeyMemoTable !== tablePda) {
    seatPubkeyMemo.clear();
    seatPubkeyMemoTable = tablePda;
    if (typeof window !== 'undefined') hydrateSeatMemo(tablePda);
  }
  let changed = false;
  for (const p of players) {
    if (p.pubkey && !p.pubkey.startsWith('seat-') && seatPubkeyMemo.get(p.seatIndex) !== p.pubkey) {
      seatPubkeyMemo.set(p.seatIndex, p.pubkey);
      changed = true;
    }
  }
  if (changed && typeof window !== 'undefined') persistSeatMemo(tablePda);
}
function rememberedSeatPubkey(seat: number): string | undefined {
  return seatPubkeyMemo.get(seat);
}

export function BettingControls({
  phase, currentBet, myBet, myChips, pot, bigBlind, onAction, isMyTurn,
  showPreAction,
  isShowdown, hasFolded, actionPending, fmtVal, parseVal,
  canRaise = true,
  myCards,
  timeLeft, timeoutSecs = 15,
  timeBankSecs = 0, timeBankActive = false,
  isCashGame, isMeSittingOut, isWaitingForBb, missedBb, missedSb, numSeatedPlayers, onSitIn, sittingOutPending, onOpenTopUp,
  maxOpponentStack, isAllIn, isMeLeaving, tablePda, handNumber = 0,
  sessionClaimRequired = false, onClaimSeatSession,
  onShowCards, revealedThisHand = false,
}: {
  phase: string; currentBet: number; myBet: number; myChips: number;
  pot: number; bigBlind: number;
  tablePda?: string; handNumber?: number;
  onAction?: (action: string, amount?: number) => void;
  // isMyTurn: true when player should see the action slider.
  // showPreAction: true when player should see pre-action checkboxes.
  isMyTurn: boolean; showPreAction: boolean;
  isShowdown: boolean; hasFolded: boolean;
  actionPending: boolean; fmtVal: (v: number) => string;
  // Inverse of fmtVal: parse a typed display string back into bet units, or
  // null if not a number. Powers the editable custom bet-amount field.
  parseVal?: (s: string) => number | null;
  canRaise?: boolean;
  myCards?: [number, number];
  timeLeft?: number;
  timeoutSecs?: number;
  /** Hero's remaining time-bank seconds (seat.time_bank_seconds). */
  timeBankSecs?: number;
  /** Hero has already engaged the time bank for the current action turn. */
  timeBankActive?: boolean;
  isCashGame?: boolean;
  isMeSittingOut?: boolean;
  isWaitingForBb?: boolean;
  // On-chain "you owe blinds" flags. When either is true, this is Scenario C/D
  // (returning after a missed BB seat) and POST vs WAIT has a real cost/wait
  // tradeoff. When both are false (Scenarios A/B - fresh joiner), the
  // contract enforces the behind-button rule and POST has no buyout effect.
  missedBb?: boolean;
  missedSb?: boolean;
  // Total seats currently occupied (any status). Used to suppress the BB
  // prompt when the player is alone at the table — no hand can deal until
  // at least one other player sits down.
  numSeatedPlayers?: number;
  onSitIn?: (postBlind: boolean) => void;
  sittingOutPending?: boolean;
  onOpenTopUp?: () => void;
  // Largest total committable (chips + current bet) among opponents still in
  // the hand. The raise slider caps here: you can't enter an intermediate
  // raise above what the opponent can cover (the contract rejects those, and
  // with skipPreflight the tx silently fails). Dragging to max routes ALL-IN,
  // which the contract handles by shoving the full stack and returning excess.
  maxOpponentStack?: number;
  // Hero is all-in in the current (live) hand. Used to suppress the busted /
  // rebuy prompts: chips===0 while all-in is not "out of chips".
  isAllIn?: boolean;
  /** Hero chose to leave (cash). Seat sits in Leaving status until the cashout
   *  settles — suppress the rebuy/action UI and show LEAVING instead. */
  isMeLeaving?: boolean;
  sessionClaimRequired?: boolean;
  sessionClaimDebug?: string | null;
  onClaimSeatSession?: () => void;
  /** Relay the hero's own cards (post-hand only). Returns success. */
  onShowCards?: (cards: [number, number]) => Promise<boolean>;
  /** Hero already showed this hand. */
  revealedThisHand?: boolean;
}) {
  // Per-player UI prefs (deck colors / font / hero pos / bet presets).
  // betPresets drives the quick-bet strip below — see prefs.betPresets.
  const cardPrefs = useCardPrefs();
  const isMobile = useIsMobile();
  // Hole cards live in the action bar for the 'left'/'center' positions. For
  // 'table' (now allowed on mobile too) they render on the felt at the seat, so
  // suppress the bar copy to avoid showing them twice.
  const heroCardsInBar = cardPrefs.heroPosition !== 'table';
  // Rendered as the leftmost element in EVERY active-hand control branch
  // (your turn, pre-action, waiting) so the cards stay visible the whole hand,
  // not just when it's your turn to act.
  const heroBarCards = (myCards && heroCardsInBar) ? (
    // Mobile: these ARE the visible cards, in-flex in the bar (the layout that
    // worked). Desktop (md+): md:invisible turns this into a width-reserving
    // spacer, and the real cards are drawn as an absolute overlay in the
    // controls wrapper so large sizes can spill above the bar (z-30).
    <div className="shrink-0 self-center md:invisible">
      <HoleCards cards={myCards} size={feltCardSize(cardPrefs.cardSize)} revealed animate={false} />
    </div>
  ) : null;
  // Clamp to myChips so we never show a call amount larger than the player's
  // effective stack. The contract (player_action.rs:290) auto-clamps to
  // seat.chips, but the UI must match or users see a misleading call label.
  const callAmount = Math.max(Math.min(currentBet - myBet, myChips), 0);
  const canCheck = callAmount === 0;
  // Min raise-TO (total). The contract wants the raise INCREMENT >= one big
  // blind AND the new total >= 2x the previous bet (else RaiseTooSmall / 6027).
  // max(currentBet + bigBlind, currentBet * 2) captures every case:
  //   - postflop open  (currentBet 0)            -> bigBlind (1 BB opening bet)
  //   - BB option / limped pot (currentBet == BB) -> 2 BB
  //   - facing a bet/raise                        -> at least 2x it
  // The old `canCheck ? bigBlind` branch returned 1 BB for the BB-preflop option
  // (canCheck but currentBet == BB), so the raise wired a 0-chip increment
  // (amount - currentBet) and the chain rejected it with RaiseTooSmall.
  const minRaise = Math.max(currentBet + bigBlind, currentBet * 2);
  // Cap the raise-to at the largest amount an opponent can actually match.
  // Betting above that is only valid as an all-in over-shove (the ALL-IN route
  // shoves the full stack and the chain returns the uncalled excess); an
  // intermediate raise above it is rejected on-chain, so block it in the UI.
  const myMaxCommit = myChips + myBet;
  const maxRaise = maxOpponentStack && maxOpponentStack > 0
    ? Math.min(myMaxCommit, maxOpponentStack)
    : myMaxCommit;
  const raiseAvailable = canRaise && myChips > 0;
  const [raiseAmt, setRaiseAmt] = useState(minRaise);
  const [preAction, setPreAction] = useState<PreActionKind | null>(() => {
    // Restore a pre-action set on this table for the current hand (survives a
    // table switch); ignore a stale one carried from a previous hand.
    if (!tablePda) return null;
    const e = preActionStore.get(tablePda);
    return e && e.hand === handNumber ? e.action : null;
  });
  const preActionsDisabled = !!sessionClaimRequired;

  useEffect(() => {
    if (preActionsDisabled) setPreAction(null);
  }, [preActionsDisabled]);

  useEffect(() => {
    if (!isMyTurn) return;
    setRaiseAmt(Math.min(minRaise, maxRaise));
  }, [isMyTurn, phase, currentBet, myBet, minRaise, maxRaise]);

  // Custom bet amount: while the user is typing in the editable value field we
  // hold the raw string here (null = not editing, show fmtVal(raiseAmt)). On
  // commit (blur / Enter) we parse it and CLAMP into the legal [minRaise,
  // maxRaise] window, so a typed value can never exceed the stack/effective cap
  // or fall below a legal raise. The slider/presets read raiseAmt, so it moves
  // to match automatically. Invalid input reverts to the current amount.
  const [betDraft, setBetDraft] = useState<string | null>(null);
  const commitBetDraft = useCallback((raw: string) => {
    const parsed = parseVal ? parseVal(raw) : parseInt(raw.replace(/[^0-9]/g, ''), 10);
    setBetDraft(null);
    if (parsed == null || Number.isNaN(parsed)) return; // keep current raiseAmt
    const lo = Math.min(minRaise, maxRaise);
    setRaiseAmt(Math.max(lo, Math.min(maxRaise, parsed)));
  }, [parseVal, minRaise, maxRaise]);

  // Fire queued pre-action the moment it becomes the player's turn.
  // check-fold: check if free, else fold.
  // check: check if free, else clear (user must decide manually when facing a bet).
  // call-any: check if free, else call the full amount.
  useEffect(() => {
    if (!isMyTurn || actionPending || isShowdown || hasFolded || !preAction || preActionsDisabled) return;
    if (preAction === 'check-fold') {
      if (canCheck) { SFX.play('check'); onAction?.('check'); }
      else { SFX.play('fold'); onAction?.('fold'); }
      setPreAction(null);
    } else if (preAction === 'check') {
      if (canCheck) { SFX.play('check'); onAction?.('check'); }
      setPreAction(null);
    } else if (preAction === 'call-any') {
      if (canCheck) { SFX.play('check'); onAction?.('check'); }
      else { SFX.play('call'); onAction?.('call', callAmount); }
      setPreAction(null);
    }
  }, [isMyTurn, actionPending, isShowdown, hasFolded, preAction, canCheck, callAmount, onAction, preActionsDisabled]);

  // If a check stops being available before your turn (a bet/raise lands), drop
  // a pre-set Auto Check so it can't silently lapse into a timeout. Check/Fold
  // and Call Any stay valid (they degrade to fold / call).
  useEffect(() => {
    if (preAction === 'check' && !canCheck) setPreAction(null);
  }, [preAction, canCheck]);

  // Pre-actions are per-hand intent — clear at the hand boundary so a
  // Check/Fold (or Check / Call-Any) never silently carries into the next hand.
  // (A future "hold to keep on" persistent mode could opt out of this.)
  useEffect(() => {
    if (isShowdown || hasFolded || phase === 'Waiting' || phase === 'Starting' || phase === 'Complete') {
      setPreAction(null);
    }
  }, [isShowdown, hasFolded, phase]);

  // Persist the pre-action per (table, hand) so it survives a table switch and
  // is restored on return — but never leaks into a different hand.
  useEffect(() => {
    if (!tablePda) return;
    if (preAction) preActionStore.set(tablePda, { action: preAction, hand: handNumber });
    else preActionStore.delete(tablePda);
  }, [preAction, tablePda, handNumber]);

  const controlShellClass = 'glass-room relative h-full min-h-0 px-3 md:px-4 py-2 md:py-3 flex flex-wrap md:flex-nowrap items-center gap-3 overflow-hidden';
  const takeControlButton = sessionClaimRequired && onClaimSeatSession ? (
    <button
      type="button"
      data-testid="action-take-control"
      title="Updates only this poker seat's session key. No funds move."
      // Fixed width; the wrapper at each render site owns the alignment (always
      // centered on its own row on mobile, right-aligned inline on desktop) so
      // the button no longer jumps between states.
      className="electric-btn electric-btn--raise flex-none min-w-[220px] md:min-w-[210px] max-w-full"
      onClick={() => { SFX.play('ui-click'); onClaimSeatSession(); }}
      disabled={actionPending}
    >
      <span>{actionPending ? 'LINKING DEVICE...' : 'USE THIS DEVICE'}</span>
      <svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" aria-hidden="true">
        <path d="M6 0 1 7.5h3.5L3 13 9 5.5H5.5L6 0Z" />
      </svg>
    </button>
  ) : null;

  // Cash player who chose to leave: the seat sits in Leaving status until the
  // cashout settles. They are NOT busted — don't prompt a rebuy, and don't show
  // any action UI. Takes precedence over the showdown / out-of-chips / action
  // branches below.
  if (isCashGame && isMeLeaving) {
    return (
      <div className={cn(controlShellClass, 'border border-boneDim/25')}>
        <Eyebrow>Leaving</Eyebrow>
        <span className="font-display text-boneDim text-sm">Cashing out. You&apos;ll be removed once this hand settles.</span>
      </div>
    );
  }

  // Voluntary post-hand card show. STRICT gate: hand is decided (showdown or
  // Complete), hero has their OWN valid cards, and hasn't already shown — never
  // mid-hand, so it can't leak live info. Rendered in the action bar with the
  // same electric-btn treatment as FOLD/CALL, sitting beside the hero's cards.
  const heroHasShowableCards = !!(myCards && myCards[0] !== 255 && myCards[1] !== 255 && myCards[0] <= 51 && myCards[1] <= 51);
  // Gate: ONLY once the hand is fully over (phase Complete) — NOT isShowdown,
  // which can be true mid-runout/reveal and would leak a live hand. Currently
  // hard-disabled by SHOW_CARDS_ENABLED (kept wired, not enabled).
  const canShowCards = SHOW_CARDS_ENABLED && !!onShowCards && !revealedThisHand && heroHasShowableCards && phase === 'Complete';
  if (canShowCards) {
    return (
      <div className={cn(controlShellClass, 'flex-row !flex-nowrap items-center gap-2 md:gap-3')}>
        <div className="flex items-stretch gap-2 md:shrink-0">
          {heroBarCards}
          <button
            data-testid="action-show-cards"
            className="electric-btn electric-btn--call flex-1 md:flex-none md:min-w-[88px] lg:min-w-[112px] min-w-0"
            onClick={async () => { SFX.play('ui-tap'); await onShowCards?.(myCards as [number, number]); }}
          >
            <span>SHOW</span>
            <svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" aria-hidden="true">
              <path d="M6 0 1 7.5h3.5L3 13 9 5.5H5.5L6 0Z" />
            </svg>
          </button>
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <Eyebrow>Hand complete</Eyebrow>
          <span className="font-display text-boneDim text-[12px] md:text-sm leading-tight truncate">Reveal your hand to the table?</span>
        </div>
        {takeControlButton && <div className="md:ml-auto flex items-center gap-2 shrink-0">{takeControlButton}</div>}
      </div>
    );
  }

  if (isShowdown) {
    return (
      <div className={controlShellClass}>
        {heroBarCards}
        <Eyebrow>Status</Eyebrow>
        <span className="font-display text-boneDim text-sm">Showdown in progress.</span>
        {takeControlButton && <div className="w-full md:w-auto md:ml-auto flex justify-center md:justify-end items-center gap-2 shrink-0">{takeControlButton}</div>}
      </div>
    );
  }

  // Busted in cash game — prominent rebuy CTA so they don't silently get stuck.
  // Suppressed while all-in: chips===0 then means the stack is in the pot and
  // the hand is still live (they may win it back), not busted. The CTA returns
  // once the hand settles and they're genuinely out of chips.
  if (isCashGame && myChips === 0 && onOpenTopUp && !isAllIn) {
    return (
      <div className={cn(controlShellClass, 'border border-orange/40 bg-orange/[0.05]')}>
        <Eyebrow>Out of chips</Eyebrow>
        <span className="font-display text-bone text-sm">Rebuy to keep playing.</span>
        <button
          onClick={() => { SFX.play('deposit'); onOpenTopUp(); }}
          className="ml-auto btn-orange px-5 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.24em] font-bold"
        >
          REBUY
        </button>
      </div>
    );
  }

  // SNG / tournament sitting-out player. Unlike cash (sit-out seats are not
  // dealt), the contract STILL deals an SNG SittingOut seat and gives it turns
  // (start_game.rs active_mask includes SittingOut), but can_act() requires
  // Active — so they cannot bet and auto-fold every orbit at the 5s timeout with
  // no path back. sit_in for SNG is a clean reactivation: no missed-blind charge
  // and no wait-for-BB (sit_out.rs:171 owes_blinds is cash-only). Surface a
  // single I'M BACK only when it is NOT their turn. ON their turn they fall
  // through to the normal action buttons below: with the act-while-sitting-out
  // contract change, taking an action reactivates them in place (no sit_in
  // round-trip, no between-hands wait), so act-to-return is the primary path and
  // I'M BACK is just the off-turn shortcut.
  // SNG has no voluntary sit-out / "I'M BACK" toggle — it's a cash concept. If a
  // player got blinded off (e.g. crank auto-sit-out after repeated timeouts),
  // just show a status; they reactivate in place by taking an action on their
  // turn (act-to-return), so no button is needed or offered.
  if (!isCashGame && isMeSittingOut && !isMyTurn) {
    // SNG: a blinded-off player is NOT dealt into the hand, so "act on your next
    // turn" alone strands them (they have no turn). Always offer an explicit
    // I'M BACK (sit_in) so they can reactivate off-turn. (Removing this button
    // earlier was the bug — there was no return path.)
    return (
      <div className={cn(controlShellClass, 'border border-emerald-300/30 bg-emerald-300/[0.04]')}>
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <Eyebrow>Sitting out</Eyebrow>
          <span className="font-display text-bone text-[13px] md:text-sm leading-tight min-w-0 truncate">
            Being blinded off. Tap I&apos;M BACK to return.
          </span>
        </div>
        <button
          disabled={sittingOutPending}
          onClick={() => { SFX.play('deposit'); onSitIn?.(false); }}
          className={cn(
            'rounded-md border font-mono font-bold transition-all',
            'px-5 md:px-7 py-2.5 md:py-2 min-h-[56px] md:min-h-[52px] md:min-w-[180px]',
            'border-emerald-300/60 bg-emerald-300/15 text-emerald-300 hover:bg-emerald-300/25 hover:border-emerald-300/80 ring-1 ring-emerald-300/30',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          )}
        >
          <span className="flex flex-col items-center leading-tight gap-1">
            <span className="text-[15px] md:text-[17px] tracking-[0.26em]">
              {sittingOutPending ? 'RETURNING…' : "I'M BACK"}
            </span>
          </span>
        </button>
      </div>
    );
  }

  // Active wait-for-BB joiner: no button needed; the contract deals them in
  // automatically when the big blind naturally reaches their seat.
  if (isCashGame && isWaitingForBb && !isMeSittingOut && !isMyTurn) {
    return (
      <div className={cn(controlShellClass, 'border border-emerald-300/30 bg-emerald-300/[0.04]')}>
        <Eyebrow>Joining</Eyebrow>
        <span className="font-display text-bone text-[13px] md:text-sm leading-tight min-w-0 truncate">
          Waiting for the big blind. You will be dealt in automatically.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] tracking-[0.22em] text-emerald-300/80 animate-pulse uppercase">
            WAITING
          </span>
        </div>
      </div>
    );
  }

  // Sitting out in cash game, from programs/fastpoker/src/instructions/seat_player.rs + sit_out.rs:
  //
  //   Branch B (voluntary sit-out, no missed flags): user chose to sit out
  //   before any deal-time blind marker fired. They can return immediately.
  //
  //   Branch C (returning from sit-out with missed_sb/bb): real YES/NO choice.
  //   POST pays the owed blinds and activates; WAIT keeps waiting_for_bb=true
  //   and lets the dealer include them when BB rotates back to their seat.
  //
  // handleSitIn forwards postMissedBlinds via sendAction('return_to_play', 1 | 0);
  // useOnChainGame maps that to the standalone sit_in IX, so the boolean is
  // preserved on-chain.
  //
  // Gate on !isMyTurn: when the contract has unambiguously activated the seat
  // (timer running, action expected), Seat-PDA WS for isMeSittingOut can lag
  // 1-3s behind Table-PDA WS that drives isMyTurn. Without this gate, the
  // user sees the JOINING / SIT OUT card while the action timer ticks against
  // them. The moment isMyTurn flips true, the contract has already cleared
  // waiting_for_bb + status, so the action UI is the truthful render.
  if (isCashGame && isMeSittingOut && !isMyTurn) {
    const owesBlinds = missedBb || missedSb;
    const totalOwed = (missedBb ? bigBlind : 0) + (missedSb ? bigBlind / 2 : 0);
    const aloneAtTable = (numSeatedPlayers ?? 0) < 2;

    // Alone at the table: no hand can start regardless of POST/WAIT choice.
    // Suppress the BB prompt so the player sees an honest "waiting for
    // opponents" status instead of a meaningless YES/NO choice.
    if (aloneAtTable) {
      return (
        <div className={controlShellClass}>
          <Eyebrow>Seated</Eyebrow>
          <span className="font-display text-bone text-sm min-w-0 truncate">
            Waiting for another player to sit down. You will be dealt in once the table fills.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="font-mono text-[10px] tracking-[0.22em] text-amber/80 animate-pulse uppercase">
              1 OF 2 NEEDED
            </span>
          </div>
        </div>
      );
    }

    // Branch B/C2: sitting out with no missed blinds owed. Two sub-cases:
    //
    //   (a) !isWaitingForBb → voluntary sit-out returner BEFORE any deal-time
    //   marker fired (start_game.rs:870 only sets missed flags when a blind
    //   would have passed a SittingOut seat). They can sit_in immediately
    //   with no charge; show an inline I'M BACK CTA so the action-bar card
    //   is self-sufficient instead of forcing them to the header toolbar.
    //
    //   (b) isWaitingForBb → legacy/older on-chain state where a waiter was
    //   represented as SittingOut. New tables use Active+waiting_for_bb and
    //   are caught by the status-only branch above.
    if (!owesBlinds) {
      // (a) Voluntary sit-out returner — inline I'M BACK button
      if (!isWaitingForBb) {
        return (
          <div className={cn(controlShellClass, 'border border-emerald-300/30 bg-emerald-300/[0.04]')}>
            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
              <Eyebrow>Sitting out</Eyebrow>
              <span className="font-display text-bone text-[13px] md:text-sm leading-tight min-w-0 truncate">
                You sat out. Return to play when you are ready.
              </span>
            </div>
            <button
              disabled={sittingOutPending}
              onClick={() => { SFX.play('deposit'); onSitIn?.(false); }}
              className={cn(
                'rounded-md border font-mono font-bold transition-all',
                'px-5 md:px-7 py-2.5 md:py-2 min-h-[56px] md:min-h-[52px] md:min-w-[180px]',
                'border-emerald-300/60 bg-emerald-300/15 text-emerald-300 hover:bg-emerald-300/25 hover:border-emerald-300/80 ring-1 ring-emerald-300/30',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              <span className="flex flex-col items-center leading-tight gap-1">
                <span className="text-[15px] md:text-[17px] tracking-[0.26em]">
                  {sittingOutPending ? 'RETURNING…' : "I'M BACK"}
                </span>
              </span>
            </button>
          </div>
        );
      }
      // (b) Mid-hand fresh joiner — status only. HU uses emerald to match Branch C-HU.
      const isHu = (numSeatedPlayers ?? 0) === 2;
      return (
        <div className={cn(controlShellClass, isHu && 'border border-emerald-300/30 bg-emerald-300/[0.04]')}>
          <Eyebrow>Joining</Eyebrow>
          <span className="font-display text-bone text-[13px] md:text-sm leading-tight min-w-0 truncate">
            {isHu
              ? 'You will be dealt in next hand — no charge.'
              : 'Joining the table. You will be dealt in after this hand.'}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className={cn(
              'font-mono text-[10px] tracking-[0.22em] animate-pulse uppercase',
              isHu ? 'text-emerald-300/80' : 'text-amber/80',
            )}>
              WAITING…
            </span>
          </div>
        </div>
      );
    }

    // Branch C-HU: in heads-up the button rotates every hand, so a fresh
    // joiner with waiting_for_bb=true is GUARANTEED to be dealt in as BB
    // next hand at no charge. The YES/NO prompt offers no real tradeoff
    // (POST = pay BB now, WAIT = pay BB next hand for free), so collapse
    // it to a clear "no charge" status. Suppression only when the contract
    // has already opted them into waiting_for_bb.
    if ((numSeatedPlayers ?? 0) === 2 && isWaitingForBb) {
      return (
        <div className={cn(controlShellClass, 'border border-emerald-300/30 bg-emerald-300/[0.04]')}>
          <Eyebrow>Joining</Eyebrow>
          <span className="font-display text-bone text-[13px] md:text-sm leading-tight min-w-0 truncate">
            You will be dealt in as BB next hand — no charge.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="font-mono text-[10px] tracking-[0.22em] text-emerald-300/80 animate-pulse uppercase">
              WAITING…
            </span>
          </div>
        </div>
      );
    }

    // Branch C: real choice. B1-styled compact prompt that lives inside the
    // action-bar card. YES (orange, left on desktop) = post the owed blind
    // now. NO (emerald, right on desktop, PRE-SELECTED by default) = wait
    // for BB rotation, no charge. Mobile (<md): YES/NO stack to full width
    // beneath the prompt text via the existing flex-wrap on controlShellClass.
    return (
      <div className={cn(controlShellClass, 'border border-orange/30 bg-orange/[0.04]')}>
        {/* Prompt copy — compacts on desktop so the YES/NO pair dominates the card */}
        <div className="flex flex-col gap-0.5 min-w-0 flex-1 md:flex-none md:max-w-[200px]">
          <Eyebrow>Play this hand?</Eyebrow>
          <span className="font-display text-bone text-[13px] md:text-sm leading-tight min-w-0">
            YES posts {fmtVal(totalOwed)} now · NO waits for BB.
          </span>
        </div>

        {/* B1 choice pair — YES (orange) left, NO (emerald) right.
            Buttons dominate the card: ~50% larger than default action buttons. */}
        <div className="grid grid-cols-2 gap-2 w-full md:w-auto md:ml-auto md:flex md:items-center md:min-w-[340px]">
          <button
            disabled={sittingOutPending}
            onClick={() => { SFX.play('deposit'); onSitIn?.(true); }}
            className={cn(
              'rounded-md border font-mono font-bold transition-all md:flex-1',
              'px-5 md:px-7 py-2.5 md:py-2 min-h-[56px] md:min-h-[52px]',
              'border-orange/50 bg-orange/10 text-orange hover:bg-orange/20 hover:border-orange/70',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            {sittingOutPending
              ? <span className="text-[12px] tracking-[0.22em]">POSTING…</span>
              : (
                <span className="flex flex-col items-center leading-tight gap-1">
                  <span className="text-[15px] md:text-[17px] tracking-[0.26em]">YES</span>
                  <span className="text-[10px] tracking-[0.16em] text-orange/70 normal-case">POST {fmtVal(totalOwed)}</span>
                </span>
              )}
          </button>
          <button
            disabled={sittingOutPending}
            onClick={() => { SFX.play('ui-click'); onSitIn?.(false); }}
            className={cn(
              'rounded-md border font-mono font-bold transition-all md:flex-1',
              'px-5 md:px-7 py-2.5 md:py-2 min-h-[56px] md:min-h-[52px]',
              // NO is the recommended default — outlined ring + slight glow.
              'border-emerald-300/60 bg-emerald-300/15 text-emerald-300 hover:bg-emerald-300/25 hover:border-emerald-300/80 ring-1 ring-emerald-300/30',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <span className="flex flex-col items-center leading-tight gap-1">
              <span className="text-[15px] md:text-[17px] tracking-[0.26em]">NO</span>
              <span className="text-[10px] tracking-[0.16em] text-emerald-300/70 normal-case">WAIT · FREE</span>
            </span>
          </button>
        </div>
      </div>
    );
  }

  if (hasFolded) {
    return (
      <div className={controlShellClass}>
        <Eyebrow>Status</Eyebrow>
        <span className="font-display text-boneDim text-sm">You folded. Waiting for next hand…</span>
        {takeControlButton && <div className="w-full md:w-auto md:ml-auto flex justify-center md:justify-end items-center gap-2 shrink-0">{takeControlButton}</div>}
        {/* SIT OUT NEXT + TOP UP are cash-only (no sit-out toggle / top-up in SNG).
            Top-up is available between hands and while folded — you have no live
            decision, so adding chips here can't collide with an action. */}
        {isCashGame && !takeControlButton && (
          <div className="ml-auto flex items-center gap-2">
            {onOpenTopUp && (
              <button
                className="btn-quiet px-3 py-1.5 rounded-md font-mono text-[11px] tracking-wider"
                onClick={() => { SFX.play('deposit'); onOpenTopUp(); }}
              >
                TOP UP
              </button>
            )}
            <button
              className="btn-quiet px-3 py-1.5 rounded-md font-mono text-[11px] tracking-wider"
              onClick={() => SFX.play('ui-click')}
            >
              SIT OUT NEXT
            </button>
          </div>
        )}
      </div>
    );
  }

  if (!isMyTurn) {
    if (!showPreAction) {
      return (
        <div className={controlShellClass}>
          {heroBarCards}
          <Eyebrow>Status</Eyebrow>
          <span className="font-display text-boneDim text-sm">
            {phase === 'Waiting' || phase === 'Complete' ? 'Waiting for dealer.' : 'Waiting for the next hand.'}
          </span>
          {takeControlButton ? (
            <div className="w-full md:w-auto md:ml-auto flex justify-center md:justify-end items-center gap-2 shrink-0">{takeControlButton}</div>
          ) : isCashGame ? (
            <div className="ml-auto flex items-center gap-2">
              {onOpenTopUp && (
                <button
                  className="btn-quiet px-3 py-1.5 rounded-md font-mono text-[11px] tracking-wider"
                  onClick={() => { SFX.play('deposit'); onOpenTopUp(); }}
                >
                  TOP UP
                </button>
              )}
              <button
                className="btn-quiet px-3 py-1.5 rounded-md font-mono text-[11px] tracking-wider"
                onClick={() => SFX.play('ui-click')}
              >
                SIT OUT NEXT
              </button>
            </div>
          ) : null}
        </div>
      );
    }
    return (
      <div className={controlShellClass}>
        {/* Leading group mirrors the action row (cards → FOLD first) so the
            Check/Fold checkbox lands under the FOLD button — it IS the fold
            pre-action — instead of drifting over to the Call button. The old
            inline "Pre-action" eyebrow pushed the checkboxes right; it now
            lives in the right-side status label below. */}
        <div className="flex items-center gap-2 md:shrink-0 min-w-0">
          {heroBarCards}
          <div className="flex flex-wrap md:flex-nowrap items-center gap-2 md:gap-3 min-w-0">
          {[
            // Facing a bet (no check available), this pre-action can only fold,
            // so label it "Fold" — "Check/Fold" misleads when a check is off the
            // table. The behaviour is identical (check if free, else fold); only
            // the label reflects the current reality.
            { key: 'check-fold' as const, label: canCheck ? 'Check/Fold' : 'Fold' },
            // Auto Check only makes sense when a check is actually available.
            // Facing a bet (e.g. SB preflop vs the BB) a check is impossible, so
            // hide it — otherwise it silently no-ops on your turn into a timeout.
            ...(canCheck ? [{ key: 'check' as const, label: 'Auto Check' }] : []),
            { key: 'call-any' as const, label: 'Call Any' },
          ].map(opt => (
            <label
              key={opt.key}
              className={cn(
                'flex items-center gap-2',
                preActionsDisabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
              )}
            >
              <input
                type="checkbox"
                className="accent-[#F26A1F]"
                disabled={preActionsDisabled}
                checked={preAction === opt.key}
                onChange={() => {
                  if (preActionsDisabled) return;
                  SFX.play('ui-toggle');
                  setPreAction(preAction === opt.key ? null : opt.key);
                }}
              />
              <span className={cn('font-mono text-xs', preAction === opt.key ? 'text-orange' : 'text-boneDim')}>{opt.label}</span>
            </label>
          ))}
          </div>
        </div>
        <div className="ml-auto hidden md:flex items-center gap-2 shrink-0">
          <Eyebrow>Pre-action · {isWaitingForBb ? 'waiting for big blind' : 'waiting for turn'}</Eyebrow>
        </div>
        {takeControlButton && <div className="w-full md:w-auto md:ml-auto flex justify-center md:justify-end items-center gap-2 shrink-0">{takeControlButton}</div>}
      </div>
    );
  }

  // Fill % of the raise track. When the big blind has escalated past the stack
  // (SNG) there's no raise range — minRaise >= maxRaise and the only move is
  // all-in. Guard the division and clamp to [0,100] so the bar renders full
  // (all-in) instead of going negative and painting an empty/hatched track.
  const pct = maxRaise > minRaise
    ? Math.max(0, Math.min(100, ((raiseAmt - minRaise) / (maxRaise - minRaise)) * 100))
    : 100;
  // The range input needs min <= max; when minRaise exceeds maxRaise collapse it
  // to a single point at the all-in amount.
  const sliderMin = Math.min(minRaise, maxRaise);

  // User-customizable preset list. Each entry is a % of pot.
  //   canCheck:  base = current pot
  //   !canCheck: base = pot + callAmount*2 (post-call pot, as if both call)
  // ALL-IN always pinned at the end. MIN pinned at the start when facing a
  // bet (contractual min-raise the user often clicks).
  type QuickBet = { label: string; v: number; accent?: boolean };
  const presetBase = canCheck ? pot : pot + callAmount * 2;
  const presetButtons: QuickBet[] = cardPrefs.betPresets.map(p =>
    p.kind === 'bb'
      ? { label: `${p.value}BB`, v: Math.round(p.value * bigBlind) }
      : { label: p.value === 100 ? 'POT' : `${p.value}%`, v: Math.round((presetBase * p.value) / 100) },
  );
  const quickBets: QuickBet[] = canCheck
    ? [...presetButtons, { label: 'ALL-IN', v: maxRaise, accent: true }]
    : [
        { label: 'MIN', v: minRaise },
        ...presetButtons,
        { label: 'ALL-IN', v: maxRaise, accent: true },
      ];

  return (
    <div className={cn(
      controlShellClass,
      // Mobile: stack (action row on top, bet sizer below). Desktop: single row
      // (buttons + sizer side by side) so it fits the fixed-height control bar
      // instead of overflowing/clipping.
      'flex-col md:flex-row !flex-nowrap items-stretch md:items-center gap-2 md:gap-3',
      actionPending && 'pointer-events-none'
    )}>
      {/* CONFIRMING TX is an absolute overlay, never an inline row — so it can
          never reflow the bar. The controls stay exactly in place underneath,
          dimmed by the overlay's translucent backdrop. */}
      {actionPending && (
        <div className="absolute inset-0 z-40 flex items-center justify-center rounded-[inherit] bg-ink/70 backdrop-blur-[1px] text-xs text-amber animate-pulse font-mono tracking-[0.2em]">
          CONFIRMING TX...
        </div>
      )}

      {/* Primary actions — equal-width row; in-bar hole cards sit to the left. */}
      <div className="flex items-stretch gap-2 md:shrink-0">
      {/* TIME BANK — engage +15s on your turn (mirrors the on-chain
          use_time_bank gate). Rendered IN-FLOW as the first item in the action
          row so the bar's overflow-hidden can never clip it (the old absolute
          -top pill was getting cut off on mobile). */}
      {isMyTurn && !isShowdown && !hasFolded && (
        timeBankActive ? (
          <span className="flex-none flex flex-col items-center justify-center px-2 rounded-md bg-amber/15 border border-amber/40 font-mono leading-tight text-amber whitespace-nowrap">
            <span className="text-[10px] font-bold tracking-[0.08em]">+15s ON</span>
            <span className="text-[7px] tracking-[0.14em] opacity-70">{Math.floor(timeBankSecs)}s LEFT</span>
          </span>
        ) : Math.floor(timeBankSecs) >= TIME_BANK_CHUNK_SECONDS ? (
          <button
            type="button"
            onClick={() => { SFX.play('ui-tap'); onAction?.('use_time_bank'); }}
            disabled={actionPending}
            title={`Add ${TIME_BANK_CHUNK_SECONDS}s to your timer (${Math.floor(timeBankSecs)}s banked total)`}
            className={cn(
              'flex-none flex flex-col items-center justify-center px-2 rounded-md border font-mono leading-tight whitespace-nowrap transition-all',
              (timeLeft ?? 99) <= 8
                ? 'bg-amber/20 border-amber/70 text-amber animate-pulse shadow-[0_0_10px_rgba(244,165,42,0.3)]'
                : 'bg-amber/[0.06] border-amber/30 text-amber/80 hover:bg-amber/15 hover:border-amber/60 hover:text-amber'
            )}
          >
            <span className="text-[10px] font-bold tracking-[0.08em]">+{TIME_BANK_CHUNK_SECONDS}s</span>
            <span className="text-[7px] tracking-[0.14em] opacity-70">{Math.floor(timeBankSecs)}s BANK</span>
          </button>
        ) : null
      )}
      {heroBarCards}
      {/* Fold */}
      <button
        data-testid="action-fold"
        className="electric-btn electric-btn--fold flex-1 md:flex-none md:min-w-[88px] lg:min-w-[112px] min-w-0"
        onClick={() => { SFX.play('fold'); onAction?.('fold'); }}
        disabled={actionPending}
      >
        <span>FOLD</span>
        <svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" aria-hidden="true">
          <path d="M6 0 1 7.5h3.5L3 13 9 5.5H5.5L6 0Z" />
        </svg>
      </button>

      {/* Check / Call */}
      {canCheck ? (
        <button
          data-testid="action-check"
          className="electric-btn electric-btn--call flex-1 md:flex-none md:min-w-[88px] lg:min-w-[112px] min-w-0"
          onClick={() => { SFX.play('check'); onAction?.('check'); }}
          disabled={actionPending}
        >
          <span>CHECK</span>
          <svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" aria-hidden="true">
            <path d="M6 0 1 7.5h3.5L3 13 9 5.5H5.5L6 0Z" />
          </svg>
        </button>
      ) : (
        <button
          data-testid="action-call"
          className="electric-btn electric-btn--call flex-1 md:flex-none md:min-w-[88px] lg:min-w-[112px] min-w-0"
          onClick={() => { SFX.play('call'); onAction?.('call', callAmount); }}
          disabled={actionPending}
        >
          <span>CALL <span className="tabular-nums opacity-80">{fmtVal(callAmount)}</span></span>
          <svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" aria-hidden="true">
            <path d="M6 0 1 7.5h3.5L3 13 9 5.5H5.5L6 0Z" />
          </svg>
        </button>
      )}

      {/* Raise */}
      {raiseAvailable && (
        <button
          data-testid="action-raise"
          className="electric-btn electric-btn--raise flex-1 md:flex-none md:min-w-[88px] lg:min-w-[112px] min-w-0"
          onClick={() => {
            const isAllIn = raiseAmt >= maxRaise;
            // When all-in amount is at or below what's needed to call, treat as a call
            // (all-in for less) so the chain sees a proper call action.
            if (isAllIn && !canCheck && (!raiseAvailable || maxRaise <= callAmount)) {
              SFX.play('all-in');
              onAction?.('call', callAmount);
            } else if (isAllIn) {
              SFX.play('all-in');
              onAction?.('allin');
            } else {
              SFX.play('raise');
              // Contract gate (post-`be4e79b3` hardening):
              //   process_bet requires table.min_bet == 0
              //     (player_action.rs:686)
              //   process_raise requires current_bet > 0
              //     (player_action.rs:707)
              // The right discriminator is `currentBet`, NOT `canCheck`.
              // canCheck is true in TWO distinct cases:
              //   1) no bet yet this round (post-flop open) → use 'bet'
              //   2) already matched the live bet (e.g. BB pre-flop after
              //      SB calls — min_bet > 0 but callAmount == 0) → use 'raise'
              // Routing on canCheck breaks case (2). Route on currentBet.
              onAction?.(currentBet === 0 ? 'bet' : 'raise', raiseAmt);
            }
          }}
          disabled={((raiseAmt < minRaise) && (raiseAmt !== maxRaise)) || actionPending}
        >
          <span>{raiseAmt >= maxRaise ? 'ALL-IN' : (canCheck ? 'BET' : 'RAISE')}</span>
          <svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" aria-hidden="true">
            <path d="M6 0 1 7.5h3.5L3 13 9 5.5H5.5L6 0Z" />
          </svg>
        </button>
      )}
      </div>

      {/* Bet sizer — the amount is the focal value; the slider is a small rail.
          Mobile: stacked column. Desktop: lays out in a single row to fit the bar. */}
      {raiseAvailable && (
        <div className="w-full md:flex-1 min-w-0 glass-sub rounded-lg px-3 py-2 flex flex-col md:flex-row md:items-center gap-2">
          {/* Amount (focal) + − / + steppers + turn timer */}
          <div className="flex items-end justify-between md:justify-start gap-3 md:shrink-0">
            {/* Fixed-width on desktop so the ch-sized value can't reflow and shove
                the slider as you drag (the "collides / changes placement" bug). */}
            <div className="flex flex-col gap-0.5 min-w-0 md:w-[118px] md:shrink-0">
              <Eyebrow>{canCheck ? 'Bet ✎' : 'Raise to ✎'}</Eyebrow>
              <input
                type="text"
                inputMode="decimal"
                value={betDraft ?? fmtVal(raiseAmt)}
                onFocus={e => { setBetDraft(fmtVal(raiseAmt)); e.currentTarget.select(); }}
                onChange={e => setBetDraft(e.currentTarget.value)}
                onBlur={e => commitBetDraft(e.currentTarget.value)}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setBetDraft(null); e.currentTarget.blur(); } }}
                aria-label={canCheck ? 'Bet amount' : 'Raise amount'}
                title="Tap to type a custom amount"
                // Dashed underline (solid on focus) + branded selection so it
                // reads as an editable field, not static text — players were
                // missing that they can type the amount.
                className="bg-transparent outline-none p-0 m-0 pb-0.5 border-t-0 border-x-0 border-b-2 border-dashed border-orange/45 hover:border-orange/70 focus:border-solid focus:border-orange font-display text-gold font-bold text-2xl tabular-nums leading-none caret-orange cursor-text selection:bg-orange/40 selection:text-bone"
                style={{ width: `${Math.max(3, String(betDraft ?? fmtVal(raiseAmt)).length + 1)}ch` }}
              />
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                aria-label="Decrease bet"
                onClick={() => { setRaiseAmt(Math.max(sliderMin, Math.min(maxRaise, raiseAmt - bigBlind))); SFX.play('ui-tap'); }}
                disabled={actionPending || raiseAmt <= sliderMin}
                className="w-9 h-9 rounded-md border border-gold/30 bg-gold/5 text-gold text-xl font-bold leading-none flex items-center justify-center hover:bg-gold/15 hover:border-gold/50 active:scale-95 transition disabled:opacity-30 disabled:pointer-events-none"
              >−</button>
              <button
                type="button"
                aria-label="Increase bet"
                onClick={() => { setRaiseAmt(Math.max(sliderMin, Math.min(maxRaise, raiseAmt + bigBlind))); SFX.play('ui-tap'); }}
                disabled={actionPending || raiseAmt >= maxRaise}
                className="w-9 h-9 rounded-md border border-gold/30 bg-gold/5 text-gold text-xl font-bold leading-none flex items-center justify-center hover:bg-gold/15 hover:border-gold/50 active:scale-95 transition disabled:opacity-30 disabled:pointer-events-none"
              >+</button>
              {/* Turn countdown lives on the hero's nameplate (depleting border)
                  now — no redundant ring here (it overflowed the bar + double-
                  animated). */}
            </div>
          </div>

          {/* Slider — MOBILE ONLY. On the stacked mobile layout it's a usable
              full-width rail. On the desktop single row it shrank to a useless
              sliver between the steppers and presets, so it's dropped there
              (md:hidden): the − / + steppers, preset chips, and the tap-to-type
              amount field cover sizing without it. */}
          <div className="w-full md:hidden" style={{ position: 'relative', height: 20 }}>
            <div style={{ position: 'absolute', top: 7, left: 0, right: 0, height: 6, borderRadius: 9999, background: 'rgba(245,241,230,0.13)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.45)' }} />
            {pct < 100 && (
              <div aria-hidden style={{ position: 'absolute', top: 7, left: `${pct}%`, right: 0, height: 6, borderRadius: '0 9999px 9999px 0', background: 'repeating-linear-gradient(45deg, rgba(245,241,230,0.10) 0px, rgba(245,241,230,0.10) 2px, transparent 2px, transparent 6px)', pointerEvents: 'none' }} />
            )}
            <div style={{ position: 'absolute', top: 7, left: 0, width: `${pct}%`, height: 6, borderRadius: '9999px 0 0 9999px', background: '#F26A1F', boxShadow: '0 0 8px rgba(242,106,31,0.55)', transition: 'width 0.1s ease' }} />
            <div style={{ position: 'absolute', top: 2, left: `calc(${pct}% - ${(pct / 100) * 16}px)`, width: 16, height: 16, borderRadius: '50%', background: '#F26A1F', border: '2px solid rgba(245,241,230,0.95)', boxShadow: '0 0 0 1.5px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4), 0 0 12px rgba(242,106,31,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'left 0.1s ease', zIndex: 1 }}>
              <div style={{ display: 'flex', gap: 1.5, pointerEvents: 'none' }}>
                <div style={{ width: 1, height: 5, borderRadius: 9999, background: 'rgba(245,241,230,0.9)' }} />
                <div style={{ width: 1, height: 5, borderRadius: 9999, background: 'rgba(245,241,230,0.9)' }} />
                <div style={{ width: 1, height: 5, borderRadius: 9999, background: 'rgba(245,241,230,0.9)' }} />
              </div>
            </div>
            <input
              type="range"
              min={sliderMin}
              max={maxRaise}
              step={bigBlind}
              value={raiseAmt}
              onChange={e => {
                const raw = parseInt(e.target.value);
                // Snap the final BB step up to the true max so dragging right
                // always reaches all-in instead of capping ~1% short.
                setRaiseAmt(raw > maxRaise - bigBlind ? maxRaise : raw);
                SFX.play('ui-slider');
              }}
              aria-label={canCheck ? 'Bet amount' : 'Raise amount'}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'grab', zIndex: 2, margin: 0 }}
            />
          </div>

          {/* Preset chips — equal-width row on mobile; on desktop natural width
              but allowed to SHRINK so the row (incl. ALL-IN) stays on a single
              line at cramped mid widths instead of being clipped off the right
              by the fixed-height, overflow-hidden control shell. */}
          <div className="flex gap-0.5 min-w-0 md:flex-1">
            {quickBets.map(q => (
              <button
                key={q.label}
                className={cn(
                  'flex-1 min-w-0 overflow-hidden px-0.5 md:px-1 py-1.5 rounded-md font-mono text-[9px] tracking-tight border transition whitespace-nowrap text-center',
                  q.accent
                    ? 'bg-gold/15 border-gold/50 text-gold hover:bg-gold/25'
                    : 'bg-transparent border-gold/15 text-boneDim hover:border-gold/40 hover:text-bone',
                )}
                onClick={() => { setRaiseAmt(Math.min(Math.max(q.v, minRaise), maxRaise)); SFX.play('ui-tap'); }}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  SngStandings — log.jsx 1:1
// ═══════════════════════════════════════════════════════════════════════════

// SNG blind schedule — mirror of programs/fastpoker/src/constants.rs
// (SNG_BLIND_INTERVAL_SECONDS + SNG_BLIND_LEVELS). Keep in lockstep. Blinds step
// every 5 min off tournament_start (stored as a unix timestamp on-chain).
const SNG_BLIND_INTERVAL_SECONDS = 300;
const SNG_BLIND_LEVELS: [number, number][] = [
  [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300],
  [200, 400], [300, 600], [500, 1000], [750, 1500], [1000, 2000], [1250, 2500],
  [1500, 3000], [2000, 4000], [2500, 5000], [3000, 6000], [4000, 8000],
  [5000, 10000], [7000, 14000],
];

// Live "Next blinds in MM:SS" countdown for SNG tables. Null until the
// tournament clock starts (first hand sets tournament_start on-chain).
// Duel pause (Flat Bounty): a live duel PAUSES the tournament clock on-chain and
// tournament_start shifts forward by the pause duration at resolve. `pausedAtTs`
// is the on-chain pause stamp (sidecar duel_pause_started_ts): while set, elapsed
// is computed AT the stamp, so the display freezes at the exact on-chain moment
// regardless of how late the poll noticed. After resolve, elapsed resumes from
// that same value once the shifted start arrives; the continuity clamp bridges
// the window where the pause has cleared but the stale start hasn't refreshed.
function NextBlindsTimer({ tournamentStartTime, pausedAtTs = null }: { tournamentStartTime?: number; pausedAtTs?: number | null }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const elapsedFloorRef = useRef(0);
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  if (!tournamentStartTime) return null;
  const frozen = pausedAtTs != null && pausedAtTs > 0;
  const rawElapsed = Math.max(0, (frozen ? Math.min(pausedAtTs, now) : now) - tournamentStartTime);
  // Elapsed is monotonic within one game (pauses only shift the start forward), so a
  // large regression means the table was reused for a new game - reset the floor.
  if (rawElapsed + 120 < elapsedFloorRef.current) elapsedFloorRef.current = 0;
  const elapsed = Math.max(rawElapsed, elapsedFloorRef.current);
  elapsedFloorRef.current = elapsed;
  const maxIdx = SNG_BLIND_LEVELS.length - 1;
  const levelIdx = Math.min(Math.floor(elapsed / SNG_BLIND_INTERVAL_SECONDS), maxIdx);
  const atMax = levelIdx >= maxIdx;
  const secs = atMax ? 0 : SNG_BLIND_INTERVAL_SECONDS - (elapsed % SNG_BLIND_INTERVAL_SECONDS);
  const next = SNG_BLIND_LEVELS[Math.min(levelIdx + 1, maxIdx)];
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <div className="px-3 py-2 hairline-b flex items-center justify-between">
      <span className="font-mono text-[9px] text-orange/70 tracking-[0.2em] uppercase">Next Blinds</span>
      {atMax ? (
        <span className="font-mono text-[10px] text-boneDim tracking-wider">Final level</span>
      ) : frozen ? (
        <span className="font-mono text-[10px] tabular-nums">
          <span className="text-bone">{next[0]}/{next[1]}</span>
          <span className="text-boneDim"> in </span>
          <span className="text-bone/60">{mmss}</span>
          <span className="ml-1.5 rounded-full border border-amber/40 bg-amber/10 px-1.5 py-px text-[8px] uppercase tracking-[0.16em] text-amber">paused &middot; duel</span>
        </span>
      ) : (
        <span className="font-mono text-[10px] text-bone tabular-nums">
          {next[0]}/{next[1]}
          <span className="text-boneDim"> in </span>
          <span className={cn('tabular-nums', secs <= 30 ? 'text-orange' : 'text-bone')}>{mmss}</span>
        </span>
      )}
    </div>
  );
}

/** SnG Duels right-rail data (pool/buy-in header + per-seat collected bounties + live duel). */
interface BountyRailData {
  potFp: number;
  potSol: number;
  /** $FP pool at the CURRENT maturity - what the rows project today; grows each level to potFp. */
  potFpMatured: number;
  maturityPct: number;
  buyInSol: number;
  /** True once the on-chain jackpot snapshot funded (potFp is then the exact pool, not an estimate). */
  potFpFunded: boolean;
  /** Current emission-governor rate in bps (null if EmissionCtrl unreadable). */
  emissionRateBps: number | null;
  seatKo: Record<number, number>;
  seatFp: Record<number, number>;
  seatSol: Record<number, number>;
  /** Flat Bounty ruleset marker (always 1 on duel sidecars). */
  ruleset?: number;
  /** Busted seats -> blind level they busted at. Standings keep showing them (who got what). */
  seatEliminated: Record<number, number>;
  /** Latched hero seat (survives the hero busting) so their rows/bank keep rendering. */
  heroSeat: number | null;
  duel: { round: number; seatA: number; seatB: number } | null;
  /** On-chain blind-clock pause stamp (unix s); nonzero while a duel holds the clock. */
  duelPausedAtTs: number | null;
}

function SngStandings({ players, blinds, isCashGame, myPubkey, totalPlayers, itmCount, tournamentStartTime, bountyRail }: {
  players: Player[];
  blinds: { small: number; big: number };
  isCashGame: boolean;
  myPubkey?: string;
  totalPlayers?: number;
  itmCount?: number;
  tournamentStartTime?: number;
  bountyRail?: BountyRailData;
}) {
  if (isCashGame) return null;
  // SNG: TOURNAMENT standings, not hand standings. Busted/Empty seats are already
  // filtered out of `players` upstream, so EVERY remaining entry is still in the
  // tournament - including seats that folded THIS hand (folded => !isActive, which the
  // old isActive||isSittingOut filter wrongly dropped: "STANDINGS 5/9" mid-hand with 9
  // alive, live finding 2026-07-03). (SNG-only - cash returns null above.)
  const alive = [...players].sort((a, b) => b.chips - a.chips);
  // Bounty tables keep the standings up even with no alive seats visible (busted hero watching along).
  if (alive.length === 0 && !bountyRail) return null;
  // Busted seats stay listed on bounty tables: who collected what matters. Latest bust first.
  const busted = bountyRail
    ? Object.entries(bountyRail.seatEliminated)
        .map(([s, lvl]) => ({ seat: Number(s), lvl }))
        .filter(({ seat }) => !alive.some(p => p.seatIndex === seat))
        .sort((a, b) => b.lvl - a.lvl)
    : [];
  const total = totalPlayers ?? players.length;
  const playersLeft = alive.length;
  const itm = itmCount ?? (total <= 2 ? 1 : total <= 6 ? 2 : 3);
  const shieldMode = (bountyRail?.ruleset ?? 0) === 1;
  const bountyUnitLabel = (n: number) => shieldMode ? `${formatPoints(n)} pt${n === 1 ? '' : 's'}` : `×${n}`;

  return (
    <div className="hairline-b">
      {/* SnG Duels: pools + buy-in header. BOUNTY POOL = all $FP (pure bounty) + the SOL bounty
          half; ITM POOL = the SOL finish half.
          Tightened 2026-07-03 (user crop): every label is ONE line on a shared baseline - the
          governor estimate no longer wraps the first label to two lines and shoves its value
          off-baseline. SOL values all render 2 decimals (0.10, not 0.1). */}
      {bountyRail && (
        <div className="px-3 py-2 hairline-b grid grid-cols-3 gap-2" data-format="bounty">
          <div className="flex flex-col leading-none">
            <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-[8px] uppercase tracking-widest text-amber/60">
              Bounty pool
              {/* Governed emission estimate (`~` = pre-funding). Micro-pill, not label text. */}
              {bountyRail.emissionRateBps != null && !bountyRail.potFpFunded && (
                <span
                  className="rounded-full border border-white/10 bg-white/[0.04] px-1 py-px text-[7px] tracking-[0.08em] text-bone/45"
                  title={`$FP figure is an estimate at the current ${Math.round(bountyRail.emissionRateBps / 100)}% emission rate; exact once funded`}
                >
                  ~{Math.round(bountyRail.emissionRateBps / 100)}%
                </span>
              )}
              {/* Maturity: the $FP value shown is the CURRENT matured pool - the same basis as
                  the per-seat rows - growing each blind level toward the full pool. */}
              {bountyRail.maturityPct < 100 && (
                <span
                  className="rounded-full border border-amber/25 bg-amber/[0.06] px-1 py-px text-[7px] tracking-[0.08em] text-amber/70"
                  title={`$FP shown at the current ${bountyRail.maturityPct}% maturity; grows each blind level to ${bountyRail.potFp.toLocaleString(undefined, { maximumFractionDigits: 0 })} at 100%`}
                >
                  {bountyRail.maturityPct}% mat
                </span>
              )}
            </span>
            <span className="mt-1 inline-flex items-baseline gap-1.5">
              <span className="inline-flex items-baseline gap-0.5 font-display text-[13px] tabular-nums text-gold">
                {bountyRail.potFpMatured.toLocaleString(undefined, { maximumFractionDigits: 0 })}<TokenMark t="fp" size={10} />
              </span>
              <span className="inline-flex items-baseline gap-0.5 font-display text-[13px] tabular-nums text-emerald-400">
                {(bountyRail.potSol * SOL_BOUNTY_BPS / 10_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<TokenMark t="sol" size={10} />
              </span>
            </span>
          </div>
          <div className="flex flex-col items-center leading-none">
            <span className="whitespace-nowrap font-mono text-[8px] uppercase tracking-widest text-bone/45">ITM pool</span>
            <span className="mt-1 inline-flex items-baseline gap-0.5 font-display text-[13px] tabular-nums text-emerald-400">
              {(bountyRail.potSol * (10_000 - SOL_BOUNTY_BPS) / 10_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<TokenMark t="sol" size={10} />
            </span>
          </div>
          <div className="flex flex-col items-end leading-none">
            <span className="whitespace-nowrap font-mono text-[8px] uppercase tracking-widest text-bone/45">Buy-in</span>
            <span className="mt-1 inline-flex items-baseline gap-0.5 font-display text-[13px] tabular-nums text-bone">
              {bountyRail.buyInSol.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<TokenMark t="sol" size={10} />
            </span>
          </div>
        </div>
      )}
      <NextBlindsTimer
        tournamentStartTime={tournamentStartTime}
        pausedAtTs={bountyRail?.duelPausedAtTs ?? null}
      />
      <div className="px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Eyebrow>Standings</Eyebrow>
          <span className="font-mono text-[10px] text-boneDim">{playersLeft}/{total}</span>
        </div>
        <span className="font-mono text-[9px] text-gold/70 tracking-wider">PAY TOP {itm}</span>
      </div>
      <div className="px-3 pb-2 max-h-[168px] overflow-y-auto space-y-0.5">
        {alive.map((p, i) => {
          const place = i + 1;
          const isHero = myPubkey ? p.pubkey === myPubkey : false;
          const inTheMoney = place <= itm;
          const onBubble = !inTheMoney && place === itm + 1;
          const suffix = place === 1 ? 'st' : place === 2 ? 'nd' : place === 3 ? 'rd' : 'th';
          const bb = blinds.big > 0 ? Math.round(p.chips / blinds.big) : 0;
          return (
            <div key={p.seatIndex} className={cn(
              'flex items-center gap-2 px-1.5 py-[3px] rounded-sm font-mono text-[10px]',
              isHero ? 'bg-gold/10 border border-gold/30' : 'hover:bg-bone/[0.02]'
            )}>
              <span className={cn('w-5 tabular-nums font-bold',
                place === 1 ? 'text-gold' : place === 2 ? 'text-bone' : place === 3 ? 'text-amber/80' : 'text-boneDim/70'
              )}>
                {place}{suffix}
              </span>
              <span className={cn('flex-1 truncate', isHero ? 'text-gold' : 'text-bone/90')}>
                {isHero ? 'You' : shortWallet(p.pubkey)}
                {bountyRail?.duel && (p.seatIndex === bountyRail.duel.seatA || p.seatIndex === bountyRail.duel.seatB) && (
                  <span className="ml-1 text-amber animate-pulse">&#9670;</span>
                )}
              </span>
              {bountyRail && (bountyRail.seatKo[p.seatIndex] ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1 shrink-0" data-format="bounty">
                  <span className="tabular-nums text-amber">{bountyUnitLabel(bountyRail.seatKo[p.seatIndex])}</span>
                  <span className="inline-flex items-baseline gap-0.5 tabular-nums text-gold/90">
                    {(bountyRail.seatFp[p.seatIndex] ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}<TokenMark t="fp" size={9} />
                  </span>
                  <span className="inline-flex items-baseline gap-0.5 tabular-nums text-emerald-400/90">
                    {(bountyRail.seatSol[p.seatIndex] ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}<TokenMark t="sol" size={9} />
                  </span>
                </span>
              )}
              {inTheMoney && <span className="font-mono text-[8px] tracking-[0.2em] text-gold/80">ITM</span>}
              {onBubble && <span className="font-mono text-[8px] tracking-[0.2em] text-orange/80">BUB</span>}
              <span className={cn('tabular-nums', isHero ? 'text-bone' : 'text-boneDim')}>{bb}bb</span>
            </div>
          );
        })}
        {busted.map(({ seat, lvl }) => {
          const isHero = bountyRail?.heroSeat === seat;
          const p = players.find(pl => pl.seatIndex === seat);
          const pk = p?.pubkey && !p.pubkey.startsWith('seat-') ? p.pubkey : rememberedSeatPubkey(seat);
          const name = isHero ? 'You' : pk ? shortWallet(pk) : `Seat ${seat + 1}`;
          const ko = bountyRail?.seatKo[seat] ?? 0;
          return (
            <div key={`out-${seat}`} className={cn(
              'flex items-center gap-2 px-1.5 py-[3px] rounded-sm font-mono text-[10px]',
              isHero ? 'bg-gold/10 border border-gold/30 opacity-80' : 'opacity-45'
            )} data-format="bounty">
              <span className="w-5 font-bold text-boneDim/50">—</span>
              <span className={cn('flex-1 truncate', isHero ? 'text-gold' : 'text-bone/80')}>{name}</span>
              {ko > 0 && (
                <span className="inline-flex items-center gap-1 shrink-0">
                  <span className="tabular-nums text-amber">{bountyUnitLabel(ko)}</span>
                  <span className="inline-flex items-baseline gap-0.5 tabular-nums text-gold/90">
                    {(bountyRail?.seatFp[seat] ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}<TokenMark t="fp" size={9} />
                  </span>
                  <span className="inline-flex items-baseline gap-0.5 tabular-nums text-emerald-400/90">
                    {(bountyRail?.seatSol[seat] ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}<TokenMark t="sol" size={9} />
                  </span>
                </span>
              )}
              {/* 1-based level display, matching the HUD (on-chain elimination_level is 0-based) */}
              <span className="font-mono text-[8px] tracking-[0.15em] text-boneDim/60">OUT L{lvl + 1}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  ActionLog — log.jsx 1:1
// ═══════════════════════════════════════════════════════════════════════════

function LogRow({ entry }: { entry: HandAction }) {
  const colorByAction = (text: string) => {
    if (text.includes('FOLD') || text === 'folded') return 'text-[#c94c4c]/80';
    if (text.includes('WIN') || text.includes('WON')) return 'text-gold';
    if (text.includes('RAISE') || text.includes('ALL-IN') || text.includes('bet')) return 'text-gold';
    if (text.includes('CALL')) return 'text-boneDim';
    if (text.includes('CHECK')) return 'text-boneDim';
    if (text.startsWith('Board:')) return 'text-bone';
    if (entry.phase === 'Summary' || entry.phase === 'Result') return 'text-bone';
    return 'text-boneDim';
  };
  return (
    <div className="flex items-start gap-2 font-mono text-[11px] leading-snug">
      <span className="text-boneDim/40 tabular-nums shrink-0 pt-[1px] text-[9px]">
        {entry.phase?.slice(0, 3).toUpperCase()}
      </span>
      <span className={cn('flex-1', colorByAction(entry.action))}>
        {entry.player ? `${entry.player}: ` : ''}{entry.action}
      </span>
    </div>
  );
}

/** Click-to-copy table address for the bounty rail header. */
function CopyableTableId({ short, full }: { short: string; full: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        SFX.play('ui-tap');
        navigator.clipboard?.writeText(full).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={cn('font-mono text-[9px] truncate min-w-0 transition-colors', copied ? 'text-amber' : 'text-boneDim/60 hover:text-bone')}
      title="Copy table address"
    >
      {copied ? 'copied ✓' : short}
    </button>
  );
}

function ActionLog({
  entries, handNumber, tablePda, pastHands, viewingPastHand, onHandNav,
  verifyUrl, handLogRef, sngPlayers, blinds, isCashGame, myPubkey,
  totalPlayers, itmCount, tournamentStartTime, onCollapse, bountyRail,
}: {
  entries: HandAction[];
  handNumber: number;
  tablePda: string;
  pastHands: HandAction[][];
  viewingPastHand: number | null;
  onHandNav?: (idx: number | null) => void;
  verifyUrl?: string | null;
  /** Collapse the whole rail (desktop multi-tabling). */
  onCollapse?: () => void;
  handLogRef: React.RefObject<HTMLDivElement | null>;
  sngPlayers?: Player[];
  blinds?: { small: number; big: number };
  isCashGame?: boolean;
  myPubkey?: string;
  totalPlayers?: number;
  itmCount?: number;
  tournamentStartTime?: number;
  bountyRail?: BountyRailData;
}) {
  const isViewingPast = viewingPastHand !== null;
  const viewedHand = isViewingPast ? (pastHands[viewingPastHand] || []) : entries;
  const totalPast = pastHands.length;
  const tablePdaShort = tablePda ? `${tablePda.slice(0, 8)}…${tablePda.slice(-4)}` : '';

  return (
    // SnG Duels rail gets the mock's black card style; other tables keep the glass-room chrome.
    <div className={cn('h-full flex flex-col', bountyRail ? 'rounded-xl border border-white/10 bg-black/40 overflow-hidden' : 'glass-room')}>
      <div className="px-3 py-2 hairline-b flex items-center justify-between gap-2">
        {/* Compact one-line hand + table id on the bounty rail (was a stacked two-line block). */}
        <div className={cn('min-w-0', bountyRail ? 'flex items-center gap-2 whitespace-nowrap' : 'flex flex-col gap-1')}>
          <div className="flex items-center gap-1.5">
            <Eyebrow>Hand</Eyebrow>
            <span className="font-display text-bone text-sm leading-none">
              #{viewingPastHand !== null
                ? Math.max(0, (handNumber || 0) - (pastHands.length - viewingPastHand))
                : (handNumber || 0)}
            </span>
          </div>
          {tablePdaShort && (bountyRail
            ? <CopyableTableId short={tablePdaShort} full={tablePda} />
            : <TxPill id={tablePdaShort} label="table" />)}
        </div>
        <div className="flex items-center gap-1 shrink-0 self-start">
          {totalPast > 0 && (
            <>
              <button
                className="btn-quiet px-1.5 py-0.5 rounded-sm font-mono text-[9px]"
                onClick={() => {
                  SFX.play('ui-tap');
                  if (isViewingPast && viewingPastHand! > 0) onHandNav?.(viewingPastHand! - 1);
                  else if (!isViewingPast && totalPast > 0) onHandNav?.(totalPast - 1);
                }}
                disabled={isViewingPast && viewingPastHand === 0}
              >
                ‹
              </button>
              <button
                className="btn-quiet px-1.5 py-0.5 rounded-sm font-mono text-[9px]"
                onClick={() => {
                  SFX.play('ui-tap');
                  if (isViewingPast) {
                    if (viewingPastHand! < totalPast - 1) onHandNav?.(viewingPastHand! + 1);
                    else onHandNav?.(null);
                  }
                }}
                disabled={!isViewingPast}
              >
                ›
              </button>
            </>
          )}
          {/* Collapse the rail — desktop multi-tabling. The re-open tab lives on
              the table's right edge. */}
          {onCollapse && (
            <button
              onClick={() => { SFX.play('ui-tap'); onCollapse(); }}
              className="hidden md:flex btn-quiet w-6 h-6 items-center justify-center rounded-sm font-mono text-xs text-boneDim/60 hover:text-bone"
              title="Hide hand log (multi-table)"
              aria-label="Hide hand log"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {!isCashGame && sngPlayers && blinds && (
        <SngStandings
          players={sngPlayers}
          blinds={blinds}
          isCashGame={!!isCashGame}
          myPubkey={myPubkey}
          totalPlayers={totalPlayers}
          itmCount={itmCount}
          tournamentStartTime={tournamentStartTime}
          bountyRail={bountyRail}
        />
      )}

      <div ref={handLogRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5 min-h-0">
        {/* SnG Duels: live duel pinned as a system message at the top of the log. */}
        {!isViewingPast && bountyRail?.duel && (() => {
          const nameFor = (s: number) => {
            const p = sngPlayers?.find((pl) => pl.seatIndex === s);
            if (p) return p.pubkey === myPubkey ? 'You' : shortWallet(p.pubkey);
            const pk = rememberedSeatPubkey(s);
            return pk ? shortWallet(pk) : `Seat ${s}`;
          };
          return (
            <div className="flex items-center gap-1.5 rounded-sm bg-amber/10 border border-amber/25 px-2 py-1 font-mono text-[10px]" data-format="bounty">
              <span className="text-amber">&#9876;</span>
              <span className="font-display uppercase tracking-wider text-amber">Duel</span>
              <span className="text-bone/70 tabular-nums">R{bountyRail.duel.round}/3</span>
              <span className="truncate text-bone/60">
                {nameFor(bountyRail.duel.seatA)} vs {nameFor(bountyRail.duel.seatB)}
              </span>
            </div>
          );
        })()}
        {viewedHand.length === 0 ? (
          <div className="text-boneDim/30 font-mono text-[10px] text-center pt-4">No actions yet</div>
        ) : (
          viewedHand.map((e, i) => <LogRow key={i} entry={e} />)
        )}
      </div>

      <div className="hairline-t px-3 py-2 flex items-center justify-between gap-2">
        {(() => {
          const verifyHand = Math.max(0, (viewingPastHand !== null ? handNumber - (pastHands.length - viewingPastHand) : handNumber - 1));
          const fallback = tablePda && verifyHand > 0 ? `/verify?table=${tablePda}&hand=${verifyHand}` : null;
          const href = verifyUrl || fallback;
          if (!href) {
            return <span className="font-mono text-[10px] text-boneDim/30">Hand #{handNumber || 0}</span>;
          }
          return (
            <a
              href={href} target="_blank" rel="noopener noreferrer"
              onClick={() => SFX.play('ui-click')}
              className="flex items-center gap-1.5 hover:text-bone group"
              title="Open the public verification page for this hand"
            >
              <svg className="w-3 h-3 text-amber group-hover:scale-110 transition shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8 1.5 2.5 3.5v3.8c0 3.4 2.3 6.3 5.5 7.2 3.2-.9 5.5-3.8 5.5-7.2V3.5L8 1.5Z" />
                <path d="m5.5 8 1.8 1.8L11 6" />
              </svg>
              <span className="font-mono text-[10px] text-amber tracking-wider group-hover:underline underline-offset-2">VERIFY HAND</span>
              <span className="font-mono text-[9px] text-boneDim/40">↗</span>
            </a>
          );
        })()}
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400/80" />
          <span className="font-mono text-[10px] text-boneDim tracking-wider">VRF · TEE</span>
          <span className="font-mono text-[10px] text-emerald-300">ok</span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  SNG payout helpers
// ═══════════════════════════════════════════════════════════════════════════

const TIER_NAMES = ['Copper', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Black'];
/** SOL prize-pool BPS (top 1/2/3 only). Drives buy-in pool splits. */
const SOL_PAYOUT_BPS: Record<number, number[]> = {
  2: [10000],
  6: [6500, 3500],
  9: [5000, 3000, 2000],
};
/** POKER (Raw Yield) emission BPS. Mirrors PokerPayoutStructure in
 * programs/fastpoker/src/constants.rs. Includes non-ITM trickle; last-out
 * positions are 0. Used to project the hero's $FP earnings for any rank. */
const POKER_PAYOUT_BPS: Record<number, number[]> = {
  2: [10000, 0],
  6: [5500, 2500, 1200, 500, 300, 0],
  9: [5000, 2500, 1500, 500, 300, 100, 100, 0, 0],
};
/** Legacy alias kept for any external callers; maps to POKER table since
 * existing usages compute projected $FP earnings, not SOL splits. */
const PAYOUT_BPS = POKER_PAYOUT_BPS;

// ═══════════════════════════════════════════════════════════════════════════
//  Mobile detection
// ═══════════════════════════════════════════════════════════════════════════

function useIsMobile(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia('(max-width: 639px)');
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  }, []);
  const getSnapshot = useCallback(() => window.innerWidth < 640, []);
  const getServerSnapshot = useCallback(() => false, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function useIsLandscape(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia('(orientation: landscape) and (max-height: 500px)');
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  }, []);
  const getSnapshot = useCallback(() => window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches, []);
  const getServerSnapshot = useCallback(() => false, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Card customization panel inside the table hamburger menu
// ═══════════════════════════════════════════════════════════════════════════

function CardPrefsSection() {
  const prefs = useCardPrefs();
  const isMobile = useIsMobile();

  const rowClass = 'flex items-center justify-between gap-3 px-2.5 py-1.5';
  const labelClass = 'font-mono text-[9px] tracking-[0.18em] text-boneDim';
  const btnBase = 'font-mono text-[9px] tracking-[0.16em] px-1.5 py-0.5 rounded-sm border transition';
  const btnOn = 'border-orange/60 bg-orange/15 text-orange';
  const btnOff = 'border-bone/15 text-boneDim hover:border-bone/30 hover:text-bone';

  const setDeck = (v: DeckColors) => { SFX.play('ui-toggle'); setCardPrefs({ deckColors: v }); };
  const setFont = (v: CardFont) => { SFX.play('ui-toggle'); setCardPrefs({ cardFont: v }); };
  const setPos = (v: HeroPosition) => { SFX.play('ui-toggle'); setCardPrefs({ heroPosition: v }); };
  const setSize = (v: PrefCardSize) => { SFX.play('ui-toggle'); setCardPrefs({ cardSize: v }); };
  const setUpright = (v: boolean) => { SFX.play('ui-toggle'); setCardPrefs({ uprightCorners: v }); };

  return (
    <>
      <div className="px-2.5 py-1.5">
        <span className="font-mono text-[9px] tracking-[0.22em] text-orange/70">CARDS</span>
      </div>

      <div className={rowClass}>
        <span className={labelClass}>DECK</span>
        <div className="inline-flex gap-1">
          <button type="button" onClick={() => setDeck('2color')} className={cn(btnBase, prefs.deckColors === '2color' ? btnOn : btnOff)}>2-COLOR</button>
          <button type="button" onClick={() => setDeck('4color')} className={cn(btnBase, prefs.deckColors === '4color' ? btnOn : btnOff)}>4-COLOR</button>
        </div>
      </div>

      <div className={rowClass}>
        <span className={labelClass}>FONT</span>
        <div className="inline-flex flex-wrap gap-1">
          <button type="button" onClick={() => setFont('display')} className={cn(btnBase, prefs.cardFont === 'display' ? btnOn : btnOff)}>DISPLAY</button>
          <button type="button" onClick={() => setFont('serif')} className={cn(btnBase, prefs.cardFont === 'serif' ? btnOn : btnOff)}>SERIF</button>
          <button type="button" onClick={() => setFont('mono')} className={cn(btnBase, prefs.cardFont === 'mono' ? btnOn : btnOff)}>MONO</button>
          <button type="button" onClick={() => setFont('cards')} className={cn(btnBase, prefs.cardFont === 'cards' ? btnOn : btnOff)}>CARDS</button>
          <button type="button" onClick={() => setFont('bigez')} className={cn(btnBase, prefs.cardFont === 'bigez' ? btnOn : btnOff)}>BIG EZ</button>
        </div>
      </div>

      <div className={rowClass}>
        <span className={labelClass}>SIZE</span>
        <div className="inline-flex gap-1">
          <button type="button" onClick={() => setSize('small')} className={cn(btnBase, prefs.cardSize === 'small' ? btnOn : btnOff)}>S</button>
          <button type="button" onClick={() => setSize('default')} className={cn(btnBase, prefs.cardSize === 'default' ? btnOn : btnOff)}>M</button>
          <button type="button" onClick={() => setSize('large')} className={cn(btnBase, prefs.cardSize === 'large' ? btnOn : btnOff)}>L</button>
          <button type="button" onClick={() => setSize('xl')} className={cn(btnBase, prefs.cardSize === 'xl' ? btnOn : btnOff)}>XL</button>
        </div>
      </div>

      <div className={rowClass}>
        <span className={labelClass}>CORNERS</span>
        <div className="inline-flex gap-1">
          <button type="button" onClick={() => setUpright(false)} title="Standard playing-card layout (bottom corners rotated 180°)" className={cn(btnBase, !prefs.uprightCorners ? btnOn : btnOff)}>STANDARD</button>
          <button type="button" onClick={() => setUpright(true)} title="Both corners upright so 6 and 9 don't look like opposites" className={cn(btnBase, prefs.uprightCorners ? btnOn : btnOff)}>UPRIGHT</button>
        </div>
      </div>

      <div className={rowClass}>
        <span className={labelClass}>POSITION</span>
        <div className="inline-flex gap-1">
          <button type="button" onClick={() => setPos('left')} className={cn(btnBase, prefs.heroPosition === 'left' ? btnOn : btnOff)}>LEFT</button>
          <button
            type="button"
            onClick={() => setPos('table')}
            title="Render hole cards on the felt"
            className={cn(btnBase, prefs.heroPosition === 'table' ? btnOn : btnOff)}
          >
            TABLE
          </button>
        </div>
      </div>

      <BetPresetsEditor presets={prefs.betPresets} />
    </>
  );
}

function presetLabel(p: BetPreset): string {
  return p.kind === 'bb' ? `${p.value}BB` : (p.value === 100 ? 'POT' : `${p.value}%`);
}

function BetPresetsEditor({ presets }: { presets: BetPreset[] }) {
  const [kind, setKind] = useState<'pot' | 'bb'>('bb');
  const [draft, setDraft] = useState('');
  const atMin = presets.length <= BET_PRESET_MIN_COUNT;
  const atMax = presets.length >= BET_PRESET_MAX_COUNT;
  const lo = kind === 'bb' ? BET_PRESET_MIN_BB : BET_PRESET_MIN_PCT;
  const hi = kind === 'bb' ? BET_PRESET_MAX_BB : BET_PRESET_MAX_PCT;

  const addPreset = () => {
    const v = Math.round(Number(draft));
    if (!Number.isFinite(v) || v < lo || v > hi || atMax) return;
    if (presets.some(p => p.kind === kind && p.value === v)) return;
    SFX.play('ui-toggle');
    setCardPrefs({ betPresets: [...presets, { kind, value: v }] });
    setDraft('');
  };
  const removePreset = (target: BetPreset) => {
    if (atMin) return;
    SFX.play('ui-toggle');
    setCardPrefs({ betPresets: presets.filter(p => !(p.kind === target.kind && p.value === target.value)) });
  };
  const resetDefaults = () => {
    SFX.play('ui-toggle');
    setCardPrefs({ betPresets: [...BET_PRESET_DEFAULTS] });
  };

  return (
    <>
      <div className="mx-2 my-1 h-px bg-orange/10" />
      <div className="px-2.5 py-1.5 space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[9px] tracking-[0.22em] text-orange/70">BET PRESETS</span>
          <button
            type="button"
            onClick={resetDefaults}
            className="font-mono text-[9px] tracking-[0.16em] text-boneDim/50 hover:text-bone transition"
          >
            RESET
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          {presets.map(p => (
            <button
              key={`${p.kind}:${p.value}`}
              type="button"
              onClick={() => removePreset(p)}
              disabled={atMin}
              title={atMin ? `Min ${BET_PRESET_MIN_COUNT} presets required` : `Remove ${presetLabel(p)}`}
              className={cn(
                'inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.12em] px-1.5 py-0.5 rounded-sm border transition',
                atMin
                  ? 'border-bone/15 bg-bone/[0.03] text-boneDim/55 cursor-not-allowed'
                  : 'border-orange/40 bg-orange/[0.08] text-orange hover:bg-orange/15 hover:border-orange/60',
              )}
            >
              {presetLabel(p)}
              {!atMin && <span className="text-orange/55">×</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {/* kind toggle: % of pot vs × big blind */}
          <div className="inline-flex shrink-0 rounded-sm border border-bone/15 overflow-hidden">
            {(['pot', 'bb'] as const).map(k => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cn(
                  'font-mono text-[10px] tracking-[0.08em] px-1.5 py-1 transition',
                  kind === k ? 'bg-orange/20 text-orange' : 'text-boneDim/60 hover:text-bone',
                )}
              >
                {k === 'pot' ? '%POT' : '×BB'}
              </button>
            ))}
          </div>
          <input
            type="number"
            min={lo}
            max={hi}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPreset(); } }}
            placeholder={atMax ? `Max ${BET_PRESET_MAX_COUNT}` : (kind === 'bb' ? 'e.g. 3' : 'e.g. 75')}
            disabled={atMax}
            className="flex-1 min-w-0 bg-ink/60 rounded-sm border border-bone/15 px-2 py-1 font-mono text-[10px] text-bone placeholder:text-boneDim/40 outline-none focus:border-orange/40 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={addPreset}
            disabled={atMax || !draft}
            className="shrink-0 font-mono text-[10px] tracking-[0.16em] px-2 py-1 rounded-sm border border-orange/50 bg-orange/[0.08] text-orange hover:bg-orange/15 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ADD
          </button>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main PokerTable
// ═══════════════════════════════════════════════════════════════════════════

export default function PokerTable({
  tablePda, phase, pot, currentPlayer, communityCards, players,
  myCards, shownCards = {}, onShowCards, revealedThisHand = false, linkedSigners,
  onAction, onDuelAction, bountyTeeConnection, isMyTurn, blinds = { small: 5, big: 10 },
  sessionClaimRequired = false, sessionClaimDebug = null, onClaimSeatSession,
  dealerSeat = 0, maxSeats = 2, handHistory = [], actionPending = false,
  showdownPot, showdownPayouts, tier = 0, prizePool = 0, maxPlayers = 2, currentPlayers = 0,
  seatsOccupied = 0, eliminatedSeats = [], eliminatedCount = 0, lastActionSlot = 0,
  playerActions = [], pastHands = [], viewingPastHand = null, onHandNav,
  blindLevel = 0, tournamentStartTime = 0,
  currentBet = 0, tokenMint, tokenDecimals, onSeatClick, pendingJoinSeat = null, reservedJoinSeat = null,
  selectedJoinSeat = null, reservedJoinSeats = [], joiningSeat = null, debugClearingSeats = [],
  isCashGame = false, handNumber = 0,
  blindDeadline = 0, blindsPosted = 0, smallBlindSeat = 0, bigBlindSeat = 1,
  onPostBlind,
  isMeSittingOut, autoPostBlinds, setAutoPostBlinds, onSitOut, onSitIn,
  sittingOutPending, isMaintenance, verifyUrl,
  ceremony = null, sidePots, onOpenTopUp,
  onOpenTipJar, tipJarBalance = 0, tipJarHands = 0, onShareTable,
  onLeaveTable, leavingTable, rakeBps = 500, rakeCap = 0,
  devSlot, devMyPubkey,
}: PokerTableProps) {
  const { publicKey, sendTransaction, signMessage } = useUnifiedWallet();
  // Private player notes (author-only; lazy — no signing until the editor opens).
  const playerNotes = usePlayerNotes(publicKey, signMessage);
  const [noteTargetPubkey, setNoteTargetPubkey] = useState<string | null>(null);
  // Just open — the modal triggers the signed load itself, and only when the
  // author is unlocked (level 5+), so sub-level-5 users never get a signing
  // popup for a feature they can't use yet.
  const openNotesFor = useCallback((pubkey: string) => {
    setNoteTargetPubkey(pubkey);
  }, []);
  const router = useRouter();
  const isMobile = useIsMobile();
  const tokenLogo = useTokenLogo(tokenMint);
  // Read card prefs + live SOL price for the SOL→USD toggle.
  // The toggle row in the hamburger menu (below) is the only way users flip
  // showFiat, and it's gated to SOL games — so the conversion only applies
  // when isCashGame + tokenIsSol + showFiat are all true.
  const cardPrefsForFmt = useCardPrefs();
  const prices = usePrices();
  // SnG Duels: one cached read of the sidecar for the whole table, mapped seat -> KO count for the
  // per-seat badges. Null table (non-duel formats) short-circuits the fetch inside the hook.
  const bountyDuelFormat = sngDuelsEnabled() && !isCashGame && (maxPlayers === 6 || maxPlayers === 9);
  const { state: bountySeatState, pool: bountyPool, emissionRateBps } = useSngBountyState(
    bountyDuelFormat ? tablePda : null,
    5_000,
    bountyTeeConnection,
  );
  const seatKoBySeat = useMemo(() => {
    const m: Record<number, number> = {};
    // Flat bounty 2026-07-14: tied winners split a point FRACTIONALLY (0.5 / 0.33),
    // so the per-seat map carries the fraction, not the floor.
    if (bountySeatState) for (const v of seatViews(bountySeatState)) m[v.seat] = v.points;
    return m;
  }, [bountySeatState]);
  // Right-rail bounty data: pool/buy-in header + per-seat collected-bounty projections ($FP pure
  // bounty by fp-weight share of the matured pool; SOL = the 50% bounty half by KO share).
  const bountyRail = useMemo(() => {
    if (!bountyDuelFormat) return undefined;
    const emissionFormat = maxPlayers === 6 ? 1 : 2; // duel format is 6/9-max only (HU stays legacy)
    // $FP pool truth: once the table is FUNDED, the on-chain snapshot (normal = gross minus the
    // 10% grand skim) is the real pool - the client twin can't know the governor multiplier or
    // idle boost. Unfunded: estimate = twin curve x the CURRENT governed rate. Twin-only last.
    const twinFp = Number(calculateSngPoolUnrefined(emissionFormat, maxPlayers, BigInt(0), tier)) * 0.9 / 1_000_000;
    const potFp = bountyPool?.grandFunded
      ? Number(BigInt(bountyPool.normalUnrefined)) / 1_000_000
      : emissionRateBps != null
        ? twinFp * emissionRateBps / 10_000
        : twinFp;
    const potSol = (prizePool || 0) / 1e9;
    const buyInSol = (TIERS[tier] ?? TIERS[0]).totalBuyIn / 1e9;
    const seatFp: Record<number, number> = {};
    const seatSol: Record<number, number> = {};
    const seatEliminated: Record<number, number> = {}; // seat -> blind level busted at
    let duel: { round: number; seatA: number; seatB: number } | null = null;
    if (bountySeatState) {
      const views = seatViews(bountySeatState);
      for (const v of views) if (v.eliminated) seatEliminated[v.seat] = v.eliminationLevel ?? 0;
      // Level-0 bust blind spot: a bust at blind level 0 stamps elimination_level=0, and
      // full retention leaves burned=0, so the sidecar alone reads as "alive" (07-12
      // audit finding). Cross-check the table: SNG pool games start full, so once the
      // sidecar is seeded, any seat with no seated player is busted. Skip while the
      // players list is empty (transient fetch) to avoid flashing everyone as busted.
      // No `paid` gate: during the settling window (paid=true, winner still seated) the
      // OUT rows must keep rendering - busted earners' points still pay (2026-07-14
      // live find: standings showed 6/9 pts, three earned points invisible). Reset
      // safety comes from seededCount going 0 and the players guard.
      if ((bountySeatState.seededCount ?? 0) > 0 && players.length > 0) {
        const seated = new Set(players.map((p) => p.seatIndex));
        for (const v of views) {
          if (!v.eliminated && v.seat < maxPlayers && !seated.has(v.seat)) {
            seatEliminated[v.seat] = bountySeatState.eliminationLevel?.[v.seat] ?? 0;
          }
        }
      }
      const totalFp = views.reduce((a, v) => a + v.fpWeightUnits, 0n);
      const totalKo = views.reduce((a, v) => a + v.koCreditUnits, 0n);
      const mBps = bountySeatState.paid
        ? duelMaturityBps(bountySeatState.finalBlindLevel)
        : duelMaturityBps(blindLevel);
      const maturedFp = potFp * mBps / 10_000;
      const solBountyPool = potSol * SOL_BOUNTY_BPS / 10_000;
      // Denominator, per ruleset - same rule as bountyBankView in lib/sng-duel-view.ts,
      // keep in lockstep:
      // - LEGACY: the game's KNOWN end-of-game credit total, not credits-so-far
      //   (user report 2026-07-04 x2: "1 bounty = 0.27 SOL" - the whole pool - in the
      //   standings rows). Every elimination credits exactly BOUNTY_UNIT and a game
      //   has exactly maxPlayers-1 of them.
      // - BOUNTY SHIELD (ruleset 1): points are conserved from seeding; the live
      //   Sum(held units) IS the settlement denominator (burns concentrate value).
      const shield = (bountySeatState.ruleset ?? 0) === 1;
      const expectedUnits = Number(BOUNTY_UNIT) * Math.max(1, maxPlayers - 1);
      const fpDenom = shield
        ? Number(totalFp)
        : bountySeatState.paid ? Number(totalFp) : Math.max(Number(totalFp), expectedUnits);
      const koDenom = shield
        ? Number(totalKo)
        : bountySeatState.paid ? Number(totalKo) : Math.max(Number(totalKo), expectedUnits);
      for (const v of views) {
        if (fpDenom > 0) seatFp[v.seat] = maturedFp * Number(v.fpWeightUnits) / fpDenom;
        if (koDenom > 0) seatSol[v.seat] = solBountyPool * Number(v.koCreditUnits) / koDenom;
      }
      if (bountySeatState.duelActive) {
        duel = { round: bountySeatState.duelRound, seatA: bountySeatState.duelSeatA, seatB: bountySeatState.duelSeatB };
      }
    }
    // Header consistency (user report 2026-07-17): the pool header must count maturity
    // exactly like the per-seat rows do, or the header promises the 100%-maturity pool
    // while the rows sum to the matured fraction (60 vs 6x2.5 on a fresh level-0 game).
    const railMBps = bountySeatState?.paid
      ? duelMaturityBps(bountySeatState.finalBlindLevel)
      : duelMaturityBps(blindLevel);
    return {
      potFp, potSol, buyInSol,
      potFpMatured: potFp * railMBps / 10_000,
      maturityPct: Math.min(100, Math.round(railMBps / 100)),
      potFpFunded: !!bountyPool?.grandFunded,
      emissionRateBps: emissionRateBps ?? null,
      seatKo: seatKoBySeat, seatFp, seatSol, seatEliminated, duel,
      // Flat Bounty: downstream surfaces use this for standings and duel overlay labels.
      ruleset: bountySeatState?.ruleset ?? 0,
      duelPausedAtTs: bountySeatState ? Number(bountySeatState.duelPauseStartedTs) || null : null,
    };
  }, [bountyDuelFormat, bountySeatState, bountyPool, emissionRateBps, seatKoBySeat, maxPlayers, tier, prizePool, blindLevel, players]);
  // End-screen snapshot: the sidecar is RESET to zeros at settlement (table reuse) and the SOL pool
  // drains at distribution, so the game-end breakdown must latch the last LIVE reading (KOs present
  // and pool still funded) - reading at end-time shows a winner with "0 knockouts".
  const bountyEndSnapRef = useRef<{ rail: NonNullable<typeof bountyRail>; maturityPct: number } | null>(null);
  useEffect(() => {
    if (!bountyRail) return;
    const hasKo = Object.values(bountyRail.seatKo).some((k) => k > 0);
    if (hasKo && bountyRail.potSol > 0) {
      const lvl = bountySeatState?.paid ? bountySeatState.finalBlindLevel : blindLevel;
      bountyEndSnapRef.current = {
        rail: bountyRail,
        maturityPct: Math.min(100, Math.round(duelMaturityBps(lvl) / 100)),
      };
    }
  }, [bountyRail, bountySeatState, blindLevel]);
  // Feed the module-level sticky seat memory (see rememberSeatPubkeys above).
  useEffect(() => {
    rememberSeatPubkeys(tablePda, players);
  }, [tablePda, players]);
  const tokenIsSol = !tokenMint || tokenMint === '11111111111111111111111111111111';
  const fmtUsdRate = isCashGame && tokenIsSol && cardPrefsForFmt.showFiat && prices.solPrice > 0
    ? prices.solPrice
    : undefined;
  // 'table' heroPosition is honored on mobile too now — the hero's cards render
  // on the felt above their seat (same as desktop, mobile-sized below).
  const effectiveHeroPosition: 'left' | 'center' | 'table' = cardPrefsForFmt.heroPosition;
  const fmtVal = useMemo(
    () => makeValueFormatter(blinds.big, tokenMint, isCashGame, fmtUsdRate, tokenDecimals),
    [blinds.big, tokenMint, isCashGame, fmtUsdRate, tokenDecimals]
  );
  const parseVal = useMemo(
    () => makeValueParser(blinds.big, tokenMint, isCashGame, fmtUsdRate, tokenDecimals),
    [blinds.big, tokenMint, isCashGame, fmtUsdRate, tokenDecimals]
  );

  const [soundOn, setSoundOn] = useState(() => !SFX.isMuted());
  const [showTableMenu, setShowTableMenu] = useState(false);
  useSoundEffects({
    phase, pot, currentPlayer, communityCards, players,
    isMyTurn: !!isMyTurn, myCards,
    timeLeft: undefined, handNumber: undefined,
  });

  const [endOverlayClosed, setEndOverlayClosed] = useState(false);
  // Snapshot captured the first tick phase enters Complete. The live `phase`
  // can flip away (TEE cycles Complete → Waiting → Starting for the next hand
  // when auto-rebuy is off, or a WS reconnect reads stale state) which would
  // otherwise unmount the ceremony mid-animation. Render from snapshot until
  // the player explicitly closes it.
  const [endSnapshot, setEndSnapshot] = useState<SngEndSnapshot | null>(null);

  const isLandscape = useIsLandscape();

  // Layout + hero seat
  const layouts = isMobile ? SEAT_LAYOUTS_MOBILE : SEAT_LAYOUTS;
  const layout = layouts[maxSeats] || layouts[2];
  const myPubkeyStr = devMyPubkey ?? publicKey?.toBase58();

  // ─── SNG finish: result + projected $FP, prize-distribution watcher, refine ──
  // Derive the hero's finishing result once so both the distribution watcher
  // and the end overlay read the same numbers. Projected $FP comes from the
  // emission curve (90% to the player pool); the actual credit lands on the
  // Unrefined PDA when the crank runs distribute_prizes on L1.
  const sngEnd = useMemo(() => {
    if (isCashGame || !endSnapshot || !myPubkeyStr) return null;
    const heroPlace = getSngFinishPlace(endSnapshot, myPubkeyStr);
    if (heroPlace == null) return null;
    const snapMax = endSnapshot.maxPlayers;
    const itmCount = snapMax <= 2 ? 1 : snapMax <= 6 ? 2 : 3;
    const isWinner = heroPlace === 1;
    const isItm = !isWinner && heroPlace <= itmCount;
    const payoutsBps = PAYOUT_BPS[snapMax] || PAYOUT_BPS[2];
    const emissionFormat = snapMax === 2 ? 0 : snapMax === 6 ? 1 : 2;
    // Prefer the FUNDED on-chain pool (jackpot snapshot / latched bounty rail) over the client
    // twin: the twin can't know the governor multiplier, so it overstates on governed tables.
    const twinPool =
      Number(calculateSngPoolUnrefined(emissionFormat, snapMax, BigInt(0), endSnapshot.tier)) * 0.9 / 1_000_000;
    const fundedPool = bountyPool?.grandFunded
      ? Number(BigInt(bountyPool.normalUnrefined)) / 1_000_000
      : bountyEndSnapRef.current?.rail.potFp ?? null;
    const pokerPoolRaw = bountyDuelFormat && fundedPool != null ? fundedPool : twinPool;
    const heroBps = payoutsBps[heroPlace - 1] || 0;
    const projectedPoker = Math.round(pokerPoolRaw * heroBps / 10000);
    // SOL prize for this place. HU pays 1st only; 6-max pays 1/2 (65/35);
    // 9-max pays 1/2/3 (50/30/20) — so 3rd in a 9-max DOES win SOL.
    // SOL_PAYOUT_BPS is keyed by SEAT COUNT (2/6/9) — use snapMax, NOT
    // emissionFormat (0/1/2), or 9-max looks up the HU table and zeroes 2nd/3rd.
    const solBps = (SOL_PAYOUT_BPS[snapMax] || [])[heroPlace - 1] || 0;
    const projectedSol = solBps > 0 && prizePool > 0 ? (prizePool / 1e9) * solBps / 10000 : 0;
    return {
      heroPlace,
      snapMax,
      itmCount,
      isWinner,
      isItm,
      projectedPoker,
      projectedSol,
      rewards: {
        pokerPool: pokerPoolRaw,
        solPool: prizePool / 1e9,
      },
    };
  }, [isCashGame, endSnapshot, myPubkeyStr, prizePool, bountyDuelFormat, bountyPool]);

  // Distribution status + live raw $FP balance for the refine actions. Holds
  // "distributing" until this game's $FP credit lands on the Unrefined PDA,
  // then unlocks the refine buttons on the player's full raw balance. Only
  // armed when the hero is actually due a prize (projectedPoker > 0).
  const [dist, setDist] = useState<{ status: 'pending' | 'in_progress' | 'complete' } | undefined>(undefined);
  const [rawUnrefined, setRawUnrefined] = useState(0);
  // Baseline + completion persist in refs so the watcher survives re-renders
  // (endSnapshot/sngEnd identity churn) without resetting the baseline — that
  // reset was what made the strip flicker back to "distributing" after settling.
  const distBaselineRef = useRef<bigint | null>(null);
  const distDoneRef = useRef(false);
  // Stable boolean: true while an SNG finish with a prize is on screen. Keying
  // the effect on this (not the sngEnd object) means it runs once per finish,
  // not on every re-render.
  const distArmed =
    !isCashGame && !!endSnapshot && endSnapshot.tournamentOver && !endOverlayClosed && !!sngEnd && sngEnd.projectedPoker > 0 && !!publicKey;
  useEffect(() => {
    if (!distArmed || !publicKey) {
      // Overlay gone — reset so the next finish starts clean.
      distBaselineRef.current = null;
      distDoneRef.current = false;
      setDist(undefined);
      return;
    }
    if (distDoneRef.current) { setDist({ status: 'complete' }); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const conn = makeL1Connection();
    const wallet = publicKey;
    const startedAt = Date.now();
    setDist((prev) => prev ?? { status: 'pending' });
    const tick = async (): Promise<boolean> => {
      try {
        const micros = await readUnrefinedMicros(conn, wallet);
        if (cancelled) return true;
        if (distBaselineRef.current === null) distBaselineRef.current = micros;
        setRawUnrefined(Number(micros) / 1e6);
        // Credit landed (balance grew past the baseline), or a 90s ceiling so we
        // never spin forever if the credit settled before the modal opened.
        if (micros > distBaselineRef.current || Date.now() - startedAt > 90_000) {
          distDoneRef.current = true;
          setDist({ status: 'complete' });
          return true;
        }
        setDist((prev) => (prev?.status === 'complete' ? prev : { status: 'in_progress' }));
      } catch { /* transient RPC error — keep polling */ }
      return false;
    };
    const loop = async () => {
      const done = await tick();
      if (!cancelled && !done) timer = setTimeout(loop, 3500);
    };
    loop();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [distArmed, publicKey]);

  const claimConn = useMemo(() => makeL1Connection(), []);
  const refreshRaw = useCallback(async () => {
    if (!publicKey) return;
    try { setRawUnrefined(Number(await readUnrefinedMicros(claimConn, publicKey)) / 1e6); } catch { /* ignore */ }
  }, [publicKey, claimConn]);
  const handleClaimRaw = useCallback(async () => {
    if (!publicKey || !sendTransaction) return;
    await claimRaw({ connection: claimConn, wallet: publicKey, sendTransaction });
    await refreshRaw();
  }, [publicKey, sendTransaction, claimConn, refreshRaw]);
  const handleClaimAndStake = useCallback(async () => {
    if (!publicKey || !sendTransaction) return;
    await claimAndStake({ connection: claimConn, wallet: publicKey, sendTransaction });
    await refreshRaw();
  }, [publicKey, sendTransaction, claimConn, refreshRaw]);
  const myPlayer = players.find(p => p.pubkey === myPubkeyStr);

  // SnG Duels juice: pop + sound when the hero's KO count rises (a bounty was earned). Baselines on
  // first sidecar load so pre-existing KOs don't false-trigger; only genuine increases celebrate.
  // Latched hero seat: after busting, myPlayer drops out of `players`, but the hero must keep
  // seeing their Bounty Bank / standings row ("watch along"). Latch the last known seat.
  // Persisted per tab (#24): a reload after busting would otherwise lose the latch and
  // zero the hero's Bounty Bank while their standings row still shows held points.
  const heroSeatLive = typeof myPlayer?.seatIndex === 'number' && myPlayer.seatIndex >= 0 ? myPlayer.seatIndex : null;
  const heroSeatLatchedRef = useRef<number | null>(null);
  if (heroSeatLatchedRef.current == null && heroSeatLive == null && myPubkeyStr && typeof window !== 'undefined') {
    try {
      const stored = JSON.parse(sessionStorage.getItem(`fp.heroseat.${tablePda}`) ?? 'null');
      // Wallet-scoped: never adopt a seat latched by a different signer (table reuse).
      if (stored && stored.w === myPubkeyStr && typeof stored.s === 'number') {
        heroSeatLatchedRef.current = stored.s;
      }
    } catch { /* blocked/corrupt storage - latch stays memory-only */ }
  }
  if (heroSeatLive != null && heroSeatLatchedRef.current !== heroSeatLive) {
    heroSeatLatchedRef.current = heroSeatLive;
    try { sessionStorage.setItem(`fp.heroseat.${tablePda}`, JSON.stringify({ w: myPubkeyStr, s: heroSeatLive })); } catch {}
  }
  const bountyHeroSeat = heroSeatLive ?? heroSeatLatchedRef.current;
  const heroKoNow = bountyHeroSeat != null ? (seatKoBySeat[bountyHeroSeat] ?? 0) : 0;
  const prevHeroKoRef = useRef<number | null>(null);
  const [koFlash, setKoFlash] = useState<number | null>(null);
  useEffect(() => {
    if (!bountySeatState) return;
    const prev = prevHeroKoRef.current;
    if (prev != null && heroKoNow > prev) {
      setKoFlash(heroKoNow);
      try { SFX.play('tourney-win'); } catch {}
    }
    prevHeroKoRef.current = heroKoNow;
  }, [heroKoNow, bountySeatState]);
  useEffect(() => {
    if (koFlash == null) return;
    const t = setTimeout(() => setKoFlash(null), 3200); // long enough to actually read it
    return () => clearTimeout(t);
  }, [koFlash]);

  // Anchor the table's viewing perspective to the hero's seat. When the hero
  // busts out of an SNG they're removed from `players`, so myPlayer goes
  // undefined and heroSeatIdx would snap to seat 0 — visually dropping the
  // *winner* into the hero's bottom seat, which reads like "you won". Remember
  // the last seat the hero occupied so the layout stays put through the bust.
  const lastHeroSeatRef = useRef<number | null>(null);
  if (typeof myPlayer?.seatIndex === 'number') lastHeroSeatRef.current = myPlayer.seatIndex;

  // Persist the hero's hole cards for the whole hand so the folded hover-peek
  // keeps working after a fold. The TEE zeroes a folded seat's seat_cards, so
  // live myCards goes undefined a poll or two after folding — which is why the
  // peek only lasted a few seconds (preflop/flop). Keyed by handNumber so it
  // never leaks last hand's cards into a new one.
  const heroHandCardsRef = useRef<{ hand: number; cards: [number, number] } | null>(null);
  if (myCards && myCards[0] !== 255 && myCards[0] <= 51 && myCards[1] !== 255 && myCards[1] <= 51) {
    heroHandCardsRef.current = { hand: handNumber, cards: myCards };
  }
  const heroPeekCards: [number, number] | undefined =
    (myCards && myCards[0] !== 255) ? myCards
    : (heroHandCardsRef.current?.hand === handNumber ? heroHandCardsRef.current.cards : undefined);

  // Hero cosmetic frame — read from localStorage written by /profile.
  // Listen for storage events so the seat updates live when changed in the picker.
  const [heroFrame, setHeroFrame] = useState<SeatFrameId>('default');
  useEffect(() => {
    if (!myPubkeyStr) { setHeroFrame('default'); return; }
    const key = `fp.activeFrame.${myPubkeyStr}`;
    const legacyKey = `fp.blackBenefits.${myPubkeyStr}`;
    const read = () => {
      try {
        const stored = localStorage.getItem(key);
        if (stored) {
          setHeroFrame(stored as SeatFrameId);
        } else if (localStorage.getItem(legacyKey) === '1') {
          setHeroFrame('matte-black');
        } else {
          setHeroFrame('default');
        }
      } catch { /* ignore */ }
    };
    read();
    const onStorage = (e: StorageEvent) => { if (e.key === key || e.key === legacyKey) read(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [myPubkeyStr]);
  const potUi = useMemo(() => getPotUiAmounts(players, pot), [players, pot]);
  const displayPot = potUi.contestablePot;
  const canRaise = canRaiseAgainstLiveOpponent(players, myPlayer, isCashGame === false);
  const handLogRef = useRef<HTMLDivElement>(null);
  // Collapsible right rail (hand log + SNG standings). Lets multi-tablers hide
  // it so the felt fills the column. Desktop-only (md+; on mobile the rail
  // stacks below and stays). Persisted so the choice sticks across hands,
  // tables, and reloads.
  const [railOpen, setRailOpen] = useState(true);
  useEffect(() => {
    try { if (localStorage.getItem('fp.railOpen') === '0') setRailOpen(false); } catch { /* ignore */ }
  }, []);
  const toggleRail = useCallback(() => {
    setRailOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem('fp.railOpen', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const cardsDealt = phase !== 'Waiting' && phase !== 'Starting' && phase !== 'Complete';
  const isShowdownRaw = phase === 'Showdown' || phase === 'Complete';
  // Showdown hold is owned by the page-level displayState snapshot. Keeping a
  // second hold here caused stale cards to reappear after the board cleared.
  const isShowdown = isShowdownRaw;
  // All-in run-out phases. Treated like showdown for the staged reveal so the
  // board pacing starts the moment the run-out begins (cards are revealed here,
  // BEFORE phase=Showdown) instead of waiting for the crank to reach Showdown —
  // which is what made the hole-reveal → flop gap balloon to the crank cadence.
  const isRevealPending =
    phase === 'FlopRevealPending' || phase === 'TurnRevealPending' || phase === 'RiverRevealPending';

  // ─── Same-seat UX: track seats recently transitioning from Leaving → Empty.
  // When a player leaves, the contract holds the seat in Leaving status while
  // the cashout is processed; once it clears the seat goes Empty. Another
  // joiner clicking the seat in the immediate aftermath can race the contract
  // cleanup. We show CLEARING for ~4s after the transition so users know to
  // wait rather than getting a raw seat_player error.
  const leavingSnapshotRef = useRef<Map<number, boolean>>(new Map());
  const [clearingSeats, setClearingSeats] = useState<Map<number, number>>(() => {
    const now = Date.now();
    return new Map(debugClearingSeats.map((seat) => [seat, now]));
  });
  useEffect(() => {
    if (debugClearingSeats.length === 0) return;
    const now = Date.now();
    setClearingSeats(prev => {
      const out = new Map(prev);
      for (const seat of debugClearingSeats) out.set(seat, now);
      return out;
    });
  }, [debugClearingSeats.join(',')]);
  useEffect(() => {
    const now = Date.now();
    const prev = leavingSnapshotRef.current;
    const next = new Map<number, boolean>();
    const newlyClearing: Array<[number, number]> = [];
    for (const p of players) {
      if (p?.seatIndex == null) continue;
      const wasLeaving = !!prev.get(p.seatIndex);
      const isLeavingNow = !!p.isLeaving;
      next.set(p.seatIndex, isLeavingNow);
      if (wasLeaving && !isLeavingNow) {
        newlyClearing.push([p.seatIndex, now]);
      }
    }
    // Also detect seats that vanished (player removed entirely)
    for (const [seatIdx, wasLeaving] of prev) {
      if (wasLeaving && !next.has(seatIdx)) {
        newlyClearing.push([seatIdx, now]);
      }
    }
    leavingSnapshotRef.current = next;
    if (newlyClearing.length > 0) {
      setClearingSeats(prev => {
        const out = new Map(prev);
        for (const [seat, ts] of newlyClearing) out.set(seat, ts);
        return out;
      });
    }
  }, [players]);
  // Sweep CLEARING entries older than 4s
  useEffect(() => {
    if (clearingSeats.size === 0) return;
    const tick = setInterval(() => {
      setClearingSeats(prev => {
        const cutoff = Date.now() - 4000;
        let changed = false;
        const out = new Map<number, number>();
        for (const [seat, ts] of prev) {
          if (ts > cutoff) out.set(seat, ts);
          else changed = true;
        }
        return changed ? out : prev;
      });
    }, 500);
    return () => clearInterval(tick);
  }, [clearingSeats.size]);

  // Capture the SNG end-of-game snapshot. Two DURABLE triggers, whichever first:
  //   (a) phase === 'Complete' — tournament finished (the winner path).
  //   (b) the HERO is eliminated — their seat has entered eliminatedSeats AND
  //       they hold no chips. This is the bust signal that SURVIVES a dropped
  //       Showdown/Complete frame during a fast all-in runout. Without it, an
  //       all-in bust whose terminal frame the client never received showed
  //       nothing at all (FP-DEBUG showed phase jump RiverRevealPending → Waiting
  //       with no Complete) — the "all in ... just eliminated, saw no card /
  //       no end screen" bug. eliminatedSeats is durable table state, so it's
  //       still correct on the next-hand frame; eliminated players fall out of
  //       the live `players` list, so we inject the hero at their last seat so
  //       getSngFinishPlace can resolve the finish.
  // Never reset on phase change — only the explicit onClose clears it, so a
  // post-Complete TEE cycle back to Waiting/Starting can't yank the ceremony.
  useEffect(() => {
    if (isCashGame || endSnapshot) return;
    const heroSeat = (typeof myPlayer?.seatIndex === 'number' && myPlayer.seatIndex >= 0)
      ? myPlayer.seatIndex
      : lastHeroSeatRef.current;
    const elimOrder = (eliminatedSeats || []).slice(0, Math.min(eliminatedCount, maxPlayers));
    const heroLive = myPubkeyStr ? players.find(p => p.pubkey === myPubkeyStr) : undefined;
    const heroEliminated = heroSeat != null && heroSeat >= 0
      && elimOrder.includes(heroSeat)
      && (!heroLive || (heroLive.chips || 0) <= 0); // guard vs stale elim data on a live, chipped seat
    if (phase !== 'Complete' && !heroEliminated) return;

    const snapPlayers = players.map(p => ({
      pubkey: p.pubkey,
      seatIndex: p.seatIndex,
      chips: p.chips || 0,
      isActive: p.isActive,
    }));
    if (myPubkeyStr && heroSeat != null && heroSeat >= 0 && !snapPlayers.some(p => p.pubkey === myPubkeyStr)) {
      snapPlayers.push({ pubkey: myPubkeyStr, seatIndex: heroSeat, chips: 0, isActive: false });
    }
    if (heroEliminated && phase !== 'Complete') {
      fpDebug(`sngEnd.capture reason=hero-eliminated heroSeat=${heroSeat} elimOrder=[${elimOrder.join(',')}] hand=${handNumber} phase=${phase}`);
    }
    setEndSnapshot({
      players: snapPlayers,
      maxPlayers,
      currentPlayers,
      seatsOccupied,
      eliminatedSeats,
      eliminatedCount,
      tier,
      // Over only when a single player remains (winner decided) or the contract
      // flagged the tournament Complete. A mid-tournament bust (others still
      // playing) is NOT over — prizes haven't distributed yet.
      tournamentOver: phase === 'Complete' || currentPlayers <= 1,
    });
  }, [phase, isCashGame, endSnapshot, players, maxPlayers, currentPlayers, seatsOccupied, eliminatedSeats, eliminatedCount, tier, myPlayer?.seatIndex, myPubkeyStr, handNumber]);

  // ── Chip collection animation (uses FlyingChip pattern) ────────────────
  const prevPhaseForChips = useRef(phase);
  const prevBetsRef = useRef<{ seatIdx: number; bet: number; pos: SeatPos }[]>([]);
  const streetStartBetsRef = useRef<Record<number, number>>({});
  const prevHandNumberRef = useRef(handNumber);
  // Snapshot of per-seat bets at the moment phase enters Showdown.
  // The contract zeroes seat.bet_this_round at end-of-round, so without this
  // snapshot the chip stacks vanish before the winner banner has a chance to
  // appear (winner-pulse fires at showdownStage 5, ~5s into the sequence).
  // We hold the snapshot until the user has clearly seen the winner reveal
  // (stage 5), then let it fade with the natural per-seat render.
  const [showdownBetSnapshot, setShowdownBetSnapshot] = useState<Record<number, number>>({});

  // Sticky opponent hole cards: once a seat has revealed cards in this hand,
  // remember them so they don't flicker hidden when the contract cycles phase
  // between *RevealPending and Showdown during an all-in runout (each cycle
  // briefly clears revealed_hands). Cache resets when handNumber changes.
  const revealedHoleCardsRef = useRef<{ handNumber: number; map: Map<number, [number, number]> }>({ handNumber: 0, map: new Map() });
  // Seats whose hole cards were revealed BEFORE the showdown phase — i.e. during
  // an all-in runout, where the contract reveals at the flop and runs the board
  // out through *RevealPending while phase is NOT yet Showdown. For these the
  // showdown stage-gate must not re-hide the cards, or they flip face-down for
  // ~800ms at the Showdown edge (until stage 1) and visibly "flip back over"
  // right after the river. Normal check-down showdowns (cards first appear AT
  // showdown) keep the staged flip. Reset per hand.
  const preShowdownRevealedRef = useRef<{ handNumber: number; set: Set<number> }>({ handNumber: 0, set: new Set() });
  // Ghost seats for the run-out ceremony (user report 2026-07-17): when a duel/all-in
  // busts a player, the chain vacates their seat (and the sidecar marks it eliminated)
  // while the staged run-out is still playing - the busted player's cards vanished
  // mid-ceremony and only the winner's hand stayed up. Snapshot the full player object
  // for any seat with revealed cards; the render loop keeps it on the felt while the
  // showdown ceremony is active, then lets the seat go BUSTED at the next deal.
  const revealedSeatGhostRef = useRef<{ handNumber: number; map: Map<number, Player> }>({ handNumber: 0, map: new Map() });
  useEffect(() => {
    if (revealedHoleCardsRef.current.handNumber !== handNumber) {
      revealedHoleCardsRef.current = { handNumber, map: new Map() };
    }
    if (revealedSeatGhostRef.current.handNumber !== handNumber) {
      revealedSeatGhostRef.current = { handNumber, map: new Map() };
    }
    if (preShowdownRevealedRef.current.handNumber !== handNumber) {
      preShowdownRevealedRef.current = { handNumber, set: new Set() };
    }
    // DUEL showdown (live finding 2026-07-03): duels run BETWEEN hands, so handNumber does
    // not advance and this sticky cache still holds EVERY seat's cards from the previous
    // hand's showdown - the whole table looked like it was in the duel. While a duel is
    // active, only the two duelists may show cards; purge everyone else's stale reveals.
    if (bountySeatState?.duelActive) {
      const a = bountySeatState.duelSeatA;
      const b = bountySeatState.duelSeatB;
      for (const seat of Array.from(revealedHoleCardsRef.current.map.keys())) {
        if (seat !== a && seat !== b) revealedHoleCardsRef.current.map.delete(seat);
      }
      for (const seat of Array.from(preShowdownRevealedRef.current.set)) {
        if (seat !== a && seat !== b) preShowdownRevealedRef.current.set.delete(seat);
      }
      for (const seat of Array.from(revealedSeatGhostRef.current.map.keys())) {
        if (seat !== a && seat !== b) revealedSeatGhostRef.current.map.delete(seat);
      }
    }
    for (const p of players) {
      if (!p || !p.holeCards) continue;
      // Same duel rule for LIVE state: the contract only clears revealed cards at the next
      // deal, so non-duelists still stream face-up cards during the between-hands duel.
      if (
        bountySeatState?.duelActive &&
        p.seatIndex !== bountySeatState.duelSeatA &&
        p.seatIndex !== bountySeatState.duelSeatB
      ) {
        continue;
      }
      const [c0, c1] = p.holeCards;
      if (c0 !== 255 && c1 !== 255 && c0 <= 51 && c1 <= 51) {
        revealedHoleCardsRef.current.map.set(p.seatIndex, [c0, c1]);
        revealedSeatGhostRef.current.map.set(p.seatIndex, { ...p, holeCards: [c0, c1] });
        if (!isShowdown) preShowdownRevealedRef.current.set.add(p.seatIndex);
      }
    }
  }, [handNumber, players, isShowdown, bountySeatState?.duelActive, bountySeatState?.duelSeatA, bountySeatState?.duelSeatB]);

  // Latch seats that folded during LIVE betting this hand. The contract resets
  // seats_folded during showdown AND every street's *RevealPending commit, so a
  // folded seat transiently reads !folded. We previously blanket-hid ALL card
  // backs during *RevealPending to avoid phantom backs on those seats — but that
  // also blinked off every CONTESTING seat's backs between streets (the "back
  // cards disappear then reappear during certain actions" flicker). With this
  // latch the runout phantom-back guard targets only the truly-folded seats, so
  // contesting backs can stay up through *RevealPending. Reset per hand.
  const liveFoldedRef = useRef<{ handNumber: number; set: Set<number> }>({ handNumber: 0, set: new Set() });
  useEffect(() => {
    if (liveFoldedRef.current.handNumber !== handNumber) {
      liveFoldedRef.current = { handNumber, set: new Set() };
    }
    // Only latch from stable live-betting frames — NOT showdown/runout, where
    // the folded bitmask is reset and would un-latch real folders.
    if (isShowdown || isRevealPending) return;
    for (const p of players) {
      if (p && p.folded) liveFoldedRef.current.set.add(p.seatIndex);
    }
  }, [handNumber, players, isShowdown, isRevealPending]);
  const [flyingChips, setFlyingChips] = useState<{ key: string; sx: number; sy: number; denom: string; delay: number; direction?: 'to-pot' | 'to-seat' }[]>([]);
  const winnerChipAnimRef = useRef<string>('');
  const [potPulse, setPotPulse] = useState(0);

  // New hand: seed streetStartBetsRef from current on-chain bets so SB/BB
  // pre-posts become the preflop baseline, not zero. Fixes the "BB flies
  // twice" bug where the blind appeared at the seat AND launched to pot
  // again when Preflop→Flop transitioned.
  useEffect(() => {
    if (handNumber !== prevHandNumberRef.current) {
      const seeded: Record<number, number> = {};
      for (const p of players) {
        if (typeof p.seatIndex === 'number' && p.seatIndex >= 0) {
          seeded[p.seatIndex] = p.bet || 0;
        }
      }
      streetStartBetsRef.current = seeded;
      prevHandNumberRef.current = handNumber;
      // Drop the previous hand's showdown bet snapshot immediately. Otherwise a
      // stale bet chip from the last hand can bleed onto the felt at the start
      // of the next one (the snapshot otherwise only clears on !isShowdown /
      // 1.2s after stage 5, which can lag the hand boundary).
      setShowdownBetSnapshot((prev) => (Object.keys(prev).length ? {} : prev));
    }
  }, [handNumber, players]);

  useEffect(() => {
    const prev = prevPhaseForChips.current;
    const STREETS = ['PreFlop', 'Flop', 'FlopRevealPending', 'Turn', 'TurnRevealPending', 'River', 'RiverRevealPending', 'Showdown', 'Complete'];
    const prevIdx = STREETS.indexOf(prev);
    const currIdx = STREETS.indexOf(phase);
    const streetAdvanced = prevIdx >= 0 && currIdx > prevIdx;
    const currentBaseline: Record<number, number> = {};
    for (const p of players) {
      if (typeof p.seatIndex === 'number' && p.seatIndex >= 0) {
        currentBaseline[p.seatIndex] = p.bet || 0;
      }
    }
    const activeBets = prevBetsRef.current.map(b => ({
      ...b,
      amountThisStreet: Math.max(0, b.bet - (streetStartBetsRef.current[b.seatIdx] || 0)),
    }));
    const isCollection = streetAdvanced && activeBets.some(b => b.amountThisStreet > 0);

    // Snapshot per-seat bets the moment phase transitions to Showdown so
    // chip stacks stay visible while cards flip + the winner banner builds.
    // Captured from prevBetsRef (the last seen seat bets before contract
    // zeroed bet_this_round). Cleared by the showdown-stage cleanup below.
    if (phase === 'Showdown' && prev !== 'Showdown') {
      const snap: Record<number, number> = {};
      for (const b of prevBetsRef.current) {
        if (b.bet > 0) snap[b.seatIdx] = b.bet;
      }
      if (Object.keys(snap).length > 0) setShowdownBetSnapshot(snap);
    }

    if (isCollection) {
      const chipLaunches: { key: string; sx: number; sy: number; denom: string; delay: number }[] = [];
      activeBets
        .filter(b => b.amountThisStreet > 0)
        .forEach((b, seatIdx) => {
          const topPct = parseFloat(b.pos.top);
          const leftPct = parseFloat(b.pos.left);
          // Translate % to pixel-ish offset from pot center (we use vw/vh unit in animation)
          const sx = (leftPct - 50) * 6;
          const sy = (topPct - 50) * 4;
          const denom =
            b.amountThisStreet >= (blinds.big * 20) ? 'chip-gold' :
            b.amountThisStreet >= (blinds.big * 10) ? 'chip-bone' :
            b.amountThisStreet >= (blinds.big * 3) ? 'chip-red' :
            'chip-blu';
          // Fan 3 chips per seat for density
          for (let k = 0; k < 3; k++) {
            chipLaunches.push({
              key: `${b.seatIdx}-${k}-${phase}`,
              sx: sx + (k - 1) * 6,
              sy: sy + (k - 1) * 4,
              denom,
              delay: seatIdx * 40 + k * 30,
            });
          }
        });

      setFlyingChips(chipLaunches);
      setPotPulse(p => p + 1);
      SFX.play('chip-pot');
      const t = setTimeout(() => setFlyingChips([]), 800);
      streetStartBetsRef.current = { ...streetStartBetsRef.current, ...currentBaseline };
      prevPhaseForChips.current = phase;
      return () => clearTimeout(t);
    }
    if (streetAdvanced) {
      streetStartBetsRef.current = { ...streetStartBetsRef.current, ...currentBaseline };
    }
    // handNumber-based reset (above) handles the cross-hand seeding. Leave
    // streetStartBetsRef alone here so pre-posted SB/BB aren't zeroed to
    // then re-fly when Preflop → Flop transitions.
    prevPhaseForChips.current = phase;
  }, [phase, players, blinds.big]);

  useEffect(() => {
    const heroSeatIdx = myPlayer?.seatIndex ?? lastHeroSeatRef.current ?? 0;
    prevBetsRef.current = players.map(p => {
      const visualIdx = (p.seatIndex - heroSeatIdx + maxSeats) % maxSeats;
      const pos = layout[visualIdx] || layout[0];
      return { seatIdx: p.seatIndex, bet: p.bet, pos };
    });
  }, [players, layout, maxSeats, myPlayer?.seatIndex]);

  // ── Buffered community cards (keep cached until next hand) ─────────────
  // Cache persists across every in-hand phase (Flop/*RevealPending/Turn/
  // River/Showdown/Complete) so the board never blinks between streets.
  // Clear on two signals: (a) hand number changes = new hand, or (b) phase
  // sits in Waiting/Starting/PreFlop = no board expected.
  const lastHandForBoardRef = useRef<number>(-1);
  const lastValidCardsRef = useRef<number[]>([255, 255, 255, 255, 255]);
  const bufferedCommunityCards = useMemo(() => {
    if (handNumber !== lastHandForBoardRef.current) {
      lastHandForBoardRef.current = handNumber;
      lastValidCardsRef.current = [255, 255, 255, 255, 255];
    }
    if (phase === 'Waiting' || phase === 'Starting' || phase === 'PreFlop') {
      lastValidCardsRef.current = [255, 255, 255, 255, 255];
      return [255, 255, 255, 255, 255];
    }
    // Fold-win clear. At a TERMINAL phase (Showdown/Complete) an all-empty
    // contract board means the hand ended with NO board dealt — a preflop
    // fold-win. Without this, when a showdown hand is immediately followed by a
    // fast preflop fold-win, the client can skip the new hand's PreFlop tick and
    // handNumber lags, so neither reset above fires and the anti-flicker "keep
    // cached" fallback below bleeds the PREVIOUS hand's board onto this one.
    // A real showdown has a populated board here, so it never triggers; mid-
    // street reads (Flop/Turn/River/*RevealPending) keep the anti-flicker cache.
    const incomingAllEmpty = !communityCards.some(c => c !== undefined && c !== 255 && c >= 0 && c <= 51);
    if (incomingAllEmpty && (phase === 'Showdown' || phase === 'Complete')) {
      lastValidCardsRef.current = [255, 255, 255, 255, 255];
      return [255, 255, 255, 255, 255];
    }
    // Stale-board guard: within a hand the FLOP (slots 0-2) is immutable once
    // dealt. If a freshly dealt flop differs from the cached flop, the deck was
    // reshuffled for a NEW hand even though handNumber hasn't ticked on this
    // client yet (WS lag / a missed PreFlop reset — common in wallet webviews).
    // Drop the whole cache so the previous hand's turn/river can't bleed onto
    // the new board: the "old flop appears" / "never saw the real river" bug.
    // A momentary all-255 read does NOT trigger this (flopIn needs 3 valid
    // cards), so a stale empty tick still can't blink the board off.
    const c0 = communityCards[0], c1 = communityCards[1], c2 = communityCards[2];
    const flopIn = c0 !== undefined && c0 !== 255 && c0 >= 0 && c0 <= 51
                && c1 !== undefined && c1 !== 255 && c1 >= 0 && c1 <= 51
                && c2 !== undefined && c2 !== 255 && c2 >= 0 && c2 <= 51;
    const cache = lastValidCardsRef.current;
    const flopCached = cache[0] !== 255 && cache[1] !== 255 && cache[2] !== 255;
    const flopChanged = flopIn && flopCached && (c0 !== cache[0] || c1 !== cache[1] || c2 !== cache[2]);
    if (flopChanged) {
      fpDebug(`board.stale-reset hand=${handNumber} phase=${phase} cachedFlop=[${cache[0]},${cache[1]},${cache[2]}] newFlop=[${c0},${c1},${c2}]`);
      lastValidCardsRef.current = [255, 255, 255, 255, 255];
    }
    const merged = [255, 255, 255, 255, 255];
    for (let i = 0; i < 5; i++) {
      const incoming = communityCards[i];
      const cached = lastValidCardsRef.current[i];
      if (incoming !== undefined && incoming !== 255 && incoming >= 0 && incoming <= 51) {
        merged[i] = incoming;
      } else if (cached !== 255) {
        merged[i] = cached;
      }
    }
    lastValidCardsRef.current = [...merged];
    return merged;
  }, [communityCards, phase, handNumber]);

  // Freeze the board count at the street where betting actually stopped, so an
  // all-in run-out can be dealt street-by-street instead of dumping the whole
  // board. The reliable signal is the all-in LOCK: once anyone is all-in, every
  // later street (incl. the plain Flop/Turn/River the contract briefly passes
  // through during a run-out) is reveal-only, not betting — so we stop updating
  // the count then. Resets to 0 each hand. A normal showdown never locks all-in,
  // so this reaches 5 at the river and only the hole cards animate.
  const handHasAllIn = useMemo(() => players.some(p => isAllInPlayer(p)), [players]);
  const preShowdownBoardCountRef = useRef(0);
  const preShowdownHandRef = useRef(-1);
  useEffect(() => {
    if (handNumber !== preShowdownHandRef.current) {
      preShowdownHandRef.current = handNumber;
      preShowdownBoardCountRef.current = 0;
    }
    // Sub-hand deal boundary (#6): a duel showdown re-deals the felt WITHOUT a
    // hand-number change, passing through Waiting/Starting/PreFlop (where the
    // board buffer clears). Without this reset the ref stays at the MAIN hand's
    // count (usually 5), the staging gate sees priorCount=5, and the duel's own
    // run-out bursts 0->5 unpaced (seen in the 07-12 pacing capture, hand 227).
    // A genuine all-in run-out never revisits these phases, so this can't fire
    // mid-ceremony.
    if (phase === 'Waiting' || phase === 'Starting' || phase === 'PreFlop') {
      preShowdownBoardCountRef.current = 0;
    }
    // Keep following the board while betting can STILL happen — i.e. ≥2 players
    // are live (not folded, not all-in). The run-out lock is "≤1 player can act",
    // NOT "anyone is all-in": a single short-stack all-in with others still
    // betting legitimately advances the board, so we freeze at the street where
    // betting actually stops. (Bug: a flop all-in was frozen at preflop count 0
    // and the whole board re-dealt as a preflop run-out.)
    const liveBettors = players.filter(p => !p.folded && !isAllInPlayer(p)).length;
    if (liveBettors >= 2 && (phase === 'PreFlop' || phase === 'Flop' || phase === 'Turn' || phase === 'River')) {
      preShowdownBoardCountRef.current = bufferedCommunityCards.filter(c => c !== 255 && c >= 0 && c <= 51).length;
    }
  }, [handNumber, phase, bufferedCommunityCards, players]);

  // ── Player profiles ─────────────────────────────────────────────────────
  const [profiles, setProfiles] = useState<Record<string, {
    username: string;
    avatarUrl: string;
    avatarType?: string;
    avatarValue?: string;
    avatarImageUrl?: string;
    avatarCollection?: string;
    activeFrame?: string;
  }>>({});
  const playerPubkeys = useMemo(() => players.map(p => p.pubkey).sort().join(','), [players]);
  useEffect(() => {
    if (!players.length) return;
    // Public source release ships no /api/profile backend; show wallets unless
    // an operator explicitly adds and enables a compatible profile API.
    if (!PROFILE_API_ENABLED) return;
    const pubkeys = players.map(p => p.pubkey);
    const fetchProfiles = () => {
      fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallets: pubkeys }),
      })
        .then(r => r.json())
        .then(data => { if (data.profiles) setProfiles(data.profiles); })
        .catch(() => {});
    };
    fetchProfiles();
    // Refresh profiles every 30s so frame changes (activeFrame) reach other
    // players' tables without forcing a leave/rejoin.
    const id = window.setInterval(fetchProfiles, 30_000);
    return () => clearInterval(id);
  }, [playerPubkeys]);

  // Prefer the server-saved frame (source of truth) once the batch profile fetch
  // lands, so the hero's OWN frame shows on a fresh browser/device even with an
  // empty local cache. Mirrors /profile's hydration; localStorage stays the fast
  // path for the same-browser case + live picker updates.
  useEffect(() => {
    const serverFrame = myPubkeyStr ? profiles[myPubkeyStr]?.activeFrame : undefined;
    if (serverFrame && serverFrame !== 'default') setHeroFrame(serverFrame as SeatFrameId);
  }, [profiles, myPubkeyStr]);

  // ── Turn timer ──────────────────────────────────────────────────────────
  const TIMEOUT_SECS = 15;
  const SNG_SITOUT_TIMEOUT_SECS = 5;
  const TIMEBANK_EXTENSION = 15;
  const [nowSecs, setNowSecs] = useState(() => Date.now() / 1000);
  const currentPlayerObj = players.find(p => p.seatIndex === currentPlayer);
  const actionAnchorSecs = Number(lastActionSlot || 0);
  const isTimeBankActive = currentPlayerObj?.timeBankActive ?? false;
  const hasBankExtendedDeadline = Number.isFinite(actionAnchorSecs) && actionAnchorSecs > nowSecs + 1;
  // SNG: a sitting-out current player is auto-folded at a 5s floor (timeout.rs),
  // not 15s, and gets no time bank. Reflect that in the on-screen timer so the
  // ring/countdown matches the real window they have to act-to-return.
  const isSngSitOutTurn = isCashGame === false && !!currentPlayerObj?.isSittingOut;
  const baseTimeoutSecs = isSngSitOutTurn ? SNG_SITOUT_TIMEOUT_SECS : TIMEOUT_SECS;
  const timerWindowSecs = (!isSngSitOutTurn && (isTimeBankActive || hasBankExtendedDeadline)) ? baseTimeoutSecs + TIMEBANK_EXTENSION : baseTimeoutSecs;

  useEffect(() => {
    const canAct = phase === 'PreFlop' || phase === 'Flop' || phase === 'Turn' || phase === 'River';
    if (!canAct) return;
    setNowSecs(Date.now() / 1000);
    const t = setInterval(() => setNowSecs(Date.now() / 1000), 250);
    return () => clearInterval(t);
  }, [phase, lastActionSlot, currentPlayer]);

  const timeLeft = useMemo(() => {
    if (!Number.isFinite(actionAnchorSecs) || actionAnchorSecs <= 0) return 0;
    // Two time-bank protocols are possible:
    //   (a) flag set, anchor unchanged → deadline = anchor + TIMEOUT + EXTENSION
    //   (b) anchor shifted into the future by the contract → deadline = anchor + TIMEOUT
    // hasBankExtendedDeadline tells us we're in case (b); only add the
    // extension when in case (a). Without this gate, the ring drained over
    // the original 15s window then snapped back when the contract later
    // shifted the anchor — user-visible as "reset to 15s after running out."
    const baseDeadline = actionAnchorSecs + baseTimeoutSecs;
    const deadline = (!isSngSitOutTurn && isTimeBankActive && !hasBankExtendedDeadline)
      ? baseDeadline + TIMEBANK_EXTENSION
      : baseDeadline;
    return Math.max(0, deadline - nowSecs);
  }, [actionAnchorSecs, nowSecs, isTimeBankActive, hasBankExtendedDeadline, baseTimeoutSecs, isSngSitOutTurn]);

  useEffect(() => {
    if (!isMyTurn || timeLeft <= 0) return;
    if (timeLeft <= 2) SFX.play('timer-crit');
    else if (timeLeft <= 5) SFX.play('timer-tick');
  }, [timeLeft, isMyTurn]);

  // ── Showdown staged reveal ──────────────────────────────────────────────
  // Gate the reveal timer on cards actually being present in state. Previously
  // we started counting from `isShowdownRaw` going true, but hole cards can
  // arrive via a later state update (especially over WS) — which meant the
  // 800ms reveal either fired with no cards (pop-in later) or fired right as
  // cards arrived and felt "super quick" with no build-up.
  const [showdownStage, setShowdownStage] = useState(0);
  const showdownTimerRef = useRef<NodeJS.Timeout[]>([]);

  // Transient FLOP / TURN / RIVER banner that fires when community cards
  // arrive during normal play. The system-message panel above the pot will
  // pick this up and render it for ~2.5s, then auto-clear.
  const [streetBanner, setStreetBanner] = useState<'FLOP' | 'TURN' | 'RIVER' | null>(null);
  // (The FLOP / TURN / RIVER banner effect lives below, just after
  // stagedCommunityCards is defined, so it can read the STAGED/paced reveal
  // count rather than the raw buffered board.)
  // The stage CLOCK arms on PHASE ENTRY into the showdown window — terminal
  // Showdown/Complete, or a genuine all-in run-out (*RevealPending while ≤1
  // player can still bet). It used to be gated on data readiness (5 board
  // cards + ≥1 revealed opponent), which had two failure modes seen live:
  //   1. A late/missing opponent reveal kept the stage at 0 forever — the felt
  //      sat blank in a run-out until refresh ("cards don't show").
  //   2. Mid-run-out the crank briefly passes through plain Flop/Turn/River,
  //      flapping readiness false→true and RESTARTING the ceremony from
  //      stage 1 (the visible replay/desync).
  // Now the clock arms once per hand and never unarms until the hand changes.
  // Data availability only gates WHAT each stage may reveal
  // (stagedCommunityCards / cardsFaceUp), never WHETHER the clock runs — so a
  // run-out always converges to a fully revealed board within ~4.6s and late
  // reveal data pops in at whatever stage is current instead of stalling it.
  // Live bettors use the latched fold set: the contract transiently resets
  // seats_folded during *RevealPending, and isAllInPlayer has a chips-based
  // fallback, so this count is stable across the run-out commits. A normal
  // street reveal (≥2 players still able to bet) never arms the clock.
  const runoutLiveBettors = useMemo(() => players.filter(p =>
    p && p.pubkey && p.pubkey !== '11111111111111111111111111111111' &&
    !p.folded && !liveFoldedRef.current.set.has(p.seatIndex) && !isAllInPlayer(p)
  ).length, [players]);
  const inShowdownWindow = isShowdownRaw || (isRevealPending && runoutLiveBettors <= 1);
  const [showdownClockArmed, setShowdownClockArmed] = useState(false);
  const showdownClockHandRef = useRef(-1);
  // True when the NEXT ceremony is a sub-hand re-deal (duel showdown on the same
  // hand number). Those play against the crank's short duel-showdown hold (~1s +
  // transition), so the ceremony must use compact beats or the river stage lands
  // after the felt has already been wiped (game-6 capture: duel board stopped at
  // the turn). Cleared on every real hand change.
  const subHandDealRef = useRef(false);
  useEffect(() => {
    if (handNumber !== showdownClockHandRef.current) {
      showdownClockHandRef.current = handNumber;
      setShowdownClockArmed(false);
      setShowdownStage(0);
      subHandDealRef.current = false;
    }
    // Sub-hand deal boundary (#6): duel showdowns re-deal on the SAME hand
    // number, so the per-hand latch must also reset when a new deal starts
    // (Waiting/Starting/PreFlop, where the board buffer clears). Otherwise the
    // duel's run-out inherits stage 5 from the main hand's ceremony and reveals
    // its whole board at once. A real run-out never passes through these
    // phases, so the mid-run-out flap protection (plain Flop/Turn/River) holds.
    if (!inShowdownWindow && showdownClockArmed
      && (phase === 'Waiting' || phase === 'Starting' || phase === 'PreFlop')) {
      setShowdownClockArmed(false);
      setShowdownStage(0);
      subHandDealRef.current = true;
    }
    if (inShowdownWindow && !showdownClockArmed) setShowdownClockArmed(true);
  }, [handNumber, inShowdownWindow, showdownClockArmed, phase]);

  useEffect(() => {
    // CRITICAL: deps must be STABLE primitives only (showdownClockArmed).
    // Including bufferedCommunityCards or players makes this effect re-run
    // on every render (those arrays get re-created), wiping the in-flight
    // stage timers and restarting the progression. We saw that bug in logs:
    // showdown.start fired 8+ times, stages 1-4 restarted mid-progression.
    // showdownClockArmed is a per-hand latch (false → true once, resets on
    // hand change), so this effect runs the ceremony exactly once per hand.
    showdownTimerRef.current.forEach(t => clearTimeout(t));
    showdownTimerRef.current = [];
    if (showdownClockArmed) {
      // ─── FP-DEBUG: showdown stage progression with elapsed timing
      const t0 = performance.now();
      const log = (msg: string) => fpDebug(`${msg} +${Math.round(performance.now() - t0)}ms`);
      log(`showdown.start (timers begin)`);
      // Pacing is RUN-OUT aware. On an all-in run-out the board grew during the
      // hand (preShowdownBoardCount < 5) and the flop/turn/river are revealed
      // here street-by-street (stages 2-4), so we give a real "sweat": a ~1s
      // beat on the hole-card matchup, then ~1.3s per street. The page-level
      // showdown hold for revealed-card hands is 6.5s (game/[id]/page.tsx), so a
      // winner pulse at ~4.6s + ~1s chip-flight lands comfortably inside it —
      // the board never gets "left behind". A normal (check-down) showdown
      // already has a complete board revealed at once, so its stages only drive
      // the winner pulse — keep that snappy.
      const runout = preShowdownBoardCountRef.current < 5;
      // Sub-hand (duel) showdowns get COMPACT runout beats: the crank only holds a
      // duel showdown ~1s + transition before wiping the felt, so the standard
      // 3.9s river beat never rendered (#6, game-6 capture). ~2.1s fits the window
      // while still landing the streets one at a time.
      const D = subHandDealRef.current
        ? { flip: 200, flop: 700, turn: 1400, river: 2100, win: 2600 }
        : runout
          ? { flip: 250, flop: 1300, turn: 2600, river: 3900, win: 4600 }
          : { flip: 250, flop: 650, turn: 1050, river: 1450, win: 1900 };
      const t1 = setTimeout(() => { log('showdown.stage=1 (cards flip)'); setShowdownStage(1); }, D.flip);
      const t2 = setTimeout(() => { log('showdown.stage=2 (flop)'); setShowdownStage(2); }, D.flop);
      const t3 = setTimeout(() => { log('showdown.stage=3 (turn)'); setShowdownStage(3); }, D.turn);
      const t4 = setTimeout(() => { log('showdown.stage=4 (river)'); setShowdownStage(4); }, D.river);
      const t5 = setTimeout(() => { log('showdown.stage=5 (winner-pulse)'); setShowdownStage(5); }, D.win);
      showdownTimerRef.current = [t1, t2, t3, t4, t5];
    } else if (isShowdownRaw) {
      fpDebug(`showdown.clock-not-armed @${Math.round(performance.now())}ms`);
    }
    return () => { showdownTimerRef.current.forEach(t => clearTimeout(t)); };
    // Trigger on showdownClockArmed ONLY. Including isShowdownRaw would re-run
    // (clearing + restarting the timers) when the run-out crosses
    // *RevealPending → Showdown, re-introducing the delay we just removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showdownClockArmed]);

  // ─── FP-DEBUG: log every phase/hand/state transition (temporary instrumentation,
  // grep `[FP-DEBUG]` to find + remove later). Includes wall-clock timestamp
  // so we can compute the exact display window for the winner/cards.
  useEffect(() => {
    const nonFolded = players.filter(p => p.pubkey && p.pubkey !== '11111111111111111111111111111111' && !p.folded).length;
    const revealedOpponents = players.filter(p => p.holeCards && p.holeCards[0] !== 255 && p.pubkey !== myPubkeyStr).length;
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    fpDebug(`state hand=${handNumber} phase=${phase} pot=${pot} nonFolded=${nonFolded} revealedOpponents=${revealedOpponents} community=${bufferedCommunityCards.filter(c => c !== 255).length}/5 myCards=${myCards ? '[' + myCards[0] + ',' + myCards[1] + ']' : 'none'}`);
  }, [phase, handNumber, pot, players, bufferedCommunityCards, myCards, myPubkeyStr]);
  // Reset stages only once we're fully out of showdown AND the run-out. Resetting
  // during *RevealPending would zero the stage timer that started at run-out begin.
  // While the clock is ARMED, never phase-reset: mid-run-out the crank briefly
  // passes through plain Flop/Turn/River and a phase-based reset here zeroed the
  // stage mid-ceremony (board blinked back to the pre-run-out count). The armed
  // latch resets the stage on hand change instead.
  useEffect(() => {
    if (!isShowdown && !isRevealPending && !showdownClockArmed) setShowdownStage(0);
  }, [isShowdown, isRevealPending, showdownClockArmed]);

  // Clear the showdown bet snapshot once the user has seen the winner reveal
  // (stage 5 means winner-pulse + banner have fired). The seat chip stacks
  // then fade with the natural p.bet=0 render. If isShowdown ever goes
  // false (next hand starting), clear too as a safety net.
  useEffect(() => {
    if (!isShowdown) {
      if (Object.keys(showdownBetSnapshot).length > 0) setShowdownBetSnapshot({});
      return;
    }
    if (showdownStage >= 5 && Object.keys(showdownBetSnapshot).length > 0) {
      const t = setTimeout(() => setShowdownBetSnapshot({}), 1200);
      return () => clearTimeout(t);
    }
  }, [isShowdown, showdownStage, showdownBetSnapshot]);

  const stagedCommunityCards = useMemo(() => {
    // During an all-in run-out the contract fills the WHOLE remaining board while
    // phase is still *RevealPending (before Showdown). Treat those phases like
    // showdown: the stage timer (started at run-out begin) deals flop/turn/river
    // one street at a time, paced on MY timers — independent of crank cadence.
    // showdownClockArmed keeps the staging active across the plain Flop/Turn/
    // River phases the crank briefly passes through mid-run-out; returning the
    // raw buffer there flashed the full board for a frame before re-capping.
    if (!isShowdown && !isRevealPending && !showdownClockArmed) return bufferedCommunityCards;
    // TERMINAL SHOWDOWN with a COMPLETE board: always reveal all 5. The staged /
    // capped reveal below is only for an in-progress all-in runout
    // (*RevealPending) or a true fold-win (incomplete board). Without this a real
    // showdown could render BLANK — e.g. a table full of LEAVING players collapses
    // the `contesting` count and `priorCount` never advanced, so the felt stayed
    // empty even though the full board was on-chain (the "frozen in showdown,
    // board not showing" report). Runout pacing is unaffected: it runs during
    // *RevealPending (isShowdown is false then), and at the terminal Showdown the
    // board is already complete.
    const validBoardCard = (c: number) => c !== 255 && c >= 0 && c <= 51;
    const priorCount = preShowdownBoardCountRef.current;
    // Fold-win (everyone folded to one player — incl. a shove that everyone
    // folds to): the contract deals NO further board, so we must NOT stage cards
    // past the count that was on the felt when betting stopped. Without this, a
    // complete or stale buffered board gets "run out" street-by-street as a
    // phantom all-in runout (the "everyone folded to me but it ran the board
    // out, maybe old cards" bug). ≤1 contesting player = fold-win; ≥2 = a genuine
    // showdown / all-in runout that should reveal normally.
    const contesting = players.filter(p => p.pubkey && p.pubkey !== '11111111111111111111111111111111' && !p.folded).length;
    // TERMINAL SHOWDOWN with a COMPLETE board: normally reveal all 5 at once. But
    // a fast all-in run-out on the ER blows through the *RevealPending phases
    // faster than we can poll, so the client lands straight on Showdown with the
    // whole board and used to DUMP all 5 with no flop/turn/river "sweat". When the
    // board GREW during the run-out (priorCount < 5) AND it's a genuine multi-way
    // showdown (≥2 contesting) AND the stage clock is armed (showdownClockArmed
    // arms on phase entry and converges to stage 5 within ~4.6s, so the reveal
    // never freezes partial), fall through to pace the reveal via showdownStage.
    // Otherwise (check-down board already complete, fold-win, or the
    // LEAVING-collapse blank-board case) reveal all 5.
    // showdownClockArmed flips in an EFFECT, i.e. one render AFTER the first
    // showdown frame - so a hand that jumps straight to Showdown with a full
    // board (duel showdowns: phase can go Flop->Showdown at community 3/5, or
    // deal fresh 0->5 in one commit) used to burst all 5 cards on that first
    // frame, then re-cap when the clock armed (#6 run-out pacing). Also accept
    // the render-computed inShowdownWindow so the very first frame stages too.
    if (isShowdown && bufferedCommunityCards.filter(validBoardCard).length >= 5
      && !(priorCount < 5 && contesting >= 2 && (showdownClockArmed || inShowdownWindow))) {
      return [...bufferedCommunityCards];
    }
    const revealCount =
      contesting <= 1 ? priorCount :
      showdownStage >= 4 ? 5 :
      showdownStage >= 3 ? 4 :
      showdownStage >= 2 ? 3 :
      priorCount;
    const visibleCount = Math.max(priorCount, revealCount);
    return bufferedCommunityCards.map((card, idx) => (idx < visibleCount ? card : 255));
  }, [isShowdown, isRevealPending, showdownStage, bufferedCommunityCards, players, showdownClockArmed, inShowdownWindow]);

  // FLOP / TURN / RIVER banner, driven off the STAGED board count (the same
  // paced reveal the felt shows), NOT the raw buffered board. On an all-in the
  // contract writes the whole board at once, so the raw count bursts 0->5 and a
  // raw-count banner flashes all three streets in one go right before the
  // river. stagedCommunityCards advances 3->4->5 in lockstep with the card
  // reveal (showdownStage-paced in showdown, raw in normal play), so the banner
  // announces exactly one street as each lands. Edge-fire once per count via a
  // ref; hold the dismiss timer in a ref so a re-render can't clear it early.
  const lastStreetBannerCountRef = useRef(0);
  const streetBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const count = stagedCommunityCards.filter(c => c !== 255 && c >= 0 && c <= 51).length;
    if (count < 3) {
      // Pre-flop / new hand: re-arm and drop any lingering banner.
      lastStreetBannerCountRef.current = count;
      if (streetBannerTimerRef.current) { clearTimeout(streetBannerTimerRef.current); streetBannerTimerRef.current = null; }
      setStreetBanner(null);
      return;
    }
    if (count <= lastStreetBannerCountRef.current) return; // this street already announced
    lastStreetBannerCountRef.current = count;
    // #6 per-card reveal instrumentation: one event per STAGED street landing, so the
    // timeline can prove the paced reveal (vs a raw 0->5 burst, which would edge-fire
    // a single count=5 event with no flop/turn before it).
    fpEvent('board.street', { count, paced: showdownClockArmed || isRevealPending });
    setStreetBanner(count >= 5 ? 'RIVER' : count === 4 ? 'TURN' : 'FLOP');
    if (streetBannerTimerRef.current) clearTimeout(streetBannerTimerRef.current);
    streetBannerTimerRef.current = setTimeout(() => setStreetBanner(null), 2500);
  }, [stagedCommunityCards]);

  // ── Showdown hand evaluation ────────────────────────────────────────────
  const showdownResults = useMemo(() => {
    if (!isShowdown) return null;
    const validCommunity = stagedCommunityCards.filter(c => c !== 255 && c >= 0 && c <= 51);
    if (validCommunity.length < 5) return null;
    const results: Record<string, { hand: HandResult; isWinner: boolean }> = {};
    let bestScore = -1;
    for (const p of players) {
      const hole = p.holeCards || (p.pubkey === myPubkeyStr ? myCards : undefined);
      const hasValidHole = !!hole && hole[0] !== 255 && hole[1] !== 255 && hole[0] <= 51 && hole[1] <= 51;
      // SNG: a still-sitting-out seat is not ranked at showdown by the contract
      // (settle treats it as folded). The hero always has myCards (hasValidHole),
      // so skip a still-sitting-out SNG seat explicitly to match the contract.
      if (p.folded || (isCashGame === false && p.isSittingOut) || (!p.isActive && !hasValidHole)) continue;
      if (!hole || hole[0] === 255 || hole[1] === 255 || hole[0] > 51 || hole[1] > 51) continue;
      const hand = evaluateHand(hole, validCommunity);
      if (!hand) continue;
      results[p.pubkey] = { hand, isWinner: false };
      if (hand.score > bestScore) bestScore = hand.score;
    }
    const evaluatedCount = Object.keys(results).length;
    let winnerKey = '';
    if (evaluatedCount >= 2 && bestScore >= 0) {
      for (const [key, r] of Object.entries(results)) {
        if (r.hand.score === bestScore) {
          r.isWinner = true;
          if (!winnerKey) winnerKey = key;
        }
      }
    }
    return { results, winnerKey };
  }, [isShowdown, players, stagedCommunityCards, myCards, myPubkeyStr]);

  const displayHandHistory = useMemo(() => {
    if (!isShowdown) return handHistory;
    // Don't let the log spoil the result before the felt board lands. Until the
    // staged board has caught up to the real board (the all-in run-out reveal),
    // hold back the showdown reveal rows — board, winner, and card summaries.
    // Normal/fold hands have the board already complete, so this never delays
    // them (staged === full immediately); only the all-in run-out waits.
    const validCount = (cards: number[]) => cards.filter(c => c !== 255 && c >= 0 && c <= 51).length;
    const boardRevealed = validCount(stagedCommunityCards) >= validCount(bufferedCommunityCards);
    const base = boardRevealed
      ? handHistory
      : handHistory.filter(e =>
          e.phase !== 'Summary'
          && e.phase !== 'Result'
          && !e.action.startsWith('Board:')
          && !/\bWIN\b|\bWON\b/i.test(e.action));
    if (!boardRevealed) return base;
    const existingCardRows = new Set(
      base
        .filter(e => e.phase === 'Summary' && /[2-9TJQKA][shdc]\s+[2-9TJQKA][shdc]/.test(e.action))
        .map(e => e.player)
    );
    const extras: HandAction[] = [];
    for (const p of players) {
      const hole = p.pubkey === myPubkeyStr ? (myCards || p.holeCards) : p.holeCards;
      if (!hole || hole[0] === 255 || hole[1] === 255 || hole[0] > 51 || hole[1] > 51) continue;
      const label = p.pubkey === myPubkeyStr ? 'You' : shortWallet(p.pubkey);
      if (existingCardRows.has(label)) continue;
      extras.push({
        player: label,
        action: `${cardShort(hole[0])} ${cardShort(hole[1])}`,
        phase: 'Summary',
      });
    }
    return extras.length ? [...base, ...extras] : base;
  }, [handHistory, isShowdown, players, myCards, myPubkeyStr, stagedCommunityCards, bufferedCommunityCards]);

  // ── Auto-scroll hand log ────────────────────────────────────────────────
  // ── Derived: winner state ───────────────────────────────────────────────
  const heroSeatIdx = myPlayer?.seatIndex ?? lastHeroSeatRef.current ?? 0;
  // A fold-win means exactly ONE player is still contesting (latched folds:
  // the contract transiently resets seats_folded during showdown commits). A
  // multi-way showdown whose reveal data hasn't landed yet must NOT fall back
  // to "first active player": with the phase-armed stage clock, stage 5 can
  // fire before the opponent's holes arrive, and that fallback launched the
  // winner chip flight toward whoever was first in the array, then re-fired
  // at the real winner once the cards landed (the "pot flew to the wrong
  // player" report). With 2+ contesting and no evaluated winner yet, there is
  // no winner — the ceremony waits the extra beat for data.
  const foldWinner = isShowdown && !showdownResults?.winnerKey
    ? (() => {
        const contesting = players.filter(p =>
          p && p.pubkey && !p.folded && !liveFoldedRef.current.set.has(p.seatIndex) && p.isActive && !p.waitingForBb);
        return contesting.length === 1 ? (contesting[0].pubkey || '') : '';
      })()
    : '';
  const winnerCount = showdownResults
    ? Object.values(showdownResults.results).filter(r => r.isWinner).length
    : (foldWinner ? 1 : 0);
  const isSplitPot = winnerCount > 1;
  const splitPotShare = isSplitPot
    ? Math.floor((showdownPot || pot) / winnerCount)
    : (showdownPot || pot);
  // Per-winner amount. Prefer the real per-player gross return (chip delta from
  // the game page) so an unequal all-in split shows each winner their actual
  // amount; fall back to the equal slice when that data isn't available.
  const winnerPayout = useCallback(
    (pubkey?: string) => {
      const raw = (pubkey && showdownPayouts && showdownPayouts[pubkey] != null)
        ? showdownPayouts[pubkey]
        : splitPotShare;
      if (!pubkey) return raw;
      // Cap at the winner's ELIGIBLE pot. A player all-in for N can only win the
      // main pot — their own N matched by each opponent — never the side pots
      // they're not in. The precise amount is the chip-delta payout above, but
      // when that wasn't captured (settle hadn't landed on the one-shot showdown
      // tick) `splitPotShare` falls back to the WHOLE pot, so an 80-chip all-in
      // showed +4,080. eligible = Σ min(otherContribution, thisContribution); it
      // is always ≥ the winner's true take (equal for the largest stack → full
      // pot, so non-all-in winners are never clamped). totalBetThisHand survives
      // in the showdown snapshot, so contributions are intact here.
      const winner = players.find((p) => p?.pubkey === pubkey);
      if (!winner) return raw;
      const c = committedFor(winner);
      if (c <= 0) return raw;
      const eligible = players.reduce((sum, p) => sum + (p ? Math.min(committedFor(p), c) : 0), 0);
      return eligible > 0 ? Math.min(raw, eligible) : raw;
    },
    [showdownPayouts, splitPotShare, players],
  );

  const displayHandHistoryWithResults = useMemo(() => {
    if (!isShowdown || !isSplitPot || (showdownStage ?? 0) < 5 || !showdownResults) {
      return displayHandHistory;
    }
    const winners = players.filter(p => showdownResults.results[p.pubkey]?.isWinner);
    if (winners.length < 2) return displayHandHistory;
    const alreadyLogged = new Set(
      displayHandHistory
        .filter(e => e.phase === 'Result' && e.action.includes('SPLIT'))
        .map(e => e.player)
    );
    const splitRows = winners
      .map(w => ({
        player: w.pubkey === myPubkeyStr ? 'You' : shortWallet(w.pubkey),
        action: `SPLIT +${fmtVal(winnerPayout(w.pubkey))}`,
        phase: 'Result',
      }))
      .filter(row => !alreadyLogged.has(row.player));
    return splitRows.length ? [...displayHandHistory, ...splitRows] : displayHandHistory;
  }, [displayHandHistory, isShowdown, isSplitPot, showdownStage, showdownResults, players, myPubkeyStr, winnerPayout, fmtVal]);

  useEffect(() => {
    if (handLogRef.current && viewingPastHand === null) {
      handLogRef.current.scrollTop = handLogRef.current.scrollHeight;
    }
  }, [displayHandHistoryWithResults.length, viewingPastHand]);

  useEffect(() => {
    if (!isShowdown || (showdownStage ?? 0) < 5) return;
    const winners = players.filter(p => {
      const result = showdownResults?.results[p.pubkey];
      return result?.isWinner || (foldWinner && p.pubkey === foldWinner);
    });
    if (!winners.length) return;
    const animKey = `${handNumber}:${winners.map(w => w.seatIndex).join(',')}:${showdownPot || pot}`;
    if (winnerChipAnimRef.current === animKey) return;
    winnerChipAnimRef.current = animKey;

    const chips = winners.flatMap((winner, winnerIdx) => {
      const visualIdx = ((winner.seatIndex - heroSeatIdx) + maxSeats) % maxSeats;
      const pos = layout[visualIdx];
      if (!pos) return [];
      const leftPct = parseFloat(pos.left);
      const topPct = parseFloat(pos.top);
      const sx = (leftPct - 50) * 6;
      const sy = (topPct - 50) * 4;
      return [0, 1, 2, 3].map(k => ({
        key: `win-${animKey}-${winnerIdx}-${k}`,
        sx: sx + (k - 1.5) * 5,
        sy: sy + (k - 1.5) * 3,
        denom: k === 0 ? 'chip-gold' : k === 1 ? 'chip-bone' : 'chip-red',
        delay: winnerIdx * 90 + k * 45,
        direction: 'to-seat' as const,
      }));
    });
    if (!chips.length) return;
    setFlyingChips(prev => [...prev, ...chips]);
    const t = setTimeout(() => setFlyingChips(prev => prev.filter(c => !String(c.key).startsWith(`win-${animKey}`))), 1000);
    return () => clearTimeout(t);
  }, [isShowdown, showdownStage, handNumber, players, showdownResults, foldWinner, showdownPot, pot, heroSeatIdx, maxSeats, layout]);

  // Derive SB/BB seats
  const sbSeatIdx = players.find(p => p.position === 'SB')?.seatIndex ?? smallBlindSeat;
  const bbSeatIdx = players.find(p => p.position === 'BB')?.seatIndex ?? bigBlindSeat;
  // ─── FP-DEBUG: blind/button positions per render
  if (isFpDebugEnabled()) fpDebug(`positions hand=${handNumber} phase=${phase} sbSeatIdx=${sbSeatIdx} bbSeatIdx=${bbSeatIdx} dealerSeat=${dealerSeat} smallBlindSeat=${smallBlindSeat} bigBlindSeat=${bigBlindSeat} playersWithPosition=${players.filter(p => p.position).map(p => `${p.seatIndex}:${p.position}`).join(',')}`);

  // Derive the displayed dealer seat. The on-chain `dealer_button` field can
  // land on a waiting-for-BB / sitting-out player whose seat is not in the
  // current hand's rotation; SB/BB are always correct so we anchor off SB.
  // Heads-up: dealer = SB. 3+: dealer = first in-rotation seat counter-clockwise
  // from SB (the standard Hold'em rule).
  const sbHasPlayer = !!players.find(p => p?.position === 'SB');
  const inRotation = (seat: number) => {
    const p = players.find(x => x?.seatIndex === seat);
    return !!p && !p.isSittingOut;
  };
  const inRotationCount = players.filter(p => p && !p.isSittingOut).length;
  const effectiveDealerSeat = !sbHasPlayer
    ? dealerSeat
    : inRotationCount <= 2
      ? sbSeatIdx
      : (() => {
          for (let step = 1; step < maxSeats; step++) {
            const s = ((sbSeatIdx - step) % maxSeats + maxSeats) % maxSeats;
            if (inRotation(s)) return s;
          }
          return dealerSeat;
        })();

  // SNG cleanup ghost guard: a seat in the durable on-chain `eliminatedSeats`
  // list must NEVER render as an active nameplate, even if its seat status
  // transiently flips off Busted while the match settles / the table is prepped
  // for reuse. Without this, players who busted in EARLIER hands "reappear" with
  // 0 chips during the end-of-game teardown (the parse-level Busted filter at
  // useOnChainGame:784 misses them in that window because their status is
  // momentarily reset). The just-busted player of the CURRENT hand is not in
  // eliminatedSeats until this hand finishes settling, so their result still
  // shows. eliminatedCount resets to 0 on a fresh match, so this never filters
  // a reused table's new roster.
  const eliminatedSeatSet = (() => {
    if (isCashGame !== false) return null;
    const n = Math.min(eliminatedCount || 0, maxSeats);
    if (n <= 0) return null;
    const s = new Set<number>();
    for (let k = 0; k < n; k++) {
      const seat = eliminatedSeats[k];
      if (seat >= 0 && seat < maxSeats) s.add(seat);
    }
    return s.size ? s : null;
  })();

  // ── HeroCockpit scenario (SNG-aware) ────────────────────────────────────
  const heroScenario: HeroScenario | undefined = !isCashGame
    ? (() => {
        const alive = players.filter(p => p.isActive).sort((a, b) => b.chips - a.chips);
        const heroRank = myPlayer ? alive.findIndex(p => p.pubkey === myPlayer.pubkey) + 1 : 0;
        const itmCount = maxPlayers <= 2 ? 1 : maxPlayers <= 6 ? 2 : 3;
        const payouts = PAYOUT_BPS[maxPlayers] || PAYOUT_BPS[2];
        const avgStack = alive.length > 0
          ? Math.round(alive.reduce((s, p) => s + p.chips, 0) / alive.length)
          : 0;
        const emissionFormat = maxPlayers === 2 ? 0 : maxPlayers === 6 ? 1 : 2;
        let pokerPool = 0;
        try {
          // * 0.9 = the player pool after the 10% Royal Jackpot skim. The
          // projected $FP (the "Proj" chip) must reflect what the player
          // actually receives, not the gross emission before the royal cut.
          pokerPool = Number(calculateSngPoolUnrefined(emissionFormat, maxPlayers, BigInt(0), tier)) * 0.9 / 1_000_000;
        } catch { pokerPool = 0; }
        return {
          isSng: true,
          isHeroItm: heroRank > 0 && heroRank <= itmCount,
          heroPlace: heroRank || 1,
          bubblePlace: itmCount + 1,
          pokerPool,
          payouts,
          avgStack,
          blinds,
        };
      })()
    : { blinds };

  // ── Ceremony derivation (if not passed explicitly) ──────────────────────
  const derivedCeremony = useMemo<CeremonyPayload | null>(() => {
    if (ceremony) return ceremony;
    if (!isShowdown || showdownStage < 5 || !myPlayer) return null;
    const heroResult = showdownResults?.results[myPlayer.pubkey];
    const heroWon = heroResult?.isWinner || foldWinner === myPlayer.pubkey;
    if (!heroWon && heroResult && heroResult.hand.rank >= HandRank.FullHouse) {
      return { kind: 'bad-beat' };
    }
    if (!heroWon) return null;
    // Use the winner's REAL per-player gain (chip delta) for both split and
    // single-winner pops. A short-stack all-in winner only takes the capped /
    // matched amount, not the full pot — showing showdownPot||pot here
    // overstated it (e.g. +3000 when they actually won ~+2900). Falls back to
    // the pot total only when per-player data is unavailable.
    const amount = winnerPayout(myPlayer.pubkey);
    const anyAllIn = players.some(p => p.isAllIn);
    const visibleBoardCards = stagedCommunityCards.filter(c => c !== 255 && c >= 0 && c <= 51).length;
    if (foldWinner === myPlayer.pubkey && visibleBoardCards === 0 && heroResult && heroResult.hand.rank <= HandRank.HighCard) {
      return { kind: 'bluff', amount };
    }
    return { kind: anyAllIn ? 'all-in-won' : 'hand-won', amount };
  }, [ceremony, isShowdown, showdownStage, myPlayer, showdownResults, foldWinner, isSplitPot, winnerPayout, showdownPot, pot, players, stagedCommunityCards]);

  // Ceremony SFX firing
  useEffect(() => {
    if (!derivedCeremony) return;
    SFX.play(derivedCeremony.kind as any);
  }, [derivedCeremony?.kind]);

  // ── Render helpers ──────────────────────────────────────────────────────
  const phaseLabel: Record<string, string> = {
    Waiting: 'WAITING', PreFlop: 'PRE-FLOP', Flop: 'FLOP', Turn: 'TURN',
    River: 'RIVER', Showdown: 'SHOWDOWN', Complete: 'SHOWDOWN',
    SidePots: 'ALL-IN', BigPot: 'RIVER',
    FlopRevealPending: 'FLOP', TurnRevealPending: 'TURN', RiverRevealPending: 'RIVER',
  };
  // Reused SNG tables carry the PREVIOUS game's small/big blind on-chain until the next
  // start_game stamps tournamentStartTime. Pre-start, show the schedule's first level
  // instead of ghost blinds ("BLINDS 200/400 -> 15/30 at LEVEL 1" + every stack reading
  // "4bb" at 100bb - live finding 2026-07-03).
  const displayBlinds = (!isCashGame && !tournamentStartTime)
    ? { small: SNG_BLIND_LEVELS[0][0], big: SNG_BLIND_LEVELS[0][1] }
    : blinds;
  const blindsDisplay = isCashGame
    ? `${fmtVal(blinds.small)}/${fmtVal(blinds.big)} ${getTokenSymbol(tokenMint)}`
    : `${displayBlinds.small}/${displayBlinds.big}`;
  // Leaving players are exiting and won't be dealt into the next hand, so they
  // must not count toward "is the table ready to deal". Otherwise a table with
  // one real player plus several Leaving seats wrongly reads "WAITING FOR DEALER"
  // instead of "WAITING FOR PLAYERS".
  const seatedCount = players.filter(p => p.pubkey && p.pubkey !== '11111111111111111111111111111111' && !p.isLeaving).length;
  // SNG: a sitting-out seat IS dealt next hand (active_mask includes SittingOut),
  // so it counts as in-hand for the phase/waiting labels. Cash sit-out seats are
  // not dealt, so keep excluding them there.
  const activeCount = players.filter(p => p.pubkey && p.pubkey !== '11111111111111111111111111111111' && !p.isLeaving && (isCashGame === false ? true : !p.isSittingOut)).length;
  // Fold-win detection: contract transitions to Showdown/Complete on every
  // hand end, even when everyone except one player folded (no cards revealed,
  // see settle.rs:606 "winner doesn't need to show"). The label "SHOWDOWN"
  // is misleading in that case — show "SETTLING" instead.
  const nonFoldedCount = players.filter(p => p.pubkey && p.pubkey !== '11111111111111111111111111111111' && !p.folded && !p.waitingForBb).length;
  const isFoldWin = (phase === 'Showdown' || phase === 'Complete') && nonFoldedCount <= 1;
  const tablePhaseLabel = phase === 'Waiting' && seatedCount >= 2
    ? (activeCount >= 2 ? 'WAITING FOR DEALER' : 'WAITING')
    : isFoldWin
      ? 'SETTLING'
      : (phaseLabel[phase] || phase.toUpperCase());

  const toggleSound = useCallback(() => {
    const next = !soundOn;
    setSoundOn(next);
    SFX.setMuted(!next);
    SFX.play('ui-toggle');
  }, [soundOn]);

  const itmCount = maxPlayers <= 2 ? 1 : maxPlayers <= 6 ? 2 : 3;

  return (
    <div id="poker-table-root" data-bounty-table={bountyDuelFormat ? '' : undefined} className={cn("relative w-full max-w-[1440px] mx-auto px-0 md:px-5 pb-2 bg-ink grid grid-cols-1 gap-0 md:gap-4 md:h-[calc(100dvh-104px)] [@media(min-width:768px)_and_(max-height:500px)_and_(orientation:landscape)]:h-[calc(100dvh-60px)] md:min-h-0 md:overflow-hidden [@media(max-height:500px)_and_(orientation:landscape)]:h-[calc(100dvh-56px)] [@media(max-height:500px)_and_(orientation:landscape)]:min-h-0 [@media(max-height:500px)_and_(orientation:landscape)]:overflow-y-auto [@media(max-height:500px)_and_(orientation:landscape)]:overflow-x-hidden",
      railOpen ? "md:grid-cols-[minmax(0,1fr)_260px] xl:grid-cols-[minmax(0,1fr)_300px]" : "md:grid-cols-[minmax(0,1fr)_36px]")}>
      {/* ─── Left column: felt + cockpit + controls ──────────────────── */}
      <div
        className={cn(
        'relative flex flex-col gap-2 md:gap-3 md:min-h-0 md:h-full',
        '[@media(max-height:500px)_and_(orientation:landscape)]:gap-1',
        // The HeroCockpit is now hidden on every viewport (cards moved into the
        // action bar), so its grid track is gone — only felt + controls remain.
        // Landscape phones still flex-stack so the felt fills the height.
        '[@media(max-height:500px)_and_(orientation:landscape)]:!flex',
        'md:grid md:grid-cols-1',
        !isCashGame && tier !== undefined
          ? 'md:grid-rows-[auto_minmax(0,1fr)_108px]'
          : 'md:grid-rows-[minmax(0,1fr)_108px]'
      )}>

        {/* SNG status strip — 3-col: tier+buy-in · live stats · pool columns */}
        {!isCashGame && tier !== undefined && (() => {
          // TOURNAMENT alive count, not hand participation (HUD showed 4/6 vs standings
          // 5/6 because hand-folded players were dropped - live finding 2026-07-04).
          // Unlike the standings prop, THIS players array still contains busted seats:
          // busted = zero chips AND inactive; a folded player keeps chips, an all-in
          // player keeps isActive, a sit-out keeps isSittingOut.
          const aliveSng = players.filter(p => (p.chips ?? 0) > 0 || p.isActive || p.isSittingOut);
          const sortedAlive = [...aliveSng].sort((a, b) => b.chips - a.chips);
          const playersLeft = sortedAlive.length || seatedCount;
          const totalPlayers = maxPlayers;
          const avgStack = playersLeft > 0
            ? Math.round(aliveSng.reduce((s, p) => s + p.chips, 0) / playersLeft)
            : 0;
          const heroIdx = myPubkeyStr ? sortedAlive.findIndex(p => p.pubkey === myPubkeyStr) : -1;
          const heroPlace = heroIdx >= 0 ? heroIdx + 1 : playersLeft;
          const itm = totalPlayers <= 2 ? 1 : totalPlayers <= 6 ? 2 : 3;
          const isHeroItm = heroIdx >= 0 && heroPlace <= itm;
          const bubblePlace = itm + 1;
          const placeSfx = (n: number) => {
            const v = n % 100;
            if (v >= 11 && v <= 13) return 'th';
            switch (n % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; }
          };
          const emissionFormat = maxPlayers === 2 ? 0 : maxPlayers === 6 ? 1 : 2;
          // * 0.9 = player pool after the 10% Royal Jackpot skim (see the
          // projection above); show net $FP, not gross pre-skim emission.
          const pokerPool = Number(calculateSngPoolUnrefined(emissionFormat, maxPlayers, BigInt(0), tier)) * 0.9 / 1_000_000;
          const solPool = prizePool / 1e9;
          // Total buy-in = entry + fee from the tier ladder (e.g. Bronze = 0.10:
          // 0.09 prize + 0.01 fee). The header previously showed solPool/players,
          // which is only the ENTRY/prize component, understating it.
          const buyInSol = (TIERS[tier] ?? TIERS[0]).totalBuyIn / 1e9;
          const payoutsBps = PAYOUT_BPS[maxPlayers] || PAYOUT_BPS[2];
          // Project $FP at the hero's current rank. Non-ITM places (4-7 in
          // 9-max, 3-5 in 6-max) earn the trickle; last-out positions have
          // BPS=0 and naturally project 0. No isHeroItm gate.
          const heroBps = payoutsBps[heroPlace - 1] || 0;
          const heroProj = Math.round(pokerPool * heroBps / 10000);
          const avgBb = blinds.big > 0 ? Math.round(avgStack / blinds.big) : 0;
          // SnG Duels: replace the tier/buy-in strip with the non-invasive bounty HUD (tier · blinds ·
          // players · collected bounty · maturity). Buy-in/pool/standings move to the right-rail action bar.
          if (sngDuelsEnabled() && (maxPlayers === 6 || maxPlayers === 9)) {
            const nxt = SNG_BLIND_LEVELS[blindLevel + 1];
            return (
              <BountyHudBar
                table={tablePda}
                heroSeat={bountyHeroSeat}
                tierName={TIER_NAMES[tier] || 'Copper'}
                level={blindLevel}
                curBlinds={displayBlinds}
                nextBlinds={nxt ? { small: nxt[0], big: nxt[1] } : null}
                playersLeft={playersLeft}
                totalPlayers={totalPlayers}
                pokerPoolUnrefined={BigInt(Math.max(0, Math.round((bountyRail?.potFp ?? pokerPool ?? 0) * 1_000_000)))}
                solPrizePoolLamports={BigInt(Math.max(0, Math.round(prizePool || 0)))}
              />
            );
          }
          return (
            <div
              className="flex flex-col md:grid md:grid-cols-[auto_1fr_auto] items-start md:items-center gap-1 md:gap-4 px-3 md:px-4 py-1 md:py-2 glass-sub hairline"
              style={{ background: 'linear-gradient(180deg, rgba(242,106,31,0.05), rgba(242,106,31,0.01))' }}
            >
              {/* Left: tier chip + buy-in */}
              <div className="flex items-center gap-2">
                <span className={cn(
                  'px-1.5 py-[1px] rounded-sm border font-mono text-[10px] tracking-[0.2em] font-bold',
                  tier >= 4 ? 'border-amber/40 bg-amber/10 text-amber' : 'border-gold/40 bg-gold/10 text-gold'
                )}>
                  SNG · {(TIER_NAMES[tier] || 'COPPER').toUpperCase()}
                </span>
                {buyInSol > 0 && (
                  <span className="font-mono text-[10px] text-boneDim tracking-wider inline-flex items-center gap-1">
                    BUY-IN <span className="text-bone tabular-nums">{buyInSol.toFixed(3)}</span>
                    <img src="/tokens/sol.svg" alt="SOL" width={10} height={10} className="rounded-full opacity-90" />
                  </span>
                )}
              </div>
              {/* Mobile section divider (desktop's 3-zone grid separates these). */}
              <div className="md:hidden h-px w-full bg-gold/10" />
              {/* Middle: live stats. overflow-y-hidden is REQUIRED — with only
                  overflow-x:auto the spec computes overflow-y to auto, and a 1px
                  content overflow then spawns a spurious vertical scrollbar. */}
              <div className="flex items-center gap-3 md:gap-4 overflow-x-auto overflow-y-hidden md:justify-center w-full md:w-auto">
                <div className="flex flex-col items-center min-w-[52px]">
                  <span className="font-mono text-[9px] text-orange/70 tracking-[0.2em] leading-none uppercase">Level</span>
                  <span className="font-display font-semibold text-[15px] tabular-nums leading-none mt-1 text-bone">{blindLevel || 1}</span>
                  <span className="font-mono text-[9px] text-boneDim/70 tracking-wider mt-0.5 leading-none">{blinds.small}/{blinds.big}</span>
                </div>
                <div className="flex flex-col items-center min-w-[52px]">
                  <span className="font-mono text-[9px] text-orange/70 tracking-[0.2em] leading-none uppercase">Avg Stack</span>
                  <span className="font-display font-semibold text-[15px] tabular-nums leading-none mt-1 text-bone">{avgStack.toLocaleString()}</span>
                  <span className="font-mono text-[9px] text-boneDim/70 tracking-wider mt-0.5 leading-none">{avgBb} bb</span>
                </div>
                <div className="flex flex-col items-center min-w-[52px]">
                  <span className="font-mono text-[9px] text-orange/70 tracking-[0.2em] leading-none uppercase">Players</span>
                  <span className={cn('font-display font-semibold text-[15px] tabular-nums leading-none mt-1', isHeroItm ? 'text-gold' : 'text-orange')}>
                    {playersLeft}/{totalPlayers}
                  </span>
                  <span className="font-mono text-[9px] text-boneDim/70 tracking-wider mt-0.5 leading-none">
                    {isHeroItm ? 'ITM' : `bubble @ ${bubblePlace}`}
                  </span>
                </div>
                {heroIdx >= 0 && (
                  <div className="flex flex-col items-center min-w-[56px]">
                    <span className="font-mono text-[9px] text-orange/70 tracking-[0.2em] leading-none uppercase">Your Place</span>
                    <span className={cn('font-display font-semibold text-[15px] tabular-nums leading-none mt-1', isHeroItm ? 'text-gold' : 'text-bone')}>
                      {heroPlace}{placeSfx(heroPlace)}
                    </span>
                    <span className="font-mono text-[9px] text-boneDim/70 tracking-wider mt-0.5 leading-none">
                      {isHeroItm ? 'in the money' : 'not ITM'}
                    </span>
                  </div>
                )}
              </div>
              {sngDuelsEnabled() && (maxPlayers === 6 || maxPlayers === 9) && (
                <BountyDuelHud
                  table={tablePda}
                  heroSeat={bountyHeroSeat}
                  currentBlindLevel={blindLevel}
                  pokerPoolUnrefined={BigInt(Math.max(0, Math.round((bountyRail?.potFp ?? pokerPool ?? 0) * 1_000_000)))}
                  solPrizePoolLamports={BigInt(Math.max(0, Math.round(prizePool || 0)))}
                  className="shrink-0"
                />
              )}
              {/* Mobile section divider (desktop's 3-zone grid separates these). */}
              <div className="md:hidden h-px w-full bg-gold/10" />
              {/* Right: pool columns */}
              <div className="flex items-center gap-3 w-full md:w-auto">
                <div className="flex flex-col items-start md:items-end">
                  <span className="font-mono text-[9px] text-orange/80 tracking-[0.18em] leading-none inline-flex items-center gap-1">
                    <img src="/brand/app-icon.png" alt="$FP" width={10} height={10} className="rounded-full opacity-90" />
                    $FP POOL
                  </span>
                  <span className="font-display text-gold text-[15px] leading-none tabular-nums mt-0.5">
                    {pokerPool.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
                {solPool > 0 && (
                  <>
                    <div className="h-7 w-px bg-gold/15" />
                    <div className="flex flex-col items-start md:items-end">
                      <span className="font-mono text-[9px] text-orange/80 tracking-[0.18em] leading-none inline-flex items-center gap-1">
                        <img src="/tokens/sol.svg" alt="SOL" width={10} height={10} className="rounded-full opacity-90" />
                        POOL
                      </span>
                      <span className="font-display text-bone text-[15px] leading-none tabular-nums mt-0.5">{solPool.toFixed(2)}</span>
                    </div>
                  </>
                )}
                {isHeroItm && heroProj > 0 && (
                  <>
                    <div className="h-7 w-px bg-gold/15" />
                    <div className="flex flex-col items-start md:items-end">
                      <span className="font-mono text-[9px] text-amber/90 tracking-[0.18em] leading-none">YOUR PROJ</span>
                      <span className="font-display text-amber text-[15px] leading-none tabular-nums mt-0.5">
                        +{heroProj.toLocaleString()} $FP
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })()}

        {koFlash != null && (
          // absolute (not fixed): centers on the table column, which excludes the right rail.
          <div className="pointer-events-none absolute inset-0 z-[75] flex items-center justify-center" data-format="bounty">
            <div className="animate-in zoom-in-50 fade-in duration-500 flex flex-col items-center gap-2">
              <div className="font-display text-4xl sm:text-6xl md:text-7xl tracking-[0.16em] text-transparent bg-clip-text bg-gradient-to-b from-amber via-gold to-orange drop-shadow-[0_0_34px_rgba(255,198,58,0.55)]">
                {/* Flat bounty: points move only on knockouts (hand or duel bust), so the
                    burst is the bounty capture moment; tied splits burst too (fractional). */}
                {(bountyRail?.ruleset ?? 0) === 1 ? 'POINT TAKEN' : 'KNOCKOUT'}
              </div>
              <div className="rounded-full border border-amber/40 bg-black/75 px-4 py-1.5 font-display text-lg uppercase tracking-[0.2em] text-amber shadow-2xl">
                {(bountyRail?.ruleset ?? 0) === 1 ? 'Bounty point banked' : 'Bounty banked'}
              </div>
            </div>
          </div>
        )}

        {/* Glass-room containing the felt */}
        <div className="glass-room relative flex flex-col md:min-h-0 md:h-full">
          {/* Duel overlay: absolute-centered over the felt (this container excludes the right rail),
              and hidden the instant community cards land so it never covers the board. */}
          {sngDuelsEnabled() && !isCashGame && (maxPlayers === 6 || maxPlayers === 9) && (
            <DuelOverlay
              // COMPACT, not unmounted, while board cards are up: unmounting here killed the
              // resolve linger (the min-dwell timer lives inside the overlay), which the
              // [FP-EVT] timeline caught as overlay_shown-without-overlay_hidden. The compact
              // banner keeps the duel readable during its own run-out without covering the board.
              compact={(communityCards ?? []).some((c) => c !== 255 && c >= 0 && c <= 51)}
              table={tablePda}
              heroPubkey={myPubkeyStr}
              seatPubkey={(s) => players.find((pl) => pl.seatIndex === s)?.pubkey ?? null}
              seatName={(s) => {
                const p = players.find((pl) => pl.seatIndex === s);
                const key = p?.pubkey ?? rememberedSeatPubkey(s);
                return (key && profiles[key]?.username) || (key ? shortWallet(key) : `Seat ${s}`);
              }}
              onAction={onDuelAction
                ? (a, seatA, seatB) => onDuelAction(a, seatA, seatB)
                : undefined}
              // Flat Bounty stake context.
              alivePlayers={players.filter((p) => p.pubkey && !p.pubkey.startsWith('seat-')).length}
              blindLevel={blindLevel}
              smallBlind={blinds.small}
              bigBlind={blinds.big}
            />
          )}
          {/* Table info bar */}
          <div className="relative z-30 h-[42px] px-2 sm:px-3 md:px-4 hairline-b flex flex-nowrap items-center gap-2 md:gap-3 overflow-visible">
            <div className="flex items-center gap-1.5 sm:gap-2 md:gap-3 min-w-0 shrink-0 max-w-[48%] sm:max-w-[52%] lg:max-w-none overflow-hidden whitespace-nowrap">
              <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 shrink">
                <span className={cn('inline-block w-1.5 h-1.5 rounded-full',
                  phase === 'Waiting' ? 'bg-boneDim/40' : 'bg-orange animate-pulse')} />
                <span className="font-mono text-bone text-[10px] sm:text-[11px] tracking-[0.08em] sm:tracking-[0.14em] font-bold truncate max-w-[74px] sm:max-w-[112px] lg:max-w-[180px] xl:max-w-none">
                  {tablePhaseLabel}
                </span>
              </div>
              <div className="h-4 w-px bg-orange/15 shrink-0 hidden xs:block" />
              <div className="flex items-baseline gap-1 sm:gap-1.5 shrink-0">
                <Eyebrow className="hidden md:inline">Blinds</Eyebrow>
                <span className="font-mono text-bone text-[12px] tabular-nums leading-none">{blindsDisplay}</span>
              </div>
              <div className="h-4 w-px bg-orange/15 shrink-0" />
              <div className="flex items-baseline gap-1 sm:gap-1.5 shrink-0">
                <Eyebrow className="hidden md:inline">Seats</Eyebrow>
                <span className="font-mono text-bone text-[12px] tabular-nums leading-none">{seatedCount}/{maxSeats}</span>
              </div>
              {handNumber > 0 && (
                <>
                  <div className="h-4 w-px bg-orange/15 shrink-0 hidden xl:block" />
                  <span className="hidden xl:inline font-mono text-[10px] text-boneDim/70 tabular-nums shrink-0">Hand #{handNumber}</span>
                </>
              )}
            </div>
            <div className="relative h-full flex flex-1 min-w-0 items-center justify-end gap-1.5 sm:gap-2 whitespace-nowrap">
              {isMaintenance && (
                <span className="font-mono text-[9px] text-amber/80 tracking-wider animate-pulse">SYNCING...</span>
              )}

              {/* TIP JAR pill — cash games, mockup 1.4 */}
              {isCashGame && onOpenTipJar && (
                <button
                  onClick={() => { SFX.play('ui-tap'); onOpenTipJar(); }}
                  className="hidden xl:flex shrink-0 items-center gap-1.5 px-2 py-[3px] rounded-sm border border-amber/30 bg-amber/[0.06] hover:bg-amber/[0.14] hover:border-amber/50 transition group"
                  title="Tip the dealer. Per-table jar, 100% to the dealer of this table."
                >
                  <svg className="w-3 h-3 text-amber group-hover:scale-110 transition-transform" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C11 7 7 8 7 12c0 3 2 5 5 5s5-2 5-5c0-4-4-5-5-10zm0 13v5" strokeWidth="0" />
                  </svg>
                  <span className="hidden sm:inline font-mono text-[10px] tracking-wider text-amber font-bold leading-none">TIP JAR</span>
                  {tipJarHands > 0 && (
                    <>
                      <span className="h-3 w-px bg-amber/20" />
                      <span className="font-mono text-[10px] tabular-nums text-bone leading-none">{tipJarHands}h</span>
                    </>
                  )}
                </button>
              )}

              {/* Token badge */}
              <div
                className="hidden 2xl:flex shrink-0 items-center gap-1.5 px-2 py-[3px] rounded-sm text-[10px]"
                style={{
                  background: 'linear-gradient(180deg, rgba(153,69,255,0.12), rgba(20,241,149,0.08))',
                  border: '1px solid rgba(153,69,255,0.4)',
                }}
              >
                <img src={tokenLogo} alt="" className="w-3 h-3" />
                <span className="font-mono font-bold tracking-wider" style={{ color: '#B990FF' }}>
                  {getTokenSymbol(tokenMint)}
                </span>
              </div>

              {/* Share button */}
              {onShareTable && (
                <button
                  onClick={() => { SFX.play('ui-tap'); onShareTable(); }}
                  className="hidden 2xl:flex shrink-0 items-center gap-1.5 px-2 py-[3px] rounded-sm border border-gold/30 bg-gold/[0.06] hover:bg-gold/15 hover:border-gold/60 transition group"
                  title="Share this table"
                >
                  <svg className="w-3 h-3 text-gold" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="3" cy="6" r="1.4"/><circle cx="9" cy="3" r="1.4"/><circle cx="9" cy="9" r="1.4"/><path d="M4.3 5.3l3.4-1.8M4.3 6.7l3.4 1.8"/></svg>
                  <span className="hidden lg:inline font-mono text-[10px] tracking-[0.2em] text-gold font-bold leading-none">SHARE</span>
                </button>
              )}

              {/* Sound toggle */}
              <button
                onClick={toggleSound}
                className={cn(
                  'hidden xl:inline-flex shrink-0 p-1 rounded border transition-colors',
                  soundOn ? 'text-orange border-orange/20 hover:border-orange/40' : 'text-boneDim/40 border-bone/10 hover:border-bone/20'
                )}
                title={soundOn ? 'Mute' : 'Unmute'}
              >
                {soundOn
                  ? <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" /></svg>
                  : <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>}
              </button>
              {/* Sit-out controls — compact toolbar variant.
                  When sitting out, the action-bar card carries the CTAs
                  (I'M BACK button in C2, YES/NO prompt in C, emerald status
                  in C-HU). Toolbar sit-in arm is suppressed to avoid two
                  competing surfaces for the same action. */}
              {myPlayer && isCashGame !== false && !isMeSittingOut && (
                !autoPostBlinds ? (
                  <button
                    data-testid="action-cancel-sitout"
                    onClick={() => { SFX.play('ui-click'); setAutoPostBlinds?.(true); }}
                    className="shrink-0 flex items-center gap-1.5 px-2 py-[3px] rounded-sm border border-emerald-500/40 bg-emerald-500/[0.08] hover:bg-emerald-500/15 transition"
                    title="Cancel sit-out request"
                  >
                    <span className="font-mono text-[10px] tracking-[0.1em] lg:tracking-[0.2em] text-emerald-300 font-bold leading-none">SIT OUT</span>
                  </button>
                ) : (
                  <button
                    data-testid="action-sit-out"
                    onClick={() => { SFX.play('ui-click'); onSitOut?.(); }}
                    disabled={sittingOutPending}
                    className="shrink-0 flex items-center gap-1.5 px-2 py-[3px] rounded-sm border border-bone/20 bg-bone/[0.06] hover:bg-bone/10 transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Sit out next hand"
                  >
                    <span className="font-mono text-[10px] tracking-[0.1em] lg:tracking-[0.2em] text-boneDim font-bold leading-none">
                      {sittingOutPending ? 'SITTING OUT…' : 'SIT OUT'}
                    </span>
                  </button>
                )
              )}

              {/* Leave table — CASH only. You can't leave an SNG mid-tournament
                  (you're committed until you bust or win); exiting a finished SNG
                  is handled by the end-of-game overlay, not this header button. */}
              {onLeaveTable && isCashGame && (
                <button
                  onClick={() => { SFX.play('ui-tap'); onLeaveTable(); }}
                  disabled={leavingTable}
                  className="shrink-0 flex items-center gap-1.5 px-2 py-[3px] rounded-sm border border-rose-500/30 bg-rose-500/[0.08] hover:bg-rose-500/15 hover:border-rose-500/55 transition group disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Leave this table"
                >
                  <svg className="w-3 h-3 text-rose-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                    <span className="font-mono text-[10px] tracking-[0.1em] lg:tracking-[0.2em] text-rose-300 font-bold leading-none">
                    {leavingTable ? 'LEAVING…' : 'LEAVE'}
                  </span>
                </button>
              )}

              {/* Duel tables: the rail's verify footer already shows "VRF · TEE ok"; one is enough. */}
              {!bountyDuelFormat && (
                <>
                  <div className="hidden 2xl:block h-4 w-px bg-orange/15 shrink-0" />
                  <div className="hidden 2xl:flex shrink-0 items-center gap-1.5" title="TEE connection status">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
                    <span className="hidden lg:inline font-mono text-[10px] text-boneDim tracking-wider">TEE</span>
                    <span className="hidden sm:inline font-mono text-[10px] text-emerald-300">ok</span>
                  </div>
                </>
              )}
              {/* Mobile chat now lives on the nav chat bubble (#nav-landscape-chat-btn
                  in Navbar.tsx, portrait + landscape). The old in-bar CHAT button
                  was a redundant second entry point and has been removed. */}
              <button
                type="button"
                onClick={() => { SFX.play('ui-click'); setShowTableMenu(v => !v); }}
                className={cn(
                  'shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-sm border transition',
                  showTableMenu
                    ? 'border-orange/50 bg-orange/15 text-orange'
                    : 'border-bone/15 bg-bone/[0.04] text-boneDim hover:border-orange/35 hover:text-orange'
                )}
                title="Table options"
                aria-label="Table options"
                aria-expanded={showTableMenu}
              >
                <Menu className="w-3.5 h-3.5" />
              </button>
              {showTableMenu && (() => {
                // Mobile portrait + landscape phones get a full-screen takeover so
                // the tall menu (TOKEN / RAKE / CARDS) is never clipped or runs off
                // the bottom; desktop keeps the anchored, scroll-capped dropdown.
                const menuFullscreen = isMobile || isLandscape;
                return (
                <div className={cn(
                  'z-[999]',
                  menuFullscreen
                    // Solid opaque takeover so the felt never bleeds through.
                    // Starts below the sticky navbar (h-[64px] / z-50): the menu
                    // is nested in the table's stacking context so it can't paint
                    // over the navbar, and an inset-0 panel would bury the close
                    // button under it. top-16 (64px) keeps the close icon reachable.
                    ? 'fixed inset-x-0 bottom-0 top-16 flex flex-col bg-[#070706]'
                    : 'absolute right-0 top-[calc(100%+6px)] w-60 rounded-md border border-orange/20 bg-[#070706]/95 backdrop-blur-md shadow-[0_18px_60px_rgba(0,0,0,0.55)] overflow-y-auto overscroll-contain max-h-[calc(100dvh-120px)]'
                )} style={{ animation: 'fade-in 120ms ease-out' }}>
                  <div className="px-3 py-2 border-b border-orange/10 flex items-center justify-between shrink-0">
                    <span className="font-mono text-[9px] tracking-[0.24em] text-orange/80">TABLE</span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-[9px] text-emerald-300 inline-flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
                        TEE OK
                      </span>
                      {menuFullscreen && (
                        <button
                          type="button"
                          onClick={() => { SFX.play('ui-tap'); setShowTableMenu(false); }}
                          aria-label="Close table options"
                          className="w-7 h-7 -mr-1 flex items-center justify-center rounded-md text-boneDim hover:text-orange hover:bg-orange/10 transition"
                        >
                          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path d="M6 6l12 12M18 6L6 18" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                  <div className={cn('p-1.5 space-y-1', menuFullscreen && 'flex-1 overflow-y-auto overscroll-contain')}>
                    {isCashGame && onOpenTipJar && (
                      <button
                        type="button"
                        onClick={() => { SFX.play('ui-tap'); setShowTableMenu(false); onOpenTipJar(); }}
                        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-sm text-left hover:bg-amber/[0.10] transition"
                      >
                        <Coins className="w-3.5 h-3.5 text-amber" />
                        <span className="font-mono text-[10px] tracking-[0.16em] text-amber font-bold">TIP JAR</span>
                        {tipJarHands > 0 && <span className="ml-auto font-mono text-[10px] text-bone">{tipJarHands}h</span>}
                      </button>
                    )}
                    {onShareTable && (
                      <button
                        type="button"
                        onClick={() => { SFX.play('ui-tap'); setShowTableMenu(false); onShareTable(); }}
                        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-sm text-left hover:bg-gold/[0.10] transition"
                      >
                        <Share2 className="w-3.5 h-3.5 text-gold" />
                        <span className="font-mono text-[10px] tracking-[0.16em] text-gold font-bold">SHARE TABLE</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={toggleSound}
                      className="w-full flex items-center gap-2 px-2.5 py-2 rounded-sm text-left hover:bg-bone/[0.08] transition"
                    >
                      {soundOn ? <Volume2 className="w-3.5 h-3.5 text-orange" /> : <VolumeX className="w-3.5 h-3.5 text-boneDim" />}
                      <span className="font-mono text-[10px] tracking-[0.16em] text-bone font-bold">{soundOn ? 'SOUND ON' : 'SOUND OFF'}</span>
                    </button>
                    <div className="mx-2 my-1 h-px bg-orange/10" />
                    <div className="flex items-center justify-between gap-3 px-2.5 py-1.5">
                      <span className="font-mono text-[9px] tracking-[0.18em] text-boneDim">TOKEN</span>
                      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold" style={{ color: '#B990FF' }}>
                        <img src={tokenLogo} alt="" className="w-3 h-3" />
                        {getTokenSymbol(tokenMint)}
                      </span>
                    </div>
                    {isCashGame && (
                      <div className="flex items-center justify-between gap-3 px-2.5 py-1.5">
                        <span className="font-mono text-[9px] tracking-[0.18em] text-boneDim">RAKE</span>
                        <span className="font-mono text-[10px] text-bone font-bold">
                          {(rakeBps / 100).toFixed(rakeBps % 100 ? 2 : 0)}%
                          <span className="text-boneDim/70 font-normal">
                            {rakeCap > 0 ? ` · cap ${fmtVal(rakeCap)} ${getTokenSymbol(tokenMint)}` : ' · uncapped'}
                          </span>
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3 px-2.5 py-1.5">
                      <span className="font-mono text-[9px] tracking-[0.18em] text-boneDim">SHOW USD</span>
                      <button
                        type="button"
                        onClick={() => {
                          if (!(isCashGame && tokenIsSol)) return;
                          SFX.play('ui-toggle');
                          setCardPrefs({ showFiat: !cardPrefsForFmt.showFiat });
                        }}
                        disabled={!(isCashGame && tokenIsSol)}
                        title={
                          !isCashGame
                            ? 'USD display is only available on cash games'
                            : !tokenIsSol
                              ? 'USD display is only available on SOL games right now'
                              : cardPrefsForFmt.showFiat
                                ? `Showing USD at $${prices.solPrice.toFixed(2)}/SOL — click to switch back to SOL`
                                : 'Click to show amounts in USD'
                        }
                        className={cn(
                          'inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.18em] px-2 py-0.5 rounded-sm border transition',
                          !(isCashGame && tokenIsSol)
                            ? 'border-bone/10 bg-bone/[0.03] text-boneDim/40 cursor-not-allowed'
                            : cardPrefsForFmt.showFiat
                              ? 'border-emerald-400/50 bg-emerald-400/[0.10] text-emerald-300 hover:bg-emerald-400/15'
                              : 'border-bone/15 bg-bone/[0.04] text-boneDim hover:border-bone/30 hover:text-bone',
                        )}
                      >
                        {!(isCashGame && tokenIsSol) ? 'SOL ONLY' : cardPrefsForFmt.showFiat ? 'ON · USD' : 'OFF · SOL'}
                      </button>
                    </div>
                    <div className="mx-2 my-1 h-px bg-orange/10" />
                    <CardPrefsSection />
                  </div>
                </div>
                );
              })()}
            </div>
          </div>

          {/* Felt */}
          <div className="felt-wrap">
            <div className="felt-oval">
              <div className="felt-inlay" />

              {/* Token watermarks — flanking left and right, no center logo */}
              <div className="absolute inset-y-0 left-[8%] [@media(orientation:landscape)_and_(max-height:500px)]:left-[14%] flex items-center pointer-events-none z-0">
                <img src={tokenLogo} alt="" className="w-24 md:w-28 [@media(orientation:landscape)_and_(max-height:500px)]:w-28 opacity-[0.07]" />
              </div>
              <div className="absolute inset-y-0 right-[8%] [@media(orientation:landscape)_and_(max-height:500px)]:right-[14%] flex items-center pointer-events-none z-0">
                <img src={tokenLogo} alt="" className="w-24 md:w-28 [@media(orientation:landscape)_and_(max-height:500px)]:w-28 opacity-[0.07]" />
              </div>

              {/* Hero hole cards in table-view now render INSIDE the hero seat
                  (PlayerSeat card layer) at z-20 — in front of the avatar but
                  under the nameplate, matching the opponents' GG layering. The
                  old felt-center z-[5] render (which sat behind the whole seat)
                  was removed so the cards no longer hide behind the avatar. */}

              {/* Maintenance overlay */}
              {isMaintenance && (
                <div className="absolute inset-0 z-[100] flex items-center justify-center bg-ink/40 backdrop-blur-md rounded-[70px]">
                  <div className="flex flex-col items-center gap-4 p-6 rounded-3xl bg-ink/80 border border-emerald-500/30">
                    <div className="relative w-10 h-10">
                      <div className="absolute inset-0 border-4 border-emerald-500/20 rounded-full" />
                      <div className="absolute inset-0 border-4 border-emerald-400 rounded-full border-t-transparent animate-spin" />
                    </div>
                    <div className="text-center">
                      {(() => {
                        // The L1 maintenance window covers three different operations.
                        // The same overlay used to always claim "Dealer Tally Sync",
                        // which lied when the table was actually being set up or torn
                        // down. Pick copy from the on-chain signals we already have.
                        const isSng = isCashGame === false;
                        const seated = (players || []).filter((p) => p && p.pubkey);
                        const survivors = seated.filter((p) => (p.chips ?? 0) > 0);
                        // The L1 window can be caught at any point of the TEE's
                        // Complete → Waiting → Starting cycle. Use the phase (the SAME
                        // signal the header's "WAITING FOR DEALER" label reads) to tell
                        // a finished-hand SETTLE apart from the SETUP for the next hand
                        // — "Tally" was wrongly shown for both before.
                        const justFinishedHand = phase === 'Complete' || phase === 'Showdown';
                        const awaitingStart = phase === 'Waiting' || phase === 'Starting';
                        // SNG reuse: reset_sng_table zeroes tournament_start_slot but
                        // does NOT reset hand_number (it's table-lifetime monotonic), so
                        // a reused table's NEXT TOURNAMENT begins at handNumber > 0 —
                        // which would otherwise read as "next hand". tournamentStartTime
                        // is set on the tournament's first hand and 0 only between games,
                        // so for an SNG it's the reliable "a new game is forming" flag.
                        const newSngGame = isSng && (tournamentStartTime ?? 0) === 0;
                        // Default: neither clearly finished nor clearly starting (rare
                        // mid-hand blip) — a neutral, always-true description.
                        let title = 'Syncing On-Chain';
                        let subtitle = 'Confirming the table state';
                        if (newSngGame) {
                          // Reused SNG table being set up for the NEXT tournament (the
                          // previous one just finished). Checked first: after reset the
                          // seats are cleared, so a forming game could otherwise look like
                          // a 1-survivor "wrapping up".
                          const n = seated.length || currentPlayers || 0;
                          title = 'Setting Up Next Game';
                          subtitle = n > 0
                            ? `Seating players for the next tournament · ${n}/${maxPlayers}`
                            : 'Starting a new tournament on-chain';
                        } else if (handNumber <= 0) {
                          // No hand dealt yet — the table is being assembled on L1
                          // (SNG seat_from_pool, or a fresh cash table) before it
                          // delegates to the dealer engine.
                          const n = seated.length || currentPlayers || 0;
                          title = 'Seating Players';
                          subtitle = n > 0
                            ? `Setting up the table on-chain · ${n}/${maxPlayers}`
                            : 'Setting up the table on-chain';
                        } else if (isSng && survivors.length <= 1) {
                          // SNG down to a single chip-holder — the tournament is over
                          // and the table is paying out + closing.
                          title = 'Wrapping Up';
                          subtitle = 'Paying out and closing the table';
                        } else if (justFinishedHand) {
                          // A hand just ended → the crank is securing rake + payouts.
                          title = 'Dealer Tally Sync';
                          subtitle = 'Securing rake and payouts on-chain';
                        } else if (awaitingStart) {
                          // Between hands / waiting for the dealer to deal the next one.
                          title = 'Setting Up Next Hand';
                          subtitle = 'Syncing the table on-chain for the next deal';
                        }
                        return (
                          <>
                            <h3 className="text-white font-bold text-base mb-1">{title}...</h3>
                            <p className="text-emerald-400/80 text-xs">{subtitle}</p>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              )}

              {/* Community centered with pot floating top-right of board and
                  system message floating directly above center of board. Both
                  ride inside the scaled wrapper so they never crash seats. */}
              <div className="absolute inset-0 flex items-center justify-center felt-center">
                <div className="scale-[0.72] md:scale-100 origin-center">
                  <div className="relative flex flex-col items-center">
                    {displayPot > 0 && (
                      <div
                        key={`pot-${potPulse}`}
                        className={cn('absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-10', potPulse > 0 && 'animate-potGrow')}
                      >
                        {sidePots && sidePots.length > 0 && displayPot === pot ? (
                          <SidePotFan mainPot={displayPot} sidePots={sidePots} fmtVal={fmtVal} bigBlind={blinds.big} />
                        ) : (
                          <PotDisplay amount={displayPot} fmtVal={fmtVal} pulsing={potPulse > 0} bigBlind={blinds.big} />
                        )}
                      </div>
                    )}
                    {/* System message floats above the community board so it
                        scales with the felt and never crashes seats / opponent
                        chips on heads-up. Mockup 1.4 chip style preserved. */}
                    {(() => {
                      // DuelOverlay owns the felt while a duel is active. Rendering the
                      // normal phase status at the same time lets inter-hand Waiting text
                      // cut through the duel/tiebreak header on wide layouts.
                      if (bountySeatState?.duelActive) return null;

                      const nonFoldedCount = players.filter(p => !p.folded && p.isActive && !p.waitingForBb).length;
                      // A fold-win means the pot was uncontested — no hands shown.
                      // This used to FALSELY trip after an all-in SHOWDOWN whose
                      // loser busts: the loser leaves `players` (count → 1) AND, if
                      // their revealed cards never reached us, showdownResults has no
                      // winnerKey. So also require that fewer than 2 hands were
                      // revealed this hand. revealedHoleCardsRef latches every seat
                      // shown and survives the loser busting, so a real showdown
                      // (≥2 revealed) is never mislabeled "WON BY FOLD".
                      const revealedSeatCount = revealedHoleCardsRef.current.map.size;
                      const isFoldWin = isShowdown && nonFoldedCount <= 1
                        && !showdownResults?.winnerKey && revealedSeatCount < 2;

                      type Tone = 'gold' | 'orange' | 'amber' | 'bone' | 'muted' | 'emerald';
                      let text: string | null = null;
                      let sub: string | null = null;
                      let tone: Tone = 'muted';

                      if (phase === 'Waiting') {
                        const needed = Math.max(0, 2 - seatedCount);
                        if (needed > 0 || seatedCount === 0) {
                          text = 'WAITING FOR PLAYERS';
                          sub = seatedCount === 0
                            ? (isCashGame ? 'click a seat to join' : 'seats open')
                            : `${needed} more seat${needed > 1 ? 's' : ''} to start`;
                          tone = 'muted';
                        } else if (activeCount < 2) {
                          text = 'WAITING FOR OPPONENT';
                          sub = 'opponent sitting out';
                          tone = 'muted';
                        } else {
                          // Inter-hand idle gap (settled, ≥2 active, crank hasn't
                          // fired start_game yet). CONSTANT header so the pill
                          // doesn't resize/flicker; the real WS-fed phase shows
                          // in the sub. Waiting = deck being shuffled for the
                          // next hand.
                          text = 'WAITING FOR DEALER';
                          sub = 'shuffling deck';
                          tone = 'orange';
                        }
                      } else if (phase === 'Starting') {
                        // start_game landed on-chain, tee_deal pending — cards
                        // are about to hit the felt. Previously this phase fell
                        // through every branch and the message vanished (the
                        // "sometimes it shows nothing" gap). Same constant header
                        // as Waiting; sub reflects the real next step.
                        text = 'WAITING FOR DEALER';
                        sub = 'dealing cards';
                        tone = 'orange';
                      } else if (streetBanner) {
                        text = streetBanner;
                        sub = streetBanner === 'FLOP' ? 'three cards on the felt'
                          : streetBanner === 'TURN' ? 'fourth card'
                          : 'final card';
                        tone = 'gold';
                      } else if (isShowdown) {
                        const anyAllIn = players.some(p => p.isAllIn);
                        const visibleBoardCards = stagedCommunityCards.filter(c => c !== 255 && c >= 0 && c <= 51).length;
                        const isRunout = anyAllIn && visibleBoardCards < 5;
                        if (isFoldWin) {
                          text = 'WON BY FOLD';
                          sub = null;
                          tone = 'emerald';
                        } else if (showdownStage >= 5) {
                          if (isSplitPot) {
                            text = 'SPLIT POT';
                            sub = `chop ${fmtVal(splitPotShare)} each`;
                            tone = 'amber';
                          } else {
                            text = 'SETTLING HAND';
                            sub = 'awarding pot';
                            tone = 'bone';
                          }
                        } else if (!isRunout) {
                          // Final showdown (board complete). During an all-in
                          // RUNOUT we deliberately show NOTHING here: the
                          // streetBanner pops FLOP / TURN / RIVER as each card
                          // lands, and any steady status would have to derive
                          // from showdownStage, which restarts each time the
                          // contract re-enters a Showdown phase mid-runout and
                          // bursts all three names before the river.
                          text = 'SHOWDOWN';
                          sub = 'revealing hands';
                          tone = 'gold';
                        }
                      }

                      if (!text) return null;

                      const tones: Record<Tone, { border: string; bg: string; text: string; accent: string }> = {
                        gold:    { border: 'rgba(255,217,106,0.45)', bg: 'rgba(255,217,106,0.08)', text: '#FFD96A', accent: '#FFD96A' },
                        orange:  { border: 'rgba(242,106,31,0.45)',  bg: 'rgba(242,106,31,0.08)',  text: '#FFC16A', accent: '#F26A1F' },
                        amber:   { border: 'rgba(255,198,58,0.45)',  bg: 'rgba(255,198,58,0.08)',  text: '#FFC63A', accent: '#FFC63A' },
                        bone:    { border: 'rgba(245,241,230,0.25)', bg: 'rgba(245,241,230,0.05)', text: '#F5F1E6', accent: '#F5F1E6' },
                        muted:   { border: 'rgba(245,241,230,0.14)', bg: 'rgba(10,13,16,0.6)',     text: 'rgba(245,241,230,0.7)', accent: 'rgba(245,241,230,0.4)' },
                        emerald: { border: 'rgba(16,185,129,0.45)',  bg: 'rgba(16,185,129,0.10)',  text: '#34D399', accent: '#34D399' },
                      };
                      const t = tones[tone];
                      return (
                        <div
                          key={text}
                          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-20 pointer-events-none select-none whitespace-nowrap"
                        >
                          <div
                            className="flex items-center gap-2.5 px-3.5 py-1.5 rounded-sm"
                            style={{
                              border: `1px solid ${t.border}`,
                              background: `linear-gradient(180deg, ${t.bg}, rgba(10,13,16,0.5))`,
                              backdropFilter: 'blur(8px)',
                              WebkitBackdropFilter: 'blur(8px)',
                              boxShadow: '0 2px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
                            }}
                          >
                            <span className="flex gap-[3px]">
                              <span className="inline-block w-1 h-1 rounded-full animate-pulse" style={{ background: t.accent, animationDelay: '0ms' }} />
                              <span className="inline-block w-1 h-1 rounded-full animate-pulse" style={{ background: t.accent, animationDelay: '200ms' }} />
                              <span className="inline-block w-1 h-1 rounded-full animate-pulse" style={{ background: t.accent, animationDelay: '400ms' }} />
                            </span>
                            <div className="flex flex-col leading-none">
                              <span className="font-display font-semibold tracking-[0.22em] text-[11px]" style={{ color: t.text }}>{text}</span>
                              {sub && <span className="font-mono text-[9px] tracking-wider text-boneDim/70 mt-1">{sub}</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    <CommunityBoard
                      cards={stagedCommunityCards}
                      size={communityCardSize(cardPrefsForFmt.cardSize, maxSeats)}
                      animateKey={handNumber}
                    />
                  </div>
                </div>
              </div>

              {/* Flying chips to pot (FlyingChip pattern from chips.jsx) */}
              {flyingChips.length > 0 && (
                <div className="absolute top-1/2 left-1/2 z-30 pointer-events-none" style={{ transform: 'translate(-50%,-50%)' }}>
                  {flyingChips.map(chip => (
                    <FlyingChip
                      key={chip.key}
                      sx={chip.sx}
                      sy={chip.sy}
                      denom={chip.denom}
                      delay={chip.delay}
                      size={14}
                      direction={chip.direction}
                    />
                  ))}
                </div>
              )}

              {/* Seats — rendered top-to-bottom (sorted by layout top%) so that at
                  showdown a lower seat's revealed cards, which extend UPWARD out of
                  the seat, paint ABOVE the nameplate of the seat above it. Each seat
                  wrapper has its own transform (a stacking context), so a card's
                  z-index can't beat a different seat's plate cross-wrapper — only the
                  wrapper order does. Revealed seats all share z-30, so DOM order is
                  the tiebreaker between them; painting the lower seat last puts its
                  upward cards over the upper neighbour's plate. Layout is absolute, so
                  reordering the DOM moves nothing, and key={i} keeps React from
                  remounting the seats. */}
              {layout
                .map((rawPos, visualIdx) => ({ rawPos, visualIdx }))
                .sort((a, b) => parseFloat(a.rawPos.top) - parseFloat(b.rawPos.top))
                .map(({ rawPos, visualIdx }) => {
                const topPct = parseFloat(rawPos.top);
                const leftPct = parseFloat(rawPos.left);
                const isTopSide = topPct < 50 && Math.abs(leftPct - 50) > 20;
                const pos = isTopSide
                  ? isLandscape
                    ? { ...rawPos, top: `calc(${rawPos.top} + 30px)` }
                    : isMobile
                      ? { ...rawPos, top: `calc(${rawPos.top} - 30px)` }
                      : rawPos
                  : rawPos;
                const i = (visualIdx + heroSeatIdx) % maxSeats;
                const seatMap = new Map<number, Player>();
                players.forEach(p => { if (p) seatMap.set(p.seatIndex, p); });
                // Run-out ghost: a seat busted by THIS showdown (duel or all-in) stays on the
                // felt with its revealed cards until the ceremony ends - the chain vacates the
                // seat and the sidecar stamps it eliminated before the staged board finishes,
                // which dropped the busted duelist's hand mid-run-out (only the winner's cards
                // survived). Ceremony window = the same latch that paces the board.
                const ceremonyGhost = (showdownClockArmed || inShowdownWindow)
                  ? revealedSeatGhostRef.current.map.get(i)
                  : undefined;
                // Eliminated seats (durable) always render empty/BUSTED — see
                // eliminatedSeatSet above (kills the end-game "ghosts reappear"
                // artifact during SNG teardown) — EXCEPT while their bust's own
                // ceremony is still playing (ghost above; it expires with the
                // ceremony latch, so teardown behavior is unchanged after it).
                const rawP = eliminatedSeatSet?.has(i)
                  ? (ceremonyGhost ?? null)
                  : (seatMap.get(i) ?? ceremonyGhost ?? null);
                // Backfill from sticky cache: contract clears revealedHands on
                // every phase transition during an all-in runout, which made
                // opponent cards flicker visible/hidden each street. Once we
                // see valid cards in-hand, keep showing them.
                const p = (() => {
                  if (!rawP) return rawP;
                  // DUEL rule (2026-07-03): between-hands duel showdowns must show cards at
                  // the TWO duelist seats only. Everyone else's cards - stale reveals from
                  // the finished hand, still valid in live state until the next deal - are
                  // force-hidden, or the whole table reads as "in the duel".
                  if (
                    bountySeatState?.duelActive &&
                    rawP.seatIndex !== bountySeatState.duelSeatA &&
                    rawP.seatIndex !== bountySeatState.duelSeatB
                  ) {
                    return { ...rawP, holeCards: [255, 255] as [number, number] };
                  }
                  const stick = revealedHoleCardsRef.current.map.get(rawP.seatIndex);
                  const liveCards = rawP.holeCards;
                  const liveInvalid = !liveCards || liveCards[0] === 255 || liveCards[1] === 255;
                  if (stick && liveInvalid) {
                    return { ...rawP, holeCards: [...stick] as [number, number] };
                  }
                  return rawP;
                })();
                // Voluntary off-chain card show (post-hand). Only trust a show
                // whose signer matches THIS seat's on-chain approved_signer
                // (anti-spoof). Inject the cards only when the seat has none
                // live, so they render face-up like a normal reveal.
                // Gated by SHOW_CARDS_ENABLED: while the feature is disabled,
                // NEVER inject/render relayed cards — a hard gate so no path can
                // surface a player's hand off-chain. (Trigger is also disabled.)
                const showEntry = (SHOW_CARDS_ENABLED && p) ? shownCards[i] : undefined;
                const verifiedShow = (showEntry && p?.approvedSigner && showEntry.signer === p.approvedSigner)
                  ? showEntry.cards
                  : null;
                const pShown = (verifiedShow && p && (!p.holeCards || p.holeCards[0] === 255 || p.holeCards[1] === 255))
                  ? { ...p, holeCards: verifiedShow as [number, number] }
                  : p;
                const pKey = p?.pubkey;
                const playerResult = pKey && showdownResults?.results[pKey];
                const seatAction = p ? playerActions.find(a => a.seatIndex === i) : undefined;
                const isWinnerSeat = playerResult ? playerResult.isWinner : (foldWinner && pKey === foldWinner);
                const uncalledReturn = p ? (potUi.uncalledByPubkey[p.pubkey] || 0) : 0;
                // Show the player's CURRENT bet on this street (including the
                // posted blind for SB/BB). Previously this subtracted the
                // streetStartBetsRef baseline — which was seeded to the
                // blinds at hand start, making BB's posted blind invisible
                // while SB's call/raise above the blind still showed. The
                // street→street fly animation reads from a separate baseline
                // (prevBetsRef + streetStartBetsRef inside the effect at
                // line ~3107), so chips still fly to pot exactly once per
                // street transition. Uncalled returns still subtract here
                // so a fold-win winner doesn't show their own returned bet.
                //
                // During Showdown (stages 0-4), substitute the snapshot
                // captured at the moment phase entered Showdown — keeps the
                // chip stacks visible while cards flip and until the winner
                // banner appears at stage 5. The snapshot clears 1.2s after
                // stage 5 fires (see useEffect above).
                const snapshotBet = showdownBetSnapshot[i];
                const isHoldingShowdownSnapshot =
                  phase === 'Showdown' && snapshotBet != null && showdownStage < 5;
                const rawAmountThisStreet = isHoldingShowdownSnapshot
                  ? snapshotBet
                  : (p ? p.bet : 0);
                const amountThisStreet = Math.max(0, rawAmountThisStreet - uncalledReturn);
                const displayTotalBet = p ? Math.max(0, committedFor(p) - uncalledReturn) : 0;
                const isHero = p?.pubkey === myPubkeyStr;
                const isDealer = i === effectiveDealerSeat;
                const isSB = i === sbSeatIdx;
                const isBB = i === bbSeatIdx;
                const profile = pKey ? profiles[pKey] : null;
                // Avatar resolution: prefer the explicit imageUrl (new PFPs +
                // wallet NFTs), then fall back to AVATAR_OPTIONS by id, then
                // legacy `avatarUrl` field.
                const profileImageUrl = profile?.avatarImageUrl
                  || (profile?.avatarValue ? getAvatarById(profile.avatarValue)?.image : null)
                  || (profile?.avatarUrl ? getAvatarById(profile.avatarUrl)?.image : null)
                  || null;
                const avatarObj = profile?.avatarUrl ? getAvatarById(profile.avatarUrl) : null;

                return (
                  <PlayerSeat
                    key={i}
                    player={pShown}
                    voluntaryShow={!!verifiedShow}
                    latchedFolded={liveFoldedRef.current.set.has(i)}
                    linked={!!(pShown?.approvedSigner && linkedSigners?.has(pShown.approvedSigner))}
                    pos={pos}
                    isCurrent={i === currentPlayer}
                    seatIndex={i}
                    koCount={seatKoBySeat[i] ?? 0}
                    bankedFp={bountyRail?.seatFp?.[i] ?? 0}
                    bankedSol={bountyRail?.seatSol?.[i] ?? 0}
                    duelSeat={!!bountyRail?.duel && (i === bountyRail.duel.seatA || i === bountyRail.duel.seatB)}
                    duelReveal={!!bountySeatState && bountySeatState.duelChoiceA !== 0 && bountySeatState.duelChoiceB !== 0}
                    duelLiveOnFelt={!!bountyRail?.duel}
                    shieldMode={(bountyRail?.ruleset ?? 0) === 1}
                    isCashGame={isCashGame}
                    isHero={!!isHero}
                    heroCardsOnFelt={effectiveHeroPosition === 'table'}
                    heroCards={isHero ? heroPeekCards : undefined}
                    isDealer={isDealer}
                    isSB={isSB}
                    isBB={isBB && !isDealer}
                    cardsDealt={cardsDealt}
                    isShowdown={isShowdown}
                    isRunout={isRevealPending}
                    showdownStage={showdownStage}
                    cardsPreRevealed={preShowdownRevealedRef.current.set.has(i) || !!verifiedShow}
                    handName={playerResult
                      ? (isSplitPot && playerResult.isWinner ? `${playerResult.hand.name} (SPLIT)` : playerResult.hand.name)
                      : undefined}
                    isWinner={!!isWinnerSeat}
                    lastAction={seatAction ? { action: seatAction.action, timestamp: seatAction.timestamp } : null}
                    timeLeft={i === currentPlayer && !(i === myPlayer?.seatIndex && !myCards && !(myPlayer?.folded ?? false)) ? timeLeft : undefined}
                    timeoutSecs={timerWindowSecs}
                    timeBankActive={!!p?.timeBankActive}
                    showdownPot={isWinnerSeat ? winnerPayout(p?.pubkey) : (showdownPot || pot)}
                    fmtVal={fmtVal}
                    onSeatClick={onSeatClick}
                    pendingJoinSeat={pendingJoinSeat}
                    reservedJoinSeat={reservedJoinSeat}
                    selectedJoinSeat={selectedJoinSeat}
                    reservedJoinSeats={reservedJoinSeats}
                    joiningSeat={joiningSeat}
                    clearingSeats={clearingSeats}
                    profileAvatarImage={profileImageUrl}
                    profileAvatarEmoji={avatarObj?.fallbackEmoji || null}
                    profileName={profile?.username}
                    noteColor={(!isHero && pKey) ? (playerNotes.get(pKey)?.color ?? 'none') : 'none'}
                    onOpenNotes={(!isHero && pKey && publicKey) ? () => openNotesFor(pKey) : undefined}
                    peekSuppressed={!!noteTargetPubkey}
                    amountThisStreet={amountThisStreet}
                    totalBet={displayTotalBet}
                    bigBlind={blinds.big}
                    uncalledReturn={uncalledReturn}
                    frame={isHero ? heroFrame : ((profile?.activeFrame as SeatFrameId | undefined) || 'default')}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Hero Cockpit (FLOATING variant) — hidden on every viewport. Hole
            cards now live in the action bar (#action-bar-hole-cards) and the
            seat plate already shows YOU/stack/bb, so this rail is duplicate. */}
        <div
          id="hero-cockpit-shell"
          className="hidden"
        >
        {myPlayer ? (
          <HeroCockpit
            player={myPlayer}
            isCurrent={!!isMyTurn}
            handName={(() => {
              if (!isShowdown || showdownStage < 5 || !showdownResults) return undefined;
              const r = showdownResults.results[myPlayer.pubkey];
              return r ? r.hand.name : undefined;
            })()}
            timeLeft={timeLeft}
            timeoutSecs={timerWindowSecs}
            fmtVal={fmtVal}
            isShowdown={isShowdown}
            onOpenTopUp={onOpenTopUp}
            onUseTimeBank={() => onAction?.('use_time_bank')}
            ceremony={derivedCeremony}
            scenario={heroScenario}
            hasFloatingCards={!!(myCards && cardsDealt) && effectiveHeroPosition !== 'table'}
            myCards={myCards}
            folded={myPlayer.folded}
            cardsLocked={cardsDealt && !myCards && !myPlayer.folded && effectiveHeroPosition !== 'table'}
            uncalledReturn={potUi.uncalledByPubkey[myPlayer.pubkey] || 0}
          />
        ) : (
          <SpectatorCockpit
            isCashGame={isCashGame}
            players={players}
            maxSeats={maxSeats}
            reservedByOthers={reservedJoinSeats}
            onJoin={() => {
              // Already seating (auth/headless-sign in flight) — ignore re-clicks.
              if (joiningSeat != null) return;
              // SNG seats are filled from the lobby pool/queue, not by claiming
              // a seat at a running table — send spectators to the SNG tab to join.
              if (!isCashGame) { router.push('/lobby?tab=sng'); return; }
              const activeJoinSeat = pendingJoinSeat ?? reservedJoinSeat ?? selectedJoinSeat;
              if (activeJoinSeat != null) {
                onSeatClick?.(activeJoinSeat);
                return;
              }
              const taken = new Set(players.map(p => p.seatIndex));
              const reserved = new Set(reservedJoinSeats);
              let openSeat = -1;
              for (let i = 0; i < maxSeats; i++) {
                if (!taken.has(i) && !reserved.has(i)) { openSeat = i; break; }
              }
              if (openSeat >= 0) onSeatClick?.(openSeat);
            }}
          />
        )}
        </div>

        {devSlot}

        {/* Betting Controls — hidden for spectators (no seat) or when devSlot owns the area */}
        {myPlayer && !devSlot && (
          <div className="relative shrink-0 h-auto md:h-[108px] min-h-0 overflow-hidden md:overflow-visible">
            {/* DESKTOP-ONLY visible hero-cards overlay — drawn here, not inside
                the bar, so large sizes spill ABOVE the bar (z-30) without the
                bar's overflow-hidden clipping them. Width is reserved inside the
                bar by the heroBarCards spacer (md:invisible), so this never
                shifts the slider/buttons. On mobile the bar shows the in-flex
                cards directly (heroBarCards is visible there), so this overlay
                is hidden and the wrapper clips like before. */}
            {myCards && effectiveHeroPosition !== 'table' && (
              <div id="action-bar-hole-cards" className="hidden md:block absolute left-4 top-2 z-30 pointer-events-none">
                <HoleCards cards={myCards} size={feltCardSize(cardPrefsForFmt.cardSize)} revealed animate={false} />
              </div>
            )}
            {/* Amount-to-call = highest live bet on the table, NOT the table's
                min_bet field (which only tracks the min-RAISE threshold). A
                short all-in (e.g. all-in from a blind) doesn't move min_bet, so
                using it alone showed CHECK when you actually owe a CALL. Maxing
                against player bets captures the all-in. */}
            <BettingControls
              phase={phase}
              tablePda={tablePda}
              handNumber={handNumber}
              // Table.min_bet is the canonical amount owed. Do not derive this
              // from seat bet_this_round values: seat WS updates can lag a
              // street reset, briefly leaving preflop bets on the felt after
              // the table has already moved to a checked flop. Inflating
              // currentBet from those stale seat values renders phantom CALL
              // buttons until the next poll catches up.
              currentBet={currentBet}
              myBet={myPlayer?.bet || 0}
              myChips={myPlayer?.chips || 0}
              pot={displayPot}
              bigBlind={blinds.big}
              onAction={onAction}
              isMyTurn={!!isMyTurn && phase !== 'Waiting' && phase !== 'Complete' && !isShowdown && !!myCards}
              sessionClaimRequired={sessionClaimRequired}
              sessionClaimDebug={sessionClaimDebug}
              onClaimSeatSession={onClaimSeatSession}
              onShowCards={onShowCards}
              revealedThisHand={revealedThisHand}
              showPreAction={!isMyTurn && phase !== 'Waiting' && phase !== 'Complete' && !isShowdown && !(myPlayer?.folded ?? false) && !(myPlayer ? isAllInPlayer(myPlayer) : false)}
              isShowdown={isShowdown}
              hasFolded={myPlayer?.folded ?? false}
              actionPending={actionPending}
              fmtVal={fmtVal}
              parseVal={parseVal}
              myCards={myCards}
              timeLeft={timeLeft}
              timeoutSecs={timerWindowSecs}
              timeBankSecs={myPlayer?.timeBankSeconds ?? 0}
              timeBankActive={!!myPlayer?.timeBankActive}
              canRaise={canRaise}
              isAllIn={!!myPlayer?.isAllIn}
              isMeLeaving={!!myPlayer?.isLeaving}
              maxOpponentStack={Math.max(
                0,
                ...players
                  .filter(p => p && p.seatIndex !== myPlayer?.seatIndex && !p.folded && ((p.chips || 0) + (p.bet || 0)) > 0)
                  .map(p => (p.chips || 0) + (p.bet || 0)),
              )}
              isCashGame={isCashGame}
              isMeSittingOut={isMeSittingOut}
              isWaitingForBb={!!myPlayer?.waitingForBb}
              missedBb={!!myPlayer?.missedBb}
              missedSb={!!myPlayer?.missedSb}
              numSeatedPlayers={players?.length ?? 0}
              onSitIn={onSitIn}
              sittingOutPending={sittingOutPending}
              onOpenTopUp={onOpenTopUp}
            />
          </div>
        )}

        {/* Sit-out controls moved to top toolbar — see toolbar block above. */}

        {/* Private player-note editor (author-only). Opened by tapping an
            opponent's name on their seat. */}
        {noteTargetPubkey && (
          <PlayerNoteModal
            open={true}
            targetPubkey={noteTargetPubkey}
            targetName={profiles[noteTargetPubkey]?.username}
            initialNote={playerNotes.get(noteTargetPubkey)?.note ?? ''}
            initialColor={(playerNotes.get(noteTargetPubkey)?.color ?? 'none') as NoteColor}
            authorLevel={myPlayer?.level}
            onEnsureLoaded={playerNotes.ensureLoaded}
            onSave={(note, color) => playerNotes.saveNote(noteTargetPubkey, note, color)}
            onClose={() => setNoteTargetPubkey(null)}
          />
        )}

        {/* Showdown states surface as floating TableSystemMessage over the felt (see felt overlay block). */}

        {/* Cinematic end-of-tournament overlay (SNG only). Rendered from
            the snapshot captured when phase first entered Complete, so a
            subsequent TEE phase cycle can't unmount it mid-animation. */}
        {(() => {
          if (isCashGame || !endSnapshot || endOverlayClosed || !sngEnd) return null;

          const { heroPlace, isWinner, isItm, projectedPoker, projectedSol } = sngEnd;
          const result: GameEndResult = isWinner ? 'winner' : isItm ? 'itm' : 'out';
          const tierName = TIER_NAMES[endSnapshot.tier] || 'Copper';
          const heroProfile = myPubkeyStr ? profiles[myPubkeyStr] : null;
          const playerLabel = heroProfile?.username || 'You';
          const closeOverlay = () => { setEndOverlayClosed(true); setEndSnapshot(null); };
          const canClaim = !!publicKey && !!sendTransaction && rawUnrefined > 0;

          return (
            <GameEndOverlay
              open={true}
              onClose={closeOverlay}
              result={result}
              place={heroPlace}
              tournamentOver={endSnapshot.tournamentOver}
              tierName={tierName}
              playerName={playerLabel}
              // Duel mode economics: $FP is PURE bounty (no place-based $FP payout - it shows in the
              // bounty breakdown instead), and only the non-bounty half of the SOL pool pays ITM.
              // The legacy projection splits 100% of the SOL pool by place, which would read double.
              payout={bountyRail
                ? { poker: 0, sol: projectedSol * (10_000 - SOL_BOUNTY_BPS) / 10_000 }
                : { poker: projectedPoker, sol: projectedSol }}
              bounty={(() => {
                if (!bountyDuelFormat || bountyHeroSeat == null) return undefined;
                // The sidecar resets to zeros at settlement, so prefer the latched live snapshot;
                // only fall back to the live rail if it still carries data (e.g. hero busted early
                // while the game continues).
                const liveHasKo = bountyRail && Object.values(bountyRail.seatKo).some((k) => k > 0);
                const snap = bountyEndSnapRef.current;
                const rail = liveHasKo ? bountyRail : snap?.rail ?? bountyRail;
                if (!rail) return undefined;
                const maturityPct = liveHasKo || !snap
                  ? Math.min(100, Math.round(duelMaturityBps(
                      bountySeatState?.paid ? bountySeatState.finalBlindLevel : blindLevel,
                    ) / 100))
                  : snap.maturityPct;
                return {
                  koCount: rail.seatKo[bountyHeroSeat] ?? 0,
                  fpBounty: rail.seatFp[bountyHeroSeat] ?? 0,
                  solBounty: rail.seatSol[bountyHeroSeat] ?? 0,
                  maturityPct,
                  shield: (rail.ruleset ?? 0) === 1,
                  settled: !!bountySeatState?.paid,
                  topHunters: Object.entries(rail.seatKo)
                    .map(([s, ko]) => ({ seat: Number(s), ko }))
                    .filter((h) => h.ko > 0)
                    .sort((a, b) => b.ko - a.ko)
                    .map((h) => ({
                      ko: h.ko,
                      name: h.seat === bountyHeroSeat
                        ? 'You'
                        : (() => {
                            const live = players.find((pl) => pl.seatIndex === h.seat)?.pubkey;
                            const pk = live && !live.startsWith('seat-')
                              ? live
                              : rememberedSeatPubkey(h.seat);
                            return pk ? shortWallet(pk) : `Seat ${h.seat + 1}`;
                          })(),
                    })),
                };
              })()}
              rewards={sngEnd.rewards}
              rawPoker={rawUnrefined}
              distribution={dist}
              // The SNG is over — these all LEAVE the dead table. Previously
              // onLobby was unset (so LOBBY fell back to onClose) and
              // onLeaveToEarn was closeOverlay, so both just dismissed the
              // overlay and dumped you back on the finished table. Navigate.
              // SNG context: land on the SNG tab, not the last-viewed mode
              // (which would dump the player on the cash lobby).
              onLobby={() => { closeOverlay(); router.push('/lobby?tab=sng'); }}
              onPlayAgain={() => { closeOverlay(); router.push('/lobby?tab=sng'); }}
              onLeaveToEarn={() => { closeOverlay(); router.push('/lobby?tab=sng'); }}
              onClaimRaw={canClaim ? handleClaimRaw : undefined}
              onClaimAndStake={canClaim ? handleClaimAndStake : undefined}
            />
          );
        })()}
      </div>

      {/* ─── Right rail: action log + SNG standings ──────────────────── */}
      <div className="min-h-[320px] md:min-h-0 md:h-full [@media(max-height:500px)_and_(orientation:landscape)]:min-h-[240px]">
        {/* Collapsed on desktop: a thin re-open handle in place of the rail.
            Mobile always shows the full log (collapse is a desktop multi-table
            convenience, and the rail stacks below the felt on mobile). */}
        {!railOpen && (
          <button
            onClick={toggleRail}
            className="group hidden md:flex w-full h-full flex-col items-center justify-center gap-3 rounded-md glass-room hairline hover:border-orange/40 transition-colors"
            title="Show hand log"
            aria-label="Show hand log"
          >
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-orange/10 border border-orange/30 text-orange text-[12px] leading-none -ml-px group-hover:bg-orange/20 group-hover:border-orange/55 transition-colors">‹</span>
            <span className="font-mono text-[9px] tracking-[0.28em] text-boneDim/55 group-hover:text-bone/80 transition-colors [writing-mode:vertical-rl]">HAND&nbsp;LOG</span>
          </button>
        )}
        <div className={cn("h-full", !railOpen && "md:hidden")}>
        <ActionLog
          onCollapse={toggleRail}
          entries={displayHandHistoryWithResults}
          handNumber={handNumber}
          tablePda={tablePda}
          pastHands={pastHands}
          viewingPastHand={viewingPastHand}
          onHandNav={onHandNav}
          verifyUrl={verifyUrl}
          handLogRef={handLogRef}
          sngPlayers={players}
          blinds={displayBlinds}
          isCashGame={isCashGame}
          myPubkey={myPubkeyStr}
          totalPlayers={maxPlayers}
          itmCount={itmCount}
          tournamentStartTime={tournamentStartTime}
          bountyRail={bountyRail ? { ...bountyRail, heroSeat: bountyHeroSeat } : undefined}
        />
        </div>
      </div>
    </div>
  );
}
