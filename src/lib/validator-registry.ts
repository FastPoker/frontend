/**
 * ValidatorRegistry — Multi-validator support for MagicBlock TEE endpoints.
 * 
 * Design:
 *   - Registry maps validator pubkeys → RPC endpoints
 *   - Auto-detection reads L1 delegation records to find which validator owns an account
 *   - Future-proof: just add a new entry to VALIDATORS to support new endpoints
 *   - Default validator used for new table creation (configurable)
 * 
 * Delegation record layout (from @magicblock-labs/ephemeral-rollups-sdk Resolver):
 *   PDA seeds: ["delegation", account_pubkey] against DELEGATION_PROGRAM_ID
 *   Data[0..8]:  discriminator
 *   Data[8..40]: validator pubkey (32 bytes)
 */
import { Connection, PublicKey } from '@solana/web3.js';

// ─── Delegation Program ───
export const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

// ─── Validator Entry ───
export interface ValidatorEntry {
  /** Human-readable name */
  name: string;
  /** Validator identity pubkey (from getIdentity) */
  pubkey: PublicKey;
  /** HTTPS RPC endpoint */
  rpcUrl: string;
  /** WSS endpoint */
  wsUrl: string;
  /** Is this the default for new delegations? */
  isDefault?: boolean;
  /** Optional notes (e.g. "commit broken as of Mar 2026") */
  note?: string;
}

function resolveBrowserRpcUrl(raw: string): string {
  if (!raw) return raw;
  if (raw.startsWith('/') && typeof window !== 'undefined') {
    return `${window.location.origin}${raw}`;
  }
  return raw;
}

function rpcToWsUrl(raw: string): string {
  const resolved = resolveBrowserRpcUrl(raw);
  if (!resolved) return '';
  try {
    const u = new URL(resolved);
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return resolved.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  }
}

function validatorNameForRpc(raw: string): string {
  try {
    const host = new URL(resolveBrowserRpcUrl(raw)).hostname;
    if (host === 'mainnet-tee.magicblock.app') return 'mainnet-tee';
    if (host === 'devnet-tee.magicblock.app') return 'devnet-tee';
    return host || 'tee';
  } catch {
    return 'tee';
  }
}

// Default to the mainnet TEE so a blank-env run is mainnet-coherent (matches the
// mainnet RPC pool + program-ID fallbacks). Operators on devnet override via
// NEXT_PUBLIC_DEFAULT_TEE_RPC.
const DEFAULT_TEE_RPC = resolveBrowserRpcUrl(
  process.env.NEXT_PUBLIC_DEFAULT_TEE_RPC || 'https://mainnet-tee.magicblock.app',
);
const DEFAULT_TEE_WS = process.env.NEXT_PUBLIC_DEFAULT_TEE_WS || rpcToWsUrl(DEFAULT_TEE_RPC);

// ─── Known Validators ───
// Add new validators here as MagicBlock spins them up.
// Set isDefault=true on the one to use for NEW table creation.
// Env var override: NEXT_PUBLIC_DEFAULT_TEE_RPC changes the default validator's RPC URL.
export const VALIDATORS: ValidatorEntry[] = [
  {
    name: validatorNameForRpc(DEFAULT_TEE_RPC),
    pubkey: new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo'),
    rpcUrl: DEFAULT_TEE_RPC,
    wsUrl: DEFAULT_TEE_WS,
    isDefault: true,
  },
];

// ─── Registry Lookups ───

/** Map: validator pubkey string → entry */
const _byPubkey = new Map<string, ValidatorEntry>(
  VALIDATORS.map(v => [v.pubkey.toBase58(), v])
);

/** Map: name → entry */
const _byName = new Map<string, ValidatorEntry>(
  VALIDATORS.map(v => [v.name, v])
);

/** Get the default validator for new delegations */
export function getDefaultValidator(): ValidatorEntry {
  return VALIDATORS.find(v => v.isDefault) || VALIDATORS[0];
}

/** Look up a validator by its pubkey */
export function getValidatorByPubkey(pubkey: PublicKey | string): ValidatorEntry | undefined {
  const key = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
  return _byPubkey.get(key);
}

/** Look up a validator by name */
export function getValidatorByName(name: string): ValidatorEntry | undefined {
  return _byName.get(name);
}

/** Get all known validators */
export function getAllValidators(): ValidatorEntry[] {
  return [...VALIDATORS];
}

// ─── Delegation Record Detection ───

/** Derive the delegation record PDA for an account */
export function getDelegationRecordPda(account: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('delegation'), account.toBuffer()],
    DELEGATION_PROGRAM_ID,
  );
  return pda;
}

export interface DelegationInfo {
  isDelegated: boolean;
  validator?: PublicKey;
  validatorEntry?: ValidatorEntry;
}

/**
 * Read the delegation record from L1 to detect which validator an account is delegated to.
 * Returns { isDelegated: false } if not delegated.
 * Returns { isDelegated: true, validator, validatorEntry } if delegated.
 * validatorEntry may be undefined if delegated to an unknown validator (future-proof).
 */
export async function detectDelegation(
  l1: Connection,
  account: PublicKey,
): Promise<DelegationInfo> {
  const recordPda = getDelegationRecordPda(account);
  const info = await l1.getAccountInfo(recordPda, 'confirmed');

  if (!info || !info.owner.equals(DELEGATION_PROGRAM_ID) || info.lamports === 0) {
    return { isDelegated: false };
  }

  // Validator pubkey is at bytes 8..40 of the delegation record
  if (info.data.length < 40) {
    return { isDelegated: false };
  }

  const validator = new PublicKey(info.data.subarray(8, 40));
  const validatorEntry = getValidatorByPubkey(validator);

  return {
    isDelegated: true,
    validator,
    validatorEntry,
  };
}

/**
 * Batch detect delegations for multiple accounts.
 * Uses getMultipleAccountsInfo for efficiency.
 */
export async function detectDelegationBatch(
  l1: Connection,
  accounts: PublicKey[],
): Promise<Map<string, DelegationInfo>> {
  const recordPdas = accounts.map(a => getDelegationRecordPda(a));
  const infos = await l1.getMultipleAccountsInfo(recordPdas, 'confirmed');

  const results = new Map<string, DelegationInfo>();
  for (let i = 0; i < accounts.length; i++) {
    const info = infos[i];
    const key = accounts[i].toBase58();

    if (!info || !info.owner.equals(DELEGATION_PROGRAM_ID) || info.lamports === 0 || info.data.length < 40) {
      results.set(key, { isDelegated: false });
    } else {
      const validator = new PublicKey(info.data.subarray(8, 40));
      const validatorEntry = getValidatorByPubkey(validator);
      results.set(key, { isDelegated: true, validator, validatorEntry });
    }
  }
  return results;
}

/**
 * Get the RPC URL for a delegated account, or null if not delegated / unknown validator.
 * Convenience wrapper around detectDelegation.
 */
export async function getEndpointForAccount(
  l1: Connection,
  account: PublicKey,
): Promise<{ rpcUrl: string; wsUrl: string; validator: ValidatorEntry } | null> {
  const info = await detectDelegation(l1, account);
  if (!info.isDelegated || !info.validatorEntry) return null;
  return {
    rpcUrl: info.validatorEntry.rpcUrl,
    wsUrl: info.validatorEntry.wsUrl,
    validator: info.validatorEntry,
  };
}
