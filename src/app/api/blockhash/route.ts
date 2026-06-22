import { NextRequest, NextResponse } from 'next/server';
import { Commitment, Connection } from '@solana/web3.js';
import { getL1Rpc } from '@/lib/rpc-config';
import { getLatestBlockhashViaIndexer } from '@/lib/indexer-client';

// Same-origin proxy for the browser. The helper keeps a short process-local
// single-flight cache around direct RPC getLatestBlockhash calls.
let connection: Connection | null = null;
function getConnection(): Connection {
  if (!connection) connection = new Connection(getL1Rpc(), 'confirmed');
  return connection;
}

const VALID_COMMITMENTS: Commitment[] = ['processed', 'confirmed', 'finalized'];

export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get('commitment') as Commitment | null;
  const commitment: Commitment = requested && VALID_COMMITMENTS.includes(requested) ? requested : 'confirmed';
  try {
    const data = await getLatestBlockhashViaIndexer(getConnection(), commitment);
    return NextResponse.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'getLatestBlockhash failed' }, { status: 502 });
  }
}
