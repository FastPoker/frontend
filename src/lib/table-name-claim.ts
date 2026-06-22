'use client';

import nacl from 'tweetnacl';
import bs58 from 'bs58';

/**
 * Helpers for naming a cash table in the standalone client. Names are local
 * browser preferences, not global indexer-owned claims.
 *
 * The signing helpers are kept for compatibility with the existing modal, but
 * `postNameClaim` persists the label to localStorage instead of calling a server.
 */

export const NAME_SIG_DOMAIN = 'fastpoker.tableName.v1';

export interface NameClaimPayload {
  pda: string;
  name: string;
  signature: string; // base58
  nonce: number;     // unix seconds
}

export function nowNonce(): number {
  return Math.floor(Date.now() / 1000);
}

export function buildCanonicalMessage(pda: string, name: string, nonce: number): Uint8Array {
  const lower = name.toLowerCase();
  return new TextEncoder().encode(`${NAME_SIG_DOMAIN}\n${pda}\n${lower}\n${nonce}`);
}

/**
 * Sign a name-claim message with an in-memory ed25519 secret key. Use this
 * when the caller has direct access to the creator wallet keypair (e.g. a
 * test/admin script, or a session-key signer that holds the table creator).
 */
export function signWithSecretKey(
  pda: string,
  name: string,
  nonce: number,
  secretKey: Uint8Array,
): { signature: string; nonce: number } {
  const msg = buildCanonicalMessage(pda, name, nonce);
  const sigBytes = nacl.sign.detached(msg, secretKey);
  return { signature: bs58.encode(sigBytes), nonce };
}

/**
 * Store the label locally. This mirrors the old server response shape so the
 * existing modal can close on success.
 */
export interface ClaimResponse {
  ok: boolean;
  name?: string;
  pda?: string;
  owner?: string;
  error?: string;
  code?: 'taken' | 'invalid_name' | 'not_owner' | 'db_error';
}

export async function postNameClaim(payload: NameClaimPayload): Promise<ClaimResponse> {
  try {
    if (typeof window === 'undefined') {
      return { ok: false, error: 'local storage unavailable' };
    }
    const { TABLE_NAMES_STORAGE_EVENT, TABLE_NAMES_STORAGE_KEY } = await import('@/hooks/useTableNames');
    const stored = JSON.parse(window.localStorage.getItem(TABLE_NAMES_STORAGE_KEY) || '{}') as Record<string, string>;
    stored[payload.pda] = payload.name;
    window.localStorage.setItem(TABLE_NAMES_STORAGE_KEY, JSON.stringify(stored));
    window.dispatchEvent(new Event(TABLE_NAMES_STORAGE_EVENT));
    return { ok: true, name: payload.name, pda: payload.pda };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
