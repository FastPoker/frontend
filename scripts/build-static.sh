#!/usr/bin/env bash
# LIGHT static export → ./out  (servable on any CDN / static host / GitHub
# Pages, no server). This is the easiest way for anyone to run the minimal version.
#
# Static export disallows route handlers, so all node/FULL-only API routes are
# moved aside for the build and restored afterward.
set -euo pipefail

# Everything in NEXT_PUBLIC_* is inlined into the exported JavaScript, and a
# static export is uploaded to a public host. Refuse to build if any of those
# values carries a provider credential, so a key left in .env.local for local
# testing cannot end up in ./out. Set ALLOW_PUBLIC_RPC_KEY=1 only for a key that
# is meant to be public (locked to your domain in the provider dashboard).
if [ "${ALLOW_PUBLIC_RPC_KEY:-}" != "1" ]; then
  leaked="$(node -e '
    const { loadEnvConfig } = require("@next/env");
    loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
    const bad = /api[-_]?key=[^&\s]|[?&](token|key|apikey)=[^&\s]|\/\/[^\/\s:@]+:[^\/\s@]+@/i;
    const hits = Object.keys(process.env)
      .filter((k) => k.startsWith("NEXT_PUBLIC_") && bad.test(process.env[k] || ""))
      .concat(["NEXT_PUBLIC_HELIUS_API_KEY", "NEXT_PUBLIC_TEE_API_KEY"].filter((k) => process.env[k]));
    process.stdout.write([...new Set(hits)].join(" "));
  ')"
  if [ -n "$leaked" ]; then
    echo "build:static refused: these public env vars contain a credential that would be" >&2
    echo "published in ./out:  $leaked" >&2
    echo "Blank them (static builds let users bring their own RPC), or re-run with" >&2
    echo "ALLOW_PUBLIC_RPC_KEY=1 if the key is domain-restricted and meant to be public." >&2
    exit 1
  fi
fi

API_STASH=".api-stash-$$"
PROFILE_DYNAMIC_STASH=".profile-dynamic-stash-$$"
cleanup() {
  [ -d "$API_STASH" ] && mv "$API_STASH" src/app/api || true
  [ -d "$PROFILE_DYNAMIC_STASH" ] && mkdir -p src/app/profile && mv "$PROFILE_DYNAMIC_STASH" 'src/app/profile/[address]' || true
}
trap cleanup EXIT

if [ -d src/app/api ]; then
  mv src/app/api "$API_STASH"
fi

if [ -d 'src/app/profile/[address]' ]; then
  mv 'src/app/profile/[address]' "$PROFILE_DYNAMIC_STASH"
fi

# The export build uses its own distDir (.next-export, set in next.config.js when
# NEXT_OUTPUT=export), so it never shares route-type validators or build state with
# a node `next build`/`next dev`/`next start` on `.next`. That makes the documented
# `npm run build && npm run build:static` sequence safe and lets this run alongside
# a live dev server without 404'ing its /api routes. `out/` is still the final export.
NEXT_PUBLIC_STATIC_EXPORT=true NEXT_OUTPUT=export next build

echo ""
echo "Static export written to ./out"
echo "Deploy it to any static host (Vercel/Netlify/Cloudflare Pages/GitHub Pages)."
