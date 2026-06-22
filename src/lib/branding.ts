/**
 * White-label branding config (build-time).
 *
 * Everything a fork needs to make this their own — name, domain, copy, colors,
 * social links, logo/asset paths — resolved from `NEXT_PUBLIC_BRAND_*` env with
 * the project's own values as defaults. Set them before `npm run build`.
 *
 * Why build-time (NEXT_PUBLIC, inlined) rather than a runtime file: the LIGHT
 * tier targets a static export (no server at runtime), so branding must be baked
 * at build. An operator building their own skin rebuilds anyway. Because these
 * are NEXT_PUBLIC, `BRAND` is usable from BOTH server and client components with
 * no provider — import it anywhere.
 *
 * Colors flow to the UI as CSS variables: `brandCssVars()` emits a `:root` block
 * (injected once in layout.tsx) and the Tailwind brand tokens (orange/bone/amber/
 * gold) resolve to `rgb(var(--brand-*) / <alpha>)`, so a single primary color
 * reskins every `bg-orange` / `text-orange` / `border-orange/25` in the app.
 */

function clamp8(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** '#F26A1F' | 'F26A1F' -> '242 106 31' (space-separated channels for rgb(var() / a)). */
function hexToRgbChannels(hex: string | undefined, fallback: string): string {
  if (!hex) return fallback;
  const h = hex.trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return fallback;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

/** Scale RGB channels by a factor (for auto-deriving hi/lo shades from primary). */
function scaleChannels(channels: string, factor: number): string {
  const [r, g, b] = channels.split(' ').map(Number);
  return `${clamp8(r * factor)} ${clamp8(g * factor)} ${clamp8(b * factor)}`;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

// ─── Primary color + auto-derived shades ─────────────────────────────────────
// Minimal config is just NEXT_PUBLIC_BRAND_PRIMARY; hi/lo derive from it unless
// set explicitly.
const PRIMARY_RGB = hexToRgbChannels(env('NEXT_PUBLIC_BRAND_PRIMARY'), '242 106 31'); // #F26A1F
const PRIMARY_HI_RGB = env('NEXT_PUBLIC_BRAND_PRIMARY_HI')
  ? hexToRgbChannels(env('NEXT_PUBLIC_BRAND_PRIMARY_HI'), '255 138 61')
  : (env('NEXT_PUBLIC_BRAND_PRIMARY') ? scaleChannels(PRIMARY_RGB, 1.22) : '255 138 61'); // #FF8A3D
const PRIMARY_LO_RGB = env('NEXT_PUBLIC_BRAND_PRIMARY_LO')
  ? hexToRgbChannels(env('NEXT_PUBLIC_BRAND_PRIMARY_LO'), '184 69 21')
  : (env('NEXT_PUBLIC_BRAND_PRIMARY') ? scaleChannels(PRIMARY_RGB, 0.72) : '184 69 21'); // #B84515
const AMBER_RGB = hexToRgbChannels(env('NEXT_PUBLIC_BRAND_AMBER'), '255 198 58'); // #FFC63A
const GOLD_RGB = hexToRgbChannels(env('NEXT_PUBLIC_BRAND_GOLD'), '212 180 87'); // #D4B457
const BONE_RGB = hexToRgbChannels(env('NEXT_PUBLIC_BRAND_BONE'), '245 241 230'); // #F5F1E6

export const BRAND = {
  /** Display name, e.g. header logo alt + OG site name. */
  name: env('NEXT_PUBLIC_BRAND_NAME') ?? 'FAST POKER',
  /** Compact name for the title template / twitter. */
  shortName: env('NEXT_PUBLIC_BRAND_SHORT_NAME') ?? 'FastPoker',
  /** Bare domain — drives metadataBase, OG url, canonical, and copy. */
  domain: env('NEXT_PUBLIC_BRAND_DOMAIN') ?? 'fast.poker',
  tagline: env('NEXT_PUBLIC_BRAND_TAGLINE') ?? "On-Chain Texas Hold'em",
  description:
    env('NEXT_PUBLIC_BRAND_DESCRIPTION') ??
    'Non-custodial, on-chain poker on Solana. TEE-attested shuffles. Your wallet, your table.',
  /** Reward-token ticker shown in copy (e.g. "$FP"). */
  tokenSymbol: env('NEXT_PUBLIC_BRAND_TOKEN_SYMBOL') ?? '$FP',
  twitterHandle: env('NEXT_PUBLIC_BRAND_TWITTER') ?? '@fastdotpoker',

  social: {
    discord: env('NEXT_PUBLIC_BRAND_DISCORD_URL') ?? 'https://discord.gg/fastpoker',
    x: env('NEXT_PUBLIC_BRAND_X_URL') ?? 'https://x.com/fastdotpoker',
    github: env('NEXT_PUBLIC_BRAND_GITHUB_URL') ?? 'https://github.com/FastPoker',
    docs: env('NEXT_PUBLIC_BRAND_DOCS_URL') ?? 'https://docs.fast.poker',
    poweredByUrl: env('NEXT_PUBLIC_BRAND_POWERED_BY_URL') ?? 'https://paradice.ai',
    poweredByName: env('NEXT_PUBLIC_BRAND_POWERED_BY_NAME') ?? 'PARADICE',
    poweredByTagline: env('NEXT_PUBLIC_BRAND_POWERED_BY_TAGLINE') ?? 'Technologies',
  },

  assets: {
    logo: env('NEXT_PUBLIC_BRAND_LOGO') ?? '/brand/logo_horiz_offwhite.png',
    favicon: env('NEXT_PUBLIC_BRAND_FAVICON') ?? '/brand/favicon.png',
    appleIcon: env('NEXT_PUBLIC_BRAND_APPLE_ICON') ?? '/brand/app-icon.png',
    ogImage: env('NEXT_PUBLIC_BRAND_OG_IMAGE') ?? '/brand/app-icon.png',
  },

  colors: {
    primaryRgb: PRIMARY_RGB,
    primaryHiRgb: PRIMARY_HI_RGB,
    primaryLoRgb: PRIMARY_LO_RGB,
    amberRgb: AMBER_RGB,
    goldRgb: GOLD_RGB,
    boneRgb: BONE_RGB,
  },
} as const;

/** True when any brand value was overridden from the defaults (for diagnostics). */
export function isRebranded(): boolean {
  return Boolean(env('NEXT_PUBLIC_BRAND_NAME') || env('NEXT_PUBLIC_BRAND_PRIMARY') || env('NEXT_PUBLIC_BRAND_DOMAIN'));
}

/**
 * `:root` CSS variable block for the brand palette. Injected once in layout.tsx
 * <head> so it overrides the defaults compiled into globals.css before paint.
 */
export function brandCssVars(): string {
  const c = BRAND.colors;
  return [
    ':root{',
    `--brand-primary:${c.primaryRgb};`,
    `--brand-primary-hi:${c.primaryHiRgb};`,
    `--brand-primary-lo:${c.primaryLoRgb};`,
    `--brand-amber:${c.amberRgb};`,
    `--brand-gold:${c.goldRgb};`,
    `--brand-bone:${c.boneRgb};`,
    '}',
  ].join('');
}
