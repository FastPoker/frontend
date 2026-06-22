'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { BRAND } from '@/lib/branding';
import { ProfilePill } from './ProfilePill';
import { SngJackpotRail } from '@/components/jackpot/SngJackpotRail';

type NavItem = { href: string; label: string };

// Standalone: only the routes that exist in this build.
const LEFT_NAV: NavItem[] = [
  { href: '/lobby', label: 'LOBBY' },
];

const RIGHT_NAV: NavItem[] = [
  { href: '/how-to-play', label: 'HOW TO' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/lobby') return pathname === '/lobby';
  return pathname === href || pathname.startsWith(href + '/');
}

export function Navbar() {
  const pathname = usePathname() || '';
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [menuOpen]);

  const isGame = pathname === '/game';

  const linkCls = (item: NavItem) => cn(
    'px-2.5 py-1.5 rounded-md text-[11.5px] font-semibold tracking-[0.12em] uppercase transition whitespace-nowrap',
    isActive(pathname, item.href)
      ? 'text-orange bg-orange/10'
      : 'text-bone/75 hover:text-bone hover:bg-bone/[0.05]',
  );

  return (
    <>
    <header
      className="sticky top-0 z-50 bg-ink/85 backdrop-blur-xl"
      style={{ borderBottom: '1px solid rgba(242,106,31,0.12)' }}
    >
      <div className="max-w-[1440px] mx-auto px-3 sm:px-5 h-[64px] flex items-center gap-3 md:gap-4 lg:gap-5">
        {/* LEFT: hamburger + landscape chat toggle (mobile only) */}
        <div className="shrink-0 flex items-center gap-1 xl:hidden">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            className="w-9 h-9 flex flex-col items-center justify-center gap-1 rounded-md hover:bg-orange/10 transition relative z-[70] shrink-0"
          >
            {menuOpen ? (
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            ) : (
              <>
                <span className="block w-4 h-[1.5px] bg-bone/80" />
                <span className="block w-4 h-[1.5px] bg-bone/80" />
                <span className="block w-4 h-[1.5px] bg-bone/80" />
              </>
            )}
          </button>

          {/* Chat toggle — the single mobile chat entry (portrait + landscape)
              on game routes. Desktop (md+) uses the floating bottom-right
              TableChatWidget instead. Dispatches table-chat-toggle, which the
              full-screen TableChatWidget overlay listens for. */}
          {false /* table chat disabled for now (see LayoutShell TABLE_CHAT_ENABLED) */ && isGame && (
            <button
              id="nav-landscape-chat-btn"
              onClick={() => window.dispatchEvent(new Event('table-chat-toggle'))}
              aria-label="Toggle table chat"
              className="flex md:hidden [@media(orientation:landscape)_and_(max-height:500px)]:!flex w-9 h-9 items-center justify-center rounded-md hover:bg-orange/10 transition text-orange/75 hover:text-orange"
            >
              <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M2.5 4.5h11v6h-4l-2.5 2v-2h-4.5z" />
              </svg>
            </button>
          )}
        </div>

        {/* LOGO — left-anchored. */}
        <Link
          id="nav-logo-shell"
          href="/lobby"
          className={cn(
            'flex items-center group select-none shrink-0 transition-opacity duration-200',
            menuOpen && 'opacity-30 pointer-events-none',
          )}
          aria-hidden={menuOpen ? 'true' : undefined}
          tabIndex={menuOpen ? -1 : undefined}
          aria-label={`${BRAND.name} home`}
        >
          <Image
            src={BRAND.assets.logo}
            alt={BRAND.name}
            width={220}
            height={34}
            priority
            draggable={false}
            className="block h-[20px] w-auto transition group-hover:brightness-110"
          />
        </Link>

        {/* PRIMARY NAV — merged LEFT_NAV + RIGHT_NAV, lined up next to the logo. */}
        <nav
          id="nav-primary-links"
          className={cn(
            'hidden xl:flex items-center gap-1 shrink-0 transition-opacity duration-200',
            menuOpen && 'opacity-30 pointer-events-none',
          )}
          aria-hidden={menuOpen ? 'true' : undefined}
        >
          {[...LEFT_NAV, ...RIGHT_NAV].map(item => (
            <Link key={item.href} href={item.href} className={linkCls(item)} tabIndex={menuOpen ? -1 : undefined}>{item.label}</Link>
          ))}
        </nav>

        {/* RIGHT CLUSTER — badges + Connect Wallet, pinned to the right edge. */}
        <div
          id="nav-right-cluster"
          className={cn(
            'ml-auto shrink-0 flex items-center gap-3 md:gap-4 lg:gap-5 transition-opacity duration-200',
            menuOpen && 'opacity-30 pointer-events-none',
          )}
          aria-hidden={menuOpen ? 'true' : undefined}
        >
          {(
            <>
              <div id="nav-badge-rail-mini" className="hidden md:block shrink-0">
                <SngJackpotRail variant="header" tone="mini" />
              </div>
              <div id="nav-badge-rail-grand" className="hidden md:block shrink-0">
                <SngJackpotRail variant="header" tone="grand" />
              </div>
            </>
          )}
          <ProfilePill />
        </div>
      </div>
    </header>

    {/* Mobile drawer + dimmer rendered OUTSIDE the sticky header so they
        escape its stacking context and can cover any sticky CTAs on the
        page (z-50 and below). */}
    {menuOpen && (
      <>
        <div
          id="mobile-nav-backdrop"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
          className="xl:hidden fixed inset-0 bg-black/55 backdrop-blur-sm z-[60]"
          style={{ top: '3.25rem' }}
        />
        <div
          id="mobile-nav-drawer"
          className="xl:hidden fixed left-0 right-0 bg-[#050608] border-b-2 border-orange/50 z-[65] shadow-xl"
          style={{ top: '3.25rem' }}
        >
          <nav className="flex flex-col py-2 max-w-[1440px] mx-auto">
            {[...LEFT_NAV, ...RIGHT_NAV].map(item => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMenuOpen(false)}
                className={cn(
                  'px-5 py-3 text-[12px] tracking-[0.12em] font-semibold uppercase border-b border-orange/5 transition',
                  isActive(pathname, item.href) ? 'text-orange bg-orange/5' : 'text-bone/85 hover:bg-orange/5',
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </>
    )}
    </>
  );
}
