import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlockhashViaIndexer } from '@/lib/indexer-client';
import { Connection, PublicKey } from '@solana/web3.js';
import { getL1Rpc } from '@/lib/rpc-config';
import { chargeBudgets, checkProvenance, clientIp, type Rejection } from '@/lib/rpc-proxy-guard';

/**
 * Legacy fixed-method RPC relay. Same abuse guard as the `/rpc` proxy:
 * same-origin browser requests only, per-IP and global budgets (see
 * rpc-proxy-guard). Budgets are in-process; multi-instance deployments need a
 * shared limiter in front.
 */
function denied(r: Rejection) {
  return NextResponse.json(
    { error: r.message },
    { status: r.status, headers: r.retryAfterSec ? { 'Retry-After': String(r.retryAfterSec) } : {} },
  );
}

/** Upstream errors must never echo the provider URL (it carries the key). */
function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'RPC request failed';
  return raw.replace(/\b(?:https?|wss?):\/\/\S+/gi, '[rpc]').slice(0, 500);
}

export async function POST(request: NextRequest) {
  const provenance = checkProvenance(request);
  if (provenance) return denied(provenance);

  try {
    const body = await request.json();
    const { method, params } = body;
    const limited = chargeBudgets(clientIp(request), {
      credits: 1,
      sends: method === 'sendRawTransaction' ? 1 : 0,
    });
    if (limited) return denied(limited);
    const connection = new Connection(getL1Rpc(), 'confirmed');

    switch (method) {
      case 'getAccountInfo': {
        const [pubkeyStr] = params;
        const pubkey = new PublicKey(pubkeyStr);
        const accountInfo = await connection.getAccountInfo(pubkey);
        return NextResponse.json({
          result: accountInfo ? {
            data: Buffer.from(accountInfo.data).toString('base64'),
            executable: accountInfo.executable,
            lamports: accountInfo.lamports,
            owner: accountInfo.owner.toBase58(),
            rentEpoch: accountInfo.rentEpoch,
          } : null
        });
      }

      case 'getBalance': {
        const [pubkeyStr] = params;
        const pubkey = new PublicKey(pubkeyStr);
        const balance = await connection.getBalance(pubkey);
        return NextResponse.json({ result: balance });
      }

      case 'getTokenAccountBalance': {
        const [pubkeyStr] = params;
        const pubkey = new PublicKey(pubkeyStr);
        const balance = await connection.getTokenAccountBalance(pubkey);
        return NextResponse.json({ result: balance.value });
      }

      case 'getLatestBlockhash': {
        const blockhash = await getLatestBlockhashViaIndexer(connection, 'confirmed');
        return NextResponse.json({ 
          result: {
            blockhash: blockhash.blockhash,
            lastValidBlockHeight: blockhash.lastValidBlockHeight
          }
        });
      }

      case 'sendRawTransaction': {
        const [txBase64] = params;
        const txBuffer = Buffer.from(txBase64, 'base64');
        const signature = await connection.sendRawTransaction(txBuffer, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
        return NextResponse.json({ result: signature });
      }

      case 'confirmTransaction': {
        const [signature] = params;
        const result = await connection.confirmTransaction(signature, 'confirmed');
        return NextResponse.json({ result: result.value });
      }

      case 'getMultipleAccountsInfo': {
        const [pubkeyStrs] = params;
        const pubkeys = pubkeyStrs.map((s: string) => new PublicKey(s));
        const accounts = await connection.getMultipleAccountsInfo(pubkeys);
        return NextResponse.json({
          result: accounts.map(acc => acc ? {
            data: Buffer.from(acc.data).toString('base64'),
            executable: acc.executable,
            lamports: acc.lamports,
            owner: acc.owner.toBase58(),
            rentEpoch: acc.rentEpoch,
          } : null)
        });
      }

      default:
        return NextResponse.json({ error: `Unknown method: ${method}` }, { status: 400 });
    }
  } catch (error: unknown) {
    console.error('RPC API error:', safeMessage(error));
    return NextResponse.json({ error: safeMessage(error) }, { status: 500 });
  }
}
