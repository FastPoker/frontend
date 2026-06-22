import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Typed error thrown when a wallet's lamport balance is below what an
 * upcoming transaction will require (rent + tx fee + transferred amount).
 *
 * Catch by `code === 'INSUFFICIENT_FUNDS'` and route to
 * `useInsufficientFundsModal().open({ ... })`.
 */
export class InsufficientFundsError extends Error {
  code = 'INSUFFICIENT_FUNDS' as const;
  required: number;
  have: number;
  address: string;
  reason?: string;
  /** Optional modal title override. */
  title?: string;
  /** Optional table-currency ticker (e.g. "POKER"). When set, the modal
   *  clarifies that the shortfall is SOL for fees, not the table token. */
  tableTokenSymbol?: string;

  constructor(opts: { required: number; have: number; address: string; reason?: string; title?: string; tableTokenSymbol?: string }) {
    super(
      `Wallet needs at least ${(opts.required / 1e9).toFixed(3)} SOL${
        opts.reason ? ` — ${opts.reason}` : ''
      }. Currently has ${(opts.have / 1e9).toFixed(6)} SOL.`,
    );
    this.required = opts.required;
    this.have = opts.have;
    this.address = opts.address;
    this.reason = opts.reason;
    this.title = opts.title;
    this.tableTokenSymbol = opts.tableTokenSymbol;
  }
}

export interface AssertFundsArgs {
  connection: Connection;
  payer: PublicKey;
  /** Minimum lamports the payer must hold before this tx is attempted. */
  requiredLamports: number;
  /** Optional human reason surfaced in the modal. */
  reason?: string;
  /** Optional modal title override (e.g. "SOL needed for fees"). */
  title?: string;
  /** Optional SPL table ticker — modal will add an explanatory note that
   *  the SOL shortfall is for fees, not the table currency. */
  tableTokenSymbol?: string;
}

/**
 * Throws InsufficientFundsError if `payer.balance < requiredLamports`.
 * Otherwise resolves silently. Always uses 'confirmed' commitment so the
 * read is consistent with what the upcoming send-and-confirm will see.
 */
export async function assertFunds(args: AssertFundsArgs): Promise<void> {
  const { connection, payer, requiredLamports, reason, title, tableTokenSymbol } = args;
  const balance = await connection.getBalance(payer, 'confirmed');
  if (balance < requiredLamports) {
    throw new InsufficientFundsError({
      required: requiredLamports,
      have: balance,
      address: payer.toBase58(),
      reason,
      title,
      tableTokenSymbol,
    });
  }
}

/**
 * Convenience: rounded-up minimum lamports for typical action types so each
 * call site does not re-derive constants. Tune per program as needed.
 */
export const FUNDS_HINTS = {
  /** Player + unrefined PDA rent + tx fee, with safety margin. */
  REGISTER_LAMPORTS: 5_000_000, // 0.005 SOL
  /** Tx fee for a single signed action (claim, ack, etc.). */
  TX_FEE_LAMPORTS: 1_000_000, // 0.001 SOL
  /** Sit at a table — buy-in + seat/deposit-proof/delegation rent + tx fees.
   *  Caller adds buy-in. Reserves headroom so a max buy-in never leaves the
   *  wallet unable to cover rent + fees. */
  SIT_OVERHEAD_LAMPORTS: 15_000_000, // 0.015 SOL on top of buy-in
} as const;
