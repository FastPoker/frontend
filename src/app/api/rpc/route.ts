import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlockhashViaIndexer } from '@/lib/indexer-client';
import { Connection, PublicKey } from '@solana/web3.js';
import { getL1Rpc } from '@/lib/rpc-config';

/**
 * Chunk 8b — bound quota abuse on the open sendRawTransaction relay. Per
 * IP, allow up to SEND_RATE_MAX tx sends per SEND_RATE_WINDOW_MS. Map is
 * in-process (single Next.js instance); multi-instance deployments need
 * a shared store. Read-only methods (getAccountInfo, getBalance, etc.)
 * are not rate-limited — cheap + cachable.
 */
const SEND_RATE_MAX = 10;
const SEND_RATE_WINDOW_MS = 10_000;
const sendHits = new Map<string, number[]>();
function ipOf(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}
function sendAllowed(req: NextRequest): boolean {
  const ip = ipOf(req);
  const now = Date.now();
  const hits = (sendHits.get(ip) || []).filter((t) => now - t < SEND_RATE_WINDOW_MS);
  if (hits.length >= SEND_RATE_MAX) {
    sendHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  sendHits.set(ip, hits);
  return true;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { method, params } = body;
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
        if (!sendAllowed(request)) {
          return NextResponse.json(
            { error: `Rate limited: max ${SEND_RATE_MAX} sendRawTransaction per ${SEND_RATE_WINDOW_MS / 1000}s` },
            { status: 429 },
          );
        }
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
  } catch (error: any) {
    console.error('RPC API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
