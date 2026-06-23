#!/usr/bin/env bash
# LIGHT static export → ./out  (servable on any CDN / static host / GitHub
# Pages, no server). This is the easiest way for anyone to run the minimal version.
#
# Static export disallows route handlers, so all node/FULL-only API routes are
# moved aside for the build and restored afterward.
set -euo pipefail

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
