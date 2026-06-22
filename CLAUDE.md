# FastPoker Standalone Claude Guide

Follow these project rules when helping a user run, modify, or publish this clone.

## Source-First Direction

This repository is released as source code. Do not add packaged backend
instructions. Users can run the source however they want. The supported paths are:

- MVR / LIGHT local dev
- Static export from `out/`
- Next node server from source
- Optional read-side indexer from source

Use `SETUP.md` for exact setup commands and `OVERVIEW.md` for architecture,
feature parity, status, and release gates.

## Fastest MVR Path

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3005`.

For a static public artifact:

```bash
npm run build:static
```

Upload `out/` to any static host. Static LIGHT must not require `/api/*`,
MongoDB, keypairs, or server-only route handlers.

## Source Node Path

```bash
npm run build
PORT=3005 npm start
```

Relay-capable node mode may use `L1_RPC`, `AUTHORITY_KEYPAIR_PATH`, `TEE_RPC`,
`TEE_API_KEY`, and `APP_ORIGIN`. These relays sign protocol helper transactions
only. They must never sign player wallet actions or custody player funds.

## Optional Indexer Path

The `Indexer` package is a separate source package — run it wherever it
lives (its own directory), not a fixed relative path:

```bash
npm ci && npm run start   # from the Indexer package directory
```

The indexer is read-only and optional. It needs MongoDB, a keyed mainnet RPC, and
Helius LaserStream for production-quality live data. Wire it by URL only: set the
web app's `INDEXER_BASE_URL` (server) + `NEXT_PUBLIC_INDEXER_WS_URL` (browser, before
building) at wherever the indexer listens (`INDEXER_PORT`, default 3001).

## Validation

Run before publishing:

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run build
npm run build:static
```

For indexer edits, from the `Indexer` package:

```bash
npm run typecheck
```

Never commit `.env`, `.env.local`, keypair JSON, wallet files, `node_modules/`,
`.next/`, `out/`, or generated NFT art. Rebrand before public release; the MIT
license covers the code, not the original FastPoker marks.
