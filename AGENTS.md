# FastPoker Standalone Agent Guide

Use this file when Codex or another coding agent is asked to run, verify, modify,
or publish this standalone client.

## Project Position

- This is a source-code release. Do not add packaged backend assumptions unless the
  user explicitly changes that direction.
- The easiest path is MVR / LIGHT: `npm ci`, `cp .env.example .env.local`,
  `npm run dev`, or `npm run build:static`.
- Treat `SETUP.md` as the human setup source of truth and `OVERVIEW.md` as the
  architecture/status source of truth.

## Run Paths

MVR local:

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Static release:

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

This makes normal visitors use the operator's same-origin RPC proxy. Do not bake a
private provider key into `NEXT_PUBLIC_L1_RPC_URL`.

FULL indexer from source:

```bash
cd ../Indexer
npm ci
npm run start
```

Wire the indexer by URL, not by folder assumptions. `INDEXER_BASE_URL` powers
server-side table lists/history; `NEXT_PUBLIC_INDEXER_WS_URL` is optional browser
live push and must be set before building if used.

## Rules For Changes

- Keep static LIGHT free of server-route requirements. Static export must not depend
  on `/api/*`, `/rpc`, local files, MongoDB, or private keys.
- Keep node relay routes explicit. They may use `L1_RPC`, `AUTHORITY_KEYPAIR_PATH`,
  `TEE_RPC`, `TEE_API_KEY`, and `APP_ORIGIN`, but they must not custody player wallets
  or sign player actions.
- Keep public-source auth wallet-only by default. Privy requires both
  `NEXT_PUBLIC_PRIVY_APP_ID` and `NEXT_PUBLIC_PRIVY_LOGIN_ENABLED=true`; email,
  Google, X, and Apple buttons require their own `NEXT_PUBLIC_PRIVY_LOGIN_*` flags.
- Treat FULL as Node server plus the source indexer. Node server without the indexer
  is hosted relay/RPC mode, not full indexed read parity.
- Keep secrets out of source. Never commit `.env`, `.env.local`, keypair JSON, wallet
  files, or generated build output.
- Prefer source setup instructions over infrastructure opinions. Users can run the
  source with any process manager or host they choose.
- Rebrand before public release. The code is MIT; the original FastPoker brand,
  logo, and token marks are not part of the open-source grant.

## Validation

Before calling source-release work done, run:

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run build
npm run build:static
```

For indexer changes, also run:

```bash
cd ../Indexer
npm run typecheck
```

## Known Gates

- Mainnet fund-path smoke test is still required before claiming cash flows are
  production-certified: create cash table, sit, play one hand, cash out, plus SNG
  join/play.
- FULL indexer must be tested with the operator's real MongoDB, RPC, and
  LaserStream credentials.
