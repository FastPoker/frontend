import { NextRequest, NextResponse } from 'next/server';
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import { getL1Rpc } from '@/lib/rpc-config';
import {
  buildClearStaleJoinMarkerInstruction,
  getDepositProofPda,
  getPlayerTableMarkerPda,
} from '@/lib/onchain-game';
import { requireTrustedOrigin, requireWalletSignature } from '@/lib/api-auth';
import { requireRateLimit } from '@/lib/api-rate-limit';
import { loadRequiredServerKeypair } from '@/lib/server-runtime-keys';

let crankKeypair: Keypair | null = null;
function getCrankKeypair(): Keypair {
  if (crankKeypair) return crankKeypair;
  crankKeypair = loadRequiredServerKeypair('AUTHORITY_KEYPAIR_PATH');
  return crankKeypair;
}

export async function POST(request: NextRequest) {
  try {
    const originError = requireTrustedOrigin(request);
    if (originError) return originError;

    const body = await request.json();
    const { tablePda, seatIndex, wallet } = body;
    if (!tablePda || seatIndex === undefined || !wallet) {
      return NextResponse.json({ error: 'tablePda, seatIndex, and wallet required' }, { status: 400 });
    }

    const authError = requireWalletSignature(body, 'cash-clear-stale-marker');
    if (authError) return authError;
    const rateError = requireRateLimit(request, 'cash-clear-stale-marker', `${wallet}:${tablePda}:${seatIndex}`, 4, 60_000);
    if (rateError) return rateError;

    const l1 = new Connection(getL1Rpc(), 'confirmed');
    const payer = getCrankKeypair();
    const tablePubkey = new PublicKey(tablePda);
    const walletPubkey = new PublicKey(wallet);
    const [markerPda] = getPlayerTableMarkerPda(walletPubkey, tablePubkey);
    const [proofPda] = getDepositProofPda(tablePubkey, seatIndex);

    const [markerInfo, proofInfo] = await Promise.all([
      l1.getAccountInfo(markerPda),
      l1.getAccountInfo(proofPda),
    ]);

    if (!markerInfo || markerInfo.data.length < 73) {
      return NextResponse.json({ success: true, cleared: false, reason: 'marker_not_found' });
    }

    const markerPlayer = new PublicKey(markerInfo.data.subarray(8, 40));
    const markerTable = new PublicKey(markerInfo.data.subarray(40, 72));
    const markerSeat = markerInfo.data[72];
    if (markerPlayer.equals(PublicKey.default)) {
      return NextResponse.json({ success: true, cleared: false, reason: 'marker_already_clear' });
    }
    if (!markerPlayer.equals(walletPubkey) || !markerTable.equals(tablePubkey) || markerSeat !== seatIndex) {
      return NextResponse.json({ error: 'Marker does not match wallet/table/seat' }, { status: 409 });
    }

    if (!proofInfo || proofInfo.owner.equals(DELEGATION_PROGRAM_ID) || proofInfo.data.length < 90) {
      return NextResponse.json({
        success: false,
        pending: true,
        error: 'Seat still has a pending join proof. Try taking the seat or wait for cleanup.',
      }, { status: 409 });
    }

    const proofDepositor = new PublicKey(proofInfo.data.subarray(41, 73));
    const proofBuyIn = proofInfo.data.readBigUInt64LE(73);
    const proofReserve = proofInfo.data.readBigUInt64LE(81);
    const proofConsumed = proofInfo.data[89] === 1;
    if (!proofDepositor.equals(PublicKey.default) || proofBuyIn !== BigInt(0) || proofReserve !== BigInt(0) || proofConsumed) {
      return NextResponse.json({
        success: false,
        pending: true,
        error: 'Seat has an active or consumed join proof. It cannot be marker-cleared.',
      }, { status: 409 });
    }

    const ix = buildClearStaleJoinMarkerInstruction(payer.publicKey, tablePubkey, seatIndex, walletPubkey);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(l1, tx, [payer], { commitment: 'confirmed' });

    return NextResponse.json({ success: true, cleared: true, signature: sig });
  } catch (e: any) {
    console.error('Clear stale marker failed:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
