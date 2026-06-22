import { Keypair } from '@solana/web3.js';
import fs from 'fs';

const runtimeKeyCache = new Map<string, Keypair>();

export function loadRequiredServerKeypair(envName = 'AUTHORITY_KEYPAIR_PATH'): Keypair {
  const keypairPath = process.env[envName]?.trim();
  if (!keypairPath) {
    throw new Error(`Server misconfigured: ${envName} env var required.`);
  }

  const cached = runtimeKeyCache.get(keypairPath);
  if (cached) return cached;

  const raw = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
  runtimeKeyCache.set(keypairPath, keypair);
  return keypair;
}
