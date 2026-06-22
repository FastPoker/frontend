import { PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ANCHOR_PROGRAM_ID,
  FASTPOKER_REGISTRY_PROGRAM_ID,
  STEEL_PROGRAM_ID,
} from './constants';
import { IX_DISC } from './discriminators';

export interface FundsActionPreview {
  title: string;
  action: string;
  amount?: string;
  table?: string;
  details?: string[];
  transaction?: Transaction;
  instructions?: TransactionInstruction[];
}

export const FUNDS_CONFIRM_EVENT = 'fastpoker:funds-confirm';

export interface FundsConfirmEventDetail {
  preview: FundsActionPreview;
  resolve: (confirmed: boolean) => void;
  handle: () => void;
}

interface DecodedInstructionPreview {
  label: string;
  program: string;
  accounts: number;
  writable: number;
  signers: number;
  dataBytes: number;
}

export interface FundsActionReview {
  title: string;
  action: string;
  amount?: string;
  table?: string;
  details: string[];
  instructions: DecodedInstructionPreview[];
  fallbackText: string;
}

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const FASTPOKER_DISC_NAMES = new Map<string, string>(
  Object.entries(IX_DISC).map(([name, disc]) => [Buffer.from(disc).toString('hex'), humanizeInstructionName(name)]),
);

const STEEL_ONE_BYTE_NAMES = new Map<number, string>([
  [1, 'Burn FP to stake'],
  [3, 'Claim stake rewards'],
  [6, 'Claim unrefined FP'],
  [24, 'Initialize unrefined account'],
  [31, 'Claim SPL rewards'],
]);

function humanizeInstructionName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function shortProgramName(programId: PublicKey): string {
  if (programId.equals(ANCHOR_PROGRAM_ID)) return 'FastPoker';
  if (programId.equals(FASTPOKER_REGISTRY_PROGRAM_ID)) return 'FastPoker Registry';
  if (programId.equals(STEEL_PROGRAM_ID)) return 'Steel';
  if (programId.equals(SystemProgram.programId)) return 'System';
  if (programId.equals(TOKEN_PROGRAM_ID)) return 'SPL Token';
  if (programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return 'Associated Token';
  if (programId.equals(MEMO_PROGRAM_ID)) return 'Memo';
  return programId.toBase58().slice(0, 8);
}

function decodeInstruction(ix: TransactionInstruction): DecodedInstructionPreview {
  let label = 'Unknown instruction';

  if (ix.programId.equals(ANCHOR_PROGRAM_ID) || ix.programId.equals(FASTPOKER_REGISTRY_PROGRAM_ID)) {
    const key = Buffer.from(ix.data.subarray(0, 8)).toString('hex');
    label = FASTPOKER_DISC_NAMES.get(key) || label;
  } else if (ix.programId.equals(SystemProgram.programId) && ix.data.length >= 4) {
    const tag = Buffer.from(ix.data.subarray(0, 4)).readUInt32LE(0);
    label = tag === 2 ? 'SOL transfer' : `System instruction ${tag}`;
  } else if (ix.programId.equals(STEEL_PROGRAM_ID) && ix.data.length >= 1) {
    label = STEEL_ONE_BYTE_NAMES.get(ix.data[0]) || `Steel instruction ${ix.data[0]}`;
  } else if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
    label = 'Token transfer or account update';
  } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
    label = 'Create associated token account';
  } else if (ix.programId.equals(MEMO_PROGRAM_ID)) {
    label = 'Memo';
  }

  return {
    label,
    program: shortProgramName(ix.programId),
    accounts: ix.keys.length,
    writable: ix.keys.filter(k => k.isWritable).length,
    signers: ix.keys.filter(k => k.isSigner).length,
    dataBytes: ix.data.length,
  };
}

function decodedInstructions(preview: FundsActionPreview): DecodedInstructionPreview[] {
  const instructions = preview.instructions || preview.transaction?.instructions || [];
  return instructions.map(decodeInstruction);
}

export function buildFundsActionReview(preview: FundsActionPreview): FundsActionReview {
  const instructions = decodedInstructions(preview);
  const details = preview.details || [];
  const fallbackLines = [
    preview.title,
    '',
    `Action: ${preview.action}`,
    preview.amount ? `Amount: ${preview.amount}` : null,
    preview.table ? `Table: ${preview.table}` : null,
    ...details,
    '',
    'Only approve if this matches what you intended.',
  ].filter(Boolean) as string[];

  return {
    title: preview.title,
    action: preview.action,
    amount: preview.amount,
    table: preview.table,
    details,
    instructions,
    fallbackText: fallbackLines.join('\n'),
  };
}

export function confirmFundsAction(preview: FundsActionPreview): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(true);

  // Per-action suppression — if the user previously checked
  // "Don't show again" on this action type, skip the modal entirely.
  // Re-enable lives in the TEE auth / Session modal.
  // Imported here (not at module top) to avoid a circular dep with the
  // provider that imports this file.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const suppress = require('./funds-confirm-suppress') as typeof import('./funds-confirm-suppress');
    // Headless (Privy embedded) wallets sign with no native popup, so this
    // modal is the only approval surface. Never honor suppression there, or
    // the user signs a funds-moving action with no warning at all.
    if (!suppress.isHeadlessSigner() && suppress.isFundsConfirmSuppressed(preview.title)) {
      return Promise.resolve(true);
    }
  } catch {
    /* lookup failed, fall through to showing the modal */
  }

  return new Promise((resolve) => {
    let handled = false;
    const detail: FundsConfirmEventDetail = {
      preview,
      resolve,
      handle: () => {
        handled = true;
      },
    };

    window.dispatchEvent(new CustomEvent(FUNDS_CONFIRM_EVENT, { detail }));

    if (!handled) {
      console.warn('Funds confirmation provider is not mounted; blocking funds-moving action.');
      resolve(false);
    }
  });
}
