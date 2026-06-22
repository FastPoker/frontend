/**
 * User-friendly error message mapping for Solana/Anchor errors.
 * Converts raw blockchain errors into plain English for the UI.
 */

interface ErrorMapping {
  /** Regex or string to match against the raw error message */
  match: RegExp | string;
  /** User-friendly message to display */
  message: string;
  /** Optional severity for styling */
  severity?: 'error' | 'warning' | 'info';
}

const ERROR_MAPPINGS: ErrorMapping[] = [
  // ─── Wallet / User Actions ───
  {
    match: /user rejected|cancelled|user cancel|request rejected/i,
    message: 'Transaction cancelled.',
    severity: 'info',
  },
  {
    match: /wallet not connected|wallet disconnected/i,
    message: 'Please connect your wallet first.',
    severity: 'warning',
  },
  {
    match: /does not support signTransaction/i,
    message: 'Your wallet does not support this action. Please try a different wallet (e.g., Phantom).',
    severity: 'error',
  },

  // ─── Session Keys ───
  {
    match: /session expired|InvalidSessionKey|Reconnecting session/i,
    message: 'Your session expired. Extending automatically...',
    severity: 'warning',
  },
  {
    match: /Session extend failed/i,
    message: 'Session renewal failed. Please refresh the page and try again.',
    severity: 'error',
  },
  {
    match: /Claim this seat session|claim seat session/i,
    message: 'Claim this seat session on this device before acting.',
    severity: 'warning',
  },
  {
    // 6007 / 0x1777 — sit_out attempted mid-hand. It applies between hands.
    match: /HandInProgress|Custom\":6007|0x1777/i,
    message: 'A hand is in progress. Sit-out takes effect between hands.',
    severity: 'info',
  },
  {
    match: /ValidityTooLong|error 6000/i,
    message: 'Session creation failed (duration too long). Please try again.',
    severity: 'error',
  },

  // ─── Funds / Balance ───
  {
    match: /insufficient funds|insufficient lamports|0x1$|InsufficientFundsForRent/i,
    message: 'Insufficient funds. Please add more SOL to your wallet.',
    severity: 'error',
  },
  {
    match: /insufficient balance for transaction/i,
    message: 'Not enough SOL for transaction fees. You need a small amount of SOL for gas.',
    severity: 'error',
  },
  {
    // JSON-RPC -32002 = SendTransactionPreflightFailure. The real cause is
    // base64-encoded in the @solana/errors message ("npx @solana/errors decode
    // -- -32002 ...") so the plaintext "insufficient funds" patterns above
    // never match it. For the funds flows the dominant cause is not enough SOL
    // for the amount + fees; surface a clean, actionable message instead of the
    // raw decode blob.
    match: /-32002\b|SendTransactionPreflightFailure|@solana\/errors decode/i,
    message: 'Not enough SOL to cover this transaction (amount plus network fees). Add SOL and try again.',
    severity: 'error',
  },

  // ─── Transaction Errors ───
  {
    match: /blockhash not found|block height exceeded|blockhash.*expired/i,
    message: 'Transaction expired. Please try again.',
    severity: 'warning',
  },
  {
    match: /not confirmed after \d+s/i,
    message: 'Transaction is taking longer than expected. Please wait a moment and check your status.',
    severity: 'warning',
  },
  {
    match: /Transaction simulation failed/i,
    message: 'Transaction would fail. This usually means the game state changed. Please try again.',
    severity: 'error',
  },
  {
    match: /transaction too large|too many accounts/i,
    message: 'Transaction is too complex. Please try again with fewer operations.',
    severity: 'error',
  },
  {
    match: /already processed/i,
    message: 'This action was already processed. Refreshing...',
    severity: 'info',
  },

  // ─── Game Logic (Anchor custom errors) ───
  {
    match: /0x1796|Unauthorized.*WhitelistEntry/i,
    message: 'This is a private table. You are not on the whitelist.',
    severity: 'error',
  },
  {
    match: /SeatOccupied|0x1772/i,
    message: 'This seat is already taken. Please choose a different seat.',
    severity: 'warning',
  },
  {
    match: /TableFull|0x1773/i,
    message: 'This table is full. Please try another table.',
    severity: 'warning',
  },
  {
    match: /NotYourTurn|NotPlayersTurn|Custom\":6022|0x1786|0x1775/i,
    message: 'It\'s not your turn to act.',
    severity: 'warning',
  },
  {
    match: /InvalidBetAmount|Custom\":6023|0x1787|0x1776|BetTooSmall/i,
    message: 'Invalid bet amount. Please check the minimum and maximum allowed.',
    severity: 'warning',
  },
  {
    match: /InvalidActionForPhase|Custom\":6021|0x1785/i,
    message: 'That action is no longer available. The hand state changed.',
    severity: 'warning',
  },
  {
    match: /BetBelowMinimum|Custom\":6024|0x1788/i,
    message: 'Bet is below the minimum.',
    severity: 'warning',
  },
  {
    match: /CannotCheck|Custom\":6025|0x1789/i,
    message: 'You cannot check here. Call, raise, or fold.',
    severity: 'warning',
  },
  {
    match: /NothingToCall|Custom\":6026|0x178a/i,
    message: 'There is no bet to call.',
    severity: 'warning',
  },
  {
    match: /RaiseTooSmall|Custom\":6027|0x178b/i,
    message: 'Raise is too small for the current bet.',
    severity: 'warning',
  },
  {
    match: /ActionTimeout|Custom\":6028|0x178c/i,
    message: 'Action timed out. Refreshing the table state.',
    severity: 'warning',
  },
  {
    match: /AlreadySeated|PlayerTableMarker|already.*seat/i,
    message: 'You are already seated at this table.',
    severity: 'info',
  },
  {
    match: /GameInProgress|0x1774/i,
    message: 'A hand is in progress. Please wait for it to finish.',
    severity: 'info',
  },
  {
    match: /RebuyBelowMin|0x17cf/i,
    message: 'Rebuy amount is below the minimum required.',
    severity: 'warning',
  },
  {
    match: /not delegated to TEE|not delegated yet/i,
    message: 'This table is not ready yet. The creator must finish setup first.',
    severity: 'error',
  },

  // ─── TEE / Network ───
  {
    match: /Missing token query param|500 Internal Server Error/i,
    message: 'Connection to game server lost. Reconnecting...',
    severity: 'warning',
  },
  {
    match: /error sending request|ECONNREFUSED|ENOTFOUND|network error/i,
    message: 'Network error. Please check your connection and try again.',
    severity: 'error',
  },
  {
    match: /AccountOwnedByWrongProgram|3007/i,
    message: 'Account state conflict. Please retry — this usually resolves automatically.',
    severity: 'warning',
  },
  {
    match: /Stale (deposit )?proof/i,
    message: 'Cleaning up from a previous attempt. Please try sitting down again.',
    severity: 'warning',
  },

  // ─── SNG Pool ───
  {
    match: /PoolAlreadyQueued|already queued|6099/i,
    message: 'You are already in this pool queue.',
    severity: 'info',
  },
  {
    match: /PoolNotInQueue|not in queue/i,
    message: 'You are not in this pool queue.',
    severity: 'warning',
  },
  {
    match: /PoolPlayerInMatch|player in match/i,
    message: 'You have a match in progress. Please finish your current game first.',
    severity: 'warning',
  },
  {
    match: /Failed to create on-chain table/i,
    message: 'Table setup is in progress. You are in the queue -- please wait.',
    severity: 'info',
  },

  // ─── Anti-Ratholing ───
  {
    match: /Custom.:6101|RatholingBuyInTooLow/i,
    message: 'Anti-ratholing: you must buy in with at least the amount you left with. Increase your buy-in or wait for the 12-hour lock to expire.',
    severity: 'warning',
  },

  // ─── Deposit / Cashout ───
  {
    match: /Deposit simulation failed/i,
    message: '', // empty = pass through raw error for debugging
    severity: 'error',
  },
  {
    match: /Deposit TX failed/i,
    message: 'Deposit transaction failed on-chain. Please try again.',
    severity: 'error',
  },
  {
    match: /Seating failed/i,
    message: 'Could not seat you at the table. The seat may have been taken. Please try another.',
    severity: 'error',
  },
  {
    match: /NonceAlreadyProcessed|0x17d1/i,
    message: 'Cashout already processed. Your funds should be in your wallet.',
    severity: 'info',
  },
  {
    // Cash fund-stranding fix: claim_unclaimed_sol / claim_unclaimed /
    // reclaim_expired are disabled. Stranded balances are returned via manual
    // admin recovery, not self-claim. (Error 6175 / 0x181f.)
    match: /UnclaimedClaimDisabled|0x181f/i,
    message: 'This balance is being returned through manual recovery. No action needed on your part.',
    severity: 'info',
  },
];

/**
 * Convert a raw error message to a user-friendly string.
 * Returns the friendly message if matched, or a cleaned-up version of the original.
 */
export function friendlyError(rawError: unknown): { message: string; severity: 'error' | 'warning' | 'info' } {
  const raw = rawError instanceof Error ? rawError.message : String(rawError || 'Unknown error');

  // Try each mapping
  for (const mapping of ERROR_MAPPINGS) {
    const matches = typeof mapping.match === 'string'
      ? raw.includes(mapping.match)
      : mapping.match.test(raw);

    if (matches) {
      // Empty message = pass through raw error for debugging
      return { message: mapping.message || raw, severity: mapping.severity || 'error' };
    }
  }

  // Fallback: clean up the raw message
  const trimmed = raw.trim();

  // Detect serialized transaction data embedded in error messages (Phantom does this)
  if (trimmed.length > 200 && /^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    return { message: 'Transaction failed. Please try again.', severity: 'error' };
  }

  // Detect very long technical messages — truncate at first useful boundary
  if (trimmed.length > 120) {
    // Try to find a natural sentence boundary
    const short = trimmed.slice(0, 120);
    const lastPeriod = short.lastIndexOf('.');
    const lastColon = short.lastIndexOf(':');
    const cut = Math.max(lastPeriod, lastColon);
    const cleaned = cut > 40 ? short.slice(0, cut + 1) : short + '...';
    return { message: cleaned, severity: 'error' };
  }

  return { message: trimmed, severity: 'error' };
}

/**
 * Shorthand: just get the message string.
 */
export function getErrorMessage(rawError: unknown): string {
  return friendlyError(rawError).message;
}
