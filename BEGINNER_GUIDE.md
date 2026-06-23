# Beginner Guide

This guide is for someone who wants to run the public FastPoker frontend source
without already knowing the project structure.

## What This Repo Is

This is a source-code frontend for the live FastPoker on-chain game. It is not a
private backend, custody server, database dump, or packaged hosting stack.

You can:

- Run it locally.
- Build a static site from it.
- Host it as a normal Next.js Node server.
- Connect it to your own read-only indexer for the FULL read experience.
- Fork it, rebrand it, and build your own frontend on top of it.

You still need a Solana wallet to play. Player actions are signed by the player's
wallet. The frontend does not take custody of player funds.

## Which Path Should I Choose?

| Goal | Choose | What you need |
| --- | --- | --- |
| Try the app on your computer | MVR local | Node, npm, browser wallet |
| Publish the smallest possible website | Static LIGHT | Node to build, any static host |
| Host a public site where users do not paste RPCs | Node server | Node server plus your own server-side RPC |
| Show full profiles, history, leaderboards, richer stats, and live indexed data | FULL | Node server, separate indexer, MongoDB, paid/dedicated RPC, stream provider |

If you are unsure, start with MVR local.

## Basic Terms

- **RPC:** the Solana API endpoint the frontend uses to read chain state and send
  transactions. Free public RPCs are useful for testing but may rate-limit,
  block browser requests, or reject heavy account scans.
- **TEE:** the MagicBlock execution environment used by the game for fast poker
  actions, hidden cards, and delegated table state.
- **Static LIGHT:** a browser-only build. It has no server API routes.
- **Node server:** the same frontend running with Next.js route handlers enabled.
- **Indexer:** a separate read-only service that stores chain-derived data in
  MongoDB for history, profiles, stats, leaderboards, and live push.
- **FULL:** the frontend plus the separate indexer. FULL is about indexed read
  parity, not a different frontend package.

## Install And Run Locally

Install Node 20 or newer. This repo's `.nvmrc` currently pins Node 22.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open:

```text
http://localhost:3005
```

The blank `.env.local` is intentionally valid. It uses mainnet, the built-in
best-effort public RPC pool, and keyless MagicBlock TEE auth.

## Wallet And Funds

Use a real Solana wallet such as Phantom, Backpack, or Solflare.

For live mainnet play you need enough SOL for transaction fees and whichever
entry, buy-in, or rent costs the UI shows. Rent shown in the UI is protocol rent
or account funding and may be refundable depending on the action.

Do not test with funds you cannot afford to lose. This is open-source software
interacting with live on-chain programs.

## RPC Choices

The easiest local path is to leave RPC blank and use the public pool. That is
best-effort only.

Public/free RPC limitations can show up as:

- Lobby tables loading slowly or partially.
- "My tables" or watch-table discovery missing some entries.
- CORS, 429, 413, 503, or 504 errors in the browser console.
- Transaction confirmation delays.

For a better local test, set a browser-reachable RPC in `.env.local`:

```bash
NEXT_PUBLIC_L1_RPC_URL=https://your-mainnet-rpc.example
NEXT_PUBLIC_L1_WS_URL=wss://your-mainnet-rpc-websocket.example
```

For a hosted public Node server, do not bake a private provider key into
`NEXT_PUBLIC_L1_RPC_URL`. Use the server proxy pattern instead:

```bash
NEXT_PUBLIC_L1_RPC_URL=/rpc
NEXT_PUBLIC_L1_WS_URL=wss://your-mainnet-rpc-websocket.example
L1_RPC=https://your-private-server-side-rpc.example
```

That makes browser HTTP RPC calls go through your same-origin `/rpc` route while
the private upstream URL stays server-side. The WebSocket URL still needs to be
browser-reachable because `/rpc` only proxies HTTP.

## Static LIGHT Build

Use this when you want a static website artifact:

```bash
npm run build:static
```

Upload `out/` to any static host.

Static LIGHT cannot run server routes like `/rpc`, `/api/tee/token`,
`/api/cash-game/*`, `/api/sitngos/ready`, `/api/tables/list`, or
`/api/my-sng-tables`. Users can still connect wallets and sign player
transactions, but server-assisted relay features require a Node server or an
external operator network.

Do not set `NEXT_PUBLIC_L1_RPC_URL=/rpc` for a static-only deployment because
there is no `/rpc` server route in `out/`.

## Node Server Run

Use this when you want the Next.js route handlers:

```bash
npm run build
PORT=3005 npm start
```

For relay-capable Node mode, configure:

```bash
NEXT_PUBLIC_L1_RPC_URL=/rpc
NEXT_PUBLIC_L1_WS_URL=wss://your-provider-ws.example
L1_RPC=https://your-provider-rpc.example
AUTHORITY_KEYPAIR_PATH=/absolute/path/to/operator-keypair.json
TEE_RPC=https://mainnet-tee.magicblock.app
APP_ORIGIN=https://your-public-origin.example
```

The authority keypair is for protocol helper transactions only. It does not sign
player actions, choose player amounts, or custody player funds.

## FULL Mode And The Indexer

The FULL read experience requires the separate indexer source package. The
frontend alone can still run without it, but it will not have full indexed
profiles, leaderboards, history, jackpot attribution, or live push.

For FULL, the web app needs:

```bash
NEXT_PUBLIC_ENABLE_INDEXER=true
INDEXER_BASE_URL=http://localhost:3001
NEXT_PUBLIC_INDEXER_WS_URL=ws://localhost:3001/ws
```

The indexer itself needs:

- MongoDB.
- A paid/dedicated mainnet RPC.
- A stream provider for production live updates.
- Stream credentials, such as LaserStream/Geyser-compatible credentials.

Free/public RPC is not enough for production FULL indexing. It can be useful for
local smoke tests, but it will lag or miss the live behavior expected from FULL.

## Privy Login

Privy is disabled by default. With the default env, the app shows native wallet
connect only.

To enable Privy, set your own app id and explicitly opt into the methods you
want:

```bash
NEXT_PUBLIC_PRIVY_APP_ID=your-app-id
NEXT_PUBLIC_PRIVY_LOGIN_ENABLED=true
NEXT_PUBLIC_PRIVY_LOGIN_EMAIL=true
NEXT_PUBLIC_PRIVY_LOGIN_GOOGLE=false
NEXT_PUBLIC_PRIVY_LOGIN_X=false
NEXT_PUBLIC_PRIVY_LOGIN_APPLE=false
```

Never ship another operator's Privy app id.

## Optional Frontend Fees

The source template can add an optional frontend operator fee. This is separate
from protocol buy-ins, prize pools, rake, or account rent.

Leave this blank to disable fees:

```bash
NEXT_PUBLIC_OPERATOR_FEE_WALLET=
```

To enable an example 1% SNG frontend fee:

```bash
NEXT_PUBLIC_OPERATOR_FEE_WALLET=your-solana-wallet
NEXT_PUBLIC_SNG_FEE_BPS=100
```

The UI should show frontend-added fees before the user signs.

## Rebranding

The code is MIT licensed. The FastPoker name, logos, token marks, and legal copy
are not included as a brand license.

Before shipping your own public fork:

- Set `NEXT_PUBLIC_BRAND_*` values in `.env.local`.
- Replace images in `public/brand/`.
- Replace Terms, Privacy, Consent, and any jurisdiction/legal copy with your own.
- Check `TRADEMARK.md`.

Brand env values are build-time values. Rebuild after changing them.

## Common Problems

### The page loads but tables or player data are missing

You are probably using the free public RPC pool or a limited browser RPC. Use a
capable RPC, hosted Node `/rpc`, or FULL indexer mode.

### Browser console shows CORS, 429, 413, 503, or 504

Your RPC provider is blocking the request, rate-limiting you, or rejecting a
large request. Switch RPC providers or host the Node server with server-side
`L1_RPC`.

### Static build has `/api/*` or `/rpc` 404 errors

Static LIGHT has no server route handlers. That is expected. Use Node server mode
if you need those routes.

### I changed `.env.local` but nothing changed in the browser

Restart `npm run dev`. For production builds, rebuild. `NEXT_PUBLIC_*` values are
baked into the browser bundle.

### Privy/email/social login buttons are showing unexpectedly

Check `NEXT_PUBLIC_PRIVY_LOGIN_ENABLED` and the individual
`NEXT_PUBLIC_PRIVY_LOGIN_*` flags. They should be `false` unless you intentionally
enabled them.

### FULL mode still looks incomplete

Confirm all three are true:

- `NEXT_PUBLIC_ENABLE_INDEXER=true` was set before building.
- `INDEXER_BASE_URL` points to a running indexer from the web server process.
- The indexer has MongoDB, RPC, and stream credentials and is caught up.

## What Not To Commit Or Publish

Do not commit or ship:

```text
node_modules/
.next/
out/
.env
.env.local
.env.*.local
*keypair*.json
*wallet*.json
logs/
public/nfts/
```

Ship the source, docs, `package.json`, `package-lock.json`, `src/`, `public/`,
and `scripts/`.

## Where To Read Next

- `README.md` is the project overview.
- `SETUP.md` is the command-focused setup guide.
- `OVERVIEW.md` explains architecture, modes, parity, and release gates.
- `AGENT_SETUP.md`, `AGENTS.md`, `CLAUDE.md`, and
  `skills/fastpoker-frontend-public-setup/SKILL.md` are for coding agents.
