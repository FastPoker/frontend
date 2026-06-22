import { createHash } from 'crypto';

export function ixDisc(name: string): Buffer {
  return Buffer.from(
    createHash('sha256').update(`global:${name}`).digest().slice(0, 8),
  );
}

export function accountDisc(name: string): Buffer {
  return Buffer.from(
    createHash('sha256').update(`account:${name}`).digest().slice(0, 8),
  );
}

export const ACCOUNT_DISC = {
  Table: accountDisc('Table'),
  PlayerSeat: accountDisc('PlayerSeat'),
} as const;

export const IX_DISC = {
  updateApprovedSigner: ixDisc('update_approved_signer'),
  adminSetAuctionDuration: ixDisc('admin_set_auction_duration'),
  adminCloseAuctionConfig: ixDisc('admin_close_auction_config'),
  adminCloseAuctionState: ixDisc('admin_close_auction_state'),
  adminCloseGlobalBid: ixDisc('admin_close_global_bid'),
  adminCloseListedToken: ixDisc('admin_close_listed_token'),
  adminCloseGlobalContribution: ixDisc('admin_close_global_contribution'),
  adminUndelegateEr: ixDisc('admin_undelegate_er'),
  adminCloseAccounts: ixDisc('admin_close_accounts'),
  purchaseDealerLicense: ixDisc('purchase_dealer_license'),

  // readyUp removed — SNG pool seats players directly; no ready-up gate.
  kickUnready: ixDisc('kick_unready'),
  handleBlindTimeout: ixDisc('handle_blind_timeout'),

  initCrankTallyEr: ixDisc('init_crank_tally_er'),
  delegateCrankTally: ixDisc('delegate_crank_tally'),
  resizeCrankTally: ixDisc('resize_crank_tally'),

  initSngPool: ixDisc('init_sng_pool'),
  initSngQueuePage: ixDisc('init_sng_queue_page'),
  initProtocolGuard: ixDisc('init_protocol_guard'),
  setProtocolGuard: ixDisc('set_protocol_guard'),
  compactSngQueuePages: ixDisc('compact_sng_queue_pages'),
  closeEmptySngQueuePage: ixDisc('close_empty_sng_queue_page'),
  closeCompletedSngMatch: ixDisc('close_completed_sng_match'),
  joinSngPool: ixDisc('join_sng_pool'),
  leaveSngPool: ixDisc('leave_sng_pool'),
  initJackpotGlobal: ixDisc('init_jackpot_global'),
  initJackpotBucket: ixDisc('init_jackpot_bucket'),
  settleSngJackpots: ixDisc('settle_sng_jackpots'),
  prepareSngMatch: ixDisc('prepare_sng_match'),
  finalizeSngMatch: ixDisc('finalize_sng_match'),
  seatFromPool: ixDisc('seat_from_pool'),
  cancelSngMatch: ixDisc('cancel_sng_match'),

  delegateTable: ixDisc('delegate_table'),
  delegateSeat: ixDisc('delegate_seat'),
  delegateSeatCards: ixDisc('delegate_seat_cards'),
  delegateDepositProof: ixDisc('delegate_deposit_proof'),
  delegateDeckState: ixDisc('delegate_deck_state'),
  delegateSlimBuffer: ixDisc('delegate_slim_buffer'),
  delegatePermission: ixDisc('delegate_permission'),

  updateSeatPermissionTee: ixDisc('update_seat_permission_tee'),

  register: ixDisc('register'),
  createUserTable: ixDisc('create_user_table'),
  createTable: ixDisc('create_table'),
  leaveTable: ixDisc('leave_table'),
  depositForJoin: ixDisc('deposit_for_join'),
  depositTopup: ixDisc('deposit_topup'),
  applyTopup: ixDisc('apply_topup'),
  initTipJar: ixDisc('init_tip_jar'),
  depositTip: ixDisc('deposit_tip'),
  initHandReportBuffer: ixDisc('init_hand_report_buffer'),
  initHandReportFlushState: ixDisc('init_hand_report_flush_state'),
  placeBid: ixDisc('place_bid'),

  commitState: ixDisc('commit_state'),
  commitAndUndelegateTable: ixDisc('commit_and_undelegate_table'),
  processCashoutV2: ixDisc('process_cashout_v2'),
  clearLeavingSeat: ixDisc('clear_leaving_seat'),
  clearStaleJoinMarker: ixDisc('clear_stale_join_marker'),
  cleanupDepositProof: ixDisc('cleanup_deposit_proof'),
  cleanupTablePermissions: ixDisc('cleanup_table_permissions'),
  cleanupTableAccounts: ixDisc('cleanup_table_accounts'),
  cleanupSeatCards: ixDisc('cleanup_seat_cards'),
  crankRemovePlayer: ixDisc('crank_remove_player'),
  closeTable: ixDisc('close_table'),
  distributePrizes: ixDisc('distribute_prizes'),
  refundFailedDeposit: ixDisc('refund_failed_deposit'),
  resetSeatPermission: ixDisc('reset_seat_permission'),
  resolveAuction: ixDisc('resolve_auction'),
  claimUnclaimedSol: ixDisc('claim_unclaimed_sol'),
  claimSolWinnings: ixDisc('claim_sol_winnings'),

  startGame: ixDisc('start_game'),
  teeDeal: ixDisc('tee_deal'),
  contributeGlobalEntropy: ixDisc('contribute_global_entropy'),
  playerAction: ixDisc('player_action'),
  settleHand: ixDisc('settle_hand'),
  scheduleNextHand: ixDisc('schedule_next_hand'),
  scheduleSettle: ixDisc('schedule_settle'),

  settleTableRewards: ixDisc('settle_table_rewards'),
  resizeVault: ixDisc('resize_vault'),
  initCrankRewardState: ixDisc('init_crank_reward_state'),
  initOperatorClaim: ixDisc('init_operator_claim'),
  initOperatorRewardTotal: ixDisc('init_operator_reward_total'),
  updateOpClaimWeight: ixDisc('update_op_claim_weight'),
  updateAccRewardPerWeight: ixDisc('update_acc_reward_per_weight'),
  claimOperatorRewards: ixDisc('claim_operator_rewards'),
  claimOperatorTokenRewards: ixDisc('claim_operator_token_rewards'),
  sweepColdOperatorActions: ixDisc('sweep_cold_operator_actions'),
} as const;
