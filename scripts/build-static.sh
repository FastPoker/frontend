#!/usr/bin/env bash
# LIGHT static export → ./out  (servable on any CDN / static host / GitHub
# Pages, no server). This is the easiest way for anyone to run the minimal version.
#
# Static export disallows dynamic route handlers, so the FULL-only /api/indexer
# proxy (unused in LIGHT) is moved aside for the build and restored afterward.
set -euo pipefail

STASH=".api-stash-$$"
cleanup() { [ -d "$STASH" ] && mv "$STASH" src/app/api || true; }
trap cleanup EXIT

if [ -d src/app/api ]; then
  mv src/app/api "$STASH"
fi

NEXT_OUTPUT=export next build

echo ""
echo "Static export written to ./out"
echo "Deploy it to any static host (Vercel/Netlify/Cloudflare Pages/GitHub Pages)."
