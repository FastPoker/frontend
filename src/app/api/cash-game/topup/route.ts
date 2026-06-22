import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlockhashViaIndexer } from '@/lib/indexer-client';
import { Connection, Keypair, Transaction, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { DELEGATION_PROGRAM_ID, delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationRecordPdaFromDelegatedAccount, delegationMetadataPdaFromDelegatedAccount } from '@magicblock-labs/ephemeral-rollups-sdk';
import { buildApplyTopupInstruction, buildDelegateDepositProofInstruction, getDepositProofPda } from '@/lib/onchain-game';
import { ANCHOR_PROGRAM_ID } from '@/lib/constants';
import { getTeeConnection } from '@/lib/tee-auth-server';
import { getL1Rpc } from '@/lib/rpc-config';
import { requireTrustedOrigin, requireWalletSignature } from '@/lib/api-auth';
import { requireRateLimit } from '@/lib/api-rate-limit';
import { loadRequiredServerKeypair } from '@/lib/server-runtime-keys';

let authorityKeypair: Keypair | null = null;
function getAuthority(): Keypair {
  if (authorityKeypair) return authorityKeypair;
  authorityKeypair = loadRequiredServerKeypair('AUTHORITY_KEYPAIR_PATH');
  return authorityKeypair;
}

/**
 * POST /api/cash-game/topup
 * Step 2 of top-up flow: delegate proof to TEE + apply_topup on TEE.
 *
 * Precondition: Player already called deposit_topup on L1 (atomically deposited
 * SOL/SPL to vault and updated DepositProof). Frontend may have bundled
 * delegate_deposit_proof in the same L1 TX.
 *
 * PERMISSIONLESS: apply_topup reads amounts from the on-chain DepositProof.
 * The payer (authority) just relays — cannot inflate or forge amounts.
 *
 * Body: { tablePda: string, seatIndex: number }
 */
export async function POST(request: NextRequest) {
  try {
    const originError = requireTrustedOrigin(request);
    if (originError) return originError;
    const body = await request.json();
    const { tablePda, seatIndex, wallet } = body;

    if (!tablePda || seatIndex === undefined || !wallet) {
      return NextResponse.json({ error: 'tablePda, seatIndex, and wallet required' }, { status: 400 });
    }
    const authError = requireWalletSignature(body, 'cash-topup');
    if (authError) return authError;
    const rateError = requireRateLimit(request, 'cash-topup', `${wallet}:${tablePda}:${seatIndex}`, 8, 60_000);
    if (rateError) return rateError;

    const l1 = new Connection(getL1Rpc(), 'confirmed');
    const er = await getTeeConnection();
    const authority = getAuthority();
    const tablePubkey = new PublicKey(tablePda);
    const [depositProofPda] = getDepositProofPda(tablePubkey, seatIndex);

    console.log(`=== Top-Up: seat ${seatIndex} of ${tablePda.slice(0, 12)} ===`);

    // Step 1: Ensure DepositProof is delegated to TEE
    const proofInfo = await l1.getAccountInfo(depositProofPda);
    if (!proofInfo) {
      return NextResponse.json({ error: 'DepositProof not found — deposit_topup must be called first' }, { status: 400 });
    }

    if (proofInfo.data.length >= 73) {
      const proofWallet = new PublicKey(proofInfo.data.subarray(41, 73)).toBase58();
      if (proofWallet !== wallet) {
        return NextResponse.json({ error: 'Wallet does not match DepositProof depositor' }, { status: 403 });
      }
    }

    const proofRecord = delegationRecordPdaFromDelegatedAccount(depositProofPda);
    const proofRecordInfo = await l1.getAccountInfo(proofRecord);
    const alreadyDelegated = proofInfo.owner.equals(DELEGATION_PROGRAM_ID) || !!proofRecordInfo;

    if (!alreadyDelegated) {
      // Delegate DepositProof to ER
      const delegBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(depositProofPda, ANCHOR_PROGRAM_ID);
      const delegRec = delegationRecordPdaFromDelegatedAccount(depositProofPda);
      const delegMeta = delegationMetadataPdaFromDelegatedAccount(depositProofPda);

      const delegIx = buildDelegateDepositProofInstruction(
        authority.publicKey,
        tablePubkey,
        seatIndex,
        delegBuf,
        delegRec,
        delegMeta,
        DELEGATION_PROGRAM_ID,
      );

      const delegTx = new Transaction().add(delegIx);
      delegTx.feePayer = authority.publicKey;
      delegTx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
      const delegSig = await sendAndConfirmTransaction(l1, delegTx, [authority], {
        commitment: 'confirmed',
      });
      console.log(`  DepositProof delegated to ER: ${delegSig.slice(0, 20)}`);
    } else {
      console.log(`  DepositProof already delegated — skipping`);
    }

    // Wait for delegation to propagate to TEE
    await new Promise(r => setTimeout(r, 3000));

    // Step 2: Call apply_topup on TEE (permissionless — reads proof for amounts)
    const applyIx = buildApplyTopupInstruction(
      authority.publicKey,
      tablePubkey,
      seatIndex,
    );

    const applyTx = new Transaction().add(applyIx);
    applyTx.feePayer = authority.publicKey;
    applyTx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    applyTx.sign(authority);
    const applySig = await er.sendRawTransaction(applyTx.serialize(), {
      skipPreflight: true,
    });
    console.log(`  Sent apply_topup: ${applySig.slice(0, 20)}`);

    // Poll for confirmation
    let confirmed = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const statuses = await er.getSignatureStatuses([applySig]);
      const s = statuses?.value?.[0];
      if (s?.err) {
        console.error(`  apply_topup TX error:`, JSON.stringify(s.err));
        return NextResponse.json({ error: `apply_topup TX failed: ${JSON.stringify(s.err)}` }, { status: 500 });
      }
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
        console.log(`  Top-up applied (confirmed): ${applySig.slice(0, 20)}`);
        confirmed = true;
        break;
      }
    }

    if (!confirmed) {
      console.error(`  apply_topup TX not confirmed after 15s: ${applySig.slice(0, 20)}`);
      return NextResponse.json({
        error: 'apply_topup TX not confirmed on TEE after 15s — proof may not have propagated. Try again.',
        signature: applySig,
      }, { status: 500 });
    }

    // Step 3: Cleanup deposit proof (fire-and-forget — crank will handle if this fails)
    try {
      const { buildCleanupDepositProofInstruction } = await import('@/lib/onchain-game');
      const cleanupIx = buildCleanupDepositProofInstruction(
        authority.publicKey,
        tablePubkey,
        seatIndex,
      );
      const cleanupTx = new Transaction().add(cleanupIx);
      cleanupTx.feePayer = authority.publicKey;
      cleanupTx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
      cleanupTx.sign(authority);
      er.sendRawTransaction(cleanupTx.serialize(), { skipPreflight: true }).catch(() => {});
      console.log(`  Cleanup deposit proof sent (fire-and-forget)`);
    } catch (e: any) {
      console.warn(`  Cleanup failed (non-fatal):`, e.message?.slice(0, 80));
    }

    return NextResponse.json({
      success: true,
      signature: applySig,
      message: `Top-up applied to seat ${seatIndex}`,
    });

  } catch (error: any) {
    console.error('Top-up error:', error);
    return NextResponse.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
}
