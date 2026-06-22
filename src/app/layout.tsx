import type { Metadata } from 'next';
import { Bebas_Neue, Playfair_Display, JetBrains_Mono, Inter, Bitter, Oswald } from 'next/font/google';
import './globals.css';
import { Providers } from './providers-client';
import { LayoutShell } from '@/components/layout/LayoutShell';
import { BRAND, brandCssVars } from '@/lib/branding';

// Mockup 1.4 canonical font stack. Bebas Neue is the primary display face;
// Playfair stays available as font-serif for cinematic moments. Inter is
// body sans, JetBrains Mono is code/eyebrow/mono pills.
const display = Bebas_Neue({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-display',
});
const serif = Playfair_Display({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-serif',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});
const sans = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-sans',
});
// Bicycle-style card fonts. Bitter Black approximates the Bookman-ish
// rank numerals on the classic Rider Back deck. Oswald Bold approximates
// the chunky condensed sans used on the Bicycle Big Print / EZ See line.
const cardSerif = Bitter({
  subsets: ['latin'],
  weight: ['900'],
  variable: '--font-card-serif',
});
const cardBigEz = Oswald({
  subsets: ['latin'],
  weight: ['700'],
  variable: '--font-card-bigez',
});

// All copy/links/icons resolve from the white-label BRAND config (build-time env
// with project defaults — see lib/branding.ts).
const SITE_TITLE = `${BRAND.name} | ${BRAND.tagline}`;

export const metadata: Metadata = {
  metadataBase: new URL(`https://${BRAND.domain}`),
  title: SITE_TITLE,
  description: BRAND.description,
  icons: {
    icon: BRAND.assets.favicon,
    apple: BRAND.assets.appleIcon,
  },
  openGraph: {
    type: 'website',
    url: `https://${BRAND.domain}`,
    siteName: BRAND.shortName,
    title: SITE_TITLE,
    description: BRAND.description,
    images: [
      {
        url: BRAND.assets.ogImage,
        width: 180,
        height: 180,
        alt: BRAND.shortName,
      },
    ],
  },
  twitter: {
    card: 'summary',
    site: BRAND.twitterHandle,
    title: SITE_TITLE,
    description: BRAND.description,
    images: [BRAND.assets.ogImage],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        {/* Operator brand palette override → :root CSS vars, before paint (no
            color flash). Defaults live in globals.css; this restates/overrides
            them from the build-time BRAND config. */}
        <style id="brand-vars" dangerouslySetInnerHTML={{ __html: brandCssVars() }} />
      </head>
      <body className={`${display.variable} ${serif.variable} ${mono.variable} ${sans.variable} ${cardSerif.variable} ${cardBigEz.variable} font-sans bg-ink text-bone min-h-screen flex flex-col antialiased`}>
        <Providers>
          <LayoutShell>{children}</LayoutShell>
        </Providers>
      </body>
    </html>
  );
}
