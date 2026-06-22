import type { Connection, Transaction, SendOptions } from '@solana/web3.js';
import { IS_MAINNET } from './constants';

type WalletSenders = {
  // wallet-adapter sendTransaction (uses the wallet's signAndSendTransaction for Phantom).
  sendTransaction?: (tx: Transaction, conn: Connection, opts?: SendOptions) => Promise<string>;
  signTransaction?: <T extends Transaction>(tx: T) => Promise<T>;
};

/**
 * Submit a wallet-signed L1 transaction.
 *
 * - **Mainnet:** `wallet.sendTransaction` (= the wallet's `signAndSendTransaction`),
 *   so Phantom and Blowfish can inject their Lighthouse guard instructions. This is
 *   what Phantom verification requires; without it the dApp shows a malicious warning.
 * - **Devnet:** manual `signTransaction` + `sendRawTransaction`, because Phantom's
 *   `signAndSendTransaction` submits via its own (mainnet) RPC and errors on devnet txs.
 *
 * Only for single-signer wallet txs sent to L1. Do NOT use for ER/rollup txs (those
 * must go to the TEE connection) or co-signer txs (those need `signers` in the adapter).
 */
export async function sendWalletTx(
  tx: Transaction,
  conn: Connection,
  wallet: WalletSenders,
  opts: SendOptions = { skipPreflight: false },
): Promise<string> {
  if (IS_MAINNET && wallet.sendTransaction) {
    return wallet.sendTransaction(tx, conn, opts);
  }
  if (wallet.signTransaction) {
    const signed = await wallet.signTransaction(tx);
    return conn.sendRawTransaction(signed.serialize(), opts);
  }
  if (wallet.sendTransaction) return wallet.sendTransaction(tx, conn, opts);
  throw new Error('Wallet cannot sign transactions');
}
