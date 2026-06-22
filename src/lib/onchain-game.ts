import {
  AccountMeta,
  type AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { ANCHOR_PROGRAM_ID, FASTPOKER_REGISTRY_PROGRAM_ID, PERMISSION_PROGRAM_ID, POOL_PDA, TREASURY, STEEL_PROGRAM_ID, TABLE_SEED, SEAT_SEED, PROTOCOL_GUARD_SEED, SEAT_CARDS_SEED, PLAYER_SEED, VAULT_SEED, RECEIPT_SEED, DEPOSIT_PROOF_SEED, DECK_STATE_SEED, GLOBAL_ENTROPY_SEED, CRANK_TALLY_ER_SEED, CRANK_TALLY_L1_SEED, TEE_VALIDATOR, SNG_POOL_SEED, SNG_POOL_VAULT_SEED, SNG_QUEUE_PAGE_SEED, SNG_QUEUE_MARKER_SEED, SNG_MATCH_SEED, SNG_TABLE_SEED, CRANK_OPERATOR_SEED, JACKPOT_GLOBAL_SEED, JACKPOT_BUCKET_SEED, JACKPOT_ENTRY_SEED, SNG_JACKPOT_TABLE_STATE_SEED, TIER_CONFIG_SEED, isPremiumTokenMint, requiresTokenTierConfig } from './constants';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import { IX_DISC, accountDisc, ixDisc } from './discriminators';

// Anchor instruction discriminators (SHA256("global:<instruction_name>")[0..8])
// Verified from cash-game-1-2-test.ts
const DISCRIMINATORS = {
  createTable: ixDisc('create_table'),
  startGame: IX_DISC.startGame,
  playerAction: IX_DISC.playerAction,
  settle: IX_DISC.settleHand,
  delegateGame: ixDisc('delegate_game'),
  leaveTable: ixDisc('leave_table'),
  distributePrizes: IX_DISC.distributePrizes,
  createUserTable: ixDisc('create_user_table'),
  addWhitelist: ixDisc('add_whitelist'),
  removeWhitelist: ixDisc('remove_whitelist'),
  claimCreatorRake: ixDisc('claim_creator_rake'),
  rebuy: ixDisc('rebuy'),
  closeTable: IX_DISC.closeTable,
  cleanupTablePermissions: IX_DISC.cleanupTablePermissions,
  cleanupTableAccounts: IX_DISC.cleanupTableAccounts,
  placeBid: ixDisc('place_bid'),
  resolveAuction: IX_DISC.resolveAuction,
  initRakeVault: ixDisc('init_rake_vault'),
  depositToVault: ixDisc('deposit_to_vault'),
  claimRakeReward: ixDisc('claim_rake_reward'),
  sitOut: ixDisc('sit_out'),
  sitIn: ixDisc('sit_in'),
  processRakeDistribution: ixDisc('process_rake_distribution'),
  clearAccumulatedRake: ixDisc('clear_accumulated_rake'),
  resizeVault: IX_DISC.resizeVault,
  commitState: IX_DISC.commitState,
  settleTableRewards: IX_DISC.settleTableRewards,
  initCrankRewardState: IX_DISC.initCrankRewardState,
  initOperatorClaim: IX_DISC.initOperatorClaim,
  initOperatorRewardTotal: IX_DISC.initOperatorRewardTotal,
  updateOpClaimWeight: IX_DISC.updateOpClaimWeight,
  updateAccRewardPerWeight: IX_DISC.updateAccRewardPerWeight,
  claimOperatorRewards: IX_DISC.claimOperatorRewards,
  claimOperatorTokenRewards: IX_DISC.claimOperatorTokenRewards,
  // Pre-created seats architecture
  initTableSeat: ixDisc('init_table_seat'),
  delegateTable: IX_DISC.delegateTable,
  delegateSeat: IX_DISC.delegateSeat,
  delegateSeatCards: IX_DISC.delegateSeatCards,
  delegateDepositProof: ixDisc('delegate_deposit_proof'),
  delegateDeckState: IX_DISC.delegateDeckState,
  delegateSlimBuffer: IX_DISC.delegateSlimBuffer,
  delegatePermission: IX_DISC.delegatePermission,
  depositForJoin: ixDisc('deposit_for_join'),
  seatPlayer: ixDisc('seat_player'),
  cleanupDepositProof: IX_DISC.cleanupDepositProof,
  cleanupSeatCards: IX_DISC.cleanupSeatCards,
  crankRemovePlayer: IX_DISC.crankRemovePlayer,
  initializeAuctionConfig: ixDisc('initialize_auction_config'),
  // TEE permission creation + delegation (required for getAccountInfo on TEE)
  createTablePermission: ixDisc('create_table_permission'),
  createSeatPermission: ixDisc('create_seat_permission'),
  createDeckStatePermission: ixDisc('create_deck_state_permission'),
  updateDeckStatePermission: ixDisc('update_deck_state_permission'),
  createGlobalEntropyPermission: ixDisc('create_global_entropy_permission'),
  delegateTablePermission: ixDisc('delegate_table_permission'),
  delegateSeatPermission: ixDisc('delegate_seat_permission'),
  delegateDeckStatePermission: ixDisc('delegate_deck_state_permission'),
  delegateGlobalEntropyPermission: ixDisc('delegate_global_entropy_permission'),
  contributeGlobalEntropy: IX_DISC.contributeGlobalEntropy,
  resetSeatPermission: IX_DISC.resetSeatPermission,
  depositTopup: ixDisc('deposit_topup'),
  applyTopup: ixDisc('apply_topup'),
  initTipJar: IX_DISC.initTipJar,
  initHandReportBuffer: IX_DISC.initHandReportBuffer,
  initHandReportFlushState: IX_DISC.initHandReportFlushState,
  commitAndUndelegateTable: IX_DISC.commitAndUndelegateTable,
  refundFailedDeposit: IX_DISC.refundFailedDeposit,
  clearStaleJoinMarker: IX_DISC.clearStaleJoinMarker,
  useTimeBank: ixDisc('use_time_bank'),
  updateApprovedSigner: IX_DISC.updateApprovedSigner,
  adminListToken: ixDisc('admin_list_token'),
  adminSetAuctionDuration: IX_DISC.adminSetAuctionDuration,
  adminCloseAuctionConfig: IX_DISC.adminCloseAuctionConfig,
  adminCloseAuctionState: IX_DISC.adminCloseAuctionState,
  adminCloseGlobalBid: IX_DISC.adminCloseGlobalBid,
  adminCloseListedToken: IX_DISC.adminCloseListedToken,
  adminCloseGlobalContribution: IX_DISC.adminCloseGlobalContribution,
  // readyUp removed — SNG pool seats players directly.
  kickUnready: IX_DISC.kickUnready,
  handleBlindTimeout: IX_DISC.handleBlindTimeout,
  initCrankTallyEr: IX_DISC.initCrankTallyEr,
  delegateCrankTally: IX_DISC.delegateCrankTally,
  initSngPool: IX_DISC.initSngPool,
  initSngQueuePage: IX_DISC.initSngQueuePage,
  compactSngQueuePages: IX_DISC.compactSngQueuePages,
  closeEmptySngQueuePage: IX_DISC.closeEmptySngQueuePage,
  closeCompletedSngMatch: IX_DISC.closeCompletedSngMatch,
  joinSngPool: IX_DISC.joinSngPool,
  leaveSngPool: IX_DISC.leaveSngPool,
  prepareSngMatch: IX_DISC.prepareSngMatch,
  finalizeSngMatch: IX_DISC.finalizeSngMatch,
  seatFromPool: IX_DISC.seatFromPool,
  cancelSngMatch: IX_DISC.cancelSngMatch,
  resizeCrankTally: IX_DISC.resizeCrankTally,
};

const MAGIC_PROGRAM_ID = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT_ID = new PublicKey('MagicContext1111111111111111111111111111111');
const MAGIC_FEE_VAULT = new PublicKey('EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b');
const EPHEMERAL_VAULT_ID = new PublicKey('MagicVau1t999999999999999999999999999999999');

export const HAND_REPORT_BUFFER_HEADER_SIZE = 52;
export const HAND_REPORT_FLUSH_STATE_SIZE = 88;
export const HAND_REPORT_DEFAULT_CAPACITY = 10_188;

// Game type values matching Anchor enum
export enum OnChainGameType {
  SitAndGoHeadsUp = 0,
  SitAndGo6Max = 1,
  SitAndGo9Max = 2,
  CashGame = 3,
}

// Stakes values matching Anchor enum
export enum OnChainStakes {
  Micro = 0,  // 5/10
  Low = 1,    // 10/20
  Mid = 2,    // 25/50
  High = 3,   // 50/100
}

// Game phase values from on-chain
export enum OnChainPhase {
  Waiting = 0,
  Starting = 1,
  Preflop = 2,
  Flop = 3,
  Turn = 4,
  River = 5,
  Showdown = 6,
  Complete = 7,
  FlopRevealPending = 8,
  TurnRevealPending = 9,
  RiverRevealPending = 10,
}

// Seat status (must match Anchor SeatStatus enum in seat.rs)
export enum SeatStatus {
  Empty = 0,
  Active = 1,
  Folded = 2,
  AllIn = 3,
  SittingOut = 4,
  Busted = 5,
  Leaving = 6,
}

// Action type values (must match Anchor PokerAction enum)
export enum ActionType {
  Fold = 0,
  Check = 1,
  Call = 2,
  Bet = 3,
  Raise = 4,
  AllIn = 5,
  SitOut = 6,
  ReturnToPlay = 7,
  LeaveCashGame = 8,
}

// PDA derivation functions
export function getTablePda(tableId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(TABLE_SEED), Buffer.from(tableId)],
    ANCHOR_PROGRAM_ID
  );
}

export function getSeatPda(tablePda: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEAT_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    ANCHOR_PROGRAM_ID
  );
}

export function getSeatCardsPda(tablePda: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEAT_CARDS_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    ANCHOR_PROGRAM_ID
  );
}

export function getPlayerPda(playerPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PLAYER_SEED), playerPubkey.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

// Generate unique table ID
export function generateTableId(prefix: string = 'sng'): Uint8Array {
  const tableId = new Uint8Array(32);
  const idStr = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const encoder = new TextEncoder();
  const encoded = encoder.encode(idStr);
  tableId.set(encoded.slice(0, Math.min(encoded.length, 32)));
  return tableId;
}

/**
 * Build create_table instruction
 */
export function buildCreateTableInstruction(
  authority: PublicKey,
  tableId: Uint8Array,
  gameType: OnChainGameType,
  stakes: OnChainStakes,
  maxPlayers: number,
  tier: number = 0 // SnGTier enum: 0=Copper,1=Bronze,...6=Black
): { instruction: TransactionInstruction; tablePda: PublicKey } {
  const [tablePda] = getTablePda(tableId);

  // Build instruction data: discriminator(8) + table_id(32) + game_type(1) + stakes(1) + max_players(1) + tier(1)
  const data = Buffer.alloc(8 + 32 + 4);
  DISCRIMINATORS.createTable.copy(data, 0);
  Buffer.from(tableId).copy(data, 8);
  data.writeUInt8(gameType, 40);
  data.writeUInt8(stakes, 41);
  data.writeUInt8(maxPlayers, 42);
  data.writeUInt8(tier, 43);

  const keys = [
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: POOL_PDA, isSigner: false, isWritable: false },
    { pubkey: getSlimBufferPda(tablePda)[0], isSigner: false, isWritable: true },
    { pubkey: getCrankActionL1Pda(tablePda, authority)[0], isSigner: false, isWritable: true },
    { pubkey: getOperatorRewardTotalL1Pda(tablePda)[0], isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  if (gameType !== OnChainGameType.CashGame) {
    keys.push(
      { pubkey: getSngPoolPda(gameType, tier)[0], isSigner: false, isWritable: true },
      { pubkey: getCrankOperatorPda(authority)[0], isSigner: false, isWritable: false },
    );
  }

  const instruction = new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });

  return { instruction, tablePda };
}

// Get player-table marker PDA (prevents same player joining multiple seats)
export function getPlayerTableMarkerPda(player: PublicKey, tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('player_table'), player.toBuffer(), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getVaultPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getTipJarPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('tip_jar'), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getHandReportBufferPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('hand_report_buf'), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getHandReportFlushStatePda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('hand_report_flush'), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getCrankTallyErPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(CRANK_TALLY_ER_SEED), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getCrankTallyL1Pda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(CRANK_TALLY_L1_SEED), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getReceiptPda(tablePda: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(RECEIPT_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    ANCHOR_PROGRAM_ID
  );
}

export function getDepositProofPda(tablePda: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(DEPOSIT_PROOF_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    ANCHOR_PROGRAM_ID
  );
}

export function getJackpotEntryPda(tablePda: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(JACKPOT_ENTRY_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    ANCHOR_PROGRAM_ID,
  );
}

export function getJackpotBucketPda(gameType: number, tier: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(JACKPOT_BUCKET_SEED), Buffer.from([gameType]), Buffer.from([tier])],
    ANCHOR_PROGRAM_ID,
  );
}

export function getSngJackpotTableStatePda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SNG_JACKPOT_TABLE_STATE_SEED), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
}

export function getDeckStatePda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(DECK_STATE_SEED), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getGlobalEntropyPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(GLOBAL_ENTROPY_SEED)],
    ANCHOR_PROGRAM_ID
  );
}

export function buildContributeGlobalEntropyInstruction(
  caller: PublicKey,
  entropyKey: PublicKey = Keypair.generate().publicKey,
): TransactionInstruction {
  const data = Buffer.concat([DISCRIMINATORS.contributeGlobalEntropy, entropyKey.toBuffer()]);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: false },
      { pubkey: getGlobalEntropyPda()[0], isSigner: false, isWritable: true },
    ],
    data,
  });
}

export function getSlimBufferPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('slim_buffer'), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getCrankRewardStatePda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('crank_reward_state'), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getOperatorRewardTotalErPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('op_reward_total_er'), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getOperatorRewardTotalL1Pda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('op_reward_total_l1'), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getCrankActionL1Pda(tablePda: PublicKey, operator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('crank_action_l1'), tablePda.toBuffer(), operator.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getCrankActionErPda(tablePda: PublicKey, operator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('crank_action_er'), tablePda.toBuffer(), operator.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getOperatorClaimPda(tablePda: PublicKey, operator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('op_claim'), tablePda.toBuffer(), operator.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getDealerLicensePda(operator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dealer_license'), operator.toBuffer()],
    FASTPOKER_REGISTRY_PROGRAM_ID
  );
}

export function getValidatorRegistryPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('validator_registry')],
    ANCHOR_PROGRAM_ID
  );
}

export function buildInitCrankTallyErInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
): TransactionInstruction {
  const [tallyPda] = getCrankTallyErPda(tablePda);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data: DISCRIMINATORS.initCrankTallyEr,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: tallyPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function buildDelegateCrankTallyInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  delegBuf: PublicKey,
  delegRec: PublicKey,
  delegMeta: PublicKey,
  delegationProgramId: PublicKey,
): TransactionInstruction {
  const [tallyPda] = getCrankTallyErPda(tablePda);
  const [validatorRegistryPda] = getValidatorRegistryPda();
  const data = Buffer.alloc(40);
  DISCRIMINATORS.delegateCrankTally.copy(data, 0);
  tablePda.toBuffer().copy(data, 8);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: delegBuf, isSigner: false, isWritable: true },
      { pubkey: delegRec, isSigner: false, isWritable: true },
      { pubkey: delegMeta, isSigner: false, isWritable: true },
      { pubkey: tallyPda, isSigner: false, isWritable: true },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildDelegateSlimBufferInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  delegBuf: PublicKey,
  delegRec: PublicKey,
  delegMeta: PublicKey,
  delegationProgramId: PublicKey,
): TransactionInstruction {
  const [slimBufferPda] = getSlimBufferPda(tablePda);
  const [validatorRegistryPda] = getValidatorRegistryPda();
  const data = Buffer.alloc(40);
  DISCRIMINATORS.delegateSlimBuffer.copy(data, 0);
  tablePda.toBuffer().copy(data, 8);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: delegBuf, isSigner: false, isWritable: true },
      { pubkey: delegRec, isSigner: false, isWritable: true },
      { pubkey: delegMeta, isSigner: false, isWritable: true },
      { pubkey: slimBufferPda, isSigner: false, isWritable: true },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build crank_remove_player instruction (permissionless inactive-seat kick)
 */
export function buildCrankRemovePlayerInstruction(
  caller: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  playerWallet: PublicKey,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [unclaimedPda] = getUnclaimedBalancePda(tablePda, playerWallet);
  const [markerPda] = getPlayerTableMarkerPda(playerWallet, tablePda);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: unclaimedPda, isSigner: false, isWritable: true },
      { pubkey: markerPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.crankRemovePlayer,
  });
}

/**
 * Build start_game instruction (called by authority/crank)
 * Contract-level guard: requires deck_state and, for SNGs after hand 0,
 * the table jackpot state proving the prior hand was settled.
 * On TEE, writable accounts that aren't delegated are rejected,
 * preventing games from starting with partially-delegated accounts.
 */
export function buildStartGameInstruction(
  authority: PublicKey,
  tablePda: PublicKey,
  maxPlayers: number = 2,
  seatsOccupied: number = (1 << maxPlayers) - 1,
  gameType: number = 3,
  privateWhitelistWallets: PublicKey[] = [],
): TransactionInstruction {
  const data = Buffer.alloc(8);
  DISCRIMINATORS.startGame.copy(data, 0);

  const keys = [
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: getDeckStatePda(tablePda)[0], isSigner: false, isWritable: true },
  ];
  // remaining_accounts: occupied seats, plus SNG jackpot state for the
  // previous-hand settlement guard.
  for (let i = 0; i < maxPlayers; i++) {
    if (seatsOccupied & (1 << i)) {
      keys.push({ pubkey: getSeatPda(tablePda, i)[0], isSigner: false, isWritable: true });
    }
  }
  for (const wallet of privateWhitelistWallets) {
    keys.push({ pubkey: getWhitelistPda(tablePda, wallet)[0], isSigner: false, isWritable: false });
  }
  if (gameType !== 3) {
    keys.push({ pubkey: getSngJackpotTableStatePda(tablePda)[0], isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });
}

// MagicBlock Delegation Program ID
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

/**
 * Build player_action instruction
 * OPEN-4: Now includes 32 bytes of random entropy + deck_state as remaining_account
 */
export function buildPlayerActionInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  action: ActionType,
  amount?: number,
  maxPlayers: number = 0,
  seatsOccupied: number = 0,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  // OPEN-4: Generate 32 bytes of random entropy
  const entropyBytes = Keypair.generate().publicKey.toBuffer();

  // disc(8) + action_type(1) + amount(8) + entropy(32) = 49 bytes
  const data = Buffer.alloc(17 + 32);
  DISCRIMINATORS.playerAction.copy(data, 0);
  data.writeUInt8(action, 8);
  
  if (amount !== undefined) {
    data.writeBigUInt64LE(BigInt(amount), 9);
  }
  entropyBytes.copy(data, 17);

  const keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
    { pubkey: player, isSigner: true, isWritable: false },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: seatPda, isSigner: false, isWritable: true },
  ];

  const isBettingAction =
    action === ActionType.Fold ||
    action === ActionType.Check ||
    action === ActionType.Call ||
    action === ActionType.Bet ||
    action === ActionType.Raise ||
    action === ActionType.AllIn;

  if (isBettingAction) {
    const [deckStatePda] = getDeckStatePda(tablePda);
    const [globalEntropyPda] = getGlobalEntropyPda();
    const [handReportBufferPda] = getHandReportBufferPda(tablePda);
    keys.push(
      { pubkey: deckStatePda, isSigner: false, isWritable: true },
      { pubkey: globalEntropyPda, isSigner: false, isWritable: true },
      { pubkey: handReportBufferPda, isSigner: false, isWritable: true },
    );
    for (let i = 0; i < maxPlayers; i++) {
      if (i !== seatIndex && (seatsOccupied & (1 << i))) {
        keys.push({ pubkey: getSeatPda(tablePda, i)[0], isSigner: false, isWritable: false });
      }
    }
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build update_approved_signer instruction — wallet-signed, rotates seat.approved_signer.
 * Normal SNG pool seating writes the queued session signer in seat_from_pool.
 * This remains as a recovery/rotation path when a player changes session keys.
 */
export function buildUpdateApprovedSignerInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  newApprovedSigner: PublicKey,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const data = Buffer.alloc(8 + 32);
  DISCRIMINATORS.updateApprovedSigner.copy(data, 0);
  newApprovedSigner.toBuffer().copy(data, 8);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// buildReadyUpInstruction removed (2026-04-23) — SNG pool seats players
// directly via seat_from_pool; there is no ready-up gate. Entropy is derived
// from the other 6 sources mixed in tee_deal.

/**
 * Build use_time_bank instruction — player activates 15s time extension
 * Accounts: player (signer), table (mut), seat (mut)
 */
export function buildUseTimeBankInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data: DISCRIMINATORS.useTimeBank,
  });
}

/**
 * Build leave_table instruction
 * Player leaves table, seat + marker PDAs are closed, rent returned
 */
export function buildLeaveTableInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [markerPda] = getPlayerTableMarkerPda(player, tablePda);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: markerPda, isSigner: false, isWritable: true },
      // Optional token accounts (use program ID as placeholder for SNG)
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.leaveTable,
  });
}

/**
 * Parse table account data
 */
export interface TableState {
  tableId: Uint8Array;
  authority: PublicKey;
  pool: PublicKey;
  creator: PublicKey;
  gameType: OnChainGameType;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  currentPlayers: number;
  handNumber: number;
  pot: number;
  phase: OnChainPhase;
  dealerButton: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  currentPlayer: number;
  currentBet: number;
  communityCards: number[];
  lastActionTime: number;
  tier: number;
  entryAmount: number;
  feeAmount: number;
  prizePool: number;
  blindLevel: number;
  tournamentStartTime: number;
  tokenMint: string;
  isPrivate: boolean;
  seatsOccupied: number;
  seatsAllin: number;
  seatsFolded: number;
  eliminatedSeats: number[];
  eliminatedCount: number;
  // OPEN-4 Phase 4
  playersReady: number;
  readyDeadline: number;
  blindsPosted: number;
  blindDeadline: number;
  revealedHands: number[];
  handResults: number[];
  activeMask?: number;
  dealtMask?: number;
  rosterHandNumber?: number;
}

// Verified byte offsets from Table struct in programs/cq-poker/src/state/table.rs
// All offsets include the 8-byte Anchor discriminator
const TABLE_OFFSETS = {
  TABLE_ID: 8,           // [u8; 32]
  AUTHORITY: 40,         // Pubkey
  POOL: 72,              // Pubkey
  GAME_TYPE: 104,        // u8 (enum)
  SMALL_BLIND: 105,      // u64
  BIG_BLIND: 113,        // u64
  MAX_PLAYERS: 121,      // u8
  CURRENT_PLAYERS: 122,  // u8
  HAND_NUMBER: 123,      // u64
  POT: 131,              // u64
  MIN_BET: 139,          // u64
  RAKE_ACCUMULATED: 147, // u64
  COMMUNITY_CARDS: 155,  // [u8; 5]
  PHASE: 160,            // u8 (enum)
  CURRENT_PLAYER: 161,   // u8
  ACTIONS_THIS_ROUND: 162, // u8
  DEALER_BUTTON: 163,    // u8
  SMALL_BLIND_SEAT: 164, // u8
  BIG_BLIND_SEAT: 165,   // u8
  LAST_ACTION_SLOT: 166, // u64
  IS_DELEGATED: 174,     // bool
  REVEALED_HANDS: 175,   // [u8; 18] (9 seats × 2 cards, 255=hidden)
  HAND_RESULTS: 193,     // [u8; 9] (hand rank per seat)
  PRE_COMMUNITY: 202,    // [u8; 5]
  DECK_SEED: 207,        // [u8; 32]
  DECK_INDEX: 239,       // u8
  STAKES_LEVEL: 240,     // u8
  BLIND_LEVEL: 241,      // u8
  TOURNAMENT_START_SLOT: 242, // u64
  SEATS_OCCUPIED: 250,   // u16
  SEATS_ALLIN: 252,      // u16
  SEATS_FOLDED: 254,     // u16
  DEAD_BUTTON: 256,      // bool
  FLOP_REACHED: 257,     // bool
  TOKEN_ESCROW: 258,     // Pubkey
  CREATOR: 290,          // Pubkey
  IS_USER_CREATED: 322,  // bool
  CREATOR_RAKE_TOTAL: 323, // u64
  LAST_RAKE_EPOCH: 331,  // u64
  PRIZES_DISTRIBUTED: 339, // bool
  UNCLAIMED_BALANCE_COUNT: 340, // u8
  BUMP: 341,             // u8
  ELIMINATED_SEATS: 342, // [u8; 9]
  ELIMINATED_COUNT: 351, // u8
  ENTRY_FEES_ESCROWED: 352, // u64
  TIER: 360,             // u8 (SnGTier enum)
  ENTRY_AMOUNT: 361,     // u64 (lamports)
  FEE_AMOUNT: 369,       // u64 (lamports)
  PRIZE_POOL: 377,       // u64 (lamports)
  TOKEN_MINT: 385,       // Pubkey (32 bytes)
  BUY_IN_TYPE: 417,      // u8
  RAKE_CAP: 418,         // u64
  IS_PRIVATE: 426,       // bool
  CRANK_POOL_ACCUMULATED: 427, // u64
  ACTION_NONCE: 435,     // u16
  BLINDS_POSTED: 437,    // u16
  BLIND_DEADLINE: 439,   // i64
  PLAYERS_READY: 447,    // u16
  READY_DEADLINE: 449,   // i64
  // Shadow-byte expansion for new table layout (Table::ALLOC_SIZE = 478)
  ACTIVE_MASK: 460,      // u16
  DEALT_MASK: 462,       // u16
  ROSTER_HAND_NUMBER: 472, // u32
  // Historical base Table SIZE = 459 bytes; new tables allocate 478 bytes.
};

export { TABLE_OFFSETS };

export function parseTableState(data: Buffer): TableState | null {
  if (data.length < 385) return null;
  
  try {
    const o = TABLE_OFFSETS;
    
    const tableId = new Uint8Array(data.slice(o.TABLE_ID, o.TABLE_ID + 32));
    const authority = new PublicKey(data.slice(o.AUTHORITY, o.AUTHORITY + 32));
    const pool = new PublicKey(data.slice(o.POOL, o.POOL + 32));
    const gameType = data[o.GAME_TYPE] as OnChainGameType;
    const smallBlind = Number(data.readBigUInt64LE(o.SMALL_BLIND));
    const bigBlind = Number(data.readBigUInt64LE(o.BIG_BLIND));
    const maxPlayers = data[o.MAX_PLAYERS];
    const currentPlayers = data[o.CURRENT_PLAYERS];
    const handNumber = Number(data.readBigUInt64LE(o.HAND_NUMBER));
    const pot = Number(data.readBigUInt64LE(o.POT));
    const minBet = Number(data.readBigUInt64LE(o.MIN_BET));
    const communityCards = Array.from(data.slice(o.COMMUNITY_CARDS, o.COMMUNITY_CARDS + 5));
    const phase = data[o.PHASE] as OnChainPhase;
    const currentPlayer = data[o.CURRENT_PLAYER];
    const dealerButton = data[o.DEALER_BUTTON];
    const smallBlindSeat = data[o.SMALL_BLIND_SEAT];
    const bigBlindSeat = data[o.BIG_BLIND_SEAT];
    const lastActionSlot = Number(data.readBigUInt64LE(o.LAST_ACTION_SLOT));
    
    return {
      tableId,
      authority,
      pool,
      gameType,
      smallBlind,
      bigBlind,
      maxPlayers,
      currentPlayers,
      handNumber,
      pot,
      phase,
      dealerButton,
      smallBlindSeat,
      bigBlindSeat,
      currentPlayer,
      currentBet: minBet,
      communityCards,
      lastActionTime: lastActionSlot,
      tier: data[o.TIER],
      entryAmount: Number(data.readBigUInt64LE(o.ENTRY_AMOUNT)),
      feeAmount: Number(data.readBigUInt64LE(o.FEE_AMOUNT)),
      prizePool: Number(data.readBigUInt64LE(o.PRIZE_POOL)),
      blindLevel: data[o.BLIND_LEVEL],
      tournamentStartTime: Number(data.readBigUInt64LE(o.TOURNAMENT_START_SLOT)),
      seatsOccupied: data.readUInt16LE(o.SEATS_OCCUPIED),
      seatsAllin: data.readUInt16LE(o.SEATS_ALLIN),
      seatsFolded: data.readUInt16LE(o.SEATS_FOLDED),
      eliminatedSeats: Array.from(data.slice(o.ELIMINATED_SEATS, o.ELIMINATED_SEATS + 9)),
      eliminatedCount: data.length > o.ELIMINATED_COUNT ? data[o.ELIMINATED_COUNT] : 0,
      tokenMint: data.length >= 385 + 32
        ? new PublicKey(data.slice(o.TOKEN_MINT, o.TOKEN_MINT + 32)).toBase58()
        : PublicKey.default.toBase58(),
      creator: data.length >= o.CREATOR + 32
        ? new PublicKey(data.slice(o.CREATOR, o.CREATOR + 32))
        : PublicKey.default,
      isPrivate: data.length > o.IS_PRIVATE ? data[o.IS_PRIVATE] === 1 : false,
      // OPEN-4 Phase 4
      blindsPosted: data.length >= o.BLINDS_POSTED + 2 ? data.readUInt16LE(o.BLINDS_POSTED) : 0,
      blindDeadline: data.length >= o.BLIND_DEADLINE + 8 ? Number(data.readBigInt64LE(o.BLIND_DEADLINE)) : 0,
      playersReady: data.length >= o.PLAYERS_READY + 2 ? data.readUInt16LE(o.PLAYERS_READY) : 0,
      readyDeadline: data.length >= o.READY_DEADLINE + 8 ? Number(data.readBigInt64LE(o.READY_DEADLINE)) : 0,
      revealedHands: Array.from(data.slice(o.REVEALED_HANDS, o.REVEALED_HANDS + 18)),
      handResults: Array.from(data.slice(o.HAND_RESULTS, o.HAND_RESULTS + 9)),
      activeMask: data.length >= o.ACTIVE_MASK + 2 ? data.readUInt16LE(o.ACTIVE_MASK) : undefined,
      dealtMask: data.length >= o.DEALT_MASK + 2 ? data.readUInt16LE(o.DEALT_MASK) : undefined,
      rosterHandNumber: data.length >= o.ROSTER_HAND_NUMBER + 4 ? data.readUInt32LE(o.ROSTER_HAND_NUMBER) : undefined,
    };
  } catch (e) {
    console.error('Failed to parse table state:', e);
    return null;
  }
}

/**
 * Parse seat account data
 */
export interface SeatState {
  player: PublicKey;
  sessionKey: PublicKey;
  table: PublicKey;
  chips: number;
  betThisRound: number;
  totalBetThisHand: number;
  seatIndex: number;
  status: SeatStatus;
  sitOutButtonCount: number;
  handsSinceBust: number;
  sitOutTimestamp: number;
  timeBankSeconds: number;
  timeBankActive: boolean;
  vaultReserve: number;
  missedSb: boolean;
  missedBb: boolean;
  waitingForBb: boolean;
}

// Verified byte offsets from PlayerSeat struct in programs/cq-poker/src/state/seat.rs
const SEAT_OFFSETS = {
  WALLET: 8,                    // Pubkey (32)
  APPROVED_SIGNER: 40,          // Pubkey (32)
  TABLE: 72,                    // Pubkey (32)
  CHIPS: 104,                   // u64
  BET_THIS_ROUND: 112,          // u64
  TOTAL_BET_THIS_HAND: 120,     // u64
  HOLE_CARDS_ENCRYPTED: 128,    // [u8; 64]
  HOLE_CARDS_COMMITMENT: 192,   // [u8; 32]
  HOLE_CARDS: 224,              // [u8; 2]
  SEAT_NUMBER: 226,             // u8
  STATUS: 227,                  // u8 (SeatStatus enum)
  LAST_ACTION_SLOT: 228,        // u64
  MISSED_SB: 236,               // bool
  MISSED_BB: 237,               // bool
  POSTED_BLIND: 238,            // bool
  WAITING_FOR_BB: 239,          // bool
  SIT_OUT_BUTTON_COUNT: 240,    // u8
  HANDS_SINCE_BUST: 241,        // u8
  AUTO_FOLD_COUNT: 242,         // u8
  MISSED_BB_COUNT: 243,         // u8
  BUMP: 244,                    // u8
  PAID_ENTRY: 245,              // bool
  CASHOUT_CHIPS: 246,           // u64
  CASHOUT_NONCE: 254,           // u64
  VAULT_RESERVE: 262,           // u64
  SIT_OUT_TIMESTAMP: 270,       // i64
  TIME_BANK_SECONDS: 278,       // u16
  TIME_BANK_ACTIVE: 280,        // bool
};

export { SEAT_OFFSETS };

export function parseSeatState(data: Buffer): SeatState | null {
  if (data.length < 245) return null;
  
  try {
    const o = SEAT_OFFSETS;
    
    const player = new PublicKey(data.slice(o.WALLET, o.WALLET + 32));
    const approvedSigner = new PublicKey(data.slice(o.APPROVED_SIGNER, o.APPROVED_SIGNER + 32));
    const table = new PublicKey(data.slice(o.TABLE, o.TABLE + 32));
    const chips = Number(data.readBigUInt64LE(o.CHIPS));
    const betThisRound = Number(data.readBigUInt64LE(o.BET_THIS_ROUND));
    const totalBetThisHand = Number(data.readBigUInt64LE(o.TOTAL_BET_THIS_HAND));
    const seatIndex = data[o.SEAT_NUMBER];
    const status = data[o.STATUS] as SeatStatus;
    const sitOutButtonCount = data.length > o.SIT_OUT_BUTTON_COUNT ? data[o.SIT_OUT_BUTTON_COUNT] : 0;
    const handsSinceBust = data.length > o.HANDS_SINCE_BUST ? data[o.HANDS_SINCE_BUST] : 0;
    const sitOutTimestamp =
      data.length >= o.SIT_OUT_TIMESTAMP + 8
        ? Number(data.readBigInt64LE(o.SIT_OUT_TIMESTAMP))
        : 0;
    const timeBankSeconds =
      data.length >= o.TIME_BANK_SECONDS + 2
        ? data.readUInt16LE(o.TIME_BANK_SECONDS)
        : 0;
    const timeBankActive =
      data.length > o.TIME_BANK_ACTIVE
        ? data[o.TIME_BANK_ACTIVE] === 1
        : false;
    const vaultReserve =
      data.length >= o.VAULT_RESERVE + 8
        ? Number(data.readBigUInt64LE(o.VAULT_RESERVE))
        : 0;

    const missedSb = data.length > o.MISSED_SB ? data[o.MISSED_SB] === 1 : false;
    const missedBb = data.length > o.MISSED_BB ? data[o.MISSED_BB] === 1 : false;
    const waitingForBb = data.length > o.WAITING_FOR_BB ? data[o.WAITING_FOR_BB] === 1 : false;

    return {
      player,
      sessionKey: approvedSigner,
      table,
      chips,
      betThisRound,
      totalBetThisHand,
      seatIndex,
      status,
      sitOutButtonCount,
      handsSinceBust,
      sitOutTimestamp,
      timeBankSeconds,
      timeBankActive,
      vaultReserve,
      missedSb,
      missedBb,
      waitingForBb,
    };
  } catch (e) {
    console.error('Failed to parse seat state:', e);
    return null;
  }
}

/**
 * Convert on-chain phase to display string
 */
export function phaseToString(phase: OnChainPhase): string {
  switch (phase) {
    case OnChainPhase.Waiting: return 'Waiting';
    case OnChainPhase.Starting: return 'Starting';
    case OnChainPhase.Preflop: return 'PreFlop';
    case OnChainPhase.Flop: return 'Flop';
    case OnChainPhase.Turn: return 'Turn';
    case OnChainPhase.River: return 'River';
    case OnChainPhase.Showdown: return 'Showdown';
    case OnChainPhase.Complete: return 'Complete';
    case OnChainPhase.FlopRevealPending: return 'FlopRevealPending';
    case OnChainPhase.TurnRevealPending: return 'TurnRevealPending';
    case OnChainPhase.RiverRevealPending: return 'RiverRevealPending';
    default: return 'Unknown';
  }
}

// ============================================
// CASH GAME TABLE HELPERS
// ============================================

/**
 * Build create_user_table instruction (cash game, creator earns 25% rake)
 * New UserTableConfig: table_id(32) + max_players(1) + small_blind(8) + big_blind(8) + token_mint(32)
 *
 * For SOL tables (tokenMint = PublicKey.default):
 *   - Fee = 0.05 SOL flat + 1-2 BB in SOL via Steel CPI
 *   - creator_token_account / treasury_token_account / token_program = PROGRAM_ID placeholder
 *
 * For SPL token tables (POKER, USDC, auction-listed):
 *   - Fee = 0.05 SOL flat via Steel CPI + 1-2 BB in the table token
 *   - creator_token_account = creator's ATA for the mint
 *   - treasury_token_account = treasury's ATA for the mint
 *   - pool_token_account = pool ATA for the mint
 *   - remaining accounts include SPLRewardPool + prize_authority so the pool
 *     fee share updates Steel token-vault accounting atomically
 *   - token_program = TOKEN_PROGRAM_ID
 */
export function buildCreateUserTableInstruction(
  creator: PublicKey,
  tableId: Uint8Array,
  smallBlind: bigint,
  bigBlind: bigint,
  maxPlayers: number,
  tokenMint: PublicKey = PublicKey.default,
  creatorTokenAccount?: PublicKey,
  treasuryTokenAccount?: PublicKey,
  buyInType: number = 0, // 0=Normal, 1=Deep Stack
  poolTokenAccount?: PublicKey,
  isPrivate: boolean = false,
  tokenEscrow?: PublicKey,
): { instruction: TransactionInstruction; tablePda: PublicKey } {
  const [tablePda] = getTablePda(tableId);

  const isSol = tokenMint.equals(PublicKey.default);

  // UserTableConfig: table_id(32) + max_players(1) + small_blind(8) + big_blind(8) + token_mint(32) + buy_in_type(1) + is_private(1)
  const data = Buffer.alloc(8 + 32 + 1 + 8 + 8 + 32 + 1 + 1);
  DISCRIMINATORS.createUserTable.copy(data, 0);
  Buffer.from(tableId).copy(data, 8);
  data.writeUInt8(maxPlayers, 40);
  data.writeBigUInt64LE(smallBlind, 41);
  data.writeBigUInt64LE(bigBlind, 49);
  tokenMint.toBuffer().copy(data, 57);
  data.writeUInt8(buyInType, 89);
  data.writeUInt8(isPrivate ? 1 : 0, 90);

  const [vaultPda] = getVaultPda(tablePda);
  const [slimBufferPda] = getSlimBufferPda(tablePda);
  const [protocolGuardPda] = getProtocolGuardPda();

  // Core accounts — order must match CreateUserTable struct in contract
  const keys = [
    { pubkey: creator, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: POOL_PDA, isSigner: false, isWritable: true },
    { pubkey: TREASURY, isSigner: false, isWritable: true },
    { pubkey: creatorTokenAccount ?? ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !isSol },
    { pubkey: treasuryTokenAccount ?? ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !isSol },
    { pubkey: poolTokenAccount ?? ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !isSol },
    { pubkey: isSol ? ANCHOR_PROGRAM_ID : TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: slimBufferPda, isSigner: false, isWritable: true },
    { pubkey: protocolGuardPda, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // token_escrow: Option<UncheckedAccount> — pass real ATA for SPL tables, program_id for SOL
    { pubkey: isSol ? ANCHOR_PROGRAM_ID : (tokenEscrow ?? ANCHOR_PROGRAM_ID), isSigner: false, isWritable: !isSol },
  ];

  // SOL/USDC require TokenTierConfig at contract level. Auction-listed SPL
  // tokens prove listing through ListedToken and pass the mint so the contract
  // can read decimals for the universal blind floor.
  if (requiresTokenTierConfig(tokenMint)) {
    keys.push({ pubkey: getTokenTierConfigPda(tokenMint), isSigner: false, isWritable: false });
  } else if (!isSol) {
    if (!isPremiumTokenMint(tokenMint)) {
      keys.push({ pubkey: getListedTokenPda(tokenMint), isSigner: false, isWritable: false });
    }
  }

  if (!isSol) {
    keys.push(
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: getSplRewardPoolPda(tokenMint), isSigner: false, isWritable: true },
      { pubkey: getPrizeAuthorityPda(), isSigner: false, isWritable: false },
    );
  }

  const instruction = new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });

  return { instruction, tablePda };
}

// ============================================
// PRE-CREATED SEATS ARCHITECTURE
// ============================================

/**
 * Build init_table_seat instruction — creates seat PDA + seat_cards PDA on L1.
 * Called once per seat during table setup. Creator pays rent.
 */
export function getPermissionPda(permissionedAccount: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('permission:'), permissionedAccount.toBuffer()],
    PERMISSION_PROGRAM_ID
  );
}

export function getProtocolGuardPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PROTOCOL_GUARD_SEED)],
    ANCHOR_PROGRAM_ID
  );
}

export function buildInitTipJarInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
): TransactionInstruction {
  const [tipJarPda] = getTipJarPda(tablePda);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data: DISCRIMINATORS.initTipJar,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: tipJarPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function buildInitHandReportBufferInstruction(
  sponsor: PublicKey,
  tablePda: PublicKey,
  capacity: number = HAND_REPORT_DEFAULT_CAPACITY,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 32 + 4);
  DISCRIMINATORS.initHandReportBuffer.copy(data, 0);
  tablePda.toBuffer().copy(data, 8);
  data.writeUInt32LE(capacity, 40);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data,
    keys: [
      { pubkey: sponsor, isSigner: true, isWritable: true },
      { pubkey: getHandReportBufferPda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: getHandReportFlushStatePda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

export function buildInitHandReportFlushStateInstruction(
  sponsor: PublicKey,
  tablePda: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 32);
  DISCRIMINATORS.initHandReportFlushState.copy(data, 0);
  tablePda.toBuffer().copy(data, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data,
    keys: [
      { pubkey: sponsor, isSigner: true, isWritable: true },
      { pubkey: getHandReportFlushStatePda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

export function buildInitTableSeatInstruction(
  creator: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
  const [deckStatePda] = getDeckStatePda(tablePda);
  const [receiptPda] = getReceiptPda(tablePda, seatIndex);
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
  const [vaultPda] = getVaultPda(tablePda);
  const [crankTallyErPda] = getCrankTallyErPda(tablePda);
  const [crankTallyL1Pda] = getCrankTallyL1Pda(tablePda);
  const [permissionPda] = getPermissionPda(seatCardsPda);

  const data = Buffer.alloc(9);
  DISCRIMINATORS.initTableSeat.copy(data, 0);
  data.writeUInt8(seatIndex, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: seatCardsPda, isSigner: false, isWritable: true },
      { pubkey: deckStatePda, isSigner: false, isWritable: true },
      { pubkey: receiptPda, isSigner: false, isWritable: true },
      { pubkey: depositProofPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: crankTallyErPda, isSigner: false, isWritable: true },
      { pubkey: crankTallyL1Pda, isSigner: false, isWritable: true },
      { pubkey: permissionPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ═══ TEE Permission Creation + Delegation Builders ═══
// TEE requires ALL delegated accounts to have permission PDAs for getAccountInfo.

export function buildCreateTablePermission(payer: PublicKey, tablePda: PublicKey): TransactionInstruction {
  const [permPda] = getPermissionPda(tablePda);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data: DISCRIMINATORS.createTablePermission,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function buildCreateSeatPermission(payer: PublicKey, tablePda: PublicKey, seatIndex: number): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [permPda] = getPermissionPda(seatPda);
  const data = Buffer.alloc(9);
  DISCRIMINATORS.createSeatPermission.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: seatPda, isSigner: false, isWritable: false },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function buildCreateDeckStatePermission(payer: PublicKey, tablePda: PublicKey): TransactionInstruction {
  const [dsPda] = getDeckStatePda(tablePda);
  const [permPda] = getPermissionPda(dsPda);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data: DISCRIMINATORS.createDeckStatePermission,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: dsPda, isSigner: false, isWritable: false },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function buildUpdateDeckStatePermission(payer: PublicKey, tablePda: PublicKey): TransactionInstruction {
  const [dsPda] = getDeckStatePda(tablePda);
  const [permPda] = getPermissionPda(dsPda);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data: DISCRIMINATORS.updateDeckStatePermission,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: dsPda, isSigner: false, isWritable: false },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

export function getWhitelistPda(tablePda: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('whitelist'), tablePda.toBuffer(), player.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
}

export function buildAddWhitelistInstruction(
  creator: PublicKey,
  tablePda: PublicKey,
  player: PublicKey,
): TransactionInstruction {
  const [whitelistPda] = getWhitelistPda(tablePda, player);
  const data = Buffer.alloc(40);
  DISCRIMINATORS.addWhitelist.copy(data, 0);
  player.toBuffer().copy(data, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: whitelistPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildCreateGlobalEntropyPermission(payer: PublicKey): TransactionInstruction {
  const [globalEntropyPda] = getGlobalEntropyPda();
  const [permPda] = getPermissionPda(globalEntropyPda);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data: DISCRIMINATORS.createGlobalEntropyPermission,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: globalEntropyPda, isSigner: false, isWritable: false },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function buildDelegateTablePermission(
  payer: PublicKey, tablePda: PublicKey,
  delegationProgramId: PublicKey,
  tableId: Uint8Array,
): TransactionInstruction {
  const [permPda] = getPermissionPda(tablePda);
  const [validatorRegistryPda] = getValidatorRegistryPda();
  const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
  const rec = delegationRecordPdaFromDelegatedAccount(permPda);
  const meta = delegationMetadataPdaFromDelegatedAccount(permPda);
  // CG-CT1 FIX: Contract now takes table_id as instruction arg (AccountInfo instead of Account<Table>)
  const data = Buffer.alloc(8 + 32);
  DISCRIMINATORS.delegateTablePermission.copy(data, 0);
  Buffer.from(tableId).copy(data, 8);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: rec, isSigner: false, isWritable: true },
      { pubkey: meta, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
    ],
  });
}

export function buildDelegateSeatPermission(
  payer: PublicKey, tablePda: PublicKey, seatIndex: number,
  delegationProgramId: PublicKey,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [permPda] = getPermissionPda(seatPda);
  const [validatorRegistryPda] = getValidatorRegistryPda();
  const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
  const rec = delegationRecordPdaFromDelegatedAccount(permPda);
  const meta = delegationMetadataPdaFromDelegatedAccount(permPda);
  const data = Buffer.alloc(9);
  DISCRIMINATORS.delegateSeatPermission.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: rec, isSigner: false, isWritable: true },
      { pubkey: meta, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
    ],
  });
}

export function buildDelegateDeckStatePermission(
  payer: PublicKey, tablePda: PublicKey,
  delegationProgramId: PublicKey,
): TransactionInstruction {
  const [dsPda] = getDeckStatePda(tablePda);
  const [permPda] = getPermissionPda(dsPda);
  const [validatorRegistryPda] = getValidatorRegistryPda();
  const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
  const rec = delegationRecordPdaFromDelegatedAccount(permPda);
  const meta = delegationMetadataPdaFromDelegatedAccount(permPda);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data: DISCRIMINATORS.delegateDeckStatePermission,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: dsPda, isSigner: false, isWritable: true },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: rec, isSigner: false, isWritable: true },
      { pubkey: meta, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
    ],
  });
}

/**
 * Build delegate_table instruction — delegates table PDA to Ephemeral Rollup.
 * Requires delegation SDK PDAs (buffer, record, metadata).
 */
export function buildDelegateTableInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  tableId: Uint8Array,
  delegationBufferPda: PublicKey,
  delegationRecordPda: PublicKey,
  delegationMetadataPda: PublicKey,
  delegationProgramId: PublicKey,
  maxPlayers: number,
): TransactionInstruction {
  const data = Buffer.alloc(40);
  DISCRIMINATORS.delegateTable.copy(data, 0);
  Buffer.from(tableId).copy(data, 8);

  // Contract reads validator from remaining_accounts.first(), so it MUST be first.
  // Order: [validator, slim_buffer, seat_perm_0..N, table_perm, ds_perm, validator_registry]
  const remainingKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];

  // Validator FIRST — contract's delegate_handler reads remaining_accounts.first()
  remainingKeys.push({ pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false });
  const [slimBufferPda] = getSlimBufferPda(tablePda);
  remainingKeys.push({ pubkey: slimBufferPda, isSigner: false, isWritable: false });

  // Seat permission PDAs (0..maxPlayers)
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = getSeatPda(tablePda, i);
    const [seatPerm] = getPermissionPda(seatPda);
    remainingKeys.push({ pubkey: seatPerm, isSigner: false, isWritable: false });
  }

  // SeatCards permission PDAs (0..maxPlayers). delegate_seat_cards enforces
  // each one stays L1 Permission-owned before delegating the matching SeatCards.
  for (let i = 0; i < maxPlayers; i++) {
    const [scPda] = getSeatCardsPda(tablePda, i);
    const [scPerm] = getPermissionPda(scPda);
    remainingKeys.push({ pubkey: scPerm, isSigner: false, isWritable: false });
  }

  // Table permission PDA
  const [tablePerm] = getPermissionPda(tablePda);
  remainingKeys.push({ pubkey: tablePerm, isSigner: false, isWritable: false });

  // DeckState permission PDA
  const [dsPda] = getDeckStatePda(tablePda);
  const [dsPerm] = getPermissionPda(dsPda);
  remainingKeys.push({ pubkey: dsPerm, isSigner: false, isWritable: false });
  const [validatorRegistryPda] = getValidatorRegistryPda();
  remainingKeys.push({ pubkey: validatorRegistryPda, isSigner: false, isWritable: false });

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: delegationBufferPda, isSigner: false, isWritable: true },
      { pubkey: delegationRecordPda, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPda, isSigner: false, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // remaining_accounts: validator, guard PDAs, permissions, validator registry
      ...remainingKeys,
    ],
    data,
  });
}

/**
 * Build delegate_seat instruction — delegates a seat PDA to Ephemeral Rollup.
 */
export function buildDelegateSeatInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  delegationBufferPda: PublicKey,
  delegationRecordPda: PublicKey,
  delegationMetadataPda: PublicKey,
  delegationProgramId: PublicKey,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [validatorRegistryPda] = getValidatorRegistryPda();
  const data = Buffer.alloc(9);
  DISCRIMINATORS.delegateSeat.copy(data, 0);
  data.writeUInt8(seatIndex, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: delegationBufferPda, isSigner: false, isWritable: true },
      { pubkey: delegationRecordPda, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build delegate_seat_cards instruction — delegates a seat_cards PDA to Ephemeral Rollup.
 */
export function buildDelegateSeatCardsInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  delegationBufferPda: PublicKey,
  delegationRecordPda: PublicKey,
  delegationMetadataPda: PublicKey,
  delegationProgramId: PublicKey,
): TransactionInstruction {
  const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
  const [permissionPda] = getPermissionPda(seatCardsPda);
  const [validatorRegistryPda] = getValidatorRegistryPda();
  const data = Buffer.alloc(9);
  DISCRIMINATORS.delegateSeatCards.copy(data, 0);
  data.writeUInt8(seatIndex, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: delegationBufferPda, isSigner: false, isWritable: true },
      { pubkey: delegationRecordPda, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPda, isSigner: false, isWritable: true },
      { pubkey: seatCardsPda, isSigner: false, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
      { pubkey: permissionPda, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build commit_and_undelegate instruction — commit+undelegates the table plus any
 * fastpoker-owned target PDAs (slimBuffer/deckState/crankTallyER/seats) from the TEE.
 * Must be signed by table.authority (creator) and sent to the TEE RPC.
 *
 * Mirrors the crank's buildCommitAndUndelegateIx EXACTLY:
 *   data = disc(8) + include_table(1 bool byte)
 *   keys = [payer(signer,w), table(w if includeTable or tableWritable), magic_program(r), magic_context(w), ...targets(w)]
 * The contract reads `include_table: bool`, so the bool byte is REQUIRED. Sending
 * only the 8-byte discriminator (the prior stale builder) deserializes incorrectly.
 *
 * Chunk targets conservatively (<= 4 accounts per TX, table included) because Magic's
 * relayer silently drops CAU bundles with >= 10 accounts.
 */
export function buildCommitAndUndelegateInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  targetPdas: PublicKey[] = [],
  includeTable: boolean = true,
  tableWritable: boolean = includeTable,
  readonlyWitnessPdas: PublicKey[] = [],
): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: tableWritable || includeTable },
    { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    ...targetPdas.map(pk => ({ pubkey: pk, isSigner: false, isWritable: true })),
    ...readonlyWitnessPdas.map(pk => ({ pubkey: pk, isSigner: false, isWritable: false })),
  ];
  // Instruction data = discriminator(8) + bool(include_table)(1)
  const data = Buffer.concat([
    DISCRIMINATORS.commitAndUndelegateTable,
    Buffer.from([includeTable ? 1 : 0]),
  ]);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build resize_vault instruction.
 * Idempotent migration for legacy 57/73-byte vault accounts to current TableVault size.
 */
export function buildResizeVaultInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
): TransactionInstruction {
  const [vaultPda] = getVaultPda(tablePda);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.resizeVault,
  });
}

export function buildCommitStateInstruction(
  payer: PublicKey,
  accounts: PublicKey[],
): TransactionInstruction {
  if (accounts.length === 0) {
    throw new Error('commit_state requires the table PDA as the first commit target');
  }
  const globalEntropy = getGlobalEntropyPda()[0];
  if (accounts.some(a => a.equals(globalEntropy))) {
    throw new Error('GlobalEntropy is TEE-private and must never be committed to L1');
  }
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data: DISCRIMINATORS.commitState,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_FEE_VAULT, isSigner: false, isWritable: true },
      ...accounts.map(a => ({ pubkey: a, isSigner: false, isWritable: true })),
    ],
  });
}

export function buildSettleTableRewardsInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  creatorAccount: PublicKey,
  remainingAccounts: AccountMeta[] = [],
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: getVaultPda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: creatorAccount, isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: getPrizeAuthorityPda(), isSigner: false, isWritable: true },
      { pubkey: getCrankTallyErPda(tablePda)[0], isSigner: false, isWritable: false },
      { pubkey: getCrankTallyL1Pda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: getTipJarPda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...remainingAccounts,
    ],
    data: DISCRIMINATORS.settleTableRewards,
  });
}

export function buildInitCrankRewardStateInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(40);
  DISCRIMINATORS.initCrankRewardState.copy(data, 0);
  tablePda.toBuffer().copy(data, 8);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: getCrankRewardStatePda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitOperatorRewardTotalInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  isL1: boolean,
): TransactionInstruction {
  const data = Buffer.alloc(41);
  DISCRIMINATORS.initOperatorRewardTotal.copy(data, 0);
  tablePda.toBuffer().copy(data, 8);
  data.writeUInt8(isL1 ? 1 : 0, 40);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      {
        pubkey: isL1
          ? getOperatorRewardTotalL1Pda(tablePda)[0]
          : getOperatorRewardTotalErPda(tablePda)[0],
        isSigner: false,
        isWritable: true,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitOperatorClaimInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  operator: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(72);
  DISCRIMINATORS.initOperatorClaim.copy(data, 0);
  tablePda.toBuffer().copy(data, 8);
  operator.toBuffer().copy(data, 40);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: getOperatorClaimPda(tablePda, operator)[0], isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildUpdateOpClaimWeightInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  operator: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: getCrankRewardStatePda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: getOperatorClaimPda(tablePda, operator)[0], isSigner: false, isWritable: true },
      { pubkey: getCrankActionErPda(tablePda, operator)[0], isSigner: false, isWritable: false },
      { pubkey: getCrankActionL1Pda(tablePda, operator)[0], isSigner: false, isWritable: false },
      { pubkey: getDealerLicensePda(operator)[0], isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.updateOpClaimWeight,
  });
}

export function buildUpdateAccRewardPerWeightInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  spl?: {
    escrowAta: PublicKey;
    poolAta: PublicKey;
    treasuryAta: PublicKey;
    splRewardPool: PublicKey;
  } | null,
): TransactionInstruction {
  const remaining: AccountMeta[] = spl
    ? [
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: spl.escrowAta, isSigner: false, isWritable: true },
        { pubkey: spl.poolAta, isSigner: false, isWritable: true },
        { pubkey: spl.treasuryAta, isSigner: false, isWritable: true },
        { pubkey: spl.splRewardPool, isSigner: false, isWritable: true },
        { pubkey: POOL_PDA, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: false },
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: getPrizeAuthorityPda(), isSigner: false, isWritable: true },
      ]
    : [
        { pubkey: POOL_PDA, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: getPrizeAuthorityPda(), isSigner: false, isWritable: true },
      ];
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: getCrankRewardStatePda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: getVaultPda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: getOperatorRewardTotalErPda(tablePda)[0], isSigner: false, isWritable: false },
      { pubkey: getOperatorRewardTotalL1Pda(tablePda)[0], isSigner: false, isWritable: false },
      ...remaining,
    ],
    data: DISCRIMINATORS.updateAccRewardPerWeight,
  });
}

export function buildClaimOperatorRewardsInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  operator: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: getCrankRewardStatePda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: getOperatorClaimPda(tablePda, operator)[0], isSigner: false, isWritable: true },
      { pubkey: getVaultPda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: operator, isSigner: false, isWritable: true },
      { pubkey: getDealerLicensePda(operator)[0], isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.claimOperatorRewards,
  });
}

export function buildClaimOperatorTokenRewardsInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  operator: PublicKey,
  escrowAta: PublicKey,
  operatorAta: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: getCrankRewardStatePda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: getOperatorClaimPda(tablePda, operator)[0], isSigner: false, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: getVaultPda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: escrowAta, isSigner: false, isWritable: true },
      { pubkey: operatorAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: getDealerLicensePda(operator)[0], isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.claimOperatorTokenRewards,
  });
}

/**
 * Build delegate_deposit_proof instruction — delegates DepositProof PDA to ER.
 * Called on L1 after deposit_for_join, before seat_player on ER.
 */
export function buildDelegateDepositProofInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  delegationBufferPda: PublicKey,
  delegationRecordPda: PublicKey,
  delegationMetadataPda: PublicKey,
  delegationProgramId: PublicKey,
): TransactionInstruction {
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
  const [validatorRegistryPda] = getValidatorRegistryPda();
  const data = Buffer.alloc(9);
  DISCRIMINATORS.delegateDepositProof.copy(data, 0);
  data.writeUInt8(seatIndex, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: delegationBufferPda, isSigner: false, isWritable: true },
      { pubkey: delegationRecordPda, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPda, isSigner: false, isWritable: true },
      { pubkey: depositProofPda, isSigner: false, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build delegate_deck_state instruction — delegates DeckState PDA to ER.
 * Called on L1 during table setup (after init_table_seat, before game start).
 * No args — just the PDA derivation from table key.
 */
export function buildDelegateDeckStateInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  delegationBufferPda: PublicKey,
  delegationRecordPda: PublicKey,
  delegationMetadataPda: PublicKey,
  delegationProgramId: PublicKey,
): TransactionInstruction {
  const [deckStatePda] = getDeckStatePda(tablePda);
  const [deckPermPda] = getPermissionPda(deckStatePda);
  const [validatorRegistryPda] = getValidatorRegistryPda();
  const data = Buffer.alloc(8);
  DISCRIMINATORS.delegateDeckState.copy(data, 0);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: delegationBufferPda, isSigner: false, isWritable: true },
      { pubkey: delegationRecordPda, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPda, isSigner: false, isWritable: true },
      { pubkey: deckStatePda, isSigner: false, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
      { pubkey: deckPermPda, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build delegate_permission instruction. This path is retired fail-closed:
 * SeatCards Permission PDAs must remain L1-owned for future occupant rebinds.
 */
export function buildDelegatePermissionInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  delegationBufferPda: PublicKey,
  delegationRecordPda: PublicKey,
  delegationMetadataPda: PublicKey,
  delegationProgramId: PublicKey,
): TransactionInstruction {
  const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
  const [permissionPda] = getPermissionPda(seatCardsPda);
  const [validatorRegistryPda] = getValidatorRegistryPda();

  const data = Buffer.alloc(9);
  DISCRIMINATORS.delegatePermission.copy(data, 0);
  data.writeUInt8(seatIndex, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: seatCardsPda, isSigner: false, isWritable: true },
      { pubkey: permissionPda, isSigner: false, isWritable: true },
      { pubkey: delegationBufferPda, isSigner: false, isWritable: true },
      { pubkey: delegationRecordPda, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build deposit_for_join instruction — player deposits SOL to vault on L1.
 * Creates receipt PDA + marker + deposit_proof PDAs. Called BEFORE seat_player on ER.
 */
export function buildDepositForJoinInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  buyIn: bigint,
  reserve: bigint = BigInt(0),
  tokenMint?: PublicKey,       // SPL token mint (omit for SOL tables)
  playerAta?: PublicKey,       // player's token ATA
  tableAta?: PublicKey,        // table's token escrow ATA
  approvedSigner?: PublicKey,  // ephemeral key for gasless TEE play (defaults to player wallet)
  whitelistPlayer?: PublicKey, // required for private non-creator cash deposits
): TransactionInstruction {
  const [playerAccountPda] = getPlayerPda(player);
  const [vaultPda] = getVaultPda(tablePda);
  const [receiptPda] = getReceiptPda(tablePda, seatIndex);
  const [markerPda] = getPlayerTableMarkerPda(player, tablePda);

  const isSplTable = tokenMint && !tokenMint.equals(PublicKey.default);

  // disc(8) + seat_index(1) + buy_in(8) + reserve(8) + approved_signer(32)
  const data = Buffer.alloc(57);
  DISCRIMINATORS.depositForJoin.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  data.writeBigUInt64LE(buyIn, 9);
  data.writeBigUInt64LE(reserve, 17);
  (approvedSigner || player).toBuffer().copy(data, 25); // approved_signer defaults to wallet

  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
  const [protocolGuardPda] = getProtocolGuardPda();

  const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
  const [permissionPda] = getPermissionPda(seatCardsPda);

  const keys: AccountMeta[] = [
    { pubkey: player, isSigner: true, isWritable: true },
    { pubkey: playerAccountPda, isSigner: false, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: false },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: receiptPda, isSigner: false, isWritable: true },
    { pubkey: markerPda, isSigner: false, isWritable: true },
    { pubkey: depositProofPda, isSigner: false, isWritable: true },
    { pubkey: protocolGuardPda, isSigner: false, isWritable: false },
    // Optional SPL accounts (pass real accounts for SPL tables, None-placeholder for SOL)
    { pubkey: isSplTable ? playerAta! : ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !!isSplTable },
    { pubkey: isSplTable ? tableAta! : ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !!isSplTable },
    { pubkey: isSplTable ? TOKEN_PROGRAM_ID : ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // remaining_accounts: atomic card read permission update (L1 CPI to Permission Program)
    // Only player added as member — crank must NOT access seatCards.
    // Permission PDA must NOT be delegated — stays on L1 so deposit_for_join can write to it.
    // See docs/TEE_ATOMIC_PERMISSION_FIX.md
    { pubkey: seatCardsPda, isSigner: false, isWritable: true },
    { pubkey: permissionPda, isSigner: false, isWritable: true },
    { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  if (whitelistPlayer) {
    const [whitelistPda] = getWhitelistPda(tablePda, whitelistPlayer);
    keys.push({ pubkey: whitelistPda, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build deposit_topup instruction (L1) — top-up deposit for an already-seated player.
 * Atomically transfers SOL/SPL to vault and updates the DepositProof PDA.
 * The proof is then delegated to TEE (bundle delegate in same TX).
 * Backend API calls apply_topup on TEE to credit vault_reserve → chips.
 */
export function buildDepositTopupInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  topupAmount: bigint,
  tokenMint?: PublicKey,
  playerAta?: PublicKey,
  tableAta?: PublicKey,
): TransactionInstruction {
  const [vaultPda] = getVaultPda(tablePda);
  const [receiptPda] = getReceiptPda(tablePda, seatIndex);
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
  const [protocolGuardPda] = getProtocolGuardPda();

  const isSplTable = tokenMint && !tokenMint.equals(PublicKey.default);

  // disc(8) + seat_index(1) + topup_amount(8)
  const data = Buffer.alloc(17);
  DISCRIMINATORS.depositTopup.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  data.writeBigUInt64LE(topupAmount, 9);

  const keys: AccountMeta[] = [
    { pubkey: player, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: false },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: receiptPda, isSigner: false, isWritable: false },
    { pubkey: depositProofPda, isSigner: false, isWritable: true },
    { pubkey: protocolGuardPda, isSigner: false, isWritable: false },
    // Optional SPL accounts
    { pubkey: isSplTable ? playerAta! : ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !!isSplTable },
    { pubkey: isSplTable ? tableAta! : ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !!isSplTable },
    { pubkey: isSplTable ? TOKEN_PROGRAM_ID : ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build apply_topup instruction (TEE) — permissionless relay.
 * Reads delegated DepositProof, credits vault_reserve, auto-converts to chips
 * if between hands. Called by backend API after deposit_topup + delegation.
 */
export function buildApplyTopupInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);

  // disc(8) + seat_index(1)
  const data = Buffer.alloc(9);
  DISCRIMINATORS.applyTopup.copy(data, 0);
  data.writeUInt8(seatIndex, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: depositProofPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Build seat_player instruction — permissionless seating on ER.
 * Reads buy_in/reserve/player from DepositProof PDA (created on L1, delegated to ER).
 * Any funded ER account can relay this instruction.
 * OPEN-4: Now includes entropy_key (random Pubkey) for RNG entropy at join time,
 * and deck_state as remaining_account for the entropy XOR.
 * Anti-ratholing: includes PlayerTableMarker as remaining_account for chip_lock check.
 */
export function buildSeatPlayerInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  entropyKey?: PublicKey,
  playerWallet?: PublicKey, // for anti-ratholing chip_lock check
  maxPlayers: number = 6, // for anti-duplicate seat check
  includeWhitelist: boolean = false,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
  const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
  const [deckStatePda] = getDeckStatePda(tablePda);

  // OPEN-4: Generate random entropy key if not provided
  const entropy = entropyKey || Keypair.generate().publicKey;

  // disc(8) + seat_index(1) + entropy_key(32)
  const data = Buffer.alloc(9 + 32);
  DISCRIMINATORS.seatPlayer.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  entropy.toBuffer().copy(data, 9);

  const keys: AccountMeta[] = [
    { pubkey: payer, isSigner: true, isWritable: false }, // NOT writable — TEE rejects writable non-delegated accounts
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: seatPda, isSigner: false, isWritable: true },
    { pubkey: depositProofPda, isSigner: false, isWritable: true },
    // Cash seat reuse guard: seat_player wipes/rebinds SeatCards; read access
    // was already set by deposit_for_join on L1.
    { pubkey: seatCardsPda, isSigner: false, isWritable: true },
    // OPEN-4: DeckState for entropy XOR (remaining_account)
    { pubkey: deckStatePda, isSigner: false, isWritable: true },
    // GlobalEntropy private-PER pool (program-member write, no wallet read/message flags)
    { pubkey: getGlobalEntropyPda()[0], isSigner: false, isWritable: true },
  ];

  // Anti-ratholing: include PlayerTableMarker for chip_lock check
  if (playerWallet) {
    const [markerPda] = getPlayerTableMarkerPda(playerWallet, tablePda);
    keys.push({ pubkey: markerPda, isSigner: false, isWritable: false });

    if (includeWhitelist) {
      const [whitelistPda] = getWhitelistPda(tablePda, playerWallet);
      keys.push({ pubkey: whitelistPda, isSigner: false, isWritable: false });
    }
  }

  // Required by contract: pass every other Seat PDA so seat_player can enforce
  // duplicate-seat prevention and count whether a real active orbit exists.
  for (let i = 0; i < maxPlayers; i++) {
    if (i === seatIndex) continue;
    const [otherSeatPda] = getSeatPda(tablePda, i);
    keys.push({ pubkey: otherSeatPda, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });
}


/**
 * Build reset_seat_permission instruction — locks seatCards permission back to
 * members=[] on L1 after a player leaves or is kicked. PERMISSIONLESS.
 * Safety: only works when the seat is Empty (wallet == default).
 */
export function buildResetSeatPermissionInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
  const [permissionPda] = getPermissionPda(seatCardsPda);

  const data = Buffer.alloc(9);
  DISCRIMINATORS.resetSeatPermission.copy(data, 0);
  data.writeUInt8(seatIndex, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: seatPda, isSigner: false, isWritable: false },
      { pubkey: seatCardsPda, isSigner: false, isWritable: false },
      { pubkey: permissionPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Permissionless: undelegate + close a consumed DepositProof on ER.
 * Call this on ER to free stale DepositProof PDAs that block seat re-use.
 */
export function buildCleanupDepositProofInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  seatPda?: PublicKey, // Pass seat PDA for unconsumed proofs (contract requires remaining_accounts[0] = seat when not consumed)
): TransactionInstruction {
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
  const MAGIC_PROGRAM_ID = new PublicKey('Magic11111111111111111111111111111111111111');
  const MAGIC_CONTEXT_ID = new PublicKey('MagicContext1111111111111111111111111111111');

  const data = Buffer.alloc(9);
  DISCRIMINATORS.cleanupDepositProof.copy(data, 0);
  data.writeUInt8(seatIndex, 8);

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: false },
    { pubkey: depositProofPda, isSigner: false, isWritable: true },
    { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    { pubkey: MAGIC_FEE_VAULT, isSigner: false, isWritable: true },
  ];
  // For unconsumed proofs, contract requires seat PDA in remaining_accounts to verify seat is Empty
  if (seatPda) {
    keys.push({ pubkey: seatPda, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Permissionless: undelegate a SeatCards PDA on ER. For cash tables the contract
 * only permits this when the table phase is Complete (table shutdown). Mirrors the
 * crank's buildCleanupSeatCardsIx. Sent to the TEE RPC.
 */
export function buildCleanupSeatCardsInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
  const [seatPda] = getSeatPda(tablePda, seatIndex);

  const data = Buffer.alloc(9);
  DISCRIMINATORS.cleanupSeatCards.copy(data, 0);
  data.writeUInt8(seatIndex, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: seatCardsPda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: false },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_FEE_VAULT, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Build refund_failed_deposit instruction — permissionless refund of a failed deposit.
 * Runs on L1. Requires 3-minute timelock after deposit. Funds go to original depositor.
 * Seat must be Empty (player was never seated). Proof must not be consumed.
 */
export function buildRefundFailedDepositInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  playerWallet: PublicKey,
  tableId: Uint8Array,
  tableBump: number,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [vaultPda] = getVaultPda(tablePda);
  const [receiptPda] = getReceiptPda(tablePda, seatIndex);
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
  const [playerTableMarkerPda] = getPlayerTableMarkerPda(playerWallet, tablePda);

  const data = Buffer.alloc(42);
  DISCRIMINATORS.refundFailedDeposit.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  Buffer.from(tableId).copy(data, 9, 0, 32);
  data.writeUInt8(tableBump, 41);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: seatPda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: receiptPda, isSigner: false, isWritable: true },
      { pubkey: depositProofPda, isSigner: false, isWritable: true },
      { pubkey: playerWallet, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: playerTableMarkerPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Clear a stale PlayerTableMarker after a failed join was already refunded.
 * No funds move; the contract requires clean DepositProof + CashoutReceipt.
 */
export function buildClearStaleJoinMarkerInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  playerWallet: PublicKey,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [receiptPda] = getReceiptPda(tablePda, seatIndex);
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
  const [playerTableMarkerPda] = getPlayerTableMarkerPda(playerWallet, tablePda);

  const data = Buffer.alloc(9);
  DISCRIMINATORS.clearStaleJoinMarker.copy(data, 0);
  data.writeUInt8(seatIndex, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: seatPda, isSigner: false, isWritable: false },
      { pubkey: receiptPda, isSigner: false, isWritable: false },
      { pubkey: depositProofPda, isSigner: false, isWritable: false },
      { pubkey: playerWallet, isSigner: false, isWritable: false },
      { pubkey: playerTableMarkerPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

export function buildDelegateGlobalEntropyPermission(
  payer: PublicKey,
  delegationProgramId: PublicKey,
): TransactionInstruction {
  const [globalEntropyPda] = getGlobalEntropyPda();
  const [permPda] = getPermissionPda(globalEntropyPda);
  const [validatorRegistryPda] = getValidatorRegistryPda();
  const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
  const rec = delegationRecordPdaFromDelegatedAccount(permPda);
  const meta = delegationMetadataPdaFromDelegatedAccount(permPda);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    data: DISCRIMINATORS.delegateGlobalEntropyPermission,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: globalEntropyPda, isSigner: false, isWritable: true },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: rec, isSigner: false, isWritable: true },
      { pubkey: meta, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
    ],
  });
}

/**
 * Build clear_accumulated_rake instruction (ER)
 * Zeroes table.rake_accumulated after successful L1 distribution
 */
export function buildClearAccumulatedRakeInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: true },
    ],
    data: DISCRIMINATORS.clearAccumulatedRake,
  });
}

/**
 * Build close_table instruction
 * Closes a table and returns rent to creator. Cash games: must have 0 players.
 *
 * remaining_accounts layout (per seat): [player_wallet, seat_pda, seat_cards_pda, marker_pda]
 * After all seats: vault_pda, receipt PDAs (one per seat)
 *
 * Always uses creator as wallet for all seats — creator paid for all PDA rent at
 * init_table_seat, so all rent returns to creator. This also keeps unique account
 * keys minimal (~33 for 9-max) to fit within Solana's 1232-byte TX limit.
 */
export function buildCloseTableInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  creator: PublicKey,
  maxPlayers: number = 0,
  splClose?: {
    tokenEscrow?: PublicKey | null;
    creatorTokenAccount?: PublicKey | null;
    tokenProgram?: PublicKey | null;
  },
  cleanupMode: 'full' | 'minimal' = 'full',
): TransactionInstruction {
  const remaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];

  // Per-seat groups of 4: [player_wallet, seat_pda, seat_cards_pda, marker_pda]
  // Use creator for all wallets — they paid the rent, they get it back.
  // This also ensures only 1 unique marker PDA (all derived from same wallet+table).
  const [markerPda] = getPlayerTableMarkerPda(creator, tablePda);
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = getSeatPda(tablePda, i);
    const [seatCardsPda] = getSeatCardsPda(tablePda, i);

    remaining.push(
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: seatCardsPda, isSigner: false, isWritable: true },
      { pubkey: markerPda, isSigner: false, isWritable: true },
    );
  }

  // Vault, DeckState, and receipt PDAs — rent goes to creator
  const [vaultPda] = getVaultPda(tablePda);
  remaining.push({ pubkey: vaultPda, isSigner: false, isWritable: true });

  if (cleanupMode === 'full') {
    const [tipJarPda] = getTipJarPda(tablePda);
    remaining.push({ pubkey: tipJarPda, isSigner: false, isWritable: true });

    const [deckStatePda] = getDeckStatePda(tablePda);
    remaining.push({ pubkey: deckStatePda, isSigner: false, isWritable: true });

    const [handReportBufferPda] = getHandReportBufferPda(tablePda);
    remaining.push({ pubkey: handReportBufferPda, isSigner: false, isWritable: true });

    const [handReportFlushStatePda] = getHandReportFlushStatePda(tablePda);
    remaining.push({ pubkey: handReportFlushStatePda, isSigner: false, isWritable: true });

    const [slimBufferPda] = getSlimBufferPda(tablePda);
    remaining.push({ pubkey: slimBufferPda, isSigner: false, isWritable: true });

    const [crankTallyErPda] = getCrankTallyErPda(tablePda);
    remaining.push({ pubkey: crankTallyErPda, isSigner: false, isWritable: true });

    const [crankTallyL1Pda] = getCrankTallyL1Pda(tablePda);
    remaining.push({ pubkey: crankTallyL1Pda, isSigner: false, isWritable: true });

    for (let i = 0; i < maxPlayers; i++) {
      const [receiptPda] = getReceiptPda(tablePda, i);
      remaining.push({ pubkey: receiptPda, isSigner: false, isWritable: true });
    }

    for (let i = 0; i < maxPlayers; i++) {
      const [depositProofPda] = getDepositProofPda(tablePda, i);
      remaining.push({ pubkey: depositProofPda, isSigner: false, isWritable: true });
    }
  }

  const keys = [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      {
        pubkey: splClose?.tokenEscrow ?? ANCHOR_PROGRAM_ID,
        isSigner: false,
        isWritable: !!splClose?.tokenEscrow,
      },
      {
        pubkey: splClose?.creatorTokenAccount ?? ANCHOR_PROGRAM_ID,
        isSigner: false,
        isWritable: !!splClose?.creatorTokenAccount,
      },
      {
        pubkey: splClose?.tokenEscrow
          ? (splClose.tokenProgram ?? TOKEN_PROGRAM_ID)
          : ANCHOR_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      ...remaining,
  ];

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data: DISCRIMINATORS.closeTable,
  });
}

export function buildCleanupTableAccountsInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  creator: PublicKey,
  accounts: PublicKey[],
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: false, isWritable: true },
      ...accounts.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: DISCRIMINATORS.cleanupTableAccounts,
  });
}

export function getTablePermissionCleanupAccounts(
  tablePda: PublicKey,
  maxPlayers: number,
  startSeat: number = 0,
  seatCount: number = maxPlayers,
  includeBase: boolean = true,
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  const accounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  if (includeBase) {
    const deckState = getDeckStatePda(tablePda)[0];
    accounts.push(
      { pubkey: getPermissionPda(tablePda)[0], isSigner: false, isWritable: true },
      { pubkey: deckState, isSigner: false, isWritable: false },
      { pubkey: getPermissionPda(deckState)[0], isSigner: false, isWritable: true },
    );
  }

  const endSeat = Math.min(maxPlayers, startSeat + seatCount);
  for (let i = startSeat; i < endSeat; i++) {
    const seat = getSeatPda(tablePda, i)[0];
    const seatCards = getSeatCardsPda(tablePda, i)[0];
    accounts.push(
      { pubkey: seat, isSigner: false, isWritable: false },
      { pubkey: getPermissionPda(seat)[0], isSigner: false, isWritable: true },
      { pubkey: seatCards, isSigner: false, isWritable: false },
      { pubkey: getPermissionPda(seatCards)[0], isSigner: false, isWritable: true },
    );
  }

  return accounts;
}

export function buildCleanupTablePermissionsInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  maxPlayers: number,
  startSeat: number = 0,
  seatCount: number = maxPlayers,
  includeBase: boolean = true,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      ...getTablePermissionCleanupAccounts(tablePda, maxPlayers, startSeat, seatCount, includeBase),
    ],
    data: Buffer.concat([
      DISCRIMINATORS.cleanupTablePermissions,
      Buffer.from([startSeat, seatCount, includeBase ? 1 : 0]),
    ]),
  });
}

export function buildCleanupTablePermissionsInstructions(
  payer: PublicKey,
  tablePda: PublicKey,
  maxPlayers: number,
  chunkSize: number = 3,
): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  for (let start = 0; start < maxPlayers; start += chunkSize) {
    const seatCount = Math.min(chunkSize, maxPlayers - start);
    ixs.push(buildCleanupTablePermissionsInstruction(
      payer,
      tablePda,
      maxPlayers,
      start,
      seatCount,
      start === 0,
    ));
  }
  return ixs;
}


/**
 * Build sit_out instruction (cash games — player stays at table but skips hands)
 */
export function buildSitOutInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      // Player is NOT writable per contract (sit_out.rs:19) — TEE rejects
      // writable non-delegated accounts.
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data: DISCRIMINATORS.sitOut,
  });
}

/**
 * Build sit_in instruction (return from sitting out)
 * post_missed_blinds: if true, deducts missed BB/SB from chips immediately
 */
export function buildSitInInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  postMissedBlinds: boolean = true,
  whitelistPlayer?: PublicKey,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  // Data: discriminator(8) + post_missed_blinds(1)
  const data = Buffer.alloc(9);
  DISCRIMINATORS.sitIn.copy(data, 0);
  data.writeUInt8(postMissedBlinds ? 1 : 0, 8);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      ...(whitelistPlayer
        ? [{ pubkey: getWhitelistPda(tablePda, whitelistPlayer)[0], isSigner: false, isWritable: false }]
        : []),
    ],
    data,
  });
}

export { DISCRIMINATORS };

// ============================================
// UNCLAIMED BALANCE HELPERS (Cash Games)
// ============================================

const UNCLAIMED_SEED = 'unclaimed';

// Additional discriminators for unclaimed balance instructions
const UNCLAIMED_DISCRIMINATORS = {
  forceReleaseSeat: ixDisc('force_release_seat'),
  claimUnclaimed: ixDisc('claim_unclaimed'),
  claimUnclaimedSol: IX_DISC.claimUnclaimedSol,
  reclaimExpired: ixDisc('reclaim_expired'),
};

/**
 * Get UnclaimedBalance PDA for a player at a specific table
 * Seeds: ["unclaimed", table_pubkey, player_pubkey]
 */
export function getUnclaimedBalancePda(tablePda: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(UNCLAIMED_SEED), tablePda.toBuffer(), player.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

/**
 * Get escrow authority PDA for a table (controls token escrow)
 * Seeds: ["escrow", table_pubkey]
 */
export function getEscrowAuthorityPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

/**
 * Check if an unclaimed balance exists for a player at a table
 */
export async function checkUnclaimedBalance(
  connection: Connection,
  tablePda: PublicKey,
  player: PublicKey
): Promise<{ exists: boolean; amount: number; lastActiveAt: number } | null> {
  const [unclaimedPda] = getUnclaimedBalancePda(tablePda, player);
  
  try {
    const accountInfo = await connection.getAccountInfo(unclaimedPda);
    if (!accountInfo || accountInfo.data.length === 0) {
      return { exists: false, amount: 0, lastActiveAt: 0 };
    }
    
    // Parse UnclaimedBalance: discriminator(8) + player(32) + table(32) + amount(8) + last_active_at(8) + bump(1)
    const data = accountInfo.data;
    const amount = Number(data.readBigUInt64LE(72)); // 8 + 32 + 32 = 72
    const lastActiveAt = Number(data.readBigInt64LE(80)); // 72 + 8 = 80
    
    return { exists: true, amount, lastActiveAt };
  } catch (e) {
    console.error('Failed to check unclaimed balance:', e);
    return null;
  }
}

/**
 * Build claim_unclaimed instruction (player claims their unclaimed balance)
 */
export function buildClaimUnclaimedInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  tableTokenAccount: PublicKey,
  playerTokenAccount: PublicKey
): TransactionInstruction {
  const [unclaimedPda] = getUnclaimedBalancePda(tablePda, player);
  const [escrowAuthorityPda] = getEscrowAuthorityPda(tablePda);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: unclaimedPda, isSigner: false, isWritable: true },
      { pubkey: tableTokenAccount, isSigner: false, isWritable: true },
      { pubkey: playerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: escrowAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: UNCLAIMED_DISCRIMINATORS.claimUnclaimed,
  });
}

/**
 * Build claim_unclaimed_sol instruction (SOL tables — lamports from table PDA)
 * PERMISSIONLESS: anyone can call it. SOL goes to playerWallet, rent to caller.
 * For player self-claim, caller == playerWallet.
 */
export function buildClaimUnclaimedSolInstruction(
  caller: PublicKey,
  tablePda: PublicKey,
  playerWallet?: PublicKey,
): TransactionInstruction {
  const wallet = playerWallet || caller;
  const [unclaimedPda] = getUnclaimedBalancePda(tablePda, wallet);
  // The contract (claim_unclaimed_sol.rs) moves lamports OUT of the TableVault PDA
  // (seeds = [VAULT_SEED, table]) into the player's wallet. The builder previously
  // omitted the vault account, so the IX resolved to the wrong 5-account layout and
  // ALWAYS reverted — every "Claim SOL" button (in-game + profile fund history) was
  // dead. Order must mirror the deployed struct exactly:
  // caller, table, vault, unclaimed, player_wallet, system.
  const [vaultPda] = getVaultPda(tablePda);

  // Instruction data: discriminator(8) + player_wallet(32)
  const data = Buffer.alloc(40);
  UNCLAIMED_DISCRIMINATORS.claimUnclaimedSol.copy(data, 0);
  wallet.toBuffer().copy(data, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: unclaimedPda, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build reclaim_expired instruction (creator reclaims expired unclaimed balance)
 */
export function buildReclaimExpiredInstruction(
  creator: PublicKey,
  tablePda: PublicKey,
  player: PublicKey, // Player whose expired balance to reclaim
  tableTokenAccount: PublicKey,
  creatorTokenAccount: PublicKey
): TransactionInstruction {
  const [unclaimedPda] = getUnclaimedBalancePda(tablePda, player);
  const [escrowAuthorityPda] = getEscrowAuthorityPda(tablePda);

  // Instruction data: discriminator(8) + player(32)
  const data = Buffer.alloc(40);
  UNCLAIMED_DISCRIMINATORS.reclaimExpired.copy(data, 0);
  player.toBuffer().copy(data, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: unclaimedPda, isSigner: false, isWritable: true },
      { pubkey: tableTokenAccount, isSigner: false, isWritable: true },
      { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: escrowAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}


/**
 * Calculate if an unclaimed balance is expired (100 days from last_active_at)
 */
export function isUnclaimedExpired(lastActiveAt: number): boolean {
  const UNCLAIMED_EXPIRY_SECONDS = 100 * 24 * 60 * 60; // 100 days
  const now = Math.floor(Date.now() / 1000);
  return now >= lastActiveAt + UNCLAIMED_EXPIRY_SECONDS;
}

/**
 * Calculate days until unclaimed balance expires
 */
export function daysUntilExpiry(lastActiveAt: number): number {
  const UNCLAIMED_EXPIRY_SECONDS = 100 * 24 * 60 * 60; // 100 days
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = lastActiveAt + UNCLAIMED_EXPIRY_SECONDS;
  const secondsRemaining = expiresAt - now;
  return Math.max(0, Math.ceil(secondsRemaining / (24 * 60 * 60)));
}

// ─── Token Listing Auction Instructions (Permissionless) ───
// Epoch tracked by AuctionConfig singleton PDA (adaptive duration).
// Launch fallback: Math.floor(unixTimestamp / 259200) when AuctionConfig is unavailable.

const AUCTION_EPOCH_SECS = 259_200;
const AUCTION_SEED = Buffer.from('auction');
const AUCTION_CONFIG_SEED = Buffer.from('auction_config');
const LISTED_TOKEN_SEED = Buffer.from('listed_token');
const GLOBAL_BID_SEED = Buffer.from('global_bid');
const GLOBAL_CONTRIB_SEED = Buffer.from('global_contrib');
const AUCTION_RANK_SEED = Buffer.from('auction_rank');

/** AuctionConfig singleton PDA */
export function getAuctionConfigPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [AUCTION_CONFIG_SEED],
    FASTPOKER_REGISTRY_PROGRAM_ID,
  );
  return pda;
}

/** Parse AuctionConfig from on-chain data (69-byte layout) */
export function parseAuctionConfig(data: Buffer): {
  currentEpoch: bigint;
  currentEpochStart: number;
  currentEpochDuration: number;
  lastTotalBid: bigint;
  totalActiveMints: number;
  minDuration: number;
  stepDuration: number;
  maxDuration: number;
} {
  return {
    currentEpoch: data.readBigUInt64LE(8),
    currentEpochStart: Number(data.readBigInt64LE(16)),
    currentEpochDuration: Number(data.readBigInt64LE(24)),
    lastTotalBid: data.readBigUInt64LE(32),
    totalActiveMints: data.readUInt32LE(40),
    minDuration: Number(data.readBigInt64LE(44)),
    stepDuration: Number(data.readBigInt64LE(52)),
    maxDuration: Number(data.readBigInt64LE(60)),
  };
}

/** Fallback: compute wall-clock epoch (for old/legacy epochs before config existed) */
export function getCurrentAuctionEpoch(): bigint {
  return BigInt(Math.floor(Date.now() / 1000 / AUCTION_EPOCH_SECS));
}

/** Fallback: wall-clock based end time */
export function getAuctionEndTime(epoch: bigint): number {
  return Number((epoch + BigInt(1)) * BigInt(AUCTION_EPOCH_SECS)) * 1000; // ms
}

export function getAuctionPda(epoch: bigint): PublicKey {
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch);
  const [pda] = PublicKey.findProgramAddressSync(
    [AUCTION_SEED, epochBuf],
    FASTPOKER_REGISTRY_PROGRAM_ID,
  );
  return pda;
}


/** Global persistent bid PDA — carries across epochs. Seeds: ["global_bid", mint] */
export function getGlobalBidPda(candidateMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [GLOBAL_BID_SEED, candidateMint.toBuffer()],
    FASTPOKER_REGISTRY_PROGRAM_ID,
  );
  return pda;
}

export function getAuctionRankPda(candidateMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [AUCTION_RANK_SEED, candidateMint.toBuffer()],
    FASTPOKER_REGISTRY_PROGRAM_ID,
  );
  return pda;
}

/** Global persistent contribution PDA. Seeds: ["global_contrib", mint, bidder] */
export function getGlobalContribPda(candidateMint: PublicKey, bidder: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [GLOBAL_CONTRIB_SEED, candidateMint.toBuffer(), bidder.toBuffer()],
    FASTPOKER_REGISTRY_PROGRAM_ID,
  );
  return pda;
}

/** Anchor discriminator for GlobalTokenBid: sha256("account:GlobalTokenBid")[0..8] */
const GLOBAL_BID_DISCRIMINATOR = accountDisc('GlobalTokenBid');
const AUCTION_RANK_DISCRIMINATOR = accountDisc('AuctionRank');

/** Parse GlobalTokenBid (61 bytes) from on-chain data */
export function parseGlobalTokenBid(data: Buffer): { tokenMint: string; totalAmount: bigint; bidderCount: number; firstBidAt: number } | null {
  if (data.length < GLOBAL_BID_DATA_SIZE) return null;
  if (!data.subarray(0, 8).equals(GLOBAL_BID_DISCRIMINATOR)) return null;
  return {
    tokenMint: new PublicKey(data.subarray(8, 40)).toBase58(),
    totalAmount: data.readBigUInt64LE(40),
    bidderCount: data.readUInt32LE(48),
    firstBidAt: Number(data.readBigInt64LE(53)),
  };
}

/** GlobalTokenBid account size for getProgramAccounts filter */
export const GLOBAL_BID_DATA_SIZE = 61;
export const AUCTION_RANK_DATA_SIZE = 122;

export function parseAuctionRank(data: Buffer): {
  tokenMint: string;
  totalAmount: bigint;
  firstBidAt: number;
  prevMint: string;
  nextMint: string;
  active: boolean;
} | null {
  if (data.length < AUCTION_RANK_DATA_SIZE) return null;
  if (!data.subarray(0, 8).equals(AUCTION_RANK_DISCRIMINATOR)) return null;
  return {
    tokenMint: new PublicKey(data.subarray(8, 40)).toBase58(),
    totalAmount: data.readBigUInt64LE(40),
    firstBidAt: Number(data.readBigInt64LE(48)),
    prevMint: new PublicKey(data.subarray(56, 88)).toBase58(),
    nextMint: new PublicKey(data.subarray(88, 120)).toBase58(),
    active: data[120] === 1,
  };
}

/**
 * Bid SOL for a candidate token mint to be listed.
 * CPI into Steel's DepositPublicRevenue — Steel handles 50/50 split
 * (treasury + pool for staker rewards) and updates staker accounting.
 * Permissionless — auto-creates auction PDA for current epoch on first bid.
 */
export function buildPlaceBidInstruction(
  bidder: PublicKey,
  candidateMint: PublicKey,
  amountLamports: bigint,
  epoch: bigint,
  placement?: {
    insertPrevMint?: PublicKey | null;
    insertNextMint?: PublicKey | null;
    extraRankMints?: PublicKey[];
  },
): TransactionInstruction {
  const configPda = getAuctionConfigPda();
  const auctionPda = getAuctionPda(epoch);
  const globalBidPda = getGlobalBidPda(candidateMint);
  const globalContribPda = getGlobalContribPda(candidateMint, bidder);
  // listed_token_check: PDA at seeds [b"listed_token", mint]. Handler rejects
  // the bid if this account is already initialized (= mint already won).
  const listedTokenCheckPda = getListedTokenPda(candidateMint);

  const insertPrevMint = placement?.insertPrevMint ?? PublicKey.default;
  const insertNextMint = placement?.insertNextMint ?? PublicKey.default;
  const data = Buffer.alloc(8 + 8 + 8 + 32 + 32);
  Buffer.from(DISCRIMINATORS.placeBid).copy(data, 0);
  data.writeBigUInt64LE(epoch, 8);
  data.writeBigUInt64LE(amountLamports, 16);
  insertPrevMint.toBuffer().copy(data, 24);
  insertNextMint.toBuffer().copy(data, 56);

  const rankAccounts = new Map<string, PublicKey>();
  for (const mint of placement?.extraRankMints ?? []) {
    if (!mint.equals(candidateMint)) rankAccounts.set(mint.toBase58(), getAuctionRankPda(mint));
  }
  if (!insertPrevMint.equals(PublicKey.default) && !insertPrevMint.equals(candidateMint)) {
    rankAccounts.set(insertPrevMint.toBase58(), getAuctionRankPda(insertPrevMint));
  }
  if (!insertNextMint.equals(PublicKey.default) && !insertNextMint.equals(candidateMint)) {
    rankAccounts.set(insertNextMint.toBase58(), getAuctionRankPda(insertNextMint));
  }

  return new TransactionInstruction({
    programId: FASTPOKER_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: bidder, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: auctionPda, isSigner: false, isWritable: true },
      { pubkey: candidateMint, isSigner: false, isWritable: false },
      { pubkey: globalBidPda, isSigner: false, isWritable: true },
      { pubkey: getAuctionRankPda(candidateMint), isSigner: false, isWritable: true },
      { pubkey: globalContribPda, isSigner: false, isWritable: true },
      { pubkey: listedTokenCheckPda, isSigner: false, isWritable: false },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...[...rankAccounts.values()].map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
    ],
    data,
  });
}

export function getListedTokenPda(tokenMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [LISTED_TOKEN_SEED, tokenMint.toBuffer()],
    FASTPOKER_REGISTRY_PROGRAM_ID,
  );
  return pda;
}

export function getTokenTierConfigPda(tokenMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(TIER_CONFIG_SEED), tokenMint.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

export function getSplRewardPoolPda(tokenMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('spl_reward_pool'), tokenMint.toBuffer()],
    STEEL_PROGRAM_ID,
  );
  return pda;
}

export function getSplStakerClaimPda(staker: PublicKey, tokenMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('spl_staker_claim'), staker.toBuffer(), tokenMint.toBuffer()],
    STEEL_PROGRAM_ID,
  );
  return pda;
}

export function getPrizeAuthorityPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('prize_authority')],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

export function buildInitSplRewardPoolInstruction(
  payer: PublicKey,
  tokenMint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: STEEL_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: getSplRewardPoolPda(tokenMint), isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: false },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([29]), tokenMint.toBuffer()]),
  });
}

/** ListedToken account size for getProgramAccounts filter */
export const LISTED_TOKEN_DATA_SIZE = 57; // 8 disc + 32 mint + 8 epoch + 8 listed_at + 1 bump

/** Parse ListedToken from on-chain data */
export function parseListedToken(data: Buffer): { tokenMint: string; winningEpoch: bigint; listedAt: number } | null {
  if (data.length < 57) return null;
  return {
    tokenMint: new PublicKey(data.subarray(8, 40)).toBase58(),
    winningEpoch: data.readBigUInt64LE(40),
    listedAt: Number(data.readBigInt64LE(48)),
  };
}

/**
 * Resolve an ended auction epoch - permissionless, anyone (crank) can call.
 * Pass the stored linked-rank head plus the optional next-rank PDA. The
 * contract no longer scans every challenger; place_bid maintains the order.
 * Creates a ListedToken PDA so the winning mint can be used for cash game tables.
 */
export function buildResolveAuctionInstruction(
  payer: PublicKey,
  epoch: bigint,
  winningMint: PublicKey,
  nextWinningMint: PublicKey | null = null,
): TransactionInstruction {
  const configPda = getAuctionConfigPda();
  const auctionPda = getAuctionPda(epoch);
  const nextAuctionPda = getAuctionPda(epoch + BigInt(1));
  const winningBidPda = getGlobalBidPda(winningMint);
  const winningRankPda = getAuctionRankPda(winningMint);
  const listedTokenPda = getListedTokenPda(winningMint);

  const data = Buffer.alloc(8);
  Buffer.from(DISCRIMINATORS.resolveAuction).copy(data, 0);

  return new TransactionInstruction({
    programId: FASTPOKER_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: auctionPda, isSigner: false, isWritable: true },
      { pubkey: winningBidPda, isSigner: false, isWritable: true },
      { pubkey: winningRankPda, isSigner: false, isWritable: true },
      { pubkey: nextAuctionPda, isSigner: false, isWritable: true },
      { pubkey: listedTokenPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...(nextWinningMint && !nextWinningMint.equals(PublicKey.default)
        ? [{ pubkey: getAuctionRankPda(nextWinningMint), isSigner: false, isWritable: true }]
        : []),
    ],
    data,
  });
}

/** Admin-only: live-tune auction durations (used for 7-min devnet tests, 7-day prod). */
export function buildAdminSetAuctionDurationInstruction(
  admin: PublicKey,
  currentDurationSecs: bigint,
  minDurationSecs: bigint,
  stepDurationSecs: bigint,
  maxDurationSecs: bigint,
): TransactionInstruction {
  const configPda = getAuctionConfigPda();
  const data = Buffer.alloc(8 + 8 * 4);
  DISCRIMINATORS.adminSetAuctionDuration.copy(data, 0);
  data.writeBigInt64LE(currentDurationSecs, 8);
  data.writeBigInt64LE(minDurationSecs, 16);
  data.writeBigInt64LE(stepDurationSecs, 24);
  data.writeBigInt64LE(maxDurationSecs, 32);
  return new TransactionInstruction({
    programId: FASTPOKER_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Admin-only: close AuctionConfig PDA (devnet reset). Rent returns to admin. */
export function buildAdminCloseAuctionConfigInstruction(admin: PublicKey): TransactionInstruction {
  const configPda = getAuctionConfigPda();
  const data = Buffer.alloc(8);
  DISCRIMINATORS.adminCloseAuctionConfig.copy(data, 0);
  return new TransactionInstruction({
    programId: FASTPOKER_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Admin-only: close a per-epoch AuctionState PDA. */
export function buildAdminCloseAuctionStateInstruction(
  admin: PublicKey,
  epoch: bigint,
): TransactionInstruction {
  const auctionPda = getAuctionPda(epoch);
  const data = Buffer.alloc(8);
  DISCRIMINATORS.adminCloseAuctionState.copy(data, 0);
  return new TransactionInstruction({
    programId: FASTPOKER_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: auctionPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Admin-only: close a GlobalTokenBid (leaderboard entry). Decrements active-mint counter if non-zero. */
export function buildAdminCloseGlobalBidInstruction(
  admin: PublicKey,
  tokenMint: PublicKey,
): TransactionInstruction {
  const configPda = getAuctionConfigPda();
  const globalBidPda = getGlobalBidPda(tokenMint);
  const data = Buffer.alloc(8);
  DISCRIMINATORS.adminCloseGlobalBid.copy(data, 0);
  return new TransactionInstruction({
    programId: FASTPOKER_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: globalBidPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Admin-only: close a ListedToken PDA (delist). */
export function buildAdminCloseListedTokenInstruction(
  admin: PublicKey,
  tokenMint: PublicKey,
): TransactionInstruction {
  const listedTokenPda = getListedTokenPda(tokenMint);
  const data = Buffer.alloc(8);
  DISCRIMINATORS.adminCloseListedToken.copy(data, 0);
  return new TransactionInstruction({
    programId: FASTPOKER_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: listedTokenPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Admin-only: close a per-(mint,bidder) GlobalBidContribution receipt. */
export function buildAdminCloseGlobalContributionInstruction(
  admin: PublicKey,
  tokenMint: PublicKey,
  bidder: PublicKey,
): TransactionInstruction {
  const globalContribPda = getGlobalContribPda(tokenMint, bidder);
  const data = Buffer.alloc(8);
  DISCRIMINATORS.adminCloseGlobalContribution.copy(data, 0);
  return new TransactionInstruction({
    programId: FASTPOKER_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: globalContribPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Admin-only: manually create a ListedToken PDA for a token mint.
 * Bypasses auction epoch — used to restore listings after redeploy.
 */
export function buildAdminListTokenInstruction(
  admin: PublicKey,
  tokenMint: PublicKey,
  epoch: bigint,
): TransactionInstruction {
  const listedTokenPda = getListedTokenPda(tokenMint);
  const data = Buffer.alloc(16);
  DISCRIMINATORS.adminListToken.copy(data, 0);
  data.writeBigUInt64LE(epoch, 8);
  return new TransactionInstruction({
    programId: FASTPOKER_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: listedTokenPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitializeAuctionConfigInstruction(
  payer: PublicKey,
): TransactionInstruction {
  const configPda = getAuctionConfigPda();
  return new TransactionInstruction({
    programId: FASTPOKER_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.initializeAuctionConfig),
  });
}

// ─── Rake Vault Instructions ───

const RAKE_VAULT_SEED = Buffer.from('rake_vault');
const STAKER_CLAIM_SEED = Buffer.from('staker_claim');

export function getRakeVaultPda(tokenMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [RAKE_VAULT_SEED, tokenMint.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

export function getStakerClaimPda(rakeVault: PublicKey, staker: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [STAKER_CLAIM_SEED, rakeVault.toBuffer(), staker.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

/**
 * Admin: initialize a RakeVault for a token mint
 */
export function buildInitRakeVaultInstruction(
  admin: PublicKey,
  tokenMint: PublicKey,
  vaultTokenAccount: PublicKey,
): TransactionInstruction {
  const rakeVaultPda = getRakeVaultPda(tokenMint);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: rakeVaultPda, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.initRakeVault),
  });
}

/**
 * Deposit rake tokens into a vault (crank calls after distribute_rake)
 */
export function buildDepositToVaultInstruction(
  depositor: PublicKey,
  tokenMint: PublicKey,
  sourceTokenAccount: PublicKey,
  vaultTokenAccount: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const rakeVaultPda = getRakeVaultPda(tokenMint);
  const data = Buffer.alloc(8 + 8);
  Buffer.from(DISCRIMINATORS.depositToVault).copy(data, 0);
  data.writeBigUInt64LE(amount, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: rakeVaultPda, isSigner: false, isWritable: true },
      { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Staker claims their proportional share of rake from a vault
 */
export function buildClaimRakeRewardInstruction(
  staker: PublicKey,
  tokenMint: PublicKey,
  vaultTokenAccount: PublicKey,
  stakerTokenAccount: PublicKey,
  pool: PublicKey,
  stakeAccount: PublicKey,
): TransactionInstruction {
  const rakeVaultPda = getRakeVaultPda(tokenMint);
  const stakerClaimPda = getStakerClaimPda(rakeVaultPda, staker);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: staker, isSigner: true, isWritable: true },
      { pubkey: rakeVaultPda, isSigner: false, isWritable: true },
      { pubkey: stakerClaimPda, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: stakerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: stakeAccount, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.claimRakeReward),
  });
}

/**
 * Build update_seat_permission_tee instruction.
 * Rewrites SeatCards permission around the program and current player.
 * Verifies the seat against a canonical occupant proof before updating permissions.
 */
export function buildUpdateSeatPermissionTeeInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  occupantProof?: PublicKey,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
  const [permissionPda] = getPermissionPda(seatCardsPda);
  const [defaultOccupantProof] = getJackpotEntryPda(tablePda, seatIndex);
  const data = Buffer.alloc(9);
  IX_DISC.updateSeatPermissionTee.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer,              isSigner: true,  isWritable: false },
      { pubkey: tablePda,           isSigner: false, isWritable: false },
      { pubkey: seatPda,            isSigner: false, isWritable: true  },
      { pubkey: occupantProof ?? defaultOccupantProof, isSigner: false, isWritable: false },
      { pubkey: seatCardsPda,       isSigner: false, isWritable: true  },
      { pubkey: permissionPda,      isSigner: false, isWritable: true  },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ===================================================================
// SNG Pool -- PDA Derivation
// ===================================================================

export function getSngPoolPda(gameType: number, tier: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SNG_POOL_SEED), Buffer.from([gameType]), Buffer.from([tier])],
    ANCHOR_PROGRAM_ID,
  );
}

export function getSngPoolVaultPda(gameType: number, tier: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SNG_POOL_VAULT_SEED), Buffer.from([gameType]), Buffer.from([tier])],
    ANCHOR_PROGRAM_ID,
  );
}

export function getSngQueuePagePda(pool: PublicKey, pageIndex: number): [PublicKey, number] {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(pageIndex);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SNG_QUEUE_PAGE_SEED), pool.toBuffer(), buf],
    ANCHOR_PROGRAM_ID,
  );
}

export function getSngQueueMarkerPda(pool: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SNG_QUEUE_MARKER_SEED), pool.toBuffer(), player.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
}

export function getSngMatchPda(pool: PublicKey, matchId: bigint | number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(matchId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SNG_MATCH_SEED), pool.toBuffer(), buf],
    ANCHOR_PROGRAM_ID,
  );
}

export function getJackpotGlobalPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(JACKPOT_GLOBAL_SEED)],
    ANCHOR_PROGRAM_ID,
  );
}

export interface JackpotGlobalState {
  authority: PublicKey;
  miniPoolLamports: bigint;
  grandUnrefinedPool: bigint;
  handsSinceMiniHit: bigint;
  handsSinceGrandHit: bigint;
  miniOddsDenominator: bigint;
  grandOddsDenominator: bigint;
  activeMiniWeight: bigint;
  activeGrandWeight: bigint;
  grandAccUnrefinedPerWeight: bigint;
  hitSequence: bigint;
  miniBucketWeights: bigint[];
  grandBucketWeights: bigint[];
  bump: number;
}

const JACKPOT_BUCKET_COUNT = 21;
const JACKPOT_GLOBAL_SIZE = 8 + 32 + (9 * 8) + 16 + (8 * JACKPOT_BUCKET_COUNT * 2) + 1;

function readU128LE(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  return lo + (hi << 64n);
}

export function parseJackpotGlobal(data: Buffer): JackpotGlobalState {
  if (data.length < JACKPOT_GLOBAL_SIZE) {
    throw new Error(`JackpotGlobal account too small: ${data.length}`);
  }

  let offset = 8; // discriminator
  const authority = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const miniPoolLamports = data.readBigUInt64LE(offset); offset += 8;
  const grandUnrefinedPool = data.readBigUInt64LE(offset); offset += 8;
  const handsSinceMiniHit = data.readBigUInt64LE(offset); offset += 8;
  const handsSinceGrandHit = data.readBigUInt64LE(offset); offset += 8;
  const miniOddsDenominator = data.readBigUInt64LE(offset); offset += 8;
  const grandOddsDenominator = data.readBigUInt64LE(offset); offset += 8;
  const activeMiniWeight = data.readBigUInt64LE(offset); offset += 8;
  const activeGrandWeight = data.readBigUInt64LE(offset); offset += 8;
  const grandAccUnrefinedPerWeight = readU128LE(data, offset); offset += 16;
  const hitSequence = data.readBigUInt64LE(offset); offset += 8;

  const miniBucketWeights: bigint[] = [];
  for (let i = 0; i < JACKPOT_BUCKET_COUNT; i++) {
    miniBucketWeights.push(data.readBigUInt64LE(offset));
    offset += 8;
  }

  const grandBucketWeights: bigint[] = [];
  for (let i = 0; i < JACKPOT_BUCKET_COUNT; i++) {
    grandBucketWeights.push(data.readBigUInt64LE(offset));
    offset += 8;
  }

  const bump = data.readUInt8(offset);

  return {
    authority,
    miniPoolLamports,
    grandUnrefinedPool,
    handsSinceMiniHit,
    handsSinceGrandHit,
    miniOddsDenominator,
    grandOddsDenominator,
    activeMiniWeight,
    activeGrandWeight,
    grandAccUnrefinedPerWeight,
    hitSequence,
    miniBucketWeights,
    grandBucketWeights,
    bump,
  };
}

export function getSngTablePda(poolPda: PublicKey, tableIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SNG_TABLE_SEED), poolPda.toBuffer(), Buffer.from([tableIndex])],
    ANCHOR_PROGRAM_ID,
  );
}

export function getCrankOperatorPda(crankWallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(CRANK_OPERATOR_SEED), crankWallet.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
}

// ===================================================================
// SNG Pool -- State Parser
// ===================================================================

export interface SngPoolState {
  gameType: number;
  tier: number;
  maxPlayers: number;
  entryAmount: bigint;
  feeAmount: bigint;
  waitingCount: number;
  nextTicket: bigint;
  headPageIndex: number;
  tailPageIndex: number;
  waitingBitmap: [bigint, bigint, bigint, bigint];
  nextTableIndex: number;
  matchEligibleAt: bigint;
  activeMatch: PublicKey;
  activeMatchSet: boolean;
  matchIdCounter: bigint;
  totalMatchedLifetime: bigint;
  queuePageRentReserveLamports: bigint;
  pageRentContributionLamports: bigint;
  bump: number;
}

export function parseSngPool(data: Buffer): SngPoolState {
  let offset = 8; // skip discriminator

  const gameType = data.readUInt8(offset); offset += 1;
  const tier = data.readUInt8(offset); offset += 1;
  const maxPlayers = data.readUInt8(offset); offset += 1;
  const entryAmount = data.readBigUInt64LE(offset); offset += 8;
  const feeAmount = data.readBigUInt64LE(offset); offset += 8;
  const waitingCount = data.readUInt32LE(offset); offset += 4;
  const nextTicket = data.readBigUInt64LE(offset); offset += 8;
  const headPageIndex = data.readUInt16LE(offset); offset += 2;
  const tailPageIndex = data.readUInt16LE(offset); offset += 2;
  const matchEligibleAt = data.readBigInt64LE(offset); offset += 8;
  const activeMatch = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const activeMatchSet = data.readUInt8(offset) !== 0; offset += 1;
  const matchIdCounter = data.readBigUInt64LE(offset); offset += 8;

  // Bitmap: 4 x u64
  const waitingBitmap: [bigint, bigint, bigint, bigint] = [
    data.readBigUInt64LE(offset),
    data.readBigUInt64LE(offset + 8),
    data.readBigUInt64LE(offset + 16),
    data.readBigUInt64LE(offset + 24),
  ];
  offset += 32;

  const nextTableIndex = data.readUInt8(offset); offset += 1;
  const totalMatchedLifetime = data.readBigUInt64LE(offset); offset += 8;
  const queuePageRentReserveLamports = data.readBigUInt64LE(offset); offset += 8;
  const pageRentContributionLamports = data.readBigUInt64LE(offset); offset += 8;
  const bump = data.readUInt8(offset); offset += 1;

  return {
    gameType, tier, maxPlayers, entryAmount, feeAmount,
    waitingCount, nextTicket, headPageIndex, tailPageIndex,
    waitingBitmap, nextTableIndex, matchEligibleAt, activeMatch,
    activeMatchSet, matchIdCounter, totalMatchedLifetime,
    queuePageRentReserveLamports, pageRentContributionLamports, bump,
  };
}

export interface SngQueuePageState {
  pool: PublicKey;
  pageIndex: number;
  activeMask: number;
  lockedMask: number;
  consumedMask: number;
  players: PublicKey[];
  approvedSigners: PublicKey[];
  miniOptIn: number[];
  tickets: bigint[];
}

export const SNG_QUEUE_PAGE_SLOTS = 12;
export const MAX_MATCH_SCAN_PAGES = 22;

export function parseSngQueuePage(data: Buffer): SngQueuePageState {
  let offset = 8;
  const pool = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const pageIndex = data.readUInt16LE(offset); offset += 2;
  const activeMask = data.readUInt32LE(offset); offset += 4;
  const lockedMask = data.readUInt32LE(offset); offset += 4;
  const consumedMask = data.readUInt32LE(offset); offset += 4;
  const players: PublicKey[] = [];
  for (let i = 0; i < SNG_QUEUE_PAGE_SLOTS; i++) {
    players.push(new PublicKey(data.subarray(offset, offset + 32)));
    offset += 32;
  }
  const approvedSigners: PublicKey[] = [];
  for (let i = 0; i < SNG_QUEUE_PAGE_SLOTS; i++) {
    approvedSigners.push(new PublicKey(data.subarray(offset, offset + 32)));
    offset += 32;
  }
  const miniOptIn: number[] = [];
  for (let i = 0; i < SNG_QUEUE_PAGE_SLOTS; i++) {
    miniOptIn.push(data.readUInt8(offset));
    offset += 1;
  }
  const tickets: bigint[] = [];
  for (let i = 0; i < SNG_QUEUE_PAGE_SLOTS; i++) {
    tickets.push(data.readBigUInt64LE(offset));
    offset += 8;
  }
  return { pool, pageIndex, activeMask, lockedMask, consumedMask, players, approvedSigners, miniOptIn, tickets };
}

export interface SngMatchState {
  pool: PublicKey;
  matchId: bigint;
  table: PublicKey;
  tableIndex: number;
  selectedPlayers: PublicKey[];
  selectedPages: number[];
  selectedSlots: number[];
  approvedSigners: PublicKey[];
  miniOptIn: number[];
  seatIndices: number[];
  seatedMask: number;
  selectedCount: number;
  seatedCount: number;
  candidateHash: Buffer;
  revealSlot: bigint;
  initiator: PublicKey;
  prepareBondLamports: bigint;
  candidatePageStart: number;
  candidatePageCount: number;
  candidateCount: number;
  entropySlot: bigint;
  lastActionAt: bigint;
  phase: number;
}

export function parseSngMatch(data: Buffer): SngMatchState {
  let offset = 8;
  const pool = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const matchId = data.readBigUInt64LE(offset); offset += 8;
  const table = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const tableIndex = data.readUInt8(offset); offset += 1;
  const selectedPlayers: PublicKey[] = [];
  for (let i = 0; i < 9; i++) {
    selectedPlayers.push(new PublicKey(data.subarray(offset, offset + 32)));
    offset += 32;
  }
  const selectedPages: number[] = [];
  for (let i = 0; i < 9; i++) {
    selectedPages.push(data.readUInt16LE(offset));
    offset += 2;
  }
  const selectedSlots: number[] = [];
  for (let i = 0; i < 9; i++) {
    selectedSlots.push(data.readUInt8(offset));
    offset += 1;
  }
  const approvedSigners: PublicKey[] = [];
  for (let i = 0; i < 9; i++) {
    approvedSigners.push(new PublicKey(data.subarray(offset, offset + 32)));
    offset += 32;
  }
  const miniOptIn: number[] = [];
  for (let i = 0; i < 9; i++) {
    miniOptIn.push(data.readUInt8(offset));
    offset += 1;
  }
  const seatIndices: number[] = [];
  for (let i = 0; i < 9; i++) {
    seatIndices.push(data.readUInt8(offset));
    offset += 1;
  }
  const seatedMask = data.readUInt16LE(offset); offset += 2;
  const selectedCount = data.readUInt8(offset); offset += 1;
  const seatedCount = data.readUInt8(offset); offset += 1;
  const candidateHash = Buffer.from(data.subarray(offset, offset + 32)); offset += 32;
  const revealSlot = data.readBigUInt64LE(offset); offset += 8;
  const initiator = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const prepareBondLamports = data.readBigUInt64LE(offset); offset += 8;
  const candidatePageStart = data.readUInt16LE(offset); offset += 2;
  const candidatePageCount = data.readUInt16LE(offset); offset += 2;
  const candidateCount = data.readUInt16LE(offset); offset += 2;
  const entropySlot = data.readBigUInt64LE(offset); offset += 8;
  const lastActionAt = data.readBigInt64LE(offset); offset += 8;
  const phase = data.readUInt8(offset);
  return {
    pool, matchId, table, tableIndex, selectedPlayers, selectedPages,
    selectedSlots, approvedSigners, miniOptIn, seatIndices, seatedMask,
    selectedCount, seatedCount, candidateHash, revealSlot, initiator,
    prepareBondLamports, candidatePageStart, candidatePageCount,
    candidateCount, entropySlot, lastActionAt, phase,
  };
}

// ===================================================================
// SNG Pool -- Instruction Builders
// ===================================================================

export function buildInitSngQueuePageInstruction(
  payer: PublicKey,
  gameType: number,
  tier: number,
  pageIndex: number,
  currentTailPage?: PublicKey,
): TransactionInstruction {
  const [poolPda] = getSngPoolPda(gameType, tier);
  const [vaultPda] = getSngPoolVaultPda(gameType, tier);
  const [queuePagePda] = getSngQueuePagePda(poolPda, pageIndex);
  const data = Buffer.alloc(10);
  DISCRIMINATORS.initSngQueuePage.copy(data, 0);
  data.writeUInt16LE(pageIndex, 8);

  const keys: AccountMeta[] = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: poolPda, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: queuePagePda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  if (currentTailPage) {
    keys.push({ pubkey: currentTailPage, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build join_sng_pool instruction.
 * Player deposits entry+fee plus any refundable Lucky escrow into pool vault and enters the queue.
 */
export function buildJoinSngPoolInstruction(
  player: PublicKey,
  gameType: number,
  tier: number,
  approvedSigner: PublicKey,
  miniOptIn = true,
  poolState?: Pick<SngPoolState, 'tailPageIndex'>,
): TransactionInstruction {
  const [playerAccountPda] = getPlayerPda(player);
  const [poolPda] = getSngPoolPda(gameType, tier);
  const [vaultPda] = getSngPoolVaultPda(gameType, tier);
  const [queuePagePda] = getSngQueuePagePda(poolPda, poolState?.tailPageIndex ?? 0);
  const [queueMarkerPda] = getSngQueueMarkerPda(poolPda, player);
  const [protocolGuardPda] = getProtocolGuardPda();

  const data = Buffer.alloc(8 + 32 + 1);
  DISCRIMINATORS.joinSngPool.copy(data, 0);
  approvedSigner.toBuffer().copy(data, 8);
  data.writeUInt8(miniOptIn ? 1 : 0, 40);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player,                    isSigner: true,  isWritable: true  },
      { pubkey: playerAccountPda,          isSigner: false, isWritable: false },
      { pubkey: poolPda,                   isSigner: false, isWritable: true  },
      { pubkey: vaultPda,                  isSigner: false, isWritable: true  },
      { pubkey: queuePagePda,              isSigner: false, isWritable: true  },
      { pubkey: queueMarkerPda,            isSigner: false, isWritable: true  },
      { pubkey: protocolGuardPda,           isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build leave_sng_pool instruction.
 * Player withdraws from queue and gets entry+fee plus any Lucky escrow back.
 */
export function buildLeaveSngPoolInstruction(
  player: PublicKey,
  gameType: number,
  tier: number,
  pageIndex = 0,
): TransactionInstruction {
  const [poolPda] = getSngPoolPda(gameType, tier);
  const [vaultPda] = getSngPoolVaultPda(gameType, tier);
  const [queueMarkerPda] = getSngQueueMarkerPda(poolPda, player);
  const [queuePagePda] = getSngQueuePagePda(poolPda, pageIndex);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player,                    isSigner: true,  isWritable: true  },
      { pubkey: poolPda,                   isSigner: false, isWritable: true  },
      { pubkey: vaultPda,                  isSigner: false, isWritable: true  },
      { pubkey: queueMarkerPda,            isSigner: false, isWritable: true  },
      { pubkey: queuePagePda,              isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.leaveSngPool),
  });
}

/**
 * Build prepare_sng_match instruction.
 * Permissionless -- locks the SNG candidate set before future-slot finalization.
 */
export function buildPrepareSngMatchInstruction(
  caller: PublicKey,
  gameType: number,
  tier: number,
  tablePda: PublicKey,
  pool: SngPoolState,
): TransactionInstruction {
  const [poolPda] = getSngPoolPda(gameType, tier);
  const [vaultPda] = getSngPoolVaultPda(gameType, tier);
  const [sngMatchPda] = getSngMatchPda(poolPda, pool.matchIdCounter);
  const data = Buffer.alloc(16);
  DISCRIMINATORS.prepareSngMatch.copy(data, 0);
  data.writeBigUInt64LE(pool.matchIdCounter, 8);

  const keys: AccountMeta[] = [
    { pubkey: caller,                    isSigner: true,  isWritable: true  },
    { pubkey: poolPda,                   isSigner: false, isWritable: true  },
    { pubkey: vaultPda,                  isSigner: false, isWritable: true  },
    { pubkey: sngMatchPda,               isSigner: false, isWritable: true  },
    { pubkey: tablePda,                  isSigner: false, isWritable: false },
    { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
  ];

  for (let i = 0; i < pool.maxPlayers; i++) {
    keys.push({ pubkey: getPermissionPda(getSeatCardsPda(tablePda, i)[0])[0], isSigner: false, isWritable: false });
  }

  const lastPage = Math.min(pool.tailPageIndex, pool.headPageIndex + MAX_MATCH_SCAN_PAGES - 1);
  for (let page = pool.headPageIndex; page <= lastPage; page++) {
    keys.push({ pubkey: getSngQueuePagePda(poolPda, page)[0], isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });
}

export function buildFinalizeSngMatchInstruction(
  caller: PublicKey,
  gameType: number,
  tier: number,
  sngMatch: SngMatchState,
): TransactionInstruction {
  const [poolPda] = getSngPoolPda(gameType, tier);
  const [vaultPda] = getSngPoolVaultPda(gameType, tier);
  const [sngMatchPda] = getSngMatchPda(poolPda, sngMatch.matchId);
  const SLOT_HASHES = new PublicKey('SysvarS1otHashes111111111111111111111111111');

  const keys: AccountMeta[] = [
    { pubkey: caller,                    isSigner: true,  isWritable: true  },
    { pubkey: poolPda,                   isSigner: false, isWritable: true  },
    { pubkey: vaultPda,                  isSigner: false, isWritable: true  },
    { pubkey: sngMatchPda,               isSigner: false, isWritable: true  },
    { pubkey: SLOT_HASHES,               isSigner: false, isWritable: false },
    { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
  ];
  for (let i = 0; i < sngMatch.candidatePageCount; i++) {
    keys.push({ pubkey: getSngQueuePagePda(poolPda, sngMatch.candidatePageStart + i)[0], isSigner: false, isWritable: true });
  }
  keys.push({ pubkey: getCrankActionL1Pda(sngMatch.table, caller)[0], isSigner: false, isWritable: true });
  keys.push({ pubkey: getOperatorRewardTotalL1Pda(sngMatch.table)[0], isSigner: false, isWritable: true });

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data: Buffer.from(DISCRIMINATORS.finalizeSngMatch),
  });
}

/**
 * Build seat_from_pool instruction.
 * Seats one matched player from pool onto the table.
 */
export function buildSeatFromPoolInstruction(
  caller: PublicKey,
  gameType: number,
  tier: number,
  tablePda: PublicKey,
  playerWallet: PublicKey,
  playerIndex: number,
  seatIndex: number,
  sngMatch: SngMatchState,
): TransactionInstruction {
  const [poolPda] = getSngPoolPda(gameType, tier);
  const [vaultPda] = getSngPoolVaultPda(gameType, tier);
  const [sngMatchPda] = getSngMatchPda(poolPda, sngMatch.matchId);
  const [queueMarkerPda] = getSngQueueMarkerPda(poolPda, playerWallet);
  const [queuePagePda] = getSngQueuePagePda(poolPda, sngMatch.selectedPages[playerIndex]);
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [playerAccountPda] = getPlayerPda(playerWallet);
  const [markerPda] = getPlayerTableMarkerPda(playerWallet, tablePda);
  const [tableVaultPda] = getVaultPda(tablePda);

  // Data: discriminator(8) + player_index(1) + seat_index(1)
  const data = Buffer.alloc(10);
  DISCRIMINATORS.seatFromPool.copy(data, 0);
  data.writeUInt8(playerIndex, 8);
  data.writeUInt8(seatIndex, 9);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: caller,                    isSigner: true,  isWritable: true  },
      { pubkey: poolPda,                   isSigner: false, isWritable: true  },
      { pubkey: vaultPda,                  isSigner: false, isWritable: true  },
      { pubkey: sngMatchPda,               isSigner: false, isWritable: true  },
      { pubkey: queueMarkerPda,            isSigner: false, isWritable: true  },
      { pubkey: queuePagePda,              isSigner: false, isWritable: true  },
      { pubkey: tablePda,                  isSigner: false, isWritable: true  },
      { pubkey: seatPda,                   isSigner: false, isWritable: true  },
      { pubkey: playerAccountPda,          isSigner: false, isWritable: true  },
      { pubkey: playerWallet,              isSigner: false, isWritable: false },
      { pubkey: markerPda,                 isSigner: false, isWritable: true  },
      { pubkey: tableVaultPda,             isSigner: false, isWritable: true  },
      { pubkey: getJackpotGlobalPda()[0],  isSigner: false, isWritable: true  },
      { pubkey: getJackpotBucketPda(gameType, tier)[0], isSigner: false, isWritable: true },
      { pubkey: getJackpotEntryPda(tablePda, seatIndex)[0], isSigner: false, isWritable: true },
      { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build cancel_sng_match instruction.
 * Permissionless after 15-minute timeout. Refunds unseated players.
 * Remaining accounts: one AccountInfo per unseated matched player (for refund).
 */
export function buildCancelSngMatchInstruction(
  caller: PublicKey,
  gameType: number,
  tier: number,
  sngMatch: SngMatchState,
): TransactionInstruction {
  const [poolPda] = getSngPoolPda(gameType, tier);
  const [sngMatchPda] = getSngMatchPda(poolPda, sngMatch.matchId);

  const keys: AccountMeta[] = [
    { pubkey: caller,                    isSigner: true,  isWritable: true  },
    { pubkey: poolPda,                   isSigner: false, isWritable: true  },
    { pubkey: getSngPoolVaultPda(gameType, tier)[0], isSigner: false, isWritable: true },
    { pubkey: sngMatchPda,               isSigner: false, isWritable: true  },
    { pubkey: sngMatch.table,            isSigner: false, isWritable: false },
    { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
  ];

  const pages = new Set<number>();
  if (sngMatch.phase === 1 && sngMatch.candidatePageCount > 0) {
    for (let i = 0; i < sngMatch.candidatePageCount; i++) {
      pages.add(sngMatch.candidatePageStart + i);
    }
  } else {
    for (let i = 0; i < sngMatch.selectedCount; i++) {
      pages.add(sngMatch.selectedPages[i]);
    }
  }
  for (const page of pages) {
    keys.push({ pubkey: getSngQueuePagePda(poolPda, page)[0], isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data: Buffer.from(DISCRIMINATORS.cancelSngMatch),
  });
}

/**
 * Batch-read all 21 SNG pool accounts in one RPC call.
 * Returns parsed pool states (null for uninitialized pools).
 */
// Free public RPCs (PublicNode) BLOCK getMultipleAccounts above ~10 accounts
// ("Request blocked: blocked parameter params.0.#") — not a rate limit, a hard
// WAF reject. So batch reads MUST be chunked to <=10 or they 403 on the free
// pool. A capable RPC (Helius) has no such limit, but chunking is harmless there.
export const MAX_GMA_ACCOUNTS = 10;

/** getMultipleAccountsInfo that chunks the request so it isn't WAF-blocked on the
 *  free pool (PublicNode rejects >10 accounts). Chunk size is adaptive: 10 on the
 *  free pool, 100 on a capable RPC (Helius/custom has no such cap) so we don't
 *  fan a big read into dozens of slow sequential calls. Preserves input order. */
export async function getMultipleAccountsInfoChunked(
  connection: Connection,
  pubkeys: PublicKey[],
): Promise<(AccountInfo<Buffer> | null)[]> {
  let chunkSize = 100;
  try {
    // Lazy import to avoid a hard dep cycle; falls back to the safe small chunk.
    const { shouldUsePool } = await import('./rpc-pool');
    if (shouldUsePool()) chunkSize = MAX_GMA_ACCOUNTS;
  } catch {
    chunkSize = MAX_GMA_ACCOUNTS;
  }
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < pubkeys.length; i += chunkSize) {
    const chunk = pubkeys.slice(i, i + chunkSize);
    const infos = await connection.getMultipleAccountsInfo(chunk);
    for (const info of infos) out.push(info as AccountInfo<Buffer> | null);
  }
  return out;
}

export async function fetchAllSngPools(
  connection: Connection,
): Promise<{ gameType: number; tier: number; pda: PublicKey; state: SngPoolState | null }[]> {
  const GAME_TYPES = [0, 1, 2];
  const TIERS = [0, 1, 2, 3, 4, 5, 6];

  const entries: { gameType: number; tier: number; pda: PublicKey }[] = [];
  for (const gt of GAME_TYPES) {
    for (const t of TIERS) {
      const [pda] = getSngPoolPda(gt, t);
      entries.push({ gameType: gt, tier: t, pda });
    }
  }

  // 21 pools — must be chunked (>10) or the free pool 403s the whole read.
  const accounts = await getMultipleAccountsInfoChunked(connection, entries.map(e => e.pda));

  return entries.map((entry, i) => ({
    ...entry,
    state: accounts[i] ? parseSngPool(Buffer.from(accounts[i]!.data)) : null,
  }));
}
