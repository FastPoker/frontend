'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, Suspense } from 'react';
import { Navbar } from './Navbar';
import { ActiveTableBar } from './ActiveTableBar';
import { FooterStrip } from './FooterStrip';
import { SiteFooter } from './SiteFooter';
import { Toaster } from '@/components/ui/sonner';
import { RotateGate } from '@/components/system/RotateGate';
import { RpcSettings } from '@/components/system/RpcSettings';

/**
 * Routes where all global chrome (navbar, bottom tabs, Toaster, site bg) is
 * suppressed. /game/[id] keeps the table immersive but WITH the navbar
 * (nav-IA spec: no bare/game mode). /admin intentionally keeps the navbar
 * too so the password gate wraps around it as a hype takeover.
 *
 * Public/pre-app surfaces are bare so they don't leak the gated-app chrome
 * (which has links to gated routes that look broken to unauthenticated
 * visitors): the root "/" (now a redirect to /lobby) and the legal pages.
 */
// /region-blocked is a dead-end notice for geo-blocked visitors. Keep it bare
// (like /privacy, /terms) so it doesn't mount the Navbar, wallet-balance
// polling, DegradedBanner, footer price ticker, or chat — all of which would
// fire indexer/RPC fetches that get geo-redirected for a blocked user and
// surface a false "indexer degraded" banner.
const BARE_ROUTES_EXACT = new Set<string>(['/', '/privacy', '/terms', '/region-blocked']);
const BARE_ROUTES_PREFIX: string[] = [];

/**
 * The About page ('/about') has a custom hero background; every other
 * surface wears the shared photo background via body.fp-site-bg (set here
 * in a useEffect). The actual home ('/') uses the standard site bg.
 */
function useFpSiteBg(active: boolean) {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (active) document.body.classList.add('fp-site-bg');
    else document.body.classList.remove('fp-site-bg');
    return () => document.body.classList.remove('fp-site-bg');
  }, [active]);
}

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  const [inIframe, setInIframe] = useState(false);

  useEffect(() => {
    try { setInIframe(window.self !== window.top); } catch { setInIframe(true); }
  }, []);

  const isBare =
    inIframe ||
    BARE_ROUTES_EXACT.has(pathname) ||
    BARE_ROUTES_PREFIX.some((r) => pathname.startsWith(r));
  const isHome = pathname === '/about';
  // Game table: keep Navbar + FooterStrip, hide mobile bottom tabs and drop
  // the bottom pb-14 padding so the table uses full viewport height.
  // The game route is /game?table=<pda> (query-param, for static export), so the
  // pathname is exactly '/game'.
  const isGame = pathname === '/game';

  // Game routes are immersive (felt fills the viewport), so the marketing
  // FP-card site background would otherwise bleed around the table on
  // narrow viewports and dominate the loading state when on-chain data
  // hasn't streamed in yet.
  useFpSiteBg(!isBare && !isHome && !isGame);

  return (
    <>
      {/* Landscape is disabled for now: block phones held sideways with a
          rotate-to-portrait prompt. */}
      <RotateGate />
      {!isBare && <Navbar />}
      {/* ActiveTableBar reads the current table from the URL query (useSearchParams),
          which needs a Suspense boundary so the rest of the tree can still be
          statically pre-rendered. */}
      {!isBare && (
        <Suspense fallback={null}>
          <ActiveTableBar />
        </Suspense>
      )}
      <div className={isBare ? '' : 'flex-1'}>{children}</div>
      {!isBare && !isGame && <SiteFooter />}
      {!isBare && <FooterStrip />}
      {!isBare && <RpcSettings />}
      <Toaster />
    </>
  );
}
