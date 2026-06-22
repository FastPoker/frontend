import { useCallback, useEffect, useState, useRef } from 'react';
import { Connection, PublicKey, Transaction, Keypair, ComputeBudgetProgram } from '@solana/web3.js';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { makeL1Connection, L1_RPC, TEE_RPC_URL, IS_MAINNET, PLAYER_ACCOUNT_OFFSETS, levelFromXp } from '@/lib/constants';
import { isFpDebugEnabled } from '@/lib/fp-debug';
import { getErrorMessage } from '@/lib/error-messages';
import { publishGameState } from '@/lib/dev-state-hook';
import {
  TableState,
  SeatState,
  parseTableState,
  parseSeatState,
  buildPlayerActionInstruction,
  buildUpdateApprovedSignerInstruction,
  buildUseTimeBankInstruction,
  buildSitOutInstruction,
  buildSitInInstruction,
  getSeatPda,
  getSeatCardsPda,
  getPlayerPda,
  ActionType,
  OnChainPhase,
  SeatStatus,
  phaseToString,
  TABLE_OFFSETS,
} from '@/lib/onchain-game';
import { ANCHOR_PROGRAM_ID } from '@/lib/constants';

const TEE_READ_COMMITMENT = 'processed' as const;
const PROGRAM_PUBLIC_KEY = new PublicKey(ANCHOR_PROGRAM_ID);
const CARD_CHASE_FAST_MS = 2500;
const CARD_CHASE_TOTAL_MS = 10000;
const CARD_CHASE_FAST_INTERVAL_MS = 100;
const CARD_CHASE_SLOW_INTERVAL_MS = 500;
const OWN_CARD_PHASES = new Set([
  'PreFlop',
  'Flop',
  'FlopRevealPending',
  'Turn',
  'TurnRevealPending',
  'River',
  'RiverRevealPending',
  'Showdown',
]);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const shouldDisplayOwnCards = (phase?: string) => !!phase && OWN_CARD_PHASES.has(phase);
const SEAT_CARDS_TABLE_OFFSET = 8;
const SEAT_CARDS_SEAT_OFFSET = 40;
const SEAT_CARDS_PLAYER_OFFSET = 41;
const SEAT_CARDS_CARD1_OFFSET = 73;
const SEAT_CARDS_CARD2_OFFSET = 74;

const hasValidCardPair = (cards?: [number, number]) => (
  !!cards && cards[0] >= 0 && cards[0] <= 51 && cards[1] >= 0 && cards[1] <= 51
);

function readOwnedSeatCards(
  data: Buffer | Uint8Array,
  tablePda: PublicKey,
  seatIndex: number,
  expectedPlayer?: PublicKey | null,
): [number, number] | undefined {
  if (!expectedPlayer || data.length <= SEAT_CARDS_CARD2_OFFSET) return undefined;
  const tableBytes = data.slice(SEAT_CARDS_TABLE_OFFSET, SEAT_CARDS_TABLE_OFFSET + 32);
  const playerBytes = data.slice(SEAT_CARDS_PLAYER_OFFSET, SEAT_CARDS_PLAYER_OFFSET + 32);
  const storedTable = new PublicKey(tableBytes);
  const storedPlayer = new PublicKey(playerBytes);
  if (!storedTable.equals(tablePda)) return undefined;
  if (data[SEAT_CARDS_SEAT_OFFSET] !== seatIndex) return undefined;
  if (!storedPlayer.equals(expectedPlayer)) return undefined;
  const cards: [number, number] = [data[SEAT_CARDS_CARD1_OFFSET], data[SEAT_CARDS_CARD2_OFFSET]];
  return hasValidCardPair(cards) ? cards : undefined;
}

function canDisplayOwnCards(state: Pick<OnChainGameState, 'phase' | 'handNumber' | 'mySeatIndex' | 'players' | 'dealtMask' | 'rosterHandNumber' | 'isCashGame'> | null | undefined, wallet?: PublicKey | null): boolean {
  if (!state || !wallet || state.handNumber <= 0 || state.mySeatIndex < 0 || !shouldDisplayOwnCards(state.phase)) return false;
  const walletStr = wallet.toBase58();
  const me = state.players.find(p => p.seatIndex === state.mySeatIndex && p.pubkey === walletStr);
  if (!me || me.folded || me.isLeaving) return false;
  // SNG: a sitting-out seat is still dealt and gets turns (and can act-to-return
  // on its turn), so it must see its own hole cards even though status != Active.
  // Cash sit-out seats are never dealt, so keep blocking them. The dealtMask check
  // below remains the real authority on whether this seat holds cards this hand.
  const sngSittingOut = state.isCashGame === false && me.isSittingOut;
  if (!sngSittingOut && (me.isSittingOut || !me.isActive)) return false;
  if (state.rosterHandNumber && state.rosterHandNumber !== state.handNumber) return false;
  if (typeof state.dealtMask === 'number' && (state.dealtMask & (1 << state.mySeatIndex)) === 0) return false;
  return true;
}

// ─── State Diff / Last Action Inference ───

export type LastAction =
  | { type: 'phase_change'; from: string; to: string }
  | { type: 'bet'; seatIndex: number; amount: number }
  | { type: 'fold'; seatIndex: number }
  | { type: 'player_joined'; seatIndex: number }
  | { type: 'player_left'; seatIndex: number }
  | { type: 'new_hand'; handNumber: number }
  | { type: 'pot_change'; oldPot: number; newPot: number }
  | null;

function inferLastAction(oldState: OnChainGameState | null, newState: OnChainGameState): LastAction {
  if (!oldState) return null;

  // New hand started
  if (newState.handNumber !== oldState.handNumber) {
    return { type: 'new_hand', handNumber: newState.handNumber };
  }

  // Phase changed (deal, flop, turn, river, showdown)
  if (newState.phase !== oldState.phase) {
    return { type: 'phase_change', from: oldState.phase, to: newState.phase };
  }

  // Player folded: check if any seat changed to folded
  for (const newP of newState.players) {
    const oldP = oldState.players.find(p => p.seatIndex === newP.seatIndex);
    if (oldP && !oldP.folded && newP.folded) {
      return { type: 'fold', seatIndex: newP.seatIndex };
    }
  }

  // Player bet/raised/called: pot increased and a seat bet changed
  if (newState.pot > oldState.pot) {
    for (const newP of newState.players) {
      const oldP = oldState.players.find(p => p.seatIndex === newP.seatIndex);
      if (oldP && newP.bet > oldP.bet) {
        return { type: 'bet', seatIndex: newP.seatIndex, amount: newP.bet - oldP.bet };
      }
    }
    return { type: 'pot_change', oldPot: oldState.pot, newPot: newState.pot };
  }

  // Player joined
  if (newState.currentPlayers > oldState.currentPlayers) {
    for (const newP of newState.players) {
      const oldP = oldState.players.find(p => p.seatIndex === newP.seatIndex);
      if (!oldP) return { type: 'player_joined', seatIndex: newP.seatIndex };
    }
  }

  // Player left
  if (newState.currentPlayers < oldState.currentPlayers) {
    for (const oldP of oldState.players) {
      const newP = newState.players.find(p => p.seatIndex === oldP.seatIndex);
      if (!newP) return { type: 'player_left', seatIndex: oldP.seatIndex };
    }
  }

  return null;
}

// ─── Phase 1C: XP cache (60s TTL) to avoid L1 reads every poll ───
const _xpCache = new Map<string, { level: number; fetchedAt: number }>();
const XP_CACHE_TTL = 60_000; // 60s

// Phase 1C: Phase-aware polling delay
// When WebSocket is active, use relaxed intervals (WS handles real-time updates, polling is safety net)
const WS_ACTIVE_POLL_INTERVAL = 10000; // 10s fallback when WS is pushing updates
// When the tab is backgrounded (document.hidden) we SLOW the game poll to this
// floor instead of pausing it — a hidden tab can't act on a hand (the crank
// auto-folds on timeout) so there's nothing to keep warm at 3s, but we never
// fully blindfold it either, so a tab left hidden for a while still trickles
// state. On returning to the foreground a visibilitychange handler fires an
// immediate catch-up poll, so the user never waits the floor to resync. This
// is a pure read-path change — it does not touch action signing/sending.
const HIDDEN_POLL_INTERVAL = 30000; // 30s floor while the tab is hidden

// ─── WS Batching: buffer notifications then merge atomically ───
// Prevents inconsistent renders when table + seat updates arrive as separate events
const WS_BATCH_WINDOW_MS = 75; // Must capture table + seat notifications in same batch

// ─── Slot-based versioning: reject stale WS notifications ───
const wsSlotTracker = new Map<string, number>(); // pubkey -> last known slot

function getPhaseDelay(phase: string, wsActive: boolean = false): number {
  if (wsActive) return WS_ACTIVE_POLL_INTERVAL;
  // Minimum 3s for all phases to stay within TEE rate limits (10 req/s, 1000 burst)
  switch (phase) {
    case 'Waiting': return 5000;
    case 'Complete': return 5000;
    case 'Showdown': return 3000;
    default: return 3000; // Active play phases
  }
}

// Owner/delegation lookup via the indexer's push-fresh Table cache (0 RPC when enabled).
// Lets the game poll skip the per-poll L1 getAccountInfo when the table is
// delegated (the common case). Returns null on miss/cold/unreachable/timeout so
// the caller falls back to a direct read — the stale-shadow guard stays on the
// direct path. 2s timeout so a hung indexer can't stall the poll (mobile lifeline).
async function fetchTableOwnerViaIndexer(pubkey: string): Promise<{ owner: PublicKey } | null> {
  try {
    const res = await fetch(`/api/table-account?pubkey=${encodeURIComponent(pubkey)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { table?: { owner?: string } | null };
    const owner = body?.table?.owner;
    if (!owner) return null;
    return { owner: new PublicKey(owner) };
  } catch {
    return null;
  }
}

export interface GamePlayer {
  pubkey: string;
  chips: number;
  bet: number;
  folded: boolean;
  isActive: boolean;
  isAllIn?: boolean;
  isSittingOut: boolean;
  isLeaving: boolean;
  seatIndex: number;
  position?: 'SB' | 'BB' | 'BTN';
  holeCards?: [number, number]; // Revealed at showdown
  /** Seat's on-chain approved_signer (session key). Used to verify an off-chain
   *  voluntary card-show came from this seat's owner (anti-spoof). */
  approvedSigner?: string;
  level?: number;
  sitOutButtonCount?: number;
  handsSinceBust?: number;
  sitOutTimestamp?: number;
  timeBankSeconds?: number;
  timeBankActive?: boolean;
  vaultReserve?: number;
  missedSb?: boolean;
  missedBb?: boolean;
  waitingForBb?: boolean;
  totalBetThisHand?: number;
}

export interface OnChainGameState {
  tablePda: string;
  phase: string;
  isMaintenance?: boolean;
  pot: number;
  currentPlayer: number;
  communityCards: number[];
  players: GamePlayer[];
  myCards?: [number, number];
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  blinds: { small: number; big: number };
  currentBet: number;
  handNumber: number;
  mySeatIndex: number;
  tier: number;
  prizePool: number;
  maxPlayers: number;
  lastActionSlot: number;
  blindLevel: number;
  tournamentStartTime: number;
  tokenMint: string;
  creator: string;
  isPrivate: boolean;
  isCashGame: boolean;
  isMyLeaving: boolean;
  // OPEN-4 Phase 4
  currentPlayers: number;
  playersReady: number;
  readyDeadline: number;
  blindsPosted: number;
  blindDeadline: number;
  revealedHands?: number[];
  handResults?: number[];
  activeMask?: number;
  dealtMask?: number;
  rosterHandNumber?: number;
  seatsOccupied?: number;
  seatsAllin?: number;
  seatsFolded?: number;
  eliminatedSeats?: number[];
  eliminatedCount?: number;
  // WebSocket state diff
  lastAction: LastAction;
}

// Phases where opponent hole cards and the community board are legitimately
// visible: showdown plus the all-in runout, where the contract writes
// revealed_hands / board cards early. Waiting/Starting are excluded so stale
// reveal bytes from the previous hand never replay.
const REVEALABLE_PHASES = new Set([
  'Showdown', 'Complete', 'Flop', 'Turn', 'River',
  'FlopRevealPending', 'TurnRevealPending', 'RiverRevealPending',
]);

// Ratchet a freshly-fetched poll snapshot against the last committed state so a
// stale [255,255] revealed_hands read (cross-validator race) or a momentarily
// shrunken board never blinks opponent cards or community cards off mid-hand.
// flushWsBatch already does this for the WS path; the poll path used to commit
// raw, which is why opponent cards dropped and re-revealed exactly as each
// street card landed during an all-in runout. Pure: returns `next` unchanged
// when nothing needs preserving.
function ratchetRevealedState(
  prev: OnChainGameState | null,
  next: OnChainGameState,
): OnChainGameState {
  if (!prev || prev.handNumber !== next.handNumber) return next;

  // Street boundary: zero per-street bets, mirroring the WS batch path. The
  // contract byte-pokes bet_this_round at street reveal, but a POLL/refetch
  // that lands on a lagging validator (or spans the transition) can deliver
  // the new street with last street's bets intact — the "bet chips ride into
  // the next street" report. A real same-gap new-street bet flickers off for
  // one tick and returns with the next read; stale chips never linger.
  if (
    (next.phase === 'Flop' || next.phase === 'Turn' || next.phase === 'River') &&
    next.phase !== prev.phase &&
    next.players?.some(p => (p.bet || 0) > 0)
  ) {
    next = { ...next, players: next.players.map(p => (p.bet ? { ...p, bet: 0 } : p)) };
  }
  if (!REVEALABLE_PHASES.has(next.phase)) return next;

  let players = next.players;
  if (players && prev.players) {
    const prevByIdx = new Map(prev.players.map(p => [p.seatIndex, p]));
    let changed = false;
    players = players.map(p => {
      if (p.seatIndex === next.mySeatIndex) return p;
      if (p.holeCards && p.holeCards[0] !== 255 && p.holeCards[1] !== 255) return p;
      const prevP = prevByIdx.get(p.seatIndex);
      if (prevP?.holeCards && prevP.holeCards[0] !== 255 && prevP.holeCards[1] !== 255) {
        changed = true;
        return { ...p, holeCards: prevP.holeCards };
      }
      return p;
    });
    if (!changed) players = next.players;
  }

  let communityCards = next.communityCards;
  const validCard = (c: number) => c !== 255 && c >= 0 && c <= 51;
  const prevCount = (prev.communityCards || []).filter(validCard).length;
  const newCount = (communityCards || []).filter(validCard).length;
  if (prevCount > newCount) communityCards = prev.communityCards;

  if (players === next.players && communityCards === next.communityCards) return next;
  return { ...next, players, communityCards };
}

interface UseOnChainGameReturn {
  gameState: OnChainGameState | null;
  isLoading: boolean;
  error: string | null;
  isConnected: boolean;
  sendAction: (action: 'fold' | 'check' | 'call' | 'raise' | 'allin' | 'sit_out' | 'return_to_play' | 'leave_cash_game' | 'use_time_bank', amount?: number) => Promise<string | null>;
  isPendingAction: boolean;
  sessionClaimRequired: boolean;
  isClaimingSession: boolean;
  claimSeatSession: (onStep?: (step: string) => void) => Promise<string | null>;
  refreshState: () => Promise<void>;
  /** Last inferred action from WebSocket state diff (null if no diff yet) */
  lastAction: LastAction;
  /** Whether WebSocket subscription is active (reduces polling frequency) */
  wsActive: boolean;
}

export function useOnChainGame(tablePdaString: string | null, sessionKey?: Keypair | null, teeConnection?: Connection | null, teeAuthenticated?: boolean, onAuthFailed?: () => void): UseOnChainGameReturn {
  const { publicKey, sendTransaction, signTransaction } = useUnifiedWallet();
  const [gameState, setGameState] = useState<OnChainGameState | null>(null);
  const [isLoading, setIsLoading] = useState(!!tablePdaString);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isPendingAction, setIsPendingAction] = useState(false);
  const [sessionClaimRequired, setSessionClaimRequired] = useState(false);
  const [isClaimingSession, setIsClaimingSession] = useState(false);
  
  // WebSocket state diff tracking
  const [lastAction, setLastAction] = useState<LastAction>(null);
  const [wsActive, setWsActive] = useState(false);
  const sessionKeyPubkeyString = sessionKey?.publicKey.toBase58() || null;
  const wsSubKeysRef = useRef<string[]>([]);
  const prevGameStateRef = useRef<OnChainGameState | null>(null);
  // WS batching: accumulate partial updates in a buffer, flush after 50ms
  const wsBatchRef = useRef<Partial<OnChainGameState>>({});
  const wsBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsConnRef = useRef<Connection | null>(null);
  const connectionRef = useRef<Connection | null>(null);
  const teeConnRef = useRef<Connection | null>(null); // Authed TEE for all reads (token required)
  // Seat/table coherence reconciler (see flushWsBatch): pending one-shot
  // refetch armed when a table update implies an action but no seat data came.
  const seatReconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshStateRef = useRef<(() => Promise<void>) | null>(null);
  const subscriptionRef = useRef<number | null>(null);

  useEffect(() => {
    if (!error) return;
    if (error === 'TABLE_NOT_FOUND') return;
    const timer = setTimeout(() => {
      setError(current => current === error ? null : current);
    }, 4500);
    return () => clearTimeout(timer);
  }, [error]);
  const tablePdaRef = useRef<PublicKey | null>(null);
  const onAuthFailedRef = useRef(onAuthFailed);
  onAuthFailedRef.current = onAuthFailed;
  const seatCardsNullCountRef = useRef(0);
  const approvedSignerRegisteredRef = useRef<string | null>(null);
  const tableReadFailCountRef = useRef(0);
  const lastMyCardsRef = useRef<{
    tablePda: string;
    handNumber: number;
    seatIndex: number;
    cards: [number, number];
  } | null>(null);
  const cardChaseRef = useRef<{ key: string; cancelled: boolean } | null>(null);
  // Phase 1C: Nonce tracking — skip seat re-reads if table unchanged
  const lastNonceRef = useRef<string>('');
  const lastPlayersRef = useRef<GamePlayer[]>([]);

  const readSeatApprovedSigner = useCallback(async (
    conn: Connection,
    tablePda: PublicKey,
    seatIndex: number,
  ): Promise<PublicKey | null> => {
    const [seatPda] = getSeatPda(tablePda, seatIndex);
    const seatInfo = await conn.getAccountInfo(seatPda);
    if (!seatInfo || seatInfo.data.length < 72) return null;
    return new PublicKey(seatInfo.data.slice(40, 72));
  }, []);

  // Initialize connections (TEE requires token for ALL reads)
  useEffect(() => {
    connectionRef.current = makeL1Connection();
    // TEE connection with auth token — required even for public table/seat data
    teeConnRef.current = teeConnection || new Connection(TEE_RPC_URL, { commitment: 'confirmed', wsEndpoint: 'wss://127.0.0.1:1' });
  }, [teeConnection]);

  useEffect(() => {
    let cancelled = false;

    const checkSeatSession = async () => {
      if (!gameState || gameState.mySeatIndex < 0 || !sessionKey) {
        if (!cancelled) setSessionClaimRequired(false);
        return;
      }
      const teeConn = teeConnRef.current;
      if (!teeConn) return;

      try {
        const tablePda = new PublicKey(gameState.tablePda);
        const approvedSigner = await readSeatApprovedSigner(teeConn, tablePda, gameState.mySeatIndex);
        if (cancelled || !approvedSigner) return;

        const seatKey = `${tablePda.toBase58()}:${gameState.mySeatIndex}:${sessionKey.publicKey.toBase58()}`;
        if (approvedSigner.equals(sessionKey.publicKey)) {
          approvedSignerRegisteredRef.current = seatKey;
          setSessionClaimRequired(false);
        } else {
          approvedSignerRegisteredRef.current = null;
          setSessionClaimRequired(true);
        }
      } catch {
        // Reads can temporarily fail during ER reconnects. Do not clear a
        // visible claim banner until a positive matching signer read arrives.
      }
    };

    checkSeatSession();
    const interval = setInterval(checkSeatSession, sessionClaimRequired ? 1000 : 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    gameState?.tablePda,
    gameState?.mySeatIndex,
    sessionKeyPubkeyString,
    teeConnection,
    readSeatApprovedSigner,
    sessionClaimRequired,
  ]);

  const readOwnSeatCards = useCallback(async (
    tablePda: PublicKey,
    seatIndex: number,
    handNumber: number,
    reason: string,
  ): Promise<[number, number] | undefined> => {
    const teeConn = teeConnRef.current;
    if (!teeConn || seatIndex < 0) return undefined;

    const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
    try {
      const seatCardsInfo = await teeConn.getAccountInfo(seatCardsPda, TEE_READ_COMMITMENT);
      if (seatCardsInfo && seatCardsInfo.data.length > SEAT_CARDS_CARD2_OFFSET) {
        const cards = readOwnedSeatCards(seatCardsInfo.data as Buffer, tablePda, seatIndex, publicKey);
        if (cards) {
          const current = prevGameStateRef.current;
          if (
            current &&
            (current.tablePda !== tablePda.toBase58() ||
              current.handNumber !== handNumber ||
              current.mySeatIndex !== seatIndex ||
              !canDisplayOwnCards(current, publicKey))
          ) {
            console.log(`[cards] ignored stale seat_cards reason=${reason} targetHand=${handNumber} currentHand=${current.handNumber} phase=${current.phase}`);
            return undefined;
          }
          lastMyCardsRef.current = {
            tablePda: tablePda.toBase58(),
            handNumber,
            seatIndex,
            cards,
          };
          seatCardsNullCountRef.current = 0;
          console.log(`[cards] seat_cards ready reason=${reason} hand=${handNumber} seat=${seatIndex} card1=${cards[0]} card2=${cards[1]}`);
          return cards;
        }
        return undefined;
      }

      seatCardsNullCountRef.current++;
      console.warn(`[cards] seat_cards ${seatCardsInfo ? 'too short (' + seatCardsInfo.data.length + ')' : 'NOT FOUND'} for seat ${seatIndex} (null count: ${seatCardsNullCountRef.current})`);
      if (seatCardsNullCountRef.current >= 10 && onAuthFailedRef.current) {
        console.warn('[cards] Too many null reads -- forcing TEE re-auth');
        seatCardsNullCountRef.current = 0;
        onAuthFailedRef.current();
      }
    } catch (e: any) {
      const msg = e.message || '';
      console.warn('[cards] seat_cards read failed:', msg.slice(0, 100));
      if (msg.includes('403') || msg.includes('401') || msg.includes('Unauthorized') || msg.includes('invalid token')) {
        console.warn('[cards] TEE token rejected -- forcing re-auth');
        if (onAuthFailedRef.current) onAuthFailedRef.current();
      }
    }
    return undefined;
  }, [publicKey]);

  const startCardChase = useCallback((
    tablePda: PublicKey,
    seatIndex: number | undefined,
    handNumber: number | undefined,
    reason: string,
  ) => {
    if (seatIndex === undefined || seatIndex < 0 || handNumber === undefined || handNumber <= 0) return;
    const table = tablePda.toBase58();
    const key = `${table}:${handNumber}:${seatIndex}`;
    const existing = cardChaseRef.current;
    if (existing && existing.key === key && !existing.cancelled) return;
    if (existing) existing.cancelled = true;

    const chase = { key, cancelled: false };
    cardChaseRef.current = chase;
    const start = perfNow();

    (async () => {
      let tries = 0;
      console.log(`[POKER-METRICS] cards_chase_start hand=${handNumber} seat=${seatIndex} reason=${reason} t=${start.toFixed(1)}`);
      try {
        while (!chase.cancelled && perfNow() - start < CARD_CHASE_TOTAL_MS) {
          tries++;
          const cards = await readOwnSeatCards(tablePda, seatIndex, handNumber, `chase:${reason}`);
          if (cards) {
            const current = prevGameStateRef.current;
            if (
              !current ||
              current.tablePda !== table ||
              current.handNumber !== handNumber ||
              current.mySeatIndex !== seatIndex ||
              !canDisplayOwnCards(current, publicKey)
            ) {
              console.log(`[POKER-METRICS] cards_chase_stale hand=${handNumber} seat=${seatIndex} reason=${reason} phase=${current?.phase ?? 'none'}`);
              chase.cancelled = true;
              return;
            }
            const elapsed = perfNow() - start;
            setGameState(prev => {
              if (!prev || prev.tablePda !== table || prev.handNumber !== handNumber || prev.mySeatIndex !== seatIndex) {
                return prev;
              }
              if (prev.myCards?.[0] === cards[0] && prev.myCards?.[1] === cards[1]) return prev;
              return { ...prev, myCards: cards };
            });
            if (
              prevGameStateRef.current &&
              prevGameStateRef.current.tablePda === table &&
              prevGameStateRef.current.handNumber === handNumber &&
              prevGameStateRef.current.mySeatIndex === seatIndex
            ) {
              prevGameStateRef.current = { ...prevGameStateRef.current, myCards: cards };
            }
            console.log(`[POKER-METRICS] cards_chase_success hand=${handNumber} seat=${seatIndex} tries=${tries} delta=${elapsed.toFixed(1)}ms`);
            chase.cancelled = true;
            return;
          }
          const elapsed = perfNow() - start;
          await sleep(elapsed < CARD_CHASE_FAST_MS ? CARD_CHASE_FAST_INTERVAL_MS : CARD_CHASE_SLOW_INTERVAL_MS);
        }
        if (!chase.cancelled) {
          console.warn(`[POKER-METRICS] cards_chase_timeout hand=${handNumber} seat=${seatIndex} tries=${tries}`);
        }
      } finally {
        if (cardChaseRef.current === chase) cardChaseRef.current = null;
      }
    })().catch(() => {
      if (cardChaseRef.current === chase) cardChaseRef.current = null;
    });
  }, [readOwnSeatCards, publicKey]);

  useEffect(() => {
    return () => {
      if (cardChaseRef.current) cardChaseRef.current.cancelled = true;
    };
  }, [tablePdaString]);

  useEffect(() => {
    lastMyCardsRef.current = null;
    seatCardsNullCountRef.current = 0;
    if (cardChaseRef.current) cardChaseRef.current.cancelled = true;
    setGameState(prev => (prev?.myCards ? { ...prev, myCards: undefined } : prev));
    if (prevGameStateRef.current?.myCards) {
      prevGameStateRef.current = { ...prevGameStateRef.current, myCards: undefined };
    }
  }, [tablePdaString, publicKey]);

  // Fetch and parse all game state from TEE (all delegated game accounts live on TEE)
  const fetchGameState = useCallback(async (tablePda: PublicKey): Promise<OnChainGameState | null> => {
    const l1Connection = connectionRef.current;
    const teeConn = teeConnRef.current;
    if (!l1Connection || !publicKey || !teeConn) return null;

    try {

      // If L1 owns the table, L1 is authoritative. Mainnet TEE can retain a
      // stale ER shadow after an undelegate/reset/cancel; accepting that shadow
      // shows old seats even though the program-owned L1 accounts are clean.
      let fromL1Fallback = false;
      let tableInfo: Awaited<ReturnType<typeof teeConn.getAccountInfo>> = null;
      try {
        // Owner/delegation check via the indexer's push-fresh Table cache first.
        // If it reports the table DELEGATED, skip the per-poll L1 getAccountInfo
        // and go straight to the TEE (the common live path) — the big getAccountInfo
        // cut. If the indexer is cold/unreachable OR the table is PROGRAM-owned (L1
        // authoritative), do a DIRECT read so the stale-TEE-shadow guard keeps
        // authoritative data. The TEE-miss disambiguation read below stays direct.
        const idx = await fetchTableOwnerViaIndexer(tablePda.toBase58());
        const indexerSaysDelegated = !!(idx && !idx.owner.equals(PROGRAM_PUBLIC_KEY));
        if (!indexerSaysDelegated) {
          const l1Info = await l1Connection.getAccountInfo(tablePda);
          if (!l1Info) {
            console.warn('[L1] Table not found:', tablePda.toBase58());
            throw new Error('TABLE_NOT_FOUND');
          }
          if (l1Info.owner.equals(PROGRAM_PUBLIC_KEY)) {
            tableInfo = l1Info;
            fromL1Fallback = true;
          }
        }
      } catch (e: any) {
        if (e?.message === 'TABLE_NOT_FOUND') throw e;
      }

      // ── TEE path for delegated tables ──
      try {
        if (!tableInfo) {
          tableInfo = await teeConn.getAccountInfo(tablePda, TEE_READ_COMMITMENT);
        }
      } catch (teeErr: any) {
        // TEE 500 = account not delegated (proxy crashes fetching from L1)
        // Treat same as null — fall through to L1 check below
        console.warn(`[TEE] getAccountInfo failed: ${teeErr?.message?.slice(0, 80)}`);
      }
      if (!tableInfo) {
        tableReadFailCountRef.current++;
        console.log(`Table not found on TEE (fail #${tableReadFailCountRef.current}):`, tablePda.toBase58());

        // Check L1 to distinguish "table genuinely closed" from "TEE auth stale"
        try {
          const l1Info = await l1Connection.getAccountInfo(tablePda);
          if (!l1Info) {
            // Table doesn't exist on L1 either — it's genuinely closed/finished
            console.warn('[TEE] Table not found on L1 either — table is closed');
            throw new Error('TABLE_NOT_FOUND');
          }
          // Check if table was undelegated back to L1 (meaning it's currently in the 5-10s maintenance cycle)
          if (l1Info.owner.equals(PROGRAM_PUBLIC_KEY)) {
            console.log(`[TEE] Table is undelegated on L1 (maintenance cycle) — holding UI state`);
            tableInfo = l1Info;
            fromL1Fallback = true;
            // Overwrite the missing tableInfo with the L1 payload so parsing succeeds below
          } else {
            // L1 has it (delegation program owns it) but TEE can't serve it — TEE auth issue
            throw new Error('TEE_AUTH_STALE');
          }
        } catch (e: any) {
          if (e.message === 'TABLE_NOT_FOUND') throw e; // re-throw sentinel
          // Network issue or TEE_AUTH_STALE
        }

        if (!tableInfo) {
          // After 3 consecutive failures, TEE token is likely stale — force re-auth
          if (tableReadFailCountRef.current >= 3 && onAuthFailedRef.current) {
            console.warn('[TEE] Too many table read failures — forcing re-auth');
            tableReadFailCountRef.current = 0;
            onAuthFailedRef.current();
          }
          return null;
        }
      }
      tableReadFailCountRef.current = 0; // Reset on success

      // isMaintenance = true only when we fell back to L1 and table is undelegated (nonce reset).
      // On TEE, owner is always our program — that's normal, NOT maintenance.
      const isMaintenance = fromL1Fallback;
      const tableState = parseTableState(tableInfo.data as Buffer);
      if (!tableState) {
        console.error('Failed to parse table state');
        return null;
      }

      // Batch-fetch seat accounts (all on TEE alongside table)
      const players: GamePlayer[] = [];
      let mySeatIndex = -1;
      let myCards: [number, number] | undefined;

      // Phase 1C: Nonce check — skip seat re-reads if table state unchanged.
      // Exception: while any cached seat is Leaving, keep polling the seats. A
      // Leaving seat resolves to Empty when its cashout finalizes, but that
      // transition need not bump any nonce field (the occupied bit and
      // currentPlayers are already cleared on a drifted table), so a nonce-only
      // skip would leave the seat stuck showing LEAVING until a manual refresh.
      const nonce = `${tableState.handNumber}:${tableState.phase}:${tableState.currentPlayer}:${tableState.pot}:${tableState.seatsOccupied}:${tableState.seatsAllin}:${tableState.seatsFolded}:${tableState.currentPlayers}`;
      const hasLeavingCached = lastPlayersRef.current.some(p => p.isLeaving);
      let nonceUnchanged = nonce === lastNonceRef.current && lastPlayersRef.current.length > 0 && !hasLeavingCached;

      // Read every seat, not only those flagged in the seatsOccupied bitmask.
      // The bitmask can lag the seat PDAs: the occupied bit is cleared the moment
      // a player goes Leaving, but the seat PDA still holds Leaving status until
      // its cashout finalizes (and the bitmask can desync entirely on a stuck
      // table). A bitmask-only read drops those seats from `players`, so they
      // render as empty/JOINING instead of the truthful LEAVING state. Scanning
      // all maxPlayers seats is the same single batched RPC (≤9 accounts) and the
      // parse loop below still skips Empty/Busted/default seats.
      const occupiedIndices: number[] = [];
      for (let i = 0; i < tableState.maxPlayers; i++) {
        occupiedIndices.push(i);
      }

      // Batch-fetch all seat PDAs in ONE RPC call (not N individual calls)
      const seatPdas: { index: number; pda: PublicKey }[] = occupiedIndices.map(i => ({
        index: i, pda: getSeatPda(tablePda, i)[0],
      }));

      // If nonce unchanged, reuse last seat data (skip RPC entirely)
      let seatAccounts: ({ data: Buffer | Uint8Array } | null)[];
      if (nonceUnchanged) {
        seatAccounts = []; // Will use lastPlayersRef below
      } else {
        try {
          const batchKeys = seatPdas.map(({ pda }) => pda);
          const readConn = fromL1Fallback ? l1Connection : teeConn;
          const batchResults = await readConn.getMultipleAccountsInfo(batchKeys, fromL1Fallback ? 'confirmed' : TEE_READ_COMMITMENT);
          seatAccounts = batchResults.map(r => r || null);
        } catch {
          seatAccounts = seatPdas.map(() => null);
        }

        // Avoid L1 fallback for delegated TEE tables: L1 seats are frozen/stale.
        // If TEE fails to return seats but table says they exist, keep previous state to avoid UI flicker.
        const allSeatsNull = seatAccounts.every(s => s === null);
        if (allSeatsNull && tableState.currentPlayers > 0) {
          console.warn('[seats] All TEE seat reads failed — keeping previous state instead of flashing empty');
          // Reuse cached players via the single canonical path below (the
          // `if (nonceUnchanged)` block pushes lastPlayersRef + recomputes
          // mySeatIndex exactly once). Do NOT push here too — doing so doubled
          // every cached player into `players`, and the doubled array was
          // written back to lastPlayersRef, compounding each failed read.
          nonceUnchanged = true; // skip parsing the null seatAccounts below
        }
      }

      // Phase 1C: If nonce unchanged, reuse cached players
      if (nonceUnchanged) {
        players.push(...lastPlayersRef.current);
        mySeatIndex = lastPlayersRef.current.find(p => {
          const pk = new PublicKey(p.pubkey);
          return (sessionKey && pk.equals(sessionKey.publicKey)) || pk.equals(publicKey);
        })?.seatIndex ?? -1;
      } else {
        for (let j = 0; j < seatPdas.length; j++) {
          const i = seatPdas[j].index;
          const seatInfo = seatAccounts[j];
          if (!seatInfo) continue;

          const seatState = parseSeatState(seatInfo.data as Buffer);
          if (!seatState || seatState.status === SeatStatus.Empty) continue;
          // Skip Busted players and seats with default wallet (pre-created empty)
          // Keep Leaving players visible mid-hand so the UI can show "Leaving next hand"
          if (seatState.status === SeatStatus.Busted) continue;
          if (seatState.player.equals(PublicKey.default)) continue;

          const isMe = (sessionKey && seatState.player.equals(sessionKey.publicKey)) || 
                       seatState.player.equals(publicKey);
          if (isMe) mySeatIndex = i;

          let position: 'SB' | 'BB' | 'BTN' | undefined;
          if (i === tableState.smallBlindSeat) position = 'SB';
          else if (i === tableState.bigBlindSeat) position = 'BB';

          // Opponent hole cards from table.revealed_hands. Reveal-able phases
          // match the WS-batch ratchet set (flushWsBatch): showdown AND the
          // all-in runout (Flop/Turn/River + *RevealPending), where the contract
          // writes revealed_hands early. The 255 guard below means normal hands
          // (revealed_hands not yet populated) still show nothing, so this only
          // reveals when the contract actually did. Without these phases the
          // poll path dropped opponent cards mid-runout and they flickered.
          let holeCards: [number, number] | undefined;
          if (
            !isMe &&
            (tableState.phase === OnChainPhase.Showdown ||
              tableState.phase === OnChainPhase.Complete ||
              tableState.phase === OnChainPhase.Flop ||
              tableState.phase === OnChainPhase.Turn ||
              tableState.phase === OnChainPhase.River ||
              tableState.phase === OnChainPhase.FlopRevealPending ||
              tableState.phase === OnChainPhase.TurnRevealPending ||
              tableState.phase === OnChainPhase.RiverRevealPending)
          ) {
            const tableData = tableInfo.data as Buffer;
            const rhOff = TABLE_OFFSETS.REVEALED_HANDS + i * 2;
            if (tableData.length > rhOff + 1) {
              const rc1 = tableData[rhOff];
              const rc2 = tableData[rhOff + 1];
              if (rc1 !== 255 && rc2 !== 255) {
                holeCards = [rc1, rc2];
              }
            }
          }

          players.push({
            pubkey: seatState.player.toBase58(),
            chips: seatState.chips,
            bet: seatState.betThisRound,
            folded: seatState.status === SeatStatus.Folded,
            isActive: seatState.status === SeatStatus.Active || seatState.status === SeatStatus.AllIn || seatState.status === SeatStatus.Leaving,
            isAllIn: seatState.status === SeatStatus.AllIn,
            isSittingOut: seatState.status === SeatStatus.SittingOut,
            isLeaving: seatState.status === SeatStatus.Leaving,
            seatIndex: i,
            position,
            holeCards,
            approvedSigner: seatState.sessionKey?.toBase58(),
            sitOutButtonCount: seatState.sitOutButtonCount,
            handsSinceBust: seatState.handsSinceBust,
            sitOutTimestamp: seatState.sitOutTimestamp,
            timeBankSeconds: seatState.timeBankSeconds,
            timeBankActive: seatState.timeBankActive,
            vaultReserve: seatState.vaultReserve,
            missedSb: seatState.missedSb,
            missedBb: seatState.missedBb,
            waitingForBb: seatState.waitingForBb,
            totalBetThisHand: seatState.totalBetThisHand,
          });
        }
      }

      // Phase 1C: Batch-fetch PlayerAccount PDAs from L1 — with 60s XP cache
      if (players.length > 0) {
        const now = Date.now();
        const uncachedPlayers: { idx: number; pubkey: string }[] = [];
        for (let idx = 0; idx < players.length; idx++) {
          const cached = _xpCache.get(players[idx].pubkey);
          if (cached && (now - cached.fetchedAt) < XP_CACHE_TTL) {
            players[idx].level = cached.level;
          } else {
            uncachedPlayers.push({ idx, pubkey: players[idx].pubkey });
          }
        }
        if (uncachedPlayers.length > 0) {
          try {
            const playerPdas = uncachedPlayers.map(p => getPlayerPda(new PublicKey(p.pubkey))[0]);
            const playerAccounts = await l1Connection.getMultipleAccountsInfo(playerPdas);
            for (let j = 0; j < uncachedPlayers.length; j++) {
              const acctInfo = playerAccounts[j];
              if (acctInfo && acctInfo.data.length > PLAYER_ACCOUNT_OFFSETS.XP + 8) {
                const data = acctInfo.data as Buffer;
                const xp = Number(data.readBigUInt64LE(PLAYER_ACCOUNT_OFFSETS.XP));
                const level = levelFromXp(xp);
                players[uncachedPlayers[j].idx].level = level;
                _xpCache.set(uncachedPlayers[j].pubkey, { level, fetchedAt: now });
              }
            }
          } catch {
            // PlayerAccount may not exist for unregistered players
          }
        }
      }

      const phaseName = phaseToString(tableState.phase);
      const ownCardGate = {
        phase: phaseName,
        handNumber: tableState.handNumber,
        mySeatIndex,
        players,
        dealtMask: tableState.dealtMask,
        rosterHandNumber: tableState.rosterHandNumber,
        isCashGame: tableState.gameType === 3,
      };

      // My hole cards: read OWN seat_cards via TEE connection only while the
      // current table phase can actually display them. Complete/Waiting/Starting
      // can still have old SeatCards bytes for a moment, so reading there causes
      // the previous hand to flash back after the board clears.
      if (canDisplayOwnCards(ownCardGate, publicKey)) {
        const [mySeatCardsPda] = getSeatCardsPda(tablePda, mySeatIndex);
        try {
          // Try TEE connection first (has auth token baked in — no wallet popup)
          if (teeConn) {
            const seatCardsInfo = await teeConn.getAccountInfo(mySeatCardsPda, TEE_READ_COMMITMENT);
            if (seatCardsInfo && seatCardsInfo.data.length > SEAT_CARDS_CARD2_OFFSET) {
              const cards = readOwnedSeatCards(seatCardsInfo.data as Buffer, tablePda, mySeatIndex, publicKey);
              // CARD VALUES NEVER LOGGED — Sentry's breadcrumbs integration
              // captures console output, so logging raw card bytes here would
              // leak the user's hole cards into every subsequent error event
              // for the next ~50 breadcrumbs. Log only the read shape.
              console.log(`[cards] seat_cards read OK (dataLen=${seatCardsInfo.data.length})`);
              if (cards) {
                myCards = cards;
                seatCardsNullCountRef.current = 0;
              }
            } else {
              seatCardsNullCountRef.current++;
              console.warn(`[cards] seat_cards ${seatCardsInfo ? 'too short (' + seatCardsInfo.data.length + ')' : 'NOT FOUND'} for seat ${mySeatIndex} (null count: ${seatCardsNullCountRef.current})`);
              // After 5 consecutive nulls, TEE token is likely stale — force re-auth
              if (seatCardsNullCountRef.current >= 5 && onAuthFailedRef.current) {
                console.warn('[cards] Too many null reads — forcing TEE re-auth');
                seatCardsNullCountRef.current = 0;
                onAuthFailedRef.current();
              }
            }
          } else {
            console.warn('[cards] TEE connection not available — cannot read hole cards securely.');
          }
        } catch (e: any) {
          const msg = e.message || '';
          console.warn('[cards] seat_cards read failed:', msg.slice(0, 100));
          // Detect expired/invalid TEE token (server restart, token revoked)
          if (msg.includes('403') || msg.includes('401') || msg.includes('Unauthorized') || msg.includes('invalid token')) {
            console.warn('[cards] TEE token rejected — forcing re-auth');
            if (onAuthFailedRef.current) onAuthFailedRef.current();
          }
        }
      }

      const shouldHaveOwnCards =
        mySeatIndex >= 0 &&
        tableState.handNumber > 0 &&
        canDisplayOwnCards(ownCardGate, publicKey);

      if (myCards && mySeatIndex >= 0) {
        lastMyCardsRef.current = {
          tablePda: tablePda.toBase58(),
          handNumber: tableState.handNumber,
          seatIndex: mySeatIndex,
          cards: myCards,
        };
      }

      if (!myCards && mySeatIndex >= 0) {
        const cached = lastMyCardsRef.current;
        if (
          cached &&
          cached.tablePda === tablePda.toBase58() &&
          cached.handNumber === tableState.handNumber &&
          cached.seatIndex === mySeatIndex
        ) {
          myCards = cached.cards;
        }
      }
      if (!shouldHaveOwnCards) {
        lastMyCardsRef.current = null;
      }

      if (!myCards && shouldHaveOwnCards) {
        startCardChase(tablePda, mySeatIndex, tableState.handNumber, 'fetch-miss');
      }

      // Phase 1C: Update nonce cache for next poll
      lastNonceRef.current = nonce;
      lastPlayersRef.current = players;

      return {
        tablePda: tablePda.toBase58(),
        phase: phaseToString(tableState.phase),
        isMaintenance,
        pot: Number(tableState.pot),
        currentPlayer: tableState.currentPlayer,
        communityCards: tableState.communityCards,
        players,
        myCards,
        dealerSeat: tableState.dealerButton,
        smallBlindSeat: tableState.smallBlindSeat,
        bigBlindSeat: tableState.bigBlindSeat,
        blinds: { small: tableState.smallBlind, big: tableState.bigBlind },
        currentBet: tableState.currentBet,
        handNumber: tableState.handNumber,
        mySeatIndex,
        isCashGame: tableState.gameType === 3,
        isMyLeaving: mySeatIndex >= 0 && players.find(p => p.seatIndex === mySeatIndex)?.isLeaving === true,
        tier: tableState.tier,
        prizePool: tableState.prizePool,
        maxPlayers: tableState.maxPlayers,
        lastActionSlot: tableState.lastActionTime,
        blindLevel: tableState.blindLevel,
        tournamentStartTime: tableState.tournamentStartTime,
        tokenMint: tableState.tokenMint,
        creator: tableState.creator.toBase58(),
        isPrivate: tableState.isPrivate,
        // OPEN-4 Phase 4
        currentPlayers: tableState.currentPlayers || 0,
        seatsOccupied: tableState.seatsOccupied,
        seatsAllin: tableState.seatsAllin,
        seatsFolded: tableState.seatsFolded,
        eliminatedSeats: tableState.eliminatedSeats,
        eliminatedCount: tableState.eliminatedCount,
        playersReady: tableState.playersReady || 0,
        readyDeadline: tableState.readyDeadline || 0,
        blindsPosted: tableState.blindsPosted || 0,
        blindDeadline: tableState.blindDeadline || 0,
        revealedHands: tableState.revealedHands,
        handResults: tableState.handResults,
        activeMask: tableState.activeMask,
        dealtMask: tableState.dealtMask,
        rosterHandNumber: tableState.rosterHandNumber,
        lastAction: null, // Will be set by WS diff or caller
      };
    } catch (err: any) {
      if (err?.message === 'TABLE_NOT_FOUND') throw err; // Let callers detect closed tables
      console.error('Error fetching game state:', err);
      return null;
    }
  }, [publicKey, sessionKey, startCardChase, readOwnSeatCards]);

  // Refresh state manually
  const refreshState = useCallback(async () => {
    if (!tablePdaRef.current) return;
    setIsLoading(true);
    const state = await fetchGameState(tablePdaRef.current);
    if (state) {
      if (prevGameStateRef.current) {
        const current = prevGameStateRef.current;
        const isStale = state.handNumber < current.handNumber || 
                        (state.handNumber === current.handNumber && state.lastActionSlot < current.lastActionSlot);
        if (isStale) {
          console.log(`[REFRESH] Ignoring stale data (slot ${state.lastActionSlot} < current ${current.lastActionSlot})`);
          setIsLoading(false);
          return;
        }
      }
      const ratcheted = ratchetRevealedState(prevGameStateRef.current, state);
      setGameState(ratcheted);
      prevGameStateRef.current = ratcheted;
      setError(null);
    }
    setIsLoading(false);
  }, [fetchGameState]);
  refreshStateRef.current = refreshState;

  const claimSeatSession = useCallback(async (onStep?: (step: string) => void): Promise<string | null> => {
    onStep?.('claim: entered');
    if (!publicKey || !signTransaction || !gameState || !sessionKey) {
      setError('Connect your wallet and generate a session key first.');
      onStep?.(`claim: missing ${!publicKey ? 'wallet' : !signTransaction ? 'signTransaction' : !gameState ? 'gameState' : 'sessionKey'}`);
      return null;
    }
    if (gameState.mySeatIndex < 0) {
      setError('Not seated at table');
      onStep?.('claim: not seated');
      return null;
    }

    const teeConn = teeConnRef.current;
    if (!teeConn) {
      setError('TEE connection is not ready');
      onStep?.('claim: no TEE connection');
      return null;
    }

    setIsClaimingSession(true);
    setError(null);
    try {
      onStep?.('claim: reading seat signer');
      const tablePda = new PublicKey(gameState.tablePda);
      const approvedSigner = await readSeatApprovedSigner(teeConn, tablePda, gameState.mySeatIndex);
      const seatKey = `${tablePda.toBase58()}:${gameState.mySeatIndex}:${sessionKey.publicKey.toBase58()}`;
      onStep?.(`claim: seat signer ${approvedSigner ? approvedSigner.toBase58().slice(0, 8) : 'missing'} local ${sessionKey.publicKey.toBase58().slice(0, 8)}`);
      if (approvedSigner?.equals(sessionKey.publicKey)) {
        approvedSignerRegisteredRef.current = seatKey;
        setSessionClaimRequired(false);
        onStep?.('claim: already claimed');
        return null;
      }

      onStep?.('claim: building transaction');
      const updIx = buildUpdateApprovedSignerInstruction(
        publicKey,
        tablePda,
        gameState.mySeatIndex,
        sessionKey.publicKey,
      );
      const updTx = new Transaction().add(updIx);
      updTx.feePayer = publicKey;
      onStep?.('claim: fetching TEE blockhash');
      updTx.recentBlockhash = (await teeConn.getLatestBlockhash()).blockhash;

      onStep?.('claim: waiting for wallet signature');
      const signed = await signTransaction(updTx);
      onStep?.('claim: wallet signed, sending to TEE');
      const sig = await teeConn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      onStep?.(`claim: sent ${sig.slice(0, 8)}`);

      let confirmed = false;
      for (let p = 0; p < 15; p++) {
        await new Promise(r => setTimeout(r, 500));
        onStep?.(`claim: confirming ${p + 1}/15`);
        const st = await teeConn.getSignatureStatuses([sig]);
        const status = st?.value?.[0];
        if (status?.err) throw new Error('claim session TX err: ' + JSON.stringify(status.err));
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
          confirmed = true;
          break;
        }
      }
      if (!confirmed) throw new Error('claim session transaction not confirmed');

      onStep?.('claim: verifying seat signer');
      const verified = await readSeatApprovedSigner(teeConn, tablePda, gameState.mySeatIndex);
      if (!verified?.equals(sessionKey.publicKey)) {
        throw new Error('seat session was not updated');
      }

      approvedSignerRegisteredRef.current = seatKey;
      setSessionClaimRequired(false);
      onStep?.('claim: success');
      await refreshState();
      return sig;
    } catch (err: any) {
      const msg = err?.message?.slice(0, 180) || 'Failed to claim seat session';
      onStep?.(`claim: error ${msg}`);
      setError(msg);
      throw err;
    } finally {
      setIsClaimingSession(false);
    }
  }, [publicKey, signTransaction, gameState, sessionKey, readSeatApprovedSigner, refreshState]);

  // L1 existence check — runs BEFORE TEE auth, fast-fails for missing tables
  const [l1Checked, setL1Checked] = useState(false);
  const l1CheckedTableRef = useRef<string | null>(null);

  useEffect(() => {
    if (!tablePdaString || !connectionRef.current) {
      setL1Checked(false);
      l1CheckedTableRef.current = null;
      return;
    }
    // Only run once per table PDA
    if (l1CheckedTableRef.current === tablePdaString) return;
    l1CheckedTableRef.current = tablePdaString;
    setL1Checked(false);

    let tablePda: PublicKey;
    try {
      tablePda = new PublicKey(tablePdaString);
    } catch {
      setError('Invalid table PDA');
      return;
    }

    const l1 = connectionRef.current;
    l1.getAccountInfo(tablePda).then(info => {
      if (!info) {
        // Table doesn't exist on L1 — can't exist on TEE either
        console.warn('[L1] Table not found:', tablePdaString, '— skipping TEE');
        setError('TABLE_NOT_FOUND');
        setIsLoading(false);
        setIsConnected(false);
      }
      setL1Checked(true);
    }).catch(() => {
      // L1 check failed (network) — proceed to TEE path anyway
      setL1Checked(true);
    });
  }, [tablePdaString]);

  // Subscribe to table account changes (TEE polling)
  useEffect(() => {
    if (!tablePdaString || !connectionRef.current) {
      setGameState(null);
      setIsConnected(false);
      return;
    }

    // Wait for L1 existence check to complete first
    if (!l1Checked) {
      setIsLoading(true);
      return;
    }

    // If L1 check already determined table is gone, don't proceed
    if (error === 'TABLE_NOT_FOUND') return;

    // Wait for TEE auth before fetching — unauthenticated reads return 500
    if (!teeAuthenticated) {
      setIsLoading(true); // Keep loading indicator while waiting for auth
      return;
    }

    let tablePda: PublicKey;
    try {
      tablePda = new PublicKey(tablePdaString);
      tablePdaRef.current = tablePda;
    } catch {
      setError('Invalid table PDA');
      return;
    }

    // TEE connection for delegated game accounts (gasless play)
    const teeConn = teeConnRef.current;
    const l1Connection = connectionRef.current;
    setIsLoading(true);

    // Initial fetch — may fail before TEE auth token arrives; polling will retry
    let tableNotFound = false;
    fetchGameState(tablePda).then((state) => {
      if (state) {
        setGameState(state);
        setIsConnected(true);
        setError(null);
        setIsLoading(false);
      }
      // Don't set error on initial failure — TEE auth token may still be loading.
      // Polling will succeed once the token arrives (~2-3s).
    }).catch((err: any) => {
      if (err?.message === 'TABLE_NOT_FOUND') {
        tableNotFound = true;
        setError('TABLE_NOT_FOUND');
        setIsLoading(false);
        setIsConnected(false);
      }
    });

    // TEE WebSocket subscriptions ARE supported (confirmed March 2026), but we still use polling.
    // TODO: migrate to WS subscriptions (accountSubscribe) for lower latency.
    // Exponential backoff on errors to avoid spamming TEE.
    let active = true;
    let lastPhase = '';
    let errorCount = 0;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    // Single reschedule path so the hidden-tab floor is applied uniformly and
    // we always hold a cancelable handle (so the visibilitychange catch-up can
    // pull the next poll forward without leaving an orphan timer behind).
    const scheduleNext = (delay: number) => {
      if (!active || tableNotFound) return;
      const hidden = typeof document !== 'undefined' && document.hidden;
      const eff = hidden ? Math.max(delay, HIDDEN_POLL_INTERVAL) : delay;
      pollTimer = setTimeout(poll, eff);
    };

    const poll = async () => {
      if (!active || tableNotFound) return;
      // We're executing now, not waiting. Nulling the handle synchronously
      // (before the first await) means pollTimer is non-null ONLY while a poll
      // is scheduled-but-not-yet-running, so the visibilitychange catch-up can
      // safely treat a non-null handle as "no poll in flight, fire one now".
      pollTimer = null;
      try {
        const state = await fetchGameState(tablePda);
        if (state) {
          // Detect and ignore stale poll responses comparing to our latest known state
          if (prevGameStateRef.current) {
            const current = prevGameStateRef.current;
            const isStale = state.handNumber < current.handNumber || 
                            (state.handNumber === current.handNumber && state.lastActionSlot < current.lastActionSlot);
            
            if (isStale) {
              console.log(`[POLL] Ignoring stale polling data (slot ${state.lastActionSlot} < current ${current.lastActionSlot})`);
              const delay = wsActive ? WS_ACTIVE_POLL_INTERVAL : 2000;
              scheduleNext(Math.min(delay * Math.pow(2, errorCount), 30000));
              return;
            }
          }

          // Ratchet opponent reveals + board against the last committed state so
          // a stale [255,255] read or a shrunken board mid-runout doesn't blink
          // opponent hole cards / community cards off exactly as the next street
          // lands. Mirrors flushWsBatch (the WS path was already protected).
          const ratcheted = ratchetRevealedState(prevGameStateRef.current, state);
          // State diff: infer last action from polling update
          const action = inferLastAction(prevGameStateRef.current, ratcheted);
          if (action) {
            ratcheted.lastAction = action;
            setLastAction(action);
          }
          prevGameStateRef.current = ratcheted;
          // Since we now reject stale polling data (which was the root cause of the race condition),
          // we should apply polling updates cleanly. The former hack that preserved prev.currentPlayer
          // was keeping the game stuck in old turns when a player left or the WS dropped an event.
          if (isFpDebugEnabled()) console.log(`[FP-DEBUG] sync src=poll wsActive=${wsActive} hand=${ratcheted.handNumber} phase=${ratcheted.phase}`);
          setGameState(ratcheted);
          setIsConnected(true);
          setIsLoading(false);
          setError(null);
          errorCount = 0; // Reset backoff on success
          if (state.phase !== lastPhase) {
            lastPhase = state.phase;
          }
        } else {
          errorCount++;
          // After 3 consecutive failures, token may be stale — force refresh
          if (errorCount === 3 && onAuthFailedRef.current) {
            console.warn('[useOnChainGame] 3 consecutive failures — forcing TEE token refresh');
            onAuthFailedRef.current();
          }
        }
      } catch (err: any) {
        if (err?.message === 'TABLE_NOT_FOUND') {
          tableNotFound = true;
          setError('TABLE_NOT_FOUND');
          setIsLoading(false);
          setIsConnected(false);
          return; // Stop polling — table is genuinely gone
        }
        errorCount++;
        if (errorCount === 3 && onAuthFailedRef.current) {
          console.warn('[useOnChainGame] 3 consecutive failures — forcing TEE token refresh');
          onAuthFailedRef.current();
        }
      }
      if (!active || tableNotFound) return;
      // WS-first: when WS is active, use slow safety-net polling (10s)
      // to catch any missed WS notifications. Without this, missed WS events
      // cause the UI to freeze until the next notification arrives.
      if (wsActive) {
        scheduleNext(WS_ACTIVE_POLL_INTERVAL);
        return;
      }
      // Phase 1C: Phase-aware base delay + exponential backoff on errors
      const baseDelay = errorCount === 0 ? getPhaseDelay(lastPhase, false) : 2000;
      const delay = Math.min(baseDelay * Math.pow(2, errorCount), 30000);
      scheduleNext(delay);
    };
    poll();

    // When the tab returns to the foreground, pull the next poll forward so the
    // user sees current state immediately rather than waiting out the hidden
    // floor. Cancel the pending (possibly 30s-floored) timer and fire now. If a
    // poll happens to be mid-flight, pollTimer is null so this is a no-op and
    // the in-flight poll reschedules itself normally — worst case is one extra
    // read, which the stale-rejection above discards harmlessly.
    const onVisible = () => {
      if (!active || tableNotFound) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
        void poll();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }

    return () => {
      active = false;
      if (pollTimer) clearTimeout(pollTimer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
      setIsConnected(false);
    };
  }, [tablePdaString, fetchGameState, teeAuthenticated, l1Checked, error, wsActive]);

  // ─── WebSocket Subscription (hybrid: WS + polling fallback) ───
  // Uses TEE accountSubscribe for real-time table state updates.
  // When WS is active, polling interval is relaxed to 10s (safety net).
  // On WS disconnect, polling reverts to normal phase-aware intervals.
  useEffect(() => {
    if (!tablePdaString || !teeConnection || !teeAuthenticated) {
      setWsActive(false);
      return;
    }

    // Extract token from teeConnection endpoint
    const endpoint = teeConnection.rpcEndpoint;
    const tokenMatch = endpoint.match(/[?&]token=([^&]+)/);
    if (!tokenMatch) {
      setWsActive(false);
      return;
    }

    const token = tokenMatch[1];
    const wsUrl = endpoint.split('?')[0]
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://') + `?token=${token}`;

    // If the TEE HTTP RPC is proxied through our own /api/tee/rpc route (a Next
    // route can't service a WebSocket upgrade), the derived ws:// points at our
    // own server and would fail forever. This used to DISABLE WS entirely on
    // mainnet — production ran on pure polling, and every update cost the poll
    // interval plus a ~300ms TEE read (measured 2026-06-10 on a live mainnet
    // hand: the WS delivers the same state change 371ms median / 765ms p90
    // before even an aggressive 250ms direct poll first sees it). The mainnet
    // TEE accepts JWT-only WebSocket connections — no API key needed on the
    // socket — so when the HTTP endpoint is proxied, open the WS DIRECTLY
    // against the validator with the same per-player token instead of bailing.
    // Privacy model unchanged: the token is the player's own TEE JWT, so
    // seatCards reads stay permission-gated per player exactly as before. If
    // the direct socket can't connect (origin filtering, validator mismatch),
    // the existing failure paths flip wsActive false and polling takes over —
    // strictly no worse than the old always-polling behavior.
    // NOTE: the direct host must NOT be derived from TEE_RPC_URL — on prod
    // NEXT_PUBLIC_DEFAULT_TEE_RPC is itself the /api/tee/rpc proxy path, so
    // that derivation would silently bail and the WS would stay disabled
    // (caught by the devnet e2e rig before shipping). The validator hosts are
    // cluster-known, the same pair the /api/tee/token route whitelists;
    // NEXT_PUBLIC_DIRECT_TEE_WS overrides for future validators.
    let effectiveWsUrl = wsUrl;
    try {
      const wu = new URL(wsUrl, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
      const sameOrigin = typeof window !== 'undefined' && wu.host === window.location.host;
      if (sameOrigin || wu.pathname.includes('/api/tee/rpc')) {
        const directWsBase =
          process.env.NEXT_PUBLIC_DIRECT_TEE_WS ||
          (IS_MAINNET ? 'wss://mainnet-tee.magicblock.app' : 'wss://devnet-tee.magicblock.app');
        effectiveWsUrl = directWsBase.replace(/\/+$/, '') + `?token=${token}`;
      }
    } catch { /* unparseable URL — fall through and let the WS attempt proceed */ }

    let tablePda: PublicKey;
    try {
      tablePda = new PublicKey(tablePdaString);
    } catch {
      return;
    }

    // Create a separate WS-enabled connection (does NOT replace teeConnection for RPC reads)
    // Use "processed" commitment for fastest updates (~50ms on ER vs ~400ms for "confirmed")
    const wsConn = new Connection(endpoint, {
      commitment: 'processed',
      wsEndpoint: effectiveWsUrl,
    });
    wsConnRef.current = wsConn;

    // Flush batched WS updates as a single atomic state update
    const flushWsBatch = () => {
      wsBatchTimerRef.current = null;
      const batch = wsBatchRef.current;
      if (Object.keys(batch).length === 0) return;

      // FP-DEBUG sync attribution: every applied update names its source so
      // lag reports can be pinned to a pipe (ws = TEE push, poll = HTTP read,
      // reconcile = seat-coherence refetch) instead of guessed at.
      if (isFpDebugEnabled()) console.log(`[FP-DEBUG] sync src=ws fields=${Object.keys(batch).join(',').slice(0, 120)}`);

      // ── Seat/table coherence reconciler ──
      // The action LABEL derives from the TABLE account (pot/currentBet/
      // currentPlayer deltas) while the chips on the felt derive from the SEAT
      // account's bet field — different subscriptions. A dropped seat
      // notification (~3% per notification, measured on a live mainnet hand)
      // used to leave the seat stale until the 10s wsActive backstop poll:
      // the name showed the action seconds before the chips moved, and
      // currentBet-vs-myBet computed across the mismatched snapshots rendered
      // phantom CALL buttons on checked-through streets. If this batch carries
      // a table change that implies an action but NO seat data, give the seat
      // notification 450ms to arrive, then do one full refetch (stale-guarded
      // + ratcheted by refreshState).
      {
        const prevSnap = prevGameStateRef.current;
        const tableActed = !!prevSnap && (
          (batch.pot !== undefined && batch.pot !== prevSnap.pot) ||
          (batch.currentBet !== undefined && batch.currentBet !== prevSnap.currentBet) ||
          (batch.currentPlayer !== undefined && batch.currentPlayer !== prevSnap.currentPlayer)
        );
        // The batch frequently carries SOME seat update (hero refresh, an
        // unrelated seat) while the ACTING seat's notification is the one that
        // dropped — "any players data" is not proof of coherence. Only treat
        // the action as covered when the seat that acted (prev currentPlayer)
        // shows changed bet/chips/fold data in this batch. currentPlayer=255
        // (runout/no actor) falls back to any-seat-data semantics.
        const actorSeat = prevSnap && prevSnap.currentPlayer >= 0 && prevSnap.currentPlayer < 16
          ? prevSnap.currentPlayer
          : -1;
        let actionCovered = !!batch.players;
        if (batch.players && prevSnap && actorSeat >= 0) {
          const nb = batch.players.find(p => p.seatIndex === actorSeat);
          const ob = prevSnap.players?.find(p => p.seatIndex === actorSeat);
          actionCovered = !!nb && (!ob || nb.bet !== ob.bet || nb.chips !== ob.chips || nb.folded !== ob.folded);
        }
        if (actionCovered && seatReconcileTimerRef.current) {
          clearTimeout(seatReconcileTimerRef.current);
          seatReconcileTimerRef.current = null;
        } else if (tableActed && !actionCovered && !seatReconcileTimerRef.current) {
          seatReconcileTimerRef.current = setTimeout(() => {
            seatReconcileTimerRef.current = null;
            if (isFpDebugEnabled()) console.log('[FP-DEBUG] sync src=reconcile (table acted, acting-seat data missing 450ms)');
            void refreshStateRef.current?.();
          }, 450);
        }
      }

      setGameState(prev => {
        if (!prev) return prev;
        const merged = { ...prev, ...batch };

        // If batch includes player updates, merge them properly
        if (batch.players) {
          merged.players = batch.players;
        }

        // Phase entered a new betting street. Contract resets bet_this_round
        // via byte-poke in tee_reveal.rs:127-173, but the user's own seat WS
        // for the reset can race against the next-actor's seat WS, leaving a
        // stale per-round bet locally. Force-reset here so callAmount math in
        // BettingControls (currentBet - myBet) doesn't show CHECK when the
        // opponent has already bet on the new street.
        if (
          (merged.phase === 'Flop' || merged.phase === 'Turn' || merged.phase === 'River') &&
          merged.phase !== prev.phase &&
          merged.players
        ) {
          merged.players = merged.players.map(p => (p.bet ? { ...p, bet: 0 } : p));
        }

        if (!canDisplayOwnCards(merged as OnChainGameState, publicKey)) {
          merged.myCards = undefined;
          lastMyCardsRef.current = null;
        }

        // Apply revealed hands to opponent holeCards during actual showdown
        // AND during all-in runouts (Flop/Turn/River) when the contract has
        // written revealed_hands early (tee_reveal.rs:200-243). The phase
        // gate excludes Waiting/Starting where stale revealed_hands from the
        // previous hand still linger — those would replay last hand's cards
        // over a cleared board.
        //
        // RATCHET: TEE runs multiple validators and reads can race. Once we've
        // seen revealed_hands populated in the current hand, keep them visible
        // even on stale [255,255] reads from out-of-sync validators. Only clear
        // when handNumber increments (new hand) or phase exits the reveal-able
        // set (Waiting/Starting). Without this, cards visibly flicker off
        // between street reveals during an all-in runout.
        const rh = merged.revealedHands;
        if (merged.players) {
          const canRevealOpponents =
            merged.phase === 'Showdown' ||
            merged.phase === 'Complete' ||
            merged.phase === 'Flop' ||
            merged.phase === 'Turn' ||
            merged.phase === 'River' ||
            merged.phase === 'FlopRevealPending' ||
            merged.phase === 'TurnRevealPending' ||
            merged.phase === 'RiverRevealPending';
          const sameHand = prev.handNumber === merged.handNumber;
          const prevPlayersByIdx = new Map((prev.players ?? []).map(p => [p.seatIndex, p]));
          merged.players = merged.players.map(p => {
            if (p.seatIndex === merged.mySeatIndex) return p;
            const c1 = rh?.[p.seatIndex * 2];
            const c2 = rh?.[p.seatIndex * 2 + 1];
            if (canRevealOpponents && c1 !== undefined && c2 !== undefined && c1 !== 255 && c2 !== 255) {
              return { ...p, holeCards: [c1, c2] as [number, number] };
            }
            // Ratchet: same hand + still in a reveal-able phase + previously visible
            // → keep the cards rather than flickering off on a stale 255 read.
            if (canRevealOpponents && sameHand) {
              const prevP = prevPlayersByIdx.get(p.seatIndex);
              if (prevP?.holeCards && prevP.holeCards[0] !== 255 && prevP.holeCards[1] !== 255) {
                return { ...p, holeCards: prevP.holeCards };
              }
            }
            if (p.holeCards) {
              const { holeCards: _drop, ...rest } = p;
              return rest as GamePlayer;
            }
            return p;
          });
        }

        // Keep SB/BB positions fresh on the WS path. The POLL path computes
        // player.position from the blind seat indices, but the per-seat WS
        // update (buildPlayer) does not, so on a new hand the SB/BB badges (and
        // the dealer derivation that anchors off them) stayed on the prior
        // hand's seats until the next poll — they visibly lagged the deal.
        // Recompute from the merged, WS-fresh smallBlindSeat/bigBlindSeat.
        if (merged.players) {
          merged.players = merged.players.map(p => {
            const position = p.seatIndex === merged.smallBlindSeat ? 'SB'
              : p.seatIndex === merged.bigBlindSeat ? 'BB'
              : undefined;
            return p.position === position ? p : { ...p, position };
          });
        }

        // Ratchet the community board the same way as hole cards: within the
        // same hand and a reveal-able phase, never let the board shrink or clear
        // on a stale / out-of-sync validator read. That oscillation is what made
        // the flop/turn/river flicker off between reveals on an all-in runout.
        if (prev.handNumber === merged.handNumber) {
          const boardRevealable =
            merged.phase === 'Showdown' || merged.phase === 'Complete' ||
            merged.phase === 'Flop' || merged.phase === 'Turn' || merged.phase === 'River' ||
            merged.phase === 'FlopRevealPending' || merged.phase === 'TurnRevealPending' ||
            merged.phase === 'RiverRevealPending';
          if (boardRevealable) {
            const validCard = (c: number) => c !== 255 && c >= 0 && c <= 51;
            const prevCount = (prev.communityCards || []).filter(validCard).length;
            const newCount = (merged.communityCards || []).filter(validCard).length;
            if (prevCount > newCount) merged.communityCards = prev.communityCards;
          }
        }

        // Infer action from the merged diff
        const action = inferLastAction(prev, merged as OnChainGameState);
        if (action) {
          merged.lastAction = action;
          setLastAction(action);
        }

        prevGameStateRef.current = merged as OnChainGameState;
        return merged as OnChainGameState;
      });

      wsBatchRef.current = {};
    };

    // Queue a partial state update into the batch buffer
    const queueWsUpdate = (partial: Partial<OnChainGameState>) => {
      // While the table is program-owned on L1, TEE notifications can be stale
      // shadows from before undelegation/cancel. The poller will switch back to
      // TEE automatically once L1 says the table is delegated again.
      if (prevGameStateRef.current?.isMaintenance) return;
      Object.assign(wsBatchRef.current, partial);
      if (!wsBatchTimerRef.current) {
        wsBatchTimerRef.current = setTimeout(flushWsBatch, WS_BATCH_WINDOW_MS);
      }
    };

    const subIds: number[] = [];
    let active = true;

    console.log(`[WS] Subscribing to table ${tablePdaString.slice(0, 12)}...`);

    // Subscribe to table PDA for real-time state changes
    try {
      const tableSubId = wsConn.onAccountChange(
        tablePda,
        (accountInfo, context) => {
          if (!active) return;
          try {
            // Slot-based versioning: reject stale notifications
            const slot = context?.slot || 0;
            const key = tablePdaString!;
            const lastSlot = wsSlotTracker.get(key) || 0;
            if (slot > 0 && slot < lastSlot) {
              console.log(`[WS] Rejecting stale table notification (slot ${slot} < ${lastSlot})`);
              return;
            }
            if (slot > 0) wsSlotTracker.set(key, slot);

            const tableState = parseTableState(accountInfo.data as Buffer);
            if (!tableState) return;

            const newPhase = phaseToString(tableState.phase);

            // Clear stale cards when hand number changes or the hand is not active.
            // Do not clear on Complete: showdown/settle can briefly report Complete
            // while the player should still see their own cards.
            const prevHand = prevGameStateRef.current?.handNumber || 0;
            const prevPhase = prevGameStateRef.current?.phase;
            if (tableState.handNumber > prevHand) {
              queueWsUpdate({ myCards: undefined });
              lastMyCardsRef.current = null;
              if (cardChaseRef.current) cardChaseRef.current.cancelled = true;
              // Clear stale opponent holeCards from previous hand
              const prevPlayers = prevGameStateRef.current?.players;
              if (prevPlayers) {
                queueWsUpdate({
                  players: prevPlayers.map(p => {
                    if (!p.holeCards) return p;
                    const { holeCards: _drop, ...rest } = p;
                    return rest as GamePlayer;
                  }),
                });
              }

              // Kick off an INLINE SeatCards fetch immediately instead of
              // waiting for the next 10s poll cycle. Measured Δ turn→cards
              // drops from 0–10s (poll jitter) to ~300–900ms (TEE RTT only).
              // See scripts/stress-test/probe-report.md.
              const mySeatIdx = prevGameStateRef.current?.mySeatIndex;
              if (typeof mySeatIdx === 'number' && mySeatIdx >= 0) {
                startCardChase(tablePda, mySeatIdx, tableState.handNumber, 'ws-hand-change');
              }
            }
            // Also clear when transitioning to truly non-card phases.
            if (newPhase === 'Waiting' || newPhase === 'Starting') {
              if (prevPhase && prevPhase !== 'Waiting' && prevPhase !== 'Starting') {
                queueWsUpdate({ myCards: undefined });
              }
              lastMyCardsRef.current = null;
              if (cardChaseRef.current) cardChaseRef.current.cancelled = true;
            }

            // If the deal finished after the hand-number notification, restart
            // the card chase on the active phase edge. This helps seats that are
            // not first to act see cards immediately instead of waiting for a
            // current-player flip or the next poll tick.
            const activeCardPhase = shouldDisplayOwnCards(newPhase);
            const prevStateForCards = prevGameStateRef.current;
            const mySeatForCards = prevStateForCards?.mySeatIndex;
            const dealtMaskBecameReady =
              typeof mySeatForCards === 'number' &&
              mySeatForCards >= 0 &&
              typeof tableState.dealtMask === 'number' &&
              (tableState.dealtMask & (1 << mySeatForCards)) !== 0 &&
              ((prevStateForCards?.dealtMask ?? 0) & (1 << mySeatForCards)) === 0;
            if (
              activeCardPhase &&
              typeof mySeatForCards === 'number' &&
              mySeatForCards >= 0 &&
              !prevStateForCards?.myCards &&
              (newPhase !== prevPhase || tableState.handNumber > prevHand || dealtMaskBecameReady)
            ) {
              startCardChase(tablePda, mySeatForCards, tableState.handNumber, `ws-phase-${newPhase}`);
            }

            // Metrics: when current_player flips TO my seat, stamp the
            // arrival time so we can diff it against [POKER-METRICS] cards
            // below. Helps diagnose cross-browser card delivery variance.
            try {
              const prevState = prevGameStateRef.current;
              const prevCp = prevState?.currentPlayer;
              const newCp = tableState.currentPlayer;
              const mySeatIdx = prevState?.mySeatIndex;
              if (typeof mySeatIdx === 'number' && mySeatIdx >= 0 && newCp === mySeatIdx && prevCp !== mySeatIdx) {
                console.log(`[POKER-METRICS] turn_received hand=${tableState.handNumber} phase=${newPhase} t=${performance.now().toFixed(1)}`);
                if (!prevState?.myCards) {
                  startCardChase(tablePda, mySeatIdx, tableState.handNumber, 'ws-my-turn');
                }
              }
            } catch {}

            // Queue into batch buffer instead of direct setState
            queueWsUpdate({
              phase: newPhase,
              pot: Number(tableState.pot),
              currentPlayer: tableState.currentPlayer,
              communityCards: tableState.communityCards,
              dealerSeat: tableState.dealerButton,
              smallBlindSeat: tableState.smallBlindSeat,
              bigBlindSeat: tableState.bigBlindSeat,
              blinds: { small: tableState.smallBlind, big: tableState.bigBlind },
              currentBet: tableState.currentBet,
              handNumber: tableState.handNumber,
              lastActionSlot: tableState.lastActionTime,
              currentPlayers: tableState.currentPlayers || 0,
              seatsOccupied: tableState.seatsOccupied,
              seatsAllin: tableState.seatsAllin,
              seatsFolded: tableState.seatsFolded,
              eliminatedSeats: tableState.eliminatedSeats,
              eliminatedCount: tableState.eliminatedCount,
              playersReady: tableState.playersReady || 0,
              readyDeadline: tableState.readyDeadline || 0,
              blindsPosted: tableState.blindsPosted || 0,
              blindDeadline: tableState.blindDeadline || 0,
              revealedHands: tableState.revealedHands,
              handResults: tableState.handResults,
              activeMask: tableState.activeMask,
              dealtMask: tableState.dealtMask,
              rosterHandNumber: tableState.rosterHandNumber,
            });
          } catch (err: any) {
            console.warn(`[WS] Failed to parse table notification:`, err.message?.slice(0, 80));
          }
        },
        'processed',
      );
      subIds.push(tableSubId);
      setWsActive(true);
      console.log(`[WS] Table subscribed (subId=${tableSubId})`);
    } catch (err: any) {
      console.warn(`[WS] Table subscribe failed:`, err.message?.slice(0, 80));
      setWsActive(false);
    }

    // Subscribe to ALL seat PDAs (not just occupied) for real-time seat updates.
    // This catches new player joins and seat changes instantly via WS.
    // Default to 9 (the protocol max) when state hasn't loaded yet: the old
    // `|| 6` default left seats 6-8 of a 9-max table UNSUBSCRIBED whenever this
    // effect mounted before the first fetch — those players' bets/chips then
    // only ever arrived via the 10s backstop poll, so their action label
    // (table push) led their chips by seconds, consistently, only on high
    // seats. Subscribing 3 extra empty-seat PDAs is negligible.
    const maxSeats = prevGameStateRef.current?.maxPlayers || 9;
    for (let seatIdx = 0; seatIdx < maxSeats; seatIdx++) {
      try {
        const [seatPda] = getSeatPda(tablePda, seatIdx);
        const capturedSeatIdx = seatIdx;
        const seatSubId = wsConn.onAccountChange(
          seatPda,
          (accountInfo, context) => {
            if (!active) return;
            try {
              // Slot-based versioning
              const slot = context?.slot || 0;
              const key = seatPda.toBase58();
              const lastSlot = wsSlotTracker.get(key) || 0;
              if (slot > 0 && slot < lastSlot) return;
              if (slot > 0) wsSlotTracker.set(key, slot);

              const seatState = parseSeatState(accountInfo.data as Buffer);
              if (!seatState) return;

              // Build updated players array and queue into batch
              setGameState(prev => {
                if (!prev) return prev;
                const existingIdx = prev.players.findIndex(p => p.seatIndex === capturedSeatIdx);
                let updatedPlayers: GamePlayer[];

                const buildPlayer = (): GamePlayer => ({
                  pubkey: seatState.player.toBase58(),
                  chips: seatState.chips,
                  bet: seatState.betThisRound,
                  folded: seatState.status === SeatStatus.Folded || seatState.status === SeatStatus.Leaving,
                  isActive: seatState.status === SeatStatus.Active || seatState.status === SeatStatus.AllIn,
                  isAllIn: seatState.status === SeatStatus.AllIn,
                  isSittingOut: seatState.status === SeatStatus.SittingOut,
                  isLeaving: seatState.status === SeatStatus.Leaving,
                  seatIndex: capturedSeatIdx,
                  approvedSigner: seatState.sessionKey?.toBase58(),
                  sitOutButtonCount: seatState.sitOutButtonCount,
                  timeBankSeconds: seatState.timeBankSeconds,
                  timeBankActive: seatState.timeBankActive,
                  vaultReserve: seatState.vaultReserve,
                  missedSb: seatState.missedSb,
                  missedBb: seatState.missedBb,
                  waitingForBb: seatState.waitingForBb,
                  totalBetThisHand: seatState.totalBetThisHand,
                });

                if (seatState.status === SeatStatus.Empty || seatState.player.equals(PublicKey.default)) {
                  // Player left -- remove from array
                  updatedPlayers = prev.players.filter(p => p.seatIndex !== capturedSeatIdx);
                } else if (existingIdx >= 0) {
                  // Update existing player
                  updatedPlayers = prev.players.map(p =>
                    p.seatIndex === capturedSeatIdx ? { ...p, ...buildPlayer() } : p
                  );
                } else {
                  // New player joined -- add to array
                  updatedPlayers = [...prev.players, buildPlayer()];
                }

                // Queue the players update into the batch (merged with table update atomically)
                queueWsUpdate({ players: updatedPlayers });
                return prev; // Don't setState here - let flushWsBatch handle it
              });
            } catch (err: any) {
              console.warn(`[WS] Failed to parse seat ${capturedSeatIdx} notification:`, err.message?.slice(0, 80));
            }
          },
          'processed',
        );
        subIds.push(seatSubId);
      } catch (err: any) {
        console.warn(`[WS] Seat ${seatIdx} subscribe failed:`, err.message?.slice(0, 80));
      }
    }
    console.log(`[WS] Subscribed to ${maxSeats} seats`);

    // Subscribe to own seatCards PDA for instant hole card updates
    const currentState2 = prevGameStateRef.current;
    const mySeat = currentState2?.mySeatIndex;
    if (mySeat !== undefined && mySeat >= 0) {
      try {
        const [mySeatCardsPda] = getSeatCardsPda(tablePda, mySeat);
        const cardsSubId = wsConn.onAccountChange(
          mySeatCardsPda,
          (accountInfo, context) => {
            if (!active) return;
            try {
              // Slot-based versioning
              const slot = context?.slot || 0;
              const key = mySeatCardsPda.toBase58();
              const lastSlot = wsSlotTracker.get(key) || 0;
              if (slot > 0 && slot < lastSlot) return;
              if (slot > 0) wsSlotTracker.set(key, slot);

              const data = accountInfo.data as Buffer;
              if (data && data.length > SEAT_CARDS_CARD2_OFFSET) {
                const cards = readOwnedSeatCards(data, tablePda, mySeat, publicKey);
                if (cards) {
                  // Only show cards during active hand phases (not between hands)
                  const curPhase = prevGameStateRef.current?.phase;
                  if (!canDisplayOwnCards(prevGameStateRef.current, publicKey)) {
                    lastMyCardsRef.current = null;
                    // Stale cards from previous hand — ignore
                  } else {
                    // Check if we're actually in the hand (not folded/sitting out)
                    const myPlayer = prevGameStateRef.current?.players?.find(
                      (p: any) => p.seatIndex === mySeat
                    );
                    // SNG: a sit-out seat IS dealt and canDisplayOwnCards already
                    // cleared it above, so don't re-drop it here — otherwise the
                    // instant WS card push is lost and the on-turn action buttons
                    // lag. Cash sit-out is already blocked by canDisplayOwnCards.
                    const sngSittingOut = prevGameStateRef.current?.isCashGame === false && myPlayer?.isSittingOut;
                    const inHand = myPlayer && !myPlayer.folded && (!myPlayer.isSittingOut || sngSittingOut);
                    if (inHand) {
                      queueWsUpdate({ myCards: cards });
                      const hn = prevGameStateRef.current?.handNumber ?? '?';
                      if (typeof hn === 'number') {
                        lastMyCardsRef.current = {
                          tablePda: tablePda.toBase58(),
                          handNumber: hn,
                          seatIndex: mySeat,
                          cards,
                        };
                      }
                      console.log(`[WS] Hole cards: ${cards[0]}, ${cards[1]} (phase=${curPhase})`);
                      console.log(`[POKER-METRICS] cards_received hand=${hn} phase=${curPhase} t=${performance.now().toFixed(1)}`);
                    }
                  }
                } else {
                  // Cards cleared (new hand / fold)
                  lastMyCardsRef.current = null;
                  queueWsUpdate({ myCards: undefined });
                }
              }
            } catch (err: any) {
              console.warn(`[WS] Failed to parse seatCards notification:`, err.message?.slice(0, 80));
            }
          },
          'processed',
        );
        subIds.push(cardsSubId);
        console.log(`[WS] SeatCards subscribed for seat ${mySeat} (subId=${cardsSubId})`);
      } catch (err: any) {
        console.warn(`[WS] SeatCards subscribe failed:`, err.message?.slice(0, 80));
      }
    }

    // WS reconnection: if connection drops, retry after 3s
    const setupReconnect = () => {
      // @solana/web3.js doesn't expose a clean "onClose" for WS.
      // We detect disconnection via wsActive going false (set by onAccountChange failure).
      // Polling will handle state updates until WS reconnects.
      // The useEffect cleanup + re-run handles reconnection when teeConnection changes.
    };
    setupReconnect();

    // ── WS liveness heartbeat ──
    // The ER pushes a slot notification every ~50ms (measured on devnet AND
    // mainnet TEE, 2026-06-10). If slots stall for >4s the socket is dead or
    // degraded, but account subscriptions fail SILENTLY — the old failure mode
    // was a dead socket discovered only by the slow backstop poll (the
    // intermittent multi-second "chips don't appear" lag; measured drop rate
    // on a live mainnet hand was ~3% of account notifications even on a
    // healthy socket). Flipping wsActive false drops the poll loop to its
    // fast cadence immediately; a resumed slot stream flips it back.
    // Two failure shapes covered:
    //   1. Stream STALLS after working: degrade 4s after the last slot.
    //   2. Socket NEVER CONNECTS (e.g. the TEE filters browser Origins on the
    //      direct mainnet WS): subscription registration "succeeds" locally
    //      and wsActive optimistically goes true, so without this the dead
    //      socket would silently pin the slow 10s backstop. Degrade if no
    //      slot has EVER arrived within 8s of mount (healthy sockets push a
    //      slot every ~50ms, so 8s of silence is conclusive).
    let sawSlot = false;
    let lastSlotAt = 0;
    let slotDegraded = false;
    let slotSubId: number | null = null;
    const wsMountedAt = Date.now();
    try {
      slotSubId = wsConn.onSlotChange(() => {
        const now = Date.now();
        // Slots arrive every ~50ms on a healthy TEE socket. A 1s+ gap that
        // then RESUMES is a TEE-side WS hiccup — log it so user lag reports
        // can be attributed to the validator stream rather than the client.
        if (sawSlot && now - lastSlotAt > 1000) {
          if (isFpDebugEnabled()) console.log(`[FP-DEBUG] ws slot-gap ${((now - lastSlotAt) / 1000).toFixed(1)}s (TEE stream hiccup)`);
        }
        sawSlot = true;
        lastSlotAt = now;
        if (slotDegraded && active) {
          slotDegraded = false;
          setWsActive(true);
        }
      });
    } catch { /* slot subscriptions unsupported — stall detection still applies via mount timeout */ }
    const heartbeatTimer = setInterval(() => {
      if (!active || slotDegraded) return;
      const sinceSignal = Date.now() - (sawSlot ? lastSlotAt : wsMountedAt);
      const limit = sawSlot ? 4000 : 8000;
      if (sinceSignal > limit) {
        slotDegraded = true;
        console.warn(`[WS] ${sawSlot ? 'slot stream stalled' : 'no slot signal since connect'} (${Math.round(sinceSignal / 1000)}s) — marking WS degraded, polling takes over`);
        setWsActive(false);
      }
    }, 2000);

    return () => {
      active = false;
      setWsActive(false);
      wsConnRef.current = null;
      clearInterval(heartbeatTimer);
      if (seatReconcileTimerRef.current) {
        clearTimeout(seatReconcileTimerRef.current);
        seatReconcileTimerRef.current = null;
      }
      if (slotSubId !== null) {
        try { wsConn.removeSlotChangeListener(slotSubId); } catch { /* ignore */ }
      }
      if (wsBatchTimerRef.current) {
        clearTimeout(wsBatchTimerRef.current);
        wsBatchTimerRef.current = null;
      }
      if (wsReconnectTimerRef.current) {
        clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = null;
      }
      wsBatchRef.current = {};
      for (const subId of subIds) {
        try { wsConn.removeAccountChangeListener(subId); } catch { /* ignore */ }
      }
      // Close the underlying socket so rpc-websocket-client stops its forever
      // reconnect loop. removeAccountChangeListener alone leaves a dead socket
      // retrying (and spamming the console) whenever the WS endpoint was never
      // reachable, and HMR re-runs don't kill it without this.
      try { (wsConn as unknown as { _rpcWebSocket?: { close?: () => void } })._rpcWebSocket?.close?.(); } catch { /* ignore */ }
      console.log(`[WS] Cleaned up ${subIds.length} subscriptions`);
    };
  }, [tablePdaString, teeConnection, teeAuthenticated, gameState?.mySeatIndex, startCardChase, publicKey]);

  // Send player action
  const sendAction = useCallback(async (
    action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin' | 'sit_out' | 'return_to_play' | 'leave_cash_game' | 'use_time_bank',
    amount?: number
  ): Promise<string | null> => {
    console.log(`[FP-DEBUG] action.submit action=${action} amount=${amount ?? 'n/a'} hand=${gameState?.handNumber ?? '?'} phase=${gameState?.phase ?? '?'} seat=${gameState?.mySeatIndex ?? -1}`);
    if (!publicKey || !sendTransaction || !gameState || !connectionRef.current) {
      setError('Wallet not connected or no active game');
      return null;
    }

    if (gameState.mySeatIndex < 0) {
      setError('Not seated at table');
      return null;
    }

    const l1Connection = connectionRef.current;
    const teeConn = teeConnRef.current;
    const tablePda = new PublicKey(gameState.tablePda);

    // Map action string to enum
    const actionMap: Record<string, ActionType> = {
      fold: ActionType.Fold,
      check: ActionType.Check,
      call: ActionType.Call,
      bet: ActionType.Bet,
      raise: ActionType.Raise,
      allin: ActionType.AllIn,
      sit_out: ActionType.SitOut,
      return_to_play: ActionType.ReturnToPlay,
      leave_cash_game: ActionType.LeaveCashGame,
    };

    // process_raise (player_action.rs) does `new_bet = current_bet + amount`
    // and require!(amount >= min_raise) where min_raise is an INCREMENT (>= big
    // blind). The UI passes the raise-TO TOTAL, so we must send the increment
    // (raise-to − current_bet); otherwise a min-raise-to-2bb is sent as the
    // increment and lands at 3bb (current_bet + raise-to). Applies to cash + SNG.
    // process_bet uses total semantics, so only 'raise' is adjusted.
    const wireAmount =
      action === 'raise' && amount !== undefined
        ? Math.max(0, amount - gameState.currentBet)
        : amount;

    setIsPendingAction(true);
    setError(null);

    try {
      // Non-gameplay actions can fall back to wallet signing if session is unavailable
      const isNonGameplayAction = action === 'sit_out' || action === 'return_to_play' || action === 'leave_cash_game' || action === 'use_time_bank';

      // Use session key for gasless play on ER if available
      console.log('sendAction: sessionKey exists?', !!sessionKey, 'action:', action);
      
      let signature: string;

      // SNG seat_from_pool / cash seating write the session signer. If the
      // local key does not match the seat (usually a different device/browser),
      // do NOT sneak a wallet-signed update_approved_signer TX into a Fold/Call.
      // Surface an explicit "claim session" state so the user understands they
      // are linking this device's session key to the seat.
      if (sessionKey && teeConn) {
        const seatKey = `${tablePda.toBase58()}:${gameState.mySeatIndex}:${sessionKey.publicKey.toBase58()}`;
        if (approvedSignerRegisteredRef.current !== seatKey) {
          try {
            const current = await readSeatApprovedSigner(teeConn, tablePda, gameState.mySeatIndex);
            if (!current?.equals(sessionKey.publicKey)) {
              setSessionClaimRequired(true);
              throw new Error('SESSION_CLAIM_REQUIRED');
            } else {
              approvedSignerRegisteredRef.current = seatKey;
            }
          } catch (regErr: any) {
            if (regErr?.message === 'SESSION_CLAIM_REQUIRED') {
              throw new Error('Claim this seat session on this device before acting.');
            }
            console.warn('approved_signer check failed (will still attempt action):', regErr.message?.slice(0, 200));
          }
        }
      }

      // Try session key path first (gasless on TEE)
      // All actions route through session key on TEE — no wallet popups needed
      if (sessionKey && teeConn) {
        // Route each action to its specific instruction builder
        let instruction;
        if (action === 'use_time_bank') {
          instruction = buildUseTimeBankInstruction(sessionKey.publicKey, tablePda, gameState.mySeatIndex);
        } else if (action === 'return_to_play') {
          const whitelistWallet = gameState.isPrivate && publicKey && gameState.creator !== publicKey.toBase58()
            ? publicKey
            : undefined;
          instruction = buildSitInInstruction(sessionKey.publicKey, tablePda, gameState.mySeatIndex, amount !== 0, whitelistWallet);
        } else {
          instruction = buildPlayerActionInstruction(
            sessionKey.publicKey,
            tablePda,
            gameState.mySeatIndex,
            actionMap[action],
            wireAmount,
            gameState.maxPlayers,
            gameState.seatsOccupied ?? 0,
          );
        }

        const tx = new Transaction();
        if (!isNonGameplayAction) {
          tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
        }
        tx.add(instruction);
        try {
          tx.feePayer = sessionKey.publicKey;
          // TEE requires its own blockhash — L1 blockhash causes "Blockhash not found"
          try {
            tx.recentBlockhash = (await teeConn.getLatestBlockhash()).blockhash;
          } catch {
            tx.recentBlockhash = (await l1Connection.getLatestBlockhash()).blockhash;
          }
          tx.sign(sessionKey);
          // TEE WS subscriptions work, but sendAndConfirmTransaction is not used here — polling via getSignatureStatuses is simpler. Migration pending.
          signature = await teeConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
          // Poll for confirmation via getSignatureStatuses
          for (let p = 0; p < 10; p++) {
            await new Promise(r => setTimeout(r, 1000));
            const statuses = await teeConn.getSignatureStatuses([signature]);
            const status = statuses?.value?.[0];
            if (status?.err) throw new Error('session action TX err: ' + JSON.stringify(status.err));
            if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') break;
          }
          console.log(`Action ${action} confirmed (gasless on TEE):`, signature);
        } catch (sessionErr: any) {
          const sessionMsg = sessionErr.message || '';
          console.error('Session key failed:', sessionMsg.slice(0, 200));
          try {
            const current = await readSeatApprovedSigner(teeConn, tablePda, gameState.mySeatIndex);
            if (current && !current.equals(sessionKey.publicKey)) {
              approvedSignerRegisteredRef.current = null;
              setSessionClaimRequired(true);
              throw new Error('Claim this seat session on this device before acting.');
            }
          } catch (checkErr: any) {
            if (checkErr?.message?.includes('Claim this seat session')) throw checkErr;
          }
          // 6007/HandInProgress: a mid-hand sit_out (a non-gameplay action) is
          // rejected on-chain. Recognize it as a clean gameplay reject so it
          // does NOT fall through to a second, also-doomed wallet-signed TX
          // (spurious popup + ugly error). Mirrors providers.tsx HANDLED set.
          const isGameplayReject = /Custom\":(6007|6021|6022|6023|6024|6025|6026|6027|6028)\b|ComputationalBudgetExceeded|HandInProgress|0x1777|InvalidActionForPhase|NotPlayersTurn|InvalidBetAmount|BetBelowMinimum|CannotCheck|NothingToCall|RaiseTooSmall|ActionTimeout/i.test(sessionMsg);
          if (isGameplayReject) {
            throw sessionErr;
          }
          // For non-gameplay actions, fall through to wallet signing below
          if (!isNonGameplayAction) {
            throw new Error('Session expired or invalid. Reconnecting session — please try again in a moment.');
          }
          console.log(`Falling back to wallet-signed ${action}...`);
          signature = ''; // will be set below
        }

        if (signature) {
          await refreshState();
          return signature;
        }
      }

      // Wallet-signing fallback for non-gameplay actions (no session needed)
      if (isNonGameplayAction && teeConn) {
        let ix;
        if (action === 'sit_out') {
          ix = buildSitOutInstruction(publicKey, tablePda, gameState.mySeatIndex);
        } else if (action === 'return_to_play') {
          const whitelistWallet = gameState.isPrivate && gameState.creator !== publicKey.toBase58()
            ? publicKey
            : undefined;
          ix = buildSitInInstruction(publicKey, tablePda, gameState.mySeatIndex, amount !== 0, whitelistWallet);
        } else if (action === 'use_time_bank') {
          ix = buildUseTimeBankInstruction(publicKey, tablePda, gameState.mySeatIndex);
        } else {
          // leave_cash_game — no standalone instruction, use player_action with wallet signer
          ix = buildPlayerActionInstruction(
            publicKey,
            tablePda,
            gameState.mySeatIndex,
            actionMap[action],
            wireAmount,
            gameState.maxPlayers,
            gameState.seatsOccupied ?? 0,
          );
        }

        const tx = new Transaction().add(ix);
        tx.feePayer = publicKey;
        // TEE requires its own blockhash — L1 blockhash causes "Blockhash not found"
        try {
          tx.recentBlockhash = (await teeConn.getLatestBlockhash()).blockhash;
        } catch {
          tx.recentBlockhash = (await l1Connection.getLatestBlockhash()).blockhash;
        }
        // skipPreflight: wallet adapter simulates against L1 where table is delegation-owned → fails
        signature = await sendTransaction(tx, teeConn, { skipPreflight: true });
        console.log(`Action ${action} confirmed (wallet-signed on TEE):`, signature);
        await refreshState();
        return signature;
      }

      // No session and not a non-gameplay action — need session
      throw new Error('Session expired or invalid. Reconnecting session — please try again in a moment.');
    } catch (err: any) {
      console.error('Action failed:', err);
      setError(getErrorMessage(err));
      throw err;
    } finally {
      setIsPendingAction(false);
    }
  }, [publicKey, sendTransaction, gameState, refreshState, sessionKey, readSeatApprovedSigner]);

  // Tier 3 E2E hook: mirror gameState onto window.__GAMESTATE__ so Playwright
  // specs can wait on protocol state instead of fragile DOM polling. No-op
  // in production builds (see dev-state-hook.ts).
  useEffect(() => {
    publishGameState(gameState);
  }, [gameState]);

  return {
    gameState,
    isLoading,
    error,
    isConnected,
    sendAction,
    isPendingAction,
    sessionClaimRequired,
    isClaimingSession,
    claimSeatSession,
    refreshState,
    lastAction,
    wsActive,
  };
}
