'use client';

import Link from 'next/link';
import { BRAND } from '@/lib/branding';

/**
 * Site-wide end-of-page footer: Docs / Privacy / Terms links, Discord + X +
 * GitHub socials, and a "Powered by" wordmark.
 *
 * This is the in-flow footer at the bottom of the page content — distinct from
 * the sticky FooterStrip ($FP price bar). Rendered by LayoutShell on app
 * (non-bare, non-game) routes. All links + the wordmark come from the BRAND
 * config (lib/branding.ts), so a fork sets them via NEXT_PUBLIC_BRAND_*.
 */
const DISCORD_URL = BRAND.social.discord;
const X_URL = BRAND.social.x;
const GITHUB_URL = BRAND.social.github;
const POWERED_BY_URL = BRAND.social.poweredByUrl;
const DOCS_URL = BRAND.social.docs;

export function SiteFooter() {
  return (
    <div className="w-full mt-16 border-t border-white/[0.06] px-5 pb-10">
      <div className="max-w-[1100px] mx-auto">
        <footer className="w-full flex flex-col items-center gap-4 pt-6">
          <div className="flex items-center gap-3">
            <SocialLink href={DISCORD_URL} label="Discord"><DiscordIcon /></SocialLink>
            <SocialLink href={X_URL} label="X"><XIcon /></SocialLink>
            <SocialLink href={GITHUB_URL} label="GitHub"><GithubIcon /></SocialLink>
          </div>

          <nav
            aria-label="Footer links"
            className="flex items-center gap-3 font-mono text-[9px] tracking-[0.28em] text-boneDim/55 uppercase"
          >
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-amber/80 transition-colors"
            >
              Docs
            </a>
            <span aria-hidden className="text-boneDim/25">·</span>
            <Link href="/privacy" className="hover:text-amber/80 transition-colors">
              Privacy
            </Link>
            <span aria-hidden className="text-boneDim/25">·</span>
            <Link href="/terms" className="hover:text-amber/80 transition-colors">
              Terms
            </Link>
          </nav>

          <a
            href={POWERED_BY_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Powered by"
            className="paradice-wordmark-link group flex flex-col items-center gap-2 transition"
          >
            <span className="font-mono text-[8px] tracking-[0.4em] text-boneDim/45 group-hover:text-boneDim/70 uppercase transition-colors">
              Powered by
            </span>
            <span className="paradice-wordmark">
              <span className="paradice-wordmark-name">{BRAND.social.poweredByName}</span>
              <span className="paradice-wordmark-tagline">{BRAND.social.poweredByTagline}</span>
            </span>
          </a>
        </footer>
      </div>
    </div>
  );
}

function SocialLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="w-9 h-9 rounded-full inline-flex items-center justify-center text-boneDim/55 hover:text-amber/90 hover:bg-amber/[0.06] transition"
      style={{ border: '1px solid rgba(245,241,230,0.10)' }}
    >
      {children}
    </a>
  );
}

function DiscordIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.16-.02-2.1-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.07 11.07 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.81-.01 3.19 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}
