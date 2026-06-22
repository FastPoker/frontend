'use client';

import React, { useState, useEffect, useCallback, useRef, createContext, useContext, ReactNode } from 'react';
import { Keypair } from '@solana/web3.js';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { getSessionKey, setSessionKey, removeSessionKey, migrateFromLocalStorage } from '@/lib/session-storage';

// ═══════════════════════════════════════════════════════════════
// approved_signer model — replaces gum session tokens (March 2026)
//
// How it works:
// 1. An ephemeral Keypair is generated and stored in IndexedDB
// 2. Its pubkey is passed as approved_signer in deposit_for_join IX data
// 3. The contract stores it in PlayerSeat.approved_signer
// 4. All TEE game actions accept either wallet OR approved_signer as signer
// 5. TEE is gasless — no SOL balance needed for the session key
// 6. No on-chain PDA, no expiry, no renewal needed
// 7. Key rotation via update_approved_signer instruction (wallet-signed)
// ═══════════════════════════════════════════════════════════════

export const SESSION_KEY_STORAGE_PREFIX = 'fastpoker_session_key';

export interface SessionState {
  sessionKey: Keypair | null;
  isActive: boolean;
  status: 'disconnected' | 'loading' | 'active' | 'no_session';
}

interface UseSessionReturn {
  session: SessionState;
  isLoading: boolean;
  error: string | null;
  createSession: () => Promise<string>;
  reclaimSession: () => Promise<string>;
  reloadSession: () => void;
}

const DEFAULT_SESSION: SessionState = {
  sessionKey: null, isActive: false, status: 'disconnected',
};

const ACTIVE_SESSION = (key: Keypair): SessionState => ({
  sessionKey: key, isActive: true, status: 'active',
});

/**
 * Hook for managing ephemeral session keys for gasless TEE transactions.
 *
 * approved_signer model (replaces gum session tokens):
 * - Keypair stored in IndexedDB, its pubkey set as approved_signer on-chain
 * - TEE is gasless — no SOL balance needed
 * - No on-chain session PDA, no expiry, no renewal
 * - approved_signer set atomically during deposit_for_join
 * - Key rotation via update_approved_signer instruction (wallet-signed)
 */
export function useSession(): UseSessionReturn {
  const { publicKey, isConnected: connected } = useUnifiedWallet();
  const [session, setSession] = useState<SessionState>(DEFAULT_SESSION);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRecoveredRef = useRef<number>(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Recover existing session keypair from IndexedDB on wallet connect
  useEffect(() => {
    if (!publicKey || !connected) {
      disconnectTimerRef.current = setTimeout(() => {
        setSession(prev => prev.sessionKey
          ? { ...prev, status: 'disconnected', isActive: false }
          : DEFAULT_SESSION
        );
      }, 3000);
      return () => { if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current); };
    }

    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }

    const now = Date.now();
    if (sessionRef.current.isActive && (now - lastRecoveredRef.current) < 30_000) return;

    const recover = async () => {
      setSession(prev => prev.isActive ? prev : { ...prev, status: 'loading' });
      await migrateFromLocalStorage(SESSION_KEY_STORAGE_PREFIX);

      const stored = await getSessionKey(publicKey.toBase58());
      if (!stored) {
        console.log('No session key in IndexedDB. Will be created on first game join.');
        setSession({ ...DEFAULT_SESSION, status: 'no_session' });
        return;
      }

      try {
        const key = Keypair.fromSecretKey(stored);
        console.log(`Session key recovered from IndexedDB: ${key.publicKey.toBase58().slice(0, 12)}...`);
        setSession(ACTIVE_SESSION(key));
      } catch {
        console.error('Corrupt session key in IndexedDB, removing');
        await removeSessionKey(publicKey.toBase58());
        setSession({ ...DEFAULT_SESSION, status: 'no_session' });
      }
    };

    recover().then(() => { lastRecoveredRef.current = Date.now(); });
  }, [publicKey, connected]);

  // Create session — just generate keypair + store in IndexedDB (no on-chain TX)
  const createSession = useCallback(async (): Promise<string> => {
    if (!publicKey) throw new Error('Wallet not connected');
    setIsLoading(true);
    setError(null);
    try {
      const sessionKey = Keypair.generate();
      await setSessionKey(publicKey.toBase58(), sessionKey.secretKey);
      setSession(ACTIVE_SESSION(sessionKey));
      console.log(`Session key created: ${sessionKey.publicKey.toBase58().slice(0, 12)}...`);
      return 'local'; // No on-chain TX — return placeholder
    } catch (err: any) {
      setError(err.message || 'Failed to create session');
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [publicKey]);

  // Reclaim session — just clear IndexedDB (no on-chain revocation needed)
  const reclaimSession = useCallback(async (): Promise<string> => {
    if (!publicKey) throw new Error('Wallet not connected');
    setIsLoading(true);
    try {
      await removeSessionKey(publicKey.toBase58());
      setSession({ ...DEFAULT_SESSION, status: 'no_session' });
      console.log('Session key removed from IndexedDB');
      return 'local';
    } catch (err: any) {
      setError(err.message || 'Failed to reclaim session');
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [publicKey]);

  // Reload session from IndexedDB after a pool or cash seating flow creates one.
  const reloadSession = useCallback(() => {
    if (!publicKey) return;
    getSessionKey(publicKey.toBase58()).then(stored => {
      if (stored) {
        try {
          const key = Keypair.fromSecretKey(stored);
          if (!session.sessionKey || !session.sessionKey.publicKey.equals(key.publicKey)) {
            setSession(ACTIVE_SESSION(key));
            console.log('Session reloaded from IndexedDB');
          }
        } catch (e) {
          console.error('Failed to reload session:', e);
        }
      }
    });
  }, [publicKey, session.sessionKey]);

  return {
    session,
    isLoading,
    error,
    createSession,
    reclaimSession,
    reloadSession,
  };
}

// ─── Context Provider (persists session across page navigation) ───

const SessionContext = createContext<UseSessionReturn | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  return React.createElement(SessionContext.Provider, { value: session }, children);
}

export function useSessionContext(): UseSessionReturn {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSessionContext must be used within <SessionProvider>');
  return ctx;
}
