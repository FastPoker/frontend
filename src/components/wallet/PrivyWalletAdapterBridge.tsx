'use client';

import { useEffect, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { usePrivy } from '@privy-io/react-auth';
import { useStandardWallets, useWallets as useConnectedSolanaWallets } from '@privy-io/react-auth/solana';
import { getWallets } from '@wallet-standard/app';

const PRIVY_ENABLED = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const DEBUG = true;
const log = (...args: unknown[]) => { if (DEBUG) console.log('[PrivyBridge]', ...args); };
const warn = (...args: unknown[]) => { if (DEBUG) console.warn('[PrivyBridge]', ...args); };

export function PrivyWalletAdapterBridge() {
  if (!PRIVY_ENABLED) return null;
  return <Bridge />;
}

function Bridge() {
  const wa = useWallet();
  const privy = usePrivy();
  const std = useStandardWallets();
  const connected = useConnectedSolanaWallets();
  const registeredRef = useRef<WeakSet<object>>(new WeakSet());
  const connectAttemptedRef = useRef<string | null>(null);
  const lastSelectedRef = useRef<string | null>(null);

  // Wait for Privy to actually have a connected embedded wallet (not just auth).
  // useWallets() (Solana) only returns wallets that have addresses.
  const connectedCount = connected.wallets?.length ?? 0;
  const ready = privy.ready && privy.authenticated && connectedCount > 0;

  const privyReady = privy.ready;
  const privyAuth = privy.authenticated;
  const waConnected = wa.connected;
  const waConnecting = wa.connecting;
  const waWalletName = wa.wallet?.adapter.name ?? null;
  const waWalletNamesKey = wa.wallets.map((w) => w.adapter.name).join('|');

  // 1. Register Privy standard wallets only after they have at least one account.
  useEffect(() => {
    if (!ready) {
      log('register skipped — not ready', { privyReady, privyAuth, connectedCount });
      return;
    }
    if (!std.wallets?.length) return;
    const reg = getWallets();
    for (const w of std.wallets) {
      if (registeredRef.current.has(w as object)) continue;
      const accounts = (w as any).accounts ?? [];
      if (accounts.length === 0) {
        log('register skipped — wallet has 0 accounts', (w as any).name);
        continue;
      }
      try {
        log('registering standard wallet', (w as any).name, 'accounts:', accounts.length);
        reg.register(w as any);
        registeredRef.current.add(w as object);
      } catch (e) {
        warn('register threw', e);
      }
    }
  }, [ready, std.wallets, privyReady, privyAuth, connectedCount]);

  // 2. Auto-select Privy adapter once it surfaces in wa.wallets.
  useEffect(() => {
    if (!ready) return;
    if (waConnected || waConnecting) return;
    if (waWalletName && /privy/i.test(waWalletName)) return;
    const target = wa.wallets.find((w) => /privy/i.test(w.adapter.name));
    if (!target) {
      log('no privy adapter visible yet; wa.wallets =', waWalletNamesKey || '<empty>');
      return;
    }
    if (lastSelectedRef.current === target.adapter.name) return;
    lastSelectedRef.current = target.adapter.name;
    log('selecting', target.adapter.name);
    try {
      wa.select(target.adapter.name);
    } catch (e) {
      warn('select threw', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, waConnected, waConnecting, waWalletName, waWalletNamesKey]);

  // 3. Connect after select.
  useEffect(() => {
    if (!ready) return;
    if (!waWalletName) return;
    if (waConnected || waConnecting) return;
    if (!/privy/i.test(waWalletName)) return;
    if (connectAttemptedRef.current === waWalletName) return;
    connectAttemptedRef.current = waWalletName;
    log('calling wa.connect()', waWalletName);
    wa.connect().then(
      () => log('connect resolved'),
      (e) => {
        warn('connect rejected', e?.name, e?.message ?? e);
        // Reset so a later state change can retry.
        connectAttemptedRef.current = null;
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, waWalletName, waConnected, waConnecting]);

  // Reset guards on disconnect.
  useEffect(() => {
    if (!waConnected && !waWalletName) {
      lastSelectedRef.current = null;
      connectAttemptedRef.current = null;
    }
  }, [waConnected, waWalletName]);

  // 4. Logout sync.
  useEffect(() => {
    if (!privyReady) return;
    if (privyAuth) return;
    if (!waConnected || !waWalletName) return;
    if (!/privy/i.test(waWalletName)) return;
    log('privy logged out; disconnecting wa');
    wa.disconnect().catch(() => {});
    lastSelectedRef.current = null;
    connectAttemptedRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privyReady, privyAuth, waConnected, waWalletName]);

  return null;
}
