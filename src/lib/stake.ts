import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

import { POKER_MINT, POOL_PDA, STEEL_PROGRAM_ID, USDC_MINT } from './constants';

export const CLAIM_STAKE_REWARDS_DISCRIMINATOR = 3;
export const BURN_STAKE_DISCRIMINATOR = 1;
export const INIT_SPL_REWARD_POOL_DISCRIMINATOR = 29;
export const LAUNCH_SPL_REWARD_MINTS = [POKER_MINT, USDC_MINT];

export function getStakePda(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stake'), wallet.toBuffer()],
    STEEL_PROGRAM_ID,
  );
}

export function getSplRewardPoolPda(tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('spl_reward_pool'), tokenMint.toBuffer()],
    STEEL_PROGRAM_ID,
  );
}

export function getSplStakerClaimPda(wallet: PublicKey, tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('spl_staker_claim'), wallet.toBuffer(), tokenMint.toBuffer()],
    STEEL_PROGRAM_ID,
  );
}

export function buildInitSplRewardPoolInstruction(
  payer: PublicKey,
  tokenMint: PublicKey,
): TransactionInstruction {
  const [splPoolPda] = getSplRewardPoolPda(tokenMint);
  return new TransactionInstruction({
    programId: STEEL_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: splPoolPda, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: false },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from([INIT_SPL_REWARD_POOL_DISCRIMINATOR]),
      tokenMint.toBuffer(),
    ]),
  });
}

export async function buildBurnStakeInstruction(
  wallet: PublicKey,
  amountBase: bigint,
): Promise<TransactionInstruction> {
  const [stakePda] = getStakePda(wallet);
  const tokenAccount = await getAssociatedTokenAddress(
    POKER_MINT,
    wallet,
    false,
  );
  const data = Buffer.alloc(9);
  data.writeUInt8(BURN_STAKE_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(amountBase, 1);
	  const launchSplClaimKeys = LAUNCH_SPL_REWARD_MINTS.flatMap((mint) => {
	    const [splPoolPda] = getSplRewardPoolPda(mint);
	    const [claimPda] = getSplStakerClaimPda(wallet, mint);
	    return [
	      { pubkey: splPoolPda, isSigner: false, isWritable: true },
	      { pubkey: claimPda, isSigner: false, isWritable: true },
	    ];
	  });
  return new TransactionInstruction({
    programId: STEEL_PROGRAM_ID,
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: stakePda, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: POKER_MINT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...launchSplClaimKeys,
    ],
    data,
  });
}

/**
 * Build a Steel ClaimStakeRewards transaction. Returns a Transaction pre-seeded
 * with an ATA creation guard for the staker's $FP token account so fresh
 * wallets can claim without a separate setup step. Callers pass in the already
 * established connection so the ATA existence probe reuses the same RPC.
 */
export async function buildClaimStakeRewardsTx(
  connection: Connection,
  wallet: PublicKey,
): Promise<Transaction> {
  const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, wallet);
  const poolTokenAccount = await getAssociatedTokenAddress(
    POKER_MINT,
    POOL_PDA,
    true,
  );
  const [stakePda] = getStakePda(wallet);
  const tx = new Transaction();
  try {
    await getAccount(connection, tokenAccount);
  } catch {
    tx.add(
      createAssociatedTokenAccountInstruction(
        wallet,
        tokenAccount,
        wallet,
        POKER_MINT,
      ),
    );
  }
  const data = Buffer.alloc(1);
  data.writeUInt8(CLAIM_STAKE_REWARDS_DISCRIMINATOR, 0);
  tx.add(
    new TransactionInstruction({
      programId: STEEL_PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: stakePda, isSigner: false, isWritable: true },
        { pubkey: POOL_PDA, isSigner: false, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: poolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    }),
  );
  return tx;
}

export interface StakeRewardsView {
  staked: number;
  totalPoolStaked: number;
  yourSharePercent: number;
  pendingSol: number;
  pendingPoker: number;
  pokerBalance: number;
  loading: boolean;
}

/**
 * Read wallet $POKER balance, the staker's stake PDA, and the pool PDA in a
 * single batched RPC call, then compute lazy pending SOL + pending $POKER the
 * same way the on-chain ClaimStakeRewards IX would. Used by /earn
 * (for the position summary) and /earn/claims (for the Native rewards tile).
 */
export async function readStakeRewards(
  connection: Connection,
  wallet: PublicKey,
): Promise<StakeRewardsView> {
  const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, wallet);
  const [stakePda] = getStakePda(wallet);
  const accounts = await connection.getMultipleAccountsInfo([
    tokenAccount,
    stakePda,
    POOL_PDA,
  ]);
  const [tokenAcct, stakeAcct, poolAcct] = accounts;

  let pokerBalance = 0;
  if (tokenAcct && tokenAcct.data.length >= 64) {
    pokerBalance =
      Number(Buffer.from(tokenAcct.data).readBigUInt64LE(64)) / 1e9;
  }

  let staked = 0;
  let pendingSol = 0;
  let pendingPoker = 0;
  let burnedRaw = BigInt(0);
  let solRewardDebt = BigInt(0);
  let storedPendingSol = BigInt(0);
  if (stakeAcct && stakeAcct.data.length >= 72) {
    const d = Buffer.from(stakeAcct.data);
    burnedRaw = d.readBigUInt64LE(40);
    staked = Number(burnedRaw) / 1e9;
    const debtLo = d.readBigUInt64LE(48);
    const debtHi = d.readBigUInt64LE(56);
    solRewardDebt = (debtHi << BigInt(64)) | debtLo;
    storedPendingSol = d.readBigUInt64LE(64);
  }

  let totalPoolStaked = 0;
  if (poolAcct && poolAcct.data.length >= 168) {
    const pd = Buffer.from(poolAcct.data);
    totalPoolStaked = Number(pd.readBigUInt64LE(72)) / 1e9;

    const accSolLo = pd.readBigUInt64LE(96);
    const accSolHi = pd.readBigUInt64LE(104);
    const accSolPerToken = (accSolHi << BigInt(64)) | accSolLo;
    if (burnedRaw > BigInt(0)) {
      const accumulated = burnedRaw * accSolPerToken;
      const lazy =
        accumulated > solRewardDebt
          ? (accumulated - solRewardDebt) / BigInt(1_000_000_000_000)
          : BigInt(0);
      pendingSol = Number(storedPendingSol + lazy) / 1e9;
    } else {
      pendingSol = Number(storedPendingSol) / 1e9;
    }

    if (stakeAcct && stakeAcct.data.length >= 96 && burnedRaw > BigInt(0)) {
      const sd = Buffer.from(stakeAcct.data);
      const pokerDebtLo = sd.readBigUInt64LE(72);
      const pokerDebtHi = sd.readBigUInt64LE(80);
      const pokerRewardDebt = (pokerDebtHi << BigInt(64)) | pokerDebtLo;
      const storedPendingPoker = sd.readBigUInt64LE(88);
      const accPokerLo = pd.readBigUInt64LE(128);
      const accPokerHi = pd.readBigUInt64LE(136);
      const accPokerPerToken = (accPokerHi << BigInt(64)) | accPokerLo;
      const accumulated = burnedRaw * accPokerPerToken;
      const lazy =
        accumulated > pokerRewardDebt
          ? (accumulated - pokerRewardDebt) / BigInt(1_000_000_000_000)
          : BigInt(0);
      pendingPoker = Number(storedPendingPoker + lazy) / 1e9;
    }
  }

  const yourSharePercent =
    totalPoolStaked > 0 ? (staked / totalPoolStaked) * 100 : 0;

  return {
    staked,
    totalPoolStaked,
    yourSharePercent,
    pendingSol,
    pendingPoker,
    pokerBalance,
    loading: false,
  };
}

/**
 * Read the stake pool PDA alone. Used by /earn pool tiles.
 */
export async function readPoolHealth(
  connection: Connection,
): Promise<{
  totalPoolStaked: number;
  solDistributed: number;
  solAvailable: number;
  pokerDistributed: number;
  pokerAvailable: number;
  totalUnrefined: number;
}> {
  const poolAcct = await connection.getAccountInfo(POOL_PDA);
  if (!poolAcct || poolAcct.data.length < 168) {
    return {
      totalPoolStaked: 0,
      solDistributed: 0,
      solAvailable: 0,
      pokerDistributed: 0,
      pokerAvailable: 0,
      totalUnrefined: 0,
    };
  }
  const pd = Buffer.from(poolAcct.data);
  return {
    totalPoolStaked: Number(pd.readBigUInt64LE(72)) / 1e9,
    solAvailable: Number(pd.readBigUInt64LE(80)) / 1e9,
    solDistributed: Number(pd.readBigUInt64LE(88)) / 1e9,
    pokerDistributed: Number(pd.readBigUInt64LE(120)) / 1e9,
    pokerAvailable: Number(pd.readBigUInt64LE(112)) / 1e9,
    totalUnrefined: Number(pd.readBigUInt64LE(144)) / 1e6,
  };
}
