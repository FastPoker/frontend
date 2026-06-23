'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { TEE_RPC_URL } from '@/lib/constants';
import { VALIDATORS, getDefaultValidator } from '@/lib/validator-registry';
import { useSessionContext } from '@/hooks/useSession';
import { reportHealth } from '@/lib/system-health';

// ─── TEE Constants ───
// Dummy WS endpoint to prevent @solana/web3.js from auto-connecting to TEE WebSocket.
// TEE WebSocket IS supported (confirmed March 2026) via wss://<validator>?token=<jwt>.
// DUMMY_WS is kept to avoid unintended WS connections until we migrate from polling to WS subscriptions.
const DUMMY_WS = 'wss://127.0.0.1:1';
const TEE_TOKEN_STORAGE = 'fastpoker_tee_token';
const TEE_BASE = TEE_RPC_URL;
const ALL_VALIDATOR_URLS = VALIDATORS.map(v => v.rpcUrl);

// Token lifetimes — kept short to bound XSS blast radius (tokens live in
// localStorage; a stolen token was previously valid for 30 days).
// Magicblock TEE service rotates player tokens at ~50 minutes regardless of
// what the client thinks. Match that here so we auto-refresh BEFORE the
// server actually expires the token. Misaligning these (e.g. claiming 24h
// when the server enforces 50m) causes surprise re-auth popups mid-session.
const TOKEN_LIFETIME_MS = 45 * 60 * 1000;         // 45m — under actual TEE TTL of ~50m
const REFRESH_BEFORE_MS = 10 * 60 * 1000;         // Refresh 10m before expiry (at 35m)
const HEALTH_CHECK_INTERVAL_MS = 60 * 1000;       // Health check every 60s
const MAX_CONSECUTIVE_FAILURES = 3;                // Trigger recovery after 3 failures

// ─── Types ───

export type AuthStatus =
  | 'disconnected'  // No wallet connected
  | 'connecting'    // Getting initial TEE token + recovering session
  | 'browse'        // Authority TEE token ready (can view tables, not hole cards)
  | 'ready'         // Player TEE token + session active (can play + see cards)
  | 'degraded';     // Partial auth — one system failed, attempting recovery

export type TeeTokenType = 'none' | 'authority' | 'player';

export interface GameAuthState {
  // Unified status
  status: AuthStatus;
  // TEE auth details (default validator)
  teeConnection: Connection;
  teeTokenType: TeeTokenType;
  teeAuthenticated: boolean;
  isTeeAuthenticating: boolean;
  isPlayerReady: boolean;  // True when player token is active (can see hole cards)
  teeTokenExpiresAt: number; // Epoch ms when TEE token expires (0 if none)
  // Multi-validator: per-validator connections (authority tokens, auto-populated on connect)
  validatorConnections: Map<string, Connection>; // rpcUrl → authenticated Connection
  getConnectionForValidator: (rpcUrl: string) => Connection; // Get connection for specific validator
  // Session details (passthrough from useSession)
  sessionActive: boolean;
  sessionStatus: string;
  // Actions
  authenticatePlayer: () => Promise<void>;       // Trigger player signMessage auth for default validator
  authenticatePlayerForValidator: (validatorUrl: string) => Promise<boolean>; // Auth for specific validator
  ensurePlayerAuth: () => Promise<boolean>;      // Gate: returns true if player auth active, triggers if not
  ensurePlayerConnection: (validatorUrl?: string) => Promise<Connection | null>; // Gate + return fresh tokenized TEE connection
  forceRefresh: () => Promise<void>;             // Force re-auth (recovery)
  // For components that need the raw connection
  plainConnection: Connection;
}

// ─── Context ───

const GameAuthContext = createContext<GameAuthState | null>(null);

export function useGameAuth(): GameAuthState {
  const ctx = useContext(GameAuthContext);
  if (!ctx) throw new Error('useGameAuth must be used within <GameAuthProvider>');
  return ctx;
}

// ─── Provider ───

export function GameAuthProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage } = useUnifiedWallet();
  const { session } = useSessionContext();

  // TEE auth state
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [tokenType, _setTokenType] = useState<TeeTokenType>('none');
  const tokenTypeRef = useRef<TeeTokenType>('none'); // Sync mirror of tokenType for guards
  const setTokenType = (t: TeeTokenType) => { tokenTypeRef.current = t; _setTokenType(t); };
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const tokenExpiryRef = useRef<number>(0);
  const isAuthPendingRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);
  const cacheRestoreAttemptsRef = useRef(0); // Track how many times forceRefresh tried cached token
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connections
  const plainConnection = useMemo(
    () => new Connection(TEE_RPC_URL, { commitment: 'confirmed', wsEndpoint: DUMMY_WS }),
    [],
  );
  const [teeConnection, setTeeConnection] = useState<Connection>(plainConnection);
  const teeConnectionRef = useRef<Connection>(plainConnection);
  const setCurrentTeeConnection = useCallback((conn: Connection) => {
    teeConnectionRef.current = conn;
    setTeeConnection(conn);
  }, []);
  // Multi-validator: authority-authed connections per validator URL
  const validatorConnsRef = useRef<Map<string, Connection>>(new Map());
  const [validatorConnections, setValidatorConnections] = useState<Map<string, Connection>>(new Map());

  // ─── Internal: authority token DISABLED by default in LIGHT ───
  // The node/FULL build has /api/tee/token, but the static build does not ship
  // route handlers. Public TEE reads therefore use direct unauthenticated reads
  // or the per-player wallet-signed JWT established at join/action time.
  const getAuthorityToken = useCallback(async (_force?: boolean): Promise<boolean> => {
    return false;
  }, []);

  // ─── Internal: get player token for a specific validator (signMessage popup) ───
  const getPlayerTokenForValidator = useCallback(async (validatorUrl: string): Promise<boolean> => {
    if (!publicKey) {
      console.error('[JOIN-AUTH] no publicKey — wallet not connected');
      return false;
    }
    if (!signMessage) {
      console.error('[JOIN-AUTH] signMessage not available on this wallet adapter (adapter does not support signing)');
      return false;
    }
    try {
      const pub = publicKey.toBase58();
      console.log(`[JOIN-AUTH] Fetching challenge from ${validatorUrl}/auth/challenge`);
      let crRaw: Response;
      try {
        crRaw = await fetch(`${validatorUrl}/auth/challenge?pubkey=${pub}`);
      } catch (fetchErr: any) {
        console.error('[JOIN-AUTH] Challenge fetch failed (network error):', fetchErr.message);
        return false;
      }
      if (!crRaw.ok) {
        console.error(`[JOIN-AUTH] Challenge endpoint HTTP ${crRaw.status} — TEE may be down or URL wrong: ${validatorUrl}`);
        return false;
      }
      let cr: any;
      try {
        cr = await crRaw.json();
      } catch {
        console.error('[JOIN-AUTH] Challenge response is not valid JSON');
        return false;
      }
      if (!cr?.challenge) {
        console.error('[JOIN-AUTH] Challenge response missing .challenge field:', JSON.stringify(cr).slice(0, 200));
        return false;
      }
      console.log('[JOIN-AUTH] Challenge received — calling signMessage (wallet popup should appear now)');
      const sig = await signMessage(new TextEncoder().encode(cr.challenge));
      console.log('[JOIN-AUTH] signMessage completed — posting to login endpoint');
      const lr = await fetch(`${validatorUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: pub, challenge: cr.challenge, signature: bs58.encode(sig) }),
      }).then(r => r.json());
      if (!lr.token) {
        console.error('[JOIN-AUTH] Login endpoint returned no token:', JSON.stringify(lr).slice(0, 200));
        return false;
      }

      const expiry = Date.now() + TOKEN_LIFETIME_MS;
      const conn = new Connection(`${validatorUrl}?token=${lr.token}`, { commitment: 'confirmed', wsEndpoint: DUMMY_WS });
      validatorConnsRef.current.set(validatorUrl, conn);
      setValidatorConnections(new Map(validatorConnsRef.current));

      // If this is the default validator, update main connection state
      if (validatorUrl === getDefaultValidator().rpcUrl || validatorUrl === TEE_BASE) {
        setAuthToken(lr.token);
        tokenExpiryRef.current = expiry;
        setCurrentTeeConnection(conn);
        setTokenType('player');
      }
      // Cache player token — use consistent key (pub only for default validator, pub+url for others)
      const cacheKey = (validatorUrl === getDefaultValidator().rpcUrl || validatorUrl === TEE_BASE)
        ? `${TEE_TOKEN_STORAGE}_${pub}`
        : `${TEE_TOKEN_STORAGE}_${pub}_${validatorUrl}`;
      localStorage.setItem(cacheKey, JSON.stringify({ token: lr.token, expiry }));
      consecutiveFailuresRef.current = 0;
      console.log(`[JOIN-AUTH] Player TEE token obtained for ${validatorUrl.replace('https://', '').slice(0, 20)}`);
      return true;
    } catch (e: any) {
      console.error(`[JOIN-AUTH] Player auth failed for ${validatorUrl}:`, e.message);
      return false;
    }
  }, [publicKey, signMessage]);

  // ─── Internal: get player token for default validator (backward compat) ───
  const getPlayerToken = useCallback(async (): Promise<boolean> => {
    return getPlayerTokenForValidator(TEE_BASE);
  }, [getPlayerTokenForValidator]);

  // ─── Schedule proactive refresh before token expiry ───
  const MAX_TIMEOUT_MS = 2_147_483_647; // setTimeout max (2^31-1) — ~24.8 days
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const timeUntilExpiry = tokenExpiryRef.current - Date.now();
    const refreshIn = Math.min(Math.max(0, timeUntilExpiry - REFRESH_BEFORE_MS), MAX_TIMEOUT_MS);
    if (refreshIn <= 0 || timeUntilExpiry <= 0) return;

    refreshTimerRef.current = setTimeout(async () => {
      const isPlayer = tokenTypeRef.current === 'player';
      if (isPlayer && publicKey) {
        try {
          const pub = publicKey.toBase58();
          const cached = localStorage.getItem(`${TEE_TOKEN_STORAGE}_${pub}`);
          if (cached) {
            const { token, expiry } = JSON.parse(cached);
            if (expiry > Date.now() + REFRESH_BEFORE_MS) {
              // Token still has plenty of life — update ref from cache and reschedule
              tokenExpiryRef.current = expiry;
              scheduleRefresh();
              return;
            }
          }
        } catch {}
        // Can't silently refresh player token (needs signMessage popup)
        // Fall back to authority to keep reads working; player re-signs on next game action
        console.log('[GameAuth] Proactive token refresh — falling back to authority');
        const ok = await getAuthorityToken(true);
        if (!ok) console.warn('[GameAuth] Proactive refresh failed');
      } else {
        console.log('[GameAuth] Proactive token refresh (authority)');
        await getAuthorityToken(true);
      }
      scheduleRefresh();
    }, refreshIn);
  }, [tokenType, publicKey, getAuthorityToken]);

  // ─── Restore cached player token on wallet connect ───
  // Synchronous restore: trust localStorage expiry immediately (no popup).
  // Validate in background — if stale, clear and fall back to authority token.
  const hasRestoredRef = useRef(false);
  useEffect(() => {
    if (!publicKey) {
      hasRestoredRef.current = false;
      return;
    }
    if (hasRestoredRef.current) return;
    hasRestoredRef.current = true;

    const cached = localStorage.getItem(`${TEE_TOKEN_STORAGE}_${publicKey.toBase58()}`);
    if (!cached) return;
    try {
      const { token, expiry } = JSON.parse(cached);
      if (expiry <= Date.now()) {
        localStorage.removeItem(`${TEE_TOKEN_STORAGE}_${publicKey.toBase58()}`);
        return;
      }

      // Trust cache immediately — set player token without waiting for validation
      const conn = new Connection(`${TEE_BASE}?token=${token}`, { commitment: 'confirmed', wsEndpoint: DUMMY_WS });
      setAuthToken(token);
      tokenExpiryRef.current = expiry;
      validatorConnsRef.current.set(TEE_BASE, conn);
      setValidatorConnections(new Map(validatorConnsRef.current));
      setCurrentTeeConnection(conn);
      setTokenType('player');
      consecutiveFailuresRef.current = 0;
      console.log('[GameAuth] Restored cached player token (expiry in', Math.round((expiry - Date.now()) / 60000), 'min)');
      scheduleRefresh();

      // Background validation — if token is actually stale (TEE restarted), clear it.
      // Validate the tokenized TEE connection directly so static LIGHT builds do not
      // depend on a node-only /api/tee/token route.
      void conn.getSlot('confirmed').catch(() => {
        console.warn('[GameAuth] Cached token invalid on validation — clearing');
        localStorage.removeItem(`${TEE_TOKEN_STORAGE}_${publicKey.toBase58()}`);
        // Fall back to authority token silently
        setTokenType('none');
        tokenExpiryRef.current = 0;
        getAuthorityToken(true).then(ok => {
          if (ok) scheduleRefresh();
        });
      });
    } catch {}
  }, [publicKey, scheduleRefresh, getAuthorityToken]);

  // ─── Auto-authenticate (authority token, silent) ───
  // The authority token is SERVER-issued and read-only — it does not need a
  // wallet. This used to bootstrap only on wallet connect, which left anyone
  // without a connected wallet (spectators, shared /game links, players whose
  // wallet hydration is slow) on "Loading Table…" FOREVER: teeAuthenticated
  // stayed false, so useOnChainGame never started polling at all. Found via
  // headless spectator repro on devnet, 2026-06-10. Bootstrap unconditionally;
  // wallet connect still upgrades to a player token via the cached-restore and
  // authenticatePlayer paths exactly as before.
  const hasAutoAuthedRef = useRef(false);
  useEffect(() => {
    if (!publicKey) {
      hasAutoAuthedRef.current = false;
      if (tokenTypeRef.current === 'player') {
        // Wallet disconnected: the player token belongs to that wallet session.
        // Drop it; the fall-through below re-acquires an authority token so
        // public table reads keep working.
        setAuthToken(null);
        setTokenType('none');
        setCurrentTeeConnection(plainConnection);
        tokenExpiryRef.current = 0;
      }
      // NOTE: no early return — anonymous viewers need the authority token too.
    }
    // Skip if already have a valid token (restored from cache)
    if (tokenExpiryRef.current > Date.now()) return;
    if (hasAutoAuthedRef.current) return;

    hasAutoAuthedRef.current = true;
    (async () => {
      setIsAuthenticating(true);
      const ok = await getAuthorityToken(false);
      setIsAuthenticating(false);
      if (ok) {
        console.log(publicKey
          ? '[GameAuth] Authority token on wallet connect'
          : '[GameAuth] Authority token (anonymous viewer)');
        scheduleRefresh();
      } else {
        // Don't latch a failed attempt — allow a retry on the next effect run.
        hasAutoAuthedRef.current = false;
      }
    })();
  }, [publicKey, plainConnection, getAuthorityToken, scheduleRefresh]);

  // ─── Health monitoring: periodic check that TEE connection works ───
  useEffect(() => {
    if (!authToken) return;

    const checkHealth = async () => {
      try {
        await teeConnection.getSlot('confirmed');
        reportHealth('tee', 'ok');
        consecutiveFailuresRef.current = 0;
      } catch {
        reportHealth('tee', 'degraded', 'health probe failed');
        consecutiveFailuresRef.current++;
        console.warn(`[GameAuth] Health check failed (${consecutiveFailuresRef.current}/${MAX_CONSECUTIVE_FAILURES})`);
        if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailuresRef.current = 0;
          const wasPlayer = tokenTypeRef.current === 'player';

          // Try to restore player token from localStorage cache first
          if (wasPlayer && publicKey) {
            const cached = localStorage.getItem(`${TEE_TOKEN_STORAGE}_${publicKey.toBase58()}`);
            if (cached) {
              try {
                const { token, expiry } = JSON.parse(cached);
                if (expiry > Date.now()) {
                  const testConn = new Connection(`${TEE_BASE}?token=${token}`, { commitment: 'confirmed', wsEndpoint: DUMMY_WS });
                  await testConn.getSlot('confirmed');
                  // Cache is still valid — restore it
                  setAuthToken(token);
                  tokenExpiryRef.current = expiry;
                  validatorConnsRef.current.set(TEE_BASE, testConn);
                  setValidatorConnections(new Map(validatorConnsRef.current));
                  setCurrentTeeConnection(testConn);
                  setTokenType('player');
                  console.log('[GameAuth] Restored player token from cache after health failure');
                  scheduleRefresh();
                  return;
                }
              } catch {
                // Cached token truly dead — remove it
                localStorage.removeItem(`${TEE_TOKEN_STORAGE}_${publicKey.toBase58()}`);
              }
            }
          }

          // Fallback: get authority token to restore basic reads
          console.warn('[GameAuth] Falling back to authority token');
          const ok = await getAuthorityToken(true);
          if (ok) scheduleRefresh();
        }
      }
    };

    // Jittered initial delay so 1000 tabs opening together don't all probe
    // TEE health at the same wall-clock offset. After the first fire the
    // cadence is regular but per-session phase is randomized.
    const initialDelay = Math.random() * HEALTH_CHECK_INTERVAL_MS;
    let startTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      startTimer = null;
      void checkHealth();
      healthTimerRef.current = setInterval(checkHealth, HEALTH_CHECK_INTERVAL_MS);
    }, initialDelay);
    return () => {
      if (startTimer) clearTimeout(startTimer);
      if (healthTimerRef.current) clearInterval(healthTimerRef.current);
    };
  }, [authToken, teeConnection, getAuthorityToken, scheduleRefresh]);

  // ─── Public: trigger player auth (signMessage) — fire-and-forget ───
  const authenticatePlayer = useCallback(async () => {
    if (isAuthPendingRef.current) return;
    // Use ref (sync) not state (async) to avoid race with React batched updates
    if (tokenTypeRef.current === 'player' && tokenExpiryRef.current > Date.now()) return;
    // If a valid cached token exists AND the restore effect hasn't run yet, it
    // will apply it — skip the popup during that mount race. But once restore
    // has run (hasRestoredRef set) and we're STILL not player-ready, the cache
    // is not being applied (e.g. Privy wallet came up late on refresh), so fall
    // through and actually authenticate instead of dead-ending the button.
    if (publicKey && !hasRestoredRef.current) {
      try {
        const cached = localStorage.getItem(`${TEE_TOKEN_STORAGE}_${publicKey.toBase58()}`);
        if (cached) {
          const { expiry } = JSON.parse(cached);
          if (expiry > Date.now()) return;
        }
      } catch {}
    }
    isAuthPendingRef.current = true;
    setIsAuthenticating(true);
    try {
      const ok = await getPlayerToken();
      if (ok) scheduleRefresh();
      else await getAuthorityToken(true); // fallback
    } finally {
      setIsAuthenticating(false);
      isAuthPendingRef.current = false;
    }
  }, [getPlayerToken, getAuthorityToken, scheduleRefresh]);

  // ─── Public: gate check — returns true if player token active, triggers auth if not ───
  const ensurePlayerAuth = useCallback(async (): Promise<boolean> => {
    // Already have valid player token — use ref (sync) not state (async)
    if (tokenTypeRef.current === 'player' && tokenExpiryRef.current > Date.now()) return true;
    // Try to get player token (will show signMessage popup)
    if (isAuthPendingRef.current) {
      console.warn('[JOIN-AUTH] ensurePlayerAuth: auth already in progress (isAuthPendingRef=true) — returning false');
      return false;
    }
    console.log('[JOIN-AUTH] ensurePlayerAuth: starting player token fetch');
    isAuthPendingRef.current = true;
    setIsAuthenticating(true);
    try {
      const ok = await getPlayerToken();
      if (ok) {
        scheduleRefresh();
        return true;
      }
      console.error('[JOIN-AUTH] ensurePlayerAuth: getPlayerToken returned false — see above for specific reason');
      return false;
    } catch (e: any) {
      console.error('[JOIN-AUTH] ensurePlayerAuth: unexpected error:', e.message);
      return false;
    } finally {
      setIsAuthenticating(false);
      isAuthPendingRef.current = false;
    }
  }, [getPlayerToken, scheduleRefresh]);

  // ─── Public: gate check + fresh tokenized connection ───
  // React state publishes teeConnection on the next render. Action sends often
  // happen inside the same click handler that just authenticated, so return the
  // connection from refs updated synchronously by getPlayerTokenForValidator().
  const ensurePlayerConnection = useCallback(async (validatorUrl = TEE_BASE): Promise<Connection | null> => {
    const target = validatorUrl || TEE_BASE;
    const isDefault = target === TEE_BASE || target === getDefaultValidator().rpcUrl;
    const existing = isDefault ? teeConnectionRef.current : validatorConnsRef.current.get(target);
    if (existing?.rpcEndpoint.includes('token=') && tokenExpiryRef.current > Date.now()) {
      return existing;
    }
    if (isAuthPendingRef.current) {
      console.warn('[JOIN-AUTH] ensurePlayerConnection: auth already in progress — returning null');
      return null;
    }
    console.log(`[JOIN-AUTH] ensurePlayerConnection: starting player token fetch for ${target}`);
    isAuthPendingRef.current = true;
    setIsAuthenticating(true);
    try {
      const ok = await getPlayerTokenForValidator(target);
      if (!ok) {
        console.error('[JOIN-AUTH] ensurePlayerConnection: getPlayerTokenForValidator returned false');
        return null;
      }
      scheduleRefresh();
      return isDefault ? teeConnectionRef.current : (validatorConnsRef.current.get(target) ?? null);
    } catch (e: any) {
      console.error('[JOIN-AUTH] ensurePlayerConnection: unexpected error:', e.message);
      return null;
    } finally {
      setIsAuthenticating(false);
      isAuthPendingRef.current = false;
    }
  }, [getPlayerTokenForValidator, scheduleRefresh]);

  // ─── Public: force refresh (recovery) ───
  // Attempts to restore player-level auth (tries cached token first, then authority fallback).
  // Does NOT pop up signMessage — that would be disruptive during gameplay.
  const forceRefresh = useCallback(async () => {
    setAuthToken(null);
    setCurrentTeeConnection(plainConnection);
    tokenExpiryRef.current = 0;
    setTokenType('none');
    isAuthPendingRef.current = false;

    // Try to restore cached player token BEFORE falling back to authority
    // But if we've already tried the cache 2+ times and cards still fail,
    // the cached token is stale (getSlot passes without auth, but permissioned reads fail).
    // In that case, clear the cache and force a fresh signMessage.
    if (publicKey) {
      const pub = publicKey.toBase58();
      const cacheKey = `${TEE_TOKEN_STORAGE}_${pub}`;

      if (cacheRestoreAttemptsRef.current >= 2) {
        // Cache has been tried and failed — clear it and force fresh auth
        console.log('[GameAuth] forceRefresh: cache failed 2x, clearing and requesting fresh signMessage');
        localStorage.removeItem(cacheKey);
        cacheRestoreAttemptsRef.current = 0;
        // Force fresh player token via signMessage popup
        setIsAuthenticating(true);
        try {
          const ok = await getPlayerToken();
          if (ok) {
            console.log('[GameAuth] forceRefresh: fresh player token obtained via signMessage');
            scheduleRefresh();
            return;
          }
        } catch (e: any) {
          console.warn('[GameAuth] forceRefresh: signMessage failed:', e.message?.slice(0, 80));
        } finally {
          setIsAuthenticating(false);
        }
        // If signMessage failed/rejected, fall through to authority
      } else {
        try {
          const cached = localStorage.getItem(cacheKey);
          if (cached) {
            const { token, expiry } = JSON.parse(cached);
            if (expiry > Date.now()) {
              const testConn = new Connection(`${TEE_BASE}?token=${token}`, { commitment: 'confirmed', wsEndpoint: DUMMY_WS });
              try {
                await testConn.getSlot('confirmed');
                // Cached player token still valid — restore it
                setAuthToken(token);
                tokenExpiryRef.current = expiry;
                validatorConnsRef.current.set(TEE_BASE, testConn);
                setValidatorConnections(new Map(validatorConnsRef.current));
                setCurrentTeeConnection(testConn);
                setTokenType('player');
                consecutiveFailuresRef.current = 0;
                cacheRestoreAttemptsRef.current++;
                console.log(`[GameAuth] forceRefresh: restored player token from cache (attempt ${cacheRestoreAttemptsRef.current})`);
                scheduleRefresh();
                return;
              } catch {
                // Token dead — remove and fall through
                localStorage.removeItem(cacheKey);
                cacheRestoreAttemptsRef.current = 0;
              }
            } else {
              localStorage.removeItem(cacheKey);
            }
          }
        } catch {}
      }
    }

    // Fallback: authority token (reads table/seats but not hole cards)
    setIsAuthenticating(true);
    try {
      await getAuthorityToken(true);
      scheduleRefresh();
    } finally {
      setIsAuthenticating(false);
    }
  }, [publicKey, plainConnection, getAuthorityToken, getPlayerToken, scheduleRefresh]);

  // ─── Cleanup timers on unmount ───
  useEffect(() => {
    return () => {
      if (healthTimerRef.current) clearInterval(healthTimerRef.current);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // ─── Derive unified status ───
  const status: AuthStatus = useMemo(() => {
    if (!publicKey) return 'disconnected';
    if (isAuthenticating && !authToken) return 'connecting';
    if (!authToken) return 'disconnected';

    const sessionOk = session.isActive;
    const teeOk = tokenExpiryRef.current > Date.now();

    if (!teeOk) return 'degraded';
    if (tokenType === 'player' && sessionOk) return 'ready';
    if (tokenType === 'authority') return 'browse';
    // Player token but no session — still good for reads + will create session on join
    if (tokenType === 'player') return 'browse';
    return 'degraded';
  }, [publicKey, isAuthenticating, authToken, tokenType, session.isActive]);

  const isPlayerReady = tokenType === 'player' && tokenExpiryRef.current > Date.now();

  // Multi-validator: helper to get connection for a specific validator URL
  const getConnectionForValidator = useCallback((rpcUrl: string): Connection => {
    return validatorConnsRef.current.get(rpcUrl) || plainConnection;
  }, [plainConnection]);

  // Multi-validator: trigger player signMessage auth for a specific validator
  const authenticatePlayerForValidator = useCallback(async (validatorUrl: string): Promise<boolean> => {
    return getPlayerTokenForValidator(validatorUrl);
  }, [getPlayerTokenForValidator]);

  const value: GameAuthState = {
    status,
    teeConnection,
    teeTokenType: tokenType,
    teeAuthenticated: !!authToken,
    isTeeAuthenticating: isAuthenticating,
    isPlayerReady,
    teeTokenExpiresAt: tokenExpiryRef.current,
    validatorConnections,
    getConnectionForValidator,
    sessionActive: session.isActive,
    sessionStatus: session.status,
    authenticatePlayer,
    authenticatePlayerForValidator,
    ensurePlayerAuth,
    ensurePlayerConnection,
    forceRefresh,
    plainConnection,
  };

  return React.createElement(GameAuthContext.Provider, { value }, children);
}
