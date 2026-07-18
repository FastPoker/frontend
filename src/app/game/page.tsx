'use client';

import { useEffect, useState, useCallback, useRef, useMemo, Suspense } from 'react';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { createPortal } from 'react-dom';
import { useSearchParams, useRouter } from 'next/navigation';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, Keypair } from '@solana/web3.js';
import Link from 'next/link';
import { makeL1Connection, L1_RPC, TEE_RPC_URL, ANCHOR_PROGRAM_ID, TABLE_OFFSETS, POKER_MINT, STEEL_PROGRAM_ID, POOL_PDA, TREASURY, isUsdcMint, IS_MAINNET } from '@/lib/constants';
import { sendWalletTx } from '@/lib/send-wallet-tx';
import { BRAND } from '@/lib/branding';
import { detectDelegation } from '@/lib/validator-registry';
import { useOnChainGame } from '@/hooks/useOnChainGame';
import { useShowCards } from '@/hooks/useShowCards';
import { useLinkedSeats } from '@/hooks/useLinkedSeats';
import { useChatProfiles } from '@/hooks/useChatProfiles';
import { useGameAuth } from '@/hooks/useGameAuth';
import { useSessionContext } from '@/hooks/useSession';
import PokerTable from '@/components/game/PokerTable';
import FpDebugOverlay from '@/components/game/FpDebugOverlay';
import { fpDebug } from '@/lib/fp-debug';
import { ModalShell } from '@/components/modals/ModalShell';
import { requestOpenSessionRenewModal } from '@/components/layout/SessionRenewModal';
import {
  buildDepositForJoinInstruction,
  buildDelegateDepositProofInstruction,
  buildDelegateSeatCardsInstruction,
  buildSeatPlayerInstruction,
  buildCleanupDepositProofInstruction,
  buildResizeVaultInstruction,
  buildLeaveTableInstruction,
  buildDepositTopupInstruction,
  getDepositProofPda,
  getReceiptPda,
  getWhitelistPda,
  getPlayerTableMarkerPda,
  getSeatPda,
  getSeatCardsPda,
  parseSeatState,
  SeatStatus,
  parseTableState,
  TABLE_OFFSETS as OG_TABLE_OFFSETS,
} from '@/lib/onchain-game';
import {
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { getPlayerPda } from '@/lib/pda';
import { setActiveTable, removeActiveGame, addActiveGame } from '@/components/layout/ActiveTableBar';
import { refreshMyActiveTables } from '@/hooks/useMyActiveTables';
import { setSessionKey } from '@/lib/session-storage';
import { getErrorMessage } from '@/lib/error-messages';
import { assertFunds, FUNDS_HINTS } from '@/lib/assertFunds';
import { useFundsErrorHandler } from '@/components/wallet/InsufficientFundsModal';
import { useWalletBalances } from '@/hooks/useWalletBalances';
import { SFX } from '@/lib/sfx';
import { buildWalletApiAuth } from '@/lib/wallet-api-auth';
import { getDeviceId } from '@/lib/device-id';
import { confirmFundsAction } from '@/lib/funds-confirmation';
import { classifyHandActions } from '@/lib/hand-action-classifier';
import { JackpotCeremonyOverlay } from '@/components/jackpot/JackpotCeremonyOverlay';
import { PlayAccessGate } from '@/components/access/PlayAccessGate';

const REGISTER_DISCRIMINATOR = Buffer.from([242, 146, 194, 234, 234, 145, 228, 42]);
const INIT_UNREFINED_DISC = Buffer.from([24]);
function getUnrefinedPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('unrefined'), owner.toBuffer()], STEEL_PROGRAM_ID);
}

const SIT_OUT_KICK_TIMEOUT_SECS = 5 * 60;

// ─── Main Component ───

export default function CashGamePage() {
  // Query-param route (/game?table=<pda>) so the page is statically exportable
  // (a dynamic [id] segment can't be pre-rendered for arbitrary table PDAs).
  // useSearchParams requires a Suspense boundary under static export.
  return (
    <Suspense fallback={null}>
      <PlayAccessGate>
        <CashGameView />
      </PlayAccessGate>
    </Suspense>
  );
}

function CashGameView() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tablePubkey = (searchParams.get('table') ?? '') as string;
  const { publicKey, sendTransaction, signTransaction, signMessage, isConnected: connected } = useUnifiedWallet();
  const { session, createSession, reloadSession } = useSessionContext();
  const { teeConnection, teeAuthenticated, forceRefresh: forceRefreshTee, authenticatePlayer, ensurePlayerAuth, ensurePlayerConnection, isPlayerReady, getConnectionForValidator } = useGameAuth();

  // Detect which validator this table is delegated to (from L1 delegation record)
  const [tableValidatorUrl, setTableValidatorUrl] = useState<string | null>(null);
  const detectedRef = useRef(false);
  useEffect(() => {
    if (detectedRef.current || !tablePubkey) return;
    detectedRef.current = true;
    const l1 = makeL1Connection();
    detectDelegation(l1, new PublicKey(tablePubkey)).then(result => {
      if (result.isDelegated && result.validatorEntry) setTableValidatorUrl(result.validatorEntry.rpcUrl);
    }).catch(() => {});
  }, [tablePubkey]);

  // Use the correct validator connection (detected or default)
  // CRITICAL: teeConnection has the player's token (can read hole cards).
  // getConnectionForValidator returns authority-level connections (CANNOT read hole cards).
  // Always prefer teeConnection unless the table is on a truly different validator.
  const activeConnection = useMemo(() => {
    if (!tableValidatorUrl) return teeConnection;
    // Normalize URLs for comparison (strip trailing slash, protocol, port differences)
    const normalize = (url: string) => url.replace(/\/$/, '').replace(/^https?:\/\//, '').toLowerCase();
    const detectedNorm = normalize(tableValidatorUrl);
    const defaultNorm = normalize(TEE_RPC_URL);
    if (detectedNorm === defaultNorm) {
      return teeConnection;
    }
    // Non-default validator — use teeConnection anyway since it has the player token.
    // Authority-only connections can't read permissioned seatCards (hole cards).
    // TODO: support player-level auth for multiple validators when needed.
    console.warn(`[game] Detected validator ${tableValidatorUrl} differs from default ${TEE_RPC_URL} — using player teeConnection anyway`);
    return teeConnection;
  }, [tableValidatorUrl, teeConnection, getConnectionForValidator]);

  // Reuse exact same hook as SNG — handles ER/L1 routing, WebSocket subscriptions, gasless actions
  const {
    gameState,
    isLoading: gameLoading,
    isConnected: gameConnected,
    sendAction,
    sendDuelAction,
    isPendingAction,
    sessionClaimRequired,
    isClaimingSession,
    claimSeatSession,
    error: gameError,
    refreshState,
  } = useOnChainGame(tablePubkey, session.sessionKey, activeConnection, teeAuthenticated, forceRefreshTee, ensurePlayerConnection);

  // Voluntary off-chain card show (post-hand only; signed by the session key).
  const showCards = useShowCards(tablePubkey, gameState?.handNumber, session.sessionKey, gameState?.mySeatIndex);

  // Anti-collusion transparency: session keys at this table that share a device
  // (the "LINKED" badge). Heartbeats while seated; cash same-device is blocked
  // at seat time, so links surface in practice only on SNG.
  const linkedSigners = useLinkedSeats(
    tablePubkey,
    !!(gameState && gameState.mySeatIndex >= 0),
    session.sessionKey,
  );

  // Hand-log usernames (pubkey → username, batched + cached). Read the latest via
  // a ref so the action-log effect can resolve names without taking seatProfiles
  // as a dep (which would re-run it on every profile load). Falls back to a short
  // pubkey when a profile hasn't loaded yet.
  const seatWallets = useMemo(
    () => (gameState?.players ?? [])
      .map(p => p.pubkey)
      .filter((w): w is string => !!w && w !== '11111111111111111111111111111111'),
    [gameState?.players],
  );
  const seatProfiles = useChatProfiles(seatWallets);
  const seatProfilesRef = useRef(seatProfiles);
  seatProfilesRef.current = seatProfiles;
  const handLogName = (pubkey?: string): string => {
    if (!pubkey) return '';
    if (pubkey === publicKey?.toBase58()) return 'You';
    return seatProfilesRef.current[pubkey]?.username || `${pubkey.slice(0, 6)}...`;
  };

  // Cash-game-specific state
  const [actionPending, setActionPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [claimDebug, setClaimDebug] = useState<string | null>(null);
  // Last status/error banner the user manually dismissed via its × — suppresses
  // that exact message until a different one arrives (gameError is read-only from
  // the hook, so we gate on the message string to dismiss either source).
  const [bannerClosed, setBannerClosed] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "It's not your turn to act.") return;
    const timer = setTimeout(() => {
      setStatus(current => current === status ? null : current);
    }, 3500);
    return () => clearTimeout(timer);
  }, [status]);

  const confirmSeatSessionUpdate = useCallback(() => confirmFundsAction({
    title: 'Confirm Seat Session',
    action: 'Use this device for this seat',
    table: tablePubkey,
    details: [
      'No SOL or tokens move.',
      'This only updates the session key approved for your poker seat.',
      'Phantom may show a warning because this is a custom TEE session update.',
      'Approve only if you are moving this seat to this device.',
    ],
  }), [tablePubkey]);

  const handleClaimSeatSession = useCallback(async () => {
    setClaimDebug('claim: click');
    try {
      if (!session.isActive) {
        setStatus('Generating session key for this device...');
        setClaimDebug('claim: generating key');
        await createSession();
        reloadSession();
        setStatus('Session key generated. Tap Claim Session again to finish.');
        setClaimDebug('claim: key generated');
        return;
      }

      setStatus(isPlayerReady ? 'Claiming seat session...' : 'Authenticating TEE session...');
      if (!isPlayerReady) {
        setClaimDebug('claim: authenticating TEE');
        await authenticatePlayer();
        setClaimDebug('claim: TEE auth returned');
      }

      if (!(await confirmSeatSessionUpdate())) {
        setStatus('Seat session claim cancelled.');
        setClaimDebug('claim: cancelled before wallet');
        return;
      }

      setStatus('Claiming seat session on this device...');
      await claimSeatSession(setClaimDebug);
      setStatus('Session claimed. You can act without wallet popups.');
      setClaimDebug('claim: done');
      await refreshState();
    } catch (e: any) {
      setClaimDebug(`claim: caught ${e?.message?.slice(0, 120) || 'error'}`);
      if (e?.message?.includes('6021') || e?.message?.includes('InvalidActionForPhase')) {
        setStatus('Seat session claim failed because table state changed. Refreshing...');
        await refreshState();
        return;
      }
      setStatus(getErrorMessage(e));
    }
  }, [session.isActive, createSession, reloadSession, gameState, isPlayerReady, authenticatePlayer, confirmSeatSessionUpdate, claimSeatSession, refreshState]);

  // SNG direct join from table view
  // Routes INSUFFICIENT_FUNDS errors caught in confirmBuyIn / handleTopup
  // to the polished InsufficientFundsModal (live balance polling, Privy
  // fund flow, faucet link) instead of dropping a raw JSON string into the
  // status pill. Returns true when handled — callers short-circuit.
  const handleFundsError = useFundsErrorHandler();
  // Wallet balances (SOL + POKER) for capping the buy-in slider to what
  // the user can actually afford. Avoids the "dial up to 100 BB, then
  // discover at sign-time you only have 5 BB" foot-gun.
  const walletBalances = useWalletBalances();

  const handleSngSeatClick = useCallback(async (_seatIndex: number) => {
    if (!publicKey || !gameState) return;
    if (gameState.phase !== 'Waiting') {
      setStatus('SNG already started. Seats are locked.');
      return;
    }
    setStatus('SNG seats are assigned by pool matching. Join from the lobby pool or resume your matched table.');
  }, [publicKey, gameState]);
  const [leavingTable, setLeavingTable] = useState(false);
  const [shareTooltip, setShareTooltip] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareCopied, setShareCopied] = useState<string | null>(null);

  // Buy-in modal state
  const [buyInModal, setBuyInModal] = useState<{ seatIndex: number; mode?: 'join' | 'topup' } | null>(null);
  const [buyInBBs, setBuyInBBs] = useState(50);
  const [buyInLoading, setBuyInLoading] = useState(false);
  const [ratholeLock, setRatholeLock] = useState<{ chipsAtLeave: number; minutesLeft: number; kickPenalty: number } | null>(null);
  const [pendingJoinSeat, setPendingJoinSeat] = useState<number | null>(null);
  // Unix seconds of the pending deposit (DepositProof.deposit_timestamp).
  // Drives the refund countdown: the contract timelocks refund_failed_deposit
  // for 180s after deposit, and the crank auto-refunds right after — clicking
  // "Cancel & refund" early just fails on-chain (the "refund didn't work"
  // reports). Null when the proof is delegation-owned (timestamp unreadable).
  const [pendingDepositAt, setPendingDepositAt] = useState<number | null>(null);
  const [refundNowTick, setRefundNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (pendingJoinSeat === null) return;
    const iv = setInterval(() => setRefundNowTick(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [pendingJoinSeat]);
  const [reservedJoinSeat, setReservedJoinSeat] = useState<number | null>(null);
  const [selectedJoinSeat, setSelectedJoinSeat] = useState<number | null>(null);
  const [reservedJoinSeats, setReservedJoinSeats] = useState<number[]>([]);
  const [clearingJoinSeats, setClearingJoinSeats] = useState<number[]>([]);
  const [joiningSeat, setJoiningSeat] = useState<number | null>(null);
  const [cancelPendingSeat, setCancelPendingSeat] = useState<number | null>(null);
  const staleMarkerClearInFlight = useRef<Set<string>>(new Set());
  // seatIndex -> first time we saw an L1-unverifiable DepositProof reservation
  // there (delegated to ER, or missing deposit_timestamp). Used to age them out
  // so a stranded proof can't pin an empty seat to "JOINING" forever.
  const unverifiableReservationFirstSeen = useRef<Map<number, number>>(new Map());

  // Top-up modal state (add chips while seated)
  const [topupModal, setTopupModal] = useState(false);
  const [topupBBs, setTopupBBs] = useState(20);
  const [topupLoading, setTopupLoading] = useState(false);
  // Non-intrusive "topping up" indicator: set when the top-up TX is sent, cleared
  // by the watcher below once the seat's chips actually grow past `baseline`
  // (i.e. the deposit landed on the TEE), or by a safety timeout. `baseline` is
  // the hero's chip count at submit time.
  const [topupPending, setTopupPending] = useState<{ baseline: number; at: number } | null>(null);

  // Sit-out / auto-post-blinds
  const [autoPostBlinds, setAutoPostBlinds] = useState(true);
  const [sittingOutPending, setSittingOutPending] = useState(false);
  const sittingOutPendingRef = useRef(false);
  // Holds a queued sit-in (the post_missed_blinds flag) when I'M BACK is clicked
  // mid-hand: sit_in only lands between hands, so we auto-fire it at the next
  // hand boundary instead of dead-ending on HandInProgress. null = nothing queued.
  const sitInQueuedRef = useRef<boolean | null>(null);
  // Bounds the auto-retry of a rejected return_to_play (see handleSitIn catch).
  // A 6021 InvalidActionForPhase can be transient (hand advanced under us) OR
  // durable (waiting-for-BB still behind the button, a never-played joiner
  // posting missed blinds). Without a cap, re-arming on a durable 6021 spins a
  // gasless TX loop because the auto-fire effect re-runs on every state refresh.
  const sitInRetryRef = useRef(0);

  // Rake info (read from L1 directly — these fields aren't in useOnChainGame)
  const [rakeAccum, setRakeAccum] = useState(0);
  const [creatorRake, setCreatorRake] = useState(0);
  const [tokenMint, setTokenMint] = useState(PublicKey.default.toBase58());
  const [resolvedDecimals, setResolvedDecimals] = useState<number | null>(null);
  const [isCreator, setIsCreator] = useState(false);
  const [buyInType, setBuyInType] = useState(0); // 0=Normal(20-100BB), 1=Deep(50-250BB)
  const [rakeCap, setRakeCap] = useState(0); // rake cap in token units (0=no cap)
  // Dealer rake is mandatory: 45% creator, 5% dealer, 25% stakers, 25% treasury
  // Tip Jar
  const [tipJarBalance, setTipJarBalance] = useState(0);
  const [tipJarHands, setTipJarHands] = useState(0);
  const [tipJarTotal, setTipJarTotal] = useState(0);
  const [showTipModal, setShowTipModal] = useState(false);
  const [tipAmount, setTipAmount] = useState('0.01');
  const [tipPending, setTipPending] = useState(false);
  const [handHistory, setHandHistory] = useState<{ player: string; action: string; amount?: number; phase: string }[]>([]);
  const [pastHands, setPastHands] = useState<{ player: string; action: string; amount?: number; phase: string }[][]>([]);
  const [viewingPastHand, setViewingPastHand] = useState<number | null>(null);
  const [lastVerifyUrl, setLastVerifyUrl] = useState<string | null>(null);
  const [playerActions, setPlayerActions] = useState<{ seatIndex: number; action: string; timestamp: number }[]>([]);
  // Optimistic hero bet: your own bet/call/raise renders chips on the felt at
  // CLICK time instead of after the TX confirm round trip (1s+ steps). Expires
  // when the on-chain seat catches up, the hand changes, or after 6s.
  const [optimisticHeroBet, setOptimisticHeroBet] = useState<{ hand: number; amount: number; at: number } | null>(null);

  // Showdown state tracking — snapshot + hold so cards/results stay visible
  const [showdownHold, setShowdownHold] = useState(false);
  const [showdownPot, setShowdownPot] = useState<number | undefined>();
  // Per-player gross return at showdown (chip delta post-settle vs pre-settle).
  // For all-in players (stack at 0 going in) this equals what they pulled from
  // the pot, so an unequal all-in split shows each winner their REAL amount
  // instead of an equal slice. Keyed by pubkey; reset at each hand boundary
  // alongside showdownPot.
  const [showdownPayouts, setShowdownPayouts] = useState<Record<string, number>>({});
  const [showdownSnapshot, setShowdownSnapshot] = useState<{
    handNumber: number;
    communityCards: number[];
    players: any[];
    myCards?: [number, number];
  } | null>(null);
  const lastValidCommunityRef = useRef<number[]>([]);
  const showdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showdownStartRef = useRef<number>(0); // Timestamp when showdown hold began
  const prevPhaseRef = useRef<string | null>(null);
  // Community-card count last logged this hand, so we emit a FLOP/TURN/RIVER row
  // the moment each street is dealt (independent of the showdown board summary,
  // which the staged-reveal gate can filter out on SNG all-in run-outs).
  const prevCommunityCountRef = useRef(0);
  const lastOnChainRef = useRef<typeof gameState>(null);
  // Dedup refs for showdown summary lines — reveals can arrive after the phase
  // transition, so we re-enter the summary block on every update and skip
  // anything already logged for this hand.
  const summaryHandRef = useRef<number>(-1);
  const summaryBoardLoggedRef = useRef<boolean>(false);
  const summaryPlayerLoggedRef = useRef<Set<string>>(new Set());
  const summaryWinnerLoggedRef = useRef<Set<string>>(new Set());

  // ─── Hand-outcome safeguard (recap-only; never touches the read/sign path) ──
  // Guarantees you always see the result of a hand you contested, even when lag
  // or a fast "no actions left" resolution made the client miss the live
  // runout/showdown frames. Per-hand tracking below; on the hand boundary, if
  // you were dealt in, didn't fold, still have a stack, and no live result was
  // shown for that hand, we surface a small non-intrusive recap built from your
  // chip-delta + an authoritative /api/hand-history fetch (board + winners).
  type RecapState = { handNumber: number; board: string[]; heroWon: boolean; heroDelta: number; loading: boolean; isSng: boolean; endAction?: string; heroAllIn?: boolean };
  const [handRecap, setHandRecap] = useState<RecapState | null>(null);
  // Last resolved recap, retained after the card auto-dismisses so the player
  // can click to re-show the board/result for the hand they just played.
  const [lastHandRecap, setLastHandRecap] = useState<RecapState | null>(null);
  const resultShownForHandRef = useRef<number>(-1); // hand whose result the live UI already showed
  const recapEvalHandRef = useRef<number>(-1);       // hand currently being tracked
  const recapDoneForHandRef = useRef<number>(-1);    // hand already recapped (no repeat)
  const heroStartChipsRef = useRef<number | null>(null); // hero chips at the start of the tracked hand
  const heroDealtInThisHandRef = useRef(false);
  const heroFoldedThisHandRef = useRef(false);

  // Auto-authenticate with TEE as player when game page opens (not just when seated).
  // This ensures hole card access is ready BEFORE the user sits down.
  // On wallet connect, GameAuthProvider auto-fetches authority token silently (no popup).
  // Here we upgrade to player token (signMessage) on game page mount — but ONLY if not already authenticated.
  // Open the SessionRenewModal first so the user sees WHY the wallet popup
  // is about to appear, rather than getting a bare sign request out of nowhere.
  const hasTriggeredPlayerAuthRef = useRef(false);
  useEffect(() => {
    if (connected && !isPlayerReady && !hasTriggeredPlayerAuthRef.current) {
      hasTriggeredPlayerAuthRef.current = true;
      requestOpenSessionRenewModal();
    }
  }, [connected, isPlayerReady]);

  // Mid-hand auth recovery. If we're seated in an active hand and our hole
  // cards are missing because the TEE Player token isn't active (Authority
  // Only), the user is locked out — the seat timer ticks against them while
  // they have nothing to act on. Prompt the SessionRenewModal once per hand.
  //
  // Guards against loop:
  //  - handNumberRef tracks the last hand we prompted on; only one prompt
  //    per hand. User dismissal sticks for the rest of the hand.
  //  - 3-second debounce lets normal TEE reveal latency land first, so we
  //    don't fire for transient lateness.
  //  - Resets on phase=Waiting (new hand) so a dismissal doesn't persist
  //    forever if the auth genuinely recovers.
  const cardsStuckPromptRef = useRef<{ handNumber: number | null; prompted: boolean }>({
    handNumber: null, prompted: false,
  });
  useEffect(() => {
    if (!gameState) return;
    const phase = gameState.phase;
    const hn = gameState.handNumber ?? null;
    if (cardsStuckPromptRef.current.handNumber !== hn) {
      cardsStuckPromptRef.current = { handNumber: hn, prompted: false };
    }
    const inActiveHand = phase !== 'Waiting' && phase !== 'Complete';
    if (!inActiveHand) return;
    if (gameState.mySeatIndex < 0) return;
    const me = gameState.players?.find(p => p.seatIndex === gameState.mySeatIndex);
    // SNG: a sit-out hero IS dealt and should receive their cards, so the
    // stuck-card "sign to receive your cards" prompt must still fire for them.
    // Only skip for cash sit-out (never dealt).
    const isSngTbl = gameState.isCashGame === false;
    if (!me || me.folded || (me.isSittingOut && !isSngTbl)) return;
    if (gameState.myCards !== undefined) return;
    if (isPlayerReady) return;
    if (cardsStuckPromptRef.current.prompted) return;
    const t = setTimeout(() => {
      if (cardsStuckPromptRef.current.prompted) return;
      cardsStuckPromptRef.current.prompted = true;
      setStatus('Session is read-only — sign to receive your cards.');
      requestOpenSessionRenewModal();
    }, 3000);
    return () => clearTimeout(t);
  }, [gameState?.phase, gameState?.handNumber, gameState?.mySeatIndex, gameState?.myCards, gameState?.players, isPlayerReady]);

  // Track active table in localStorage for the ActiveTableBar component.
  // Critical: only stamp the entry when actually seated (mySeatIndex >= 0),
  // and use the correct type — SNG tables were incorrectly labeled "Cash"
  // when routed through setActiveTable (which always writes type:'cash').
  useEffect(() => {
    if (gameState && gameState.mySeatIndex >= 0) {
      const isCash = gameState.isCashGame !== false;
      const blindsText = gameState.blinds
        ? isCash
          ? `${fmtTokenAmount(gameState.blinds.small, 4)}/${fmtTokenAmount(gameState.blinds.big, 4)}`
          : `${gameState.blinds.small}/${gameState.blinds.big}`
        : '';
      if (isCash) {
        setActiveTable({ tablePda: tablePubkey, blinds: blindsText, maxPlayers: gameState.maxPlayers });
      } else {
        const maxP = gameState.maxPlayers;
        const typeLabel = maxP === 2 ? 'HU' : maxP === 6 ? '6-Max' : '9-Max';
        addActiveGame({ tablePda: tablePubkey, type: 'sng', maxPlayers: maxP, label: `SNG ${typeLabel}` });
      }
    }
  }, [gameState?.mySeatIndex, gameState?.isCashGame, tablePubkey, tokenMint]);

  // Clear active table on unmount (navigating away) only if no longer seated
  useEffect(() => {
    return () => {
      // Don't clear immediately — let the bar persist briefly for back-navigation.
      // It will be overwritten when re-entering a game page, or cleared on leave.
    };
  }, []);

  // Fetch rake info separately (not part of useOnChainGame)
  useEffect(() => {
    if (!tablePubkey) return;
    const fetchRake = async () => {
      try {
        const conn = makeL1Connection();
        let pda: PublicKey;
        try { pda = new PublicKey(tablePubkey); } catch { return; }
        const acct = await conn.getAccountInfo(pda);
        if (!acct) return;
        const data = Buffer.from(acct.data);
        const O = TABLE_OFFSETS;
        if (data.length >= O.RAKE_ACCUMULATED + 8) setRakeAccum(Number(data.readBigUInt64LE(O.RAKE_ACCUMULATED)));
        if (data.length >= O.CREATOR_RAKE_TOTAL + 8) setCreatorRake(Number(data.readBigUInt64LE(O.CREATOR_RAKE_TOTAL)));
        if (data.length >= O.TOKEN_MINT + 32) setTokenMint(new PublicKey(data.subarray(O.TOKEN_MINT, O.TOKEN_MINT + 32)).toBase58());
        if (data.length > O.BUY_IN_TYPE) setBuyInType(data[O.BUY_IN_TYPE]);
        if (data.length >= O.RAKE_CAP + 8) setRakeCap(Number(data.readBigUInt64LE(O.RAKE_CAP)));
        // dealer rake is mandatory — no crank_rake_enabled flag needed
        if (data.length >= O.CREATOR + 32 && publicKey) {
          const creator = new PublicKey(data.subarray(O.CREATOR, O.CREATOR + 32));
          setIsCreator(creator.equals(publicKey));
        }
        // (unclaimed-SOL read removed: claim_unclaimed_sol is disabled on-chain and the
        // ticket amount is inflated; stranded cash is returned via admin recovery)
        // Fetch TipJar PDA
        try {
          const [tipJarPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('tip_jar'), pda.toBuffer()],
            new PublicKey(ANCHOR_PROGRAM_ID),
          );
          const tjAcct = await conn.getAccountInfo(tipJarPda);
          if (tjAcct && tjAcct.data.length >= 67) {
            const tjd = Buffer.from(tjAcct.data);
            setTipJarBalance(Number(tjd.readBigUInt64LE(40))); // balance at offset 8+32=40
            setTipJarHands(tjd.readUInt16LE(48)); // hands_remaining at offset 40+8=48
            setTipJarTotal(Number(tjd.readBigUInt64LE(50))); // total_deposited at 48+2=50
          }
        } catch {}
      } catch (e) {
        console.error('Failed to fetch rake info:', e);
      }
    };
    fetchRake();
    const id = setInterval(fetchRake, 15000); // 15s (L1 reads, not TEE)
    return () => clearInterval(id);
  }, [tablePubkey, publicKey]);

  // Track opponent actions + hand history (same logic as SNG page)
  useEffect(() => {
    const prev = lastOnChainRef.current;
    if (!gameState || !prev) {
      lastOnChainRef.current = gameState;
      return;
    }
    const prevPhase = prev.phase;
    const currPhase = gameState.phase;
    const sameHand = prev.handNumber === gameState.handNumber;
    const blinds = gameState.blinds;

    // Reset summary dedup refs on ANY handNumber change — previously this was
    // gated on phaseEntering/revealEntering which failed on reconnects and on
    // mid-showdown joins, leaving summaryHandRef at its old value and gating
    // the whole summary block off. Unconditional reset fixes that.
    if (summaryHandRef.current !== gameState.handNumber) {
      summaryHandRef.current = gameState.handNumber;
      summaryBoardLoggedRef.current = false;
      summaryPlayerLoggedRef.current = new Set();
      summaryWinnerLoggedRef.current = new Set();
    }

    // Formatter for hand log — chip values for SNG, lamports→SOL for cash
    const isCash = gameState.isCashGame !== false;
    const fmtVal = (v: number) => {
      if (!isCash) return v.toLocaleString();
      return fmtTokenAmount(v, 9);
    };

    // New hand detection: archive whenever handNumber bumps, regardless of
    // phase. Previous gate on currPhase === Starting|PreFlop missed cases
    // where the WS update landed on a different phase first, leaving the
    // prior hand's rows in the new hand's log forever. Position-based blind
    // detection below works in any phase since positions persist all hand.
    if (prev.handNumber !== gameState.handNumber && gameState.handNumber > 0) {
      // Archive previous hand
      setHandHistory(h => {
        if (h.length > 0) setPastHands(past => [...past, h]);
        return [];
      });
      setViewingPastHand(null);
      setPlayerActions([]);
      setShowdownPot(undefined); setShowdownPayouts({});
      setLastVerifyUrl(null);
      prevCommunityCountRef.current = 0;

      // Log blinds. Prefer the contract-assigned position label — bet-amount
      // matching was unreliable on hot tables where the SB had already called
      // up to BB by the time this effect fired, so the SB row never logged
      // and the user only saw "BB X" with no SB.
      const now = Date.now();
      for (const p of gameState.players) {
        // SNG: a sit-out seat is still blinded off (dealt), so log its blind post.
        // Cash sit-out seats are not dealt. (isCash defined above.)
        if (!p.isActive && !(!isCash && p.isSittingOut)) continue;
        const label = handLogName(p.pubkey);
        // SB/BB from the authoritative table scalars (always fresh from both the
        // poll and WS paths), NOT p.position — which can drift from
        // smallBlindSeat/bigBlindSeat on a WS hand-change — and NOT a bet-amount
        // fallback, which mislabels (and can make one seat post BOTH blinds) when a
        // seat's bet coincidentally equals a blind. Fixes the offset-by-1 +
        // "posts both SB and BB in one hand" reports.
        const isSB = p.seatIndex === gameState.smallBlindSeat;
        const isBB = p.seatIndex === gameState.bigBlindSeat;
        if (isSB) {
          setHandHistory(h => [...h, { player: label, action: `SB ${fmtVal(blinds.small)}`, phase: 'PreFlop' }]);
          setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== p.seatIndex), { seatIndex: p.seatIndex, action: `SB ${fmtVal(blinds.small)}`, timestamp: now }]);
        } else if (isBB) {
          setHandHistory(h => [...h, { player: label, action: `BB ${fmtVal(blinds.big)}`, phase: 'PreFlop' }]);
          setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== p.seatIndex), { seatIndex: p.seatIndex, action: `BB ${fmtVal(blinds.big)}`, timestamp: now + 1 }]);
        }
      }
      lastOnChainRef.current = gameState;
      return;
    }

    // Street/phase boundary: clear the seat action bubbles. A bubble is only
    // meaningful on the street it happened on — letting a flop CHECK ride into
    // the turn read as "he already checked the turn" while that player hadn't
    // acted yet, and hand-end bubbles (FOLD / BET x) bled into the WAITING FOR
    // DEALER screen. The hand log below keeps the full per-street history; the
    // felt only shows current-street actions.
    const phaseChanged = prev.phase !== gameState.phase;
    if (phaseChanged) setPlayerActions(p => (p.length ? [] : p));

    // Detect opponent actions from table-atomic signals first. Fold/all-in masks
    // and currentBet are updated on the table account in the same mutation that
    // advances the turn, so this path does not depend on seat-WS timing. Seat chip
    // deltas remain only a fallback for contribution amounts on closing ticks.
    const classifiedActions = classifyHandActions(prev, gameState);
    if (classifiedActions.length > 0) {
      const wallet = publicKey?.toBase58();
      const now = Date.now();
      const rows: { player: string; action: string; phase: string }[] = [];
      const seatActions: { seatIndex: number; action: string; timestamp: number }[] = [];

      for (const classified of classifiedActions) {
        const player =
          gameState.players.find((p: { seatIndex: number }) => p.seatIndex === classified.seatIndex) ||
          prev.players.find((p: { seatIndex: number }) => p.seatIndex === classified.seatIndex);
        if (!player || player.pubkey === wallet) continue;

        const action = classified.amount !== undefined
          ? `${classified.kind} ${fmtVal(classified.amount)}`
          : classified.kind;
        rows.push({
          player: handLogName(player.pubkey),
          action,
          phase: classified.phase,
        });
        seatActions.push({
          seatIndex: classified.seatIndex,
          action,
          timestamp: now + seatActions.length,
        });
      }

      if (rows.length > 0) {
        setHandHistory(h => [...h, ...rows]);
        // Street-closing actions arrive on the SAME tick as the phase advance
        // (the contract mutates both atomically). Those belong to the street
        // that just ENDED — re-seeding their bubbles here is what made a flop
        // CHECK read as a turn action. Log rows above keep the history; the
        // felt only carries bubbles for the street in progress.
        if (!phaseChanged) {
          setPlayerActions(existing => {
            const changedSeats = new Set(seatActions.map(a => a.seatIndex));
            return [
              ...existing.filter(a => !changedSeats.has(a.seatIndex)),
              ...seatActions,
            ];
          });
        }
      }
    }

    // Track valid community cards (settle resets them before frontend can read)
    const validComm = (gameState.communityCards || []).filter((c: number) => c !== 255 && c >= 0 && c <= 51);
    if (validComm.length > 0) {
      lastValidCommunityRef.current = [...gameState.communityCards];
    }

    // Log the board per street as it's dealt, so the action log shows the
    // FLOP/TURN/RIVER cards when they land — not only in the showdown summary
    // (which the felt staged-reveal gate can hide on SNG all-in run-outs). Catch
    // up every crossed street if the board jumps (all-in run-out bursts 0→5).
    if (sameHand && validComm.length > prevCommunityCountRef.current) {
      const R = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
      const S = ['s', 'h', 'd', 'c'];
      const fmtCard = (c: number) => (c >= 0 && c <= 51 ? `${R[c % 13]}${S[Math.floor(c / 13)]}` : '?');
      const prevN = prevCommunityCountRef.current;
      const streetRows: { player: string; action: string; phase: string }[] = [];
      if (prevN < 3 && validComm.length >= 3) streetRows.push({ player: '', action: `Flop  ${validComm.slice(0, 3).map(fmtCard).join(' ')}`, phase: 'Flop' });
      if (prevN < 4 && validComm.length >= 4) streetRows.push({ player: '', action: `Turn  ${fmtCard(validComm[3])}`, phase: 'Turn' });
      if (prevN < 5 && validComm.length >= 5) streetRows.push({ player: '', action: `River  ${fmtCard(validComm[4])}`, phase: 'River' });
      if (streetRows.length) setHandHistory(h => [...h, ...streetRows]);
      prevCommunityCountRef.current = validComm.length;
    }

    // Showdown/Complete detection — snapshot + hold + hand log.
    // Trigger on EITHER the phase transition OR revealed_hands appearing,
    // because settle.rs writes revealed_hands in the same atomic TX that flips
    // phase to Waiting — so in many WS timelines phase=Showdown and populated
    // revealed_hands never coexist. Without the second signal we would skip
    // the showdown UI entirely (user reports "NONE of 1s").
    const hasRevealedNow = gameState.revealedHands?.some((c: number) => c !== 255) ?? false;
    const hadRevealedPrev = prev.revealedHands?.some((c: number) => c !== 255) ?? false;
    if (showdownHold && currPhase === 'Starting' && showdownSnapshot && gameState.handNumber > showdownSnapshot.handNumber) {
      // Defer bailout until winner-pulse can play. PokerTable's stage 5
      // (winner-pulse + chip flight) fires ~4600ms after cards-revealed on an
      // all-in run-out; the 6500ms gate below covers that + chip flight. Without
      // this gate, hot tables that start the next hand in 2s wipe the showdown
      // UI before the chip animation fires — user reports "I dont always see
      // the table winner animation for chips" map to this race.
      // Fall back to immediate release if showdownStartRef was never stamped
      // (defensive — should be rare since cards reveal sets it).
      const elapsed = showdownStartRef.current > 0 ? Date.now() - showdownStartRef.current : Infinity;
      if (elapsed < 6500) {
        fpDebug(`showdownHold.newHandStarting deferred elapsed=${elapsed}ms (waiting for winner animation)`);
      } else {
        fpDebug(`showdownHold.release reason=newHandStarting prevHand=${showdownSnapshot.handNumber} newHand=${gameState.handNumber}`);
        setShowdownHold(false);
        setShowdownPot(undefined); setShowdownPayouts({});
        setShowdownSnapshot(null);
        lastValidCommunityRef.current = [];
        showdownStartRef.current = 0;
        if (showdownTimerRef.current) {
          clearTimeout(showdownTimerRef.current);
          showdownTimerRef.current = null;
        }
      }
    }
    // ALL-IN RUNOUT GUARD. When two+ players are all-in, the contract runs the
    // board out one street at a time and writes revealed_hands EARLY (at the
    // flop), cycling FlopRevealPending → TurnRevealPending → Showdown(3/5) →
    // RiverRevealPending(4/5) → Showdown(5/5). Both showdown triggers below fire
    // on that flop-stage reveal/Showdown, which froze the snapshot at 3 community
    // cards and ran the winner sequence before turn + river dealt — the "all-in
    // is messed up / board stuck on flop then jumps" report. So: don't start the
    // ceremony while a runout is still in progress (>=2 live players AND the
    // board isn't complete). Fold-wins (<=1 live player) have no runout and fire
    // immediately even with a short board; real terminal showdowns have board==5.
    // Opponent cards still flip live during the runout via gameState.players —
    // that reveal is independent of this hold.
    const validBoardCard = (c: number) => c !== 255 && c >= 0 && c <= 51;
    const boardCount = (gameState.communityCards || []).filter(validBoardCard).length;
    const liveNonFolded = gameState.players?.filter((p: any) => !p.folded).length ?? 0;
    const runoutInProgress = liveNonFolded >= 2 && boardCount < 5 && currPhase !== 'Complete';

    const phaseEntering = (currPhase === 'Showdown' || currPhase === 'Complete') && prevPhase !== 'Showdown' && prevPhase !== 'Complete' && !runoutInProgress;
    const revealEntering = hasRevealedNow && !hadRevealedPrev && !showdownHold && currPhase !== 'Starting' && !runoutInProgress;
    // Catch the terminal all-in showdown even if its phase edge was absorbed by
    // an intermediate Showdown tick: the river just landed (board reached 5) with
    // hands revealed. Without this the runout guard above could swallow the only
    // trigger when the phase sequence skips a *RevealPending before the final
    // Showdown.
    const prevBoardCount = (prev?.communityCards || []).filter(validBoardCard).length;
    const boardJustCompleted = boardCount >= 5 && prevBoardCount < 5 && hasRevealedNow && !showdownHold;
    if (phaseEntering || revealEntering || boardJustCompleted) {
      // Settle atomically adds the final call to table.pot then resets it to 0,
      // so on most WS ticks `gameState.pot` is 0 and `prev.pot` misses the last
      // call. Use chip-delta math (post-settle chips vs pre-settle chips) as the
      // primary source — it's resilient to the tick-timing race. Fall back to
      // sum(totalBetThisHand), then raw pot, then last-known pot.
      let computedPot = 0;
      const payouts: Record<string, number> = {};
      const prevPlayers = prev?.players as any[] | undefined;
      const currPlayers = gameState.players as any[] | undefined;
      if (prevPlayers?.length && currPlayers?.length) {
        for (const cp of currPlayers) {
          const pp = prevPlayers.find((p: any) => p.pubkey === cp.pubkey);
          if (!pp) continue;
          const gain = (cp.chips ?? 0) - (pp.chips ?? 0);
          if (gain > computedPot) computedPot = gain;
          if (gain > 0 && cp.pubkey) payouts[cp.pubkey] = gain;
        }
      }
      if (computedPot <= 0) {
        const totalBetsSum = (prev?.players || []).reduce((s: number, p: any) => s + (p.totalBetThisHand || 0), 0);
        computedPot = totalBetsSum || gameState.pot || prev?.pot || 0;
      }
      if (computedPot > 0) setShowdownPot(computedPot);
      if (Object.keys(payouts).length) setShowdownPayouts(payouts);

      // Snapshot the game state for display hold.
      // Prefer `gameState` as source whenever it carries revealed hands or a
      // populated community — `lastOnChainRef.current` is intentionally one
      // tick stale (it's the PREVIOUS update) and opponents often lack
      // holeCards there, which starves the summary block later.
      if (!showdownSnapshot) {
        const gsHasReveals = gameState.revealedHands?.some((c: number) => c !== 255) ?? false;
        const gsHasBoard = (gameState.communityCards || []).some((c: number) => c !== 255);
        const snapSource = (gsHasReveals || gsHasBoard) ? gameState : (lastOnChainRef.current || gameState);
        const snapshotCommunity = lastValidCommunityRef.current.length > 0
          ? [...lastValidCommunityRef.current]
          : [...(snapSource.communityCards || [])];

        const playersCopy = JSON.parse(JSON.stringify(snapSource.players || []));
        // Seed holeCards from revealedHands immediately so the snapshot is
        // usable by the summary block on the same tick.
        const rh0 = gameState.revealedHands;
        for (const p of playersCopy) {
          const liveP = gameState.players.find((lp: any) => lp.pubkey === p.pubkey);
          if (liveP) {
            p.folded = liveP.folded;
            p.isActive = liveP.isActive;
            if (liveP.chips > p.chips) p.chips = liveP.chips;
          }
          if (rh0 && p.seatIndex != null && p.seatIndex >= 0 && (!p.holeCards || p.holeCards[0] === 255)) {
            const c1 = rh0[p.seatIndex * 2];
            const c2 = rh0[p.seatIndex * 2 + 1];
            if (c1 !== undefined && c2 !== undefined && c1 !== 255 && c2 !== 255) {
              p.holeCards = [c1, c2];
            }
          }
        }

        const myRevealSeat = gameState.mySeatIndex;
        let snapshotMyCards = snapSource.myCards ? [...snapSource.myCards] as [number, number] : undefined;
        if (!snapshotMyCards && rh0 && myRevealSeat != null && myRevealSeat >= 0) {
          const c1 = rh0[myRevealSeat * 2];
          const c2 = rh0[myRevealSeat * 2 + 1];
          if (c1 !== undefined && c2 !== undefined && c1 !== 255 && c2 !== 255) {
            snapshotMyCards = [c1, c2];
          }
        }

        setShowdownSnapshot({
          handNumber: gameState.handNumber,
          communityCards: snapshotCommunity,
          players: playersCopy,
          myCards: snapshotMyCards,
        });
      }
      // Update snapshot with revealed hands when they arrive (functional
      // form to avoid stale-closure clobber when multiple sets fire in one tick).
      if (gameState.revealedHands) {
        const rh = gameState.revealedHands;
        setShowdownSnapshot(prev => {
          if (!prev) return prev;
          let updated = false;
          const updatedPlayers = prev.players.map((p: any) => {
            if (p.seatIndex === gameState.mySeatIndex) return p;
            const c1 = rh[p.seatIndex * 2];
            const c2 = rh[p.seatIndex * 2 + 1];
            if (c1 !== undefined && c2 !== undefined && c1 !== 255 && c2 !== 255 && (!p.holeCards || p.holeCards[0] === 255)) {
              updated = true;
              return { ...p, holeCards: [c1, c2] };
            }
            return p;
          });
          let nextMyCards = prev.myCards;
          const myRevealSeat = gameState.mySeatIndex;
          if ((!nextMyCards || nextMyCards[0] === 255) && myRevealSeat != null && myRevealSeat >= 0) {
            const c1 = rh[myRevealSeat * 2];
            const c2 = rh[myRevealSeat * 2 + 1];
            if (c1 !== undefined && c2 !== undefined && c1 !== 255 && c2 !== 255) {
              nextMyCards = [c1, c2];
              updated = true;
            }
          }
          return updated ? { ...prev, players: updatedPlayers, myCards: nextMyCards } : prev;
        });
      }

      const tsStart = new Date().toISOString().slice(11, 23);
      const startedAt = performance.now();
      fpDebug(`showdownHold.start hand=${gameState.handNumber} phase=${currPhase} reason=${phaseEntering ? 'phaseEntering' : 'revealEntering'} hasRevealed=${hasRevealedNow}`);
      setShowdownHold(true);
      // The live UI is showing this hand's result — suppress the recap safeguard.
      resultShownForHandRef.current = gameState.handNumber;

      // Only start the 5s timer AFTER revealed hands are available (cards flipped)
      const hasRevealedCards = gameState.revealedHands?.some((c: number) => c !== 255);
      const releaseShowdown = () => {
        const elapsed = Math.round(performance.now() - startedAt);
        const tsEnd = new Date().toISOString().slice(11, 23);
        fpDebug(`showdownHold.release elapsed=${elapsed}ms hadRevealedCards=${hasRevealedCards}`);
        setShowdownHold(false);
        setShowdownPot(undefined); setShowdownPayouts({});
        setShowdownSnapshot(null);
        lastValidCommunityRef.current = [];
        showdownStartRef.current = 0;
        if (showdownTimerRef.current) {
          clearTimeout(showdownTimerRef.current);
          showdownTimerRef.current = null;
        }
      };

      if (hasRevealedCards && showdownStartRef.current === 0) {
        // Cards are visible - hold long enough for PokerTable's showdown
        // stage progression to complete: on an all-in run-out the board reveals
        // flop/turn/river through ~3900ms and stage 5 (winner-pulse) fires at
        // ~4600ms after showdownCardsReady, then ~1s for chip-flight to land.
        // 6500ms gives margin so the full sweat + winner animation play through.
        fpDebug('showdownHold.timer 6.5s (revealed cards path)');
        showdownStartRef.current = Date.now();
        if (showdownTimerRef.current) clearTimeout(showdownTimerRef.current);
        showdownTimerRef.current = setTimeout(releaseShowdown, 6500);
      } else if (!hasRevealedCards && !showdownTimerRef.current) {
        // Cards not revealed yet. Distinguish two cases:
        //   nonFolded === 1: real fold-win — no reveal is coming, 10s is fine.
        //   nonFolded >= 2: actual showdown with slow TEE reveal — using 10s
        // here caused the late-reveal-on-next-hand glitch: hold released
        // before reveal arrived, then re-triggered showdownHold.start after
        // phase moved to Waiting, so the flip animation overlapped the next
        // hand starting. 20s covers typical TEE reveal latency with margin.
        const liveNonFolded = gameState.players?.filter((p: any) => !p.folded).length ?? 0;
        const fallbackMs = liveNonFolded >= 2 ? 20000 : 10000;
        const reason = liveNonFolded >= 2 ? 'await-reveal' : 'fold-win';
        fpDebug(`showdownHold.timer ${fallbackMs / 1000}s (no revealed cards - ${reason} path, nonFolded=${liveNonFolded})`);
        showdownTimerRef.current = setTimeout(releaseShowdown, fallbackMs);
      }

      // Point to verify without probing the API; just-finished hands may not
      // be indexed yet and browser 404 noise makes real join errors harder to see.
      if (gameState.handNumber > 0 && tablePubkey) {
        const handNum = prev.handNumber || gameState.handNumber;
        setLastVerifyUrl(`/verify?table=${tablePubkey}&hand=${handNum}`);
      }
    }

    // Re-capture snapshot if showdown hold is active and we get new data with
    // revealed cards. Must run regardless of currPhase — settle flips phase to
    // Waiting in the same TX that writes revealed_hands, so late reveals arrive
    // when currPhase is already Waiting. Gate only on showdownHold.
    if (showdownHold) {
      const rh = gameState.revealedHands;
      setShowdownSnapshot(prev => {
        if (!prev) return prev;
        let changed = false;
        const nextPlayers = prev.players.map((sp: any) => {
          if (sp.holeCards && sp.holeCards[0] !== 255) return sp;
          const liveP = gameState.players.find((lp: any) => lp.pubkey === sp.pubkey);
          if (liveP?.holeCards && liveP.holeCards[0] !== 255) {
            changed = true;
            return { ...sp, holeCards: [...liveP.holeCards] };
          }
          const seatIdx = sp.seatIndex;
          if (rh && seatIdx != null && seatIdx >= 0) {
            const c1 = rh[seatIdx * 2];
            const c2 = rh[seatIdx * 2 + 1];
            if (c1 !== undefined && c2 !== undefined && c1 !== 255 && c2 !== 255) {
              changed = true;
              return { ...sp, holeCards: [c1, c2] };
            }
          }
          return sp;
        });
        let nextMyCards = prev.myCards;
        if ((!nextMyCards || nextMyCards[0] === 255) && gameState.myCards) {
          nextMyCards = [...gameState.myCards] as [number, number];
          changed = true;
        } else if ((!nextMyCards || nextMyCards[0] === 255) && rh && gameState.mySeatIndex >= 0) {
          const c1 = rh[gameState.mySeatIndex * 2];
          const c2 = rh[gameState.mySeatIndex * 2 + 1];
          if (c1 !== undefined && c2 !== undefined && c1 !== 255 && c2 !== 255) {
            nextMyCards = [c1, c2];
            changed = true;
          }
        }
        return changed ? { ...prev, players: nextPlayers, myCards: nextMyCards } : prev;
      });

      // Re-anchor the 6.5s timer to the moment cards first become visible.
      // If the hold was opened before cards were revealed (fallback path),
      // showdownStartRef is still 0 — stamp it now and schedule a fresh timer
      // so the player gets the full winner-animation window (stage 5 at +5.2s
      // plus ~1s for chip-flight).
      if (hasRevealedNow && showdownStartRef.current === 0) {
        showdownStartRef.current = Date.now();
        if (showdownTimerRef.current) clearTimeout(showdownTimerRef.current);
        showdownTimerRef.current = setTimeout(() => {
          setShowdownHold(false);
          setShowdownPot(undefined); setShowdownPayouts({});
          setShowdownSnapshot(null);
          lastValidCommunityRef.current = [];
          showdownStartRef.current = 0;
          showdownTimerRef.current = null;
        }, 6500);
      }
    }

    // Idempotent showdown summary logging — runs on EVERY update for the
    // duration of showdownHold OR while phase is Showdown/Complete.
    // Critical: settle.rs writes revealed_hands in the same TX that flips
    // phase→Waiting, so gating on phase alone drops late reveals. We keep
    // running during the 5s hold so any player who hasn't logged yet gets
    // their cards in the action log as soon as revealed_hands lands.
    // Only honor `showdownHold` while the snapshot is still pinned to the
    // current hand. When handNumber bumps mid-hold (winner-pulse defers the
    // release ~6.5s after the next hand starts) the snapshot/community refs
    // still hold the PRIOR hand's data — without this gate they get appended
    // to the new hand's freshly-reset history ("old hand mashed into new").
    const snapHand = showdownSnapshot?.handNumber;
    const holdForThisHand = showdownHold && snapHand != null && snapHand === gameState.handNumber;
    if ((currPhase === 'Showdown' || currPhase === 'Complete' || holdForThisHand)
        && summaryHandRef.current === gameState.handNumber) {
      const SUITS = ['s', 'h', 'd', 'c'];
      const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
      const cardStr = (c: number) => c >= 0 && c <= 51 ? `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}` : '?';

      // Board (once per hand)
      if (!summaryBoardLoggedRef.current) {
        const board = (lastValidCommunityRef.current.length > 0
          ? lastValidCommunityRef.current
          : (gameState.communityCards || [])
        ).filter((c: number) => c !== 255 && c >= 0 && c <= 51);
        if (board.length >= 3) {
          setHandHistory(h => [...h, { player: '', action: `Board: ${board.map(cardStr).join(' ')}`, phase: 'Summary' }]);
          summaryBoardLoggedRef.current = true;
        }
      }

      // isFoldWin detection: prefer snapshot (pre-settle state) since live
      // gameState.players get cleared to isActive=false/folded=false after
      // settle and would misread as a fold-win with zero survivors.
      const foldWinSource: any[] = (showdownSnapshot?.players && showdownSnapshot.players.length > 0)
        ? showdownSnapshot.players
        : gameState.players;
      const isFoldWin = foldWinSource.filter((p: any) => !p.folded && p.isActive).length <= 1;

      // Per-player cards/folded (once per player per hand).
      // Iterate snapshot when available — live gameState.players may have
      // been cleared post-settle (isActive=false && folded=false), which
      // would otherwise skip reveals for all showdown participants.
      const playersToLogBase: any[] = (showdownSnapshot?.players && showdownSnapshot.players.length > 0)
        ? showdownSnapshot.players
        : gameState.players;
      const playersToLog: any[] = [...playersToLogBase];
      if (gameState.revealedHands) {
        const seenSeats = new Set(playersToLog.map((p: any) => p.seatIndex).filter((s: any) => s != null && s >= 0));
        const maxSeats = gameState.maxPlayers || Math.floor(gameState.revealedHands.length / 2);
        for (let seatIdx = 0; seatIdx < maxSeats; seatIdx++) {
          if (seenSeats.has(seatIdx)) continue;
          const c1 = gameState.revealedHands[seatIdx * 2];
          const c2 = gameState.revealedHands[seatIdx * 2 + 1];
          if (c1 !== undefined && c2 !== undefined && c1 !== 255 && c2 !== 255) {
            playersToLog.push({ pubkey: `seat-${seatIdx}`, seatIndex: seatIdx, folded: false, isActive: true });
          }
        }
      }
      for (const p of playersToLog) {
        const logKey = p.pubkey || `seat-${p.seatIndex}`;
        if (summaryPlayerLoggedRef.current.has(logKey)) continue;
        const isMe = p.pubkey === publicKey?.toBase58();
        const label = p.pubkey?.startsWith?.('seat-') ? `Seat ${p.seatIndex + 1}` : handLogName(p.pubkey);
        let cards: number[] | [number, number] | undefined;
        if (gameState.revealedHands && p.seatIndex != null && p.seatIndex >= 0) {
          const rc1 = gameState.revealedHands[p.seatIndex * 2];
          const rc2 = gameState.revealedHands[p.seatIndex * 2 + 1];
          if (rc1 !== undefined && rc2 !== undefined && rc1 !== 255 && rc2 !== 255) cards = [rc1, rc2];
        }
        if ((!cards || cards[0] === 255) && isMe) {
          cards = showdownSnapshot?.myCards || gameState.myCards;
        }
        if ((!cards || cards[0] === 255) && !isMe) {
          const snapPlayer = showdownSnapshot?.players?.find((sp: any) => sp.seatIndex === p.seatIndex);
          cards = snapPlayer?.holeCards || p.holeCards;
        }
        // Skip pure ghost seats (never had an active role this hand)
        const livePeer = gameState.players.find((lp: any) => lp.pubkey === p.pubkey);
        const snapPeer = showdownSnapshot?.players?.find((sp: any) => sp.pubkey === p.pubkey);
        const wasInvolved = p.folded || (cards && cards[0] !== 255 && cards[1] !== 255)
          || (livePeer && (livePeer.isActive || livePeer.folded))
          || (snapPeer && (snapPeer.isActive || snapPeer.folded));
        if (!wasInvolved) continue;

        if (cards && cards[0] !== 255 && cards[1] !== 255) {
          setHandHistory(h => [...h, { player: label, action: `${cardStr(cards[0])} ${cardStr(cards[1])}`, phase: 'Summary' }]);
          summaryPlayerLoggedRef.current.add(logKey);
        } else if (p.folded) {
          setHandHistory(h => [...h, { player: label, action: 'folded', phase: 'Summary' }]);
          summaryPlayerLoggedRef.current.add(logKey);
        }
        // Else: cards not yet revealed — keep slot open, try again next update.
        // Previously this branch pre-marked fold-win survivors as logged,
        // but that locked out any player whose cards arrived later in a
        // multi-player showdown (settle.rs writes revealed_hands at the
        // same time as phase→Waiting, so the reveal can race the hold).
      }

      // Winners (once per winner per hand, detected via chip delta).
      // Walk live gameState regardless of isActive — settle.rs flips every
      // seat to isActive=false when the hand ends, so the old guard dropped
      // every winner once that TX landed.
      const prevGs = lastOnChainRef.current;
      if (prevGs) {
        for (const curr of gameState.players) {
          if (summaryWinnerLoggedRef.current.has(curr.pubkey)) continue;
          const prevP = prevGs.players.find((p: { pubkey: string }) => p.pubkey === curr.pubkey);
          if (!prevP) continue;
          // Use NET (gain minus what they put in this hand), not the raw chip
          // delta. A covering all-in player who LOSES still gets their uncalled
          // bet returned, so their chip delta is positive (e.g. shove 3000 vs a
          // 50 stack and lose → +2950 returned). That was being logged as a win.
          // Net is negative for that player, so only true winners are logged,
          // and the amount shown is their actual winnings.
          const chipDelta = curr.chips - prevP.chips;
          const contributed = (prevP as { totalBetThisHand?: number }).totalBetThisHand || 0;
          const net = chipDelta - contributed;
          if (net > 0) {
            const winType = isFoldWin ? 'WON (fold)' : 'WON';
            setHandHistory(h => [...h, { player: handLogName(curr.pubkey), action: `${winType} +${fmtVal(net)}`, phase: 'Result' }]);
            summaryWinnerLoggedRef.current.add(curr.pubkey);
          }
        }
      }

      // Fold-win winner: everyone folded to one player. The net-chip-delta loop
      // above can MISS them — a shover who wins only the blinds has the uncalled
      // portion of their bet returned, so (chipDelta − totalBetThisHand) goes
      // negative and they're skipped (the "didn't say who won" report). For a
      // fold-win the winner is unambiguous (the lone survivor), so log them
      // directly with the pot they collected = sum of everyone else's bets.
      if (isFoldWin && summaryWinnerLoggedRef.current.size === 0) {
        const survivor = foldWinSource.find((p: any) => !p.folded && p.isActive);
        if (survivor?.pubkey && !summaryWinnerLoggedRef.current.has(survivor.pubkey)) {
          const potWon = foldWinSource.reduce(
            (sum: number, p: any) => (p.pubkey === survivor.pubkey
              ? sum
              : sum + ((p as { totalBetThisHand?: number }).totalBetThisHand || 0)),
            0,
          );
          if (potWon > 0) {
            setHandHistory(h => [...h, { player: handLogName(survivor.pubkey), action: `WON (fold) +${fmtVal(potWon)}`, phase: 'Result' }]);
            summaryWinnerLoggedRef.current.add(survivor.pubkey);
          }
        }
      }
    }

    // Early release: if the new hand has started (PreFlop or Starting)
    // release the hold — but enforce a MINIMUM display time so players can
    // actually see the showdown results before the next hand begins.
    const MIN_SHOWDOWN_DISPLAY_MS = 7000; // enough time for hole cards, flop, turn, river, then winner
    // Release hold only when a non-showdown phase arrives AND min time has elapsed.
    // Starting/PreFlop are kept in exclusion so the hold doesn't release during rapid phase transitions.
    const HOLD_PHASES = new Set(['Showdown', 'Complete']);
    if (showdownHold && currPhase && !HOLD_PHASES.has(currPhase) && showdownStartRef.current > 0) {
      const elapsed = Date.now() - showdownStartRef.current;
      const releaseHold = () => {
        setShowdownHold(false);
        setShowdownPot(undefined); setShowdownPayouts({});
        setShowdownSnapshot(null);
        lastValidCommunityRef.current = [];
        showdownStartRef.current = 0;
        if (showdownTimerRef.current) {
          clearTimeout(showdownTimerRef.current);
          showdownTimerRef.current = null;
        }
      };

      if (elapsed >= MIN_SHOWDOWN_DISPLAY_MS) {
        // Already displayed long enough — release immediately
        releaseHold();
      } else {
        // Not enough time yet — schedule release after remaining time
        const remaining = MIN_SHOWDOWN_DISPLAY_MS - elapsed;
        if (showdownTimerRef.current) clearTimeout(showdownTimerRef.current);
        showdownTimerRef.current = setTimeout(() => {
          releaseHold();
          showdownTimerRef.current = null;
        }, remaining);
      }
    }

    lastOnChainRef.current = gameState;
  }, [gameState, showdownHold]);

  const isSol = tokenMint === PublicKey.default.toBase58();
  const isUsdcTable = (() => {
    try {
      return isUsdcMint(new PublicKey(tokenMint));
    } catch {
      return false;
    }
  })();
  // Read real token decimals from the mint (SPL Mint / Token-2022 base: u8 at
  // byte offset 44) so blinds/pot/stacks render correctly for ANY token, not
  // just the known SOL/$FP/USDC set. Falls back to the known guess until resolved.
  useEffect(() => {
    if (isSol) { setResolvedDecimals(9); return; }
    let cancelled = false;
    (async () => {
      try {
        const conn = makeL1Connection();
        const info = await conn.getAccountInfo(new PublicKey(tokenMint));
        if (!cancelled && info && info.data.length > 44) setResolvedDecimals(info.data[44]);
      } catch { /* keep fallback */ }
    })();
    return () => { cancelled = true; };
  }, [tokenMint, isSol]);
  const tokenDecimals = resolvedDecimals ?? (isUsdcTable ? 6 : 9);
  const tokenBase = 10 ** tokenDecimals;
  const fmtTokenAmount = (raw: number | bigint, maxDecimals = 6) => {
    const amount = Number(raw) / tokenBase;
    const fixed = amount >= 1
      ? amount.toFixed(Math.min(4, maxDecimals))
      : amount >= 0.01
        ? amount.toFixed(Math.min(4, maxDecimals))
        : amount >= 0.0001
          ? amount.toFixed(Math.min(6, maxDecimals))
          : amount.toFixed(maxDecimals);
    return fixed.replace(/\.?0+$/, '') || '0';
  };
  const getTokenSymbol = (mint: string) => {
    if (mint === PublicKey.default.toBase58()) return 'SOL';
    if (mint === POKER_MINT.toBase58()) return '$FP';
    try {
      if (isUsdcMint(new PublicKey(mint))) return 'USDC';
    } catch {}
    return mint.slice(0, 4) + '...';
  };
  const tokenLogoSrc = isSol
    ? '/tokens/sol.svg'
    : tokenMint === POKER_MINT.toBase58()
      ? '/brand/app-icon.png'
      : isUsdcTable
        ? '/tokens/usdc.svg'
        : '';

  // ─── Auto-start cash game when 2+ players in Waiting ───
  const startingRef = useRef(false);
  const lastStartRef = useRef(0);
  const startFailsRef = useRef(0);
  const lastCompleteRef = useRef(Date.now()); // Default to now to prevent instant start on mount

  const triggerCashReady = useCallback(async (reason: string) => {
    if (!tablePubkey) return;
    if (startingRef.current) return;
    startingRef.current = true;
    lastStartRef.current = Date.now();
    try {
      console.log(`[CashGame] Ready trigger (${reason})`);
      const res = await fetch('/api/cash-game/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tablePda: tablePubkey }),
      });
      const data = await res.json();
      if (data.success) {
        startFailsRef.current = 0;
        await refreshState();
      } else {
        console.log('[CashGame] Ready response:', data.error || data);
        // 409 "report finalized must be flushed" is cooperative, not a true
        // failure — the crank flushes the buffer then drives start_game/
        // tee_deal itself. Don't increment the failure counter (would burn
        // the 3-strike cap and stop auto-start), and shorten the cooldown
        // so we can re-poll quickly once the flush lands.
        const errMsg = String(data.error || '');
        const isFlushRace = res.status === 409 && /must be flushed/i.test(errMsg);
        if (isFlushRace) {
          lastStartRef.current = Date.now() - 3500; // ~1.5s effective cooldown
        } else {
          startFailsRef.current++;
        }
      }
    } catch (err) {
      console.error('[CashGame] Ready trigger failed:', err);
      startFailsRef.current++;
    } finally {
      startingRef.current = false;
    }
  }, [tablePubkey, refreshState]);

  useEffect(() => {
    if (gameState?.phase === 'Complete' || gameState?.phase === 'Showdown') {
      lastCompleteRef.current = Date.now();
    }
  }, [gameState?.phase]);

  useEffect(() => {
    if (!tablePubkey) return;
    startFailsRef.current = 0; // Reset on phase/player change

    const tryStart = () => {
      if (!gameState) return;
      // Cash-only: SNG start is pool/crank-driven, not /api/cash-game/ready.
      // Without this guard SNG tables sitting in 'Waiting' spam that route and 500.
      if (gameState.isCashGame === false) return;
      const phase = gameState.phase;
      const eligiblePlayers = gameState.players?.filter(p => !p.isSittingOut || p.waitingForBb)?.length || 0;
      if (phase !== 'Waiting' || eligiblePlayers < 2) return;
      if (startingRef.current) return;
      if (sittingOutPendingRef.current) return;
      if (gameState.isMaintenance) return; // Prevent auto-start during L1 undelegation
      if (startFailsRef.current >= 3) return; // Stop after 3 consecutive failures
      // Cooldown: wait at least 5s between start attempts to avoid duplicate requests with crank
      if (Date.now() - lastStartRef.current < 5000) return;
      // Post-hand wrap-up delay to show the results! (Essential for all-ins)
      if (Date.now() - lastCompleteRef.current < 5500) return;

      // If we observe Waiting but haven't given the frontend time, artificially delay here
      if (eligiblePlayers >= 2 && gameState?.handNumber > 0 && Date.now() - lastCompleteRef.current > 10000) {
          // If 10 seconds have passed since we last saw Complete/Showdown, it's safe to assume we can start.
      } else if (Date.now() - lastCompleteRef.current < 5500) {
          return; // Still in the cooldown phase
      }

      triggerCashReady(`auto-start:${eligiblePlayers}`);
    };

    tryStart();
    const interval = setInterval(tryStart, 4000);
    return () => clearInterval(interval);
  }, [gameState?.phase, gameState?.players?.length, gameState?.players?.filter(p => !p.isSittingOut || p.waitingForBb)?.length, gameState?.handNumber, tablePubkey, triggerCashReady]);

  // ─── Actions (gasless via session key, same as SNG) ───

  const handleGameAction = useCallback(async (action: string, amount?: number) => {
    const recordOwnAction = () => {
      const isCash = gameState?.isCashGame !== false;
      const fmtAmt = (v: number) => isCash ? fmtTokenAmount(v, 9) : v.toLocaleString();
      const actionLabel = amount ? `${action.toUpperCase()} ${fmtAmt(amount)}` : action.toUpperCase();
      setHandHistory(prev => [...prev, { player: 'You', action: actionLabel, amount, phase: gameState?.phase || 'Unknown' }]);
      setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== (gameState?.mySeatIndex ?? -1)), { seatIndex: gameState?.mySeatIndex ?? -1, action: actionLabel, timestamp: Date.now() }]);
    };
    const revertOwnAction = () => {
      setHandHistory(prev => prev.slice(0, -1));
      setPlayerActions(prev => prev.filter(a => a.seatIndex !== (gameState?.mySeatIndex ?? -1)));
      setOptimisticHeroBet(null);
    };
    const sendAndRecord = async () => {
      // Record BEFORE the send: sendAction's confirm loop takes 1s+ steps, and
      // recording after it seeded the label late — sometimes onto the NEXT
      // street (the stale "CALL on the flop" report). Your own action is the
      // one event that needs no network round trip to display; revert if the
      // TX actually fails.
      recordOwnAction();
      if ((action === 'bet' || action === 'raise') && amount) {
        setOptimisticHeroBet({ hand: gameState?.handNumber ?? -1, amount, at: Date.now() });
      } else if (action === 'call' && gameState) {
        setOptimisticHeroBet({ hand: gameState.handNumber, amount: gameState.currentBet, at: Date.now() });
      } else if (action === 'allin' && gameState) {
        const me = gameState.players.find(p => p.seatIndex === gameState.mySeatIndex);
        if (me) setOptimisticHeroBet({ hand: gameState.handNumber, amount: (me.bet || 0) + (me.chips || 0), at: Date.now() });
      }
      try {
        await sendAction(action as any, amount);
      } catch (e) {
        revertOwnAction();
        throw e;
      }
    };

    setActionPending(true);
    setStatus(null);
    try {
      await sendAndRecord();
    } catch (e: any) {
      const msg = e?.message || '';
      if (msg.includes('Claim this seat session')) {
        setStatus(isPlayerReady ? 'Claiming seat session...' : 'Authenticating TEE session...');
        try {
          if (!isPlayerReady) {
            setClaimDebug('claim-action: authenticating TEE');
            await authenticatePlayer();
          }
          if (!(await confirmSeatSessionUpdate())) {
            setStatus('Seat session claim cancelled.');
            setClaimDebug('claim-action: cancelled before wallet');
            return;
          }
          setClaimDebug('claim-action: claiming seat session');
          await claimSeatSession(setClaimDebug);
          setStatus('Session claimed. Sending action...');
          await sendAndRecord();
          setStatus(null);
        } catch (claimErr: any) {
          setClaimDebug(`claim-action: caught ${claimErr?.message?.slice(0, 120) || 'error'}`);
          setStatus(getErrorMessage(claimErr));
        }
        return;
      }

      // Session key mismatch — reload from IndexedDB and retry once
      if (msg.includes('Session expired') || msg.includes('Reconnecting session') || msg.includes('InvalidSessionKey')) {
        setStatus('Session key mismatch. Retrying...');
        try {
          reloadSession();
          await sendAndRecord();
          setStatus(null);
        } catch {
          setStatus('Action failed. Try generating a new session key.');
        }
      } else {
        setStatus(getErrorMessage(e));
      }
    } finally {
      setActionPending(false);
    }
  }, [sendAction, reloadSession, gameState, isPlayerReady, authenticatePlayer, confirmSeatSessionUpdate, claimSeatSession]);

  // ─── Join table with buy-in modal ───

  // Buy-in ranges per type: 0=Normal(20-100BB), 1=Deep(50-250BB)
  const buyInMin = buyInType === 1 ? 50 : 20;
  const buyInMax = buyInType === 1 ? 250 : 100;
  const buyInQuickPicks = buyInType === 1 ? [50, 100, 175, 250] : [20, 50, 75, 100];

  // Keep the buy-in slider within what the wallet can actually afford on SOL
  // tables. The 50 BB default can exceed the affordable max once the balance
  // loads, which pushed the custom slider thumb off-track and let confirm try
  // to spend the whole balance with nothing left for rent/fees. Clamp the value
  // down (never below min — cantAfford handles the "can't even buy in" case).
  useEffect(() => {
    if (!buyInModal || buyInModal.mode === 'topup') return;
    if (!gameState || tokenMint !== PublicKey.default.toBase58()) return;
    if (walletBalances.loading) return;
    const bb = gameState.blinds.big || 1;
    const ratholeRequiredBB = ratholeLock
      ? Math.max(buyInMin, Math.ceil((Math.max(ratholeLock.chipsAtLeave, bb * buyInMin) + ratholeLock.kickPenalty) / bb))
      : buyInMin;
    const allowedMaxBB = Math.max(buyInMax, ratholeRequiredBB);
    const affordable = Math.floor(Math.max(0, walletBalances.solBalance * 1e9 - FUNDS_HINTS.SIT_OVERHEAD_LAMPORTS) / bb);
    const maxBB = Math.min(allowedMaxBB, affordable);
    if (buyInBBs < ratholeRequiredBB) setBuyInBBs(ratholeRequiredBB);
    else if (maxBB >= ratholeRequiredBB && buyInBBs > maxBB) setBuyInBBs(maxBB);
  }, [buyInModal, gameState, tokenMint, walletBalances.solBalance, walletBalances.loading, buyInBBs, buyInMin, buyInMax, ratholeLock]);

  const readOwnReservedJoinSeat = useCallback(async (conn?: Connection): Promise<number | null> => {
    if (!publicKey || !tablePubkey || !gameState || gameState.isCashGame === false || gameState.mySeatIndex >= 0) {
      return null;
    }
    try {
      const l1 = conn || makeL1Connection();
      const tablePda = new PublicKey(tablePubkey);
      const [markerPda] = getPlayerTableMarkerPda(publicKey, tablePda);
      const markerInfo = await l1.getAccountInfo(markerPda);
      if (!markerInfo || markerInfo.data.length < 73) return null;

      const markerPlayer = new PublicKey(markerInfo.data.subarray(8, 40));
      const markerTable = new PublicKey(markerInfo.data.subarray(40, 72));
      const seatIndex = markerInfo.data[72];
      const max = gameState.maxPlayers || 9;
      if (!markerPlayer.equals(publicKey) || !markerTable.equals(tablePda) || seatIndex >= max) {
        return null;
      }

      // A normal cash-game leave intentionally keeps PlayerTableMarker around
      // as the anti-rathole chip lock. That is not an unfinished join and
      // should not render as "Take Seat" on the old seat.
      if (markerInfo.data.length >= 90) {
        const chipsAtLeave = Number(markerInfo.data.readBigUInt64LE(74));
        const leaveTime = Number(markerInfo.data.readBigInt64LE(82));
        if (leaveTime > 0 || chipsAtLeave > 0) {
          return null;
        }
      }
      if (markerInfo.data.length >= 99) {
        const kickTime = Number(markerInfo.data.readBigInt64LE(90));
        const kickReason = markerInfo.data[98];
        if (kickTime > 0 || kickReason > 0) {
          return null;
        }
      }

      const liveSeat = gameState.players.find(p => p.seatIndex === seatIndex);
      if (liveSeat?.pubkey === publicKey.toBase58()) return null;
      return seatIndex;
    } catch (e: any) {
      console.warn('[join-resume] Failed to read PlayerTableMarker:', e.message?.slice(0, 100));
      return null;
    }
  }, [publicKey, tablePubkey, gameState?.isCashGame, gameState?.mySeatIndex, gameState?.maxPlayers, gameState?.players]);

  const readOwnPendingJoinSeat = useCallback(async (conn?: Connection): Promise<number | null> => {
    if (!publicKey || !tablePubkey || !gameState || gameState.isCashGame === false) return null;
    const l1 = conn || makeL1Connection();
    const tablePda = new PublicKey(tablePubkey);
    const max = gameState.maxPlayers || 9;

    // Helper: validate that the proof at `seatIndex` represents an unfinished
    // join by THIS wallet. Handles three states:
    //   • L1-owned proof  → read depositor + consumed flag directly
    //   • Delegation-owned → data lives on TEE; we can't read depositor from
    //     L1, so trust the marker's seat_index pointer (caller's job).
    //   • Missing → not ours.
    const checkSeatOwned = async (seatIndex: number, trustOnDeleg: boolean): Promise<number | null> => {
      try {
        const [proofPda] = getDepositProofPda(tablePda, seatIndex);
        const proofInfo = await l1.getAccountInfo(proofPda);
        if (!proofInfo) return null;
        if (proofInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
          if (trustOnDeleg) setPendingDepositAt(null); // timestamp unreadable while delegated
          return trustOnDeleg ? seatIndex : null;
        }
        if (proofInfo.data.length < 90) return null;
        const proofDepositor = new PublicKey(proofInfo.data.subarray(41, 73));
        const proofBuyIn = proofInfo.data.readBigUInt64LE(73);
        const proofConsumed = proofInfo.data[89] === 1;
        if (!proofDepositor.equals(publicKey) || proofBuyIn === BigInt(0) || proofConsumed) {
          return null;
        }
        // deposit_timestamp (i64 LE @90) feeds the refund-timelock countdown.
        if (proofInfo.data.length >= 98) {
          try { setPendingDepositAt(Number(proofInfo.data.readBigInt64LE(90))); } catch { setPendingDepositAt(null); }
        }
        return seatIndex;
      } catch {
        return null;
      }
    };

    // Fast path: marker (without rathole shadow) points to a reserved seat.
    const markerSeat = await readOwnReservedJoinSeat(conn);
    if (markerSeat !== null) {
      const direct = await checkSeatOwned(markerSeat, true);
      if (direct !== null) return direct;
    }

    // Backup: read the marker raw to get seat_index even when leave-data is
    // present (rathole shadow). Then trust delegation-owned proofs at that seat
    // as the user's, since on-chain proofs PDA-derive from (table, seatIndex)
    // and only the user could have created one against their own marker seat.
    try {
      const [markerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('player_table'), publicKey.toBuffer(), tablePda.toBuffer()],
        ANCHOR_PROGRAM_ID,
      );
      const markerInfo = await l1.getAccountInfo(markerPda);
      if (markerInfo && markerInfo.data.length >= 73) {
        const markerPlayer = new PublicKey(markerInfo.data.subarray(8, 40));
        const markerTable = new PublicKey(markerInfo.data.subarray(40, 72));
        const seatIndex = markerInfo.data[72];
        if (markerPlayer.equals(publicKey) && markerTable.equals(tablePda) && seatIndex < max) {
          const found = await checkSeatOwned(seatIndex, true);
          if (found !== null) return found;
        }
      }
    } catch (e: any) {
      console.warn('[join-resume] Raw marker read failed:', e?.message?.slice(0, 100));
    }

    // Slow path: scan all L1-owned proofs (delegation-owned proofs not at our
    // marker seat are not ours).
    try {
      const proofPdas = Array.from({ length: max }, (_, i) => getDepositProofPda(tablePda, i)[0]);
      const infos = await l1.getMultipleAccountsInfo(proofPdas);
      for (let seatIndex = 0; seatIndex < infos.length; seatIndex++) {
        const info = infos[seatIndex];
        if (!info) continue;
        if (info.owner.equals(DELEGATION_PROGRAM_ID)) continue;
        if (info.data.length < 90) continue;
        const depositor = new PublicKey(info.data.subarray(41, 73));
        const buyIn = info.data.readBigUInt64LE(73);
        const consumed = info.data[89] === 1;
        if (depositor.equals(publicKey) && buyIn > BigInt(0) && !consumed) {
          return seatIndex;
        }
      }
    } catch (e: any) {
      console.warn('[join-resume] DepositProof scan failed:', e?.message?.slice(0, 100));
    }
    return null;
  }, [publicKey, tablePubkey, gameState?.isCashGame, gameState?.maxPlayers, readOwnReservedJoinSeat]);

  const scanReservedJoinSeats = useCallback(async (conn?: Connection): Promise<number[]> => {
    if (!publicKey || !tablePubkey || !gameState || gameState.isCashGame === false) return [];
    try {
      const l1 = conn || makeL1Connection();
      const tablePda = new PublicKey(tablePubkey);
      const max = gameState.maxPlayers || 9;
      const proofPdas = Array.from({ length: max }, (_, i) => getDepositProofPda(tablePda, i)[0]);
      const receiptPdas = Array.from({ length: max }, (_, i) => getReceiptPda(tablePda, i)[0]);
      const seatPdas = Array.from({ length: max }, (_, i) => getSeatPda(tablePda, i)[0]);
      const [infos, receiptInfos, seatInfos] = await Promise.all([
        l1.getMultipleAccountsInfo(proofPdas),
        l1.getMultipleAccountsInfo(receiptPdas),
        l1.getMultipleAccountsInfo(seatPdas),
      ]);
      // "JOINING" only ever applies to a genuinely Empty seat. A seat that is
      // occupied (Active/Folded/AllIn/SittingOut/Leaving) must never be relabeled
      // from a lingering DepositProof — e.g. a Leaving seat whose deposit proof is
      // still delegated to ER. Read live seat status (the L1 delegated snapshot is
      // accurate) and exclude any non-Empty seat from the reservation set.
      const occupiedSeats = new Set<number>();
      seatInfos.forEach((info, seatIndex) => {
        if (!info) return;
        const seat = parseSeatState(Buffer.from(info.data));
        if (seat && seat.status !== SeatStatus.Empty && !seat.player.equals(PublicKey.default)) {
          occupiedSeats.add(seatIndex);
        }
      });
      const seats: number[] = [];
      const clearingSeats: number[] = [];
      receiptInfos.forEach((info, seatIndex) => {
        if (!info || occupiedSeats.has(seatIndex)) return;
        const data = Buffer.from(info.data);
        if (data.length < 82) return;
        const receiptDepositor = new PublicKey(data.subarray(50, 82));
        if (!receiptDepositor.equals(PublicKey.default) && !receiptDepositor.equals(publicKey)) {
          clearingSeats.push(seatIndex);
        }
      });
      // DepositProof layout (offsets):
      //   8  disc | 32 table | 1 seat | 32 depositor | 8 buy_in
      // → depositor at 41, buy_in at 73, consumed at 89, deposit_timestamp at 90 (i64 LE)
      const STALE_AFTER_SECS = 5 * 60; // 5min — anything older is abandoned
      // Genuine seat finalization (delegate → seat_from_proof) completes within
      // seconds, after which the seat shows a real player and JOINING is hidden.
      // For proofs whose freshness we can't read from L1, keep JOINING during a
      // short grace, then drop them so a stranded proof can't pin an empty seat
      // to JOINING forever.
      const UNVERIFIABLE_GRACE_MS = 45_000;
      const nowSecs = Math.floor(Date.now() / 1000);
      const nowMs = Date.now();
      const seen = unverifiableReservationFirstSeen.current;
      const unverifiableNow = new Set<number>();
      infos.forEach((info, seatIndex) => {
        if (!info) return;
        if (occupiedSeats.has(seatIndex)) return; // seat is taken, not joinable
        let unverifiable = false;
        if (info.owner.equals(DELEGATION_PROGRAM_ID)) {
          // Delegated to ER: the DepositProof data lives on the rollup, so we
          // can't read its timestamp/consumed flag from L1. Age it client-side.
          unverifiable = true;
        } else {
          const data = Buffer.from(info.data);
          if (data.length < 98) return;
          const depositor = new PublicKey(data.subarray(41, 73));
          const buyIn = data.readBigUInt64LE(73);
          const consumed = data[89] === 1;
          if (depositor.equals(PublicKey.default) || buyIn === BigInt(0) || consumed) return;
          const tsSecs = Number(data.readBigInt64LE(90));
          if (tsSecs > 0) {
            // Verifiable age: drop only when older than the abandon window.
            if (nowSecs - tsSecs > STALE_AFTER_SECS) return;
            seats.push(seatIndex);
            return;
          }
          // Missing/zero timestamp (legacy proof): can't verify freshness → age it.
          unverifiable = true;
        }
        // Unverifiable proof: keep showing JOINING only within the grace window.
        unverifiableNow.add(seatIndex);
        const firstSeen = seen.get(seatIndex);
        if (firstSeen === undefined) {
          seen.set(seatIndex, nowMs);
          seats.push(seatIndex);
          return;
        }
        if (nowMs - firstSeen > UNVERIFIABLE_GRACE_MS) return; // stranded — drop
        seats.push(seatIndex);
      });
      // Forget seats that no longer carry an unverifiable proof so a future
      // genuine join there gets a fresh grace window (and aged-out stranded
      // proofs stay forgotten only once their account actually clears).
      for (const k of [...seen.keys()]) if (!unverifiableNow.has(k)) seen.delete(k);
      setClearingJoinSeats(clearingSeats);
      return seats;
    } catch (e: any) {
      console.warn('[join-reserve] Failed to scan DepositProof reservations:', e.message?.slice(0, 100));
      setClearingJoinSeats([]);
      return [];
    }
  }, [publicKey, tablePubkey, gameState?.isCashGame, gameState?.maxPlayers]);

  const clearOwnStaleJoinMarker = useCallback(async (seatIndex: number): Promise<boolean> => {
    if (!publicKey || !tablePubkey) return false;
    const key = `${tablePubkey}:${seatIndex}`;
    if (staleMarkerClearInFlight.current.has(key)) return false;
    staleMarkerClearInFlight.current.add(key);
    try {
      const clearAuth = await buildWalletApiAuth(publicKey, signMessage, 'cash-clear-stale-marker');
      const res = await fetch('/api/cash-game/clear-stale-marker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tablePda: tablePubkey, seatIndex, ...clearAuth }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) {
        console.warn('[join-resume] Stale marker clear skipped:', result.error || res.statusText);
        return false;
      }
      if (result.cleared) {
        console.log('[join-resume] Cleared stale PlayerTableMarker:', result.signature?.slice(0, 20));
      }
      return !!result.cleared || result.reason === 'marker_already_clear';
    } catch (e: any) {
      console.warn('[join-resume] Stale marker clear failed:', e.message?.slice(0, 100));
      return false;
    } finally {
      staleMarkerClearInFlight.current.delete(key);
    }
  }, [publicKey, signMessage, tablePubkey]);

  const cancelPendingDeposit = useCallback(async (seatIndex: number): Promise<boolean> => {
    if (!publicKey || cancelPendingSeat !== null) return false;
    // Lock the button BEFORE the (headless on Privy) signMessage + refund.
    setCancelPendingSeat(seatIndex);
    try {
      setStatus('Canceling pending deposit & refunding...');
      const auth = await buildWalletApiAuth(publicKey, signMessage, 'cash-cleanup-proof');
      const res = await fetch('/api/cash-game/cleanup-proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tablePda: tablePubkey, seatIndex, ...auth }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) {
        throw new Error(result.error || `cleanup failed: ${res.status}`);
      }
      setPendingJoinSeat(null);
      setReservedJoinSeat(null);
      setSelectedJoinSeat(null);
      setReservedJoinSeats(prev => prev.filter(s => s !== seatIndex));
      const refundedNote = result.refunded ? ' Deposit refunded.' : ' (refund pending, retry in a moment if needed)';
      setStatus(`Seat ${seatIndex + 1} cleared.${refundedNote}`);
      setTimeout(() => setStatus(null), 4000);
      return true;
    } catch (e: any) {
      console.error('[cancel-deposit] failed:', e);
      setStatus(`Cancel failed: ${e?.message?.slice(0, 140) || 'unknown'}`);
      return false;
    } finally {
      setCancelPendingSeat(null);
    }
  }, [publicKey, signMessage, tablePubkey, cancelPendingSeat]);

  const ensureSeatCardsDelegated = useCallback(async (seatIndex: number, teeConnOverride?: Connection | null): Promise<void> => {
    if (!publicKey) throw new Error('Wallet not connected.');
    if (!signTransaction) throw new Error('Your wallet does not support transaction signing (required to prepare seat cards).');

    const conn = makeL1Connection();
    const teeConn = teeConnOverride || activeConnection;
    const tablePda = new PublicKey(tablePubkey);
    const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
    const delegationRecordPda = delegationRecordPdaFromDelegatedAccount(seatCardsPda);
    const [seatCardsInfo, delegationInfo] = await Promise.all([
      conn.getAccountInfo(seatCardsPda),
      conn.getAccountInfo(delegationRecordPda),
    ]);

    const waitForSeatCardsOnTee = async () => {
      if (teeConn) {
        for (let poll = 0; poll < 8; poll++) {
          await new Promise(r => setTimeout(r, 750));
          const info = await teeConn.getAccountInfo(seatCardsPda).catch(() => null);
          if (info) return;
        }
      }
      await new Promise(r => setTimeout(r, 2000));
    };

    if (!seatCardsInfo || seatCardsInfo.owner.equals(DELEGATION_PROGRAM_ID) || delegationInfo) {
      await waitForSeatCardsOnTee();
      return;
    }

    setStatus('Preparing private seat cards...');
    const delegationBufferPda = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seatCardsPda, ANCHOR_PROGRAM_ID);
    const delegationMetadataPda = delegationMetadataPdaFromDelegatedAccount(seatCardsPda);
    const tx = new Transaction().add(buildDelegateSeatCardsInstruction(
      publicKey,
      tablePda,
      seatIndex,
      delegationBufferPda,
      delegationRecordPda,
      delegationMetadataPda,
      DELEGATION_PROGRAM_ID,
    ));
    tx.feePayer = publicKey;
    tx.recentBlockhash = (await getLatestBlockhashClient(conn, 'confirmed')).blockhash;

    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) {
      const errJson = JSON.stringify(sim.value.err);
      const lastLogs = (sim.value.logs || []).slice(-8).join(' | ');
      throw new Error(`SeatCards delegation simulation failed: ${errJson}${lastLogs ? ` - ${lastLogs}` : ''}`);
    }

    const signed = await signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, 'confirmed');
    await waitForSeatCardsOnTee();
  }, [activeConnection, publicKey, signTransaction, tablePubkey]);

  // Client-side cash seat: production routed seat_player through a server keypair
  // (browser wallets can't reach the TEE), but the standalone has a player-
  // authenticated TEE connection (activeConnection) + local signing, so we sign
  // seat_player locally and submit raw to the TEE — the same mechanism every
  // in-game action already uses. seat_player is permissionless (buy-in comes from
  // the on-chain DepositProof, not the signer), so the player can seat themselves.
  const clientSeatPlayer = useCallback(async (seatIndex: number): Promise<string> => {
    if (!publicKey) throw new Error('Wallet not connected.');
    if (!signTransaction) throw new Error('Your wallet does not support transaction signing (required to seat at the table).');
    const teeConn = await ensurePlayerConnection();
    if (!teeConn) throw new Error('TEE connection unavailable.');
    const tablePda = new PublicKey(tablePubkey);
    const maxPlayers = gameState?.maxPlayers || 6;
    const includeWhitelist = !!gameState?.isPrivate;
    await ensureSeatCardsDelegated(seatIndex, teeConn);
    const ix = buildSeatPlayerInstruction(publicKey, tablePda, seatIndex, undefined, publicKey, maxPlayers, includeWhitelist);
    const tx = new Transaction().add(ix);
    tx.feePayer = publicKey;
    tx.recentBlockhash = (await teeConn.getLatestBlockhash('confirmed')).blockhash;
    const signed = await signTransaction(tx);
    const sig = await teeConn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    // Poll the TEE for the seat to land (state poll catches up regardless).
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const st = await teeConn.getSignatureStatuses([sig]).catch(() => null);
      const s = st?.value?.[0];
      if (s?.err) throw new Error(`Seating failed: ${JSON.stringify(s.err)}`);
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') break;
    }
    return sig;
  }, [publicKey, signTransaction, ensurePlayerConnection, tablePubkey, gameState, ensureSeatCardsDelegated]);

  const finishPendingSeat = useCallback(async (seatIndex: number): Promise<boolean> => {
    if (!publicKey || !gameState) return false;
    // Final auth gate before claiming the seat on-chain. openBuyInModal and
    // handleSngSeatClick already run ensurePlayerAuth(), but the "Resume
    // Pending Seat" button (page.tsx:2406) hands directly to this helper,
    // bypassing the upstream gate. Without this check a user with a stale
    // Authority-only TEE token would seat and immediately hit "cards
    // unreadable" — sit-down fails fast instead, mirroring the other paths.
    // Lock the seat button BEFORE the (headless on Privy) auth signature so it
    // can't be re-clicked or look idle during ensurePlayerAuth().
    setJoiningSeat(seatIndex);
    const authOk = await ensurePlayerAuth();
    if (!authOk) {
      setJoiningSeat(null);
      requestOpenSessionRenewModal();
      setStatus('Sign the session prompt to continue.');
      return false;
    }
    setBuyInLoading(true);
    setStatus(`Taking seat ${seatIndex + 1}...`);
    try {
      // Pre-flight: reject the resume if a 12h anti-rathole lock is active and
      // the pending deposit is below the required minimum. The contract would
      // reject this with custom error 6095 anyway — fail fast with a clear
      // message so the user can cancel the pending join and re-deposit higher.
      try {
        const conn = makeL1Connection();
        const tablePda = new PublicKey(tablePubkey);
        const [markerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('player_table'), publicKey.toBuffer(), tablePda.toBuffer()],
          ANCHOR_PROGRAM_ID,
        );
        const [proofPda] = getDepositProofPda(tablePda, seatIndex);
        const [markerInfo, proofInfo] = await Promise.all([
          conn.getAccountInfo(markerPda),
          conn.getAccountInfo(proofPda),
        ]);
        if (markerInfo && markerInfo.data.length >= 90) {
          const chipsAtLeave = Number(markerInfo.data.readBigUInt64LE(74));
          const leaveTime = Number(markerInfo.data.readBigInt64LE(82));
          const now = Math.floor(Date.now() / 1000);
          const lockExpires = leaveTime + 12 * 3600;
          if (chipsAtLeave > 0 && now < lockExpires) {
            const pendingBuyIn = proofInfo && proofInfo.data.length >= 90
              ? Number(proofInfo.data.readBigUInt64LE(73))
              : 0;
            const bigBlind = Number(gameState.blinds.big || 0);
            const minBuyIn = bigBlind > 0 ? bigBlind * buyInMin : 0;
            const kickTime = markerInfo.data.length >= 99 ? Number(markerInfo.data.readBigInt64LE(90)) : 0;
            const kickReason = markerInfo.data.length >= 99 ? markerInfo.data.readUInt8(98) : 0;
            const kickPenalty = kickReason > 0 && kickTime > 0 && now - kickTime < 30 * 60 ? bigBlind : 0;
            const effectiveMin = Math.max(minBuyIn, chipsAtLeave) + kickPenalty;
            if (pendingBuyIn < effectiveMin) {
              const tokenSymbol = getTokenSymbol(tokenMint);
              const minAmount = fmtTokenAmount(effectiveMin, 9);
              const haveAmount = fmtTokenAmount(pendingBuyIn, 9);
              const minutesLeft = Math.ceil((lockExpires - now) / 60);
              const lockLabel = minutesLeft < 60 ? `${minutesLeft}m` : `${(minutesLeft / 60).toFixed(1)}h`;
              throw new Error(`Anti-rathole lock: pending deposit ${haveAmount} ${tokenSymbol} is below the required ${minAmount} ${tokenSymbol} (lock expires in ${lockLabel}). Cancel the pending join to refund, then re-deposit at the higher amount.`);
            }
          }
        }
      } catch (e: any) {
        if (e?.message?.startsWith('Anti-rathole lock:')) throw e;
        console.warn('[seat-resume] Rathole pre-flight check failed (proceeding):', e?.message?.slice(0, 100));
      }

      const seatSig = await clientSeatPlayer(seatIndex);
      console.log('[seat] Resumed pending join (client-side seat_player):', seatSig.slice(0, 20));
      SFX.play('table-join');
      setAutoPostBlinds(true);
      setPendingJoinSeat(null);
      setReservedJoinSeat(null);
      setSelectedJoinSeat(null);
      setReservedJoinSeats(prev => prev.filter(s => s !== seatIndex));
      setBuyInModal(null);
      reloadSession();
      await refreshState();
      triggerCashReady('seat-resume');
      setStatus(`Seated at #${seatIndex + 1}`);
      setTimeout(() => setStatus(null), 3000);
      return true;
    } catch (e: any) {
      console.error('[join-resume] Failed to finish pending seat:', e);
      setStatus(getErrorMessage(e));
      return false;
    } finally {
      setJoiningSeat(null);
      setBuyInLoading(false);
    }
  }, [publicKey, signMessage, tablePubkey, gameState?.maxPlayers, gameState?.blinds.big, buyInMin, buyInMax, tokenMint, reloadSession, refreshState, triggerCashReady, clientSeatPlayer]);

  useEffect(() => {
    if (!publicKey || !gameState || gameState.isCashGame === false || gameState.mySeatIndex >= 0) {
      setPendingJoinSeat(null);
      setPendingDepositAt(null);
      setReservedJoinSeat(null);
      setSelectedJoinSeat(null);
      setReservedJoinSeats([]);
      setClearingJoinSeats([]);
      return;
    }
    let cancelled = false;
    const refreshPendingSeat = async () => {
      const [pendingSeat, reservedSeat, reservedSeats] = await Promise.all([
        readOwnPendingJoinSeat(),
        readOwnReservedJoinSeat(),
        scanReservedJoinSeats(),
      ]);
      if (!cancelled) {
        setPendingJoinSeat(pendingSeat);
        setReservedJoinSeats(reservedSeats);
        if (pendingSeat === null && reservedSeat !== null) {
          const cleared = await clearOwnStaleJoinMarker(reservedSeat);
          if (!cancelled && cleared) {
            setReservedJoinSeat(null);
            return;
          }
        }
        setReservedJoinSeat(reservedSeat);
      }
    };
    refreshPendingSeat();
    const id = window.setInterval(refreshPendingSeat, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [publicKey, gameState?.isCashGame, gameState?.mySeatIndex, readOwnPendingJoinSeat, readOwnReservedJoinSeat, scanReservedJoinSeats, clearOwnStaleJoinMarker]);

  const openBuyInModal = async (seatIndex: number) => {
    setSelectedJoinSeat(seatIndex);
    // Lock the seat button BEFORE the (headless on Privy) auth signature so it
    // can't be re-clicked or look idle during ensurePlayerAuth(). Cleared once
    // the buy-in modal opens (the modal then carries the busy state) or on bail.
    setJoiningSeat(seatIndex);
    // Auth gate: ensure player TEE token is active before opening buy-in
    const authOk = await ensurePlayerAuth();
    if (!authOk) {
      setSelectedJoinSeat(null);
      setJoiningSeat(null);
      requestOpenSessionRenewModal();
      setStatus('Sign the session prompt to continue.');
      return;
    }
    const pendingSeat = pendingJoinSeat ?? await readOwnPendingJoinSeat();
    if (pendingSeat !== null) {
      setPendingJoinSeat(pendingSeat);
      await finishPendingSeat(pendingSeat);
      return;
    }
    const reservedSeat = reservedJoinSeat ?? await readOwnReservedJoinSeat();
    if (reservedSeat !== null) {
      setReservedJoinSeat(reservedSeat);
      if (reservedSeat !== seatIndex) {
        setSelectedJoinSeat(null);
        setJoiningSeat(null);
        setStatus(`Seat ${reservedSeat + 1} is reserved for your wallet on this table. Take that seat first.`);
        return;
      }
    }
    // Check anti-ratholing lock (PlayerTableMarker chip lock)
    setRatholeLock(null);
    if (publicKey && gameState) {
      try {
        const conn = makeL1Connection();
        const tablePda = new PublicKey(tablePubkey);
        const [markerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('player_table'), publicKey.toBuffer(), tablePda.toBuffer()],
          ANCHOR_PROGRAM_ID,
        );
        const markerInfo = await conn.getAccountInfo(markerPda);
        if (markerInfo && markerInfo.data.length >= 90) {
          const chipsAtLeave = Number(markerInfo.data.readBigUInt64LE(74));
          const leaveTime = Number(markerInfo.data.readBigInt64LE(82));
          const now = Math.floor(Date.now() / 1000);
          const lockExpires = leaveTime + 12 * 3600;
          if (chipsAtLeave > 0 && now < lockExpires) {
            const minutesLeft = Math.ceil((lockExpires - now) / 60);
            const kickTime = markerInfo.data.length >= 99 ? Number(markerInfo.data.readBigInt64LE(90)) : 0;
            const kickReason = markerInfo.data.length >= 99 ? markerInfo.data.readUInt8(98) : 0;
            const kickPenalty = kickReason > 0 && kickTime > 0 && now - kickTime < 30 * 60 ? gameState.blinds.big : 0;
            setRatholeLock({ chipsAtLeave, minutesLeft, kickPenalty });
            // Auto-set minimum BB to cover the lock
            const bigBlind = gameState.blinds.big || 1;
            const minLockBBs = Math.max(buyInMin, Math.ceil((Math.max(chipsAtLeave, bigBlind * buyInMin) + kickPenalty) / bigBlind));
            SFX.play('modal-open');
            setJoiningSeat(null);
            setBuyInModal({ seatIndex });
            setBuyInBBs(minLockBBs);
            return; // skip default setBuyInBBs below
          }
        }
      } catch (e: any) {
        console.warn('[rathole] Failed to check PlayerTableMarker:', e.message?.slice(0, 80));
      }
    }
    SFX.play('modal-open');
    setJoiningSeat(null);
    setBuyInModal({ seatIndex });
    setBuyInBBs(buyInType === 1 ? 100 : 50);
  };

  const confirmBuyIn = async () => {
    if (!publicKey || !sendTransaction || !buyInModal || !gameState) return;
    setBuyInLoading(true);
    setStatus(null);
    try {
      const conn = makeL1Connection();
      const tablePda = new PublicKey(tablePubkey);
      const isTopup = buyInModal.mode === 'topup';
      const [receiptPda] = getReceiptPda(tablePda, buyInModal.seatIndex);
      const receiptInfo = await conn.getAccountInfo(receiptPda);
      if (!isTopup && receiptInfo && receiptInfo.data.length >= 82) {
        const receiptDepositor = new PublicKey(receiptInfo.data.subarray(50, 82));
        if (!receiptDepositor.equals(PublicKey.default) && !receiptDepositor.equals(publicKey)) {
          setClearingJoinSeats(prev => Array.from(new Set([...prev, buyInModal.seatIndex])));
          setStatus(`Seat ${buyInModal.seatIndex + 1} is still clearing from the previous player. Try another seat or retry shortly.`);
          setBuyInModal(null);
          setSelectedJoinSeat(null);
          return;
        }
      }
      const buyIn = BigInt(gameState.blinds.big) * BigInt(buyInBBs);
      const tokenSymbol = getTokenSymbol(tokenMint);
      const buyInDisplay = `${fmtTokenAmount(buyIn, 9)} ${tokenSymbol}`;

      // IMPORTANT: For TEE writes, avoid wallet signAndSend pipelines that may route to L1 RPC.
      // Sign locally (wallet) and submit raw bytes to the authenticated TEE connection.
      const sendTeeTx = async (tx: Transaction, teeConn: Connection): Promise<string> => {
        tx.feePayer = publicKey;
        try {
          tx.recentBlockhash = (await teeConn.getLatestBlockhash('confirmed')).blockhash;
        } catch {
          tx.recentBlockhash = (await getLatestBlockhashClient(conn, 'confirmed')).blockhash;
        }

        if (!signTransaction) {
          throw new Error('Your wallet does not support signTransaction (required for TEE sit-down writes). Please use a wallet that supports transaction signing for custom RPC sends.');
        }

        const signed = await signTransaction(tx);
        return teeConn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      };

      // Check if table is delegated (pre-created seats architecture)
      const l1Info = await conn.getAccountInfo(tablePda);
      const isOnL1 = l1Info && l1Info.owner.toBase58() === ANCHOR_PROGRAM_ID.toBase58();

      if (isOnL1) {
        // L1-only tables cannot be played — card privacy requires TEE delegation.
        // Direct the creator to finish setup from the Manage Tables page.
        throw new Error('This table is not delegated to TEE yet. The creator must finish setup before players can join. Check Manage Tables → Resume Setup.');
      }

      {
        // ─── Delegated table flow: deposit on L1 → seat on ER via API ───
        const pendingSeat = pendingJoinSeat ?? await readOwnPendingJoinSeat(conn);
        if (pendingSeat !== null) {
          setPendingJoinSeat(pendingSeat);
          await finishPendingSeat(pendingSeat);
          return;
        }
        const reservedSeat = reservedJoinSeat ?? await readOwnReservedJoinSeat(conn);
        if (reservedSeat !== null && reservedSeat !== buyInModal.seatIndex) {
          setReservedJoinSeat(reservedSeat);
          setSelectedJoinSeat(null);
          setStatus(`Seat ${reservedSeat + 1} is reserved for your wallet on this table. Take that seat first.`);
          return;
        }

        if (gameState.isPrivate && gameState.creator !== publicKey.toBase58()) {
          const [whitelistPda] = getWhitelistPda(tablePda, publicKey);
          const whitelistInfo = await conn.getAccountInfo(whitelistPda);
          if (!whitelistInfo || !whitelistInfo.owner.equals(ANCHOR_PROGRAM_ID)) {
            throw new Error('This is a private table. You are not on the whitelist.');
          }
        }

        setSelectedJoinSeat(buyInModal.seatIndex);
        setStatus('Depositing to vault...');

        // ─── Pre-flight SOL balance check ──────────────────────────────────
        // For SOL tables we need buy-in + rent/fee overhead. For SPL tables
        // the buy-in is in token units so SOL only needs to cover rent/fee
        // + ATA creation + delegation rent (SIT_OVERHEAD). The SPL token
        // balance itself is checked separately below.
        const isSolTable = tokenMint === PublicKey.default.toBase58();
        const requiredLamports = isSolTable
          ? Number(buyIn) + FUNDS_HINTS.SIT_OVERHEAD_LAMPORTS
          : FUNDS_HINTS.SIT_OVERHEAD_LAMPORTS;
        await assertFunds({
          connection: conn,
          payer: publicKey,
          requiredLamports,
          reason: isSolTable
            ? `Buy-in of ${buyInDisplay} plus ~0.015 SOL for seat rent and tx fees.`
            : `~0.015 SOL needed for seat rent, token-account creation, and tx fees.`,
          title: isSolTable ? undefined : 'SOL needed for fees',
          tableTokenSymbol: isSolTable ? undefined : getTokenSymbol(tokenMint),
        });

        // ─── Pre-check: cleanup stale DepositProof if delegated from a prior attempt ───
        // If the proof PDA is owned by Delegation Program on L1, deposit_for_join will fail
        // with AccountOwnedByWrongProgram (3007). Cleanup on TEE first.
        const DELEG_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
        const [proofPda] = getDepositProofPda(tablePda, buyInModal.seatIndex);
        const proofInfo = await conn.getAccountInfo(proofPda);
        if (proofInfo && proofInfo.owner.equals(DELEG_PROGRAM)) {
          setStatus('Cleaning up stale deposit proof from prior attempt...');
          const cleanupAuth = await buildWalletApiAuth(publicKey, signMessage, 'cash-cleanup-proof');
          console.log('[deposit] DepositProof is delegation-owned — cleaning up via backend API');
          // Use backend API for cleanup — wallet adapters (Phantom) route sendTransaction
          // through their own RPC, causing cleanup_deposit_proof to land on L1 where
          // Magic program doesn't exist ("Unsupported program id"). Backend uses a
          // server-side keypair + direct TEE connection to avoid this.
          const cleanupRes = await fetch('/api/cash-game/cleanup-proof', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tablePda: tablePubkey, seatIndex: buyInModal.seatIndex, ...cleanupAuth }),
          });
          const cleanupResult = await cleanupRes.json();
          if (cleanupRes.status === 409 && cleanupResult.reserved) {
            setStatus(cleanupResult.error || 'That seat is reserved by another player who is still joining.');
            setBuyInModal(null);
            setSelectedJoinSeat(null);
            return;
          }
          if (!cleanupRes.ok || !cleanupResult.success) {
            throw new Error(`Stale proof cleanup failed: ${cleanupResult.error || 'unknown'}. Please retry sit-down.`);
          }
          console.log('[cleanup] DepositProof undelegated via backend:', cleanupResult.signature?.slice(0, 20));
          // Wait for L1 to reflect the undelegation
          await new Promise(r => setTimeout(r, 3000));
          const proofAfterCleanup = await conn.getAccountInfo(proofPda);
          if (proofAfterCleanup && proofAfterCleanup.owner.equals(DELEG_PROGRAM)) {
            throw new Error('Stale deposit proof is still delegated after cleanup. Please retry sit-down.');
          }
          setStatus('Depositing to vault...');
        }

        // Determine if SPL token table
        const mint = new PublicKey(tokenMint);
        const isSplTable = tokenMint !== PublicKey.default.toBase58();
        const playerAta = isSplTable ? await getAssociatedTokenAddress(mint, publicKey) : undefined;
        const tableAta = isSplTable ? await getAssociatedTokenAddress(mint, tablePda, true) : undefined;

        // Step 1: deposit_for_join on L1 (player signs)
        // NOTE: blockhash fetched later, right before sendTransaction, to avoid expiry during wallet popup
        const tx = new Transaction();

        // Ensure session keypair exists for approved_signer
        let sessionKeyForSigner: Keypair | null = session.sessionKey || null;
        if (!sessionKeyForSigner) {
          sessionKeyForSigner = Keypair.generate();
          console.log('[confirmBuyIn] New session key for approved_signer:', sessionKeyForSigner.publicKey.toBase58().slice(0, 12));
        }

        // Auto-register if PlayerAccount PDA doesn't exist
        const [playerPda] = getPlayerPda(publicKey);
        const [unrefinedPda] = getUnrefinedPda(publicKey);
        const [playerInfo, unrefinedInfo] = await Promise.all([
          conn.getAccountInfo(playerPda),
          conn.getAccountInfo(unrefinedPda),
        ]);
        if (!playerInfo) {
          tx.add(new TransactionInstruction({
            programId: ANCHOR_PROGRAM_ID,
            keys: [
              { pubkey: publicKey, isSigner: true, isWritable: true },
              { pubkey: playerPda, isSigner: false, isWritable: true },
              { pubkey: TREASURY, isSigner: false, isWritable: true },
              { pubkey: POOL_PDA, isSigner: false, isWritable: true },
              { pubkey: unrefinedPda, isSigner: false, isWritable: true },
              { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: REGISTER_DISCRIMINATOR,
          }));
        } else if (!unrefinedInfo) {
          tx.add(new TransactionInstruction({
            programId: STEEL_PROGRAM_ID,
            keys: [
              { pubkey: publicKey, isSigner: true, isWritable: true },
              { pubkey: unrefinedPda, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: INIT_UNREFINED_DISC,
          }));
        }

        // Legacy vaults can still be 57/73 bytes; deposit_for_join expects current vault layout.
        // resize_vault is idempotent, so prepend it unconditionally.
        tx.add(buildResizeVaultInstruction(publicKey, tablePda));

        // For SPL tables: ensure table's escrow ATA exists (first depositor creates it)
        if (isSplTable && tableAta) {
          const tableAtaInfo = await conn.getAccountInfo(tableAta);
          if (!tableAtaInfo) {
            tx.add(createAssociatedTokenAccountInstruction(publicKey, tableAta, tablePda, mint));
          }
        }

        const depositIx = buildDepositForJoinInstruction(
          publicKey, tablePda, buyInModal.seatIndex, buyIn,
          BigInt(0),
          isSplTable ? mint : undefined,
          playerAta,
          tableAta,
          sessionKeyForSigner.publicKey, // approved_signer for gasless TEE play
          gameState.isPrivate && gameState.creator !== publicKey.toBase58() ? publicKey : undefined,
        );
        tx.add(depositIx);

        // Step 1b: Bundle delegate_deposit_proof into same L1 TX (user pays).
        // This delegates the DepositProof PDA to TEE so seat_player can read it.
        const [depositProofPda] = getDepositProofPda(tablePda, buyInModal.seatIndex);
        const delegBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(depositProofPda, ANCHOR_PROGRAM_ID);
        const delegRec = delegationRecordPdaFromDelegatedAccount(depositProofPda);
        const delegMeta = delegationMetadataPdaFromDelegatedAccount(depositProofPda);
        tx.add(buildDelegateDepositProofInstruction(
          publicKey, tablePda, buyInModal.seatIndex,
          delegBuf, delegRec, delegMeta, DELEGATION_PROGRAM_ID,
        ));

        // Pre-simulate to catch errors before Phantom's generic "Unexpected error"
        tx.feePayer = publicKey;
        tx.recentBlockhash = (await getLatestBlockhashClient(conn, 'confirmed')).blockhash;
        const simResult = await conn.simulateTransaction(tx);
        if (simResult.value.err) {
          const errJson = JSON.stringify(simResult.value.err);
          console.error('[deposit] Simulation failed:', errJson);
          const lastLogs = (simResult.value.logs || []).slice(-8);
          lastLogs.forEach(l => console.log('[sim]', l));
          // Surface raw error + last log lines so user can report the failure
          const logHint = lastLogs.filter(l => l.includes('Error') || l.includes('failed') || l.includes('custom program error')).join(' | ');
          throw new Error(`Deposit simulation failed: ${errJson}${logHint ? ' — ' + logHint : ''}`);
        }
        console.log('[deposit] Simulation passed, sending to wallet...');
        if (!(await confirmFundsAction({
          title: 'Confirm Buy-In',
          action: `Join seat ${buyInModal.seatIndex + 1}`,
          amount: buyInDisplay,
          table: tablePubkey,
          details: [`Stack: ${buyInBBs} BB`],
          transaction: tx,
        }))) {
          return;
        }

        // DEVNET ONLY: manual sign+send bypasses Phantom's signAndSendTransaction,
        // which submits via Phantom's own (mainnet) RPC and errors on devnet txs.
        // On MAINNET we fall through to sendTransaction (signAndSend) so Phantom and
        // Blowfish can inject their Lighthouse guard. Fresh blockhash avoids expiry
        // during the wallet-approval delay.
        if (!IS_MAINNET && signTransaction) {
          const { blockhash: freshHash } = await getLatestBlockhashClient(conn, 'confirmed');
          tx.recentBlockhash = freshHash;
          // No co-sign needed — approved_signer is just data, not a signer
          const signed = await signTransaction(tx);
          const depositSig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
          console.log('[deposit] TX sent via signTransaction:', depositSig.slice(0, 20));
          // Poll for confirmation (TEE WS works but polling kept for now — migration pending)
          let confirmed = false;
          for (let poll = 0; poll < 30; poll++) {
            await new Promise(r => setTimeout(r, 1000));
            const status = await conn.getSignatureStatuses([depositSig]);
            const s = status?.value?.[0];
            if (s?.err) throw new Error(`Deposit TX failed: ${JSON.stringify(s.err)}`);
            if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
              confirmed = true;
              console.log(`[deposit] Confirmed (poll ${poll})`);
              break;
            }
          }
          if (!confirmed) throw new Error('Deposit TX not confirmed after 30s. Try again.');
        } else {
          // Fallback for wallets without signTransaction
          const depositSig = await sendTransaction(tx, conn, { skipPreflight: false });
          await conn.confirmTransaction(depositSig, 'confirmed');
        }

        setPendingJoinSeat(buyInModal.seatIndex);
        setReservedJoinSeats(prev => prev.includes(buyInModal.seatIndex) ? prev : [...prev, buyInModal.seatIndex]);

        // Save session key to IndexedDB (approved_signer set in deposit_for_join data)
        if (sessionKeyForSigner && !session.sessionKey?.publicKey.equals(sessionKeyForSigner.publicKey)) {
          await setSessionKey(publicKey.toBase58(), sessionKeyForSigner.secretKey);
          console.log('[confirmBuyIn] Session key saved to IndexedDB');
        }

        // Step 2: seat_player — signed locally by the player, submitted to the
        // authenticated TEE connection (no server). The buy-in was already
        // deposited + the DepositProof delegated above; seat_player reads it.
        setJoiningSeat(buyInModal.seatIndex);
        setStatus('Seating at table...');
        const seatSig = await clientSeatPlayer(buyInModal.seatIndex);
        console.log('[seat] Seated (client-side seat_player):', seatSig.slice(0, 20));

        // Cleanup is signature-gated now. The crank/recovery path handles it
        // without forcing a second wallet-message popup after a sit-down.

        setStatus(`Seated at #${buyInModal.seatIndex + 1}`);
        setAutoPostBlinds(true);
        setPendingJoinSeat(null);
        setReservedJoinSeat(null);
        setSelectedJoinSeat(null);
        setReservedJoinSeats(prev => prev.filter(s => s !== buyInModal.seatIndex));
        setJoiningSeat(null);
        triggerCashReady('seat-complete');
      }

      SFX.play('table-join');
      setBuyInModal(null);
      setSelectedJoinSeat(null);
      reloadSession();
      refreshState();
      // Auto-clear join status after 3s
      setTimeout(() => setStatus(null), 3000);
    } catch (e: any) {
      setBuyInModal(null);
      setSelectedJoinSeat(null);
      console.error('[confirmBuyIn] Full error:', e);
      // Route INSUFFICIENT_FUNDS into the live-polling modal instead of
      // dumping a raw error string into the status pill.
      if (handleFundsError(e)) return;
      setStatus(getErrorMessage(e));
    } finally {
      setBuyInLoading(false);
      setJoiningSeat(null);
    }
  };

  // ─── Top-up (add chips while seated) ───

  const handleTopup = async () => {
    if (!publicKey || !signTransaction || !gameState || gameState.mySeatIndex < 0) return;
    setTopupLoading(true);
    try {
      const conn = makeL1Connection();
      const tablePda = new PublicKey(tablePubkey);
      const seatIndex = gameState.mySeatIndex;
      const bigBlind = gameState.blinds?.big || 0;
      const topupAmount = BigInt(topupBBs) * BigInt(bigBlind);
      const tokenSymbol = getTokenSymbol(tokenMint);
      const topupDisplay = `${fmtTokenAmount(topupAmount, 9)} ${tokenSymbol}`;

      // Max buy-in enforcement: don't let player deposit more than max - current chips
      const currentChips = myPlayer?.chips || 0;
      const maxBBs = buyInType === 1 ? 250 : 100;
      const maxChips = BigInt(maxBBs) * BigInt(bigBlind);
      if (BigInt(currentChips) + topupAmount > maxChips) {
        const roomBBs = Math.floor(Number(maxChips - BigInt(currentChips)) / bigBlind);
        throw new Error(`Top-up would exceed max buy-in (${maxBBs} BB). You can add up to ${Math.max(0, roomBBs)} BB.`);
      }

      setStatus('Depositing top-up...');

      // ─── Pre-flight SOL balance check ──────────────────────────────────
      // SOL table: need top-up amount + tx fee. SPL table: just tx fee +
      // re-delegation overhead in SOL; the token amount is checked at the
      // SPL layer separately.
      const isSolTopup = tokenMint === PublicKey.default.toBase58();
      const topupRequiredLamports = isSolTopup
        ? Number(topupAmount) + FUNDS_HINTS.TX_FEE_LAMPORTS
        : FUNDS_HINTS.TX_FEE_LAMPORTS;
      await assertFunds({
        connection: conn,
        payer: publicKey,
        requiredLamports: topupRequiredLamports,
        reason: isSolTopup
          ? `Top-up of ${topupDisplay} plus tx fee.`
          : 'Tx fee needed to top up your seat.',
        title: isSolTopup ? undefined : 'SOL needed for fees',
        tableTokenSymbol: isSolTopup ? undefined : getTokenSymbol(tokenMint),
      });

      // Pre-check: deposit_topup runs on L1, so a consumed delegated proof from the
      // original sit-down has to be returned to L1 before Anchor can write it.
      // cleanup_deposit_proof only cleans consumed proofs for active seats, so it
      // won't overwrite an unconsumed in-flight top-up.
      const DELEG_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
      const [proofPda] = getDepositProofPda(tablePda, seatIndex);
      const proofInfo = await conn.getAccountInfo(proofPda);
      if (proofInfo && proofInfo.owner.equals(DELEG_PROGRAM)) {
        setStatus('Preparing top-up proof...');
        const cleanupAuth = await buildWalletApiAuth(publicKey, signMessage, 'cash-cleanup-proof');
        const cleanupRes = await fetch('/api/cash-game/cleanup-proof', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tablePda: tablePubkey, seatIndex, ...cleanupAuth }),
        });
        const cleanupResult = await cleanupRes.json();
        if (cleanupRes.status === 409 && cleanupResult.reserved) {
          throw new Error(cleanupResult.error || 'A top-up is still being processed. Please wait a few seconds and try again.');
        }
        if (!cleanupRes.ok || !cleanupResult.success) {
          throw new Error(`Top-up proof cleanup failed: ${cleanupResult.error || 'unknown'}. Please retry top-up.`);
        }
        await new Promise(r => setTimeout(r, 3000));
        const proofAfterCleanup = await conn.getAccountInfo(proofPda);
        if (proofAfterCleanup && proofAfterCleanup.owner.equals(DELEG_PROGRAM)) {
          throw new Error('Top-up proof is still delegated after cleanup. Please retry top-up.');
        }
        setStatus('Depositing top-up...');
      }

      // Determine if SPL token table
      const mint = new PublicKey(tokenMint);
      const isSplTable = tokenMint !== PublicKey.default.toBase58();
      const playerAta = isSplTable ? await getAssociatedTokenAddress(mint, publicKey) : undefined;
      const tableAta = isSplTable ? await getAssociatedTokenAddress(mint, tablePda, true) : undefined;

      // Build deposit_topup TX on L1 + delegate_deposit_proof
      const tx = new Transaction();

      // Resize vault if needed (idempotent)
      tx.add(buildResizeVaultInstruction(publicKey, tablePda));

      // deposit_topup — atomic SOL/SPL transfer + proof update
      tx.add(buildDepositTopupInstruction(
        publicKey, tablePda, seatIndex, topupAmount,
        isSplTable ? mint : undefined,
        playerAta,
        tableAta,
      ));

      // Bundle delegate_deposit_proof in same TX
      const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
      const delegBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(depositProofPda, ANCHOR_PROGRAM_ID);
      const delegRec = delegationRecordPdaFromDelegatedAccount(depositProofPda);
      const delegMeta = delegationMetadataPdaFromDelegatedAccount(depositProofPda);
      tx.add(buildDelegateDepositProofInstruction(
        publicKey, tablePda, seatIndex,
        delegBuf, delegRec, delegMeta, DELEGATION_PROGRAM_ID,
      ));

      // Simulate first
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await getLatestBlockhashClient(conn, 'confirmed')).blockhash;
      const simResult = await conn.simulateTransaction(tx);
      if (simResult.value.err) {
        const errJson = JSON.stringify(simResult.value.err);
        const lastLogs = (simResult.value.logs || []).slice(-8);
        const logHint = lastLogs.filter(l => l.includes('Error') || l.includes('failed')).join(' | ');
        throw new Error(`Top-up simulation failed: ${errJson}${logHint ? ' — ' + logHint : ''}`);
      }

      if (!(await confirmFundsAction({
        title: 'Confirm Top-Up',
        action: `Add chips to seat ${seatIndex + 1}`,
        amount: topupDisplay,
        table: tablePubkey,
        details: [`Top-up: ${topupBBs} BB`],
        transaction: tx,
      }))) {
        return;
      }

      // Sign + send
      const { blockhash: freshHash } = await getLatestBlockhashClient(conn, 'confirmed');
      tx.recentBlockhash = freshHash;
      const sig = await sendWalletTx(tx, conn, { sendTransaction, signTransaction });
      console.log('[topup] TX sent:', sig.slice(0, 20));
      // Show the non-intrusive "topping up" pill until the chips land on the felt.
      setTopupPending({ baseline: Number(currentChips), at: Date.now() });

      // Poll for confirmation
      let confirmed = false;
      for (let poll = 0; poll < 30; poll++) {
        await new Promise(r => setTimeout(r, 1000));
        const status = await conn.getSignatureStatuses([sig]);
        const s = status?.value?.[0];
        if (s?.err) throw new Error(`Top-up TX failed: ${JSON.stringify(s.err)}`);
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
          confirmed = true;
          break;
        }
      }
      if (!confirmed) throw new Error('Top-up TX not confirmed after 30s. Try again.');

      // Step 2: apply_topup on TEE via backend API
      setStatus('Applying top-up...');
      const topupAuth = await buildWalletApiAuth(publicKey, signMessage, 'cash-topup');
      const topupRes = await fetch('/api/cash-game/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tablePda: tablePubkey, seatIndex, ...topupAuth }),
      });
      const topupResult = await topupRes.json();
      if (!topupRes.ok || !topupResult.success) {
        throw new Error(`Apply top-up failed: ${topupResult.error || 'unknown'}`);
      }

      setStatus(`Added ${topupBBs} BB`);
      setAutoPostBlinds(true);
      setTopupModal(false);
      refreshState();
      setTimeout(() => setStatus(null), 3000);
    } catch (e: any) {
      console.error('[topup] Error:', e);
      if (handleFundsError(e)) return;
      setStatus(getErrorMessage(e));
    } finally {
      setTopupLoading(false);
    }
  };

  // ─── Sit Out / Sit In state (needed by leave handler) ───

  const myPlayer = gameState?.players?.find(p => p.pubkey === publicKey?.toBase58());
  const isMeSittingOut = myPlayer?.isSittingOut ?? false;

  // Clear the "topping up" pill once the chips land (stack grew past baseline),
  // with a 120s safety so it can never stick if the read lags.
  useEffect(() => {
    if (!topupPending) return;
    if ((myPlayer?.chips ?? 0) > topupPending.baseline) { setTopupPending(null); return; }
    const t = setTimeout(() => setTopupPending(null), Math.max(0, 120_000 - (Date.now() - topupPending.at)));
    return () => clearTimeout(t);
  }, [topupPending, myPlayer?.chips]);

  // ─── Hand-outcome safeguard: detect a contested hand that ended without a
  // shown result, and surface a recap. Tracks chips/fold/dealt-in per hand and
  // evaluates the previous hand on each hand boundary. Recap-only — reads state,
  // never polls faster or touches the signing path.
  useEffect(() => {
    if (!gameState) return;
    const hand = gameState.handNumber;
    const heroPk = publicKey?.toBase58();
    const hero = heroPk ? gameState.players?.find(p => p.pubkey === heroPk) : undefined;
    const heroChips = hero?.chips ?? 0;
    // Accumulate within the current hand.
    if (gameState.myCards) heroDealtInThisHandRef.current = true;
    if (hero?.folded) heroFoldedThisHandRef.current = true;

    if (recapEvalHandRef.current === hand) return; // same hand — nothing to settle yet

    // Hand boundary: the hand that just ended is recapEvalHandRef.current.
    const endedHand = recapEvalHandRef.current;
    const wasDealtIn = heroDealtInThisHandRef.current;
    const wasFolded = heroFoldedThisHandRef.current;
    const startChips = heroStartChipsRef.current;
    const shouldRecap =
      endedHand >= 0 && startChips != null && !!tablePubkey
      && wasDealtIn && !wasFolded          // you contested this hand
      && heroChips > 0                     // still have a stack (bust → elimination/rebuy UX covers it)
      && resultShownForHandRef.current !== endedHand // the live UI never showed it
      && recapDoneForHandRef.current !== endedHand;

    if (shouldRecap) {
      recapDoneForHandRef.current = endedHand;
      const delta = heroChips - (startChips as number); // post-settle minus pre-hand stack
      fpDebug(`recap.trigger hand=${endedHand} delta=${delta} (no live result shown)`);
      // Seed neutral; the authoritative win/loss is set from the fetched record
      // below. The raw chip delta is lag-prone (the recap fires ON lag), e.g. a BB
      // fold-win read mid-post shows -BB, so we don't trust it for the headline.
      setHandRecap({ handNumber: endedHand, board: [], heroWon: false, heroDelta: 0, loading: true, isSng: gameState.isCashGame === false });
      // Authoritative board + winners; sync=1 forces a fresh indexer crawl.
      (async () => {
        try {
          const r = await fetch(`/api/hand-history?table=${encodeURIComponent(tablePubkey)}&handNumber=${endedHand}&sync=1`);
          const data = r.ok ? await r.json() : null;
          const rec = data?.record
            ?? (Array.isArray(data?.records) ? data.records.find((x: any) => x?.handNumber === endedHand) : null)
            ?? (Array.isArray(data) ? data.find((x: any) => x?.handNumber === endedHand) : null);
          // The record's communityCards is a fixed 5-slot array padded with '??'
          // for undealt slots (cardLabel maps 255 → '??'). Trim to the REAL board so
          // we render only dealt cards AND can use the count as the ending street.
          const rawBoard: string[] = Array.isArray(rec?.communityCards) ? rec.communityCards : [];
          const board: string[] = rawBoard.filter((c) => c && c !== '??');
          // All-in detection (action 5 = AllIn). An all-in reaches showdown and
          // RUNS THE BOARD OUT, so if the record didn't capture the board we must
          // NOT claim "no community cards dealt" — it was an all-in runout.
          const heroAllIn = Array.isArray(rec?.actions)
            && rec.actions.some((a: any) => a?.wallet === heroPk && a?.action === 5);
          // Authoritative win/loss from the hand record. rec.winners is a SEAT-INDEX
          // array; the hero's seat is gameState.mySeatIndex. This overrides the
          // lag-prone chip delta (which can read a BB fold-win as a 1000-chip loss).
          const heroSeat = gameState.mySeatIndex;
          const isWinner = heroSeat >= 0 && Array.isArray(rec?.winners) && rec.winners.includes(heroSeat);
          let heroWon = delta >= 0;   // fallback when the record is unavailable
          let heroDelta = delta;       // fallback
          if (rec && heroSeat >= 0) {
            if (rec.foldWin === true) {
              if (isWinner) {
                // Won an uncontested pot: net = pot minus our own contribution.
                // Count only real betting rows (post-blind=2, player-action=3),
                // not roster/start/tee/crank bookkeeping rows.
                const heroBets = Array.isArray(rec.actions)
                  ? rec.actions
                      .filter((a: any) => a?.wallet === heroPk && (a?.kind === 2 || a?.kind === 3))
                      .reduce((s: number, a: any) => s + (a?.amount || 0), 0)
                  : 0;
                heroWon = true;
                heroDelta = Math.max(0, (rec.pot || 0) - heroBets);
              } else {
                heroWon = false;
                heroDelta = Math.min(0, delta); // folded → our committed chips lost
              }
            } else {
              // Showdown: the live runout makes the chip delta accurate; just never
              // render "won -X" if a split/race briefly reports a negative delta.
              heroWon = isWinner;
              heroDelta = isWinner ? Math.max(delta, 0) : delta;
            }
          }
          // If the hand ended on a fold (no showdown), surface the deciding fold so
          // the recap explains HOW it was won, not just the board. An empty board
          // with a hero win is always a preflop fold-win (no runout is possible).
          let endAction: string | undefined;
          const foldEnded = rec?.foldWin === true || (board.length === 0 && heroWon);
          if (foldEnded) {
            // Ending street = how many REAL community cards were dealt. For a fold-win
            // (no all-in runout) the board only advances as far as the hand actually
            // went, so the dealt-card count is the ground-truth street: 0=preflop,
            // 3=flop, 4=turn, 5=river. This is immune to the on-chain action buffer
            // dropping or re-ordering the deciding fold — which is why reading the
            // "last fold action's street" misreported multiway hands as "preflop"
            // when most folded preflop but the pot-deciding fold landed on a later street.
            const boardStreet = board.length >= 5 ? 3 : board.length === 4 ? 2 : board.length >= 3 ? 1 : 0;
            const foldActions: any[] = Array.isArray(rec?.actions)
              ? rec.actions.filter((a: any) => a?.action === 0 && a?.wallet)
              : [];
            // Cross-check: the furthest street any recorded fold reached. Used only
            // as a fallback when the board reveal is missing from this record.
            const maxFoldStreet = foldActions.reduce(
              (m: number, a: any) => (typeof a?.street === 'number' && a.street > m ? a.street : m),
              0,
            );
            const streetNum = board.length > 0 ? boardStreet : maxFoldStreet;
            const street = streetNum <= 0 ? 'preflop' : streetNum === 1 ? 'on the flop' : streetNum === 2 ? 'on the turn' : 'on the river';
            // Name the player who folded on that final street (the deciding fold),
            // not merely the last entry in a possibly-unordered list.
            const decidingFold = [...foldActions].reverse().find((a: any) => a?.street === streetNum)
              ?? foldActions[foldActions.length - 1];
            const name = decidingFold?.wallet ? handLogName(decidingFold.wallet) : null;
            endAction = name
              ? `${name} folded ${street}`
              : (streetNum <= 0 ? 'Everyone folded preflop' : `Won when the last player folded ${street}`);
          }
          setHandRecap(prev => (prev && prev.handNumber === endedHand) ? { ...prev, board, endAction, heroWon, heroDelta, heroAllIn, loading: false } : prev);
        } catch {
          setHandRecap(prev => (prev && prev.handNumber === endedHand) ? { ...prev, loading: false } : prev);
        }
      })();
    }

    // Reset trackers for the new hand.
    recapEvalHandRef.current = hand;
    heroStartChipsRef.current = heroChips;
    heroDealtInThisHandRef.current = !!gameState.myCards;
    heroFoldedThisHandRef.current = !!hero?.folded;
  }, [gameState, publicKey, tablePubkey]);

  // Auto-dismiss the recap card after a while (also dismissible + replaced by
  // the next hand's recap).
  useEffect(() => {
    if (!handRecap) return;
    const t = setTimeout(() => setHandRecap(null), 14000);
    return () => clearTimeout(t);
  }, [handRecap]);

  // Retain the last resolved recap so the re-show pill can bring the board +
  // result back after the auto-dismiss (only once it has loaded, not the shell).
  useEffect(() => {
    if (handRecap && !handRecap.loading) {
      setLastHandRecap(prev => (prev === handRecap ? prev : handRecap));
    }
  }, [handRecap]);

  // ─── Leave table ───

  const handleLeaveTable = useCallback(async () => {
    if (!publicKey || !gameState || gameState.mySeatIndex < 0) return;

    // Confirm before leaving. Real money out, no recovery once seat is freed.
    const tokenSymbol = getTokenSymbol(tokenMint);
    const seatedChips = (myPlayer?.chips || 0) + (myPlayer?.vaultReserve || 0);
    const cashoutDisplay = seatedChips > 0
      ? `${fmtTokenAmount(seatedChips, 9)} ${tokenSymbol}`
      : `your seated stack`;
    const ok = await confirmFundsAction({
      title: 'Leave Table',
      action: 'Sit out and cash out',
      amount: cashoutDisplay,
      table: tablePubkey,
      details: [
        'Your seated stack is returned to your wallet between hands.',
        'You will leave the table at the next settlement.',
      ],
    });
    if (!ok) return;

    const leavingSeatIdx = gameState.mySeatIndex;
    setLeavingTable(true);
    setStatus(null);
    try {
      // Send leave_cash_game on ER. sets status to Leaving (6)
      // The crank detects Leaving players between hands and processes the cashout cycle:
      // undelegate -> process_cashout_v2 on L1 (cashout back to wallet) -> re-delegate
      setStatus('Requesting leave...');
      await sendAction('leave_cash_game');
      setAutoPostBlinds(false);
      removeActiveGame(tablePubkey); // Clear active table bar
      void refreshMyActiveTables(); // force a fresh (cache-bypassing) scan so the just-left seat (now Leaving) drops from the bar/lobby immediately instead of after the 30s cache
      // Clear the player_table_marker so a revisit to this room doesn't read
      // the marker as a "pending join" and show "TAKE SEAT" on the user's
      // just-left seat. The marker survives leave by design (anti-ratholing
      // signal) but the join-detection code at readOwnPendingJoinSeat would
      // otherwise treat the still-delegated deposit_proof PDA as an
      // unfinished join. Fire-and-forget — failure here is non-fatal.
      void clearOwnStaleJoinMarker(leavingSeatIdx).catch(() => undefined);
      setStatus('Leaving table. Your SOL will be returned to your wallet between hands.');
      setTimeout(() => router.push('/lobby'), 4000);
    } catch (e: any) {
      console.error('Leave table error:', e.message?.slice(0, 80));
      setStatus(getErrorMessage(e));
    } finally {
      setLeavingTable(false);
    }
  }, [publicKey, gameState, tablePubkey, sendAction, router, myPlayer, tokenMint, clearOwnStaleJoinMarker]);

  // ─── Distribute rake ───

  const distributeRake = async () => {
    if (!publicKey) return;
    setActionPending(true);
    setStatus(null);
    try {
      if (!(await confirmFundsAction({
        title: 'Confirm Rake Claim',
        action: 'Distribute pending table rake',
        table: tablePubkey,
      }))) {
        return;
      }
      const rakeAuth = await buildWalletApiAuth(publicKey, signMessage, 'cash-clear-rake');
      // Server-side atomic: L1 distribute + ER clear (nonce-guarded)
      // API auto-detects SOL vs SPL from table data
      const res = await fetch('/api/cash-game/clear-rake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tablePda: tablePubkey, ...rakeAuth }),
      });
      const result = await res.json();
      if (!result.success && result.error) {
        throw new Error(result.error);
      }
      setStatus(`Rake distributed! ${result.distributed || 0} ${isSol ? 'lamports' : getTokenSymbol(tokenMint)}`);
      refreshState();
    } catch (e: any) {
      setStatus(getErrorMessage(e));
    } finally {
      setActionPending(false);
    }
  };

  // ─── Deposit Tip ───

  const depositTip = async () => {
    if (!publicKey || !signTransaction) return;
    setTipPending(true);
    setStatus(null);
    try {
      const conn = makeL1Connection();
      const tablePda = new PublicKey(tablePubkey);
      const [tipJarPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('tip_jar'), tablePda.toBuffer()],
        new PublicKey(ANCHOR_PROGRAM_ID),
      );
      const lamports = Math.floor(parseFloat(tipAmount) * 1e9);
      if (lamports < 1000) {
        setStatus('Invalid tip: min 0.000001 SOL');
        return;
      }

      const tx = new Transaction();

      // Auto-initialize TipJar PDA if it doesn't exist yet
      const tipJarAcct = await conn.getAccountInfo(tipJarPda);
      if (!tipJarAcct) {
        // init_tip_jar discriminator: sha256("global:init_tip_jar")[0..8]
        const initDisc = Buffer.from([
          0x0d, 0x8a, 0xd3, 0xe6, 0x2b, 0xb0, 0xd8, 0x73,
        ]);
        tx.add(new TransactionInstruction({
          programId: new PublicKey(ANCHOR_PROGRAM_ID),
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: tablePda, isSigner: false, isWritable: false },
            { pubkey: tipJarPda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: initDisc,
        }));
      }

      // deposit_tip discriminator: [15, 27, 172, 40, 63, 77, 240, 207]
      // Data layout: disc(8) + amount(u64 LE, 8) = 16 bytes.
      // hands_remaining resets to 100 on-chain per deposit.
      const disc = Buffer.from([15, 27, 172, 40, 63, 77, 240, 207]);
      const data = Buffer.alloc(8 + 8);
      disc.copy(data, 0);
      data.writeBigUInt64LE(BigInt(lamports), 8);
      tx.add(new TransactionInstruction({
        programId: new PublicKey(ANCHOR_PROGRAM_ID),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: tipJarPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }));

      // Memo nonce: prevents "transaction already processed" on rapid retries.
      // Same blockhash + same data = same signature; the memo bytes differ each click.
      const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
      tx.add(new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [],
        data: Buffer.from(`tip:${Date.now()}:${Math.floor(Math.random() * 1e6)}`, 'utf8'),
      }));
      if (!(await confirmFundsAction({
        title: 'Confirm Tip',
        action: 'Deposit SOL tip to this cash table',
        amount: `${(lamports / 1e9).toFixed(6).replace(/\.?0+$/, '')} SOL`,
        table: tablePubkey,
        transaction: tx,
      }))) {
        return;
      }

      tx.feePayer = publicKey;
      tx.recentBlockhash = (await getLatestBlockhashClient(conn, 'confirmed')).blockhash;
      const sig = await sendWalletTx(tx, conn, { sendTransaction, signTransaction });
      const conf = await conn.confirmTransaction(sig, 'confirmed');
      if (conf.value.err) {
        const txInfo = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        const logs = (txInfo?.meta?.logMessages || []).join('\n');
        console.error('[depositTip] confirmed-err', conf.value.err, '\n', logs);
        throw new Error(`On-chain: ${JSON.stringify(conf.value.err)}`);
      }
      console.log('[depositTip] sig', sig);
      // Refresh TipJar PDA so the modal shows the new balance/hands immediately.
      try {
        const tjAcct = await conn.getAccountInfo(tipJarPda);
        if (tjAcct && tjAcct.data.length >= 67) {
          const tjd = Buffer.from(tjAcct.data);
          setTipJarBalance(Number(tjd.readBigUInt64LE(40)));
          setTipJarHands(tjd.readUInt16LE(48));
          setTipJarTotal(Number(tjd.readBigUInt64LE(50)));
        }
      } catch {}
      setStatus(`Tipped ${tipAmount} SOL (funds next 100 hands)!`);
      setShowTipModal(false);
    } catch (e: any) {
      console.error('[depositTip] failure', e);
      if (Array.isArray(e?.logs)) console.error('[depositTip] logs:\n' + e.logs.join('\n'));
      const msg = e?.message || 'Unknown error';
      // "already been processed" means a previous click landed; refresh state and treat as success.
      if (/already been processed/i.test(msg)) {
        try {
          const conn2 = makeL1Connection();
          const [tipJarPda2] = PublicKey.findProgramAddressSync(
            [Buffer.from('tip_jar'), new PublicKey(tablePubkey).toBuffer()],
            new PublicKey(ANCHOR_PROGRAM_ID),
          );
          const tjAcct = await conn2.getAccountInfo(tipJarPda2);
          if (tjAcct && tjAcct.data.length >= 67) {
            const tjd = Buffer.from(tjAcct.data);
            setTipJarBalance(Number(tjd.readBigUInt64LE(40)));
            setTipJarHands(tjd.readUInt16LE(48));
            setTipJarTotal(Number(tjd.readBigUInt64LE(50)));
          }
        } catch {}
        setStatus('Previous tip already landed. Refreshed.');
        setShowTipModal(false);
        return;
      }
      const clean = msg.length > 200 || /^[A-Za-z0-9+/=]{60,}/.test(msg)
        ? 'Transaction failed. See DevTools console for logs.'
        : msg.slice(0, 200);
      setStatus(`Tip failed: ${clean}`);
    } finally {
      setTipPending(false);
    }
  };

  // ─── Sit Out / Sit In ───

  const handleSitOut = useCallback(async () => {
    if (!gameState || gameState.mySeatIndex < 0) return;

    if (gameState.phase !== 'Waiting' && gameState.phase !== 'Complete') {
      setAutoPostBlinds(false);
      setStatus('Queued sit-out for next hand');
      return;
    }

    setSittingOutPending(true);
    sittingOutPendingRef.current = true;
    setStatus(null);
    try {
      await sendAction('sit_out');
      setStatus('Sitting out. You will skip the next hand.');
    } catch (e: any) {
      if (e.message?.includes('Session expired') || e.message?.includes('Reconnecting session') || e.message?.includes('InvalidSessionKey')) {
        setStatus('Session key mismatch. Retrying...');
        try {
          reloadSession();
          await sendAction('sit_out');
          setStatus('Sitting out. You will skip the next hand.');
        } catch {
          setStatus('Action failed. Try generating a new session key.');
        }
      } else {
        setStatus(getErrorMessage(e));
      }
    } finally {
      setSittingOutPending(false);
      sittingOutPendingRef.current = false;
    }
  }, [gameState, sendAction, reloadSession, setAutoPostBlinds]);

  // handleKickInactiveSeat REMOVED (cash-stranding mitigation). It built a
  // crank_remove_player IX that cleared the seat + minted an UnclaimedBalance
  // ticket but moved NO funds, stranding cash deposits in the vault. Inactive
  // seats are handled by the crank's crank_kick_inactive -> process_cashout_v2
  // path (which actually pays out). Do not re-add a player-facing kick.

  const handleSitIn = useCallback(async (postMissedBlinds: boolean = true) => {
    if (!gameState || gameState.mySeatIndex < 0) return;
    // SNG: a sitting-out player is still dealt + auto-folded every orbit (never
    // truly "out" — you can't leave a tournament), so returning just RESUMES
    // active play; it is not a fresh deal-in. Cash: a sat-out player IS skipped,
    // so "dealt in next hand" is accurate there.
    const isSng = gameState.isCashGame === false;
    const backInMsg = isSng ? "Back in! You'll play the next hand." : 'Back in! You will be dealt into the next hand';
    // sit_in only lands between hands (contract requires phase Waiting/Complete,
    // sit_out.rs:148). An SNG sit-out player is dealt + auto-folded every orbit,
    // so a mid-hand I'M BACK click would otherwise dead-end on HandInProgress.
    // Queue it and let the effect below auto-fire at the next hand boundary, so
    // returning is a single click with no manual waiting.
    if (gameState.phase !== 'Waiting' && gameState.phase !== 'Complete') {
      sitInQueuedRef.current = postMissedBlinds;
      setSittingOutPending(true);
      sittingOutPendingRef.current = true;
      setStatus(isSng ? "Returning. You'll play the next hand." : 'Returning. You will be dealt in next hand.');
      return;
    }
    setSittingOutPending(true);
    sittingOutPendingRef.current = true;
    // Set autoPostBlinds=true SYNCHRONOUSLY (before the await) so the
    // auto-sit-out effect at the bottom of this file can't fire during the
    // ~2s window between submit and confirmation. The contract briefly flips
    // isSittingOut=false mid-flight, which used to race the !autoPostBlinds
    // gate and re-submit sit_out, creating a NO/YES/NO/YES cycle.
    setAutoPostBlinds(true);
    setStatus(null);
    // Tracks a race-driven re-queue (see catch): if the hand advanced under us
    // between the phase read above and the TX landing, we re-arm the queued
    // sit-in rather than erroring — so the finally below must NOT wipe it.
    let requeued = false;
    try {
      // sendAction overloads `amount` as the post_missed_blinds boolean
      // for return_to_play (see useOnChainGame.ts:1586 -> amount !== 0).
      // Pass 1 = post BB now, 0 = wait for natural BB rotation.
      await sendAction('return_to_play', postMissedBlinds ? 1 : 0);
      sitInRetryRef.current = 0; // landed — clear the bounded-retry counter
      // Refresh state then try to start immediately — don't wait for next interval tick
      await refreshState();
      setStatus('Back in! Starting hand...');
      try {
        const res = await fetch('/api/cash-game/ready', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tablePda: tablePubkey }),
        });
        const data = await res.json();
        if (data.success) {
          setStatus(null);
          refreshState();
        } else {
          setStatus(backInMsg);
        }
      } catch {
        setStatus(backInMsg);
      }
    } catch (e: any) {
      if (e.message?.includes('Session expired') || e.message?.includes('Reconnecting session') || e.message?.includes('InvalidSessionKey')) {
        setStatus('Session key mismatch. Retrying...');
        try {
          reloadSession();
          await sendAction('return_to_play', postMissedBlinds ? 1 : 0);
          sitInRetryRef.current = 0; // landed — clear the bounded-retry counter
          await refreshState();
          setStatus('Back in! Starting hand...');
          try {
            const res = await fetch('/api/cash-game/ready', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tablePda: tablePubkey }),
            });
            const data = await res.json();
            if (data.success) {
              setStatus(null);
              refreshState();
            } else {
              setStatus(backInMsg);
            }
          } catch {
            setStatus(backInMsg);
          }
        } catch {
          setStatus('Action failed. Try generating a new session key.');
        }
      } else if (/InvalidActionForPhase|Custom\":6021|0x1785/i.test(String(e?.message ?? '')) && sitInRetryRef.current < 2) {
        // 6021 is returned both for the TRANSIENT race we want to recover from
        // (the hand advanced between our between-hands read and the TX landing,
        // common right after returning to a backgrounded tab) AND for DURABLE
        // conditions that never clear on their own this hand (waiting-for-BB
        // still behind the button, a never-played joiner posting missed blinds).
        // So retry at the next clean boundary a BOUNDED number of times, then
        // fall through to the real error. Without the cap this re-arm would spin
        // a gasless return_to_play TX loop, because the auto-fire effect re-runs
        // on every state refresh (and refreshState() below triggers one). Counter
        // resets on a successful return_to_play and when the cap is hit.
        sitInRetryRef.current += 1;
        requeued = true;
        sitInQueuedRef.current = postMissedBlinds;
        setStatus(isSng ? "Returning. You'll play the next hand." : 'Returning. You will be dealt in next hand.');
        void refreshState();
      } else {
        sitInRetryRef.current = 0; // give up the bounded retry; surface the real error
        setStatus(getErrorMessage(e));
      }
    } finally {
      // Preserve the "returning" pending state + queued flag across a race-driven
      // re-queue so the auto-fire retry can finish the return; otherwise clear.
      setSittingOutPending(requeued);
      sittingOutPendingRef.current = requeued;
      if (!requeued) sitInQueuedRef.current = null;
    }
  }, [gameState, sendAction, reloadSession]);

  // Auto-fire a queued sit-in the moment a hand finishes, so an SNG I'M BACK
  // click made mid-hand reactivates the player on the next hand with no manual
  // retry. Clears itself before firing to avoid re-entry.
  useEffect(() => {
    if (sitInQueuedRef.current === null) return;
    if (gameState && (gameState.phase === 'Waiting' || gameState.phase === 'Complete')) {
      const pmb = sitInQueuedRef.current;
      sitInQueuedRef.current = null;
      handleSitIn(pmb);
    }
  }, [gameState?.phase, handleSitIn]);

  // Auto sit-out when autoPostBlinds is toggled off (between hands).
  // Skip if a sit-in/sit-out is already in flight — otherwise the contract
  // mid-flight state flip (isSittingOut briefly false during return_to_play
  // confirmation) races this gate and causes an unintended sit_out submit.
  useEffect(() => {
    if (sittingOutPendingRef.current) return;
    if (!autoPostBlinds && gameState && gameState.mySeatIndex >= 0 && !isMeSittingOut) {
      const phase = gameState.phase;
      if (phase === 'Waiting' || phase === 'Complete') {
        handleSitOut();
      }
    }
  }, [autoPostBlinds, gameState?.phase, isMeSittingOut]);

  // claim_unclaimed_sol handler removed (disabled on-chain; recovery is admin-only).

  // ─── Derive display state (showdown hold overrides live state) ───
  // Inject the optimistic hero bet (set at action click) until the on-chain
  // seat catches up. Real data wins the moment it's >= the optimistic amount.
  const withOptimisticHeroBet = (state: typeof gameState) => {
    if (!state || !optimisticHeroBet) return state;
    const expired = optimisticHeroBet.hand !== state.handNumber || Date.now() - optimisticHeroBet.at > 6000;
    const me = state.players.find(p => p.seatIndex === state.mySeatIndex);
    const caughtUp = !!me && (me.bet || 0) >= optimisticHeroBet.amount;
    if (expired || caughtUp) {
      setTimeout(() => setOptimisticHeroBet(null), 0);
      return state;
    }
    return {
      ...state,
      players: state.players.map(p =>
        p.seatIndex === state.mySeatIndex && (p.bet || 0) < optimisticHeroBet.amount
          ? { ...p, bet: optimisticHeroBet.amount }
          : p,
      ),
    };
  };

  const displayState = (() => {
    if (!gameState) return null;
    if (!showdownHold || !showdownSnapshot) return withOptimisticHeroBet(gameState);
    if (gameState.handNumber > showdownSnapshot.handNumber) return gameState;

    // During showdown hold, override phase/pot/cards with snapshot
    // but merge revealed hole cards from live on-chain data
    const heldPlayers = showdownSnapshot.players.map((sp: any) => {
      // Try to get revealed hole cards from live data
      const liveP = gameState.players.find((lp: any) => lp.pubkey === sp.pubkey);
      if (liveP?.holeCards && liveP.holeCards[0] !== 255 && (!sp.holeCards || sp.holeCards[0] === 255)) {
        return { ...sp, holeCards: [...liveP.holeCards] };
      }
      return sp;
    });

    return {
      ...gameState,
      phase: 'Showdown' as const,
      pot: showdownPot || gameState.pot,
      communityCards: showdownSnapshot.communityCards,
      players: heldPlayers,
      myCards: showdownSnapshot.myCards || gameState.myCards,
    };
  })();

  // ─── Helpers ───
  const isSeated = gameState && gameState.mySeatIndex >= 0;
  // Only allow actions during betting phases (not RevealPending, Showdown, Complete, Waiting, Starting)
  const ACTIONABLE_PHASES = new Set(['PreFlop', 'Preflop', 'Flop', 'Turn', 'River']);
  const isActionablePhase = gameState ? ACTIONABLE_PHASES.has(gameState.phase) : false;
  // Use gameState (not displayState) for turn detection — showdown hold should not block actions.
  // Also guard against stale state: a table whose last hand ended on e.g. River
  // can leave phase + currentPlayer pointing at our seat momentarily after we
  // join an otherwise-empty table. Without an active-opponent check the bet
  // panel would render a phantom "CHECK" before the next hand has truly
  // started. Require at least one other live opponent before treating it as
  // our turn.
  // SNG: a sitting-out opponent is still dealt and in the hand (start_game.rs:884
  // includes SittingOut in the SNG active_mask), so they count as a live opponent.
  // If we excluded them, the active player's isMyTurn would go false and their
  // actions would be disabled — the HU stall when the lone opponent sits out.
  // Cash sit-out seats are never dealt, so keep excluding them there.
  const isSngTable = gameState?.isCashGame === false;
  const hasLiveOpponent = !!gameState && (gameState.players || []).some((p: { pubkey: string; isActive: boolean; folded: boolean; isSittingOut?: boolean }) =>
    p.pubkey
    && p.pubkey !== '11111111111111111111111111111111'
    && p.pubkey !== publicKey?.toBase58()
    && !p.folded
    && (p.isActive || (isSngTable && !!p.isSittingOut)),
  );
  const isMyTurn = gameState && isActionablePhase && gameState.mySeatIndex >= 0 && gameState.currentPlayer === gameState.mySeatIndex && hasLiveOpponent;
  const maxPlayers = gameState?.maxPlayers || 6;
  // kickCandidates / canKickBetweenHands REMOVED with the legacy player-facing
  // kick (cash-stranding mitigation). Inactive-seat removal is crank-only now.

  // Count empty seats for showing join prompt
  const occupiedSeats = new Set(gameState?.players?.map(p => p.seatIndex) || []);
  const emptySeats: number[] = [];
  for (let i = 0; i < maxPlayers; i++) {
    if (!occupiedSeats.has(i)) emptySeats.push(i);
  }

  // ─── Render ───

  // Table not found — show clear message instead of infinite loading
  if (gameError === 'TABLE_NOT_FOUND') {
    return (
      <div className="bg-ink text-white min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4 max-w-sm mx-auto px-4">
          <div className="w-16 h-16 mx-auto rounded-full bg-ink/80 border border-white/10 flex items-center justify-center">
            <svg className="w-8 h-8 text-boneDim/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-white">Table Not Found</h2>
          <p className="text-sm text-boneDim">This table has been closed or no longer exists. It may have finished while you were away.</p>
          <div className="flex gap-3 justify-center pt-2">
            <Link href="/lobby" className="px-4 py-2 rounded-lg text-sm font-medium bg-orange/15 border border-orange/25 text-orange hover:bg-orange/25 transition-colors">
              Back to Lobby
            </Link>
            <Link href="/my-tables" className="px-4 py-2 rounded-lg text-sm font-medium bg-ink/80 border border-white/10 text-gray-300 hover:bg-ink/60 transition-colors">
              My Tables
            </Link>
          </div>
          <p className="text-[10px] text-boneDim/60 font-mono pt-2">{tablePubkey.slice(0, 8)}...{tablePubkey.slice(-4)}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* On-device FP-DEBUG log (renders only when ?debug=1). Self-gated. */}
      <FpDebugOverlay />

      {/* Non-intrusive top-up progress: persists until the chips land on the felt. */}
      {topupPending && (
        <div className="fixed bottom-[52px] right-3 sm:right-6 z-40 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-orange/10 border border-orange/30 backdrop-blur-md text-[11px] text-orange">
          <span className="w-3 h-3 border-2 border-orange/30 border-t-orange rounded-full animate-spin" />
          Topping up… chips landing shortly
        </div>
      )}

      {/* Poor-connection indicator. gameConnected reflects whether on-chain/TEE
          fetches are currently succeeding: it drops to false only when polls are
          actually failing (real degradation) and self-clears on the next good
          fetch. We deliberately do NOT key this off wsActive — a spectator or a
          tunneled dev session never opens the realtime socket and runs fine on
          the poll fallback, so !wsActive would flag "degraded" forever. Only
          shown mid-hand so a between-hands table never false-flags. */}
      {(() => {
        const inHand = !!gameState && ['PreFlop', 'Flop', 'FlopRevealPending', 'Turn', 'TurnRevealPending', 'River', 'RiverRevealPending', 'Showdown'].includes(gameState.phase);
        if (gameConnected || !inHand) return null;
        return (
          <div className="fixed bottom-[88px] right-3 sm:right-6 z-40 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 backdrop-blur-md text-[11px] text-amber-300">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            Reconnecting… poor connection
          </div>
        );
      })()}

      {/* Hand-outcome safeguard recap: shown when a contested hand resolved
          without the live result being seen (lag / fast resolution). */}
      {handRecap && (
        <div
          className="fixed top-[68px] left-1/2 -translate-x-1/2 z-40 max-w-[92vw] rounded-lg border backdrop-blur-md px-3.5 py-2.5 shadow-[0_10px_40px_rgba(0,0,0,0.55)]"
          style={{
            borderColor: handRecap.heroWon ? 'rgba(16,185,129,0.40)' : 'rgba(244,63,94,0.35)',
            background: handRecap.heroWon ? 'rgba(16,185,129,0.10)' : 'rgba(244,63,94,0.08)',
          }}
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[9px] tracking-[0.18em] text-boneDim/60 uppercase">Hand #{handRecap.handNumber} result</div>
              {/* This recap only fires when the live table never showed the result
                  (a lag/disconnect gap), so explain why it's surfacing after the fact. */}
              <div className="font-mono text-[9px] leading-snug text-boneDim/45 mt-0.5 max-w-[260px]">
                We detected lag, so you may not have seen the outcome. Here was the result:
              </div>
              <div className={`font-display text-sm leading-none mt-1 ${handRecap.heroWon ? 'text-emerald-300' : 'text-rose-300'}`}>
                {handRecap.heroDelta === 0
                  ? 'Hand settled'
                  : handRecap.isSng
                    // SNG stacks are virtual tournament chips (raw integers), NOT
                    // token base units — don't divide by decimals or label SOL.
                    ? `${handRecap.heroWon ? 'You won ' : 'You lost '}${Math.abs(handRecap.heroDelta).toLocaleString()} chips`
                    : `${handRecap.heroWon ? 'You won ' : 'You lost '}${fmtTokenAmount(Math.abs(handRecap.heroDelta), 9)} ${getTokenSymbol(tokenMint)}`}
              </div>
              <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                {handRecap.loading && handRecap.board.length === 0 && !handRecap.endAction ? (
                  <span className="font-mono text-[10px] text-boneDim/50">loading…</span>
                ) : (
                  <>
                    {handRecap.board.map((c, i) => {
                      const s = c.slice(-1).toLowerCase();
                      const rank = c.slice(0, -1).toUpperCase().replace('T', '10');
                      const sym = s === 'h' ? '♥' : s === 'd' ? '♦' : s === 'c' ? '♣' : '♠';
                      const red = s === 'h' || s === 'd';
                      return (
                        <span key={i} className="inline-flex items-center px-1 py-[1px] rounded-sm bg-bone/90 text-[11px] font-bold tabular-nums" style={{ color: red ? '#C0392B' : '#111' }}>
                          {rank}{sym}
                        </span>
                      );
                    })}
                    {handRecap.endAction ? (
                      // How the hand ended (the deciding fold) on its own line under
                      // the board — for a preflop fold-win there is no board, so this
                      // line is the whole story.
                      <span className="font-mono text-[10px] text-boneDim/55 w-full mt-0.5">{handRecap.endAction}</span>
                    ) : handRecap.board.length === 0 && handRecap.heroAllIn ? (
                      // All-in that ran out but whose board the record didn't capture.
                      // NEVER say "no community cards dealt" here — the board WAS dealt.
                      <span className="font-mono text-[10px] text-boneDim/55 w-full mt-0.5">all-in — went to showdown</span>
                    ) : null}
                  </>
                )}
              </div>
            </div>
            <button
              onClick={() => setHandRecap(null)}
              className="shrink-0 self-start text-boneDim/50 hover:text-bone text-base leading-none -mt-0.5"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Re-show last hand: the recap auto-dismisses, so leave a subtle pill that
          brings the board + result (and how it ended) back on click. Hidden while
          the full card is up. */}
      {!handRecap && lastHandRecap && (
        <button
          onClick={() => setHandRecap(lastHandRecap)}
          className="fixed top-[68px] left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ink/70 border border-bone/15 backdrop-blur-md text-[10px] text-boneDim/70 hover:text-bone hover:border-bone/30 transition"
          aria-label={`Re-show hand ${lastHandRecap.handNumber} result`}
        >
          <span className="text-[11px] leading-none">↻</span>
          Hand #{lastHandRecap.handNumber}
        </button>
      )}

      {/* LEGACY KICK BUTTON REMOVED (cash-stranding mitigation).
          The player-facing "Kick inactive seat" alert built a crank_remove_player
          IX that clears the seat + mints an UnclaimedBalance ticket but moves NO
          funds — stranding the player's cash deposit in the vault, with no
          reachable self-claim while the table is delegated. Inactive seats are
          handled by the crank's crank_kick_inactive -> process_cashout_v2 path,
          which actually pays the player out. Do not re-add a player-facing kick. */}

      {/* UNCLAIMED-SOL CLAIM BANNER REMOVED (cash-stranding fix).
          claim_unclaimed_sol is disabled on-chain (UnclaimedClaimDisabled 6175), and
          the displayed amount was read straight from the inflated UnclaimedBalance
          ticket — so this showed a wrong number plus a Claim that now reverts.
          Stranded cash is returned via reviewed admin recovery (shows as RECOVERY in
          My Funds), not self-claim. Do not re-add. */}

      {gameState && isSeated && !session.isActive && !sessionClaimRequired && (
        <div className="fixed bottom-[46px] left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 backdrop-blur-md">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
          <span className="text-amber-300 text-[11px]">No session key on this device.</span>
          <button
            onClick={() => session.status === 'no_session' && createSession().catch(() => {})}
            className="px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 whitespace-nowrap"
          >
            Generate
          </button>
        </div>
      )}

      {pendingJoinSeat !== null && !isSeated && (() => {
        // The contract timelocks refund_failed_deposit for 180s after the
        // deposit; the crank auto-refunds right after. Show the countdown and
        // hold the button until it can actually succeed.
        const REFUND_TIMELOCK_MS = 180_000;
        const waitMs = pendingDepositAt !== null
          ? (pendingDepositAt * 1000 + REFUND_TIMELOCK_MS) - refundNowTick
          : null;
        const refundLocked = waitMs !== null && waitMs > 0;
        const mmss = refundLocked
          ? `${Math.floor(waitMs / 60000)}:${String(Math.floor((waitMs % 60000) / 1000)).padStart(2, '0')}`
          : null;
        return (
        <div className="fixed top-[64px] left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-3 py-1.5 rounded-lg bg-orange/10 border border-orange/30 backdrop-blur-md max-w-[92vw]">
          <span className="w-1.5 h-1.5 rounded-full bg-orange animate-pulse shrink-0" />
          <span className="text-orange/90 text-[11px]">
            Pending deposit on seat {pendingJoinSeat + 1}.
            {refundLocked && <span className="text-orange/60"> Auto-refunds in {mmss} if unused.</span>}
          </span>
          <button
            onClick={() => finishPendingSeat(pendingJoinSeat)}
            disabled={joiningSeat === pendingJoinSeat || cancelPendingSeat === pendingJoinSeat}
            className="px-2 py-0.5 rounded text-[10px] font-bold bg-orange/20 border border-orange/40 text-orange hover:bg-orange/30 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {joiningSeat === pendingJoinSeat ? 'Seating…' : 'Take seat'}
          </button>
          <button
            onClick={() => cancelPendingDeposit(pendingJoinSeat)}
            disabled={refundLocked || cancelPendingSeat === pendingJoinSeat || joiningSeat === pendingJoinSeat}
            className="px-2 py-0.5 rounded text-[10px] font-medium bg-rose-500/15 border border-rose-500/35 text-rose-300 hover:bg-rose-500/25 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            title={refundLocked
              ? `Refunds unlock ${mmss} from now (on-chain timelock). It auto-refunds then even if you close this page.`
              : 'Refund the deposit and free the seat'}
          >
            {cancelPendingSeat === pendingJoinSeat ? 'Refunding…' : refundLocked ? `Refund in ${mmss}` : 'Cancel & refund'}
          </button>
        </div>
        );
      })()}

      {/* Loading / Not found — full viewport, no max-w clamp */}
      {gameLoading && !gameState ? (
        <div className="min-h-[calc(100vh-56px)] [@media(max-height:500px)_and_(orientation:landscape)]:min-h-[100dvh] flex items-center justify-center bg-ink text-white">
          <div className="text-center">
            <div className="w-10 h-10 border-2 border-orange/30 border-t-orange rounded-full animate-spin mx-auto mb-5" />
            <h3 className="text-lg font-bold text-white mb-2">Loading Table...</h3>
            <p className="text-boneDim/70 text-sm">Connecting to on-chain game state</p>
          </div>
        </div>
      ) : !gameState ? (
        <div className="min-h-[calc(100vh-56px)] [@media(max-height:500px)_and_(orientation:landscape)]:min-h-[100dvh] flex items-center justify-center bg-ink text-white">
          <div className="text-center">
            <h3 className="text-lg font-bold text-white mb-2">Table Not Found</h3>
            <p className="text-boneDim/70 text-sm mb-4">This table may not exist or may have been closed.</p>
            <Link href="/my-tables" className="px-5 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-300 text-sm hover:bg-white/[0.08] transition-colors">
              Back to Tables
            </Link>
          </div>
        </div>
      ) : (
        <>
          <PokerTable
              tablePda={tablePubkey}
              phase={displayState!.phase}
              pot={displayState!.pot}
              currentPlayer={displayState!.currentPlayer}
              communityCards={displayState!.communityCards}
              players={displayState!.players}
              myCards={displayState!.myCards}
              linkedSigners={linkedSigners}
              shownCards={showCards.shows}
              onShowCards={showCards.reveal}
              revealedThisHand={showCards.revealedThisHand}
              onAction={isSeated ? handleGameAction : undefined}
              onDuelAction={sendDuelAction}
              bountyTeeConnection={activeConnection}
              isMyTurn={!!isMyTurn}
              sessionClaimRequired={sessionClaimRequired}
              sessionClaimDebug={claimDebug}
              onClaimSeatSession={handleClaimSeatSession}
              blinds={displayState!.blinds}
              dealerSeat={displayState!.dealerSeat}
              maxSeats={displayState!.maxPlayers}
              handHistory={handHistory}
              pastHands={pastHands}
              viewingPastHand={viewingPastHand}
              onHandNav={setViewingPastHand}
              actionPending={actionPending}
              showdownPot={showdownPot}
              showdownPayouts={showdownPayouts}
              maxPlayers={gameState.maxPlayers}
              lastActionSlot={gameState.lastActionSlot}
              playerActions={playerActions}
              currentBet={displayState!.currentBet}
              tokenMint={gameState.tokenMint}
              tokenDecimals={tokenDecimals}
              isCashGame={gameState?.isCashGame ?? true}
              pendingJoinSeat={pendingJoinSeat}
              reservedJoinSeat={reservedJoinSeat}
              selectedJoinSeat={selectedJoinSeat}
              reservedJoinSeats={reservedJoinSeats}
              debugClearingSeats={clearingJoinSeats}
              joiningSeat={joiningSeat}
              handNumber={gameState.handNumber}
              tier={gameState.tier}
              prizePool={gameState.prizePool}
              currentPlayers={gameState.currentPlayers}
              seatsOccupied={gameState.seatsOccupied}
              eliminatedSeats={gameState.eliminatedSeats}
              eliminatedCount={gameState.eliminatedCount}
              isMaintenance={gameState.isMaintenance}
              verifyUrl={lastVerifyUrl}
              // if not seated, open buyin modal safely. if seated, we can hook up direct top-up!
              onSeatClick={(() => {
                const isCash = gameState?.isCashGame !== false;
                const isWaiting = gameState?.phase === 'Waiting';
                if (!isCash && !isWaiting) return undefined;
                return (seatIndex: number) => {
                  if (!connected) return;
                  if (!isSeated) {
                    isCash ? openBuyInModal(seatIndex) : handleSngSeatClick(seatIndex);
                    return;
                  }
                  if (gameState.mySeatIndex === seatIndex) {
                    if (gameState.mySeatIndex >= 0) {
                      setBuyInModal({ seatIndex: gameState.mySeatIndex, mode: 'topup' });
                    }
                  }
                };
              })()}
              blindDeadline={gameState.blindDeadline}
              blindsPosted={gameState.blindsPosted}
              blindLevel={gameState.blindLevel}
              tournamentStartTime={gameState.tournamentStartTime}
              isMeSittingOut={isMeSittingOut}
              autoPostBlinds={autoPostBlinds}
              setAutoPostBlinds={setAutoPostBlinds}
              onSitOut={handleSitOut}
              onSitIn={handleSitIn}
              sittingOutPending={sittingOutPending}
              onOpenTipJar={() => setShowTipModal(true)}
              tipJarBalance={tipJarBalance}
              tipJarHands={tipJarHands}
              onShareTable={() => setShowShareModal(true)}
              rakeBps={500}
              rakeCap={rakeCap}
              onLeaveTable={isSeated && (gameState?.isCashGame !== false || gameState?.phase === 'Waiting') ? handleLeaveTable : undefined}
              leavingTable={leavingTable}
              onOpenTopUp={() => {
                if (gameState?.mySeatIndex != null && gameState.mySeatIndex >= 0) {
                  setBuyInModal({ seatIndex: gameState.mySeatIndex, mode: 'topup' });
                }
              }}
            />

            {/* Jackpot ceremony — fires when a Mini/Grand jackpot lands on this table. */}
            <JackpotCeremonyOverlay tablePda={tablePubkey} />

            {/* Status messages — floating toast, never pushes table */}
            {(status || gameError) && (() => {
              const msg = status || gameError || '';
              if (msg && msg === bannerClosed) return null; // user dismissed this exact message
              const isPositive = !gameError && (
                msg.includes('!') || msg.startsWith('Sitting out') || msg.startsWith('Back in')
                || msg.startsWith('Leaving') || msg.startsWith('Seated') || msg.startsWith('Session e')
                || msg.startsWith('Depositing') || msg.startsWith('Seating') || msg.startsWith('Requesting')
                || msg.startsWith('Joining') || msg.startsWith('Cleaning')
              );
              return (
                <div className={`fixed bottom-[52px] left-3 sm:left-6 z-40 max-w-[calc(100vw-1.5rem)] sm:max-w-sm text-xs pl-3 pr-1.5 py-2 rounded-lg backdrop-blur-md border flex items-start gap-2 ${
                  isPositive ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-red-500/15 text-rose-300 border-red-500/30'
                }`}>
                  <span className="min-w-0">{msg}</span>
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => { setStatus(null); setBannerClosed(msg); }}
                    className={`shrink-0 -mt-0.5 text-base leading-none opacity-60 hover:opacity-100 transition-opacity ${
                      isPositive ? 'text-emerald-200' : 'text-rose-200'
                    }`}
                  >
                    ×
                  </button>
                </div>
              );
            })()}
          </>
        )}

        {/* Buy-in Modal — Mockup 1.4 cinematic. Shared with top-up flow:
            when buyInModal.mode === 'topup', the same chrome renders with
            different copy and a capped max (remaining stack room). */}
        {buyInModal && gameState && typeof document !== 'undefined' && (() => {
          const isTopup = buyInModal.mode === 'topup';
          const tokenLabel = getTokenSymbol(tokenMint);
          const sbDisp = fmtTokenAmount(gameState.blinds.small, 4);
          const bbDisp = fmtTokenAmount(gameState.blinds.big, 4);
          const currentBBs = isTopup ? Math.floor((myPlayer?.chips || 0) / (gameState.blinds.big || 1)) : 0;
          const topupMaxBB = Math.max(buyInMin, buyInMax - currentBBs);
          // Cap the buy-in slider to what the wallet can actually pay.
          // SOL table: use solBalance lamports. SPL: gated separately
          // (pokerBalance only covers $FP; other mints fall back to the
          // table-rule max and rely on sim+InsufficientFundsModal at submit
          // time until the SPL pre-flight check lands).
          const isSolTableUI = tokenMint === PublicKey.default.toBase58();
          const bigBlindLamports = gameState.blinds.big || 1;
          const overheadReserve = FUNDS_HINTS.SIT_OVERHEAD_LAMPORTS;
          // walletBalances.solBalance is in SOL (the indexer returns lamports/1e9),
          // so convert to lamports before the lamport-based affordability math.
          // Without this, SOL was subtracted as if it were lamports and the modal
          // always clamped to 0 -> "insufficient funds" on every cash buy-in.
          const walletLamports = Math.floor(walletBalances.solBalance * 1e9);
          const affordableLamports = Math.max(0, walletLamports - overheadReserve);
          const minBB = isTopup
            ? buyInMin
            : (ratholeLock
                ? Math.max(buyInMin, Math.ceil((Math.max(ratholeLock.chipsAtLeave, bigBlindLamports * buyInMin) + ratholeLock.kickPenalty) / bigBlindLamports))
                : buyInMin);
          const allowedMaxBB = isTopup ? topupMaxBB : Math.max(buyInMax, minBB);
          const affordableMaxBB = isSolTableUI
            ? Math.max(0, Math.floor(affordableLamports / bigBlindLamports))
            : allowedMaxBB;
          const effectiveMaxBB = Math.max(minBB, Math.min(allowedMaxBB, affordableMaxBB || allowedMaxBB));
          const cantAfford = isSolTableUI && affordableMaxBB < minBB && !walletBalances.loading;
          const activeBBs = isTopup ? topupBBs : buyInBBs;
          const setActiveBBs = isTopup ? setTopupBBs : setBuyInBBs;
          const depositStr = fmtTokenAmount(gameState.blinds.big * activeBBs, 9);
          const pct = effectiveMaxBB > minBB
            ? Math.min(100, Math.max(0, ((activeBBs - minBB) / (effectiveMaxBB - minBB)) * 100))
            : 0;
          // Live seat-availability watchdog. Re-runs every parent render, so
          // when gameState.players or reservedJoinSeats changes (someone else
          // grabbed the seat between us opening the modal and pressing
          // CONFIRM), we surface it instead of letting the TX fail on chain.
          const maxSeatsLive = gameState.maxPlayers || 9;
          const occupiedSeats = new Set<number>(
            (gameState.players ?? [])
              .map((p: any) => p.seatIndex as number)
              .filter((s) => typeof s === 'number' && s >= 0),
          );
          const othersReserved = new Set<number>(
            reservedJoinSeats.filter((s) => s !== buyInModal.seatIndex),
          );
          const seatTaken =
            occupiedSeats.has(buyInModal.seatIndex) ||
            othersReserved.has(buyInModal.seatIndex) ||
            clearingJoinSeats.includes(buyInModal.seatIndex);
          let nextOpenSeat: number | null = null;
          if (seatTaken) {
            for (let i = 0; i < maxSeatsLive; i++) {
              if (!occupiedSeats.has(i) && !othersReserved.has(i) && !clearingJoinSeats.includes(i)) {
                nextOpenSeat = i;
                break;
              }
            }
          }
          const noSeatsLeft = seatTaken && nextOpenSeat === null;
          const switchToNextOpen = () => {
            if (nextOpenSeat == null) return;
            SFX.play('ui-tap');
            setBuyInModal({ seatIndex: nextOpenSeat });
            setSelectedJoinSeat(nextOpenSeat);
          };
          const close = () => {
            if (!buyInLoading) {
              SFX.play('modal-close');
              setBuyInModal(null);
              setSelectedJoinSeat(null);
            }
          };

          return createPortal(
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 overflow-hidden" role="dialog" aria-modal="true" aria-label="Buy In">
              <div
                className="absolute inset-0"
                style={{
                  background:
                    'radial-gradient(ellipse at 50% 35%, rgba(242,106,31,0.18), rgba(7,9,11,0.94) 55%, #07090B)',
                  backdropFilter: 'blur(14px)',
                  WebkitBackdropFilter: 'blur(14px)',
                }}
                onClick={close}
              />

              <div className="relative w-[520px] max-w-[calc(100vw-16px)] sm:max-w-[calc(100vw-24px)] fade-in max-h-[92vh] overflow-y-auto">
                <div className="glass-room overflow-hidden rounded-xl hairline shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
                  {/* Tier ribbon */}
                  <div className="h-[2px] w-full" style={{ background: 'linear-gradient(90deg, transparent, #F26A1F, transparent)' }} />

                  {/* Header */}
                  <div className="px-4 md:px-5 pt-3 md:pt-4 pb-3 flex items-start justify-between gap-3 hairline-b">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="h-px w-6 bg-orange/60" />
                        <span className="font-mono text-[9px] tracking-[0.4em] text-orange/90 leading-none">{isTopup ? 'YOUR SEAT' : 'CASH TABLE'}</span>
                        <span className="font-mono text-[9px] tracking-[0.3em] text-boneDim/40 leading-none">·</span>
                        <span className="font-mono text-[9px] tracking-[0.3em] text-boneDim/70 leading-none">SEAT {buyInModal.seatIndex + 1}</span>
                      </div>
                      <h2 className="font-display text-bone text-[22px] md:text-[28px] leading-none tracking-normal sm:tracking-wide mt-1.5">{isTopup ? 'ADD CHIPS' : 'BUY IN'}</h2>
                      <p className="font-mono text-[10px] text-boneDim/60 tracking-wider mt-1">
                        BLINDS {sbDisp}/{bbDisp} {tokenLabel}
                        <span className="text-boneDim/30 mx-1.5">·</span>
                        {isTopup
                          ? `${currentBBs} BB stack · UP TO ${effectiveMaxBB} BB MORE`
                          : `${buyInType === 1 ? 'DEEP STACK' : 'STANDARD'} · ${buyInMin}–${buyInMax} BB`}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={close}
                      disabled={buyInLoading}
                      className="shrink-0 w-8 h-8 rounded-md hairline text-boneDim hover:text-bone hover:bg-orange/10 transition-colors flex items-center justify-center disabled:opacity-30"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <path d="M3 3l8 8M11 3l-8 8" />
                      </svg>
                    </button>
                  </div>

                  {/* Seat-taken / seats-full live banner (join mode only — your own seat in topup mode is by definition not taken) */}
                  {!isTopup && seatTaken && (
                    <div className="px-5 py-2.5 hairline-b flex items-center gap-3" style={{ background: noSeatsLeft ? 'rgba(239,68,68,0.08)' : 'rgba(242,106,31,0.08)' }}>
                      <div className="w-1 h-8 rounded-full" style={{ background: noSeatsLeft ? '#EF4444' : '#F26A1F' }} />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-[9px] tracking-[0.3em] leading-none" style={{ color: noSeatsLeft ? '#FCA5A5' : '#F26A1F' }}>
                          {noSeatsLeft ? 'TABLE IS FULL' : 'SEAT JUST TAKEN'}
                        </div>
                        <div className="font-mono text-[10px] text-boneDim/80 tracking-wider mt-1 leading-tight">
                          {noSeatsLeft
                            ? <>Every seat was claimed while you were buying in. <span className="text-boneDim/60">Try another table.</span></>
                            : <>Seat <span className="text-bone tabular-nums">{buyInModal.seatIndex + 1}</span> is no longer available. Seat <span className="text-orange tabular-nums">{(nextOpenSeat ?? 0) + 1}</span> is still open.</>}
                        </div>
                      </div>
                      {!noSeatsLeft && nextOpenSeat != null && (
                        <button
                          type="button"
                          onClick={switchToNextOpen}
                          disabled={buyInLoading}
                          className="shrink-0 px-3 py-2 rounded-sm border border-orange/50 bg-orange/15 hover:bg-orange/25 hover:border-orange font-mono text-[10px] tracking-[0.18em] text-orange transition disabled:opacity-40"
                        >
                          SWITCH TO SEAT {nextOpenSeat + 1}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Rathole notice */}
                  {ratholeLock && (
                    <div className="px-5 py-2.5 hairline-b flex items-center gap-3" style={{ background: 'rgba(242,195,106,0.06)' }}>
                      <div className="w-1 h-8 rounded-full" style={{ background: '#F2C36A' }} />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-[9px] tracking-[0.3em] text-amber/90 leading-none">RATHOLE LOCK</div>
                        <div className="font-mono text-[10px] text-boneDim/80 tracking-wider mt-1 leading-tight">
                          Must buy in with at least <span className="text-amber tabular-nums">{fmtTokenAmount(minBB * gameState.blinds.big, 9)} {tokenLabel}</span>
                          <span className="text-boneDim/40 mx-1">·</span>
                          expires {ratholeLock.minutesLeft < 60 ? `${ratholeLock.minutesLeft}m` : `${(ratholeLock.minutesLeft / 60).toFixed(1)}h`}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Hero amount — hidden on landscape mobile to save vertical space */}
                  <div className="px-4 md:px-5 py-4 md:py-5 text-center relative overflow-hidden [@media(max-height:500px)_and_(orientation:landscape)]:hidden">
                    <div
                      className="absolute inset-0 pointer-events-none"
                      style={{ background: 'radial-gradient(ellipse at 50% 60%, rgba(242,106,31,0.08), transparent 70%)' }}
                    />
                    <div className="relative">
                      <div className="font-mono text-[9px] tracking-[0.4em] text-boneDim/50 leading-none">DEPOSIT</div>
                      <div className="mt-2 font-display text-bone tabular-nums leading-none text-[36px] md:text-[52px]"
                        style={{ textShadow: '0 0 30px rgba(242,106,31,0.25)' }}
                      >
                        {depositStr}
                      </div>
                      <div className="mt-1.5 inline-flex items-center gap-1.5">
                        <span className="font-mono text-[10px] tracking-[0.3em] text-orange/90">{tokenLabel}</span>
                        <span className="text-boneDim/30 text-[10px]">·</span>
                        <span className="font-mono text-[10px] tracking-[0.2em] text-boneDim/70 tabular-nums">
                          {activeBBs} BB{!isTopup && buyInType === 1 ? ' · DEEP' : ''}{isTopup ? ' · TOP-UP' : ''}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Slider */}
                  <div className="px-4 md:px-5 pb-4">
                    <div className="flex items-center justify-between font-mono text-[9px] tracking-[0.25em] text-boneDim/55 mb-1.5">
                      <span>MIN · {minBB} BB</span>
                      <span>MAX · {effectiveMaxBB} BB</span>
                    </div>
                    {/* Custom visual track — inline-styled, matches SNG buy-in slider */}
                    <div id="buyin-slider-row" className="flex items-center gap-3" style={{ marginBottom: 8 }}>
                      <div id="buyin-slider-track" style={{ position: 'relative', height: 28, flex: 1 }}>
                        {/* Rail */}
                        <div style={{ position: 'absolute', top: 9, left: 0, right: 0, height: 10, borderRadius: 9999, background: 'rgba(245,241,230,0.13)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.45)' }} />
                        {/* Striped unfilled right */}
                        {pct < 100 && (
                          <div aria-hidden style={{ position: 'absolute', top: 9, left: `${pct}%`, right: 0, height: 10, borderRadius: '0 9999px 9999px 0', background: 'repeating-linear-gradient(45deg, rgba(245,241,230,0.10) 0px, rgba(245,241,230,0.10) 2px, transparent 2px, transparent 6px)', pointerEvents: 'none' }} />
                        )}
                        {/* Orange fill */}
                        <div style={{ position: 'absolute', top: 9, left: 0, width: `${pct}%`, height: 10, borderRadius: '9999px 0 0 9999px', background: '#F26A1F', boxShadow: '0 0 8px rgba(242,106,31,0.55)', transition: 'width 0.1s ease' }} />
                        {/* Coin thumb */}
                        <div style={{ position: 'absolute', top: 3, left: `calc(${pct}% - ${(pct * 0.22).toFixed(2)}px)`, width: 22, height: 22, borderRadius: '50%', background: '#F26A1F', border: '2px solid rgba(245,241,230,0.95)', boxShadow: '0 0 0 1.5px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4), 0 0 14px rgba(242,106,31,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'left 0.1s ease', zIndex: 1 }}>
                          <div style={{ display: 'flex', gap: 2, pointerEvents: 'none' }}>
                            <div style={{ width: 1, height: 7, borderRadius: 9999, background: 'rgba(245,241,230,0.9)' }} />
                            <div style={{ width: 1, height: 7, borderRadius: 9999, background: 'rgba(245,241,230,0.9)' }} />
                            <div style={{ width: 1, height: 7, borderRadius: 9999, background: 'rgba(245,241,230,0.9)' }} />
                          </div>
                        </div>
                        {/* Native input — transparent interaction layer on top */}
                        <input
                          type="range"
                          min={minBB}
                          max={effectiveMaxBB}
                          step={5}
                          value={activeBBs}
                          onChange={e => { setActiveBBs(Number(e.target.value)); SFX.play('ui-slider'); }}
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'grab', zIndex: 2, margin: 0 }}
                        />
                      </div>
                      {/* Landscape mobile inline value — replaces the hidden hero amount */}
                      <div id="buyin-slider-inline-value" className="hidden [@media(max-height:500px)_and_(orientation:landscape)]:flex flex-col items-end shrink-0 min-w-[72px]">
                        <span className="font-display text-bone tabular-nums leading-none text-[22px]" style={{ textShadow: '0 0 20px rgba(242,106,31,0.25)' }}>{depositStr}</span>
                        <span className="font-mono text-[9px] tracking-[0.2em] text-orange/90 tabular-nums mt-0.5">{tokenLabel}</span>
                        <span className="font-mono text-[9px] tracking-[0.2em] text-boneDim/60 tabular-nums">{activeBBs} BB</span>
                      </div>
                    </div>{/* end buyin-slider-row */}

                    {/* Quick picks (cap to effectiveMaxBB so topup picks never exceed remaining stack room) */}
                    <div className="grid grid-cols-4 gap-1.5 mt-3">
                      {buyInQuickPicks.filter(bb => bb <= effectiveMaxBB).map(bb => {
                        const active = activeBBs === bb;
                        return (
                          <button
                            key={bb}
                            type="button"
                            onClick={() => { SFX.play('ui-tap'); setActiveBBs(bb); }}
                            className={
                              'px-2 py-2 rounded-sm border font-mono text-[10px] tracking-[0.2em] tabular-nums transition ' +
                              (active
                                ? 'border-orange/60 bg-orange/15 text-bone'
                                : 'border-bone/15 text-boneDim hover:border-bone/30 hover:text-bone')
                            }
                          >
                            {bb} BB
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="px-4 md:px-5 py-3 hairline-t flex items-center gap-2">
                    <button
                      type="button"
                      onClick={close}
                      disabled={buyInLoading}
                      className="px-3 md:px-4 py-2.5 rounded-sm border border-bone/15 hover:border-bone/30 font-mono text-[11px] tracking-[0.22em] text-boneDim hover:text-bone transition disabled:opacity-30"
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      onClick={() => { if (isTopup) { handleTopup(); setBuyInModal(null); } else { confirmBuyIn(); } }}
                      disabled={(isTopup ? topupLoading : buyInLoading) || (!isTopup && seatTaken) || (!isTopup && cantAfford)}
                      className="flex-1 min-w-0 btn-orange px-2 md:px-5 py-2.5 rounded-sm font-mono text-[10px] md:text-[11px] tracking-[0.16em] md:tracking-[0.24em] font-bold disabled:opacity-60 inline-flex items-center justify-center gap-1.5 md:gap-2 flex-wrap"
                    >
                      {(isTopup ? topupLoading : buyInLoading) ? (
                        <>
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-bone animate-pulse" />
                          {isTopup ? 'ADDING…' : 'CONFIRMING…'}
                        </>
                      ) : !isTopup && seatTaken ? (
                        <span className="whitespace-nowrap">{noSeatsLeft ? 'TABLE FULL' : 'SEAT TAKEN'}</span>
                      ) : !isTopup && cantAfford ? (
                        <span className="whitespace-nowrap">INSUFFICIENT SOL</span>
                      ) : (
                        <>
                          <span className="whitespace-nowrap">{isTopup ? 'ADD CHIPS' : 'CONFIRM'}</span>
                          <span className="text-bone/80 tabular-nums whitespace-nowrap">{depositStr} {tokenLabel}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          );
        })()}

        {/* Top-Up Modal (Add Chips while seated) */}
        {topupModal && gameState && isSeated && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 backdrop-blur-sm" onClick={() => !topupLoading && setTopupModal(false)}>
            <div className="bg-ink border border-emerald-500/20 rounded-2xl p-6 w-full max-w-sm space-y-4 shadow-2xl" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-white">Add Chips</h3>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-boneDim/70">
                  <span className="inline-flex items-center gap-1">Current: {fmtTokenAmount(myPlayer?.chips || 0, 9)} {tokenLogoSrc && <img src={tokenLogoSrc} alt={getTokenSymbol(tokenMint)} width={10} height={10} className="rounded-full opacity-90" />}{getTokenSymbol(tokenMint)}</span>
                  <span>Max {buyInMax} BB total</span>
                </div>
                {/* Reserve indicator */}
                {(myPlayer?.vaultReserve || 0) > 0 && (
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/20">
                    <span className="text-[10px] text-amber-400 inline-flex items-center gap-1">Reserve: {fmtTokenAmount(myPlayer?.vaultReserve || 0, 9)} {tokenLogoSrc && <img src={tokenLogoSrc} alt={getTokenSymbol(tokenMint)} width={10} height={10} className="rounded-full opacity-90" />}{getTokenSymbol(tokenMint)} ({Math.floor((myPlayer?.vaultReserve || 0) / (gameState.blinds.big || 1))} BB)</span>
                    <span className="text-[9px] text-amber-600">Converts to chips between hands</span>
                  </div>
                )}

                {/* Top-up amount slider */}
                <div className="space-y-1">
                  <label className="text-xs text-boneDim">Top-up amount (Big Blinds)</label>
                  <input
                    type="range"
                    min={buyInMin}
                    max={(() => {
                      const currentBBs = Math.floor((myPlayer?.chips || 0) / (gameState.blinds.big || 1));
                      return Math.max(buyInMin, buyInMax - currentBBs);
                    })()}
                    step={1}
                    value={topupBBs}
                    onChange={e => setTopupBBs(Number(e.target.value))}
                    className="w-full accent-emerald-500"
                  />
                  <div className="flex justify-between text-xs text-boneDim/60">
                    <span>{buyInMin} BB</span>
                    <span className="text-emerald-400 font-bold">{topupBBs} BB</span>
                    <span>{(() => { const currentBBs = Math.floor((myPlayer?.chips || 0) / (gameState.blinds.big || 1)); return Math.max(buyInMin, buyInMax - currentBBs); })()} BB</span>
                  </div>
                </div>

                {/* Quick select */}
                <div className="flex gap-2 justify-center">
                  {[20, 50, 80].map(bb => (
                    <button
                      key={bb}
                      onClick={() => setTopupBBs(Math.min(bb, (() => { const c = Math.floor((myPlayer?.chips || 0) / (gameState.blinds.big || 1)); return Math.max(buyInMin, buyInMax - c); })()))}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        topupBBs === bb
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : 'bg-white/[0.04] text-boneDim/70 border border-white/[0.06] hover:bg-white/[0.08]'
                      }`}
                    >
                      {bb} BB
                    </button>
                  ))}
                </div>

                {/* Token amount display */}
                <div className="text-center py-2">
                  <div className="text-2xl font-bold text-white tabular-nums">
                    {fmtTokenAmount(gameState.blinds.big * topupBBs, 9)}
                  </div>
                  <div className="text-xs text-boneDim/70 inline-flex items-center gap-1 justify-center">{tokenLogoSrc && <img src={tokenLogoSrc} alt={getTokenSymbol(tokenMint)} width={11} height={11} className="rounded-full opacity-90" />}{getTokenSymbol(tokenMint)} to add</div>
                </div>

                {/* Info note */}
                <div className="text-[10px] text-boneDim/60 text-center">
                  Chips are added between hands. If a hand is in progress, they&apos;ll be available next hand.
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setTopupModal(false)}
                  disabled={topupLoading}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-boneDim text-sm font-bold hover:bg-white/[0.08] transition-colors disabled:opacity-30"
                >
                  Cancel
                </button>
                <button
                  onClick={handleTopup}
                  disabled={topupLoading}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-orange hover:from-emerald-400 hover:to-orange text-ink text-sm font-bold transition-all disabled:opacity-50"
                >
                  {topupLoading ? 'Adding...' : 'Add Chips'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tip Jar Deposit Modal — Mockup 1.4 port */}
        <ModalShell
          open={showTipModal}
          onClose={() => setShowTipModal(false)}
          title="Tip the Dealer"
          subtitle="100% GOES TO THE TIP JAR · DISTRIBUTED OVER NEXT HANDS"
          width={440}
        >
          <div className="flex flex-col gap-4">
            {/* Pool snapshot */}
            <div className="rounded-md hairline bg-ink/50 p-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.22em] mb-1">CURRENT POOL</div>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-display text-orange text-2xl leading-none tabular-nums">
                    {(tipJarBalance / 1e9).toFixed(4)}
                  </span>
                  <span className="font-mono text-[10px] text-orange/70 tracking-wider">SOL</span>
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.22em] mb-1">HANDS REMAINING</div>
                <div className="flex items-baseline gap-1 justify-end">
                  <span className="font-display text-bone text-xl leading-none tabular-nums">{tipJarHands}</span>
                  <span className="font-mono text-[10px] text-boneDim/70 tracking-wider">HANDS</span>
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.22em] mb-1">ALL-TIME</div>
                <div className="flex items-baseline gap-1 justify-end">
                  <span className="font-mono text-bone text-sm leading-none tabular-nums">
                    {(tipJarTotal / 1e9).toFixed(3)}
                  </span>
                  <span className="font-mono text-[9px] text-boneDim/70 tracking-wider">SOL</span>
                </div>
              </div>
            </div>

            {/* Amount chooser */}
            <div>
              <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.22em] mb-2">TIP AMOUNT (SOL)</div>
              <div className="grid grid-cols-4 gap-1.5 mb-2">
                {['0.005', '0.01', '0.05', '0.1'].map(p => (
                  <button
                    key={p}
                    onClick={() => setTipAmount(p)}
                    className={`px-2 py-1.5 rounded-sm border font-mono text-[11px] tracking-wider transition ${
                      tipAmount === p
                        ? 'bg-orange/20 border-orange/60 text-orange'
                        : 'border-gold/15 text-bone/80 hover:border-gold/40'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={tipAmount}
                  onChange={e => setTipAmount(e.target.value)}
                  className="flex-1 bg-ink/60 border border-gold/15 rounded-sm px-3 py-2 font-mono text-bone tabular-nums focus:border-orange/60 focus:outline-none"
                />
                <span className="font-mono text-[11px] text-boneDim tracking-wider">SOL</span>
              </div>
            </div>

            <button
              onClick={depositTip}
              disabled={tipPending}
              className="btn-orange w-full py-2.5 rounded-md font-mono text-[11px] tracking-[0.24em] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {tipPending ? 'SENDING…' : `TIP ${tipAmount} SOL`}
            </button>
            <p className="text-[10px] text-boneDim/60 leading-relaxed">
              Your tip enters the shared SOL jar. Every hand at this table pays out a slice of the jar to the dealer reward rotation until empty.
            </p>
          </div>
        </ModalShell>

        {/* Share Table Modal — Mockup 1.4 port */}
        <ModalShell
          open={showShareModal}
          onClose={() => setShowShareModal(false)}
          title="Share Table"
          subtitle={`TABLE PDA · ${tablePubkey.slice(0, 8)}…${tablePubkey.slice(-6)}`}
          width={500}
        >
          {(() => {
            const fullUrl = typeof window !== 'undefined' ? window.location.href : '';
            const copy = async (label: string, text: string) => {
              try { await navigator.clipboard.writeText(text); } catch {}
              SFX.play('ui-click');
              setShareCopied(label);
              setTimeout(() => setShareCopied(null), 1400);
            };
            const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(`Join me at the table on ${BRAND.name} `)}${encodeURIComponent(fullUrl)}`;
            const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(fullUrl)}&text=${encodeURIComponent(`Join me at ${BRAND.name}`)}`;
            return (
              <div className="space-y-4">
                <div>
                  <div className="font-mono text-[9px] text-orange/70 tracking-[0.22em] uppercase mb-1.5">Shareable link</div>
                  <div className="flex items-center gap-2 px-3 py-2 rounded-sm hairline bg-ink/60">
                    <svg className="w-3.5 h-3.5 text-boneDim/50 flex-shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M6.5 9.5a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-.5.5M9.5 6.5a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l.5-.5"/>
                    </svg>
                    <input
                      readOnly
                      value={fullUrl}
                      className="flex-1 bg-transparent outline-none font-mono text-[12px] text-bone tabular-nums truncate"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button
                      onClick={() => copy('link', fullUrl)}
                      className="px-2.5 py-1 rounded-sm font-mono text-[10px] tracking-wider border border-orange/40 text-orange hover:bg-orange/15 hover:border-orange transition"
                    >
                      {shareCopied === 'link' ? 'COPIED ✓' : 'COPY'}
                    </button>
                  </div>
                </div>

                <div className="flex gap-1.5">
                  <a
                    href={tweetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => SFX.play('ui-tap')}
                    className="flex-1 text-center px-2 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] border border-boneDim/20 text-boneDim hover:border-bone/40 hover:text-bone transition"
                  >
                    X / TWITTER
                  </a>
                  <a
                    href={tgUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => SFX.play('ui-tap')}
                    className="flex-1 text-center px-2 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] border border-boneDim/20 text-boneDim hover:border-bone/40 hover:text-bone transition"
                  >
                    TELEGRAM
                  </a>
                  <button
                    onClick={async () => {
                      if (navigator.share) {
                        try { await navigator.share({ title: BRAND.name, text: 'Join me at the table!', url: fullUrl }); } catch {}
                      } else {
                        await copy('native', fullUrl);
                      }
                    }}
                    className="flex-1 text-center px-2 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] border border-boneDim/20 text-boneDim hover:border-bone/40 hover:text-bone transition"
                  >
                    MORE…
                  </button>
                </div>

                <div className="px-3 py-2 rounded-sm bg-amber-500/[0.06] border border-amber-500/20 font-mono text-[10px] text-amber-300/90 leading-relaxed">
                  Anyone with this link can spectate read-only. To seat at a table, they must join from the lobby and claim an open seat.
                </div>
              </div>
            );
          })()}
        </ModalShell>

    </>
  );
}
