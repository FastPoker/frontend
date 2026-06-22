'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { useConnectModal } from '@/components/wallet/FastPokerConnectModal';
import { useInsufficientFundsModal, useFundsErrorHandler } from '@/components/wallet/InsufficientFundsModal';
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import Link from 'next/link';
import { ConsentModal, PlayerConsentBody } from '@/components/legal/ConsentModal';
import Image from 'next/image';
import { useGameStore } from '@/store/gameStore';
import { makeL1Connection, L1_RPC_DIRECT, POKER_MINT, STEEL_PROGRAM_ID, POOL_PDA, ANCHOR_PROGRAM_ID, SnGTier, SNG_MINI_ADDON_LAMPORTS, getTierInfo } from '@/lib/constants';
import { usePlayer, getRegistrationCost } from '@/hooks/usePlayer';
import { useSessionContext } from '@/hooks/useSession';
import { usePoolHealth } from '@/hooks/usePoolHealth';
import { usePokerSupply } from '@/hooks/usePokerSupply';
import { useWalletBalances } from '@/hooks/useWalletBalances';
import { setSessionKey as persistSessionKey } from '@/lib/session-storage';
import { useOnChainGame } from '@/hooks/useOnChainGame';
import { useGameAuth } from '@/hooks/useGameAuth';
import { getErrorMessage, friendlyError } from '@/lib/error-messages';
import { getQueuesOnChain, SngPool } from '@/lib/api';
import {
  buildInitSngQueuePageInstruction,
  buildJoinSngPoolInstruction,
  buildLeaveSngPoolInstruction,
  buildLeaveTableInstruction,
  getSngPoolPda,
  getSngQueueMarkerPda,
  getSngQueuePagePda,
} from '@/lib/onchain-game';
import { confirmFundsAction } from '@/lib/funds-confirmation';
import { operatorFeeWallet, computeSngFeeLamports, describeSngFee, feeSolLabel } from '@/lib/operator-fee';
import { RAW_YIELD_NAME, LUCKY_JACKPOT_NAME } from '@/lib/jackpot-format';
import { TokenIcon } from '@/components/ui/TokenIcon';
import { useToast } from '@/components/toast/ToastProvider';

import { Lobby } from '@/components/lobby/Lobby';
import { removeActiveGame } from '@/components/layout/ActiveTableBar';
import { requestOpenSessionRenewModal } from '@/components/layout/SessionRenewModal';
import { isPoolJoinVoluntary, isPoolLeaveVoluntary, markPoolJoinVoluntary, markPoolLeaveVoluntary } from '@/lib/sng-leave-signal';
import { useSearchParams, useRouter } from 'next/navigation';
import { getPlayerPda } from '@/lib/pda';
import { PlayAccessGate } from '@/components/access/PlayAccessGate';

// claim_sol_winnings Anchor discriminator
const CLAIM_SOL_DISC = Buffer.from([47, 206, 17, 43, 28, 213, 74, 12]);
const SNG_DEBUG = process.env.NEXT_PUBLIC_SNG_DEBUG === '1';
const sngDebug = (...args: unknown[]) => {
  if (SNG_DEBUG) console.log(...args);
};

interface TokenBalances {
  sol: number;
  poker: number;
  refined: number;
  unrefined: number;
  staked: number;
  pendingSolRewards: number;
}

interface PoolState {
  totalStaked: number;
  totalUnrefined: number;
  solDistributed: number;
  circulatingSupply: number;
}

interface SitNGoQueue {
  id: string;
  type: 'heads_up' | '6max' | '9max';
  currentPlayers: number;
  maxPlayers: number;
  buyIn: number;
  tier: number;  // SnGTier enum: 0=Copper,...6=Black
  status: 'waiting' | 'starting' | 'in_progress';
  tablePda?: string;
  players?: string[];
  onChainPlayers?: number;
  emptySeats?: number[];
}

export default function LobbyPage() {
  return (
    <PlayAccessGate>
      <Home />
    </PlayAccessGate>
  );
}

function Home() {
  const { publicKey, isConnected: connected, sendTransaction } = useUnifiedWallet();
  const { open: openConnect } = useConnectModal();
  const { open: openFundModal } = useInsufficientFundsModal();
  const handleFundsError = useFundsErrorHandler();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { phase, tablePda, setMySeatIndex, syncFromChain } = useGameStore();
  const { player, isLoading: playerLoading, register, refresh: refreshPlayer } = usePlayer();
  const { session, createSession, reclaimSession, reloadSession, isLoading: sessionLoading } = useSessionContext();
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const { showToast, showError } = useToast();
  const [handHistory, setHandHistory] = useState<{ player: string; action: string; amount?: number; phase: string }[]>([]);
  const [pastHands, setPastHands] = useState<{ player: string; action: string; amount?: number; phase: string }[][]>([]);
  const [viewingPastHand, setViewingPastHand] = useState<number | null>(null); // null = current hand

  // Deep-link support for admin "port out" links: /?table=<tablePda>
  // Redirect to the unified /game/[id] page which handles both cash and SNG.
  useEffect(() => {
    const tableFromQuery = searchParams.get('table');
    if (!tableFromQuery) return;
    try {
      new PublicKey(tableFromQuery);
      router.replace(`/game?table=${tableFromQuery}`);
    } catch {
      // Ignore malformed deep-link values
    }
  }, [searchParams, router]);

  // TEE auth for private card reads
  const { teeConnection, teeAuthenticated, forceRefresh: forceRefreshTee, authenticatePlayer, ensurePlayerAuth, isPlayerReady } = useGameAuth();

  // On-chain game state hook - pass session key for gasless play
  const { 
    gameState: onChainGameState, 
    isLoading: gameLoading, 
    isConnected: gameConnected,
    sendAction: sendOnChainAction,
    isPendingAction,
    error: gameError,
    refreshState: refreshGameState
  } = useOnChainGame(activeTable, session.sessionKey, teeConnection, teeAuthenticated, forceRefreshTee);

  // Auto-authenticate with TEE as player when an active table is loaded.
  // Open the SessionRenewModal first so the user sees WHY the wallet popup
  // is about to appear, rather than getting a bare sign request out of nowhere.
  const hasTriggeredPlayerAuthRef = useRef(false);
  useEffect(() => {
    if (activeTable && connected && !isPlayerReady && !hasTriggeredPlayerAuthRef.current) {
      hasTriggeredPlayerAuthRef.current = true;
      requestOpenSessionRenewModal();
    }
  }, [activeTable, connected, isPlayerReady]);

  // Sync on-chain game state → Zustand store for selectors (isMyTurn, etc.)
  useEffect(() => {
    syncFromChain(onChainGameState);
  }, [onChainGameState, syncFromChain]);
  
  // Showdown delay: hold UI in Showdown briefly after on-chain settles
  // Captures ALL visual state so cards/players aren't lost when on-chain resets
  const [showdownHold, setShowdownHold] = useState(false);
  const [showdownPot, setShowdownPot] = useState(0);
  const [showdownSnapshot, setShowdownSnapshot] = useState<{
    communityCards: number[];
    players: any[];
    myCards?: [number, number];
  } | null>(null);
  // Preserve final game state when tournament ends (Complete) so it survives undelegate
  const [gameCompleteState, setGameCompleteState] = useState<any>(null);
  const [playerActions, setPlayerActions] = useState<{ seatIndex: number; action: string; timestamp: number }[]>([]);
  const prevPhaseForDelayRef = useRef<string | null>(null);
  
  // Track last known on-chain state for game-over detection
  const lastOnChainRef = useRef<typeof onChainGameState>(null);
  // Track last VALID community cards (settle resets them to [255;5] before frontend can snapshot)
  const lastValidCommunityRef = useRef<number[]>([]);
  // IMPORTANT: Use a ref for the showdown timer so React's effect cleanup doesn't kill it.
  // Previously the timer was returned as the cleanup function, but since showdownHold is
  // in the effect's triggers, setting showdownHold=true would re-run the effect, and
  // React would call the previous cleanup (clearTimeout) before the timer could fire.
  const showdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear gameCompleteState when joining a new table (prevents stale data from previous game)
  const prevActiveTableRef = useRef(activeTable);
  useEffect(() => {
    if (activeTable && activeTable !== prevActiveTableRef.current) {
      setGameCompleteState(null);
      setShowdownHold(false);
      setShowdownPot(0);
      setShowdownSnapshot(null);
      lastValidCommunityRef.current = [];
      if (showdownTimerRef.current) {
        clearTimeout(showdownTimerRef.current);
        showdownTimerRef.current = null;
      }
    }
    prevActiveTableRef.current = activeTable;
  }, [activeTable]);

  useEffect(() => {
    const currPhase = onChainGameState?.phase;
    const prevPhase = prevPhaseForDelayRef.current;
    prevPhaseForDelayRef.current = currPhase || null;
    
    // Track last valid community cards (settle resets them to [255;5] atomically)
    // Only update during betting phases when cards are actually dealt
    const cc = onChainGameState?.communityCards;
    if (cc && cc.some((c: number) => c !== 255 && c >= 0 && c <= 51)) {
      lastValidCommunityRef.current = [...cc];
    }

    // Capture full state when entering showdown or any end phase (Complete/Waiting after a hand)
    // The crank is often fast enough to skip Showdown entirely (betting → Complete in one update)
    const isEndPhase = currPhase === 'Showdown' || currPhase === 'Complete' || currPhase === 'Waiting';
    const wasPlayingPhase = prevPhase && prevPhase !== 'Showdown' && prevPhase !== 'Complete' && prevPhase !== 'Waiting';
    
    if (isEndPhase && wasPlayingPhase) {
      // Compute actual winnings from chip deltas (handles side pots / all-in correctly)
      // After settle: onChainGameState has post-settle chips, lastOnChainRef has pre-settle chips
      const prevPlayers = lastOnChainRef.current?.players;
      const currPlayers = onChainGameState?.players;
      let computedPot = 0;
      if (prevPlayers?.length && currPlayers?.length) {
        for (const cp of currPlayers) {
          const pp = prevPlayers.find((p: any) => p.pubkey === cp.pubkey);
          if (pp) {
            const gain = cp.chips - pp.chips;
            if (gain > computedPot) computedPot = gain;
          }
        }
      }
      // Fall back to raw pot if chip delta not available (e.g. first poll)
      if (computedPot <= 0) {
        computedPot = onChainGameState?.pot || lastOnChainRef.current?.pot || 0;
      }
      if (computedPot > 0) {
        setShowdownPot(computedPot);
      }
      // Capture snapshot from last known state (before settle reset cards/bets)
      // Use lastValidCommunityRef for community cards since settle clears them atomically
      const snapSource = lastOnChainRef.current || onChainGameState;
      if (snapSource && !showdownSnapshot) {
        const snapshotCommunity = lastValidCommunityRef.current.length > 0
          ? [...lastValidCommunityRef.current]
          : [...(snapSource.communityCards || [])];
        setShowdownSnapshot({
          communityCards: snapshotCommunity,
          players: JSON.parse(JSON.stringify(snapSource.players || [])),
          myCards: snapSource.myCards ? [...snapSource.myCards] as [number, number] : undefined,
        });
      }
    }
    
    // Preserve game state when Complete is detected (survives undelegate)
    if (currPhase === 'Complete' && onChainGameState) {
      setGameCompleteState(JSON.parse(JSON.stringify(onChainGameState)));
    }

    // Game-over detection: on-chain state vanished while in Showdown
    // This happens when crank undelegates before frontend sees Complete phase
    if (!onChainGameState && lastOnChainRef.current) {
      const lastPhase = lastOnChainRef.current.phase;
      if (lastPhase === 'Showdown' || lastPhase === 'Complete' || showdownHold) {
        console.log('Table vanished during showdown — synthesizing Complete state');
        const synthetic = JSON.parse(JSON.stringify(lastOnChainRef.current));
        synthetic.phase = 'Complete';
        setGameCompleteState(synthetic);
        // Release showdown hold so Complete overlay shows
        setShowdownHold(false);
        setShowdownPot(0);
        setShowdownSnapshot(null);
        lastValidCommunityRef.current = [];
        if (showdownTimerRef.current) {
          clearTimeout(showdownTimerRef.current);
          showdownTimerRef.current = null;
        }
      }
    }

    // Keep ref updated
    if (onChainGameState) {
      lastOnChainRef.current = onChainGameState;
    }
    
    // Trigger hold on phase transition to end states
    // Handles: Showdown→Complete, Showdown→Waiting, AND skipped-Showdown (PreFlop→Complete, etc.)
    const triggerHold = (
      (prevPhase === 'Showdown' && (currPhase === 'Complete' || currPhase === 'Waiting')) ||
      (wasPlayingPhase && (currPhase === 'Complete' || currPhase === 'Waiting'))
    );
    if (triggerHold) {
      // Ensure showdownPot is captured even if we missed it above
      if (!showdownPot) {
        // Compute from chip deltas (handles side pots / all-in)
        const prevPlayers = lastOnChainRef.current?.players;
        const currPlayers = onChainGameState?.players;
        let computedPot = 0;
        if (prevPlayers?.length && currPlayers?.length) {
          for (const cp of currPlayers) {
            const pp = prevPlayers.find((p: any) => p.pubkey === cp.pubkey);
            if (pp) {
              const gain = cp.chips - pp.chips;
              if (gain > computedPot) computedPot = gain;
            }
          }
        }
        if (computedPot <= 0) {
          computedPot = onChainGameState?.pot || lastOnChainRef.current?.pot || 0;
        }
        if (computedPot > 0) setShowdownPot(computedPot);
      }
      // Re-capture snapshot if we missed it
      if (!showdownSnapshot) {
        const snapSource = lastOnChainRef.current || onChainGameState;
        if (snapSource) {
          const snapshotCommunity = lastValidCommunityRef.current.length > 0
            ? [...lastValidCommunityRef.current]
            : [...(snapSource.communityCards || [])];
          setShowdownSnapshot({
            communityCards: snapshotCommunity,
            players: JSON.parse(JSON.stringify(snapSource.players || [])),
            myCards: snapSource.myCards ? [...snapSource.myCards] as [number, number] : undefined,
          });
        }
      }
      setShowdownHold(true);
      // Clear any previous timer before setting a new one
      if (showdownTimerRef.current) clearTimeout(showdownTimerRef.current);
      // Hold showdown display so players can see revealed cards and hand names
      // Stage 3 (winner + chips) fires at 2.5s, so hold long enough to see it
      const holdMs = currPhase === 'Complete' ? 8000 : 10000;
      showdownTimerRef.current = setTimeout(() => {
        setShowdownHold(false);
        setShowdownPot(0);
        setShowdownSnapshot(null);
        lastValidCommunityRef.current = [];
        showdownTimerRef.current = null;
      }, holdMs);
    }

    // Early release: if showdownHold is active but new hand started (PreFlop+), release immediately
    if (showdownHold && currPhase && currPhase !== 'Showdown' && currPhase !== 'Waiting' && currPhase !== 'Complete') {
      setShowdownHold(false);
      setShowdownPot(0);
      setShowdownSnapshot(null);
      lastValidCommunityRef.current = [];
      if (showdownTimerRef.current) {
        clearTimeout(showdownTimerRef.current);
        showdownTimerRef.current = null;
      }
    }
  }, [onChainGameState, showdownHold, showdownSnapshot, showdownPot]);

  // On-chain game state only (no demo/local fallback)
  const gameState: {
    phase: string;
    pot: number;
    currentPlayer: number;
    communityCards: number[];
    players: any[];
    myCards?: [number, number];
    dealerSeat: number;
    blinds: { small: number; big: number };
    mySeatIndex: number;
    tier: number;
    prizePool: number;
    maxPlayers: number;
    lastActionSlot: number;
    blindLevel: number;
    tournamentStartTime: number;
    currentBet: number;
    tokenMint: string;
  } | null = (() => {
    // Use live on-chain state, or fall back to preserved Complete state after undelegate
    const source = onChainGameState || gameCompleteState;
    if (!source) return null;
    
    const isLive = !!onChainGameState;
    return {
      phase: showdownHold ? 'Showdown' : (isLive ? source.phase : 'Complete'),
      pot: showdownHold ? (showdownPot || source.pot) : source.pot,
      currentPlayer: source.currentPlayer,
      communityCards: showdownHold && showdownSnapshot ? showdownSnapshot.communityCards : source.communityCards,
      players: showdownHold && showdownSnapshot ? showdownSnapshot.players.map((sp: any) => {
        // Merge revealed hole cards from live on-chain data OR gameCompleteState
        // (settle populates revealed_hands; after undelegate, live data is gone)
        const mergeSource = isLive ? onChainGameState!.players : source.players;
        const mergePlayer = mergeSource?.find((lp: any) => lp.pubkey === sp.pubkey);
        if (mergePlayer?.holeCards && mergePlayer.holeCards[0] !== 255 && (!sp.holeCards || sp.holeCards[0] === 255)) {
          return { ...sp, holeCards: mergePlayer.holeCards };
        }
        return sp;
      }) : source.players,
      myCards: showdownHold && showdownSnapshot ? showdownSnapshot.myCards : source.myCards,
      dealerSeat: source.dealerSeat,
      blinds: source.blinds,
      mySeatIndex: source.mySeatIndex,
      tier: source.tier,
      prizePool: source.prizePool,
      maxPlayers: source.maxPlayers,
      lastActionSlot: source.lastActionSlot,
      blindLevel: source.blindLevel || 0,
      tournamentStartTime: source.tournamentStartTime || 0,
      currentBet: source.currentBet || 0,
      tokenMint: source.tokenMint || '11111111111111111111111111111111',
    };
  })();
  
  // Track previous game state for opponent action detection
  const prevGameStateRef = useRef<typeof onChainGameState>(null);
  
  // Track opponent actions by detecting state changes
  useEffect(() => {
    const prev = prevGameStateRef.current;
    if (!onChainGameState || !prev) {
      prevGameStateRef.current = onChainGameState;
      return;
    }
    
    const prevPhase = prev.phase;
    const currPhase = onChainGameState.phase;
    const prevPlayer = prev.currentPlayer;
    const currPlayer = onChainGameState.currentPlayer;
    const myIdx = onChainGameState.mySeatIndex;
    const blinds = onChainGameState.blinds;
    
    // Detect blind posting: Waiting → Starting/PreFlop transition (new hand starting)
    // On-chain: start_game posts blinds in Starting phase, tee_deal moves to PreFlop
    if (prevPhase === 'Waiting' && (currPhase === 'PreFlop' || currPhase === 'Starting')) {
      // Archive previous hand if it has entries
      setHandHistory(prev => {
        if (prev.length > 0) {
          setPastHands(past => [...past, prev]);
        }
        return [];
      });
      setViewingPastHand(null); // Reset to current hand view
      const now = Date.now();
      for (const p of onChainGameState.players) {
        if (!p.isActive) continue;
        const label = p.pubkey === publicKey?.toBase58() ? 'You' : (p.pubkey?.slice(0, 6) + '...');
        if (p.bet === blinds.small) {
          setHandHistory(h => [...h, { player: label, action: `SB ${blinds.small}`, phase: 'PreFlop' }]);
          setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== p.seatIndex), { seatIndex: p.seatIndex, action: `SB ${blinds.small}`, timestamp: now }]);
        } else if (p.bet === blinds.big) {
          setHandHistory(h => [...h, { player: label, action: `BB ${blinds.big}`, phase: 'PreFlop' }]);
          setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== p.seatIndex), { seatIndex: p.seatIndex, action: `BB ${blinds.big}`, timestamp: now + 1 }]);
        }
      }
      prevGameStateRef.current = onChainGameState;
      return;
    }
    
    // Detect if current player changed (opponent acted)
    if ((prevPlayer !== currPlayer || prevPhase !== currPhase) && prevPlayer !== myIdx && prevPlayer >= 0) {
      const prevOpp = prev.players.find((p: { seatIndex: number }) => p.seatIndex === prevPlayer);
      const currOpp = onChainGameState.players.find((p: { seatIndex: number }) => p.seatIndex === prevPlayer);
      
      if (prevOpp && currOpp) {
        const label = currOpp.pubkey === publicKey?.toBase58() ? 'You' : (currOpp.pubkey?.slice(0, 6) + '...');
        let action = 'CHECK';
        if (currOpp.folded && !prevOpp.folded) {
          action = 'FOLD';
        } else if (currOpp.chips === 0 && prevOpp.chips > 0) {
          action = `ALL-IN ${currOpp.bet}`;
        } else if (currOpp.bet > prevOpp.bet) {
          const betDiff = currOpp.bet - prevOpp.bet;
          const prevMaxBet = Math.max(...prev.players.map((p: { bet: number }) => p.bet), 0);
          action = currOpp.bet > prevMaxBet ? `RAISE ${currOpp.bet}` : `CALL ${betDiff}`;
        }
        
        setHandHistory(h => [...h, { player: label, action, phase: prevPhase }]);
        setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== currOpp.seatIndex), { seatIndex: currOpp.seatIndex, action, timestamp: Date.now() }]);
      }
    }

    // Log results when transitioning to Showdown or Complete
    if (prevPhase !== 'Complete' && prevPhase !== 'Showdown' && (currPhase === 'Showdown' || currPhase === 'Complete')) {
      const SUITS = ['s', 'h', 'd', 'c'];
      const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
      const cardStr = (c: number) => c >= 0 && c <= 51 ? `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}` : '?';

      // Log community cards (board)
      const board = (onChainGameState.communityCards || []).filter((c: number) => c !== 255 && c >= 0 && c <= 51);
      if (board.length >= 3) {
        setHandHistory(h => [...h, { player: '', action: `Board: ${board.map(cardStr).join(' ')}`, phase: 'Summary' }]);
      }

      // Log each player's hand
      const isFoldWin = onChainGameState.players.filter((p: any) => !p.folded && p.isActive).length <= 1;
      for (const p of onChainGameState.players) {
        if (!p.isActive && !p.folded) continue;
        const isMe = p.pubkey === publicKey?.toBase58();
        const label = isMe ? 'You' : (p.pubkey?.slice(0, 6) + '...');
        const cards = isMe ? onChainGameState.myCards : p.holeCards;
        if (p.folded) {
          setHandHistory(h => [...h, { player: label, action: 'folded', phase: 'Summary' }]);
        } else if (cards && cards[0] !== 255 && cards[1] !== 255) {
          setHandHistory(h => [...h, { player: label, action: `${cardStr(cards[0])} ${cardStr(cards[1])}`, phase: 'Summary' }]);
        } else if (!isFoldWin) {
          // Showdown but cards not revealed yet (will update on next state change)
          setHandHistory(h => [...h, { player: label, action: 'cards hidden', phase: 'Summary' }]);
        }
      }

      // Find winner — player who gained chips
      for (const curr of onChainGameState.players) {
        if (!curr.isActive && !curr.folded) continue;
        const prevP = prev.players.find((p: { pubkey: string }) => p.pubkey === curr.pubkey);
        if (!prevP) continue;
        const chipDelta = curr.chips - prevP.chips;
        const label = curr.pubkey === publicKey?.toBase58() ? 'You' : (curr.pubkey?.slice(0, 6) + '...');
        if (chipDelta > 0) {
          const winType = isFoldWin ? 'WON (fold)' : 'WON';
          setHandHistory(h => [...h, { player: label, action: `${winType} +${chipDelta.toLocaleString()}`, phase: 'Result' }]);
        }
      }
    }
    
    prevGameStateRef.current = onChainGameState;
  }, [onChainGameState, publicKey]);

  const [refreshCounter, setRefreshCounter] = useState(0);

  // Balances + pool state are derived from indexer-backed hooks. The lobby used
  // to fire its own 15s polling loop that hit Helius for 6 accounts per tick
  // (POOL_PDA + POKER_MINT + wallet accounts). Those values are now served by
  // shared hooks:
  //  - usePoolHealth: POOL_PDA direct-chain poll
  //  - usePokerSupply: POKER_MINT direct-chain poll
  //  - useWalletBalances: wallet-side direct-chain poll
  // No setBalances / setPoolState anywhere now — every value is reactive via
  // hook state and updates automatically from their shared polling loops.
  const pool = usePoolHealth();
  const supply = usePokerSupply();
  const wb = useWalletBalances();
  const balances = useMemo<TokenBalances>(() => ({
    sol: wb.solBalance,
    poker: wb.pokerBalance,
    refined: wb.pokerRefined,
    unrefined: wb.pokerUnrefined,
    staked: wb.staked,
    pendingSolRewards: wb.stakingSol,
  }), [wb.solBalance, wb.pokerBalance, wb.pokerRefined, wb.pokerUnrefined, wb.staked, wb.stakingSol]);
  const poolState = useMemo<PoolState>(() => ({
    totalStaked: pool.totalPoolStaked,
    totalUnrefined: pool.totalUnrefined,
    // The lobby reads "total SOL ever earned by stakers" = solDistributed
    // (claimed) + solAvailable (pending).
    solDistributed: pool.solDistributed + pool.solAvailable,
    circulatingSupply: supply.wholeSupply,
  }), [pool.totalPoolStaked, pool.totalUnrefined, pool.solDistributed, pool.solAvailable, supply.wholeSupply]);
  const [sitNGoQueues, setSitNGoQueues] = useState<SitNGoQueue[]>([]);
  const [sngPools, setSngPools] = useState<SngPool[] | undefined>(undefined);
  const [joiningPool, setJoiningPool] = useState<string | null>(null); // "gameType-tier" key
  const [leavingPool, setLeavingPool] = useState<string | null>(null); // "gameType-tier" key
  const [registering, setRegistering] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [selectedTier, setSelectedTier] = useState<SnGTier>(SnGTier.Micro);
  const [claimingSol, setClaimingSol] = useState(false);

  // SNG queues + pools are read directly from chain in the public source build.
  // Polled here so the lobby surfaces table-fill progress and pool seat counts.
  // Balances + pool state are delivered via hooks (usePoolHealth /
  // usePokerSupply / useWalletBalances) and no longer need an interval here.
  useEffect(() => {
    // Standalone: tiers are read directly from chain, so they load even before a
    // wallet connects (browse, then connect to join).
    const fetchQueues = async () => {
      try {
        const { queues, pools } = await getQueuesOnChain(publicKey?.toBase58());
        const myWallet = publicKey?.toBase58() ?? '';
        // Merge server data with recent voluntary signals. The server / its
        // upstream indexer can lag chain state by several seconds, so a poll
        // that lands during the 30s window after a join/leave may still
        // report the pre-action queue membership. We respect the user's
        // recently-confirmed intent and rewrite the merged pool entry so
        // SngPoolCard's isInPool calculation stays coherent.
        const merged = pools.map(p => {
          if (!myWallet) return p;
          const recentLeave = isPoolLeaveVoluntary(p.gameType, p.tier);
          const recentJoin = isPoolJoinVoluntary(p.gameType, p.tier);
          const serverHasMe = p.queue.includes(myWallet);
          if (recentLeave && serverHasMe) {
            // Stale-still-in-queue snapshot. Strip locally.
            const nextQueue = p.queue.filter(w => w !== myWallet);
            const nextEntries = p.queueEntries?.filter(e => e.wallet !== myWallet);
            sngDebug(`[SNG-DEBUG] POLL merge-strip gt=${p.gameType}/tier=${p.tier} (recent leave, server still showed me)`);
            return { ...p, queue: nextQueue, queueCount: nextQueue.length, waitingCount: nextQueue.length, queueEntries: nextEntries };
          }
          if (recentJoin && !serverHasMe) {
            // Stale-not-yet-in-queue snapshot. Add locally.
            const nextQueue = [...p.queue, myWallet];
            sngDebug(`[SNG-DEBUG] POLL merge-add gt=${p.gameType}/tier=${p.tier} (recent join, server didn't yet show me)`);
            return { ...p, queue: nextQueue, queueCount: nextQueue.length, waitingCount: nextQueue.length };
          }
          return p;
        });
        const myPools = merged
          .filter(p => p.queue.includes(myWallet))
          .map(p => `gt=${p.gameType}/tier=${p.tier}`)
          .join(',') || 'none';
        sngDebug(`[SNG-DEBUG] POLL t=${Date.now()} myWalletInQueues=[${myPools}] (after voluntary-signal merge)`);
        setSitNGoQueues((prev) => {
          const next = JSON.stringify(queues);
          return JSON.stringify(prev) === next ? prev : queues;
        });
        setSngPools((prev) => {
          const next = JSON.stringify(merged);
          return JSON.stringify(prev) === next ? prev : merged;
        });
      } catch {
        setSitNGoQueues((prev) =>
          prev.length > 0
            ? prev
            : [
                { id: 'hu-1', type: 'heads_up', currentPlayers: 0, maxPlayers: 2, buyIn: 0.01, tier: 0, status: 'waiting' },
                { id: '6max-1', type: '6max', currentPlayers: 0, maxPlayers: 6, buyIn: 0.01, tier: 0, status: 'waiting' },
                { id: '9max-1', type: '9max', currentPlayers: 0, maxPlayers: 9, buyIn: 0.01, tier: 0, status: 'waiting' },
              ],
        );
      }
    };
    fetchQueues();
    if (publicKey) refreshPlayer();
    // Minimal-request: tiers refresh slowly (cached + single-flight in getQueuesOnChain).
    const interval = setInterval(fetchQueues, 30000);
    return () => clearInterval(interval);
  }, [connected, publicKey, refreshCounter, refreshPlayer]);

  // Set seat index when connected
  useEffect(() => {
    if (connected) {
      setMySeatIndex(0);
    }
  }, [connected, setMySeatIndex]);

  // Handle on-chain registration
  const handleRegister = async () => {
    if (!publicKey) return;
    setRegistering(true);
    try {
      await register();
      // Session keys for gameplay are created by the SNG pool or cash seating flows.
    } catch (e: unknown) {
      if (handleFundsError(e)) return;
      console.error('Registration failed:', e);
      showToast('Registration failed: ' + getErrorMessage(e), 'error');
    } finally {
      setRegistering(false);
    }
  };

  // Join an on-chain SNG pool (new pool-based system)
  const handleJoinSngPool = async (gameType: number, tier: number, miniOptIn = true) => {
    if (!publicKey) return;
    const key = `${gameType}-${tier}`;
    // Lock the button BEFORE the (headless on Privy) auth signature so it can't
    // be re-clicked or look idle during ensurePlayerAuth().
    setJoiningPool(key);
    // Headless Privy signs with no wallet popup to yield the event loop, so the
    // lock can batch on->off and the button never visibly disables. Yield one
    // animation frame so the disabled/SIGNING state paints first (setTimeout
    // fallback in case rAF is throttled in a backgrounded tab).
    await new Promise<void>(resolve => {
      const done = () => resolve();
      requestAnimationFrame(done);
      setTimeout(done, 60);
    });
    try {
      console.log('[JOIN-AUTH] handleJoinSngPool: calling ensurePlayerAuth');
      const authOk = await ensurePlayerAuth();
      if (!authOk) {
        // Pop the focused renew modal so the user gets a single "Sign to
        // continue" button without the full session-manager surface.
        requestOpenSessionRenewModal();
        return;
      }
      // Ensure a session key exists so the pool entry binds it atomically.
      // Contract rejects Pubkey::default() as approved_signer.
      let sessionKeyForSigner: Keypair | null = session.sessionKey;
      if (!sessionKeyForSigner) {
        sessionKeyForSigner = Keypair.generate();
        await persistSessionKey(publicKey.toBase58(), sessionKeyForSigner.secretKey);
        reloadSession();
      }
      const connection = makeL1Connection();
      const poolState = sngPools?.find(p => p.gameType === gameType && p.tier === tier);
      const joinPageIndex = poolState?.tailPageFull && poolState.tailPageIndex !== undefined
        ? poolState.tailPageIndex + 1
        : poolState?.tailPageIndex ?? 0;
      const ix = buildJoinSngPoolInstruction(
        publicKey,
        gameType,
        tier,
        sessionKeyForSigner.publicKey,
        miniOptIn,
        { tailPageIndex: joinPageIndex },
      );
      const tx = new Transaction();
      if (poolState?.tailPageFull && poolState.tailPageIndex !== undefined) {
        const [poolPda] = getSngPoolPda(gameType, tier);
        const [currentTailPage] = getSngQueuePagePda(poolPda, poolState.tailPageIndex);
        tx.add(buildInitSngQueuePageInstruction(publicKey, gameType, tier, joinPageIndex, currentTailPage));
      }
      tx.add(ix);
      const tierInfo = getTierInfo(tier as SnGTier);
      const buyInLamports = poolState?.totalBuyIn ?? tierInfo.totalBuyIn;
      // Optional operator frontend fee: a plain SOL transfer to the operator's
      // wallet, appended to the same tx so it's disclosed and signed atomically
      // with the buy-in. No-op unless the build configured a fee wallet + knob.
      const operatorFeeWalletPk = operatorFeeWallet();
      const operatorFeeLamports = operatorFeeWalletPk ? computeSngFeeLamports(buyInLamports) : 0;
      if (operatorFeeWalletPk && operatorFeeLamports > 0) {
        tx.add(SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: operatorFeeWalletPk,
          lamports: operatorFeeLamports,
        }));
      }
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
      const pageRentContribution = poolState?.pageRentContributionLamports ?? 0;
      const totalLamports = buyInLamports
        + (miniOptIn ? SNG_MINI_ADDON_LAMPORTS : 0)
        + operatorFeeLamports;
      // Pre-check the SOL balance up front. Without this, an under-funded join
      // sends a doomed tx whose preflight failure surfaces as a raw, repeated
      // "-32002 / decode this error" toast. Instead, show the clean insufficient
      // -funds modal and stop before sending.
      const haveLamports = Math.floor((balances.sol || 0) * 1e9);
      const needLamports = totalLamports + 10_000; // buy-in + ~tx-fee headroom
      if (!wb.loading && haveLamports < needLamports) {
        openFundModal({
          required: needLamports,
          have: haveLamports,
          reason: `Joining the ${tierInfo.name} Sit & Go needs ${(totalLamports / 1e9).toFixed(4).replace(/\.?0+$/, '')} SOL plus network fees.`,
        });
        return;
      }
      if (!(await confirmFundsAction({
        title: 'Confirm SNG Buy-In',
        action: `Join ${tierInfo.name} SNG pool${miniOptIn ? ` with ${LUCKY_JACKPOT_NAME}` : ''}`,
        amount: `${(totalLamports / 1e9).toFixed(6).replace(/\.?0+$/, '')} SOL`,
        details: [
          ...(operatorFeeLamports > 0
            ? [`Includes ${feeSolLabel(operatorFeeLamports)} site fee${describeSngFee() ? ` (${describeSngFee()})` : ''} to this frontend's operator.`]
            : []),
          ...(pageRentContribution > 0
            ? [`Includes ${(pageRentContribution / 1e9).toFixed(6).replace(/\.?0+$/, '')} SOL queue page reserve contribution.`]
            : []),
          miniOptIn ? `Includes 0.01 SOL refundable ${LUCKY_JACKPOT_NAME} escrow; it funds the pot only after seating.` : `${LUCKY_JACKPOT_NAME} opt-out.`,
        ],
        transaction: tx,
      }))) {
        return;
      }
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      sngDebug(`[SNG-DEBUG] JOIN confirmed t=${Date.now()} gt=${gameType} tier=${tier} sig=${sig.slice(0, 12)}`);
      showToast('Joined pool! Waiting for match.', 'success');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@/lib/sentry-metrics') as typeof import('@/lib/sentry-metrics'))
        .count('fp.sng.join_attempt', 1, { result: 'success', tier: String(tier), gameType: String(gameType) });
      markPoolJoinVoluntary(gameType, tier);
      sngDebug(`[SNG-DEBUG] JOIN marked voluntary t=${Date.now()} gt=${gameType} tier=${tier}`);
      const myWallet = publicKey.toBase58();
      setSngPools(prev => {
        const next = prev?.map(p => {
          if (p.gameType !== gameType || p.tier !== tier) return p;
          if (p.queue.includes(myWallet)) return p;
          const nextQueue = [...p.queue, myWallet];
          return { ...p, queue: nextQueue, queueCount: nextQueue.length, waitingCount: nextQueue.length };
        });
        const myPool = next?.find(p => p.gameType === gameType && p.tier === tier);
        sngDebug(`[SNG-DEBUG] JOIN optimistic-add t=${Date.now()} myInQueue=${myPool?.queue.includes(myWallet)} count=${myPool?.queueCount}`);
        return next;
      });
      // Standalone: pools are read on-chain (no server cache to invalidate).
    } catch (e: unknown) {
      const errMsg = getErrorMessage(e);
      const msg = errMsg.toLowerCase();
      if (msg.includes('user rejected') || msg.includes('cancelled') || msg.includes('user denied')) {
        showToast('Transaction cancelled.', 'info');
      } else if (msg.includes('poolalreadyqueued') || msg.includes('already queued') || msg.includes('6099')) {
        showToast('You are already in this pool queue.', 'info');
      } else if (msg.includes('poolplayerinmatch') || msg.includes('player in match')) {
        showError(e, {
          title: 'Match in progress',
          message: 'You have a match in progress. Finish your current game first.',
          ctx: {
            action: 'sng:join_pool',
            wallet: publicKey?.toBase58(),
            programId: ANCHOR_PROGRAM_ID.toBase58(),
            rpc: L1_RPC_DIRECT,
            extra: { gameType, tier },
          },
        });
      } else {
        showError(e, {
          title: 'Join pool failed',
          // Show the friendly mapped message (e.g. the -32002 preflight case
          // now reads "Not enough SOL...") instead of the raw decode blob. The
          // SHOW/COPY DEBUG buttons still carry the raw error.
          message: errMsg,
          ctx: {
            action: 'sng:join_pool',
            wallet: publicKey?.toBase58(),
            programId: ANCHOR_PROGRAM_ID.toBase58(),
            rpc: L1_RPC_DIRECT,
            extra: { gameType, tier },
          },
        });
      }
      console.error('Join pool failed:', e);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@/lib/sentry-metrics') as typeof import('@/lib/sentry-metrics'))
        .count('fp.sng.join_attempt', 1, {
          result: msg.includes('user rejected') || msg.includes('cancelled') ? 'cancelled' : 'failure',
          tier: String(tier),
          gameType: String(gameType),
        });
    } finally {
      setJoiningPool(null);
    }
  };

  // Leave an on-chain SNG pool (full refund)
  const handleLeavePool = async (gameType: number, tier: number) => {
    if (!publicKey) return;
    const key = `${gameType}-${tier}`;
    setLeavingPool(key);
    try {
      const connection = makeL1Connection();
      // Authoritative pageIndex comes from the on-chain queue_marker, not
      // the cached SngPool. Cached state can be stale after a CompactPages,
      // pageIndex bumps from new joins, or a half-stripped optimistic update;
      // passing a stale value makes the wallet adapter throw "Unexpected
      // error" before sim returns, which is unhelpful.
      const [poolPda] = getSngPoolPda(gameType, tier);
      const [queueMarkerPda] = getSngQueueMarkerPda(poolPda, publicKey);
      const markerInfo = await connection.getAccountInfo(queueMarkerPda, 'confirmed');
      if (!markerInfo) {
        // No marker = user isn't actually queued in this pool. The cache lied.
        showToast('You are not in this pool queue.', 'info');
        // Re-sync the cache so the UI button state catches up.
        markPoolLeaveVoluntary(gameType, tier);
        const myWallet = publicKey.toBase58();
        setSngPools(prev => prev?.map(p => {
          if (p.gameType !== gameType || p.tier !== tier) return p;
          const nextQueue = p.queue.filter(w => w !== myWallet);
          const nextEntries = p.queueEntries?.filter(e => e.wallet !== myWallet);
          return { ...p, queue: nextQueue, queueCount: nextQueue.length, waitingCount: nextQueue.length, queueEntries: nextEntries };
        }));
        return;
      }
      // queue_marker layout: 8 disc + 32 pool + 32 player + u16 page_index ...
      // page_index byte offset = 8 + 32 + 32 = 72
      const pageIndex = markerInfo.data.readUInt16LE(72);
      const ix = buildLeaveSngPoolInstruction(publicKey, gameType, tier, pageIndex);
      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
      if (!(await confirmFundsAction({
        title: 'Confirm Pool Leave',
        action: 'Leave SNG pool and request refund',
        details: [`Pool: game type ${gameType}, tier ${tier}`],
        transaction: tx,
      }))) {
        return;
      }
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      sngDebug(`[SNG-DEBUG] LEAVE confirmed t=${Date.now()} gt=${gameType} tier=${tier} sig=${sig.slice(0, 12)}`);
      showToast('Left pool. Refund sent.', 'success');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@/lib/sentry-metrics') as typeof import('@/lib/sentry-metrics'))
        .count('fp.sng.leave_attempt', 1, { result: 'success', tier: String(tier), gameType: String(gameType) });
      markPoolLeaveVoluntary(gameType, tier);
      sngDebug(`[SNG-DEBUG] LEAVE marked voluntary t=${Date.now()} gt=${gameType} tier=${tier}`);
      const myWallet = publicKey.toBase58();
      setSngPools(prev => {
        const next = prev?.map(p => {
          if (p.gameType !== gameType || p.tier !== tier) return p;
          const nextQueue = p.queue.filter(w => w !== myWallet);
          const nextEntries = p.queueEntries?.filter(e => e.wallet !== myWallet);
          return { ...p, queue: nextQueue, queueCount: nextQueue.length, waitingCount: nextQueue.length, queueEntries: nextEntries };
        });
        const myPool = next?.find(p => p.gameType === gameType && p.tier === tier);
        sngDebug(`[SNG-DEBUG] LEAVE optimistic-strip t=${Date.now()} myInQueue=${myPool?.queue.includes(myWallet)} count=${myPool?.queueCount}`);
        return next;
      });
      // Standalone: pools are read on-chain (no server cache to invalidate).
    } catch (e: unknown) {
      const errMsg = getErrorMessage(e);
      const msg = errMsg.toLowerCase();
      if (msg.includes('user rejected') || msg.includes('cancelled') || msg.includes('user denied')) {
        showToast('Transaction cancelled.', 'info');
      } else if (msg.includes('poolnotinqueue') || msg.includes('not in queue')) {
        showToast('You are not in this pool queue.', 'info');
      } else if (msg.includes('poolplayerinmatch') || msg.includes('player in match')) {
        showError(e, {
          title: 'Cannot leave',
          message: 'A match is already in progress for this pool.',
          ctx: {
            action: 'sng:leave_pool',
            wallet: publicKey?.toBase58(),
            programId: ANCHOR_PROGRAM_ID.toBase58(),
            rpc: L1_RPC_DIRECT,
            extra: { gameType, tier },
          },
        });
      } else {
        showError(e, {
          title: 'Leave pool failed',
          ctx: {
            action: 'sng:leave_pool',
            wallet: publicKey?.toBase58(),
            programId: ANCHOR_PROGRAM_ID.toBase58(),
            rpc: L1_RPC_DIRECT,
            extra: { gameType, tier },
          },
        });
      }
      console.error('Leave pool failed:', e);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@/lib/sentry-metrics') as typeof import('@/lib/sentry-metrics'))
        .count('fp.sng.leave_attempt', 1, {
          result: msg.includes('user rejected') || msg.includes('cancelled') ? 'cancelled' : 'failure',
          tier: String(tier),
          gameType: String(gameType),
        });
    } finally {
      setLeavingPool(null);
    }
  };

  // Handle player action - send to on-chain
  const [actionPending, setActionPending] = useState(false);
  const handleGameAction = async (action: string, amount?: number) => {
    console.log('Player action:', action, amount);
    setActionPending(true);
    
    try {
      // Handle showdown settlement separately
      if (action === 'showdown' && activeTable) {
        try {
          showToast('Settling showdown...', 'info');
          const response = await fetch('/api/showdown', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tablePda: activeTable }),
          });
          const result = await response.json();
          if (result.success) {
            showToast('Showdown settled!', 'success');
          } else {
            showToast(`Settlement failed: ${result.error}`, 'error');
          }
        } catch (e: unknown) {
          showToast(`Settlement failed: ${getErrorMessage(e)}`, 'error');
        }
        return;
      }
      
      // Use on-chain action if table exists
      if (activeTable && sendOnChainAction) {
        try {
          const actionType = action as 'fold' | 'check' | 'call' | 'raise' | 'allin';
          const sig = await sendOnChainAction(actionType, amount);
          if (sig) {
            console.log('On-chain action confirmed:', sig);
            showToast(`${action.toUpperCase()} confirmed!`, 'success');
            // Track action in hand history + seat overlay
            const actionLabel = amount ? `${action.toUpperCase()} ${amount}` : action.toUpperCase();
            setHandHistory(prev => [...prev, {
              player: 'You',
              action: actionLabel,
              amount: amount,
              phase: gameState?.phase || 'Unknown'
            }]);
            if (gameState?.mySeatIndex !== undefined && gameState.mySeatIndex >= 0) {
              setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== gameState.mySeatIndex), { seatIndex: gameState.mySeatIndex, action: actionLabel, timestamp: Date.now() }]);
            }
          }
        } catch (e: unknown) {
          const { message: errMsg, severity } = friendlyError(e);
          // Skip console.error for user-cancellations so the Next.js dev
          // overlay doesn't pop on every wallet-rejection.
          if (severity !== 'info') console.error('On-chain action failed:', e);
          // Session expired — try auto-extend then retry the action once
          if (errMsg.includes('Session expired') || errMsg.includes('Reconnecting session') || errMsg.includes('InvalidSessionKey')) {
            showToast('Session key mismatch. Retrying...', 'info');
            reloadSession();
            try {
              const retrySig = await sendOnChainAction(action as any, amount);
              if (retrySig) {
                showToast(`${action.toUpperCase()} confirmed!`, 'success');
                const actionLabel = amount ? `${action.toUpperCase()} ${amount}` : action.toUpperCase();
                setHandHistory(prev => [...prev, { player: 'You', action: actionLabel, amount, phase: gameState?.phase || 'Unknown' }]);
              }
            } catch (retryErr: unknown) {
              const r = friendlyError(retryErr);
              showToast(r.message, r.severity === 'info' ? 'info' : 'error');
            }
            return;
          }
          showToast(errMsg, severity === 'info' ? 'info' : 'error');
        }
      }
    } finally {
      setActionPending(false);
    }
  };

  // Leave table (on-chain leave_table TX + backend queue update)
  const [leavingTable, setLeavingTable] = useState(false);
  const handleLeaveTable = async () => {
    // For SNGs in Waiting phase: send leave_table on L1 (undelegated SNG leave flow)
    // For cash games: skip — leave_cash_game is sent via onLeaveCashGame on ER
    const isCashGame = onChainGameState?.isCashGame;
    if (!isCashGame && activeTable && publicKey && onChainGameState && onChainGameState.mySeatIndex >= 0 && onChainGameState.phase === 'Waiting') {
      setLeavingTable(true);
      try {
        const connection = makeL1Connection();
        const tablePubkey = new PublicKey(activeTable);
        const ix = buildLeaveTableInstruction(publicKey, tablePubkey, onChainGameState.mySeatIndex);
        const tx = new Transaction().add(ix);
        tx.feePayer = publicKey;
        tx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
        if (!(await confirmFundsAction({
          title: 'Confirm Table Leave',
          action: `Leave SNG table seat ${onChainGameState.mySeatIndex + 1}`,
          table: activeTable,
          details: ['Only available before the SNG starts.'],
          transaction: tx,
        }))) {
          setLeavingTable(false);
          return;
        }
        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, 'confirmed');
        console.log('Left table on-chain:', sig);

      } catch (e: unknown) {
        console.error('Leave table TX failed:', e);
        showToast(getErrorMessage(e), 'error');
        setLeavingTable(false);
        return; // Don't navigate away if TX failed
      }
      setLeavingTable(false);
    }

    if (activeTable) removeActiveGame(activeTable);
    setActiveTable(null);
    setGameCompleteState(null);
    // Refresh queues and player data so lobby reflects the change
    try {
      const { queues } = await getQueuesOnChain(publicKey?.toBase58());
      setSitNGoQueues(queues);
    } catch (e) {}
    refreshPlayer(); // Refresh claimableSol after game
    setRefreshCounter(c => c + 1); // Also refresh balances
  };

  const handleClaimUnrefined = async () => {
    if (!publicKey || !sendTransaction || balances.unrefined <= 0) return;
    setClaiming(true);
    try {
      const connection = makeL1Connection();
      const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, publicKey);
      const [unrefinedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('unrefined'), publicKey.toBuffer()],
        STEEL_PROGRAM_ID
      );
      const [mintAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool')],
        STEEL_PROGRAM_ID
      );

      // ClaimAll discriminator = 6 (claims unrefined @ 90% + all refined in one TX)
      // Accounts: winner(signer), unrefined(mut), pool(mut), token_account(mut), mint(mut), mint_authority, token_program
      const data = Buffer.alloc(1);
      data.writeUInt8(6, 0);

      const ix = new TransactionInstruction({
        programId: STEEL_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: unrefinedPda, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: POKER_MINT, isSigner: false, isWritable: true },
          { pubkey: mintAuthority, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });

      const tx = new Transaction();

      // Create ATA if it doesn't exist (first time receiving POKER)
      try {
        await getAccount(connection, tokenAccount);
      } catch {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, tokenAccount, publicKey, POKER_MINT));
      }

      tx.add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
      if (!(await confirmFundsAction({
        title: 'Confirm $FP Claim',
        action: `Claim all ${RAW_YIELD_NAME}`,
        amount: `${balances.unrefined.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${RAW_YIELD_NAME}`,
        transaction: tx,
      }))) {
        return;
      }
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
      // Refresh all data immediately (balances, pool state, circulating supply)
      setRefreshCounter(c => c + 1);
    } catch (e: unknown) {
      console.error('Claim failed:', e);
      showToast('Claim failed: ' + getErrorMessage(e), 'error');
    } finally {
      setClaiming(false);
    }
  };

  const handleClaimSolWinnings = async () => {
    if (!publicKey || !sendTransaction || !player?.claimableSol) return;
    setClaimingSol(true);
    try {
      const connection = makeL1Connection();
      const [playerPda] = getPlayerPda(publicKey);

      // claim_sol_winnings: player(signer,mut), player_account(mut), system_program
      const ix = new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: playerPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: CLAIM_SOL_DISC,
      });

      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
      if (!(await confirmFundsAction({
        title: 'Confirm SOL Claim',
        action: 'Claim SNG SOL winnings',
        amount: `${(player.claimableSol / 1e9).toFixed(6).replace(/\.?0+$/, '')} SOL`,
        transaction: tx,
      }))) {
        return;
      }
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      showToast(`Claimed ${(player.claimableSol / 1e9).toFixed(4)} SOL!`, 'success');
      setRefreshCounter(c => c + 1);
    } catch (e: unknown) {
      console.error('Claim SOL failed:', e);
      showToast('Claim SOL failed: ' + getErrorMessage(e), 'error');
    } finally {
      setClaimingSol(false);
    }
  };

  return (
    <main className="min-h-screen max-w-[1280px] mx-auto w-full px-3 sm:px-5 pb-16 space-y-6">
      {/* Main Content */}
      <div>
        {!connected ? (
          /* ─── Landing Screen ─── */
          <div className="text-center py-20">
            <h2 className="font-display text-bone text-6xl md:text-8xl leading-none mb-4 tracking-wide">
              FAST <span className="text-orange">POKER</span>
            </h2>
            <p className="font-mono text-boneDim/70 text-sm mb-2 tracking-wider">
              Play to Mint. Burn to Earn. Deal to Earn.
            </p>
            <p className="font-mono text-boneDim/50 text-[11px] mb-10 max-w-lg mx-auto tracking-wider leading-relaxed">
              Join real cash games and Sit &amp; Go tournaments where poker action powers
              the $FP economy, dealer rewards, and protocol revenue sharing.
            </p>
            <div className="flex flex-col items-center gap-5">
              <button
                onClick={() => openConnect()}
                className="btn-orange px-6 h-11 rounded-md font-mono text-[11px] tracking-[0.22em] uppercase"
              >
                Sign In
              </button>
              <Link
                href="/how-to-play"
                className="font-mono text-[10px] tracking-[0.22em] text-boneDim/60 hover:text-orange transition px-3 py-1 rounded-sm hairline"
              >
                LEARN MORE &rarr;
              </Link>
            </div>

            {/* Browse SNG tiers pre-connect (read directly from chain; sign in to join) */}
            {sngPools && sngPools.length > 0 && (
              <div className="mt-14 max-w-3xl mx-auto">
                <div className="font-mono text-[10px] tracking-[0.22em] text-boneDim/60 mb-3">SIT &amp; GO TIERS &middot; LIVE</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {sngPools.slice(0, 12).map((p) => (
                    <button
                      key={`${p.gameType}-${p.tier}`}
                      onClick={() => openConnect()}
                      className="glass-room p-3 text-left hover:border-orange/40 transition"
                    >
                      <div className="font-display text-bone text-sm">
                        {p.tierName} <span className="text-boneDim/50 text-[10px] uppercase">{p.gameTypeName.replace('_', '-')}</span>
                      </div>
                      <div className="font-mono text-[10px] text-boneDim/60 mt-1">Buy-in {(p.totalBuyIn / 1e9).toFixed(3)} SOL</div>
                      <div className="font-mono text-[10px] text-emerald-400/80 mt-0.5">{p.queueCount} waiting</div>
                    </button>
                  ))}
                </div>
                <div className="font-mono text-[9px] text-boneDim/40 mt-3 tracking-wider">Sign in to join a tier.</div>
              </div>
            )}

            {/* Feature cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-16 max-w-3xl mx-auto">
              <div className="glass-room p-5 text-left">
                <div className="font-mono text-[10px] text-emerald-400 tracking-[0.22em] mb-3">PLAY TO MINT</div>
                <div className="flex flex-col items-start gap-1.5 mb-2">
                  <Image
                    src="/brand/app-icon.png"
                    alt="$FP"
                    width={18}
                    height={18}
                    className="rounded-full opacity-90 self-center"
                  />
                  <div className="font-display text-bone text-lg leading-none">Earn $FP</div>
                </div>
                <p className="font-mono text-boneDim/60 text-[11px] tracking-wider leading-relaxed">
                  SNG performance mints Raw $FP through the protocol emission curve.
                  Every eligible seat counts.
                </p>
              </div>
              <div className="glass-room p-5 text-left">
                <div className="font-mono text-[10px] text-amber tracking-[0.22em] mb-3">BURN TO EARN</div>
                <div className="font-display text-bone text-lg leading-none mb-2">Protocol revenue</div>
                <p className="font-mono text-boneDim/60 text-[11px] tracking-wider leading-relaxed">
                  Burn $FP into staking weight and collect rake routed through SOL,
                  $FP, USDC, and listed SPL vaults.
                </p>
              </div>
              <div className="glass-room p-5 text-left">
                <div className="font-mono text-[10px] text-orange tracking-[0.22em] mb-3">DEAL TO EARN</div>
                <div className="font-display text-bone text-lg leading-none mb-2">Operate the network</div>
                <p className="font-mono text-boneDim/60 text-[11px] tracking-wider leading-relaxed">
                  Licensed dealers move hands, settle flows, and earn from live
                  protocol activity.
                </p>
              </div>
            </div>
          </div>
        ) : playerLoading && !player ? (
          <div className="text-center py-24">
            <div className="w-6 h-6 border-2 border-gold/20 border-t-gold rounded-full animate-spin mx-auto mb-4" />
            <div className="font-mono text-boneDim/50 text-[10px] tracking-wider">LOADING PLAYER DATA...</div>
          </div>
        ) : !player?.isRegistered ? (
          /* ─── Registration Screen ─── */
          <div className="text-center py-20">
            <div className="glass-room inline-block p-8 max-w-md text-left">
              <div className="flex items-center gap-3 mb-5 pt-5">
                <div className="w-10 h-10 flex items-center justify-center flex-shrink-0">
                  <TokenIcon mint={POKER_MINT.toBase58()} size={40} alt="$FP" />
                </div>
                <div>
                  <div className="font-mono text-[9px] text-orange tracking-[0.25em]">ON-CHAIN REGISTRATION</div>
                  <div className="font-display text-bone text-xl leading-none mt-2.5">Register to play</div>
                </div>
              </div>
              <p className="font-mono text-boneDim/60 text-[11px] tracking-wider leading-relaxed mb-6">
                Create your on-chain player profile once, then join cash tables and SNGs
                with the same wallet.
              </p>
              <label className="flex items-center gap-2.5 rounded-sm border border-orange/20 bg-orange/[0.04] px-3 py-2.5 cursor-pointer mb-4">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={() => { if (termsAccepted) setTermsAccepted(false); else setShowConsentModal(true); }}
                  className="h-4 w-4 accent-orange shrink-0"
                />
                <span className="font-mono text-[10px] leading-snug text-boneDim/75">
                  I agree to the{' '}
                  <Link href="/terms" className="text-orange hover:text-orangeHi underline decoration-orange/30">
                    Terms of Service
                  </Link>
                  {' '}and{' '}
                  <Link href="/privacy" className="text-orange hover:text-orangeHi underline decoration-orange/30">
                    Privacy Policy
                  </Link>
                  .
                </span>
              </label>
              <ConsentModal
                open={showConsentModal}
                onClose={() => setShowConsentModal(false)}
                onAccept={() => setTermsAccepted(true)}
                title="Mainnet Beta: Read Before Playing"
                body={<PlayerConsentBody />}
                checkboxLabel={<>I have read, understood, and accept the <Link href="/terms" className="text-orange underline decoration-orange/30">Terms of Service</Link> and <Link href="/privacy" className="text-orange underline decoration-orange/30">Privacy Policy</Link>.</>}
                acceptLabel="I ACCEPT AND CONTINUE"
              />
              <button
                onClick={handleRegister}
                disabled={registering || !termsAccepted}
                className="btn-orange w-full px-6 py-3 rounded-sm font-mono text-[11px] tracking-[0.2em] font-bold disabled:opacity-50"
              >
                {registering ? 'REGISTERING...' : 'REGISTER AND PLAY'}
              </button>
              <p className="font-mono text-boneDim/45 text-[9px] mt-3 tracking-wider">
                {getRegistrationCost() > 0 ? `One-time cost: ${getRegistrationCost()} SOL` : 'Free · only pays network rent'}
              </p>
            </div>
          </div>
        ) : (
          <Lobby
            sngPools={sngPools}
            onJoinPool={handleJoinSngPool}
            onLeavePool={handleLeavePool}
            joiningPool={joiningPool}
            leavingPool={leavingPool}
            onResumeGame={(tablePda) => {
              // Ensure session is loaded before entering game view
              reloadSession();
              // Route through shared /game/[id] page (handles both cash and SNG)
              router.push(`/game?table=${tablePda}`);
              // Re-trigger ready flow in case it didn't complete previously
              const queue = sitNGoQueues.find(q => q.tablePda === tablePda);
              if (queue) {
                fetch('/api/sitngos/ready', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tablePda, playerCount: queue.maxPlayers }),
                }).then(r => r.json()).then(d => {
                  if (d.success) console.log('Ready flow triggered on resume:', d);
                  else console.log('Ready on resume pending:', d.error);
                }).catch(() => {});
              }
            }}
            balances={balances}
            poolState={poolState}
            player={player}
            sitNGoQueues={sitNGoQueues}
            session={{ isActive: session.isActive, sessionKey: !!session.sessionKey }}
            selectedTier={selectedTier}
            onTierChange={setSelectedTier}
          />
        )}
      </div>

      {/* Spacer for fixed footer */}
      <div className="h-10" />
    </main>
  );
}
