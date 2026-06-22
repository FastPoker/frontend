import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlockhashViaIndexer } from '@/lib/indexer-client';
import { getL1Rpc } from '@/lib/rpc-config';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { IX_DISC } from '@/lib/discriminators';
import { getTeeConnection } from '@/lib/tee-auth-server';
import { requireTrustedOrigin, requireWalletSignature } from '@/lib/api-auth';
import { requireRateLimit } from '@/lib/api-rate-limit';
import { loadRequiredServerKeypair } from '@/lib/server-runtime-keys';
import {
  ANCHOR_PROGRAM_ID,
  FASTPOKER_REGISTRY_PROGRAM_ID,
  POOL_PDA,
  STEEL_PROGRAM_ID,
  TREASURY,
} from '@/lib/constants';
const PROGRAM_ID = ANCHOR_PROGRAM_ID;
const REGISTRY_PROGRAM_ID = FASTPOKER_REGISTRY_PROGRAM_ID;

// Retained CrankTally compatibility layout (mirrors backend/crank/constants.ts)
const TALLY_OPERATORS_START = 40;
const TALLY_ACTION_COUNT_START = 168;
const MAX_CRANK_OPERATORS = 4;
const CRANK_TALLY_SIZE = 197;

function parseTallyOperators(data: Buffer, weightMul: number): { pubkey: PublicKey; weight: number }[] {
  const result: { pubkey: PublicKey; weight: number }[] = [];
  if (data.length < CRANK_TALLY_SIZE) return result;
  for (let i = 0; i < MAX_CRANK_OPERATORS; i++) {
    const pkStart = TALLY_OPERATORS_START + i * 32;
    const countStart = TALLY_ACTION_COUNT_START + i * 4;
    const pk = new PublicKey(data.subarray(pkStart, pkStart + 32));
    if (pk.equals(PublicKey.default)) continue;
    const count = data.readUInt32LE(countStart);
    if (count === 0) continue;
    result.push({ pubkey: pk, weight: count * weightMul });
  }
  return result;
}

// CommitState via CPI through our contract (direct Magic program calls fail on ER)
const MAGIC_PROGRAM_ID = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT_ID = new PublicKey('MagicContext1111111111111111111111111111111');
const MAGIC_FEE_VAULT = new PublicKey('EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b');
const COMMIT_STATE_DISC = IX_DISC.commitState;
function buildCommitInstruction(payer: PublicKey, accounts: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: COMMIT_STATE_DISC,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_FEE_VAULT, isSigner: false, isWritable: true },
      ...accounts.map(a => ({ pubkey: a, isSigner: false, isWritable: true })),
    ],
  });
}

const SETTLE_TABLE_REWARDS_DISC = IX_DISC.settleTableRewards;
const RESIZE_VAULT_DISC = IX_DISC.resizeVault;

// Table offsets
const OFF_RAKE_ACCUMULATED = 147;
const OFF_IS_USER_CREATED = 322;
const OFF_CREATOR = 290;
const OFF_TOKEN_ESCROW = 258; // token_escrow Pubkey in Table struct
const OFF_TOKEN_MINT = 385; // token_mint Pubkey in Table struct

function getCrankerKeypair(): Keypair {
  return loadRequiredServerKeypair('AUTHORITY_KEYPAIR_PATH');
}

// Legacy pool-authority rake accounting was removed. POKER rake accrual now
// flows via FastPoker's notify_pool_spl_deposit CPI inside settle_table_rewards.

/**
 * POST /api/cash-game/clear-rake
 * CommitState → L1 distribution flow:
 * 1. CommitState table on ER (push rake_accumulated to L1)
 * 2. Read committed L1 data to compute delta
 * 3. settle_table_rewards on L1 (parameterless — contract reads table bytes)
 * NO ER clear needed — counter stays monotonic for L1 delta to work correctly.
 * Body: { tablePda: string }
 */
export async function POST(req: NextRequest) {
  try {
    const originError = requireTrustedOrigin(req);
    if (originError) return originError;
    const body = await req.json();
    const { tablePda: tablePdaStr, wallet } = body;
    if (!tablePdaStr || !wallet) {
      return NextResponse.json({ success: false, error: 'Missing tablePda or wallet' }, { status: 400 });
    }
    const authError = requireWalletSignature(body, 'cash-clear-rake');
    if (authError) return authError;
    const rateError = requireRateLimit(req, 'cash-clear-rake', `${wallet}:${tablePdaStr}`, 4, 60_000);
    if (rateError) return rateError;

    const tablePda = new PublicKey(tablePdaStr);
    const er = await getTeeConnection();
    const l1 = new Connection(getL1Rpc(), 'confirmed');
    const admin = getCrankerKeypair();

    // ──────────────────────────────────────────────────────────────
    // Step 1: Quick ER check — is there any rake to distribute?
    // ──────────────────────────────────────────────────────────────
    const erInfo = await er.getAccountInfo(tablePda);
    if (!erInfo) {
      return NextResponse.json({ success: false, error: 'Table not found on ER' }, { status: 404 });
    }
    const erData = Buffer.from(erInfo.data);
    const erRake = Number(erData.readBigUInt64LE(OFF_RAKE_ACCUMULATED));
    if (erRake === 0) {
      return NextResponse.json({ success: true, message: 'No rake to distribute', distributed: 0 });
    }

    const tokenMint = new PublicKey(erData.subarray(OFF_TOKEN_MINT, OFF_TOKEN_MINT + 32));
    const erCreator = new PublicKey(erData.subarray(OFF_CREATOR, OFF_CREATOR + 32)).toBase58();
    if (erCreator !== wallet) {
      return NextResponse.json({ success: false, error: 'Wallet is not this table creator' }, { status: 403 });
    }
    const isSolTable = tokenMint.equals(PublicKey.default);
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), tablePda.toBuffer()], PROGRAM_ID
    );

    // ──────────────────────────────────────────────────────────────
    // Step 2: CommitState on ER — push table data to L1
    // ──────────────────────────────────────────────────────────────
    let commitSig = '';
    try {
      const commitIx = buildCommitInstruction(admin.publicKey, [tablePda]);
      const commitTx = new Transaction().add(commitIx);
      commitTx.feePayer = admin.publicKey;
      // Use TEE's own blockhash (L1 blockhash causes "Blockhash not found" on TEE)
      commitTx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
      commitTx.sign(admin);
      // TEE WS works, but using sendRawTransaction + polling for simplicity. Migration to confirmTransaction pending.
      commitSig = await er.sendRawTransaction(commitTx.serialize(), { skipPreflight: true });
      // Poll for confirmation
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const statuses = await er.getSignatureStatuses([commitSig]);
        if (statuses?.value?.[0]?.confirmationStatus === 'confirmed' || statuses?.value?.[0]?.confirmationStatus === 'finalized') break;
      }
      console.log(`[clear-rake] CommitState → L1 OK: ${commitSig.slice(0, 16)}`);
    } catch (e: any) {
      const err = e.message?.slice(0, 200) || 'CommitState failed';
      console.error(`[clear-rake] CommitState FAILED — ABORTING: ${err}`);
      return NextResponse.json({
        success: false,
        error: `CommitState failed — cannot sync ER data to L1. ${err}`,
      }, { status: 500 });
    }

    // ──────────────────────────────────────────────────────────────
    // Step 3: Read committed L1 data to compute delta for Steel
    // ──────────────────────────────────────────────────────────────
    const l1TableInfo = await l1.getAccountInfo(tablePda);
    if (!l1TableInfo || l1TableInfo.data.length < 155) {
      return NextResponse.json({ success: false, error: 'Table not readable on L1 after commit' }, { status: 500 });
    }
    const l1Data = Buffer.from(l1TableInfo.data);
    const l1RakeAccum = Number(l1Data.readBigUInt64LE(OFF_RAKE_ACCUMULATED));
    const isUserCreated = l1Data[OFF_IS_USER_CREATED] === 1;
    const creator = new PublicKey(l1Data.subarray(OFF_CREATOR, OFF_CREATOR + 32));
    const creatorAccount = isUserCreated ? creator : TREASURY;

    const vaultInfo = await l1.getAccountInfo(vaultPda);
    if (!vaultInfo) {
      return NextResponse.json({ success: false, error: 'Vault not found on L1' }, { status: 404 });
    }
    const vaultData = Buffer.from(vaultInfo.data);
    const totalRakeDistributed = vaultData.length >= 73 ? Number(vaultData.readBigUInt64LE(65)) : 0;

    const rakeDelta = Math.max(0, l1RakeAccum - totalRakeDistributed);
    console.log(`[clear-rake] L1_committed=${l1RakeAccum}, distributed=${totalRakeDistributed}, delta=${rakeDelta}`);
    if (rakeDelta === 0) {
      return NextResponse.json({
        success: true, distributed: 0,
        message: 'No new rake after commit (already distributed)',
        l1RakeAccum, totalRakeDistributed,
      });
    }

    // ──────────────────────────────────────────────────────────────
    // Step 4: settle_table_rewards on L1.
    // Operator rewards are paid by the crank's pull-claim lane; retained
    // compatibility accounts stay in the IX account list for ABI shape.
    // ──────────────────────────────────────────────────────────────
    const [prizeAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('prize_authority')], PROGRAM_ID
    );
    const [erTallyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('crank_tally_er'), tablePda.toBuffer()], PROGRAM_ID
    );
    const [l1TallyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('crank_tally_l1'), tablePda.toBuffer()], PROGRAM_ID
    );
    const [tipJarPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('tip_jar'), tablePda.toBuffer()], PROGRAM_ID
    );

    const preCreateIxs: TransactionInstruction[] = [];
    let settleRemaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    let poolTokenAccountForRecord: PublicKey | null = null;

    if (!isSolTable) {
      const configuredEscrow = new PublicKey(l1Data.subarray(OFF_TOKEN_ESCROW, OFF_TOKEN_ESCROW + 32));
      const tableTokenAccount = configuredEscrow.equals(PublicKey.default)
        ? await getAssociatedTokenAddress(tokenMint, tablePda, true)
        : configuredEscrow;
      const poolTokenAccount = await getAssociatedTokenAddress(tokenMint, POOL_PDA, true);
      const treasuryTokenAccount = await getAssociatedTokenAddress(tokenMint, TREASURY, true);
      const creatorTokenAccount = isUserCreated
        ? await getAssociatedTokenAddress(tokenMint, creator, true)
        : treasuryTokenAccount;
      poolTokenAccountForRecord = poolTokenAccount;

      // Compatibility-only: old tallies can reveal older operator ATAs to pre-create.
      // Current reward weights come from CrankAction/OperatorRewardTotal.
      const [erTallyInfo, l1TallyInfo] = await Promise.all([
        l1.getAccountInfo(erTallyPda).catch(() => null),
        l1.getAccountInfo(l1TallyPda).catch(() => null),
      ]);
      const erOps = erTallyInfo ? parseTallyOperators(Buffer.from(erTallyInfo.data), 1) : [];
      const l1Ops = l1TallyInfo ? parseTallyOperators(Buffer.from(l1TallyInfo.data), 2) : [];
      const merged = new Map<string, { pubkey: PublicKey; weight: number }>();
      for (const op of [...erOps, ...l1Ops]) {
        const k = op.pubkey.toBase58();
        const existing = merged.get(k);
        if (existing) existing.weight += op.weight;
        else merged.set(k, { ...op });
      }
      const ops = Array.from(merged.values());
      if (ops.length === 0) ops.push({ pubkey: admin.publicKey, weight: 1 });

      // Pre-create operator ATAs idempotently for SPL reward claims.
      const seenAtas = new Set<string>([
        poolTokenAccount.toBase58(),
        treasuryTokenAccount.toBase58(),
        creatorTokenAccount.toBase58(),
        tableTokenAccount.toBase58(),
      ]);
      const dealerAtas: PublicKey[] = [];
      for (const op of ops) {
        const dealerAta = await getAssociatedTokenAddress(tokenMint, op.pubkey, true);
        dealerAtas.push(dealerAta);
        if (seenAtas.has(dealerAta.toBase58())) continue;
        seenAtas.add(dealerAta.toBase58());
        preCreateIxs.push(
          createAssociatedTokenAccountIdempotentInstruction(
            admin.publicKey,
            dealerAta,
            op.pubkey,
            tokenMint,
          ),
        );
      }

      // Derive per-mint SPL reward pool PDA (Steel disc 9 account)
      const [splRewardPoolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('spl_reward_pool'), tokenMint.toBuffer()],
        STEEL_PROGRAM_ID,
      );

      // SPL bundle[0..6]; any following old operator tuple accounts are ignored
      // by the current reward math.
      settleRemaining = [
        { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
        { pubkey: tableTokenAccount,    isSigner: false, isWritable: true  },
        { pubkey: poolTokenAccount,     isSigner: false, isWritable: true  },
        { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true  },
        { pubkey: creatorTokenAccount,  isSigner: false, isWritable: true  },
        { pubkey: splRewardPoolPda,     isSigner: false, isWritable: true  },
      ];
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const [opPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('crank'), op.pubkey.toBuffer()], PROGRAM_ID,
        );
        const [licPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('dealer_license'), op.pubkey.toBuffer()], REGISTRY_PROGRAM_ID,
        );
        settleRemaining.push({ pubkey: op.pubkey,      isSigner: false, isWritable: false });
        settleRemaining.push({ pubkey: opPda,          isSigner: false, isWritable: true  });
        settleRemaining.push({ pubkey: licPda,         isSigner: false, isWritable: false });
        settleRemaining.push({ pubkey: dealerAtas[i],  isSigner: false, isWritable: true  });
      }
    }

    const distIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey,         isSigner: true,  isWritable: true  },
        { pubkey: tablePda,                isSigner: false, isWritable: false },
        { pubkey: vaultPda,                isSigner: false, isWritable: true  },
        { pubkey: POOL_PDA,                isSigner: false, isWritable: true  },
        { pubkey: TREASURY,                isSigner: false, isWritable: true  },
        { pubkey: creatorAccount,          isSigner: false, isWritable: true  },
        { pubkey: STEEL_PROGRAM_ID,        isSigner: false, isWritable: false },
        { pubkey: prizeAuthPda,            isSigner: false, isWritable: true  },
        { pubkey: erTallyPda,              isSigner: false, isWritable: false },
        { pubkey: l1TallyPda,              isSigner: false, isWritable: true  },
        { pubkey: tipJarPda,               isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...settleRemaining,
      ],
      data: SETTLE_TABLE_REWARDS_DISC,
    });

    // Resize vault + distribute (atomic L1 TX, pre-creates first)
    const resizeIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: false },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: RESIZE_VAULT_DISC,
    });

    // Legacy record_poker_rake removed — POKER staker accrual now flows through
    // FastPoker's notify_pool_spl_deposit CPI inside settle_table_rewards.
    const signers: Keypair[] = [admin];
    const distTx = new Transaction();
    for (const preIx of preCreateIxs) distTx.add(preIx);
    distTx.add(resizeIx).add(distIx);

    let distSig = '';
    let distributed = 0;
    try {
      distTx.feePayer = admin.publicKey;
      distTx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
      distSig = await sendAndConfirmTransaction(l1, distTx, signers, { commitment: 'confirmed' });
      distributed = rakeDelta;
      console.log(`[clear-rake] L1 distributed ${rakeDelta} lamports, sig=${distSig.slice(0, 16)}`);
    } catch (e: any) {
      // L1 failed after commit. Safe to retry — delta check on L1 ensures correct amount.
      const l1Error = e.message?.slice(0, 200) || 'L1 distribution failed';
      console.error(`[clear-rake] L1 FAILED: ${l1Error}`);
      return NextResponse.json({
        success: false,
        error: `L1 distribution failed. Retry — delta check ensures correct amount. ${l1Error}`,
        commitSig,
        rakeDelta,
      }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      distributed,
      rakeDelta,
      creator: creator.toBase58(),
      isUserCreated,
      l1Signature: distSig,
      commitSignature: commitSig,
    });
  } catch (e: any) {
    console.error('[clear-rake] Error:', e.message?.slice(0, 200));
    return NextResponse.json({ success: false, error: e.message?.slice(0, 200) || 'Unknown error' }, { status: 500 });
  }
}
