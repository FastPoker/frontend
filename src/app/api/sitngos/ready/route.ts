import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlockhashViaIndexer } from '@/lib/indexer-client';
import { Connection, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction, PublicKey, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { DELEGATION_PROGRAM_ID, delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationRecordPdaFromDelegatedAccount, delegationMetadataPdaFromDelegatedAccount, permissionPdaFromAccount } from '@magicblock-labs/ephemeral-rollups-sdk';
import { getSeatPda, getSeatCardsPda, getDeckStatePda, getGlobalEntropyPda, buildCreateTablePermission, buildCreateDeckStatePermission, buildCreateSeatPermission, buildUpdateSeatPermissionTeeInstruction, getPermissionPda, getSlimBufferPda, getValidatorRegistryPda, buildDelegateSlimBufferInstruction, buildUpdateDeckStatePermission, buildDelegateDeckStatePermission } from '@/lib/onchain-game';
import { ANCHOR_PROGRAM_ID, PERMISSION_PROGRAM_ID, TABLE_OFFSETS, TEE_VALIDATOR } from '@/lib/constants';
import { getTeeConnection } from '@/lib/tee-auth-server';
import { getL1Rpc } from '@/lib/rpc-config';
import { IX_DISC } from '@/lib/discriminators';
import { loadRequiredServerKeypair } from '@/lib/server-runtime-keys';

const DELEGATE_TABLE_DISC = IX_DISC.delegateTable;
const DELEGATE_SEAT_DISC = IX_DISC.delegateSeat;
const DELEGATE_SEAT_CARDS_DISC = IX_DISC.delegateSeatCards;
const DELEGATE_DECK_STATE_DISC = IX_DISC.delegateDeckState;

let authorityKeypair: Keypair | null = null;
function getAuthority(): Keypair {
  if (authorityKeypair) return authorityKeypair;
  authorityKeypair = loadRequiredServerKeypair('AUTHORITY_KEYPAIR_PATH');
  return authorityKeypair;
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

// Called after all players have joined on-chain
// Flow: delegate all accounts → FnE6 (TEE) → start_game → tee_deal
// Cards NEVER visible on L1! Permissionless — any crank can call.
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

    console.log(`=== SECURE TEE Ready Flow for ${tablePda} ===`);

    // Check if already delegated
    const tableRecord = delegationRecordPdaFromDelegatedAccount(tablePubkey);
    const tableRecordInfo = await l1.getAccountInfo(tableRecord);
    const alreadyDelegated = !!tableRecordInfo;
    
    const readConn = alreadyDelegated ? er : l1;
    console.log(`Reading from: ${alreadyDelegated ? 'ER (already delegated)' : 'L1'}`);

    const tableInfo = await readConn.getAccountInfo(tablePubkey);
    if (!tableInfo) {
      return NextResponse.json({ error: 'Table not found' }, { status: 404 });
    }
    const tableId = Buffer.from(tableInfo.data.slice(8, 40));
    const playerCount = Number(tableInfo.data[TABLE_OFFSETS.MAX_PLAYERS]);
    const currentPlayers = Number(tableInfo.data[TABLE_OFFSETS.CURRENT_PLAYERS]);

    if (currentPlayers !== playerCount) {
      return NextResponse.json({
        error: `Table not full yet: ${currentPlayers}/${playerCount} seated`,
      }, { status: 400 });
    }

    // 1. Verify all seats are occupied and get player pubkeys
    console.log('Step 1: Verifying all players joined...');
    const playerPubkeys: PublicKey[] = [];
    for (let i = 0; i < playerCount; i++) {
      const seatPda = getSeatPda(tablePubkey, i)[0];
      const seatInfo = await readConn.getAccountInfo(seatPda);
      if (!seatInfo) {
        return NextResponse.json({ error: `Seat ${i} not found - player hasn't joined yet` }, { status: 400 });
      }
      const playerPubkey = new PublicKey(seatInfo.data.slice(8, 40));
      if (playerPubkey.equals(PublicKey.default)) {
        return NextResponse.json({ error: `Seat ${i} is empty - waiting for player` }, { status: 400 });
      }
      playerPubkeys.push(playerPubkey);
      console.log(`  Seat ${i}: ${playerPubkey.toBase58().slice(0, 8)}...`);
    }

    // 2. PRE-FLIGHT: Verify all required PDAs exist on L1 before delegation
    if (!alreadyDelegated) {
      console.log('Step 2: Pre-flight — verifying DeckState + SeatCards + Permission PDAs on L1...');

      // Check DeckState PDA exists
      const [deckStatePdaCheck] = getDeckStatePda(tablePubkey);
      const deckStateInfo = await l1.getAccountInfo(deckStatePdaCheck);
      if (!deckStateInfo) {
        return NextResponse.json({
          error: 'DeckState PDA missing on L1. Table must be created with init_table_seat (new contract). Please close and recreate.',
        }, { status: 400 });
      }

      // Check SeatCards + Permission PDAs exist for each seat
      for (let i = 0; i < playerCount; i++) {
        const seatCardsPda = getSeatCardsPda(tablePubkey, i)[0];
        const seatCardsInfo = await l1.getAccountInfo(seatCardsPda);
        if (!seatCardsInfo) {
          return NextResponse.json({
            error: `SeatCards PDA missing for seat ${i}. Table must be created with init_table_seat. Please close and recreate.`,
          }, { status: 400 });
        }

        const permPda = permissionPdaFromAccount(seatCardsPda);
        const permInfo = await l1.getAccountInfo(permPda);
        if (!permInfo) {
          return NextResponse.json({
            error: `Permission PDA missing for seat ${i}. Table must be created with init_table_seat (new contract). Please close and recreate.`,
          }, { status: 400 });
        }
      }
      console.log('  ✅ All required PDAs verified on L1');
    }

    // 2.5. Create + delegate public permissions for table/deckState/seats (TEE requires for getAccountInfo)
    if (!alreadyDelegated) {
      console.log('Step 2.5: Creating public permissions on L1...');
      
      // Create table + deckState + seat permissions (idempotent — skip if already exist)
      // Batch to stay within TX size limits (max ~6 permission creates per TX)
      const [tablePermPda] = getPermissionPda(tablePubkey);
      if (!(await l1.getAccountInfo(tablePermPda))) {
        const BATCH = 4;
        // First TX: table + deckState + up to BATCH seats
        const tx1 = new Transaction();
        tx1.add(buildCreateTablePermission(authority.publicKey, tablePubkey));
        tx1.add(buildCreateDeckStatePermission(authority.publicKey, tablePubkey));
        for (let i = 0; i < Math.min(BATCH, playerCount); i++) {
          tx1.add(buildCreateSeatPermission(authority.publicKey, tablePubkey, i));
        }
        tx1.feePayer = authority.publicKey;
        tx1.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
        await sendAndConfirmTransaction(l1, tx1, [authority], { commitment: 'confirmed' });
        // Remaining seats in batches
        for (let batch = BATCH; batch < playerCount; batch += BATCH) {
          const end = Math.min(batch + BATCH, playerCount);
          const tx = new Transaction();
          for (let i = batch; i < end; i++) {
            tx.add(buildCreateSeatPermission(authority.publicKey, tablePubkey, i));
          }
          tx.feePayer = authority.publicKey;
          tx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
          await sendAndConfirmTransaction(l1, tx, [authority], { commitment: 'confirmed' });
        }
        console.log('  ✅ Public permissions created (table + deckState + seats)');
      } else {
        console.log('  Public permissions already exist');
      }

      console.log('Step 2.6: Public permission PDAs stay on L1');
    }

    // 3. Update SeatCards permissions on L1, then delegate table + seats + seat_cards + deck_state to ER
    console.log('Step 3: Delegating to Ephemeral Rollup...');

    if (!alreadyDelegated) {
      console.log('Step 3.0: Updating SeatCards permissions on L1...');
      for (let i = 0; i < playerCount; i++) {
        const tx = new Transaction().add(
          buildUpdateSeatPermissionTeeInstruction(authority.publicKey, tablePubkey, i),
        );
        tx.feePayer = authority.publicKey;
        tx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
        await sendAndConfirmTransaction(l1, tx, [authority], { commitment: 'confirmed' });
        console.log(`  SeatCards[${i}] permission updated on L1`);
      }

      // Delegate SlimBuffer before the table. delegate_table enforces this PDA
      // at remaining_accounts[1] so the hand-report hash anchor is present.
      const slimRecord = delegationRecordPdaFromDelegatedAccount(slimBufferPda);
      if (!(await l1.getAccountInfo(slimRecord))) {
        const slimDelegBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(slimBufferPda, ANCHOR_PROGRAM_ID);
        const slimMetadata = delegationMetadataPdaFromDelegatedAccount(slimBufferPda);
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
        console.log('  SlimBuffer delegated');
      } else {
        console.log('  SlimBuffer already delegated');
      }
    }
    
    if (!tableRecordInfo) {
      const tableBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(tablePubkey, ANCHOR_PROGRAM_ID);
      const tableMetadata = delegationMetadataPdaFromDelegatedAccount(tablePubkey);
      
      const delegateTableData = Buffer.alloc(40);
      DELEGATE_TABLE_DISC.copy(delegateTableData, 0);
      tableId.copy(delegateTableData, 8);
      
      // SNG delegation guard: remaining_accounts = [TEE_VALIDATOR, slimBuffer, deckState, seatCards0..N, ValidatorRegistry]
      // Contract verifies slimBuffer, deckState + seatCards are already delegated (owner == Delegation Program).
      const remainingKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
      remainingKeys.push({ pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false });
      remainingKeys.push({ pubkey: slimBufferPda, isSigner: false, isWritable: false });
      const maxPlayers = tableInfo!.data[121]; // TABLE_OFFSETS.MAX_PLAYERS
      const [dsPdaForGuard] = getDeckStatePda(tablePubkey);
      remainingKeys.push({ pubkey: dsPdaForGuard, isSigner: false, isWritable: false });
      for (let i = 0; i < maxPlayers; i++) {
        remainingKeys.push({ pubkey: getSeatCardsPda(tablePubkey, i)[0], isSigner: false, isWritable: false });
      }
      remainingKeys.push({ pubkey: validatorRegistryPda, isSigner: false, isWritable: false });

      const delegateTableIx = new TransactionInstruction({
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
      });
      
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }));
      tx.add(delegateTableIx);
      tx.feePayer = authority.publicKey;
      tx.recentBlockhash = (await getLatestBlockhashViaIndexer(l1)).blockhash;
      await sendAndConfirmTransaction(l1, tx, [authority], { commitment: 'confirmed' });
      console.log('  Table delegated');
    } else {
      console.log('  Table already delegated');
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
        console.log('  DeckState delegated');
      } catch (e: any) {
        console.error(`  ❌ DeckState delegation FAILED: ${e.message?.slice(0, 100)}`);
        return NextResponse.json({ error: `DeckState delegation failed: ${e.message?.slice(0, 100)}` }, { status: 500 });
      }
    }

    // Delegate seats and seat_cards
    // GUARD: All delegations wrapped in try/catch — partial failure must not leave zombie tables
    const delegationFailures: string[] = [];
    for (let i = 0; i < playerCount; i++) {
      // Delegate seat
      const seatPda = getSeatPda(tablePubkey, i)[0];
      const seatRecord = delegationRecordPdaFromDelegatedAccount(seatPda);
      if (!(await l1.getAccountInfo(seatRecord))) {
        const seatBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seatPda, ANCHOR_PROGRAM_ID);
        const seatMetadata = delegationMetadataPdaFromDelegatedAccount(seatPda);
        
        const delegateSeatData = Buffer.alloc(9);
        DELEGATE_SEAT_DISC.copy(delegateSeatData, 0);
        delegateSeatData.writeUInt8(i, 8);
        
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
          console.log(`  Seat ${i} delegated`);
        } catch (e: any) {
          console.error(`  ❌ Seat ${i} delegation FAILED: ${e.message?.slice(0, 100)}`);
          delegationFailures.push(`Seat[${i}]`);
        }
      }

      // Delegate seat_cards
      const seatCardsPda = getSeatCardsPda(tablePubkey, i)[0];
      const scRecord = delegationRecordPdaFromDelegatedAccount(seatCardsPda);
      if (!(await l1.getAccountInfo(scRecord))) {
        const scBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seatCardsPda, ANCHOR_PROGRAM_ID);
        const scMetadata = delegationMetadataPdaFromDelegatedAccount(seatCardsPda);
        
        const delegateSCData = Buffer.alloc(9);
        DELEGATE_SEAT_CARDS_DISC.copy(delegateSCData, 0);
        delegateSCData.writeUInt8(i, 8);
        
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
          console.log(`  SeatCards ${i} delegated`);
        } catch (e: any) {
          console.error(`  ❌ SeatCards ${i} delegation FAILED: ${e.message?.slice(0, 100)}`);
          delegationFailures.push(`SeatCards[${i}]`);
        }
      }
    }

    // GUARD: If any delegation failed, return error immediately — don't proceed to start_game
    if (delegationFailures.length > 0) {
      return NextResponse.json({
        error: `Delegation failed for: ${delegationFailures.join(', ')}. Table is partially delegated. Retry or admin-close.`,
        partiallyDelegated: true,
        failedAccounts: delegationFailures,
      }, { status: 500 });
    }

    // GUARD: Verify accounts are on TEE before proceeding to start_game.
    // PUBLIC accounts (table, seats) — verify via TEE getAccountInfo.
    // PRIVATE accounts (deckState, seatCards) — verify via L1 delegation record
    // (getAccountInfo returns null for private PDA self-member accounts, even when absorbed).
    console.log('Step 3.5: Verifying TEE propagation...');
    const publicOnTee = [
      { name: 'Table', pda: tablePubkey },
    ];
    for (let i = 0; i < playerCount; i++) {
      publicOnTee.push({ name: `Seat[${i}]`, pda: getSeatPda(tablePubkey, i)[0] });
    }
    const privateOnTee = [
      { name: 'DeckState', pda: getDeckStatePda(tablePubkey)[0] },
    ];
    for (let i = 0; i < playerCount; i++) {
      privateOnTee.push({ name: `SeatCards[${i}]`, pda: getSeatCardsPda(tablePubkey, i)[0] });
    }

    // Verify private accounts via L1 delegation records (owner = Delegation Program)
    for (const { name, pda } of privateOnTee) {
      const info = await l1.getAccountInfo(pda);
      if (!info || !info.owner.equals(DELEGATION_PROGRAM_ID)) {
        return NextResponse.json({
          error: `${name} not delegated on L1 (expected owner=DelegationProgram). Account may not be on TEE.`,
        }, { status: 503 });
      }
    }
    console.log(`  ✅ ${privateOnTee.length} private accounts verified delegated (L1 records)`);

    // Verify public accounts via TEE getAccountInfo
    const TEE_VERIFY_TIMEOUT_MS = 15_000;
    const TEE_VERIFY_POLL_MS = 2_000;
    const startWait = Date.now();
    let missingAccounts: string[] = [];
    while (Date.now() - startWait < TEE_VERIFY_TIMEOUT_MS) {
      missingAccounts = [];
      for (const { name, pda } of publicOnTee) {
        try {
          const info = await er.getAccountInfo(pda);
          if (!info) missingAccounts.push(name);
        } catch { missingAccounts.push(name); }
      }
      if (missingAccounts.length === 0) {
        console.log(`  ✅ ${publicOnTee.length} public accounts verified on TEE (${Date.now() - startWait}ms)`);
        break;
      }
      console.log(`  ⏳ Waiting for TEE propagation... missing: ${missingAccounts.join(', ')}`);
      await new Promise(r => setTimeout(r, TEE_VERIFY_POLL_MS));
    }

    if (missingAccounts.length > 0) {
      console.error(`  ❌ TEE propagation FAILED after ${TEE_VERIFY_TIMEOUT_MS}ms — missing: ${missingAccounts.join(', ')}`);
      return NextResponse.json({
        error: `TEE propagation timeout: ${missingAccounts.join(', ')} not visible on TEE after ${TEE_VERIFY_TIMEOUT_MS / 1000}s. Delegation succeeded on L1 but TEE did not pick up accounts. Retry may help.`,
        missingOnTee: missingAccounts,
      }, { status: 503 });
    }

    // 4. Start game on ER
    // CRITICAL: Use ephemeral keypair for ALL TEE transactions.
    // Persistent keypairs (deployer) in instruction keys cause stale cache on TEE → 500 errors.
    // start_game and tee_deal are permissionless — no authority required.
    const teePayer = Keypair.generate();
    console.log('Step 4: Starting game on ER (ephemeral:', teePayer.publicKey.toBase58().slice(0, 8) + '...)...');
    const erTableInfo = await er.getAccountInfo(tablePubkey);
    const erPhase = erTableInfo ? erTableInfo.data[160] : 0;
    
    let startSig = '';
    if (erPhase === 0) {
      // Pass 2N format only (seats + seat_cards).
      // Pool matches seat players via seat_from_pool before this ready path.
      // Avoiding 3N+1 prevents Permission Program CPI dependency on TEE.
      const START_GAME_DISC = IX_DISC.startGame;
      const [deckStatePdaForStart] = getDeckStatePda(tablePubkey);
      const seatPdas: PublicKey[] = [];
      const seatCardsPdasForStart: PublicKey[] = [];
      for (let i = 0; i < playerCount; i++) {
        seatPdas.push(getSeatPda(tablePubkey, i)[0]);
        seatCardsPdasForStart.push(getSeatCardsPda(tablePubkey, i)[0]);
      }
      const startIx = new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: teePayer.publicKey, isSigner: true, isWritable: false },
          { pubkey: tablePubkey, isSigner: false, isWritable: true },
          { pubkey: deckStatePdaForStart, isSigner: false, isWritable: true },
          ...seatPdas.map(pda => ({ pubkey: pda, isSigner: false, isWritable: true })),
          ...seatCardsPdasForStart.map(pda => ({ pubkey: pda, isSigner: false, isWritable: true })),
        ],
        data: START_GAME_DISC,
      });
      const tx = new Transaction().add(startIx);
      tx.feePayer = teePayer.publicKey;
      // Use TEE's own blockhash (L1 blockhash causes "Blockhash not found" on TEE)
      tx.recentBlockhash = (await erWrite.getLatestBlockhash()).blockhash;
      tx.sign(teePayer);
      // TEE WS works, but using sendRawTransaction + polling for simplicity. Migration to confirmTransaction pending.
      startSig = await erWrite.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      let startConfirmed = false;
      for (let p = 0; p < 15; p++) {
        await new Promise(r => setTimeout(r, 1000));
        const statuses = await erWrite.getSignatureStatuses([startSig]);
        const status = statuses?.value?.[0];
        if (status?.err) {
          throw new Error(`start_game failed on TEE: ${JSON.stringify(status.err)}`);
        }
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
          startConfirmed = true;
          break;
        }
      }
      if (!startConfirmed) {
        throw new Error(`start_game not confirmed on TEE within timeout: ${startSig}`);
      }
      console.log('  Game started on ER:', startSig.slice(0, 20));
    } else {
      console.log('  Game already started (phase:', erPhase, ')');
    }

    // NOTE: Step 4b (post_game_blinds) removed — start_game with seats in
    // remaining_accounts already posts blinds inline. Having both caused double-posting.

    // 5. TEE Deal — pure TEE entropy, no VRF oracle
    console.log('Step 5: TEE deal (pure TEE entropy)...');
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
      for (let i = 0; i < playerCount; i++) {
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

      const TEE_DEAL_DISC = IX_DISC.teeDeal;
      const vecLen = Buffer.alloc(4);
      vecLen.writeUInt32LE(playerInfoBufs.length, 0);
      const teeDealData = Buffer.concat([TEE_DEAL_DISC, vecLen, ...playerInfoBufs]);

      const [deckStatePda] = getDeckStatePda(tablePubkey);
      const teeDealIx = new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: teePayer.publicKey, isSigner: true, isWritable: false },
          { pubkey: tablePubkey, isSigner: false, isWritable: true },
          { pubkey: deckStatePda, isSigner: false, isWritable: true },
          ...remainingKeys,
        ],
        data: teeDealData,
      });

      console.log(`  Dealing to ${dealSeatIndices.length} seats: [${dealSeatIndices.join(', ')}]`);
      const dealTx = new Transaction().add(teeDealIx);
      dealTx.feePayer = teePayer.publicKey;
      // Use TEE's own blockhash (L1 blockhash causes "Blockhash not found" on TEE)
      dealTx.recentBlockhash = (await erWrite.getLatestBlockhash()).blockhash;
      dealTx.sign(teePayer);
      // TEE WS works, but using sendRawTransaction + polling for simplicity. Migration to confirmTransaction pending.
      dealSig = await erWrite.sendRawTransaction(dealTx.serialize(), { skipPreflight: true });
      for (let p = 0; p < 15; p++) {
        await new Promise(r => setTimeout(r, 1000));
        const statuses = await erWrite.getSignatureStatuses([dealSig]);
        if (statuses?.value?.[0]?.confirmationStatus === 'confirmed' || statuses?.value?.[0]?.confirmationStatus === 'finalized') break;
      }
      console.log('  TEE deal confirmed:', dealSig.slice(0, 20));
    } catch (dealErr: any) {
      console.log('  TEE deal error:', dealErr.message?.slice(0, 120));
    }

    console.log('=== TEE Ready Complete! ===');
    console.log('  Cards dealt on regional ER');

    return NextResponse.json({ 
      success: true,
      delegated: true,
      started: erPhase > 0 || !!startSig,
      startSig: startSig || 'already started',
      dealSig: dealSig || 'pending (crank will retry)',
      message: 'Game ready on regional ER!'
    });
  } catch (e: any) {
    console.error('Ready flow failed:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
