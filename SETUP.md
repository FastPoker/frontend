# Source Setup

This repo ships as source code. The easiest route is **MVR / LIGHT**: install
dependencies, run the frontend, or export static files. No private backend,
database, or keypair is required for that path.

## 1. Requirements

Choose the smallest path that fits what you want to run:

| Path | Requirements |
| --- | --- |
| MVR local dev | Node 20+ (`.nvmrc` currently pins 22), browser wallet |
| Static LIGHT release | Node 20+ to build, any static host to serve `out/` |
| Node server | Node 20+, a server/VM/process manager, paid/dedicated Solana RPC recommended for hosted traffic |
| FULL source mode | Node 20+, this frontend, the separate Indexer package, MongoDB, paid/dedicated Solana RPC, optional stream provider for production live updates |

MongoDB is required only for FULL indexed reads because the indexer stores
chain-derived tables, hands, player stats, jackpots, and leaderboards there.
There is no SQLite mode in this release.

Docker and IPFS are not part of the supported setup path. This is a source-code
release: run it with Node, your preferred process manager, and your preferred host.

## 2. Easiest MVR Run

Use this when you just want to run the client locally and connect a wallet.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3005`.

Blank `.env.local` values are valid for local MVR. The app defaults to mainnet, a
rotating free public RPC pool, and keyless MagicBlock TEE auth.

For a hosted Node server where visitors should not bring their own RPC, use the
operator RPC proxy setup in section 4 instead of exposing a provider key in
`NEXT_PUBLIC_L1_RPC_URL`.

Privy is disabled by default. With no Privy app id and no
`NEXT_PUBLIC_PRIVY_LOGIN_ENABLED=true`, the connect flow is wallet-only
(Phantom / Backpack / Solflare). To add Privy, set your own app id, enable Privy,
and opt into each visible method with `NEXT_PUBLIC_PRIVY_LOGIN_EMAIL`,
`NEXT_PUBLIC_PRIVY_LOGIN_GOOGLE`, `NEXT_PUBLIC_PRIVY_LOGIN_X`, or
`NEXT_PUBLIC_PRIVY_LOGIN_APPLE`.

## 3. Easiest Static Release

Use this when you want the smallest possible public artifact.

```bash
npm ci
cp .env.example .env.local
npm run build:static
```

Upload `out/` to any static host, CDN, normal web server, GitHub Pages, Cloudflare
Pages, Netlify, or Vercel static hosting.

Static LIGHT has no server route handlers. It cannot run `/api/indexer`, `/rpc`,
`/api/cash-game/*`, `/api/sitngos/ready`, or `/api/tee/token`. It can still build
wallet-signed player transactions and talk directly to Solana RPC and the TEE.

## 4. Node Server Source Run

Use this when you want the Next route handlers as part of your own server process.

```bash
npm ci
cp .env.example .env.local
npm run build
PORT=3005 npm start
```

Set these for relay-capable node mode:

```bash
NEXT_PUBLIC_L1_RPC_URL=/rpc
NEXT_PUBLIC_L1_WS_URL=wss://your-mainnet-rpc-websocket.example
L1_RPC=https://your-mainnet-rpc.example
AUTHORITY_KEYPAIR_PATH=/absolute/path/to/operator-keypair.json
TEE_RPC=https://mainnet-tee.magicblock.app
APP_ORIGIN=https://your-public-origin.example
```

`NEXT_PUBLIC_L1_RPC_URL=/rpc` tells the browser to use your same-origin Next route
as an HTTP Solana RPC proxy. The real provider URL stays in server-side `L1_RPC`,
so normal visitors do not need their own RPC and your provider key is not baked
into browser JavaScript. `NEXT_PUBLIC_L1_WS_URL` still needs to be a browser-reachable
WebSocket endpoint because `/rpc` is HTTP-only.

The operator keypair is used only for protocol helper transactions and TEE helper
auth. It never signs as a player wallet. Never commit `.env.local` or keypair JSON.

## 5. FULL Source Indexer

The Next node server can be useful without the indexer, but the FULL read
experience requires the indexer. Run it when you want history, leaderboards,
richer lobby stats, per-wallet jackpot attribution, and live WebSocket push.

Prerequisites:

- A MongoDB instance you run or rent.
- The indexer uses MongoDB only in this release. SQLite is not supported.
- A paid/dedicated mainnet RPC. Do not use public/free Solana RPC.
- A stream provider for production live indexed updates. The bundled adapter is
  LaserStream/Geyser-compatible, but the base `RPC_URL` is provider-neutral.

Root web env:

```bash
NEXT_PUBLIC_ENABLE_INDEXER=true
INDEXER_BASE_URL=http://localhost:3001
NEXT_PUBLIC_INDEXER_WS_URL=ws://localhost:3001/ws
```

`NEXT_PUBLIC_ENABLE_INDEXER=true` is the frontend switch for indexed reads.
`INDEXER_BASE_URL` is the server-side target URL and is not exposed to the
browser. Both are required for table/profile/history/jackpot/stat enrichment to
use the indexer; otherwise the app falls back to direct RPC paths where possible.
`NEXT_PUBLIC_INDEXER_WS_URL` is only for browser live push and must be set before
building if you want it in the client bundle. The indexer RPC is server-side; end
users never provide it.

The indexer is a separate package (this release ships it alongside the frontend;
run it from wherever you keep it — the directory layout doesn't matter). In the
indexer package, copy its env:

```bash
cp .env.example .env
```

Edit at least:

```bash
MONGO_URI=mongodb://localhost:27017
MONGO_DB=fastpoker_indexer
RPC_URL=https://your-dedicated-mainnet-rpc.example
RPC_WS_URL=wss://your-dedicated-mainnet-rpc-websocket.example
STREAM_PROVIDER=laserstream
STREAM_ENDPOINT=https://your-laserstream-geyser-endpoint.example
STREAM_API_KEY=YOUR_STREAM_KEY
PROGRAM_ID=PokerXYdXL2SKNnfGbv1WE7vJHipTpNsfZbZeVvoJLn
INDEXER_PORT=3001
```

Then install and run it (from the indexer package directory):

```bash
npm ci
npm run start
```

It listens on `INDEXER_PORT` (default 3001). Set the web app's
`NEXT_PUBLIC_ENABLE_INDEXER=true`, point `INDEXER_BASE_URL` (server-side) at it,
and optionally set `NEXT_PUBLIC_INDEXER_WS_URL` (browser) wherever it's reachable
- only the URLs matter, not where the indexer lives on disk.

Then build or restart the root web app after `NEXT_PUBLIC_ENABLE_INDEXER` or
`NEXT_PUBLIC_INDEXER_WS_URL` changes, because `NEXT_PUBLIC_*` values are baked into
the browser bundle at build time.

## 6. Optional Frontend Fee

This source template can optionally add a frontend operator fee on top of entry
transactions. This is not the protocol buy-in, prize pool, or rake. It is a
frontend-level SOL transfer included only in builds you ship, shown in the JOIN
price and confirmation UI, and disabled by default.

Leave `NEXT_PUBLIC_OPERATOR_FEE_WALLET` blank for no frontend fee. To enable it:

```bash
NEXT_PUBLIC_OPERATOR_FEE_WALLET=<your-solana-wallet>
NEXT_PUBLIC_SNG_FEE_BPS=100
NEXT_PUBLIC_SNG_FEE_FLAT_SOL=
NEXT_PUBLIC_CASH_FEE_BPS=
NEXT_PUBLIC_CASH_FEE_FLAT_SOL=
NEXT_PUBLIC_OPERATOR_FEE_CAP_SOL=
```

`NEXT_PUBLIC_SNG_FEE_BPS=100` means 1% on SNG entries. Flat values are in SOL.
The code caps percentage fees at 10% even if a higher bps value is configured.
Cash fee envs use the same model, but are dormant until the cash entry fee flow
is enabled in this source release.

## 7. Rebrand Before Shipping

Set `NEXT_PUBLIC_BRAND_*` values in `.env.local`, update `public/brand/`, and replace
the legal copy with your own Terms/Privacy/Consent text. The MIT license covers the
code; the original FastPoker name, logos, and token marks are not yours to ship.

## 8. Agent-Assisted Setup

If you want Codex, Claude, or another coding agent to install and verify the
source release, point it at [AGENT_SETUP.md](./AGENT_SETUP.md). That file is a
copy-paste runbook for MVR, static, Node server, and FULL indexer setup.

## 9. Validation

Run these before publishing source:

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run build
npm run build:static
```

For FULL source mode, from the indexer package:

```bash
npm ci
npm run typecheck
```

## 10. What Not To Ship

Do not include:

```text
node_modules/
.next/
out/
.env
.env.local
.env.*.local
*keypair*.json
*wallet*.json
public/nfts/
```

The client source release should include `package.json`, `package-lock.json`, `src/`,
`public/`, `scripts/`, and the docs. Ship `Indexer` as its own source
package for FULL indexed read parity.
