export type HandActionKind = 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL-IN';

export interface HandActionPlayerSnapshot {
  seatIndex: number;
  pubkey?: string;
  chips?: number;
  bet?: number;
  totalBetThisHand?: number;
  folded?: boolean;
  isAllIn?: boolean;
}

export interface HandActionSnapshot {
  handNumber: number;
  phase: string;
  currentPlayer: number;
  currentBet: number;
  pot: number;
  maxPlayers?: number;
  seatsFolded?: number;
  seatsAllin?: number;
  players: HandActionPlayerSnapshot[];
}

export interface ClassifiedHandAction {
  seatIndex: number;
  kind: HandActionKind;
  amount?: number;
  phase: string;
}

const BETTING_PHASES = new Set(['PreFlop', 'Flop', 'Turn', 'River']);
const MAX_MASK_SEATS = 16;

function seatBit(seatIndex: number): number {
  return 1 << seatIndex;
}

function playerMask(
  players: HandActionPlayerSnapshot[],
  predicate: (player: HandActionPlayerSnapshot) => boolean,
): number {
  let mask = 0;
  for (const player of players) {
    if (
      Number.isInteger(player.seatIndex) &&
      player.seatIndex >= 0 &&
      player.seatIndex < MAX_MASK_SEATS &&
      predicate(player)
    ) {
      mask |= seatBit(player.seatIndex);
    }
  }
  return mask;
}

function maxSeats(prev: HandActionSnapshot, curr: HandActionSnapshot): number {
  const highestSeat =
    Math.max(
      -1,
      ...prev.players.map((p) => p.seatIndex),
      ...curr.players.map((p) => p.seatIndex),
    ) + 1;
  return Math.min(
    MAX_MASK_SEATS,
    Math.max(prev.maxPlayers || 0, curr.maxPlayers || 0, highestSeat, 0),
  );
}

function changedSeats(prevMask: number, currMask: number, seats: number): number[] {
  const changed = currMask & ~prevMask;
  const out: number[] = [];
  for (let seat = 0; seat < seats; seat++) {
    if ((changed & seatBit(seat)) !== 0) out.push(seat);
  }
  return out;
}

function bySeat(players: HandActionPlayerSnapshot[]): Map<number, HandActionPlayerSnapshot> {
  return new Map(players.map((player) => [player.seatIndex, player]));
}

function positiveDelta(prevValue: unknown, currValue: unknown): number {
  if (typeof prevValue !== 'number' || typeof currValue !== 'number') return 0;
  const delta = currValue - prevValue;
  return delta > 0 ? delta : 0;
}

function seatContribution(
  prevPlayers: Map<number, HandActionPlayerSnapshot>,
  currPlayers: Map<number, HandActionPlayerSnapshot>,
  seatIndex: number,
  potDelta: number,
  allowPotFallback: boolean,
): number | undefined {
  const prev = prevPlayers.get(seatIndex);
  const curr = currPlayers.get(seatIndex);
  if (prev && curr) {
    const chipDelta =
      typeof prev.chips === 'number' && typeof curr.chips === 'number'
        ? prev.chips - curr.chips
        : 0;
    if (chipDelta > 0) return chipDelta;

    const totalBetDelta = positiveDelta(prev.totalBetThisHand, curr.totalBetThisHand);
    if (totalBetDelta > 0) return totalBetDelta;

    const betDelta = positiveDelta(prev.bet, curr.bet);
    if (betDelta > 0) return betDelta;
  }
  return allowPotFallback && potDelta > 0 ? potDelta : undefined;
}

export function classifyHandActions(
  prev: HandActionSnapshot | null | undefined,
  curr: HandActionSnapshot | null | undefined,
): ClassifiedHandAction[] {
  if (!prev || !curr) return [];
  if (prev.handNumber !== curr.handNumber) return [];
  if (!BETTING_PHASES.has(prev.phase)) return [];

  const seats = maxSeats(prev, curr);
  const prevPlayers = bySeat(prev.players);
  const currPlayers = bySeat(curr.players);
  const potDelta = curr.pot > prev.pot ? curr.pot - prev.pot : 0;
  const actions: ClassifiedHandAction[] = [];
  const loggedSeats = new Set<number>();
  const phase = prev.phase;

  const prevFolded = prev.seatsFolded ?? playerMask(prev.players, (p) => p.folded === true);
  const currFolded = curr.seatsFolded ?? playerMask(curr.players, (p) => p.folded === true);
  for (const seatIndex of changedSeats(prevFolded, currFolded, seats)) {
    actions.push({ seatIndex, kind: 'FOLD', phase });
    loggedSeats.add(seatIndex);
  }

  const prevAllin = prev.seatsAllin ?? playerMask(prev.players, (p) => p.isAllIn === true);
  const currAllin = curr.seatsAllin ?? playerMask(curr.players, (p) => p.isAllIn === true);
  const allinSeats = changedSeats(prevAllin, currAllin, seats)
    .filter((seatIndex) => !loggedSeats.has(seatIndex));
  for (const seatIndex of allinSeats) {
    actions.push({
      seatIndex,
      kind: 'ALL-IN',
      amount: seatContribution(prevPlayers, currPlayers, seatIndex, potDelta, allinSeats.length === 1),
      phase,
    });
    loggedSeats.add(seatIndex);
  }

  const actor = prev.currentPlayer;
  const actorTurnEnded =
    Number.isInteger(actor) &&
    actor >= 0 &&
    actor < seats &&
    (actor !== curr.currentPlayer || prev.phase !== curr.phase);
  if (!actorTurnEnded) return actions;
  const hasMaskActions = actions.length > 0;

  const prevTableBet = prev.currentBet || 0;
  const currTableBet = curr.currentBet || 0;

  // One tick can carry MULTIPLE actions (poll jitter / WS gaps): the actor
  // called AND a later seat raised before this snapshot landed. Single-actor
  // attribution logged that raise under the caller's name. Classify every
  // seat that committed chips this tick, walking in turn order from the
  // actor; when the table bet rose, the LAST committed seat whose street bet
  // matches the new table bet owns the BET/RAISE and the seats before it
  // called. Intermediate checks leave no chip trace and stay undetectable in
  // a merged tick; the single-actor CHECK path below still covers them when
  // the tick carries one action.
  const committed: { seatIndex: number; amount: number }[] = [];
  for (let offset = 0; offset < seats; offset++) {
    const seatIndex = (actor + offset) % seats;
    if (loggedSeats.has(seatIndex)) continue;
    const amount = seatContribution(prevPlayers, currPlayers, seatIndex, 0, false);
    if (amount && amount > 0) committed.push({ seatIndex, amount });
  }

  if (committed.length > 0) {
    let raiserIdx = -1;
    if (currTableBet > prevTableBet) {
      for (let i = committed.length - 1; i >= 0; i--) {
        const bet = currPlayers.get(committed[i].seatIndex)?.bet;
        // A committed seat with lagged bet data can still be the raiser when
        // no later seat in turn order matches the table bet.
        if (typeof bet !== 'number' || bet >= currTableBet) {
          raiserIdx = i;
          break;
        }
      }
      if (raiserIdx < 0) raiserIdx = committed.length - 1;
    }
    committed.forEach((entry, index) => {
      if (index === raiserIdx) {
        actions.push({
          seatIndex: entry.seatIndex,
          kind: prevTableBet > 0 ? 'RAISE' : 'BET',
          amount: currTableBet,
          phase,
        });
      } else {
        actions.push({ seatIndex: entry.seatIndex, kind: 'CALL', amount: entry.amount, phase });
      }
      loggedSeats.add(entry.seatIndex);
    });
    return actions;
  }

  if (loggedSeats.has(actor)) return actions;
  const contribution = seatContribution(prevPlayers, currPlayers, actor, potDelta, true);

  if (currTableBet > prevTableBet) {
    actions.push({
      seatIndex: actor,
      kind: prevTableBet > 0 ? 'RAISE' : 'BET',
      amount: currTableBet,
      phase,
    });
  } else if (contribution && contribution > 0) {
    actions.push({ seatIndex: actor, kind: 'CALL', amount: contribution, phase });
  } else if (!hasMaskActions) {
    // Turn ended with no chips committed and no fold/all-in mask change THIS tick.
    // You can only CHECK when nothing is owed; if the actor's street commitment
    // is short of the table bet they were facing a bet and cannot check — this is
    // a FOLD whose seats_folded mask simply hasn't landed yet (the seat WS lags
    // the table turn-advance). Misreading it as CHECK was the "folded but showed
    // CHECK" report. Only reclassify when we actually have the actor's bet value
    // (otherwise keep CHECK so a BB option with missing data isn't mislabeled).
    const actorBet = currPlayers.get(actor)?.bet ?? prevPlayers.get(actor)?.bet;
    const facingBet = typeof actorBet === 'number' && currTableBet > actorBet;
    actions.push({ seatIndex: actor, kind: facingBet ? 'FOLD' : 'CHECK', phase });
  }

  return actions;
}
