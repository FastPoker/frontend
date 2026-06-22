---
name: fastpoker-frontend-public-setup
description: Run, verify, publish, or troubleshoot the FastPoker standalone source-code frontend. Use when an agent is asked to set up the repo, explain the MVR/LIGHT route, build a static release, run the Next source server, wire the optional source indexer, rebrand the client, or prepare a public source release. Always prefer the easiest MVR/LIGHT path first and keep the release source-only.
---

# FastPoker Standalone Setup

## Core Stance

Treat this repository as a source-code release. Users can run the source however
they want. Do not add packaged infrastructure unless the user explicitly reverses
that direction.

Use these repo docs as source of truth:

- `SETUP.md` for human setup commands.
- `OVERVIEW.md` for architecture, feature parity, status, and release gates.
- `AGENTS.md` / `CLAUDE.md` for repo-local agent rules.

## Choose The Run Path

Default to MVR / LIGHT unless the user specifically asks for relays, history,
leaderboards, or indexed stats.

MVR local:

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Static MVR release:

```bash
npm run build:static
```

Node server from source:

```bash
npm run build
PORT=3005 npm start
```

Optional source indexer:

```bash
cd ../Indexer
npm ci
npm run start
```

Wire by URL, not fixed process layout: `INDEXER_BASE_URL` powers server-side
table lists/history, and optional `NEXT_PUBLIC_INDEXER_WS_URL` powers browser
live push if set before building.

## Configuration Rules

- Blank `.env.local` is valid for MVR: mainnet, free public RPC pool, keyless TEE auth.
- Recommend a keyed `NEXT_PUBLIC_L1_RPC_URL` and `NEXT_PUBLIC_L1_WS_URL` before public traffic.
- Static export has no route handlers. It cannot rely on `/api/*`, `/rpc`, MongoDB,
  local files, or server-only secrets.
- Node relay routes may use `L1_RPC`, `AUTHORITY_KEYPAIR_PATH`, `TEE_RPC`,
  `TEE_API_KEY`, and `APP_ORIGIN`. They must never sign player wallet actions.
- The optional indexer is read-only and needs MongoDB, a keyed RPC, and Helius
  LaserStream for production-quality live data.
- FULL cash table listing uses `/api/tables/list`; with `INDEXER_BASE_URL` it reads
  the indexer's raw table cache first, then falls back to direct server RPC scans.
- `NEXT_PUBLIC_*` values are baked into the browser bundle at build time; rebuild
  after changing them.

## Release Checklist

Before saying the source release is ready, run:

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run build
npm run build:static
```

For indexer changes, run:

```bash
cd ../Indexer
npm run typecheck
```

Do not commit or ship `node_modules/`, `.next/`, `out/`, `.env`, `.env.local`,
keypair JSON, wallet files, logs, or generated NFT art.

## Go-Live Gates

- Mainnet fund-path smoke test is required before claiming cash flows are certified:
  create cash table, sit, play one hand, cash out, plus SNG join/play.
- Optional indexer must be tested with the operator's real MongoDB, RPC, and
  LaserStream credentials.
- Rebrand before public release. MIT covers the code, not the original FastPoker
  name, logos, token marks, or legal copy.
