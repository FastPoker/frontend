/**
 * Dealer license helpers. Extracted from the legacy /dealer/license page
 * so the Direction C /earn/dealer surface can share the same on-chain
 * plumbing without dragging legacy styling with it.
 *
 * purchase_dealer_license invariants (see pitfalls.md Pass 1 note):
 * - Anchor discriminator is sha256('global:purchase_dealer_license')[0..8]
 * - 8-account order is load-bearing: buyer, beneficiary, registry,
 *   license, treasury, steel_pool, steel_program, system_program
 * - purchase_dealer_license data is discriminator + max_total_sold u32 LE.
 * - Steel DepositPublicRevenue CPI handles the 50/50 split; do NOT
 *   replace with raw system_program::transfer or staker claims break.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  DEALER_LICENSE_BASE_PRICE,
  DEALER_LICENSE_FREE_RESERVE,
  DEALER_LICENSE_INCREMENT,
  DEALER_LICENSE_MAX_PRICE,
  DEALER_LICENSE_PAID_SUPPLY,
  DEALER_LICENSE_SEED,
  DEALER_LICENSE_TOTAL_SUPPLY,
  DEALER_REGISTRY_SEED,
  FASTPOKER_REGISTRY_PROGRAM_ID,
  POOL_PDA,
  STEEL_PROGRAM_ID,
  TREASURY,
} from '@/lib/constants';

const PURCHASE_DISC = Buffer.from([67, 26, 163, 170, 5, 108, 229, 155]);

export function buildPurchaseLicenseData(maxTotalSold: number): Buffer {
  const data = Buffer.alloc(12);
  PURCHASE_DISC.copy(data, 0);
  data.writeUInt32LE(maxTotalSold, 8);
  return data;
}

export const REGISTRY_TOTAL_SOLD_OFFSET = 40;
export const REGISTRY_TOTAL_REVENUE_OFFSET = 44;
export const REGISTRY_MIN_SIZE = 53;

export const LICENSE_WALLET_OFFSET = 8;
export const LICENSE_NUMBER_OFFSET = 40;
export const LICENSE_PURCHASED_AT_OFFSET = 44;
export const LICENSE_PRICE_PAID_OFFSET = 52;
export const LICENSE_MIN_SIZE = 61;

export interface DealerRegistryView {
  totalSold: number;
  totalRevenue: number;
}

export interface DealerLicenseView {
  wallet: string;
  licenseNumber: number;
  purchasedAt: number;
  pricePaid: number;
}

export function getRegistryPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(DEALER_REGISTRY_SEED)],
    FASTPOKER_REGISTRY_PROGRAM_ID,
  );
}

export function getLicensePda(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(DEALER_LICENSE_SEED), wallet.toBuffer()],
    FASTPOKER_REGISTRY_PROGRAM_ID,
  );
}

export function calcLicensePrice(totalSold: number): number {
  const paidSold = Math.min(
    Math.max(0, totalSold - DEALER_LICENSE_FREE_RESERVE),
    DEALER_LICENSE_PAID_SUPPLY,
  );
  const price =
    DEALER_LICENSE_BASE_PRICE + paidSold * DEALER_LICENSE_INCREMENT;
  return Math.min(price, DEALER_LICENSE_MAX_PRICE);
}

export function isDealerLicenseSaleOpen(totalSold: number): boolean {
  return totalSold >= DEALER_LICENSE_FREE_RESERVE &&
    totalSold < DEALER_LICENSE_TOTAL_SUPPLY;
}

export function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(
    lamports >= LAMPORTS_PER_SOL ? 2 : 4,
  );
}

export function parseRegistry(data: Buffer): DealerRegistryView | null {
  if (data.length < REGISTRY_MIN_SIZE) return null;
  return {
    totalSold: data.readUInt32LE(REGISTRY_TOTAL_SOLD_OFFSET),
    totalRevenue: Number(data.readBigUInt64LE(REGISTRY_TOTAL_REVENUE_OFFSET)),
  };
}

export function parseLicense(data: Buffer): DealerLicenseView | null {
  if (data.length < LICENSE_MIN_SIZE) return null;
  return {
    wallet: new PublicKey(
      data.slice(LICENSE_WALLET_OFFSET, LICENSE_WALLET_OFFSET + 32),
    ).toBase58(),
    licenseNumber: data.readUInt32LE(LICENSE_NUMBER_OFFSET),
    purchasedAt: Number(data.readBigInt64LE(LICENSE_PURCHASED_AT_OFFSET)),
    pricePaid: Number(data.readBigUInt64LE(LICENSE_PRICE_PAID_OFFSET)),
  };
}

export function buildPurchaseLicenseIx(
  buyer: PublicKey,
  beneficiary: PublicKey,
  maxTotalSold: number,
): TransactionInstruction {
  const [registryPda] = getRegistryPda();
  const [licensePda] = getLicensePda(beneficiary);
  return new TransactionInstruction({
    programId: FASTPOKER_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: beneficiary, isSigner: false, isWritable: false },
      { pubkey: registryPda, isSigner: false, isWritable: true },
      { pubkey: licensePda, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: buildPurchaseLicenseData(maxTotalSold),
  });
}
