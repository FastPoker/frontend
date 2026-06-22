# Trademark & Branding Policy

The **source code** in this repository is released under the MIT License (see
`LICENSE`) — you may fork it, modify it, and run it however you like.

The **brand is not part of that grant.** The project name ("Fast Poker"), the
logo and wordmarks, and the `$FP` token marks are reserved. A fork must not
present itself as, or imply affiliation with, the original project.

## Rebrand before you ship

This build is white-label by design. Set your own identity via build-time env
(`NEXT_PUBLIC_BRAND_*`, see `src/lib/branding.ts`):

- `NEXT_PUBLIC_BRAND_NAME`, `NEXT_PUBLIC_BRAND_SHORT_NAME`, `NEXT_PUBLIC_BRAND_DOMAIN`
- `NEXT_PUBLIC_BRAND_PRIMARY` (one hex color reskins the whole UI), plus optional
  `_PRIMARY_HI/_LO`, `_AMBER`, `_GOLD`, `_BONE`
- `NEXT_PUBLIC_BRAND_LOGO`, `_FAVICON`, `_OG_IMAGE` (your asset paths/URLs)
- `NEXT_PUBLIC_BRAND_TAGLINE`, `_DESCRIPTION`, `_TOKEN_SYMBOL`, `_TWITTER`
- `NEXT_PUBLIC_BRAND_DISCORD_URL`, `_X_URL`, `_GITHUB_URL`, `_DOCS_URL`,
  `_POWERED_BY_URL`, `_POWERED_BY_NAME`

Replace the bundled brand assets under `public/brand/` (or point the env vars at
your own), and provide your own Terms / Privacy content.

## On-chain

This frontend talks to a specific on-chain program by default. If you deploy
your own program/token, override the addresses via env (`NEXT_PUBLIC_FASTPOKER_PROGRAM_ID`,
`NEXT_PUBLIC_POKER_MINT`, `NEXT_PUBLIC_POOL_PDA`, `NEXT_PUBLIC_TREASURY`,
`NEXT_PUBLIC_CRANK_PUBKEY`). RPC is always operator-supplied (bring your own).
