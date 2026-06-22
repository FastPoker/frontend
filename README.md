# FastPoker Frontend Public

A lightweight, self-hostable source release of the FastPoker frontend. It is a
thin client to the same live on-chain game: no fast.poker backend, no shipped
database, no bundled keys, and no hosted dependency controlled by the original
site. You bring your own RPC; gameplay rides the MagicBlock TEE.

**Open source (MIT).** Fork it, modify it, run it however you like. The code is
yours to use; the *brand* is not. Rebrand before you ship. See
[TRADEMARK.md](./TRADEMARK.md) and `src/lib/branding.ts`.

This repo is intended to ship as source code. Operators run it with Node, a
static host, a process manager, their own MongoDB, their own RPC provider, or any
infrastructure they prefer.

## Run profiles

- **LIGHT static** - `npm run build:static` creates `out/`, a pure static app for
  any CDN, static host, GitHub Pages, or normal web server. No server-side
  route handlers run in this profile.
- **Node server** - `npm run build && npm start` runs the same app with Next route
  handlers for same-origin `/rpc`, token metadata/history helpers, process-local
  show-cards/player-notes, and cash/SNG relay APIs. A hosted Node server can use
  the operator's private `L1_RPC` so normal users do not need to configure their
  own RPC.
- **FULL source mode** - run the Next node server plus the separate `Indexer`
  source package and your own MongoDB. This is the full read experience: history,
  leaderboards, richer lobby stats, per-wallet jackpot attribution, and live
  WebSocket push.
For exact commands, see [SETUP.md](./SETUP.md). For architecture, feature parity,
and release gates, see [OVERVIEW.md](./OVERVIEW.md). Agent setup guidance ships in
[AGENTS.md](./AGENTS.md), [CLAUDE.md](./CLAUDE.md), and the portable skill at
[skills/fastpoker-frontend-public-setup/SKILL.md](./skills/fastpoker-frontend-public-setup/SKILL.md).

## What it does

- Connect a Solana wallet: Phantom, Backpack, or Solflare via wallet-adapter.
- Browse SNG tiers and join the one you want with `join_sng_pool`, signed by your
  wallet.
- Create cash tables, sit, play, claim, and leave through player-signed on-chain
  transactions.
- Mint a per-session TEE auth JWT by signing a wallet challenge. No helper server
  or API key is required for the LIGHT card auth path.

The app is a window into the on-chain game. Shuffles, deals, hidden cards, and
settlement happen in the shared protocol: the Solana program, the MagicBlock TEE,
and the operator-run dealer/crank network. A static deployment can play, but
server-assisted protocol work such as cash top-up apply, stale-proof cleanup,
rake distribution, and manual ready nudges requires the node relay routes or an
external operator network.

## Quick start

Prerequisites: Node 20+ (`.nvmrc` currently pins 22), a browser wallet, and funded
mainnet SOL if you are using the live program.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3005`.

Blank env is coherent out of the box for local MVR: mainnet, the built-in free
public RPC pool, and keyless MagicBlock TEE auth. For a hosted public Node server,
set server-side `L1_RPC` and build with `NEXT_PUBLIC_L1_RPC_URL=/rpc` so visitors
use your same-origin RPC proxy instead of bringing their own endpoint.

## Configuration

See `.env.example` for the common LIGHT and node-server settings:

- `NEXT_PUBLIC_SOLANA_CLUSTER` - `mainnet` or `devnet`.
- `NEXT_PUBLIC_L1_RPC_URL` / `NEXT_PUBLIC_L1_WS_URL` - browser RPC settings.
  For hosted Node mode, set `NEXT_PUBLIC_L1_RPC_URL=/rpc` and provide
  `NEXT_PUBLIC_L1_WS_URL=wss://...` from your provider.
- `NEXT_PUBLIC_DEFAULT_TEE_RPC` / `_WS` - MagicBlock TEE endpoints.
- `NEXT_PUBLIC_TEE_API_KEY` - optional; keyless works, blank by default.
- Privy is off by default. Set your own `NEXT_PUBLIC_PRIVY_APP_ID` plus
  `NEXT_PUBLIC_PRIVY_LOGIN_ENABLED=true` to enable it; email, Google, X, and
  Apple login buttons each have their own `NEXT_PUBLIC_PRIVY_LOGIN_*` opt-in flag.
- `NEXT_PUBLIC_INDEXER_WS_URL` - optional browser WebSocket URL for the source
  indexer.
- `L1_RPC` or `L1_RPC_PROXY_UPSTREAM` - server-side RPC for node relay routes.
- `AUTHORITY_KEYPAIR_PATH`, `TEE_RPC`, optional `TEE_API_KEY`, and `APP_ORIGIN` -
  required only for node relay routes.

For the FULL read experience, run the separate `Indexer` package (wherever you
keep it). The client needs `INDEXER_BASE_URL` for server-side table lists/history
and `NEXT_PUBLIC_INDEXER_WS_URL` only for browser WebSocket push.

## Static LIGHT build

```bash
npm run build:static
```

Upload `out/` anywhere. The static build has no route handlers, so it cannot use
`/api/indexer`, `/rpc`, `/api/tables/list`, `/api/my-sng-tables`, or cash/SNG relay APIs. Users can
still provide a capable RPC endpoint in-app for table discovery, and the app can
point at an externally run indexer WebSocket if you set `NEXT_PUBLIC_INDEXER_WS_URL`
at build time.

## Source FULL mode

FULL mode is not a different client package. It is the client source plus the
separate indexer source running as normal Node processes. The indexer is required
for FULL history/stats/live-push parity; the Next node server alone is still a
valid hosted relay/RPC mode, but it is not the full indexed read experience.

1. Root Next app: `npm run build && PORT=3005 npm start`.
2. Read-side indexer: run `npm ci && npm run start` in the `Indexer` package.

The web server and indexer both need server-side RPC access. They may share the
same provider account only if your quota can support both workloads. End users do
not need to provide RPCs when you host the Node server with `L1_RPC` and
`NEXT_PUBLIC_L1_RPC_URL=/rpc`; they will use your same-origin proxy for HTTP RPC
calls. The indexer still needs MongoDB, a paid/dedicated mainnet RPC, and
LaserStream/Geyser credentials for production-quality live indexed history. The
indexer remains read-only; it never holds keys or signs transactions.

The one wiring rule:

- `INDEXER_BASE_URL` is server-side and should point from the web process to the
  indexer, for example `http://localhost:3001`.
- `NEXT_PUBLIC_INDEXER_WS_URL` is baked into the browser bundle at build time and
  must be reachable by the end user's browser for live push, for example
  `wss://your.domain/ws`.

Cash table listing in FULL mode uses the web app's `/api/tables/list` route. That
route reads the indexer's raw table cache first when `INDEXER_BASE_URL` is set,
then falls back to direct RPC scans when a server RPC is configured.

## Release hygiene

Ship the source tree plus `package-lock.json`. Do not ship `node_modules`, `.next`,
`out`, `.env`, `.env.local`, wallet files, keypair JSON, logs, or generated NFT art.

Before publishing a source release, run:

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run build
npm run build:static
```

For FULL source mode, also run this in the `Indexer` package:

```bash
npm ci
npm run typecheck
```
