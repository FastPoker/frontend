# FastPoker Standalone Agent Guide

Use this file when Codex or another coding agent is asked to run, verify, modify,
or publish this standalone client.

## Project Position

- This is a source-code release. Do not add packaged backend assumptions unless the
  user explicitly changes that direction.
- This is a fully functional frontend template/reference implementation. Users may
  run it as-is, fork/rebrand it, or use it as a base for a custom frontend.
- The easiest path is MVR / LIGHT: `npm ci`, `cp .env.example .env.local`,
  `npm run dev`, or `npm run build:static`.
- Treat `BEGINNER_GUIDE.md` as the plain-English starting point, `SETUP.md` as
  the human command source of truth, and `OVERVIEW.md` as the architecture/status
  source of truth.
- Use `AGENT_SETUP.md` when a user wants a copy-paste install runbook for Codex,
  Claude, or another coding agent.

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
npm ci && npm run start   # from the Indexer package directory
```

Wire the indexer by URL, not by folder assumptions. `NEXT_PUBLIC_ENABLE_INDEXER=true`
plus `INDEXER_BASE_URL` turns on indexed table/profile/history/jackpot/stat reads;
`NEXT_PUBLIC_INDEXER_WS_URL` is
optional browser live push and must be set before building if used.

## Rules For Changes

- Keep static LIGHT free of server-route requirements. Static export must not depend
  on `/api/*`, `/rpc`, local files, MongoDB, or private keys.
- MongoDB is only required for FULL indexed reads through the separate indexer.
  MVR, static LIGHT, and frontend-only Node mode do not need a database.
- Keep node relay routes explicit. They may use `L1_RPC`, `AUTHORITY_KEYPAIR_PATH`,
  `TEE_RPC`, `TEE_API_KEY`, and `APP_ORIGIN`, but they must not custody player wallets
  or sign player actions.
- Keep public-source auth wallet-only by default. Privy requires both
  `NEXT_PUBLIC_PRIVY_APP_ID` and `NEXT_PUBLIC_PRIVY_LOGIN_ENABLED=true`; email,
  Google, X, and Apple buttons require their own `NEXT_PUBLIC_PRIVY_LOGIN_*` flags.
- Optional operator fees are frontend-only env settings:
  `NEXT_PUBLIC_OPERATOR_FEE_WALLET`, `NEXT_PUBLIC_SNG_FEE_BPS`,
  `NEXT_PUBLIC_SNG_FEE_FLAT_SOL`, cash equivalents, and
  `NEXT_PUBLIC_OPERATOR_FEE_CAP_SOL`. Leave the wallet blank to disable. Do not
  describe these as protocol rake, prize-pool changes, or custody logic.
- Treat FULL as Node server plus the source indexer. Node server without the indexer
  is hosted relay/RPC mode, not full indexed read parity. Indexed frontend reads
  should only be enabled when `NEXT_PUBLIC_ENABLE_INDEXER=true`.
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
npm run typecheck   # from the Indexer package directory
```

## Known Gates

- Mainnet fund-path smoke test is still required before claiming cash flows are
  production-certified: create cash table, sit, play one hand, cash out, plus SNG
  join/play.
- FULL indexer must be tested with the operator's real MongoDB, RPC, and stream
  credentials; production FULL/live mode requires streaming.
