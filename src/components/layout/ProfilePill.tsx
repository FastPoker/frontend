'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import Image from 'next/image';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { useConnectModal } from '@/components/wallet/FastPokerConnectModal';
import { usePrivy } from '@privy-io/react-auth';
import { useExportWallet } from '@privy-io/react-auth/solana';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { getAvatarById, type AvatarOption } from '@/lib/avatars';
import { AvatarRender, type AvatarSelection } from '@/components/profile/avatars/AvatarRender';
import { AvatarRing, tierForLevel, LEVEL_XP, levelFromXp, xpForLevel } from '@/components/progression/AvatarRing';
import { ClaimableDropdown } from '@/components/claimable/ClaimableDropdown';
import { useClaimableTotals } from '@/hooks/useClaimableTotals';
import { useWalletBalances } from '@/hooks/useWalletBalances';
import { SessionModal } from './SessionModal';
import { TransferFundsModal } from '@/components/modals/TransferFundsModal';
import { SFX } from '@/lib/sfx';
import { PROFILE_API_ENABLED } from '@/lib/feature-flags';
import { BRAND } from '@/lib/branding';

function shortWallet(addr: string, n = 4): string {
  return `${addr.slice(0, n)}…${addr.slice(-n)}`;
}

function MenuIcon({ d }: { d: string }) {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export function ProfilePill() {
  const w = useUnifiedWallet();
  const { open: openConnect } = useConnectModal();
  const connected = w.isConnected;
  const publicKey = w.publicKey;
  const disconnect = w.logout;
  const { authenticated: privyAuthenticated, user: privyUser } = usePrivy();
  const { exportWallet } = useExportWallet();
  const pathname = usePathname() || '';
  const [open, setOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [avatar, setAvatar] = useState<AvatarOption | null>(null);
  const [avatarSelection, setAvatarSelection] = useState<AvatarSelection | null>(null);
  const [avatarImageUrl, setAvatarImageUrl] = useState<string | null>(null);
  const [avatarCollectionColor, setAvatarCollectionColor] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [activeFrame, setActiveFrame] = useState<
    'default' | 'silver-ring' | 'gold-laurel' | 'plat-octogram' | 'prism-diamond' | 'matte-black'
    | 'royal-flush' | 'monster-bone' | 'infinite-loop' | 'early-bird'
  >('default');
  // SOL/POKER balances + XP come from the shared wallet-balance hook. The hook
  // owns its polling so this menu and the global claimables UI do not duplicate
  // wallet reads.
  const wb = useWalletBalances();
  const solBalance: number | undefined = wb.loading ? undefined : wb.solBalance;
  const pokerBalance: number | undefined = wb.loading ? undefined : wb.pokerBalance;
  const totalXp = wb.xp;
  const ref = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimRect, setClaimRect] = useState<DOMRect | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [sfxMuted, setSfxMuted] = useState(() => (typeof window !== 'undefined' ? SFX.isMuted() : false));

  // walletStr is used by avatar/handle UI below. XP is delivered by
  // useWalletBalances above.
  const walletStr = publicKey?.toBase58() ?? '';
  const embeddedSolanaWallet = privyUser?.linkedAccounts?.find((account) => {
    const linked = account as {
      type?: string;
      address?: string;
      chainType?: string;
      chain_type?: string;
      walletClientType?: string;
      wallet_client_type?: string;
    };
    return linked.type === 'wallet'
      && (linked.chainType === 'solana' || linked.chain_type === 'solana')
      && (linked.walletClientType === 'privy' || linked.wallet_client_type === 'privy');
  }) as { address?: string } | undefined;
  const embeddedWalletAddress = typeof embeddedSolanaWallet?.address === 'string' ? embeddedSolanaWallet.address : null;
  const exportWalletAddress = w.source === 'privy-embedded' && walletStr
    ? walletStr
    : embeddedWalletAddress && embeddedWalletAddress === walletStr
      ? embeddedWalletAddress
      : null;
  const canExportPrivyWallet = privyAuthenticated && !!exportWalletAddress;
  const level = levelFromXp(totalXp);
  const xp = totalXp - xpForLevel(level);
  const tier = tierForLevel(level);

  const { totals: claimable, hasClaimable, onClaim: onClaimableAction } = useClaimableTotals();
  const claimableSol = claimable.sngSol + claimable.stakingSol;
  const claimablePoker = claimable.pokerUnrefined + claimable.pokerRefined;

  const openClaim = () => {
    if (pillRef.current) setClaimRect(pillRef.current.getBoundingClientRect());
    setClaimOpen(true);
    setOpen(false);
  };

  const exportPrivyWallet = () => {
    if (!exportWalletAddress) return;
    setOpen(false);
    exportWallet({ address: exportWalletAddress }).catch(() => {});
  };

  // Active cosmetic frame — read from localStorage written by optional profile tooling.
  // Listen for storage events so the pill updates live when changed in the picker.
  useEffect(() => {
    if (!publicKey) { setActiveFrame('default'); return; }
    const key = `fp.activeFrame.${publicKey.toBase58()}`;
    const legacyKey = `fp.blackBenefits.${publicKey.toBase58()}`;
    const read = () => {
      try {
        const stored = localStorage.getItem(key);
        if (stored) {
          setActiveFrame(stored as typeof activeFrame);
        } else if (localStorage.getItem(legacyKey) === '1') {
          setActiveFrame('matte-black');
        } else {
          setActiveFrame('default');
        }
      } catch { /* ignore */ }
    };
    read();
    const onStorage = (e: StorageEvent) => { if (e.key === key || e.key === legacyKey) read(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [publicKey]);

  useEffect(() => {
    if (!publicKey) {
      setAvatar(null);
      setAvatarSelection(null);
      setAvatarImageUrl(null);
      setAvatarCollectionColor(null);
      setHandle(null);
      return;
    }
    let cancelled = false;
    // Public source release ships no /api/profile backend; show the wallet
    // unless an operator explicitly adds and enables a compatible profile API.
    if (!PROFILE_API_ENABLED) return;
    fetch(`/api/profile?wallet=${publicKey.toBase58()}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        // Profile shape: avatarType / avatarValue / avatarSeed /
        // avatarImageUrl / avatarUrl / avatarCollection / avatarCollectionColor.
        const type = (data?.avatarType || 'generated') as AvatarSelection['type'];
        const value = data?.avatarValue || publicKey.toBase58();
        const seed = data?.avatarSeed || '';
        const collection = data?.avatarCollection || '';
        // Image URL: prefer explicit avatarImageUrl, then avatarUrl,
        // then resolve from AVATAR_OPTIONS by id (Early Bird PFPs, curated picks).
        const known = value ? getAvatarById(value) : null;
        const resolvedImageUrl =
          (typeof data?.avatarImageUrl === 'string' && data.avatarImageUrl) ||
          (typeof data?.avatarUrl === 'string' && data.avatarUrl) ||
          known?.image ||
          '';
        setAvatarSelection({ type, value, collection, seed });
        setAvatarImageUrl(resolvedImageUrl || null);
        setAvatarCollectionColor(data?.avatarCollectionColor || null);
        if (known) setAvatar(known);
        else if (resolvedImageUrl) setAvatar({ id: value, image: resolvedImageUrl, label: 'avatar' } as AvatarOption);
        else setAvatar(null);
        // API field is `username`, not `handle`.
        const name = data?.username || data?.handle;
        if (name) setHandle(name);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [publicKey]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        ref.current && !ref.current.contains(t) &&
        (!menuRef.current || !menuRef.current.contains(t))
      ) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // pointerdown (not mousedown): iOS Safari does NOT fire mousedown for taps
    // on non-interactive areas, so an outside tap never closed the menu there.
    // pointerdown fires for mouse + touch + pen, so close works on all devices.
    document.addEventListener('pointerdown', handler);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', handler);
      document.removeEventListener('keydown', key);
    };
  }, []);

  useEffect(() => { setOpen(false); }, [pathname]);

  // The dropdown is portaled to <body> to escape the navbar's flattened
  // stacking context (body.fp-site-bg > * { z-index: 1 }), so position it
  // against the pill via fixed coords and keep it pinned on scroll/resize.
  useEffect(() => {
    if (!open) { setMenuPos(null); return; }
    const update = () => {
      const r = pillRef.current?.getBoundingClientRect();
      if (r) setMenuPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  if (!connected || !publicKey) {
    return (
      <button
        onClick={() => openConnect()}
        aria-label="Connect wallet"
        className="relative flex items-center gap-2 px-2.5 sm:px-3.5 py-1.5 rounded-md btn-orange font-mono text-[10px] tracking-[0.22em] font-bold leading-none shrink-0"
        style={{ height: 34 }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="4" width="12" height="9" rx="1.5" />
          <path d="M2 7h12M11 10h1" />
        </svg>
        <span className="hidden sm:inline">SIGN IN</span>
        <span className="sm:hidden">SIGN IN</span>
      </button>
    );
  }

  const displayHandle = handle || shortWallet(walletStr);
  const xpPct = Math.round((100 * xp) / Math.max(1, LEVEL_XP(level)));

  const copy = () => {
    try { navigator.clipboard?.writeText(walletStr); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <>
      <div className="relative" ref={ref}>
        <button
          ref={pillRef}
          onClick={() => setOpen(v => !v)}
          className={cn(
            'relative flex items-center gap-2 pl-1.5 pr-2.5 py-1 rounded-md transition group',
            activeFrame === 'matte-black'
              ? 'hover:brightness-110'
              : cn('hairline bg-ink/50 hover:bg-ink/80', open && 'bg-ink/80 border-orange/40'),
          )}
          style={activeFrame === 'matte-black' ? {
            height: 34,
            background: 'linear-gradient(180deg, #050505 0%, #000000 100%)',
            border: '1px solid rgba(245,241,230,0.55)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 4px 14px rgba(0,0,0,0.6)',
          } : { height: 34 }}
        >
          {hasClaimable && !open && (
            <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center z-10">
              <span className="absolute w-3 h-3 rounded-full bg-emerald-400/40 animate-ping" />
              <span className="relative w-2 h-2 rounded-full bg-emerald-400 border border-ink" style={{ boxShadow: '0 0 6px rgba(52,211,153,0.9)' }} />
            </span>
          )}
          <AvatarRing
            size={26}
            level={level}
            xp={xp}
            seed={walletStr}
            avatarSrc={avatar?.image ?? null}
            avatarLabel={avatar?.label ?? 'avatar'}
            frameAnim="subtle"
            frame={activeFrame}
            innerNode={avatarSelection ? (
              <AvatarRender
                avatar={avatarSelection}
                nft={{ imageUrl: avatarImageUrl, collectionColor: avatarCollectionColor || undefined }}
                size={26}
              />
            ) : undefined}
          />
          {/* Full identity block on every route (incl. game pages) — visibility
              is driven only by the sm: breakpoint, so desktop always shows the
              full pill and mobile collapses everywhere, consistently. */}
          <div className="hidden sm:flex flex-col items-start leading-none">
            <span className="font-mono text-[10px] text-bone tracking-wider leading-none">@{displayHandle}</span>
            <span
              className="font-mono text-[8px] tabular-nums leading-none mt-[2px]"
              style={{ color: activeFrame === 'matte-black' ? '#F5F1E6' : tier.color, opacity: 0.85 }}
            >
              LVL {level} · {activeFrame === 'matte-black' ? 'BLACK' : tier.name}
            </span>
          </div>
          <svg
            className={cn('w-2.5 h-2.5 text-boneDim/50 transition-transform ml-0.5', open && 'rotate-180')}
            viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"
          >
            <path d="M2 4l3 3 3-3" />
          </svg>
        </button>

        {open && menuPos && createPortal(
          <div
            ref={menuRef}
            className={cn(
              'fixed w-[284px] fade-in overflow-y-auto rounded-md max-h-[calc(100dvh-64px)]',
              activeFrame === 'matte-black' ? '' : 'glass-pop',
            )}
            style={{
              top: menuPos.top, right: menuPos.right, zIndex: 80,
              // iOS Safari won't momentum-scroll a fixed overflow container
              // without these, so the lower menu items were unreachable on phones.
              WebkitOverflowScrolling: 'touch',
              overscrollBehavior: 'contain',
              ...(activeFrame === 'matte-black' ? {
                background: 'linear-gradient(180deg, #050505 0%, #000000 100%)',
                border: '1px solid rgba(245,241,230,0.55)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 12px 28px rgba(0,0,0,0.85)',
              } : {}),
            }}
          >
            {/* Header: framed avatar + handle + tier + XP bar */}
            <div className={cn(
              'px-3.5 py-3 flex items-center gap-3',
              activeFrame === 'matte-black' ? 'border-b border-bone/15' : 'hairline-b',
            )}>
              <AvatarRing
                size={40}
                level={level}
                xp={xp}
                seed={walletStr}
                avatarSrc={avatar?.image ?? null}
                avatarLabel={avatar?.label ?? 'avatar'}
                frameAnim="subtle"
                frame={activeFrame}
                mattePreset="dropdown"
                innerNode={avatarSelection ? (
                  <AvatarRender
                    avatar={avatarSelection}
                    nft={{ imageUrl: avatarImageUrl, collectionColor: avatarCollectionColor || undefined }}
                    size={40}
                  />
                ) : undefined}
              />
              <div className="flex-1 min-w-0">
                <div className="font-display text-bone text-[15px] leading-tight">@{displayHandle}</div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 5px rgba(52,211,153,0.9)' }} />
                  <span className="font-mono text-[9px] text-emerald-300/90 tracking-[0.2em] leading-none">REGISTERED</span>
                  <span className="text-boneDim/30 text-[9px]">·</span>
                  <span
                    className="font-mono text-[9px] tracking-[0.2em] leading-none"
                    style={{ color: activeFrame === 'matte-black' ? '#F5F1E6' : tier.color }}
                  >
                    LVL {level} {activeFrame === 'matte-black' ? 'BLACK' : tier.name}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex-1 h-1 rounded-full bg-bone/10 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${xpPct}%`,
                        background: activeFrame === 'matte-black'
                          ? 'linear-gradient(90deg, rgba(245,241,230,0.6), rgba(245,241,230,0.95))'
                          : `linear-gradient(90deg, ${tier.color}, ${tier.glow})`,
                        boxShadow: activeFrame === 'matte-black'
                          ? '0 0 6px rgba(245,241,230,0.45)'
                          : `0 0 6px ${tier.glow}55`,
                      }}
                    />
                  </div>
                  <span className="font-mono text-[8px] text-boneDim/60 tabular-nums leading-none">
                    {xp}/{LEVEL_XP(level)} XP
                  </span>
                </div>
              </div>
            </div>

            {/* Wallet address + copy */}
            <button onClick={copy} className={cn(
              'w-full px-3.5 py-2.5 flex items-center gap-2 transition text-left group',
              activeFrame === 'matte-black' ? 'border-b border-bone/15 hover:bg-bone/[0.04]' : 'hairline-b hover:bg-orange/[0.06]',
            )}>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em]">WALLET</span>
              <span className="text-boneDim/30">·</span>
              <span className="font-mono text-[11px] text-bone/90 tabular-nums tracking-wider flex-1">{shortWallet(walletStr)}</span>
              <span className={cn('font-mono text-[9px] tracking-[0.18em] transition', copied ? 'text-emerald-400' : 'text-orange/60 group-hover:text-orange')}>
                {copied ? 'COPIED' : 'COPY'}
              </span>
            </button>

            {/* Bankroll — SOL + $FP balances */}
            <div className={cn(
              'px-3.5 pt-2.5 pb-2.5',
              activeFrame === 'matte-black' ? 'border-b border-bone/15' : 'hairline-b',
            )}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-mono text-[9px] text-boneDim/55 tracking-[0.22em]">BANKROLL</span>
                <button
                  type="button"
                  onClick={() => { setOpen(false); setTransferOpen(true); }}
                  className="font-mono text-[9px] tracking-[0.18em] text-orange/70 hover:text-orange transition"
                >
                  TRANSFER →
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-sm',
                activeFrame === 'matte-black' ? 'border border-bone/15 bg-black/40' : 'hairline bg-ink/40',
              )}>
                  <Image src="/tokens/sol.svg" alt="SOL" width={12} height={12} className="rounded-full" />
                  <div className="flex-1 min-w-0 leading-none">
                    <div className="font-mono text-[11px] text-bone tabular-nums">
                      {solBalance === undefined ? '—' : solBalance.toFixed(3)}
                    </div>
                    <div className="font-mono text-[8px] text-boneDim/50 tracking-wider mt-0.5">SOL</div>
                  </div>
                </div>
                <div className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-sm',
                activeFrame === 'matte-black' ? 'border border-bone/15 bg-black/40' : 'hairline bg-ink/40',
              )}>
                  <Image src="/brand/app-icon.png" alt="$FP" width={12} height={12} className="rounded-full" />
                  <div className="flex-1 min-w-0 leading-none">
                    <div className="font-mono text-[11px] text-bone tabular-nums">
                      {pokerBalance === undefined
                        ? '—'
                        : pokerBalance >= 1000
                          ? `${(pokerBalance / 1000).toFixed(1)}k`
                          : pokerBalance.toFixed(0)}
                    </div>
                    <div className="font-mono text-[8px] text-amber/80 tracking-wider mt-0.5">$FP</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Claimable row — shown when wallet has pending rewards */}
            {hasClaimable && (
              <button onClick={openClaim} className={cn(
                'w-full px-3.5 py-2.5 flex items-center gap-3 hover:bg-emerald-400/10 transition text-left group bg-emerald-400/[0.04]',
                activeFrame === 'matte-black' ? 'border-b border-bone/15' : 'hairline-b',
              )}>
                <span className="w-4 h-4 flex items-center justify-center relative">
                  <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 8l3 3 7-7" /></svg>
                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 5px rgba(52,211,153,0.9)' }} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-display text-bone text-[13px] leading-none">Rewards available</div>
                  <div className="flex items-center gap-2 mt-1 leading-none">
                    <Image src="/tokens/sol.svg" alt="SOL" width={9} height={9} className="rounded-full" />
                    <span className="font-mono text-[10px] text-emerald-300 tabular-nums">{claimableSol.toFixed(3)}</span>
                    <span className="text-boneDim/30 text-[9px]">·</span>
                    <Image src="/brand/app-icon.png" alt="$FP" width={9} height={9} className="rounded-full" />
                    <span className="font-mono text-[10px] text-amber tabular-nums">{claimablePoker.toFixed(0)}</span>
                  </div>
                </div>
                <span className="font-mono text-[9px] text-emerald-300 tracking-[0.18em] group-hover:text-emerald-200">CLAIM →</span>
              </button>
            )}

            {/* Menu items (Admin intentionally NOT listed here — access via /admin) */}
            <div className="py-1">
              <MenuRow href="/lobby?tab=my" icon={<MenuIcon d="M4 6h16M4 10h16M4 14h16M4 18h16" />} label="My tables" subtitle="tables you created · rake earned" onNavigate={() => setOpen(false)} />
              <MenuButton icon={<MenuIcon d="M7 16l-4-4m0 0l4-4m-4 4h18M17 8l4 4m0 0l-4 4" />} label="Transfer funds" subtitle="send SOL · USDC · $FP to any wallet" onClick={() => { setOpen(false); setTransferOpen(true); }} />
              <MenuButton icon={<MenuIcon d="M15 7a4 4 0 014 4m-4-8a8 8 0 018 8M9 11a4 4 0 00-4 4M4 19a8 8 0 018-8" />} label="Session keys" subtitle="auto-approve table actions" onClick={() => { setOpen(false); setSessionOpen(true); }} />
              {/* Operator console is the self-hosted dealer-service dashboard,
                  not a website surface. License holders see public dealer
                  info + license status on /dealer instead. */}
              <MenuButton
                icon={<MenuIcon d={sfxMuted ? 'M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6' : 'M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07'} />}
                label={sfxMuted ? 'SOUND OFF' : 'SOUND ON'}
                subtitle={sfxMuted ? 'click to unmute' : 'click to mute'}
                onClick={() => {
                  const next = !sfxMuted;
                  SFX.setMuted(next);
                  setSfxMuted(next);
                  if (!next) SFX.play('ui-toggle');
                }}
              />
              {canExportPrivyWallet && (
                <MenuButton
                  icon={<MenuIcon d="M12 15V3m0 12l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />}
                  label="Export private key"
                  subtitle="embedded wallet private key"
                  onClick={exportPrivyWallet}
                />
              )}
              <MenuButton
                icon={<MenuIcon d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h6a2 2 0 012 2v1" />}
                label="Disconnect"
                subtitle="clear wallet session"
                onClick={() => { setOpen(false); disconnect(); }}
                danger
              />
            </div>

            {/* Community — X + Discord */}
            <div className={cn(
              'px-3.5 py-2.5 flex items-center gap-2',
              activeFrame === 'matte-black' ? 'border-t border-bone/15' : 'hairline-t',
            )}>
              <span className="font-mono text-[9px] text-boneDim/55 tracking-[0.22em] flex-1">COMMUNITY</span>
              <a
                href={BRAND.social.x}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${BRAND.shortName} on X`}
                className="w-7 h-7 flex items-center justify-center rounded-sm hairline bg-ink/40 text-bone/70 hover:text-bone hover:bg-orange/[0.08] transition"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
              </a>
              <a
                href={BRAND.social.discord}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${BRAND.shortName} Discord`}
                className="w-7 h-7 flex items-center justify-center rounded-sm hairline bg-ink/40 text-bone/70 hover:text-bone hover:bg-orange/[0.08] transition"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.79 19.79 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028 14.09 14.09 0 001.226-1.994.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" /></svg>
              </a>
            </div>
          </div>,
          document.body,
        )}
      </div>
      <SessionModal open={sessionOpen} onClose={() => setSessionOpen(false)} />
      <TransferFundsModal open={transferOpen} onClose={() => setTransferOpen(false)} />
      <ClaimableDropdown
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        anchorRect={claimRect}
        align="right"
        totals={claimable}
        onClaim={onClaimableAction}
      />
    </>
  );
}

function MenuRow({
  href, icon, label, subtitle, onNavigate,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  subtitle?: string;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className="w-full flex items-center gap-3 px-3 py-2 transition text-left hover:bg-orange/[0.06] text-bone/85 hover:text-bone"
    >
      <span className="w-4 h-4 flex items-center justify-center">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="font-display text-[13px] leading-none">{label}</div>
        {subtitle && <div className="font-mono text-[9px] text-boneDim/60 tracking-wider mt-1 leading-none truncate">{subtitle}</div>}
      </div>
    </Link>
  );
}

function MenuButton({
  icon, label, subtitle, onClick, danger,
}: {
  icon: React.ReactNode;
  label: string;
  subtitle?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2 transition text-left',
        danger
          ? 'hover:bg-rose-500/10 text-rose-300/90 hover:text-rose-300'
          : 'hover:bg-orange/[0.06] text-bone/85 hover:text-bone',
      )}
    >
      <span className="w-4 h-4 flex items-center justify-center">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="font-display text-[13px] leading-none">{label}</div>
        {subtitle && <div className="font-mono text-[9px] text-boneDim/60 tracking-wider mt-1 leading-none truncate">{subtitle}</div>}
      </div>
    </button>
  );
}
