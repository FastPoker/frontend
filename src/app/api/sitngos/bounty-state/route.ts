import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import { getL1Rpc } from '@/lib/rpc-config';
import { getSngDuelPda, parseSngDuelState } from '@/lib/sng-duel';
import {
  getSngJackpotTableStatePda,
  getEmissionCtrlPda,
  parseSngJackpotTableState,
  parseEmissionCtrl,
  computeRawMultBps,
} from '@/lib/emission-onchain';
import { getTeeConnection } from '@/lib/tee-auth-server';

export const dynamic = 'force-dynamic';

function jsonNoStore(body: unknown, init?: ResponseInit) {
  const res = NextResponse.json(body, init);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

// GET /api/sitngos/bounty-state?table=<pubkey>
// Reads the deployed SngDuelState sidecar for a table (returns initialized:false if none yet).
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const tableStr = searchParams.get('table');
    if (!tableStr) {
      return jsonNoStore({ success: false, error: 'missing table param' }, { status: 400 });
    }
    let table: PublicKey;
    try {
      table = new PublicKey(tableStr);
    } catch {
      return jsonNoStore({ success: false, error: 'invalid table pubkey' }, { status: 400 });
    }

    const [pda] = getSngDuelPda(table);
    const [jackpotPda] = getSngJackpotTableStatePda(table);
    const [emissionCtrlPda] = getEmissionCtrlPda();
    let account: { data: Buffer } | null = null;
    let jackpotAccount: { data: Buffer } | null = null;
    let ctrlAccount: { data: Buffer } | null = null;
    let source: 'TEE' | 'L1' = 'L1';

    // Live duel state is mutated on the ER while the table is delegated. Reading
    // L1 only makes the UI miss active duels or see a pre-delegation sidecar.
    // The jackpot snapshot (funded $FP pool truth) and EmissionCtrl (governor)
    // ride along in the same batch; each falls back to L1 individually.
    try {
      const tee = await getTeeConnection();
      const [a, j, c] = await tee.getMultipleAccountsInfo([pda, jackpotPda, emissionCtrlPda], 'confirmed');
      account = a; jackpotAccount = j; ctrlAccount = c;
      if (account) source = 'TEE';
    } catch {
      // TEE auth/reachability is allowed to fail here; fall back to L1 so the
      // bounty bank still works for undelegated/settled tables.
    }

    if (!account || !jackpotAccount || !ctrlAccount) {
      const connection = new Connection(getL1Rpc(), 'confirmed');
      const [a, j, c] = await connection.getMultipleAccountsInfo([pda, jackpotPda, emissionCtrlPda], 'confirmed');
      if (!account) { account = a; source = 'L1'; }
      if (!jackpotAccount) jackpotAccount = j;
      if (!ctrlAccount) ctrlAccount = c;
    }

    // The table's true $FP pool once funded (normal = gross minus the 10% grand skim),
    // plus the CURRENT governor multiplier for honest previews on unfunded tables.
    let pool: { grandFunded: boolean; grossUnrefined: string; normalUnrefined: string } | null = null;
    let emissionRateBps: number | null = null;
    try {
      if (jackpotAccount) {
        const j = parseSngJackpotTableState(Buffer.from(jackpotAccount.data));
        pool = {
          grandFunded: j.grandFunded,
          grossUnrefined: j.grossUnrefined.toString(),
          normalUnrefined: j.normalUnrefined.toString(),
        };
      }
    } catch { /* malformed/legacy account: omit */ }
    try {
      if (ctrlAccount) {
        emissionRateBps = computeRawMultBps(
          parseEmissionCtrl(Buffer.from(ctrlAccount.data)),
          Math.floor(Date.now() / 1000),
        );
      }
    } catch { /* ctrl not initialized: omit */ }

    if (!account) {
      return jsonNoStore({
        success: true,
        initialized: false,
        pda: pda.toBase58(),
        source,
        pool,
        emissionRateBps,
        fetchedAt: Date.now(),
      });
    }

    const s = parseSngDuelState(Buffer.from(account.data));
    return jsonNoStore({
      success: true,
      initialized: true,
      pda: pda.toBase58(),
      source,
      pool,
      emissionRateBps,
      fetchedAt: Date.now(),
      state: {
        table: s.table.toBase58(),
        maxPlayers: s.maxPlayers,
        paid: s.paid,
        finalBlindLevel: s.finalBlindLevel,
        creditedHandNumber: s.creditedHandNumber.toString(),
        lastAccountedHand: s.lastAccountedHand.toString(),
        knockoutCreditUnits: s.knockoutCreditUnits.map(String),
        fpBountyWeightUnits: s.fpBountyWeightUnits.map(String),
        eliminatedBountyUnits: s.eliminatedBountyUnits.map(String),
        eliminationLevel: s.eliminationLevel,
        foldCounts: s.foldCounts,
        lastDuelBlindLevel: s.lastDuelBlindLevel,
        duelActive: s.duelActive,
        duelRound: s.duelRound,
        duelSeatA: s.duelSeatA,
        duelSeatB: s.duelSeatB,
        duelChoiceA: s.duelChoiceA,
        duelChoiceB: s.duelChoiceB,
        duelStartedHand: s.duelStartedHand.toString(),
        duelDeadlineTs: s.duelDeadlineTs.toString(),
        // Flat Bounty config + state.
        pointsSeeded: s.pointsSeeded,
        ruleset: s.ruleset,
        seededCount: s.seededCount,
        duelPauseStartedTs: s.duelPauseStartedTs.toString(),
      },
    });
  } catch (e: any) {
    return jsonNoStore(
      { success: false, error: e?.message || 'Failed to load bounty state' },
      { status: 500 },
    );
  }
}
