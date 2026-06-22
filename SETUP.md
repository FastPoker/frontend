# Source Setup

This repo ships as source code. The easiest route is **MVR / LIGHT**: install
dependencies, run the frontend, or export static files. No private backend,
database, or keypair is required for that path.

## 1. Easiest MVR Run

Use this when you just want to run the client locally and connect a wallet.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3005`.

Blank `.env.local` values are valid. The app defaults to mainnet, a rotating free
public RPC pool, and keyless MagicBlock TEE auth. For a public deployment, set
`NEXT_PUBLIC_L1_RPC_URL` and `NEXT_PUBLIC_L1_WS_URL` to your own RPC provider.

## 2. Easiest Static Release

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

## 3. Node Server Source Run

Use this when you want the Next route handlers as part of your own server process.

```bash
npm ci
cp .env.example .env.local
npm run build
PORT=3005 npm start
```

Set these for relay-capable node mode:

```bash
L1_RPC=https://your-mainnet-rpc.example
AUTHORITY_KEYPAIR_PATH=/absolute/path/to/operator-keypair.json
TEE_RPC=https://mainnet-tee.magicblock.app
APP_ORIGIN=https://your-public-origin.example
```

The operator keypair is used only for protocol helper transactions and TEE helper
auth. It never signs as a player wallet. Never commit `.env.local` or keypair JSON.

## 4. Optional Source Indexer

The indexer is optional. Run it only if you want history, leaderboards, richer lobby
stats, per-wallet jackpot attribution, and live WebSocket push.

Prerequisites:

- A MongoDB instance you run or rent.
- A keyed mainnet RPC.
- Helius LaserStream credentials for live indexed updates.

Root web env:

```bash
INDEXER_BASE_URL=http://localhost:3001
NEXT_PUBLIC_INDEXER_WS_URL=ws://localhost:3001/ws
```

`INDEXER_BASE_URL` powers server-side table lists/history. `NEXT_PUBLIC_INDEXER_WS_URL`
is only for browser live push and must be set before building if you want it in
the client bundle.

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
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
LASERSTREAM_ENDPOINT=https://laserstream-mainnet-ewr.helius-rpc.com
HELIUS_API_KEY=YOUR_KEY
PROGRAM_ID=PokerXYdXL2SKNnfGbv1WE7vJHipTpNsfZbZeVvoJLn
INDEXER_PORT=3001
```

Then install and run it (from the indexer package directory):

```bash
npm ci
npm run start
```

It listens on `INDEXER_PORT` (default 3001). Point the web app's `INDEXER_BASE_URL`
(server-side) and optional `NEXT_PUBLIC_INDEXER_WS_URL` (browser) at wherever it's
reachable - only the URLs matter, not where the indexer lives on disk.

Then build or restart the root web app after `NEXT_PUBLIC_INDEXER_WS_URL` is set,
because `NEXT_PUBLIC_*` values are baked into the browser bundle at build time.

## 5. Rebrand Before Shipping

Set `NEXT_PUBLIC_BRAND_*` values in `.env.local`, update `public/brand/`, and replace
the legal copy with your own Terms/Privacy/Consent text. The MIT license covers the
code; the original FastPoker name, logos, and token marks are not yours to ship.

## 6. Validation

Run these before publishing source:

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run build
npm run build:static
```

If you ship the optional indexer, from the indexer package:

```bash
npm ci
npm run typecheck
```

## 7. What Not To Ship

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
package when you want the optional indexer.
