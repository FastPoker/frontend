import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlockhashViaIndexer } from '@/lib/indexer-client';
import { Connection, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction, PublicKey, SystemProgram, ComputeBudgetProgram, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
import { DELEGATION_PROGRAM_ID, delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationRecordPdaFromDelegatedAccount, delegationMetadataPdaFromDelegatedAccount, permissionPdaFromAccount } from '@magicblock-labs/ephemeral-rollups-sdk';
import { getSeatPda, getSeatCardsPda, getDeckStatePda, getPermissionPda, getCrankTallyErPda, getGlobalEntropyPda, getHandReportBufferPda, getSlimBufferPda, getValidatorRegistryPda, getWhitelistPda, buildDelegateSlimBufferInstruction, buildCreateDeckStatePermission, buildUpdateDeckStatePermission, buildDelegateDeckStatePermission } from '@/lib/onchain-game';
import { ANCHOR_PROGRAM_ID, PERMISSION_PROGRAM_ID, TABLE_OFFSETS, TEE_VALIDATOR } from '@/lib/constants';
import { getTeeConnection } from '@/lib/tee-auth-server';
import { getL1Rpc } from '@/lib/rpc-config';
import { IX_DISC } from '@/lib/discriminators';
import { loadRequiredServerKeypair } from '@/lib/server-runtime-keys';

const START_GAME_DISC = IX_DISC.startGame;
const DELEGATE_TABLE_DISC = IX_DISC.delegateTable;
const DELEGATE_SEAT_DISC = IX_DISC.delegateSeat;
const DELEGATE_SEAT_CARDS_DISC = IX_DISC.delegateSeatCards;
const DELEGATE_DECK_STATE_DISC = IX_DISC.delegateDeckState;
const DELEGATE_CRANK_TALLY_DISC = IX_DISC.delegateCrankTally;

let authorityKeypair: Keypair | null = null;
function getAuthority(): Keypair {
  if (authorityKeypair) return authorityKeypair;
  authorityKeypair = loadRequiredServerKeypair('AUTHORITY_KEYPAIR_PATH');
  return authorityKeypair;
}

async function waitForTeeSignature(conn: Connection, signature: string, label: string): Promise<void> {
  for (let p = 0; p < 15; p++) {
    await new Promise(r => setTimeout(r, 1000));
    const statuses = await conn.getSignatureStatuses([signature]);
    const status = statuses?.value?.[0];
    if (status?.err) {
      throw new Error(`${label} failed on TEE: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }
  }
  throw new Error(`${label} not confirmed on TEE within timeout: ${signature}`);
}

async function sendL1Instruction(
  l1: Connection,
  authority: Keypair,
  ix: TransactionInstruction,
  label: string,
): Promise<void> {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
  await sendAndConfirmTransaction(l1, tx, [authority], { commitment: 'confirmed' });
  console.log(`  ${label}`);
}

async function ensureDeckStatePermissionDelegated(
  l1: Connection,
  authority: Keypair,
  tablePubkey: PublicKey,
): Promise<void> {
  const [deckStatePda] = getDeckStatePda(tablePubkey);
  const [deckPermPda] = getPermissionPda(deckStatePda);
  let permInfo = await l1.getAccountInfo(deckPermPda);

  if (!permInfo) {
    await sendL1Instruction(
      l1,
      authority,
      buildCreateDeckStatePermission(authority.publicKey, tablePubkey),
      'DeckState permission created',
    );
    permInfo = await l1.getAccountInfo(deckPermPda);
  }

  if (permInfo?.owner.equals(DELEGATION_PROGRAM_ID)) {
    console.log('  DeckState permission already delegated');
    return;
  }

  if (!permInfo?.owner.equals(PERMISSION_PROGRAM_ID)) {
    throw new Error(`DeckState permission has unexpected owner ${permInfo?.owner.toBase58() || 'missing'}`);
  }

  await sendL1Instruction(
    l1,
    authority,
    buildUpdateDeckStatePermission(authority.publicKey, tablePubkey),
    'DeckState permission updated private',
  );
  await sendL1Instruction(
    l1,
    authority,
    buildDelegateDeckStatePermission(authority.publicKey, tablePubkey, DELEGATION_PROGRAM_ID),
    'DeckState permission delegated',
  );
}

function handReportNeedsFlush(data: Buffer): boolean {
  if (data.length < 12) return false;
  const finalized = data[2] !== 0;
  const cursor = data.readUInt32LE(8);
  return finalized && cursor > 0;
}

/**
 * POST /api/cash-game/ready
 * Called when a cash game table has 2+ players in Waiting/Complete phase.
 * Flow: delegate all accounts → FnE6 (TEE) → start_game → tee_deal
 * All game logic runs on TEE. Permissionless — any crank can call.
 * Body: { tablePda: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tablePda } = body;

    if (!tablePda) {
      return NextResponse.json({ error: 'tablePda required' }, { status: 400 });
    }

    const l1 = new Connection(getL1Rpc(), 'confirmed');
    const er = await getTeeConnection();
    const erWrite = er;
    const authority = getAuthority();
    const tablePubkey = new PublicKey(tablePda);
    const [slimBufferPda] = getSlimBufferPda(tablePubkey);
    const [validatorRegistryPda] = getValidatorRegistryPda();

    console.log(`=== Cash Game Ready Flow for ${tablePda.slice(0, 12)}... ===`);

    // Check delegation status
    const tableRecord = delegationRecordPdaFromDelegatedAccount(tablePubkey);
    const tableRecordInfo = await l1.getAccountInfo(tableRecord);
    const alreadyDelegated = !!tableRecordInfo;

    const readConn = alreadyDelegated ? er : l1;
    console.log(`Reading from: ${alreadyDelegated ? 'ER (pre-delegated)' : 'L1 (legacy)'}`);

    // Read table data to get maxPlayers and phase
    const tableInfo = await readConn.getAccountInfo(tablePubkey);
    if (!tableInfo) {
      return NextResponse.json({ error: 'Table not found' }, { status: 404 });
    }
    const tableData = tableInfo.data as Buffer;
    const tableId = Buffer.from(tableData.slice(8, 40));
    const maxPlayers = tableData[TABLE_OFFSETS.MAX_PLAYERS];
    const phase = tableData[TABLE_OFFSETS.PHASE];
    const tableCreator = tableData.length >= TABLE_OFFSETS.CREATOR + 32
      ? new PublicKey(tableData.subarray(TABLE_OFFSETS.CREATOR, TABLE_OFFSETS.CREATOR + 32))
      : PublicKey.default;
    const isPrivateTable = tableData.length > TABLE_OFFSETS.IS_PRIVATE
      ? tableData[TABLE_OFFSETS.IS_PRIVATE] === 1
      : false;

    // Phase 0=Waiting, 7=Complete — only start in these states
    if (phase !== 0 && phase !== 1 && phase !== 7) {
      return NextResponse.json({ error: `Hand in progress (phase=${phase})`, phase }, { status: 400 });
    }

    // Scan seats to find active players
    console.log('Step 1: Scanning seats...');
    const activeSeatIndices: number[] = [];
    const allPlayerPubkeys: Map<number, PublicKey> = new Map();

    for (let i = 0; i < maxPlayers; i++) {
      const seatPda = getSeatPda(tablePubkey, i)[0];
      const seatInfo = await readConn.getAccountInfo(seatPda);
      if (!seatInfo) continue;

      const seatData = seatInfo.data as Buffer;
      const playerPubkey = new PublicKey(seatData.slice(8, 40));
      if (playerPubkey.equals(PublicKey.default)) continue;

      // Status at offset 227: 0=Empty, 1=Active, 3=AllIn, 4=SittingOut, 5=Busted, 6=Leaving
      // waiting_for_bb at offset 239
      const status = seatData[227];
      const waitingForBb = seatData.length > 239 ? seatData[239] : 0;

      if (status === 0) continue; // Empty seat (pre-created but no player)

      allPlayerPubkeys.set(i, playerPubkey);

      if (status === 1 || status === 3) {
        activeSeatIndices.push(i);
        console.log(`  Seat ${i}: ACTIVE (${playerPubkey.toBase58().slice(0, 8)}...)`);
      } else if (status === 4 && waitingForBb === 1) {
        // SittingOut + waiting_for_bb: new joiner stuck in dead state
        // start_game will auto-activate them, so count as eligible
        activeSeatIndices.push(i);
        console.log(`  Seat ${i}: WAITING_FOR_BB → will auto-activate (${playerPubkey.toBase58().slice(0, 8)}...)`);
      } else {
        console.log(`  Seat ${i}: status=${status} (${playerPubkey.toBase58().slice(0, 8)}...)`);
      }
    }

    if (activeSeatIndices.length < 2) {
      return NextResponse.json({ error: `Need 2+ active players, found ${activeSeatIndices.length}` }, { status: 400 });
    }

    // ─── PRE-FLIGHT: Verify all required PDAs exist on L1 before delegation ───
    if (!alreadyDelegated) {
      console.log('Pre-flight: Verifying DeckState + Permission + SeatCards PDAs on L1...');

      // Check DeckState PDA exists
      const [deckStatePdaCheck] = getDeckStatePda(tablePubkey);
      const deckStateInfo = await l1.getAccountInfo(deckStatePdaCheck);
      if (!deckStateInfo) {
        return NextResponse.json({
          error: 'DeckState PDA missing on L1. Table must be created with init_table_seat (new contract). Please close and recreate.',
        }, { status: 400 });
      }
      await ensureDeckStatePermissionDelegated(l1, authority, tablePubkey);

      // Check SeatCards + Permission PDAs exist for each occupied seat
      for (const seatIdx of Array.from(allPlayerPubkeys.keys())) {
        const seatCardsPda = getSeatCardsPda(tablePubkey, seatIdx)[0];
        const seatCardsInfo = await l1.getAccountInfo(seatCardsPda);
        if (!seatCardsInfo) {
          return NextResponse.json({
            error: `SeatCards PDA missing for seat ${seatIdx}. Table must be created with init_table_seat. Please close and recreate.`,
          }, { status: 400 });
        }

        const permPda = permissionPdaFromAccount(seatCardsPda);
        const permInfo = await l1.getAccountInfo(permPda);
        if (!permInfo) {
          return NextResponse.json({
            error: `Permission PDA missing for seat ${seatIdx}. Table must be created with init_table_seat (new contract). Please close and recreate.`,
          }, { status: 400 });
        }
      }
      console.log('  ✅ All required PDAs verified on L1');

      // Delegate SlimBuffer before table delegation. The on-chain table delegate
      // guard requires remaining_accounts[1] to be this already-delegated PDA.
      const slimRecord = delegationRecordPdaFromDelegatedAccount(slimBufferPda);
      if (!(await l1.getAccountInfo(slimRecord))) {
        const slimDelegBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(slimBufferPda, ANCHOR_PROGRAM_ID);
        const slimMetadata = delegationMetadataPdaFromDelegatedAccount(slimBufferPda);
        try {
          const tx = new Transaction().add(buildDelegateSlimBufferInstruction(
            authority.publicKey,
            tablePubkey,
            slimDelegBuffer,
            slimRecord,
            slimMetadata,
            DELEGATION_PROGRAM_ID,
          ));
          tx.feePayer = authority.publicKey;
          tx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
          await sendAndConfirmTransaction(l1, tx, [authority], { commitment: 'confirmed' });
          console.log('  SlimBuffer delegated -> regional ER');
        } catch (e: any) {
          console.error(`  âŒ SlimBuffer delegation FAILED: ${e.message?.slice(0, 100)}`);
          return NextResponse.json({ error: `SlimBuffer delegation failed: ${e.message?.slice(0, 100)}` }, { status: 500 });
        }
      } else {
        console.log('  SlimBuffer already delegated');
      }

      // Delegate table
      const tableBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(tablePubkey, ANCHOR_PROGRAM_ID);
      const tableMetadata = delegationMetadataPdaFromDelegatedAccount(tablePubkey);
      const delegateTableData = Buffer.alloc(40);
      DELEGATE_TABLE_DISC.copy(delegateTableData, 0);
      tableId.copy(delegateTableData, 8);

      try {
        // CG-CT3: Pass ALL permission PDAs as remaining_accounts so contract can
        // verify full setup is complete before allowing delegation (prevents zombie tables).
        const remainingKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
          { pubkey: slimBufferPda, isSigner: false, isWritable: false },
        ];
        for (let i = 0; i < maxPlayers; i++) {
          const [seatPda] = getSeatPda(tablePubkey, i);
          const [seatPerm] = getPermissionPda(seatPda);
          remainingKeys.push({ pubkey: seatPerm, isSigner: false, isWritable: false });
        }
        const [tablePerm] = getPermissionPda(tablePubkey);
        remainingKeys.push({ pubkey: tablePerm, isSigner: false, isWritable: false });
        const [dsPdaForPerm] = getDeckStatePda(tablePubkey);
        const [dsPerm] = getPermissionPda(dsPdaForPerm);
        remainingKeys.push({ pubkey: dsPerm, isSigner: false, isWritable: false });
        remainingKeys.push({ pubkey: validatorRegistryPda, isSigner: false, isWritable: false });

        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }));
        tx.add(new TransactionInstruction({
          programId: ANCHOR_PROGRAM_ID,
          keys: [
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: tableBuffer, isSigner: false, isWritable: true },
            { pubkey: tableRecord, isSigner: false, isWritable: true },
            { pubkey: tableMetadata, isSigner: false, isWritable: true },
            { pubkey: tablePubkey, isSigner: false, isWritable: true },
            { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ...remainingKeys,
          ],
          data: delegateTableData,
        }));
        tx.feePayer = authority.publicKey;
        tx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
        await sendAndConfirmTransaction(l1, tx, [authority], { commitment: 'confirmed' });
        console.log('  Table delegated → regional ER');
      } catch (e: any) {
        console.error(`  ❌ Table delegation FAILED: ${e.message?.slice(0, 100)}`);
        return NextResponse.json({ error: `Table delegation failed: ${e.message?.slice(0, 100)}` }, { status: 500 });
      }

      // Delegate DeckState PDA (one per table)
      const [deckStatePda] = getDeckStatePda(tablePubkey);
      await ensureDeckStatePermissionDelegated(l1, authority, tablePubkey);
      const dsRecord = delegationRecordPdaFromDelegatedAccount(deckStatePda);
      if (!(await l1.getAccountInfo(dsRecord))) {
        const dsBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(deckStatePda, ANCHOR_PROGRAM_ID);
        const dsMetadata = delegationMetadataPdaFromDelegatedAccount(deckStatePda);
        const delegateDSData = Buffer.alloc(8);
        DELEGATE_DECK_STATE_DISC.copy(delegateDSData, 0);

        try {
          const tx = new Transaction().add(new TransactionInstruction({
            programId: ANCHOR_PROGRAM_ID,
            keys: [
              { pubkey: authority.publicKey, isSigner: true, isWritable: true },
              { pubkey: dsBuffer, isSigner: false, isWritable: true },
              { pubkey: dsRecord, isSigner: false, isWritable: true },
              { pubkey: dsMetadata, isSigner: false, isWritable: true },
              { pubkey: deckStatePda, isSigner: false, isWritable: true },
              { pubkey: tablePubkey, isSigner: false, isWritable: false },
              { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
              { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
              { pubkey: getPermissionPda(deckStatePda)[0], isSigner: false, isWritable: false },
            ],
            data: delegateDSData,
          }));
          tx.feePayer = authority.publicKey;
          tx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
          await sendAndConfirmTransaction(l1, tx, [authority], { commitment: 'confirmed' });
          console.log('  DeckState delegated → regional ER');
        } catch (e: any) {
          console.error(`  ❌ DeckState delegation FAILED: ${e.message?.slice(0, 100)}`);
          return NextResponse.json({ error: `DeckState delegation failed: ${e.message?.slice(0, 100)}` }, { status: 500 });
        }
      }

      // Delegate seats and seat_cards for occupied seats
      for (const [seatIdx] of Array.from(allPlayerPubkeys.entries())) {
        const seatPda = getSeatPda(tablePubkey, seatIdx)[0];
        const seatRecord = delegationRecordPdaFromDelegatedAccount(seatPda);
        if (!(await l1.getAccountInfo(seatRecord))) {
          const seatBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seatPda, ANCHOR_PROGRAM_ID);
          const seatMetadata = delegationMetadataPdaFromDelegatedAccount(seatPda);
          const delegateSeatData = Buffer.alloc(9);
          DELEGATE_SEAT_DISC.copy(delegateSeatData, 0);
          delegateSeatData.writeUInt8(seatIdx, 8);

          try {
            const tx = new Transaction().add(new TransactionInstruction({
              programId: ANCHOR_PROGRAM_ID,
              keys: [
                { pubkey: authority.publicKey, isSigner: true, isWritable: true },
                { pubkey: seatBuffer, isSigner: false, isWritable: true },
                { pubkey: seatRecord, isSigner: false, isWritable: true },
                { pubkey: seatMetadata, isSigner: false, isWritable: true },
                { pubkey: seatPda, isSigner: false, isWritable: true },
                { pubkey: tablePubkey, isSigner: false, isWritable: false },
                { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
                { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
              ],
              data: delegateSeatData,
            }));
            tx.feePayer = authority.publicKey;
            tx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
            await sendAndConfirmTransaction(l1, tx, [authority], { commitment: 'confirmed' });
            console.log(`  Seat ${seatIdx} delegated → regional ER`);
          } catch (e: any) {
            console.error(`  ❌ Seat ${seatIdx} delegation FAILED: ${e.message?.slice(0, 100)}`);
            return NextResponse.json({ error: `Seat ${seatIdx} delegation failed: ${e.message?.slice(0, 100)}` }, { status: 500 });
          }
        }

        const seatCardsPda = getSeatCardsPda(tablePubkey, seatIdx)[0];
        const scRecord = delegationRecordPdaFromDelegatedAccount(seatCardsPda);
        if (!(await l1.getAccountInfo(scRecord))) {
          const scBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seatCardsPda, ANCHOR_PROGRAM_ID);
          const scMetadata = delegationMetadataPdaFromDelegatedAccount(seatCardsPda);
          const delegateSCData = Buffer.alloc(9);
          DELEGATE_SEAT_CARDS_DISC.copy(delegateSCData, 0);
          delegateSCData.writeUInt8(seatIdx, 8);

          try {
            const tx = new Transaction().add(new TransactionInstruction({
              programId: ANCHOR_PROGRAM_ID,
              keys: [
                { pubkey: authority.publicKey, isSigner: true, isWritable: true },
                { pubkey: scBuffer, isSigner: false, isWritable: true },
                { pubkey: scRecord, isSigner: false, isWritable: true },
                { pubkey: scMetadata, isSigner: false, isWritable: true },
                { pubkey: seatCardsPda, isSigner: false, isWritable: true },
                { pubkey: tablePubkey, isSigner: false, isWritable: false },
                { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
                { pubkey: permissionPdaFromAccount(seatCardsPda), isSigner: false, isWritable: false },
                { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
              ],
              data: delegateSCData,
            }));
            tx.feePayer = authority.publicKey;
            tx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
            await sendAndConfirmTransaction(l1, tx, [authority], { commitment: 'confirmed' });
            console.log(`  SeatCards ${seatIdx} delegated → regional ER`);
          } catch (e: any) {
            console.error(`  ❌ SeatCards ${seatIdx} delegation FAILED: ${e.message?.slice(0, 100)}`);
            return NextResponse.json({ error: `SeatCards ${seatIdx} delegation failed: ${e.message?.slice(0, 100)}` }, { status: 500 });
          }
        }

        console.log(`  SeatCards permission[${seatIdx}] kept on L1 for future occupant rebinds`);
      }

      // Delegate retained CrankTallyER compatibility slot.
      const [crankTallyErPda] = getCrankTallyErPda(tablePubkey);
      const ctRecord = delegationRecordPdaFromDelegatedAccount(crankTallyErPda);
      if (!(await l1.getAccountInfo(ctRecord))) {
        const ctBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(crankTallyErPda, ANCHOR_PROGRAM_ID);
        const ctMetadata = delegationMetadataPdaFromDelegatedAccount(crankTallyErPda);
        const delegateCTData = Buffer.alloc(40);
        DELEGATE_CRANK_TALLY_DISC.copy(delegateCTData, 0);
        tablePubkey.toBuffer().copy(delegateCTData, 8);

        try {
          const tx = new Transaction().add(new TransactionInstruction({
            programId: ANCHOR_PROGRAM_ID,
            keys: [
              { pubkey: authority.publicKey, isSigner: true, isWritable: true },
              { pubkey: ctBuffer, isSigner: false, isWritable: true },
              { pubkey: ctRecord, isSigner: false, isWritable: true },
              { pubkey: ctMetadata, isSigner: false, isWritable: true },
              { pubkey: crankTallyErPda, isSigner: false, isWritable: true },
              { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
              { pubkey: validatorRegistryPda, isSigner: false, isWritable: false },
            ],
            data: delegateCTData,
          }));
          tx.feePayer = authority.publicKey;
          tx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
          await sendAndConfirmTransaction(l1, tx, [authority], { commitment: 'confirmed' });
          console.log('  Compatibility CrankTallyER delegated -> regional ER');
        } catch (e: any) {
          console.warn(`  ⚠️ Compatibility CrankTallyER delegation failed (non-fatal): ${e.message?.slice(0, 80)}`);
        }
      } else {
        console.log('  Compatibility CrankTallyER already delegated');
      }

      // GUARD: Verify PUBLIC accounts are visible on TEE before proceeding to start_game.
      // NOTE: DeckState + SeatCards have PRIVATE permissions (members=[]) so getAccountInfo
      // always returns null on TEE even when absorbed. Only check table + seats (PUBLIC perms).
      console.log('  Verifying TEE propagation (public accounts only)...');
      const requiredOnTee = [
        { name: 'Table', pda: tablePubkey },
      ];
      for (const [seatIdx] of Array.from(allPlayerPubkeys.entries())) {
        requiredOnTee.push({ name: `Seat[${seatIdx}]`, pda: getSeatPda(tablePubkey, seatIdx)[0] });
      }

      const TEE_VERIFY_TIMEOUT_MS = 15_000;
      const TEE_VERIFY_POLL_MS = 2_000;
      const startWait = Date.now();
      let missingAccounts: string[] = [];
      while (Date.now() - startWait < TEE_VERIFY_TIMEOUT_MS) {
        missingAccounts = [];
        for (const { name, pda } of requiredOnTee) {
          try {
            const info = await er.getAccountInfo(pda);
            if (!info) missingAccounts.push(name);
          } catch { missingAccounts.push(name); }
        }
        if (missingAccounts.length === 0) {
          console.log(`  ✅ All ${requiredOnTee.length} accounts verified on TEE (${Date.now() - startWait}ms)`);
          break;
        }
        console.log(`  ⏳ Waiting for TEE propagation... missing: ${missingAccounts.join(', ')}`);
        await new Promise(r => setTimeout(r, TEE_VERIFY_POLL_MS));
      }

      if (missingAccounts.length > 0) {
        console.error(`  ❌ TEE propagation FAILED after ${TEE_VERIFY_TIMEOUT_MS}ms — missing: ${missingAccounts.join(', ')}`);
        return NextResponse.json({
          error: `TEE propagation timeout: ${missingAccounts.join(', ')} not visible on TEE after ${TEE_VERIFY_TIMEOUT_MS / 1000}s. Retry may help.`,
          missingOnTee: missingAccounts,
        }, { status: 503 });
      }
    }

    // NOTE: deckState has PRIVATE permission (members=[]) so getAccountInfo on TEE
    // always returns null even when absorbed. Zombie check removed — CG-CT3 guard
    // prevents delegation without all permissions, and L1 delegation record is sufficient.

    // ─── start_game on ER — pass ALL seat PDAs (pre-created architecture) ───
    console.log('Step 2: Starting game on ER...');
    const erTableInfo = await er.getAccountInfo(tablePubkey);
    const erPhase = erTableInfo ? erTableInfo.data[TABLE_OFFSETS.PHASE] : 0;

    let startSig = '';
    if (erPhase === 0 || erPhase === 7) {
      // Pass ALL seat PDAs + seat_cards PDAs for start_game (pre-created architecture).
      // Contract-level guard: deck_state + seat_cards required as writable.
      // On TEE, writable accounts that aren't delegated are rejected — prevents partial delegation.
      // start_game reads each seat's status and skips Empty (status=0) ones.
      const allSeatPdas: PublicKey[] = [];
      const allSeatCardsPdas: PublicKey[] = [];
      for (let i = 0; i < maxPlayers; i++) {
        allSeatPdas.push(getSeatPda(tablePubkey, i)[0]);
        allSeatCardsPdas.push(getSeatCardsPda(tablePubkey, i)[0]);
      }
      const whitelistWitnesses: PublicKey[] = [];
      if (isPrivateTable) {
        for (const player of allPlayerPubkeys.values()) {
          if (player.equals(PublicKey.default) || player.equals(tableCreator)) continue;
          whitelistWitnesses.push(getWhitelistPda(tablePubkey, player)[0]);
        }
      }
      const [deckStatePdaForStart] = getDeckStatePda(tablePubkey);

      console.log(`  Passing deck_state + ${maxPlayers} seat PDAs + ${maxPlayers} seat_cards PDAs + ${whitelistWitnesses.length} whitelist witnesses`);

      const startIx = new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: tablePubkey, isSigner: false, isWritable: true },
          { pubkey: deckStatePdaForStart, isSigner: false, isWritable: true },
          ...allSeatPdas.map(pda => ({ pubkey: pda, isSigner: false, isWritable: true })),
          ...whitelistWitnesses.map(pda => ({ pubkey: pda, isSigner: false, isWritable: false })),
          ...allSeatCardsPdas.map(pda => ({ pubkey: pda, isSigner: false, isWritable: true })),
        ],
        data: START_GAME_DISC,
      });
      const tx = new Transaction().add(startIx);
      tx.feePayer = authority.publicKey;
      // Use TEE's own blockhash (L1 blockhash causes "Blockhash not found" on TEE)
      tx.recentBlockhash = (await erWrite.getLatestBlockhash()).blockhash;
      tx.sign(authority);
      // TEE WS works, but using sendRawTransaction + polling for simplicity. Migration to confirmTransaction pending.
      startSig = await erWrite.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await waitForTeeSignature(erWrite, startSig, 'start_game');
      console.log('  Game started on ER:', startSig.slice(0, 20));
    } else if (erPhase === 1) {
      console.log('  Game already in Starting phase; resuming tee_deal');
    } else {
      console.log('  Game already in progress (phase:', erPhase, ')');
      return NextResponse.json({ error: `Hand in progress (phase=${erPhase})` }, { status: 400 });
    }

    // ─── TEE deal — pure TEE entropy, no VRF oracle ───
    console.log('Step 3: TEE deal (pure TEE entropy)...');
    let dealSig = '';
    try {
      const startingTableInfo = await er.getAccountInfo(tablePubkey);
      if (!startingTableInfo) {
        throw new Error('Table missing on ER before tee_deal');
      }
      const startingTableData = startingTableInfo.data as Buffer;
      const seatsOccupied = startingTableData.readUInt16LE(TABLE_OFFSETS.SEATS_OCCUPIED);
      const seatsFolded = startingTableData.readUInt16LE(254);
      const dealMask = seatsOccupied & ~seatsFolded;

      const dealSeatIndices: number[] = [];
      for (let i = 0; i < maxPlayers; i++) {
        if (dealMask & (1 << i)) dealSeatIndices.push(i);
      }

      if (dealSeatIndices.length < 2) {
        throw new Error(`tee_deal requires 2+ active seats (mask=${dealMask})`);
      }

      // 1 byte per player (seat_index); contract reads wallet from seat PDA in remaining_accounts
      const playerInfoBufs: Buffer[] = [];
      const remainingKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
      for (const seatIdx of dealSeatIndices) {
        playerInfoBufs.push(Buffer.from([seatIdx]));
        const seatCardsPda = getSeatCardsPda(tablePubkey, seatIdx)[0];
        remainingKeys.push({ pubkey: seatCardsPda, isSigner: false, isWritable: true });
      }
      // Seat PDAs for wallet read (must follow seatCards in remaining_accounts)
      for (const seatIdx of dealSeatIndices) {
        const seatPda = getSeatPda(tablePubkey, seatIdx)[0];
        remainingKeys.push({ pubkey: seatPda, isSigner: false, isWritable: false });
      }
      const [globalEntropyPda] = getGlobalEntropyPda();
      remainingKeys.push({ pubkey: globalEntropyPda, isSigner: false, isWritable: true });
      const [handReportBufferPda] = getHandReportBufferPda(tablePubkey);
      const handReportInfo = await er.getAccountInfo(handReportBufferPda).catch(() => null);
      if (handReportInfo) {
        if (handReportNeedsFlush(Buffer.from(handReportInfo.data))) {
          return NextResponse.json({
            error: 'Previous hand report is finalized and must be flushed before dealing the next hand. The crank will retry this table.',
          }, { status: 409 });
        }
        remainingKeys.push({ pubkey: handReportBufferPda, isSigner: false, isWritable: true });
      } else {
        console.warn('  HandReportBuffer not visible on TEE; first deal event will not be buffered');
      }

      const TEE_DEAL_DISC = IX_DISC.teeDeal;
      const vecLen = Buffer.alloc(4);
      vecLen.writeUInt32LE(playerInfoBufs.length, 0);
      const crankEntropy = Keypair.generate().publicKey.toBuffer();
      const teeDealData = Buffer.concat([TEE_DEAL_DISC, vecLen, ...playerInfoBufs, crankEntropy]);

      const [deckStatePda] = getDeckStatePda(tablePubkey);
      const teeDealIx = new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: authority.publicKey, isSigner: false, isWritable: false },
          { pubkey: tablePubkey, isSigner: false, isWritable: true },
          { pubkey: deckStatePda, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
          ...remainingKeys,
        ],
        data: teeDealData,
      });

      console.log(`  Dealing to ${dealSeatIndices.length} seats: [${dealSeatIndices.join(', ')}]`);
      const dealTx = new Transaction().add(teeDealIx);
      dealTx.feePayer = authority.publicKey;
      // Use TEE's own blockhash (L1 blockhash causes "Blockhash not found" on TEE)
      dealTx.recentBlockhash = (await erWrite.getLatestBlockhash()).blockhash;
      dealTx.sign(authority);
      // TEE WS works, but using sendRawTransaction + polling for simplicity. Migration to confirmTransaction pending.
      dealSig = await erWrite.sendRawTransaction(dealTx.serialize(), { skipPreflight: true });
      await waitForTeeSignature(erWrite, dealSig, 'tee_deal');
      console.log('  TEE deal confirmed:', dealSig.slice(0, 20));
    } catch (dealErr: any) {
      console.log('  TEE deal error:', dealErr.message?.slice(0, 120));
      return NextResponse.json({ error: dealErr.message || 'TEE deal failed', startSig: startSig || 'already started' }, { status: 502 });
    }

    console.log('=== Cash Game Ready Complete! ===');

    return NextResponse.json({
      success: true,
      delegated: true,
      started: !!startSig,
      startSig: startSig || 'already started',
      dealSig: dealSig || 'pending (crank will retry)',
      activePlayers: activeSeatIndices.length,
    });
  } catch (e: any) {
    console.error('Cash game ready failed:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
