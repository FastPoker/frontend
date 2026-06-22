'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { PublicKey, Transaction, VersionedTransaction, type Connection, type SendOptions } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { usePrivy } from '@privy-io/react-auth';
import { useWallets as useSolanaWallets } from '@privy-io/react-auth/solana';
import { IS_MAINNET } from '@/lib/constants';
import { setHeadlessSigner } from '@/lib/funds-confirm-suppress';
import {
  PRIVY_AUTH_ENABLED,
  PRIVY_EMAIL_ENABLED,
  PRIVY_GOOGLE_ENABLED,
  PRIVY_X_ENABLED,
  PRIVY_APPLE_ENABLED,
} from '@/lib/privy-config';

export type WalletSource = 'wallet-adapter' | 'privy-embedded' | 'privy-external' | null;

export interface UnifiedWallet {
  publicKey: PublicKey | null;
  address: string | null;
  isConnected: boolean;
  isReady: boolean;
  source: WalletSource;
  loginEmail: () => Promise<void> | void;
  loginSocial: (provider: 'google' | 'apple' | 'twitter' | 'discord') => Promise<void> | void;
  loginWallet: () => Promise<void> | void;
  openExternalWalletModal: () => void;
  logout: () => Promise<void> | void;
  // Optional in the type (matching wallet-adapter's WalletContextState) so the
  // many `if (!signMessage)` / `&& sendTransaction` guards written against the
  // adapter still narrow cleanly. They are always provided at runtime here.
  signTransaction?: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
  // Sign + submit. Drop-in for the wallet-adapter's sendTransaction, but also
  // works for Privy embedded/external wallets (sign then sendRawTransaction).
  sendTransaction: (
    tx: Transaction | VersionedTransaction,
    connection: Connection,
    options?: SendOptions,
  ) => Promise<string>;
  signAllTransactions?: <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>;
  // Sign an arbitrary message (no on-chain effect). Used for ownership proofs
  // — e.g., the waitlist signup signature challenge. Returns the raw 64-byte
  // ed25519 signature; throws if the wallet doesn't support message signing.
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

// Privy's hooks only work when a <PrivyProvider> is mounted — and providers.tsx
// only mounts it when Privy auth is explicitly enabled. Calling useSolanaWallets()
// without that provider reads a null context and throws ("Cannot read
// properties of null (reading 'connectors')"). PRIVY_AUTH_ENABLED is a build-time
// constant, so selecting the variant at module scope keeps hook order identical
// across every render (React-safe) while never calling Privy hooks when disabled.
type PrivyState = {
  privy: ReturnType<typeof usePrivy> | null;
  privyWallet: ReturnType<typeof useSolanaWallets>['wallets'][number] | undefined;
};

function usePrivyStateEnabled(): PrivyState {
  const privy = usePrivy();
  const solanaWallets = useSolanaWallets();
  return { privy, privyWallet: solanaWallets.wallets[0] };
}

function usePrivyStateDisabled(): PrivyState {
  return { privy: null, privyWallet: undefined };
}

const usePrivyState: () => PrivyState = PRIVY_AUTH_ENABLED ? usePrivyStateEnabled : usePrivyStateDisabled;

export function useUnifiedWallet(): UnifiedWallet {
  const wa = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();

  // When Privy is disabled (no provider mounted) this returns nulls instead of
  // calling — and crashing in — Privy's hooks. Hook order stays stable.
  const { privy, privyWallet } = usePrivyState();
  const isPrivyEmbedded = !!(privyWallet?.standardWallet as any)?.isPrivyWallet;

  const source: WalletSource = useMemo(() => {
    if (wa.connected && wa.publicKey) return 'wallet-adapter';
    if (PRIVY_AUTH_ENABLED && privy?.authenticated && privyWallet) {
      return isPrivyEmbedded ? 'privy-embedded' : 'privy-external';
    }
    return null;
  }, [wa.connected, wa.publicKey, privy?.authenticated, privyWallet, isPrivyEmbedded]);

  // Tell the funds-confirm layer whether the active wallet signs headlessly
  // (Privy embedded). When it does, the approval modal can't be suppressed —
  // it's the only confirmation surface, so suppression would mean blind signing.
  useEffect(() => {
    setHeadlessSigner(source === 'privy-embedded');
  }, [source]);

  const publicKey: PublicKey | null = useMemo(() => {
    if (source === 'wallet-adapter') return wa.publicKey ?? null;
    if (privyWallet?.address) {
      try {
        return new PublicKey(privyWallet.address);
      } catch {
        return null;
      }
    }
    return null;
  }, [source, wa.publicKey, privyWallet?.address]);

  const isReady = PRIVY_AUTH_ENABLED ? !!privy?.ready : true;
  const isConnected = source !== null && !!publicKey;

  // Privy's privyWallet (and the wallet-adapter object) get a fresh identity on
  // most renders. Reading them through refs keeps the sign/send callbacks below
  // referentially STABLE, so a useEffect that lists them as deps (e.g. the game
  // page's seat scanner) does not re-fire every render and loop setState.
  const waRef = useRef(wa); waRef.current = wa;
  const privyWalletRef = useRef(privyWallet); privyWalletRef.current = privyWallet;
  const sourceRef = useRef(source); sourceRef.current = source;
  const publicKeyRef = useRef(publicKey); publicKeyRef.current = publicKey;

  const loginEmail = useCallback(() => {
    if (!PRIVY_EMAIL_ENABLED) return;
    return privy?.login({ loginMethods: ['email'] } as any);
  }, [privy]);

  const loginSocial = useCallback(
    (provider: 'google' | 'apple' | 'twitter' | 'discord') => {
      if (
        (provider === 'google' && !PRIVY_GOOGLE_ENABLED) ||
        (provider === 'twitter' && !PRIVY_X_ENABLED) ||
        (provider === 'apple' && !PRIVY_APPLE_ENABLED) ||
        provider === 'discord'
      ) return;
      return privy?.login({ loginMethods: [provider] } as any);
    },
    [privy]
  );

  const loginWallet = useCallback(() => {
    if (!PRIVY_AUTH_ENABLED) {
      setWalletModalVisible(true);
      return;
    }
    return privy?.login({ loginMethods: ['wallet'] } as any);
  }, [privy, setWalletModalVisible]);

  const openExternalWalletModal = useCallback(() => {
    setWalletModalVisible(true);
  }, [setWalletModalVisible]);

  const logout = useCallback(async () => {
    if (wa.connected) {
      try { await wa.disconnect(); } catch { /* ignore */ }
    }
    if (PRIVY_AUTH_ENABLED && privy?.authenticated) {
      try { await privy.logout(); } catch { /* ignore */ }
    }
  }, [wa, privy]);

  const signMessage = useCallback(
    async (message: Uint8Array): Promise<Uint8Array> => {
      const src = sourceRef.current;
      const w = waRef.current;
      const pw = privyWalletRef.current;
      if (src === 'wallet-adapter' && w.signMessage) {
        return w.signMessage(message);
      }
      if (src && pw) {
        // Privy's Solana wallet exposes signMessage with the same shape on
        // both embedded and external linked wallets.
        const result = await (pw as unknown as {
          signMessage: (args: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
        }).signMessage({ message });
        return result.signature;
      }
      throw new Error('Wallet does not support message signing');
    },
    [],
  );

  const signTransaction = useCallback(
    async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      const src = sourceRef.current;
      const w = waRef.current;
      const pw = privyWalletRef.current;
      if (src === 'wallet-adapter' && w.signTransaction) {
        return w.signTransaction(tx);
      }
      if (src && pw) {
        const serialized =
          tx instanceof VersionedTransaction
            ? tx.serialize()
            : tx.serialize({ requireAllSignatures: false });
        const { signedTransaction } = await pw.signTransaction({
          transaction: serialized as Uint8Array,
        });
        if (tx instanceof VersionedTransaction) {
          return VersionedTransaction.deserialize(signedTransaction) as unknown as T;
        }
        return Transaction.from(signedTransaction) as unknown as T;
      }
      throw new Error('No wallet connected');
    },
    [],
  );

  const sendTransaction = useCallback(
    async (
      tx: Transaction | VersionedTransaction,
      connection: Connection,
      options?: SendOptions,
    ): Promise<string> => {
      const src = sourceRef.current;
      const w = waRef.current;
      const pw = privyWalletRef.current;

      // Sign locally and submit through the app's OWN connection. Used for
      // Privy (headless) always, and for wallet-adapter wallets on DEVNET:
      // there Phantom's signAndSendTransaction submits via Phantom's own
      // (mainnet) RPC, which rejects the devnet tx with a generic
      // "WalletSendTransactionError: Unexpected error". Completing the legacy
      // tx (feePayer + blockhash), signing, and sending the raw bytes via our
      // connection sidesteps that. (Matches the game-page buy-in workaround.)
      const signAndSendRaw = async () => {
        if (tx instanceof Transaction) {
          if (!tx.feePayer && publicKeyRef.current) tx.feePayer = publicKeyRef.current;
          if (!tx.recentBlockhash) {
            const { blockhash } = await connection.getLatestBlockhash(
              options?.preflightCommitment ?? 'confirmed',
            );
            tx.recentBlockhash = blockhash;
          }
        }
        const signed = await signTransaction(tx);
        const raw =
          signed instanceof VersionedTransaction ? signed.serialize() : signed.serialize();
        return connection.sendRawTransaction(raw, options);
      };

      if (src === 'wallet-adapter' && w.sendTransaction) {
        // On MAINNET keep the native send so Phantom/Blowfish can inject their
        // Lighthouse guard; on DEVNET route around Phantom's mainnet RPC.
        if (!IS_MAINNET && w.signTransaction) return signAndSendRaw();
        return w.sendTransaction(tx, connection, options);
      }
      if (src && pw) {
        return signAndSendRaw();
      }
      throw new Error('No wallet connected');
    },
    [signTransaction],
  );

  const signAllTransactions = useCallback(
    async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
      const w = waRef.current;
      if (sourceRef.current === 'wallet-adapter' && w.signAllTransactions) {
        return w.signAllTransactions(txs);
      }
      // Privy signs headlessly; sign sequentially to avoid concurrent prompts.
      const out: T[] = [];
      for (const tx of txs) out.push(await signTransaction(tx));
      return out;
    },
    [signTransaction],
  );

  return {
    publicKey,
    address: publicKey?.toBase58() ?? null,
    isConnected,
    isReady,
    source,
    loginEmail,
    loginSocial,
    loginWallet,
    openExternalWalletModal,
    logout,
    signTransaction,
    sendTransaction,
    signAllTransactions,
    signMessage,
  };
}
