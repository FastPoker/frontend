---
name: fastpoker-frontend-public-setup
description: Run, verify, publish, or troubleshoot the FastPoker standalone source-code frontend. Use when an agent is asked to set up the repo, explain the MVR/LIGHT route, build a static release, run the Next source server, wire the FULL source indexer, rebrand the client, or prepare a public source release. Always prefer the easiest MVR/LIGHT path first and keep the release source-only.
---

# FastPoker Standalone Setup

## Core Stance

Treat this repository as a source-code release. Users can run the source however
they want. Do not add packaged infrastructure unless the user explicitly reverses
that direction.

Treat the app as a fully functional frontend template/reference implementation.
Users may run it as-is, fork/rebrand it, or use it as the base for a custom
frontend. The source frontend is not a custody backend; player actions are still
wallet-signed protocol transactions.

Use these repo docs as source of truth:

- `SETUP.md` for human setup commands.
- `OVERVIEW.md` for architecture, feature parity, status, and release gates.
- `AGENT_SETUP.md` for a copy-paste install runbook for coding agents.
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

Hosted Node RPC setup:

```bash
NEXT_PUBLIC_L1_RPC_URL=/rpc
NEXT_PUBLIC_L1_WS_URL=wss://your-provider-ws.example
L1_RPC=https://your-provider-rpc.example
```

This uses the operator's same-origin RPC proxy, so normal visitors do not need to
bring their own RPC. Do not put a private provider URL/key directly in
`NEXT_PUBLIC_L1_RPC_URL` for a public build.

FULL source indexer:

```bash
npm ci && npm run start   # from the Indexer package directory
```

Wire by URL, not fixed process layout: `NEXT_PUBLIC_ENABLE_INDEXER=true` plus
`INDEXER_BASE_URL` turns on indexed table/profile/history/jackpot/stat reads, and
optional `NEXT_PUBLIC_INDEXER_WS_URL` powers
browser live push if set before building.

## Configuration Rules

- Blank `.env.local` is valid for MVR: mainnet, free public RPC pool, keyless TEE auth.
- For static/LIGHT public traffic, recommend a capable browser-reachable RPC or
  let users set one in-app. For hosted Node traffic, prefer
  `NEXT_PUBLIC_L1_RPC_URL=/rpc` plus server-side `L1_RPC`.
- Static export has no route handlers. It cannot rely on `/api/*`, `/rpc`, MongoDB,
  local files, or server-only secrets.
- MongoDB is only required for FULL indexed reads through the separate indexer.
  MVR, static LIGHT, and frontend-only Node mode do not need a database.
- Node relay routes may use `L1_RPC`, `AUTHORITY_KEYPAIR_PATH`, `TEE_RPC`,
  `TEE_API_KEY`, and `APP_ORIGIN`. They must never sign player wallet actions.
- Privy is disabled by default. It requires `NEXT_PUBLIC_PRIVY_APP_ID` plus
  `NEXT_PUBLIC_PRIVY_LOGIN_ENABLED=true`; email, Google, X, and Apple buttons
  each require their own `NEXT_PUBLIC_PRIVY_LOGIN_*` flag.
- Optional operator fees are frontend-only env settings:
  `NEXT_PUBLIC_OPERATOR_FEE_WALLET`, `NEXT_PUBLIC_SNG_FEE_BPS`,
  `NEXT_PUBLIC_SNG_FEE_FLAT_SOL`, cash equivalents, and
  `NEXT_PUBLIC_OPERATOR_FEE_CAP_SOL`. Leave the wallet blank to disable. Explain
  them as frontend-added SOL transfers shown to users, not protocol rake,
  prize-pool changes, or custody logic.
- The indexer is read-only and required for FULL indexed read parity. It needs
  MongoDB, a paid/dedicated RPC, and stream credentials for production-quality
  live data.
- Browser indexer reads are explicit. Leave `NEXT_PUBLIC_ENABLE_INDEXER=false`
  unless the operator is running the source indexer and has set `INDEXER_BASE_URL`.
- FULL cash table listing uses `/api/tables/list`; with `NEXT_PUBLIC_ENABLE_INDEXER=true`
  plus `INDEXER_BASE_URL` it reads the indexer's raw table cache first, then falls
  back to direct server RPC scans.
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
npm run typecheck   # from the Indexer package directory
```

Do not commit or ship `node_modules/`, `.next/`, `out/`, `.env`, `.env.local`,
keypair JSON, wallet files, logs, or generated NFT art.

## Go-Live Gates

- Mainnet fund-path smoke test is required before claiming cash flows are certified:
  create cash table, sit, play one hand, cash out, plus SNG join/play.
- FULL indexer must be tested with the operator's real MongoDB, RPC, and stream
  credentials.
- Rebrand before public release. MIT covers the code, not the original FastPoker
  name, logos, token marks, or legal copy.
