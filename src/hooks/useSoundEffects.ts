/**
 * useSoundEffects — React hook that monitors game state and plays poker sounds.
 *
 * Detects phase transitions, player actions, turn changes, and timer events
 * to trigger the appropriate sound from sfx.ts.
 */
import { useEffect, useRef } from 'react';
import { SFX } from '@/lib/sfx';

interface PlayerInfo {
  pubkey: string;
  chips: number;
  bet: number;
  folded: boolean;
  isActive: boolean;
  seatIndex: number;
}

interface SoundEffectsState {
  phase: string;
  pot: number;
  currentPlayer: number;
  communityCards: number[];
  players: PlayerInfo[];
  isMyTurn: boolean;
  myCards?: [number, number];
  timeLeft?: number;
  handNumber?: number;
}

export function useSoundEffects(state: SoundEffectsState | null) {
  const prevStateRef = useRef<SoundEffectsState | null>(null);
  const lastTurnSoundRef = useRef(0);

  useEffect(() => {
    if (!state) return;
    const prev = prevStateRef.current;
    prevStateRef.current = state;

    // Skip on first render (no previous state to compare)
    if (!prev) return;

    const prevPhase = prev.phase;
    const currPhase = state.phase;

    // ─── Phase transitions ───

    // New hand started (Waiting -> PreFlop)
    if (prevPhase === 'Waiting' && currPhase === 'PreFlop') {
      SFX.play('dealing');
    }

    // Flop dealt (PreFlop -> Flop or FlopRevealPending -> Flop)
    if ((prevPhase === 'PreFlop' || prevPhase === 'FlopRevealPending') && currPhase === 'Flop') {
      setTimeout(() => SFX.play('dealing'), 60);
    }

    // Turn dealt
    if ((prevPhase === 'Flop' || prevPhase === 'TurnRevealPending') && currPhase === 'Turn') {
      SFX.play('card-flip');
    }

    // River dealt (mockup calls card-flip for BigPot = river)
    if ((prevPhase === 'Turn' || prevPhase === 'RiverRevealPending') && currPhase === 'River') {
      SFX.play('card-flip');
    }

    // Showdown / pot collected
    if (prevPhase !== 'Showdown' && prevPhase !== 'Complete' &&
        (currPhase === 'Showdown' || currPhase === 'Complete')) {
      setTimeout(() => SFX.play('chip-pot'), 400);
    }

    // Dealer button moved (hand restarted)
    if (prevPhase !== 'Waiting' && currPhase === 'Waiting') {
      SFX.play('dealer-move');
    }

    // SidePots state (chip-stack per mockup)
    if (currPhase === 'SidePots' && prevPhase !== 'SidePots') {
      SFX.play('chip-stack');
    }

    // ─── Player action sounds ───
    const BETTING_PHASES = ['PreFlop', 'Flop', 'Turn', 'River'];
    if (BETTING_PHASES.includes(currPhase) && prevPhase === currPhase) {
      if (prev.currentPlayer !== state.currentPlayer && prev.currentPlayer >= 0) {
        const actingPlayer = prev.players.find(p => p.seatIndex === prev.currentPlayer);
        const actingPlayerNow = state.players.find(p => p.seatIndex === prev.currentPlayer);

        if (actingPlayer && actingPlayerNow) {
          if (!actingPlayer.folded && actingPlayerNow.folded) {
            // fold already played on button click; hook acts as fallback for remote players
            SFX.play('fold');
          } else if (actingPlayerNow.bet > actingPlayer.bet) {
            if (actingPlayerNow.chips === 0 && actingPlayer.chips > 0) {
              SFX.play('all-in');
            } else {
              SFX.play('chip-bet');
            }
          } else if (!actingPlayerNow.folded && actingPlayerNow.bet === actingPlayer.bet) {
            SFX.play('check');
          }
        }
      }
    }

    // Pot collected (win)
    if ((currPhase === 'Showdown' || currPhase === 'Complete') &&
        (prevPhase === 'Showdown' || prevPhase === 'Complete')) {
      if (prev.pot > 0 && state.pot === 0) {
        SFX.play('chip-pot');
      }
    }

    // ─── My turn notification ───
    if (state.isMyTurn && !prev.isMyTurn) {
      const now = Date.now();
      if (now - lastTurnSoundRef.current > 2000) {
        // 'yourTurn' is not in the mockup SFX library; closest is 'ui-tap'
        SFX.play('ui-tap');
        lastTurnSoundRef.current = now;
      }
    }
  }, [state]);

  // ─── Timer warning sounds (mockup: <=5s tick, <=2s crit) ───
  useEffect(() => {
    if (!state?.isMyTurn || state.timeLeft === undefined) return;
    const t = state.timeLeft;
    if (t > 0 && t <= 2) {
      SFX.play('timer-crit');
    } else if (t > 2 && t <= 5) {
      SFX.play('timer-tick');
    }
  }, [state?.timeLeft, state?.isMyTurn]);

  return { SFX };
}
