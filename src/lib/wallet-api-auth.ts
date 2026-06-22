import type { PublicKey } from '@solana/web3.js';

export interface WalletApiAuth {
  wallet: string;
  message: string;
  signature: string;
}

// Server accepts signatures up to 5 minutes old (api-auth.ts SIGNATURE_MAX_AGE_MS).
// We cache for 4 minutes to keep a 1-minute safety margin against clock skew.
// Cache is in-memory only — never persisted — so it dies with the tab.
const SIG_CACHE_TTL_MS = 4 * 60 * 1000;
const sigCache = new Map<string, { auth: WalletApiAuth; expiresAt: number }>();

export async function buildWalletApiAuth(
  publicKey: PublicKey,
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined,
  purpose: string,
): Promise<WalletApiAuth> {
  if (!signMessage) {
    throw new Error('Your wallet does not support message signing.');
  }
  const wallet = publicKey.toBase58();
  const cacheKey = `${wallet}:${purpose}`;
  const cached = sigCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.auth;
  }
  const random = new Uint8Array(16);
  globalThis.crypto.getRandomValues(random);
  const nonce = Array.from(random, b => b.toString(16).padStart(2, '0')).join('');
  const message = `FastPoker API Request\n\nWallet: ${wallet}\nPurpose: ${purpose}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
  const sigBytes = await signMessage(new TextEncoder().encode(message));
  let binary = '';
  for (const byte of sigBytes) binary += String.fromCharCode(byte);
  const auth: WalletApiAuth = { wallet, message, signature: btoa(binary) };
  sigCache.set(cacheKey, { auth, expiresAt: Date.now() + SIG_CACHE_TTL_MS });
  return auth;
}

/**
 * Clear the per-purpose wallet-API-auth cache. Call on disconnect or wallet
 * change so a different wallet doesn't reuse the previous wallet's sigs.
 */
export function clearWalletApiAuthCache(): void {
  sigCache.clear();
}
