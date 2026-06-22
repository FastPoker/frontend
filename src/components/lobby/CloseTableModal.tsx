'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { useGameAuth } from '@/hooks/useGameAuth';
import { AccountMeta, Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import type { AccountInfo } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { toast } from 'sonner';
import { buildWalletApiAuth } from '@/lib/wallet-api-auth';

import { L1_RPC, L1_WS_RPC, TEE_RPC_URL, ANCHOR_PROGRAM_ID, PERMISSION_PROGRAM_ID, POOL_PDA, TREASURY } from '@/lib/constants';
import { DELEGATION_PROGRAM_ID } from '@/lib/validator-registry';
import { applyPriorityFee } from '@/lib/priority-fee';
import { accountDisc } from '@/lib/discriminators';
import {
  getSeatPda,
  getSeatCardsPda,
  getDeckStatePda,
  getSlimBufferPda,
  getCrankTallyErPda,
  getCrankTallyL1Pda,
  getDepositProofPda,
  getVaultPda,
  getTipJarPda,
  getReceiptPda,
  getHandReportBufferPda,
  getHandReportFlushStatePda,
  getCrankRewardStatePda,
  getOperatorRewardTotalErPda,
  getOperatorRewardTotalL1Pda,
  getOperatorClaimPda,
  getSplRewardPoolPda,
  getPermissionPda,
  buildCommitAndUndelegateInstruction,
  buildCommitStateInstruction,
  buildResizeVaultInstruction,
  buildSettleTableRewardsInstruction,
  buildInitCrankRewardStateInstruction,
  buildInitOperatorRewardTotalInstruction,
  buildInitOperatorClaimInstruction,
  buildUpdateOpClaimWeightInstruction,
  buildUpdateAccRewardPerWeightInstruction,
  buildClaimOperatorRewardsInstruction,
  buildClaimOperatorTokenRewardsInstruction,
  buildCloseTableInstruction,
  buildCleanupTableAccountsInstruction,
  buildCleanupTablePermissionsInstructions,
} from '@/lib/onchain-game';
import type { CreatorTable } from './Lobby';

type StepStatus = 'pending' | 'active' | 'done' | 'error';

interface Step {
  key: string;
  label: string;
  status: StepStatus;
}

const INITIAL_STEPS: Step[] = [
  { key: 'scan', label: 'Verify table state', status: 'pending' },
  { key: 'refund-proofs', label: 'Refund pending joins', status: 'pending' },
  { key: 'lock', label: 'Lock delegated table', status: 'pending' },
  { key: 'rake', label: 'Process pending rake', status: 'pending' },
  { key: 'undelegate', label: 'Return delegated accounts', status: 'pending' },
  { key: 'return-table', label: 'Return table to L1', status: 'pending' },
  { key: 'cleanup', label: 'Clean rent accounts', status: 'pending' },
  { key: 'close', label: 'Close table and refund rent', status: 'pending' },
];

const UNDELEGATE_CHUNK_SIZE = 4;
const CLOSE_CLEANUP_CHUNK_SIZE = 8;
const CASH_CLOSE_IDLE_SECONDS = 24 * 60 * 60;
const ZERO_MINT = PublicKey.default.toBase58();
const CRANK_ACTION_DISC = accountDisc('CrankAction');
const TABLE_OFF = {
  CURRENT_PLAYERS: 122,
  LAST_ACTION_SLOT: 166,
  SEATS_OCCUPIED: 250,
  RAKE_ACCUMULATED: 147,
  PHASE: 160,
  TOKEN_ESCROW: 258,
  CREATOR: 290,
  UNCLAIMED_BALANCE_COUNT: 340,
  TOKEN_MINT: 385,
  CRANK_POOL_ACCUMULATED: 427,
} as const;
const VAULT_OFF = {
  TOTAL_RAKE_DISTRIBUTED: 65,
  TOTAL_CRANK_DISTRIBUTED: 105,
} as const;

type RakePrepResult = {
  rakeDelta: number;
  dealerDelta: number;
  txCount: number;
};

type RentRefundEstimate = {
  loading: boolean;
  totalLamports: number;
  tableRentLamports: number;
  permissionLamports: number;
  splEscrowLamports: number;
  playerSeatLamports: number;
  accountCount: number;
  permissionCount: number;
  error?: string;
};

const LAMPORTS_PER_SOL = 1_000_000_000;

function isDelegatedAccount(info: { owner: PublicKey; lamports: number } | null): boolean {
  return !!info && info.lamports > 0 && info.owner.equals(DELEGATION_PROGRAM_ID);
}

function isClosableProgramAccount(info: AccountInfo<Buffer> | null): info is AccountInfo<Buffer> {
  return !!info
    && info.lamports > 0
    && (info.owner.equals(ANCHOR_PROGRAM_ID) || info.owner.equals(DELEGATION_PROGRAM_ID));
}

function isClosablePermissionAccount(info: AccountInfo<Buffer> | null): info is AccountInfo<Buffer> {
  return !!info
    && info.lamports > 0
    && (info.owner.equals(PERMISSION_PROGRAM_ID) || info.owner.equals(DELEGATION_PROGRAM_ID));
}

function depositProofNeedsCloseCleanup(info: AccountInfo<Buffer> | null): boolean {
  if (!info || info.lamports === 0) return false;
  if (info.owner.equals(DELEGATION_PROGRAM_ID)) return true;
  if (!info.owner.equals(ANCHOR_PROGRAM_ID) || info.data.length < 90) return false;
  const depositor = new PublicKey(info.data.subarray(41, 73));
  const buyIn = info.data.readBigUInt64LE(73);
  const reserve = info.data.readBigUInt64LE(81);
  const consumed = info.data[89] === 1;
  const empty = depositor.equals(PublicKey.default) && buyIn === BigInt(0) && reserve === BigInt(0);
  return !consumed && !empty;
}

function formatSol(lamports: number): string {
  const sol = lamports / LAMPORTS_PER_SOL;
  if (sol >= 1) return sol.toFixed(4);
  if (sol >= 0.01) return sol.toFixed(5);
  return sol.toFixed(6);
}

function makeL1Connection(): Connection {
  return new Connection(
    L1_RPC,
    L1_WS_RPC ? { commitment: 'confirmed', wsEndpoint: L1_WS_RPC } : 'confirmed',
  );
}

function uniquePublicKeys(keys: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const key of keys) {
    const id = key.toBase58();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readU64(data: Buffer, offset: number): number {
  return data.length >= offset + 8 ? Number(data.readBigUInt64LE(offset)) : 0;
}

function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function secondsUntilCashClose(lastActionSlot?: number, nowUnix = Math.floor(Date.now() / 1000)): number {
  if (!lastActionSlot) return 0;
  return Math.max(0, CASH_CLOSE_IDLE_SECONDS - (nowUnix - lastActionSlot));
}

function closeTooSoonMessage(label: string, lastActionSlot?: number, nowUnix?: number): string {
  const remaining = secondsUntilCashClose(lastActionSlot, nowUnix);
  const retry = remaining > 0
    ? ` Try again in ${formatRemaining(remaining)}.`
    : ' Refresh the table state and try again shortly.';
  return `${label} failed: this table must be empty for 24 hours before close.${retry}`;
}

function isCloseTooSoonText(text: string): boolean {
  return text.includes('TableCloseTooSoon')
    || text.includes('"Custom":6094')
    || text.includes('custom program error: 0x17ce');
}

async function getConnectionUnixTime(connection: Connection): Promise<number> {
  try {
    const slot = await connection.getSlot('confirmed');
    const blockTime = await connection.getBlockTime(slot);
    if (typeof blockTime === 'number') return blockTime;
  } catch {}
  return Math.floor(Date.now() / 1000);
}

function readTableLastActionSlot(data: Buffer): number {
  return readU64(data, TABLE_OFF.LAST_ACTION_SLOT);
}

function assertCashCloseReadyFromData(data: Buffer, nowUnix?: number): void {
  const currentPlayers = data[TABLE_OFF.CURRENT_PLAYERS] ?? 0;
  const phase = data[TABLE_OFF.PHASE] ?? 255;
  const seatsOccupied = data.length >= TABLE_OFF.SEATS_OCCUPIED + 2
    ? data.readUInt16LE(TABLE_OFF.SEATS_OCCUPIED)
    : 0;
  const unclaimed = data[TABLE_OFF.UNCLAIMED_BALANCE_COUNT] ?? 0;
  const lastActionSlot = readTableLastActionSlot(data);
  const remaining = secondsUntilCashClose(lastActionSlot, nowUnix);

  if (currentPlayers !== 0) {
    throw new Error(`Table cannot close yet: ${currentPlayers} player${currentPlayers === 1 ? '' : 's'} still seated.`);
  }
  if (phase !== 0 && phase !== 7) {
    throw new Error('Table cannot close yet: wait for Waiting or Complete phase.');
  }
  if (seatsOccupied !== 0) {
    throw new Error('Table cannot close yet: one or more seat accounts are still occupied.');
  }
  if (unclaimed !== 0) {
    throw new Error('Table cannot close yet: players still have unclaimed balances.');
  }
  if (remaining > 0) {
    throw new Error(closeTooSoonMessage('Close readiness check', lastActionSlot, nowUnix));
  }
}

async function sendInstructionBundle(
  sendOne: (tx: Transaction, connection: Connection, label: string, opts?: { skipPreflight?: boolean; teeBlockhash?: boolean }) => Promise<string>,
  connection: Connection,
  ixs: TransactionInstruction[],
  label: string,
  opts?: { skipPreflight?: boolean; teeBlockhash?: boolean },
): Promise<string | null> {
  if (ixs.length === 0) return null;
  await sendOne(new Transaction().add(...ixs), connection, label, opts);
  return label;
}

async function scanOperatorsForTable(
  connection: Connection,
  tablePda: PublicKey,
): Promise<{ operator: PublicKey; er: number; l1: number }[]> {
  const filters = [
    { memcmp: { offset: 0, bytes: Buffer.from(CRANK_ACTION_DISC).toString('base64'), encoding: 'base64' as const } },
    { memcmp: { offset: 8, bytes: tablePda.toBase58() } },
  ];
  const [programAccounts, delegatedAccounts] = await Promise.all([
    connection.getProgramAccounts(ANCHOR_PROGRAM_ID, { filters }).catch(() => []),
    connection.getProgramAccounts(DELEGATION_PROGRAM_ID, { filters }).catch(() => []),
  ]);
  const byOperator = new Map<string, { operator: PublicKey; er: number; l1: number }>();
  for (const account of [...programAccounts, ...delegatedAccounts]) {
    const data = Buffer.from(account.account.data);
    if (data.length < 80) continue;
    const operator = new PublicKey(data.subarray(40, 72));
    if (operator.equals(PublicKey.default)) continue;
    const key = operator.toBase58();
    const row = byOperator.get(key) ?? { operator, er: 0, l1: 0 };
    row.er += data.readUInt32LE(72);
    row.l1 += data.readUInt32LE(76);
    byOperator.set(key, row);
  }
  return Array.from(byOperator.values()).filter(op => op.er > 0 || op.l1 > 0);
}

function explainCloseError(
  message: string,
  logs: string[] | null,
  label: string,
  lastActionSlot?: number,
  nowUnix?: number,
): string {
  const text = `${message}\n${logs?.join('\n') ?? ''}`;
  if (text.includes('custom program error: 0x1778')) {
    return `${label} failed: InvalidGameType (0x1778). This program may not include the delegated creator-close patch yet, or this is not a cash table close path.`;
  }
  if (text.includes('custom program error: 0x1773')) {
    return `${label} failed: the table is still delegated to the rollup. Return it to L1 before closing.`;
  }
  if (isCloseTooSoonText(text)) {
    return closeTooSoonMessage(label, lastActionSlot, nowUnix);
  }
  if (text.includes('UnclaimedBalancesExist')) {
    return `${label} failed: players still have unclaimed balances. They must claim or expire before close.`;
  }
  if (text.includes('VaultHasPlayerFunds') || text.includes('SeatHasPendingCashout')) {
    return `${label} failed: pending player funds/cashouts remain. Finish cashout cleanup before close.`;
  }
  if (text.includes('UndistributedRakeExists')) {
    return `${label} failed: undistributed rake remains. Distribute or clear rake before close.`;
  }
  return `${label} failed: ${message}`;
}

export default function CloseTableModal({
  table,
  onClose,
  onClosed,
}: {
  table: CreatorTable;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { publicKey, signTransaction, signMessage } = useUnifiedWallet();
  const { authenticatePlayerForValidator, getConnectionForValidator } = useGameAuth();

  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const closeIdleLastActionRef = useRef<number | undefined>(table.lastActionSlot);
  const closeIdleNowRef = useRef<number | undefined>(undefined);

  const phaseOk = table.phase === 'Waiting' || table.phase === 'Complete';
  const empty = table.currentPlayers === 0;
  const idleRemaining = secondsUntilCashClose(table.lastActionSlot);
  const idleOk = idleRemaining <= 0;
  const canClose = empty && phaseOk && idleOk;
  const closeBlockReason = !empty
    ? `Players seated: ${table.currentPlayers}. Every seat must be empty before close.`
    : !phaseOk
      ? `Phase: ${table.phase}. Wait for Waiting or Complete before close.`
      : !idleOk
        ? `Empty-idle window has not finished. Try again in ${formatRemaining(idleRemaining)}.`
      : null;
  const [rentEstimate, setRentEstimate] = useState<RentRefundEstimate>({
    loading: true,
    totalLamports: 0,
    tableRentLamports: 0,
    permissionLamports: 0,
    splEscrowLamports: 0,
    playerSeatLamports: 0,
    accountCount: 0,
    permissionCount: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const loadRentEstimate = async () => {
      if (!publicKey) {
        setRentEstimate(prev => ({ ...prev, loading: false, error: 'Connect wallet to estimate refund.' }));
        return;
      }

      setRentEstimate(prev => ({ ...prev, loading: true, error: undefined }));
      try {
        const tablePda = new PublicKey(table.pubkey);
        const maxPlayers = table.maxPlayers;
        const [deckStatePda] = getDeckStatePda(tablePda);
        const [slimBufferPda] = getSlimBufferPda(tablePda);
        const [crankTallyErPda] = getCrankTallyErPda(tablePda);
        const [crankTallyL1Pda] = getCrankTallyL1Pda(tablePda);
        const seatPdas: PublicKey[] = [];
        const seatCardsPdas: PublicKey[] = [];
        for (let i = 0; i < maxPlayers; i++) {
          seatPdas.push(getSeatPda(tablePda, i)[0]);
          seatCardsPdas.push(getSeatCardsPda(tablePda, i)[0]);
        }

        const tokenEscrow = table.tokenEscrow && table.tokenEscrow !== PublicKey.default.toBase58()
          ? new PublicKey(table.tokenEscrow)
          : null;
        const tableRentAccounts = uniquePublicKeys([
          tablePda,
          getVaultPda(tablePda)[0],
          getTipJarPda(tablePda)[0],
          deckStatePda,
          getHandReportBufferPda(tablePda)[0],
          getHandReportFlushStatePda(tablePda)[0],
          slimBufferPda,
          crankTallyErPda,
          crankTallyL1Pda,
          ...seatPdas,
          ...seatCardsPdas,
          ...Array.from({ length: maxPlayers }, (_, i) => getReceiptPda(tablePda, i)[0]),
          ...Array.from({ length: maxPlayers }, (_, i) => getDepositProofPda(tablePda, i)[0]),
        ]);
        const permissionAccounts = uniquePublicKeys([
          getPermissionPda(tablePda)[0],
          getPermissionPda(deckStatePda)[0],
          ...seatPdas.map(pda => getPermissionPda(pda)[0]),
          ...seatCardsPdas.map(pda => getPermissionPda(pda)[0]),
        ]);
        const allKeys = uniquePublicKeys([
          ...tableRentAccounts,
          ...permissionAccounts,
          ...(tokenEscrow ? [tokenEscrow] : []),
        ]);
        const l1 = makeL1Connection();
        const infos = await l1.getMultipleAccountsInfo(allKeys);
        if (cancelled) return;

        const byKey = new Map<string, AccountInfo<Buffer> | null>();
        allKeys.forEach((key, i) => byKey.set(key.toBase58(), infos[i]));

        const creator = publicKey.toBase58();
        let tableRentLamports = 0;
        let permissionLamports = 0;
        let splEscrowLamports = 0;
        let playerSeatLamports = 0;
        let accountCount = 0;
        let permissionCount = 0;

        for (const key of tableRentAccounts) {
          const info = byKey.get(key.toBase58()) ?? null;
          if (!isClosableProgramAccount(info)) continue;
          let lamports = info.lamports;
          if (seatPdas.some(seat => seat.equals(key)) && info.data.length >= 40) {
            const walletInSeat = new PublicKey(Buffer.from(info.data).subarray(8, 40)).toBase58();
            if (walletInSeat !== PublicKey.default.toBase58() && walletInSeat !== creator) {
              playerSeatLamports += lamports;
              lamports = 0;
            }
          }
          if (lamports <= 0) continue;
          tableRentLamports += lamports;
          accountCount += 1;
        }

        for (const key of permissionAccounts) {
          const info = byKey.get(key.toBase58()) ?? null;
          if (!isClosablePermissionAccount(info)) continue;
          permissionLamports += info.lamports;
          permissionCount += 1;
        }

        if (tokenEscrow) {
          const info = byKey.get(tokenEscrow.toBase58()) ?? null;
          if (info && info.lamports > 0) {
            splEscrowLamports = info.lamports;
            accountCount += 1;
          }
        }

        setRentEstimate({
          loading: false,
          totalLamports: tableRentLamports + permissionLamports + splEscrowLamports,
          tableRentLamports,
          permissionLamports,
          splEscrowLamports,
          playerSeatLamports,
          accountCount,
          permissionCount,
        });
      } catch (err) {
        if (!cancelled) {
          setRentEstimate({
            loading: false,
            totalLamports: 0,
            tableRentLamports: 0,
            permissionLamports: 0,
            splEscrowLamports: 0,
            playerSeatLamports: 0,
            accountCount: 0,
            permissionCount: 0,
            error: (err as Error)?.message || 'Could not estimate refund.',
          });
        }
      }
    };

    void loadRentEstimate();
    return () => { cancelled = true; };
  }, [publicKey, table.maxPlayers, table.pubkey, table.tokenEscrow]);

  const setStep = useCallback((key: string, status: StepStatus) => {
    setSteps(prev => prev.map(s => (s.key === key ? { ...s, status } : s)));
  }, []);

  // ── Send a single TX (sign with wallet, send raw, poll for confirmation). ──
  const sendOne = useCallback(async (
    tx: Transaction,
    connection: Connection,
    label: string,
    opts?: { skipPreflight?: boolean; teeBlockhash?: boolean },
  ): Promise<string> => {
    if (!signTransaction) throw new Error('Wallet does not support signing');
    tx.feePayer = publicKey!;
    // TEE / ER transactions MUST use the validator's own blockhash. The
    // indexer-backed getLatestBlockhashClient only tracks L1, so an L1
    // blockhash on a TEE tx fails with "Blockhash not found".
    const { blockhash, lastValidBlockHeight } = opts?.teeBlockhash
      ? await connection.getLatestBlockhash('confirmed')
      : await getLatestBlockhashClient(connection, 'confirmed');
    tx.recentBlockhash = blockhash;
    await applyPriorityFee(tx);
    const signed = await signTransaction(tx);
    let sig: string;
    try {
      sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: opts?.skipPreflight ?? false,
      });
    } catch (err: unknown) {
      const txErr = err as {
        message?: string;
        logs?: string[];
        getLogs?: (connection: Connection) => Promise<string[] | null>;
      };
      let logs: string[] | null = Array.isArray(txErr.logs) ? txErr.logs : null;
      if (!logs && typeof txErr.getLogs === 'function') {
        try {
          logs = await txErr.getLogs(connection);
        } catch {
          logs = null;
        }
      }
      console.error(`[close-table] ${label} send failed`, { message: txErr.message, logs });
      throw new Error(explainCloseError(
        txErr.message || String(err),
        logs,
        label,
        closeIdleLastActionRef.current,
        closeIdleNowRef.current,
      ));
    }
    for (let poll = 0; poll < 60; poll++) {
      const status = await connection.getSignatureStatus(sig);
        const conf = status?.value?.confirmationStatus;
        if (conf === 'confirmed' || conf === 'finalized') {
          if (status.value?.err) {
            throw new Error(explainCloseError(
              `${label} confirmed but failed: ${JSON.stringify(status.value.err)}`,
              null,
              label,
              closeIdleLastActionRef.current,
              closeIdleNowRef.current,
            ));
          }
          return sig;
        }
      const blockHeight = await connection.getBlockHeight();
      if (blockHeight > lastValidBlockHeight + 30) {
        throw new Error(`${label} blockhash expired. Retry.`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`${label} confirmation timed out. Retry.`);
  }, [publicKey, signTransaction]);

  const processPendingRakeForClose = useCallback(async (
    tablePda: PublicKey,
    l1: Connection,
    tee: Connection | null,
    tableDelegated: boolean,
  ): Promise<RakePrepResult> => {
    if (!publicKey) throw new Error('Connect your wallet first.');
    let txCount = 0;

    if (tableDelegated) {
      if (!tee) throw new Error('TEE connection is required to commit delegated rake state.');
      const [teeInfo, l1BeforeInfo] = await Promise.all([
        tee.getAccountInfo(tablePda),
        l1.getAccountInfo(tablePda),
      ]);
      if (!teeInfo) throw new Error('Table was not found on TEE during rake processing.');
      const teeData = Buffer.from(teeInfo.data);
      const l1BeforeData = l1BeforeInfo ? Buffer.from(l1BeforeInfo.data) : null;
      const teeRake = readU64(teeData, TABLE_OFF.RAKE_ACCUMULATED);
      const teeCrankPool = readU64(teeData, TABLE_OFF.CRANK_POOL_ACCUMULATED);
      const l1Rake = l1BeforeData ? readU64(l1BeforeData, TABLE_OFF.RAKE_ACCUMULATED) : 0;
      const l1CrankPool = l1BeforeData ? readU64(l1BeforeData, TABLE_OFF.CRANK_POOL_ACCUMULATED) : 0;
      if (teeRake > l1Rake || teeCrankPool > l1CrankPool) {
        setDetail('Committing locked table counters to L1...');
        await sendOne(
          new Transaction().add(buildCommitStateInstruction(publicKey, [tablePda])),
          tee,
          'commit_table_rake_for_close',
          { skipPreflight: true },
        );
        txCount += 1;
        await sleep(2000);
      }
    }

    const tableInfo = await l1.getAccountInfo(tablePda);
    if (!tableInfo) throw new Error('Table was not found on L1 during rake processing.');
    const tableData = Buffer.from(tableInfo.data);
    const tokenMint = new PublicKey(tableData.subarray(TABLE_OFF.TOKEN_MINT, TABLE_OFF.TOKEN_MINT + 32));
    const tokenEscrow = new PublicKey(tableData.subarray(TABLE_OFF.TOKEN_ESCROW, TABLE_OFF.TOKEN_ESCROW + 32));
    const creator = new PublicKey(tableData.subarray(TABLE_OFF.CREATOR, TABLE_OFF.CREATOR + 32));
    if (!creator.equals(publicKey)) {
      throw new Error('Only the table creator can pay to prepare and close this table.');
    }

    const [vaultPda] = getVaultPda(tablePda);
    let vaultInfo = await l1.getAccountInfo(vaultPda);
    if (!vaultInfo) throw new Error('Table vault was not found during rake processing.');
    let vaultData = Buffer.from(vaultInfo.data);
    const rakeAccumulated = readU64(tableData, TABLE_OFF.RAKE_ACCUMULATED);
    const crankPoolAccumulated = readU64(tableData, TABLE_OFF.CRANK_POOL_ACCUMULATED);
    const totalRakeDistributed = readU64(vaultData, VAULT_OFF.TOTAL_RAKE_DISTRIBUTED);
    let totalCrankDistributed = readU64(vaultData, VAULT_OFF.TOTAL_CRANK_DISTRIBUTED);
    const rakeDelta = Math.max(0, rakeAccumulated - totalRakeDistributed);
    let dealerDelta = Math.max(0, crankPoolAccumulated - totalCrankDistributed);
    const isSolTable = tokenMint.toBase58() === ZERO_MINT;

    if (rakeDelta === 0 && dealerDelta === 0) {
      return { rakeDelta, dealerDelta, txCount };
    }

    let spl: {
      tableTokenAccount: PublicKey;
      poolTokenAccount: PublicKey;
      treasuryTokenAccount: PublicKey;
      creatorTokenAccount: PublicKey;
      splRewardPool: PublicKey;
      settleRemaining: AccountMeta[];
      updateAcc: {
        escrowAta: PublicKey;
        poolAta: PublicKey;
        treasuryAta: PublicKey;
        splRewardPool: PublicKey;
      };
    } | null = null;

    if (!isSolTable) {
      const tableTokenAccount = tokenEscrow.equals(PublicKey.default)
        ? await getAssociatedTokenAddress(tokenMint, tablePda, true)
        : tokenEscrow;
      const poolTokenAccount = await getAssociatedTokenAddress(tokenMint, POOL_PDA, true);
      const treasuryTokenAccount = await getAssociatedTokenAddress(tokenMint, TREASURY, true);
      const creatorTokenAccount = await getAssociatedTokenAddress(tokenMint, creator, true);
      const splRewardPool = getSplRewardPoolPda(tokenMint);

      setDetail('Creating any missing token accounts for rake settlement...');
      const createIxs = [
        createAssociatedTokenAccountIdempotentInstruction(publicKey, poolTokenAccount, POOL_PDA, tokenMint),
        createAssociatedTokenAccountIdempotentInstruction(publicKey, treasuryTokenAccount, TREASURY, tokenMint),
        createAssociatedTokenAccountIdempotentInstruction(publicKey, creatorTokenAccount, creator, tokenMint),
      ];
      await sendInstructionBundle(sendOne, l1, createIxs, 'prepare_spl_rake_accounts');
      txCount += 1;

      spl = {
        tableTokenAccount,
        poolTokenAccount,
        treasuryTokenAccount,
        creatorTokenAccount,
        splRewardPool,
        settleRemaining: [
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: tableTokenAccount, isSigner: false, isWritable: true },
          { pubkey: poolTokenAccount, isSigner: false, isWritable: true },
          { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true },
          { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
          { pubkey: splRewardPool, isSigner: false, isWritable: true },
        ],
        updateAcc: {
          escrowAta: tableTokenAccount,
          poolAta: poolTokenAccount,
          treasuryAta: treasuryTokenAccount,
          splRewardPool,
        },
      };
    }

    if (rakeDelta > 0) {
      setDetail('Distributing pending table rake on L1...');
      await sendInstructionBundle(
        sendOne,
        l1,
        [
          buildResizeVaultInstruction(publicKey, tablePda),
          buildSettleTableRewardsInstruction(publicKey, tablePda, creator, spl?.settleRemaining ?? []),
        ],
        'settle_pending_rake_for_close',
      );
      txCount += 1;
      vaultInfo = await l1.getAccountInfo(vaultPda);
      if (!vaultInfo) throw new Error('Table vault disappeared after rake settlement.');
      vaultData = Buffer.from(vaultInfo.data);
      totalCrankDistributed = readU64(vaultData, VAULT_OFF.TOTAL_CRANK_DISTRIBUTED);
      dealerDelta = Math.max(0, crankPoolAccumulated - totalCrankDistributed);
    }

    if (dealerDelta === 0) {
      return { rakeDelta, dealerDelta, txCount };
    }

    setDetail('Initializing reward claim accounts as needed...');
    const rewardStatePda = getCrankRewardStatePda(tablePda)[0];
    const erTotalPda = getOperatorRewardTotalErPda(tablePda)[0];
    const l1TotalPda = getOperatorRewardTotalL1Pda(tablePda)[0];
    const [rewardStateInfo, erTotalInfo, l1TotalInfo] = await l1.getMultipleAccountsInfo([
      rewardStatePda,
      erTotalPda,
      l1TotalPda,
    ]);
    const initIxs: TransactionInstruction[] = [];
    if (!rewardStateInfo) initIxs.push(buildInitCrankRewardStateInstruction(publicKey, tablePda));
    if (!erTotalInfo) initIxs.push(buildInitOperatorRewardTotalInstruction(publicKey, tablePda, false));
    if (!l1TotalInfo) initIxs.push(buildInitOperatorRewardTotalInstruction(publicKey, tablePda, true));
    if (initIxs.length > 0) {
      await sendInstructionBundle(sendOne, l1, initIxs, 'init_reward_accounts_for_close');
      txCount += 1;
    }

    const operators = await scanOperatorsForTable(l1, tablePda);
    for (const op of operators) {
      setDetail(`Syncing dealer reward weight ${op.operator.toBase58().slice(0, 8)}...`);
      const claimPda = getOperatorClaimPda(tablePda, op.operator)[0];
      const claimInfo = await l1.getAccountInfo(claimPda);
      const syncIxs: TransactionInstruction[] = [];
      if (!claimInfo) syncIxs.push(buildInitOperatorClaimInstruction(publicKey, tablePda, op.operator));
      syncIxs.push(buildUpdateOpClaimWeightInstruction(publicKey, tablePda, op.operator));
      await sendInstructionBundle(sendOne, l1, syncIxs, `sync_operator_weight_${op.operator.toBase58().slice(0, 8)}`);
      txCount += 1;
    }

    setDetail('Syncing dealer reward accumulator...');
    await sendInstructionBundle(
      sendOne,
      l1,
      [buildUpdateAccRewardPerWeightInstruction(publicKey, tablePda, spl?.updateAcc ?? null)],
      'sync_operator_reward_pool_for_close',
    );
    txCount += 1;

    for (const op of operators) {
      setDetail(`Claiming dealer reward ${op.operator.toBase58().slice(0, 8)}...`);
      if (isSolTable) {
        await sendInstructionBundle(
          sendOne,
          l1,
          [buildClaimOperatorRewardsInstruction(publicKey, tablePda, op.operator)],
          `claim_operator_reward_${op.operator.toBase58().slice(0, 8)}`,
        );
        txCount += 1;
      } else if (spl) {
        const operatorAta = await getAssociatedTokenAddress(tokenMint, op.operator, true);
        await sendInstructionBundle(
          sendOne,
          l1,
          [
            createAssociatedTokenAccountIdempotentInstruction(publicKey, operatorAta, op.operator, tokenMint),
            buildClaimOperatorTokenRewardsInstruction(
              publicKey,
              tablePda,
              op.operator,
              spl.tableTokenAccount,
              operatorAta,
            ),
          ],
          `claim_operator_token_reward_${op.operator.toBase58().slice(0, 8)}`,
        );
        txCount += 1;
      }
    }

    return { rakeDelta, dealerDelta, txCount };
  }, [publicKey, sendOne]);

  const cleanupDepositProofsForClose = useCallback(async (
    tablePda: PublicKey,
    depositProofPdas: PublicKey[],
    ownerByKey: Map<string, AccountInfo<Buffer> | null>,
  ): Promise<number> => {
    if (!publicKey) return 0;
    const staleSeats = depositProofPdas
      .map((pda, seatIndex) => ({ pda, seatIndex, info: ownerByKey.get(pda.toBase58()) ?? null }))
      .filter(({ info }) => depositProofNeedsCloseCleanup(info));

    if (staleSeats.length === 0) return 0;
    if (!signMessage) {
      throw new Error('Wallet message signing is required to refund pending joins before close.');
    }

    const auth = await buildWalletApiAuth(publicKey, signMessage, 'cash-cleanup-proof');
    let cleaned = 0;
    for (const { seatIndex } of staleSeats) {
      setDetail(`Refunding stale pending join ${cleaned + 1}/${staleSeats.length}...`);
      const res = await fetch('/api/cash-game/cleanup-proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tablePda: tablePda.toBase58(),
          seatIndex,
          creatorClose: true,
          ...auth,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.success) {
        throw new Error(result.error || `Pending-join refund failed for seat ${seatIndex + 1}`);
      }
      if (result.refundError) {
        throw new Error(`Pending-join refund failed for seat ${seatIndex + 1}: ${result.refundError}`);
      }
      if (result.refunded || result.refundSignature || result.signature) cleaned += 1;
    }
    return cleaned;
  }, [publicKey, signMessage]);

  const run = useCallback(async () => {
    if (!publicKey || !signTransaction) {
      setError('Connect your wallet first.');
      return;
    }
    if (!canClose) return;

    setRunning(true);
    setError(null);
    closeIdleLastActionRef.current = table.lastActionSlot;
    closeIdleNowRef.current = undefined;
    setSteps(INITIAL_STEPS.map(s => ({ ...s, status: 'pending' })));

    const tablePda = new PublicKey(table.pubkey);
    const maxPlayers = table.maxPlayers;
    const isSplTable = !!table.tokenMint && table.tokenMint !== PublicKey.default.toBase58();
    const tokenEscrow = isSplTable && table.tokenEscrow
      ? new PublicKey(table.tokenEscrow)
      : null;
    const tokenMint = isSplTable && table.tokenMint
      ? new PublicKey(table.tokenMint)
      : null;
    const creatorTokenAccount = tokenMint
      ? await getAssociatedTokenAddress(tokenMint, publicKey, true)
      : null;
    const l1 = makeL1Connection();

    try {
      if (isSplTable && !tokenEscrow) {
        throw new Error('SPL table close needs the table token escrow account.');
      }

      // ── Step 1: scan owners on L1 ──
      setStep('scan', 'active');
      setDetail('Reading account owners on L1...');

      const [slimBufferPda] = getSlimBufferPda(tablePda);
      const [deckStatePda] = getDeckStatePda(tablePda);
      const [crankTallyErPda] = getCrankTallyErPda(tablePda);
      const [crankTallyL1Pda] = getCrankTallyL1Pda(tablePda);
      const seatPdas: PublicKey[] = [];
      const seatCardsPdas: PublicKey[] = [];
      const depositProofPdas: PublicKey[] = [];
      for (let i = 0; i < maxPlayers; i++) {
        seatPdas.push(getSeatPda(tablePda, i)[0]);
        seatCardsPdas.push(getSeatCardsPda(tablePda, i)[0]);
        depositProofPdas.push(getDepositProofPda(tablePda, i)[0]);
      }

      const closeRelevant: PublicKey[] = uniquePublicKeys([
        tablePda,
        getVaultPda(tablePda)[0],
        getTipJarPda(tablePda)[0],
        deckStatePda,
        getHandReportBufferPda(tablePda)[0],
        getHandReportFlushStatePda(tablePda)[0],
        slimBufferPda,
        crankTallyErPda,
        crankTallyL1Pda,
        ...seatPdas,
        ...seatCardsPdas,
        ...depositProofPdas,
        ...Array.from({ length: maxPlayers }, (_, i) => getReceiptPda(tablePda, i)[0]),
        ...(tokenEscrow ? [tokenEscrow] : []),
      ]);
      const cleanupExtras: PublicKey[] = uniquePublicKeys([
        getTipJarPda(tablePda)[0],
        deckStatePda,
        getHandReportBufferPda(tablePda)[0],
        getHandReportFlushStatePda(tablePda)[0],
        slimBufferPda,
        crankTallyErPda,
        crankTallyL1Pda,
        ...Array.from({ length: maxPlayers }, (_, i) => getReceiptPda(tablePda, i)[0]),
        ...depositProofPdas,
      ]);

      const allKeys = closeRelevant;
      let infos = await l1.getMultipleAccountsInfo(allKeys);
      let ownerByKey = new Map<string, AccountInfo<Buffer> | null>();
      allKeys.forEach((k, i) => ownerByKey.set(k.toBase58(), infos[i]));

      let tableInfo = ownerByKey.get(tablePda.toBase58()) ?? null;
      if (!tableInfo) {
        throw new Error('Table account was not found on L1. It may already be closed.');
      }
      let tableDelegated = isDelegatedAccount(tableInfo);
      if (!tableInfo.owner.equals(ANCHOR_PROGRAM_ID) && !tableDelegated) {
        const ownerLabel = tableInfo.owner.equals(DELEGATION_PROGRAM_ID) ? 'TEE delegation program' : tableInfo.owner.toBase58();
        throw new Error(`Table has an unexpected owner (${ownerLabel}). It cannot be closed from the creator flow.`);
      }

      setStep('scan', 'done');

      setStep('refund-proofs', 'active');
      const refundedProofs = await cleanupDepositProofsForClose(tablePda, depositProofPdas, ownerByKey);
      if (refundedProofs > 0) {
        setDetail(`Cleaned ${refundedProofs} stale pending join${refundedProofs === 1 ? '' : 's'}; refreshing close state...`);
        infos = await l1.getMultipleAccountsInfo(allKeys);
        ownerByKey = new Map<string, AccountInfo<Buffer> | null>();
        allKeys.forEach((k, i) => ownerByKey.set(k.toBase58(), infos[i]));
        tableInfo = ownerByKey.get(tablePda.toBase58()) ?? null;
        if (!tableInfo) {
          throw new Error('Table account was not found on L1 after pending-join cleanup.');
        }
        tableDelegated = isDelegatedAccount(tableInfo);
      }
      setStep('refund-proofs', 'done');

      const delegatedChildren = closeRelevant
        .filter(k => !k.equals(tablePda))
        .filter(k => isDelegatedAccount(ownerByKey.get(k.toBase58()) ?? null));
      if (!tableDelegated && delegatedChildren.length > 0) {
        throw new Error(`Table still has ${delegatedChildren.length} delegated child account${delegatedChildren.length === 1 ? '' : 's'}. Return all accounts to L1 before closing.`);
      }

      if (tableDelegated) {
        setDetail('Authenticating creator wallet with TEE...');
        const teeAuthed = await authenticatePlayerForValidator(TEE_RPC_URL);
        if (!teeAuthed) {
          throw new Error('TEE creator authentication failed. Reconnect a wallet that supports message signing and try again.');
        }
        const tee = getConnectionForValidator(TEE_RPC_URL);
        const teeTableInfo = await tee.getAccountInfo(tablePda);
        if (!teeTableInfo) throw new Error('Table was not found on TEE during close readiness check.');
        const teeData = Buffer.from(teeTableInfo.data);
        const teeNow = await getConnectionUnixTime(tee);
        closeIdleLastActionRef.current = readTableLastActionSlot(teeData);
        closeIdleNowRef.current = teeNow;
        assertCashCloseReadyFromData(teeData, teeNow);

        setStep('lock', 'active');
        setDetail('Locking the empty table on TEE...');
        const lockIx = buildCommitAndUndelegateInstruction(
          publicKey,
          tablePda,
          [],
          false,
          true,
          depositProofPdas,
        );
        await sendOne(new Transaction().add(lockIx), tee, 'lock_cash_table_for_close', { skipPreflight: true, teeBlockhash: true });
        setStep('lock', 'done');

        setStep('rake', 'active');
        const rakePrep = await processPendingRakeForClose(tablePda, l1, tee, true);
        setDetail(
          rakePrep.txCount > 0
            ? `Rake prep complete: ${rakePrep.rakeDelta} rake units, ${rakePrep.dealerDelta} dealer units.`
            : 'No pending rake or dealer rewards to process.',
        );
        setStep('rake', 'done');

        setStep('undelegate', 'active');
        if (delegatedChildren.length > 0) {
          const childChunks = chunks(delegatedChildren, UNDELEGATE_CHUNK_SIZE);
          for (let i = 0; i < childChunks.length; i++) {
            setDetail(`Returning delegated accounts ${i + 1}/${childChunks.length}...`);
            const ix = buildCommitAndUndelegateInstruction(publicKey, tablePda, childChunks[i], false, true);
            await sendOne(new Transaction().add(ix), tee, `return_delegated_accounts_${i + 1}`, {
              skipPreflight: true,
              teeBlockhash: true,
            });
          }
        }
        setStep('undelegate', 'done');

        setStep('return-table', 'active');
        setDetail('Returning the table account to L1...');
        const returnTableIx = buildCommitAndUndelegateInstruction(publicKey, tablePda, [], true, true);
        await sendOne(new Transaction().add(returnTableIx), tee, 'return_table_to_l1', { skipPreflight: true, teeBlockhash: true });

        setDetail('Waiting for L1 ownership to update...');
        let returned = false;
        for (let poll = 0; poll < 90; poll++) {
          const refreshed = await l1.getMultipleAccountsInfo(closeRelevant);
          const refreshedTable = refreshed[0];
          const delegatedLeft = closeRelevant
            .slice(1)
            .filter((_, i) => isDelegatedAccount(refreshed[i + 1]));
          if (refreshedTable?.owner.equals(ANCHOR_PROGRAM_ID) && delegatedLeft.length === 0) {
            returned = true;
            break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
        if (!returned) {
          throw new Error('TEE return was submitted, but L1 ownership did not update before timeout. Retry after propagation.');
        }
        setStep('return-table', 'done');
      } else {
        const tableData = Buffer.from(tableInfo.data);
        const l1Now = await getConnectionUnixTime(l1);
        closeIdleLastActionRef.current = readTableLastActionSlot(tableData);
        closeIdleNowRef.current = l1Now;
        assertCashCloseReadyFromData(tableData, l1Now);
        setStep('lock', 'done');
        setStep('rake', 'active');
        const rakePrep = await processPendingRakeForClose(tablePda, l1, null, false);
        setDetail(
          rakePrep.txCount > 0
            ? `Rake prep complete: ${rakePrep.rakeDelta} rake units, ${rakePrep.dealerDelta} dealer units.`
            : 'No pending rake or dealer rewards to process.',
        );
        setStep('rake', 'done');
        setStep('undelegate', 'done');
        setStep('return-table', 'done');
      }

      setStep('cleanup', 'active');
      const permissionCleanupIxs = buildCleanupTablePermissionsInstructions(publicKey, tablePda, maxPlayers);
      for (let i = 0; i < permissionCleanupIxs.length; i++) {
        setDetail(`Closing refundable setup accounts ${i + 1}/${permissionCleanupIxs.length}...`);
        await sendOne(
          new Transaction().add(permissionCleanupIxs[i]),
          l1,
          `cleanup_refundable_setup_${i + 1}`,
        );
      }

      setDetail('Closing table child rent accounts...');
      const cleanupInfos = await l1.getMultipleAccountsInfo(cleanupExtras);
      const existingCleanupExtras = cleanupExtras.filter((_, i) => cleanupInfos[i]?.owner.equals(ANCHOR_PROGRAM_ID));
      const cleanupChunks = chunks(existingCleanupExtras, CLOSE_CLEANUP_CHUNK_SIZE);
      for (let i = 0; i < cleanupChunks.length; i++) {
        setDetail(`Closing table child rent accounts ${i + 1}/${cleanupChunks.length}...`);
        const ix = buildCleanupTableAccountsInstruction(publicKey, tablePda, publicKey, cleanupChunks[i]);
        await sendOne(new Transaction().add(ix), l1, `cleanup_table_accounts_${i + 1}`);
      }
      setStep('cleanup', 'done');

      // ── Step 2: close on L1 ──
      setStep('close', 'active');
      setDetail('Closing the table and refunding rent...');
      const closeIx = buildCloseTableInstruction(publicKey, tablePda, publicKey, maxPlayers, {
        tokenEscrow,
        creatorTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      }, 'minimal');
      const closeTx = new Transaction().add(closeIx);
      await sendOne(closeTx, l1, 'close_table');
      setStep('close', 'done');

      setDetail(null);
      setDone(true);
      setRunning(false);
      toast.success('Table closed, rent refunded');
      onClosed();
    } catch (e: unknown) {
      const msg = (e as Error)?.message || 'Close failed';
      setError(msg.slice(0, 200));
      setRunning(false);
      // Mark whichever step is active as errored.
      setSteps(prev => prev.map(s => (s.status === 'active' ? { ...s, status: 'error' } : s)));
    }
  }, [publicKey, signTransaction, canClose, table, setStep, sendOne, processPendingRakeForClose, cleanupDepositProofsForClose, onClosed]);

  const stepDot = (status: StepStatus) => {
    if (status === 'done') return <span className="text-emerald-400">+</span>;
    if (status === 'active') return <span className="text-amber animate-pulse">~</span>;
    if (status === 'error') return <span className="text-red-400">!</span>;
    return <span className="text-boneDim/40">.</span>;
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center px-4 bg-black/70 backdrop-blur-sm">
      <div className="glass-pop hairline max-w-md w-full rounded-md p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] text-amber tracking-[0.22em] font-bold">CLOSE TABLE</div>
            <div className="font-display text-bone text-xl mt-1">{table.gameTypeName} Table</div>
            <div className="font-mono text-[10px] text-boneDim/60 mt-0.5">{table.pubkey.slice(0, 8)}...{table.pubkey.slice(-4)}</div>
          </div>
          <button
            onClick={onClose}
            disabled={running}
            className="text-boneDim hover:text-bone text-sm disabled:opacity-40"
          >
            CLOSE
          </button>
        </div>

        <div className="rounded-sm border border-boneDim/15 bg-ink/45 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-[10px] text-boneDim/70 tracking-[0.14em] uppercase">Estimated Refund</div>
            <div className="font-display text-emerald-300 tabular-nums text-lg leading-none">
              {rentEstimate.loading
                ? '...'
                : rentEstimate.error
                  ? 'Unavailable'
                  : `~${formatSol(rentEstimate.totalLamports)} SOL`}
            </div>
          </div>
          {!rentEstimate.loading && !rentEstimate.error && (
            <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[10px] text-boneDim/65">
              <span className="text-boneDim/45 uppercase tracking-[0.12em]">Table setup & rent</span>
              <span className="text-bone tabular-nums">{formatSol(rentEstimate.totalLamports)} SOL</span>
            </div>
          )}
          {!rentEstimate.loading && !rentEstimate.error && (
            <div className="mt-2 font-mono text-[9px] text-boneDim/50 leading-relaxed">
              Includes currently refundable table setup rent. Network fees and the original protocol fee are not returned.
              {rentEstimate.playerSeatLamports > 0 ? ` ${formatSol(rentEstimate.playerSeatLamports)} SOL of old seat rent is tied to player wallets, so it is not included here.` : ''}
            </div>
          )}
          {!rentEstimate.loading && rentEstimate.error && (
            <div className="mt-2 font-mono text-[9px] text-red-300/80 leading-relaxed">{rentEstimate.error}</div>
          )}
        </div>

        {!canClose ? (
          <div className="rounded-sm border border-amber/25 bg-amber/[0.06] px-3 py-3 font-mono text-[10px] text-amber/90 leading-relaxed">
            Table cannot be closed yet.
            <div className="mt-1.5 text-boneDim/70">
              Players seated: {table.currentPlayers} · Phase: {table.phase} · Location: {table.isDelegated ? 'TEE' : 'L1'}
            </div>
            <div className="mt-1.5 text-boneDim/70">
              {closeBlockReason ?? 'Cash tables must be empty, idle for 24 hours, and fully back on L1 before close.'}
            </div>
          </div>
        ) : (
          <>
            <div className="rounded-sm border border-emerald-400/20 bg-emerald-400/[0.05] px-3 py-2 font-mono text-[10px] text-emerald-300/90 leading-relaxed">
              Refundable setup and rent are sent back to your wallet when the table closes.
            </div>
            <div className="font-mono text-[10px] text-boneDim/65 leading-relaxed">
              This closes an empty table after the on-chain idle window. If it is still on TEE, it is locked first so no new seats can race the close.
            </div>

            <div className="rounded-sm border border-boneDim/15 bg-ink/40 px-3 py-2.5 space-y-1.5">
              {steps.map(s => (
                <div key={s.key} className="flex items-center gap-2 font-mono text-[10px]">
                  <span className="w-3 text-center">{stepDot(s.status)}</span>
                  <span className={s.status === 'done' ? 'text-bone' : s.status === 'active' ? 'text-amber' : s.status === 'error' ? 'text-red-400' : 'text-boneDim/55'}>
                    {s.label}
                  </span>
                </div>
              ))}
            </div>

            {detail && (
              <div className="font-mono text-[10px] text-boneDim/75 tracking-wide">{detail}</div>
            )}
            {error && (
              <div className="rounded-sm border border-red-400/30 bg-red-400/[0.06] px-3 py-2 font-mono text-[10px] text-red-300 leading-relaxed break-words">
                {error}
              </div>
            )}

            {!done && (
              <div className="flex items-center gap-2">
                <button
                  onClick={run}
                  disabled={running}
                  className="flex-1 rounded-sm border border-red-400/30 bg-red-400/[0.08] px-3 py-2 font-mono text-[11px] tracking-wider text-red-300 hover:border-red-400/60 disabled:opacity-50"
                >
                  {running ? 'CLOSING...' : error ? 'RETRY' : 'CLOSE TABLE'}
                </button>
                <button
                  onClick={onClose}
                  disabled={running}
                  className="rounded-sm border border-boneDim/25 px-3 py-2 font-mono text-[11px] tracking-wider text-boneDim hover:text-bone disabled:opacity-40"
                >
                  CANCEL
                </button>
              </div>
            )}
            {done && (
              <button
                onClick={onClose}
                className="w-full rounded-sm border border-emerald-400/30 bg-emerald-400/[0.08] px-3 py-2 font-mono text-[11px] tracking-wider text-emerald-300 hover:border-emerald-400/60"
              >
                DONE
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
