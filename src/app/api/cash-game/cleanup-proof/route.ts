import { NextRequest, NextResponse } from 'next/server';
import { Connection, Keypair, Transaction, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import { getL1Rpc } from '@/lib/rpc-config';
import {
  buildCleanupDepositProofInstruction,
  buildRefundFailedDepositInstruction,
  getDepositProofPda,
  getTablePda,
  getSeatPda,
  OnChainGameType,
  OnChainPhase,
  parseTableState,
} from '@/lib/onchain-game';
import { getTeeConnection } from '@/lib/tee-auth-server';
import { requireTrustedOrigin, requireWalletSignature } from '@/lib/api-auth';
import { requireRateLimit } from '@/lib/api-rate-limit';
import { loadRequiredServerKeypair } from '@/lib/server-runtime-keys';
import { ANCHOR_PROGRAM_ID } from '@/lib/constants';

const ZERO_PUBKEY = PublicKey.default.toBase58();

/**
 * POST /api/cash-game/cleanup-proof
 * Permissionless backend cleanup of a stale (delegated) DepositProof on TEE,
 * PLUS refund of the original deposit on L1 to clear receipt/proof for seat reuse.
 *
 * Why backend? Wallet adapters (Phantom etc.) route sendTransaction through their
 * own RPC, ignoring the Connection parameter. This means cleanup_deposit_proof
 * (which CPIs to Magic program on TEE) gets sent to L1 and fails with
 * "Unsupported program id". Using a server-side keypair + direct TEE RPC avoids this.
 *
 * Flow:
 * 1. cleanup_deposit_proof on TEE → undelegates proof back to L1
 * 2. Wait for L1 to reflect undelegation
 * 3. refund_failed_deposit on L1 → refunds SOL to original depositor, clears receipt
 *
 * Body: { tablePda: string, seatIndex: number }
 */

let crankKeypair: Keypair | null = null;
function getCrankKeypair(): Keypair {
  if (crankKeypair) return crankKeypair;
  crankKeypair = loadRequiredServerKeypair('AUTHORITY_KEYPAIR_PATH');
  return crankKeypair;
}

type ProofView = {
  depositor: PublicKey;
  buyIn: bigint;
  reserve: bigint;
  consumed: boolean;
  empty: boolean;
};

function readProofView(data: Buffer): ProofView | null {
  if (data.length < 90) return null;
  const depositor = new PublicKey(data.subarray(41, 73));
  const buyIn = data.readBigUInt64LE(73);
  const reserve = data.readBigUInt64LE(81);
  const consumed = data[89] === 1;
  const empty = depositor.toBase58() === ZERO_PUBKEY && buyIn === BigInt(0) && reserve === BigInt(0);
  return { depositor, buyIn, reserve, consumed, empty };
}

async function assertCreatorCloseCanRefundProof(
  l1: Connection,
  tee: Connection,
  tablePubkey: PublicKey,
  wallet: string,
): Promise<void> {
  const tableInfoL1 = await l1.getAccountInfo(tablePubkey);
  const tableInfo = tableInfoL1?.owner.equals(DELEGATION_PROGRAM_ID)
    ? await tee.getAccountInfo(tablePubkey).catch(() => null)
    : tableInfoL1;
  const tableState = tableInfo?.data ? parseTableState(Buffer.from(tableInfo.data)) : null;
  if (!tableState) {
    throw new Error('Unable to verify table state for creator-close refund.');
  }
  if (!tableState.creator?.equals(new PublicKey(wallet))) {
    throw new Error('Only the table creator can refund stale deposits during close.');
  }
  if (tableState.gameType !== OnChainGameType.CashGame) {
    throw new Error('Creator-close deposit cleanup is only for cash tables.');
  }
  if (tableState.currentPlayers !== 0 || tableState.seatsOccupied !== 0) {
    throw new Error('Cannot refund close-blocking deposits while seats are occupied.');
  }
  if (tableState.phase !== OnChainPhase.Waiting && tableState.phase !== OnChainPhase.Complete) {
    throw new Error('Cannot refund close-blocking deposits while the table is in a hand.');
  }
}

export async function POST(request: NextRequest) {
  try {
    const originError = requireTrustedOrigin(request);
    if (originError) return originError;
    const body = await request.json();
    const { tablePda, seatIndex, wallet } = body;
    const creatorClose = body.creatorClose === true;

    if (!tablePda || seatIndex === undefined || !wallet) {
      return NextResponse.json({ error: 'tablePda, seatIndex, and wallet required' }, { status: 400 });
    }
    const authError = requireWalletSignature(body, 'cash-cleanup-proof');
    if (authError) return authError;
    const rateError = requireRateLimit(request, 'cash-cleanup-proof', `${wallet}:${tablePda}:${seatIndex}`, 6, 60_000);
    if (rateError) return rateError;

    const tee = await getTeeConnection();
    const l1 = new Connection(getL1Rpc(), 'confirmed');
    const payer = getCrankKeypair();
    const tablePubkey = new PublicKey(tablePda);
    const [seatPda] = getSeatPda(tablePubkey, seatIndex);
    const [depositProofPda] = getDepositProofPda(tablePubkey, seatIndex);

    console.log(`=== Cleanup DepositProof: seat ${seatIndex} of ${tablePda.slice(0, 12)} ===`);
    const proofPreInfo = await l1.getAccountInfo(depositProofPda);
    const proofAuthInfo = proofPreInfo?.owner.equals(DELEGATION_PROGRAM_ID)
      ? await tee.getAccountInfo(depositProofPda).catch(() => null)
      : proofPreInfo;
    if (proofPreInfo?.owner.equals(DELEGATION_PROGRAM_ID) && !proofAuthInfo) {
      return NextResponse.json({
        success: false,
        reserved: true,
        error: 'Seat has a pending join that is still on TEE. Try again in a moment.',
      }, { status: 409 });
    }
    const initialProof = proofAuthInfo?.data ? readProofView(Buffer.from(proofAuthInfo.data)) : null;
    if (!proofPreInfo || !initialProof) {
      return NextResponse.json({ success: true, refunded: false, reason: 'proof_not_found_or_unreadable' });
    }
    if (!proofPreInfo.owner.equals(DELEGATION_PROGRAM_ID) && (initialProof.consumed || initialProof.empty)) {
      return NextResponse.json({ success: true, refunded: false, reason: 'proof_already_clean' });
    }

    if (initialProof && !initialProof.consumed && !initialProof.empty) {
      const proofWallet = initialProof.depositor.toBase58();
      if (proofWallet !== wallet && !creatorClose) {
        return NextResponse.json({
          success: false,
          reserved: true,
          error: 'Seat is reserved by another player who is still joining.',
        }, { status: 409 });
      }
      if (proofWallet !== wallet && creatorClose) {
        try {
          await assertCreatorCloseCanRefundProof(l1, tee, tablePubkey, wallet);
        } catch (e: any) {
          return NextResponse.json({ success: false, error: e.message }, { status: 409 });
        }
      }
      if (proofWallet === wallet && !creatorClose) {
        const seatInfo = proofPreInfo?.owner.equals(DELEGATION_PROGRAM_ID)
          ? await tee.getAccountInfo(seatPda).catch(() => null)
          : await l1.getAccountInfo(seatPda).catch(() => null);
        const seatStatus = seatInfo?.data && seatInfo.data.length > 227
          ? seatInfo.data[227]
          : undefined;
        if (seatStatus !== 0) {
          return NextResponse.json({
            success: false,
            reserved: true,
            error: 'A previous top-up is still being processed. Wait a few seconds and retry.',
          }, { status: 409 });
        }
      }
    }

    if (!proofPreInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
      return refundL1Proof(l1, tee, payer, tablePubkey, seatIndex, depositProofPda, undefined);
    }

    // ─── Step 1: cleanup_deposit_proof on TEE (undelegate proof back to L1) ───
    const cleanupIx = buildCleanupDepositProofInstruction(
      payer.publicKey,
      tablePubkey,
      seatIndex,
      seatPda,
    );

    const tx = new Transaction().add(cleanupIx);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await tee.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(payer);

    const sig = await tee.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    console.log(`  Sent cleanup: ${sig.slice(0, 20)}`);

    // Poll for confirmation
    let confirmed = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const statuses = await tee.getSignatureStatuses([sig]);
      const s = statuses?.value?.[0];
      if (s?.err) {
        console.error(`  Cleanup TX error:`, JSON.stringify(s.err));
        return NextResponse.json({ error: `cleanup failed: ${JSON.stringify(s.err)}` }, { status: 500 });
      }
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
        confirmed = true;
        console.log(`  Cleanup confirmed: ${sig.slice(0, 20)}`);
        break;
      }
    }

    if (!confirmed) {
      return NextResponse.json({ error: 'cleanup not confirmed on TEE after 15s' }, { status: 500 });
    }

    // ─── Step 2: Wait for proof to return to L1 ───
    console.log('  Waiting for proof to return to L1...');
    let proofOnL1 = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const proofInfo = await l1.getAccountInfo(depositProofPda);
      if (proofInfo && proofInfo.owner.equals(ANCHOR_PROGRAM_ID)) {
        proofOnL1 = true;
        console.log(`  Proof back on L1 (attempt ${i})`);
        break;
      }
    }

    if (!proofOnL1) {
      // Cleanup succeeded but proof not yet on L1 — caller should retry
      return NextResponse.json({
        success: true,
        signature: sig,
        refunded: false,
        note: 'Proof undelegated but not yet on L1 — retry sit-down to trigger refund',
      });
    }

    // ─── Step 3: refund_failed_deposit on L1 (clears receipt + returns SOL) ───
    // Read proof to get original depositor
    return refundL1Proof(l1, tee, payer, tablePubkey, seatIndex, depositProofPda, sig);
  } catch (e: any) {
    console.error('Cleanup proof failed:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function refundL1Proof(
  l1: Connection,
  tee: Connection,
  payer: Keypair,
  tablePubkey: PublicKey,
  seatIndex: number,
  depositProofPda: PublicKey,
  cleanupSignature?: string,
) {
  const proofInfo = await l1.getAccountInfo(depositProofPda);
  if (!proofInfo || proofInfo.data.length < 73) {
    return NextResponse.json({ success: true, signature: cleanupSignature, refunded: false, note: 'Proof data too short' });
  }
  const proofData = Buffer.from(proofInfo.data);
  const proof = readProofView(proofData);
  if (!proof) {
    return NextResponse.json({ success: true, signature: cleanupSignature, refunded: false, note: 'Proof data too short' });
  }

  // Only refund if proof is unconsumed and has a valid depositor
  if (proof.consumed || proof.empty) {
    console.log(`  Proof already consumed or cleared — no refund needed`);
    return NextResponse.json({ success: true, signature: cleanupSignature, refunded: false });
  }

  const depositor = proof.depositor;
  console.log(`  Refunding deposit to ${depositor.toBase58().slice(0, 12)}...`);
  try {
    const tableSeedInfoL1 = await l1.getAccountInfo(tablePubkey).catch(() => null);
    const tableSeedInfo = tableSeedInfoL1?.owner.equals(DELEGATION_PROGRAM_ID)
      ? await tee.getAccountInfo(tablePubkey).catch(() => null)
      : tableSeedInfoL1;
    const tableState = tableSeedInfo?.data
      ? parseTableState(Buffer.from(tableSeedInfo.data))
      : null;
    if (!tableState) {
      return NextResponse.json({
        success: true,
        signature: cleanupSignature,
        refunded: false,
        refundError: 'Unable to read table seeds for refund; retry after table sync.',
      });
    }
    const [expectedTable, tableBump] = getTablePda(tableState.tableId);
    if (!expectedTable.equals(tablePubkey)) {
      return NextResponse.json({
        success: true,
        signature: cleanupSignature,
        refunded: false,
        refundError: 'Table seed validation failed for refund.',
      });
    }
    const refundIx = buildRefundFailedDepositInstruction(
      payer.publicKey,
      tablePubkey,
      seatIndex,
      depositor,
      tableState.tableId,
      tableBump,
    );

    const refundTx = new Transaction().add(refundIx);
    const refundSig = await sendAndConfirmTransaction(l1, refundTx, [payer], { commitment: 'confirmed' });
    console.log(`  Refund confirmed: ${refundSig.slice(0, 20)}`);

    return NextResponse.json({ success: true, signature: cleanupSignature, refunded: true, refundSignature: refundSig });
  } catch (refundErr: any) {
    // Refund may fail (e.g. 3-min timelock not met) — cleanup still succeeded
    console.warn(`  Refund failed (non-fatal): ${refundErr.message?.slice(0, 80)}`);
    return NextResponse.json({
      success: true,
      signature: cleanupSignature,
      refunded: false,
      refundError: refundErr.message?.slice(0, 120),
    });
  }
}
