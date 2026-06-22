// ────────────────────────────────────────────────────────────────────────
// Refine / claim helpers for raw (unrefined) $FP.
//
// Shared by the SNG finish overlay (and reusable by /profile). Mirrors the
// on-chain Steel `claim_all` instruction (disc 6) in
// contracts/program/src/claim_all.rs: refines raw -> liquid $FP, taking a 10%
// burn that redistributes to remaining raw holders. "Claim + stake" composes
// claim_all with the existing burn-stake instruction (disc 1) — no custom
// instruction, no contract change.
// ────────────────────────────────────────────────────────────────────────
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { STEEL_PROGRAM_ID, POKER_MINT, POOL_PDA } from '@/lib/constants';
import { buildBurnStakeInstruction } from '@/lib/stake';

// Steel `claim_all` discriminator (see funds-confirmation.ts: [6, 'Claim unrefined FP']).
const CLAIM_ALL_DISCRIMINATOR = 6;

/** Derive the Steel Unrefined PDA for a wallet. */
export function getUnrefinedPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('unrefined'), wallet.toBuffer()],
    STEEL_PROGRAM_ID,
  )[0];
}

/** Read a wallet's raw (unrefined) $FP balance in 6-dec micro-units. 0 if absent. */
export async function readUnrefinedMicros(connection: Connection, wallet: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(getUnrefinedPda(wallet));
  if (!info || info.data.length < 48) return 0n;
  return Buffer.from(info.data).readBigUInt64LE(40);
}

function buildClaimAllInstruction(wallet: PublicKey, tokenAccount: PublicKey): TransactionInstruction {
  const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from('pool')], STEEL_PROGRAM_ID);
  const data = Buffer.alloc(1);
  data.writeUInt8(CLAIM_ALL_DISCRIMINATOR, 0);
  // Account order mirrors claim_all.rs:7.
  return new TransactionInstruction({
    programId: STEEL_PROGRAM_ID,
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: getUnrefinedPda(wallet), isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: POKER_MINT, isSigner: false, isWritable: true },
      { pubkey: mintAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function addAtaGuard(
  connection: Connection,
  wallet: PublicKey,
  tokenAccount: PublicKey,
  tx: Transaction,
): Promise<void> {
  try {
    await getAccount(connection, tokenAccount);
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(wallet, tokenAccount, wallet, POKER_MINT));
  }
}

export interface RefineClaimDeps {
  connection: Connection;
  wallet: PublicKey;
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>;
}

/** Refine all raw $FP -> liquid $FP in one confirmed TX. Returns the signature. */
export async function claimRaw({ connection, wallet, sendTransaction }: RefineClaimDeps): Promise<string> {
  const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, wallet);
  const tx = new Transaction();
  await addAtaGuard(connection, wallet, tokenAccount, tx);
  tx.add(buildClaimAllInstruction(wallet, tokenAccount));
  tx.feePayer = wallet;
  tx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
  const sig = await sendTransaction(tx, connection);
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

/**
 * Claim + stake. Two confirmed steps so the staked amount equals exactly what
 * the refine minted (no decimal/rounding guesswork): (1) claim_all refines raw
 * -> liquid $FP, (2) burn the balance delta into the stake position. Returns
 * the stake signature (or the claim signature if nothing was minted to stake).
 */
export async function claimAndStake({ connection, wallet, sendTransaction }: RefineClaimDeps): Promise<string> {
  const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, wallet);
  let before = 0n;
  try { before = (await getAccount(connection, tokenAccount, 'confirmed')).amount; } catch { before = 0n; }

  const claimSig = await claimRaw({ connection, wallet, sendTransaction });

  let after = before;
  try { after = (await getAccount(connection, tokenAccount, 'confirmed')).amount; } catch { after = before; }
  const minted = after > before ? after - before : 0n;
  if (minted === 0n) return claimSig;

  const burnIx = await buildBurnStakeInstruction(wallet, minted);
  const stakeTx = new Transaction().add(burnIx);
  stakeTx.feePayer = wallet;
  stakeTx.recentBlockhash = (await getLatestBlockhashClient(connection)).blockhash;
  const stakeSig = await sendTransaction(stakeTx, connection);
  await connection.confirmTransaction(stakeSig, 'confirmed');
  return stakeSig;
}
