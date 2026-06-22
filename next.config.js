/** @type {import('next').NextConfig} */
// Frontend: lightweight, self-hostable build. No fast.poker backend.
//
// Build modes (set via NEXT_OUTPUT):
//   (unset)      normal `next build` + `next start` node server.
//   export       LIGHT static export → out/ — servable on any CDN/static host,
//                no Node server. Use `npm run build:static` (it also moves the
//                FULL-only /api/indexer proxy aside, since route handlers are not
//                allowed under static export). The /game route is query-param
//                (/game?table=<pda>) precisely so it can be pre-rendered.
//
// Headers are kept for the node/dev build; under static export they move to the
// static host's config.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Privy entries are kept so a host that opts into their OWN Privy app id works;
      // off by default.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com https://*.privy.io",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      // Direct public RPC + MagicBlock TEE over https/wss.
      "connect-src 'self' https: wss: ws:",
      "frame-src 'self' https://auth.privy.io https://*.privy.io https://verify.walletconnect.com https://challenges.cloudflare.com",
      "child-src 'self' https://auth.privy.io https://*.privy.io",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const BUILD_HASH = process.env.NEXT_PUBLIC_BUILD_HASH || 'source';
const isExport = process.env.NEXT_OUTPUT === 'export';

const nextConfig = {
  reactStrictMode: true,
  ...(isExport ? { output: 'export' } : {}),
  env: {
    NEXT_PUBLIC_BUILD_HASH: BUILD_HASH,
  },
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error'] } : false,
  },
  turbopack: {
    root: __dirname,
  },
  images: {
    // First-party token marks are SVG; the optimizer 400s on SVG without this.
    dangerouslyAllowSVG: true,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    // Static export ships no image-optimization server.
    ...(isExport ? { unoptimized: true } : {}),
  },
  // headers() is unsupported under static export — the static host applies the
  // same security headers via its own config (see README). Omit it there.
  ...(isExport
    ? {}
    : {
        async headers() {
          return [{ source: '/:path*', headers: securityHeaders }];
        },
        async rewrites() {
          return [
            { source: '/rpc', destination: '/api/rpc/proxy' },
            { source: '/rpc/:path*', destination: '/api/rpc/proxy' },
          ];
        },
      }),
};

module.exports = nextConfig;
