// SnG Duels: builds the `sng_duel_action` instruction (submit a Bell-duel choice).
// Runs on the ER via the seat's session key, like a normal in-hand action.
// Contract: programs/fastpoker/src/instructions/sng_duel.rs (SngDuelAction).
//   args:     action: u8  (1 = all-in/call-in, 2 = fold)
//   accounts: signer, table(mut), deck_state(mut), sng_duel_state(mut),
//             seat_a(mut), seat_b(mut), seat_cards_a(mut), seat_cards_b(mut),
//             hand_report_buffer(mut)

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { ANCHOR_PROGRAM_ID, DECK_STATE_SEED } from './constants';
import { ixDisc } from './discriminators';
import { getSeatPda, getSeatCardsPda } from './pda';
import { getHandReportBufferPda } from './onchain-game';
import { getSngDuelPda, DuelChoice } from './sng-duel';

const SNG_DUEL_ACTION_DISCRIMINATOR = ixDisc('sng_duel_action');

export function getDeckStatePda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(DECK_STATE_SEED), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
}

/** action: 'all-in' -> DuelChoice.CallIn(1), 'fold' -> DuelChoice.Fold(2). */
export function duelChoiceCode(action: 'all-in' | 'fold'): number {
  return action === 'all-in' ? DuelChoice.CallIn : DuelChoice.Fold;
}

export function buildSngDuelActionInstruction(
  signer: PublicKey,
  tablePda: PublicKey,
  seatA: number,
  seatB: number,
  action: 'all-in' | 'fold',
): TransactionInstruction {
  const [deckStatePda] = getDeckStatePda(tablePda);
  const [sngDuelStatePda] = getSngDuelPda(tablePda);
  const [seatAPda] = getSeatPda(tablePda, seatA);
  const [seatBPda] = getSeatPda(tablePda, seatB);
  const [seatCardsAPda] = getSeatCardsPda(tablePda, seatA);
  const [seatCardsBPda] = getSeatCardsPda(tablePda, seatB);
  const [handReportBufferPda] = getHandReportBufferPda(tablePda);

  const data = Buffer.alloc(9); // disc(8) + action(1)
  SNG_DUEL_ACTION_DISCRIMINATOR.copy(data, 0);
  data.writeUInt8(duelChoiceCode(action), 8);

  const keys = [
    { pubkey: signer, isSigner: true, isWritable: false },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: deckStatePda, isSigner: false, isWritable: true },
    { pubkey: sngDuelStatePda, isSigner: false, isWritable: true },
    { pubkey: seatAPda, isSigner: false, isWritable: true },
    { pubkey: seatBPda, isSigner: false, isWritable: true },
    { pubkey: seatCardsAPda, isSigner: false, isWritable: true },
    { pubkey: seatCardsBPda, isSigner: false, isWritable: true },
    { pubkey: handReportBufferPda, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({ programId: ANCHOR_PROGRAM_ID, keys, data });
}
