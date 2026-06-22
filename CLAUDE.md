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

For a hosted public Node server, set:

```bash
NEXT_PUBLIC_L1_RPC_URL=/rpc
NEXT_PUBLIC_L1_WS_URL=wss://your-provider-ws.example
L1_RPC=https://your-provider-rpc.example
```

This makes visitors use the operator's same-origin RPC proxy for HTTP RPC calls,
so normal users do not need to configure their own RPC.

Privy is disabled by default. A public build should show wallet-only auth unless
the operator sets both `NEXT_PUBLIC_PRIVY_APP_ID` and
`NEXT_PUBLIC_PRIVY_LOGIN_ENABLED=true`. Email, Google, X, and Apple buttons are
separate opt-ins through `NEXT_PUBLIC_PRIVY_LOGIN_*` flags.

## FULL Indexer Path

The `Indexer` package is a separate source package — run it wherever it
lives (its own directory), not a fixed relative path:

```bash
npm ci && npm run start   # from the Indexer package directory
```

The indexer is read-only and required for FULL indexed read parity. It needs
MongoDB, a paid/dedicated mainnet RPC, and Helius LaserStream or equivalent Geyser
streaming for production-quality live data. Wire it by URL only:
`INDEXER_BASE_URL` powers server-side table lists/history, and optional
`NEXT_PUBLIC_INDEXER_WS_URL` powers browser live push if set before building.
Point those URLs at wherever the indexer listens (`INDEXER_PORT`, default 3001).

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
