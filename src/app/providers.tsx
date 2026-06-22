'use client';

// Defensive secondary import — primary polyfill load is in providers-client.tsx
// (eager). Keeping it here too in case providers.tsx is the first chunk to
// load on a particular route. Idempotent (guards via typeof checks inside).
import '@/lib/buffer-polyfill';

import { useMemo, useState, useEffect } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { PrivyProvider } from '@privy-io/react-auth';
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { L1_RPC, L1_WS_RPC } from '@/lib/constants';
import { shouldUsePool, getPublicPool, makeRotatingFetch } from '@/lib/rpc-pool';
import { getEffectiveRpcUrl, getEffectiveWsUrl } from '@/lib/user-config';
import { SessionProvider } from '@/hooks/useSession';
import { GameAuthProvider } from '@/hooks/useGameAuth';
import { FundsConfirmProvider } from '@/components/wallet/FundsConfirmProvider';
import { ConnectModalProvider } from '@/components/wallet/FastPokerConnectModal';
import { PrivyWalletAdapterBridge } from '@/components/wallet/PrivyWalletAdapterBridge';
import { InsufficientFundsProvider } from '@/components/wallet/InsufficientFundsModal';
import { ToastProvider } from '@/components/toast/ToastProvider';
import { PRIVY_APP_ID, PRIVY_AUTH_ENABLED, PRIVY_LOGIN_METHODS } from '@/lib/privy-config';

import '@solana/wallet-adapter-react-ui/styles.css';

export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const network = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER || '').toLowerCase().startsWith('mainnet')
    ? WalletAdapterNetwork.Mainnet
    : WalletAdapterNetwork.Devnet;

  const wallets = useMemo(
    () => [
      // Phantom is injected via wallet-standard; adding a legacy adapter here
      // can cause duplicate registration / flaky connect behavior in some browsers.
      new SolflareWalletAdapter({ network }),
    ],
    [network]
  );

  const solanaConnectors = useMemo(() => toSolanaWalletConnectors(), []);
  // Standalone MVP: when no single RPC is configured, the wallet-adapter
  // ConnectionProvider also uses the rotating public pool (failover on 403/429),
  // so wallet sends + adapter reads work on free public APIs.
  const usePool = shouldUsePool();
  const poolEndpoints = useMemo(() => getPublicPool(), []);
  const byoRpc = getEffectiveRpcUrl() || L1_RPC;
  const byoWs = getEffectiveWsUrl();
  const connEndpoint = usePool ? poolEndpoints[0] : byoRpc;
  const connectionConfig = useMemo(
    () => usePool
      ? { commitment: 'confirmed' as const, fetch: makeRotatingFetch(poolEndpoints) }
      : (byoWs
          ? { commitment: 'confirmed' as const, wsEndpoint: byoWs }
          : { commitment: 'confirmed' as const }),
    [usePool, poolEndpoints, byoWs],
  );
  const subscriptionRpc = byoWs || connEndpoint.replace(/^http/, 'ws');

  // Prevent hydration mismatch by only rendering wallet components on client
  useEffect(() => {
    setMounted(true);
  }, []);

  // Suppress benign WalletDisconnectedError noise. Emitted by
  // @solana/wallet-adapter-base when the Privy standard-wallet adapter tears
  // down on disconnect — purely informational, doesn't break anything but
  // clutters the console on every Switch wallet click.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Env flag (NEXT_PUBLIC_DEBUG_LOGS=1, needs restart) OR a live localStorage
    // toggle so tagged debug streams can be turned on in the browser without a
    // rebuild: run `localStorage.fpDebug = '1'` in the console + reload.
    // URL toggle: `?fpdebug=1` is the most reliable — it's read on every load
    // (no console + reload-timing dance), and we persist it to localStorage so
    // it survives subsequent navigations. `?fpdebug=0` clears it.
    let urlDebug: boolean | null = null;
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.has('fpdebug')) {
        urlDebug = sp.get('fpdebug') !== '0';
        window.localStorage?.setItem('fpDebug', urlDebug ? '1' : '0');
      }
    } catch { /* blocked */ }
    let lsDebug = false;
    try { lsDebug = window.localStorage?.getItem('fpDebug') === '1'; } catch { /* SSR / blocked storage */ }
    const debugOn = process.env.NEXT_PUBLIC_DEBUG_LOGS === '1' || (urlDebug ?? false) || lsDebug;

    const origError = console.error;
    const isWalletNoise = (a: unknown): boolean => {
      if (a instanceof Error && a.name === 'WalletDisconnectedError') return true;
      if (typeof a === 'string' && a.includes('WalletDisconnectedError')) return true;
      return false;
    };
    // Gasless gameplay rejects — the contract refusing an action (not-your-turn,
    // invalid-for-phase 6021, can't-check, etc.) — are EXPECTED and already
    // surfaced to the player as friendly toasts by the action handlers (and
    // handleSitIn auto-recovers the 6021 sit-in race). They reach the console via
    // sendAction's "session action TX err" logger, which in dev pops the Next
    // error overlay as if they were crashes. Drop only those handled codes;
    // genuine session failures (InvalidSessionKey, expired, etc.) still log.
    const HANDLED_GAMEPLAY_REJECT = /session action TX err[\s\S]*"Custom":\s*(6007|602[1-8])/;
    const isHandledGameplayReject = (a: unknown): boolean => {
      const s = a instanceof Error ? a.message : typeof a === 'string' ? a : '';
      return HANDLED_GAMEPLAY_REJECT.test(s);
    };
    console.error = (...args: unknown[]) => {
      if (args.some(isWalletNoise)) return;
      if (args.some(isHandledGameplayReject)) return;
      origError(...args);
    };

    // Gate verbose tagged debug streams ([FP-DEBUG], [JOIN-AUTH], [GameAuth],
    // [WS], [SNG-DEBUG], ...) behind NEXT_PUBLIC_DEBUG_LOGS so the console
    // stays clean by default. Set NEXT_PUBLIC_DEBUG_LOGS=1 (+ restart) to
    // re-enable. Only drops messages whose first arg is one of those tags, so
    // real logs/warnings still come through.
    const DEBUG_TAG = /^\s*\[(FP-DEBUG|JOIN-AUTH|GameAuth|WS|SNG-DEBUG|rathole|cancel-deposit)\b/;
    const origLog = console.log;
    const origInfo = console.info;
    const origDebug = console.debug;
    const origWarn = console.warn;
    const gate = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
      if (typeof args[0] === 'string' && DEBUG_TAG.test(args[0])) return;
      orig(...args);
    };
    if (!debugOn) {
      console.log = gate(origLog);
      console.info = gate(origInfo);
      console.debug = gate(origDebug);
      console.warn = gate(origWarn);
    }

    return () => {
      console.error = origError;
      console.log = origLog;
      console.info = origInfo;
      console.debug = origDebug;
      console.warn = origWarn;
    };
  }, []);

  const tree = (
    <ConnectionProvider endpoint={connEndpoint} config={connectionConfig}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SessionProvider>
            <GameAuthProvider>
              <FundsConfirmProvider>
                <ConnectModalProvider>
                  <InsufficientFundsProvider>
                    <ToastProvider>
                      <PrivyWalletAdapterBridge />
                      {mounted ? children : <div style={{ visibility: 'hidden' }}>{children}</div>}
                    </ToastProvider>
                  </InsufficientFundsProvider>
                </ConnectModalProvider>
              </FundsConfirmProvider>
            </GameAuthProvider>
          </SessionProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );

  if (!PRIVY_AUTH_ENABLED) return tree;

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: PRIVY_LOGIN_METHODS as any,
        appearance: {
          theme: 'dark',
          accentColor: '#F26A1F',
          logo: '/brand/app-icon.png',
          walletChainType: 'solana-only',
        },
        embeddedWallets: {
          solana: { createOnLogin: 'users-without-wallets' },
          // Embedded wallets sign headlessly; we surface our own confirmations
          // via FundsConfirmProvider. Without this, Privy opens a "connect to
          // wallet" modal whose onFailure throws "Failed to connect to wallet"
          // on every send via @solana/wallet-adapter.
          showWalletUIs: false,
        },
        externalWallets: { solana: { connectors: solanaConnectors } },
        solana: {
          // Expose ONLY the cluster the app actually runs on, via our own RPC
          // (L1_RPC). Listing a mainnet RPC let Privy default sends to the
          // public api.mainnet-beta.solana.com endpoint (403 Forbidden) while
          // we're on devnet — which broke every Privy send (joins, claims,
          // buy-ins) and made balances read on the wrong chain.
          rpcs: {
            [network === WalletAdapterNetwork.Mainnet ? 'solana:mainnet' : 'solana:devnet']: {
              rpc: createSolanaRpc(L1_RPC) as any,
              rpcSubscriptions: createSolanaRpcSubscriptions(subscriptionRpc) as any,
              blockExplorerUrl: network === WalletAdapterNetwork.Mainnet
                ? 'https://explorer.solana.com'
                : 'https://explorer.solana.com?cluster=devnet',
            },
          },
        },
      }}
    >
      {tree}
    </PrivyProvider>
  );
}
