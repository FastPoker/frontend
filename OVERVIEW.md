# FastPoker Client Standalone - Overview, Architecture & Status

A self-hostable, **open-source (MIT)**, white-label frontend for the on-chain
FastPoker game. It is a thin client to the live Solana program and MagicBlock TEE:
no proprietary fast.poker backend required, no database required for LIGHT, and no
secrets shipped. You bring your own RPC.

This repository ships as **source code**. Operators can run the source with Node,
export static files, use their own process manager, add MongoDB only for
FULL/indexer mode, or point at infrastructure they already operate. It is also a
fully functional frontend template/reference implementation that can be run as-is,
forked, rebranded, or used as a base for a custom frontend.

---

## 1. What It Is

The frontend is a **window into the on-chain game**. The game itself - shuffles,
deals, hidden cards, settlement - runs in the shared protocol: the Solana program,
the MagicBlock TEE, and the operator-run dealer/crank network. Anyone can host this
window and it talks to the same live game.

Run profiles, same source tree:

| Profile | What it is | Backend | Best for |
|---|---|---|---|
| **MVR / LIGHT** | Static client-side app on the free public RPC pool | none | easiest source run and static release |
| **Node server** | `next start` plus route handlers | operator keypair + server RPC | hosted relay/API/RPC surface |
| **FULL source mode** | Node server plus separate `Indexer` package | relays + indexer + MongoDB | profiles, history, leaderboards, stats, live push |

Everything a player does as a player - create a table, join, sit, bet, claim,
stake, bid, mint a dealer license, or leave - is an on-chain instruction signed
by their own wallet. Node/FULL relays only sign protocol helper transactions:
ready/delegation, top-up apply, cleanup, rake distribution, and TEE helper auth.
The relay keypair is not a custody wallet and never signs player actions.

---

## 2. Architecture

```text
Browser
  |-- reads/writes chain state  -> Solana RPC        (BYO; free pool by default)
  |-- gameplay/cards            -> MagicBlock TEE    (keyless wallet-signed JWT)
  |-- node relays, if enabled   -> /api/cash-game/*, /api/sitngos/ready, /api/tee/token
  `-- indexer, if enabled       -> /api/indexer/* -> read-only indexer + MongoDB
```

- **Client-side:** UI, transaction building, wallet signing, polling, and WebSocket
  reads. Runs in the visitor's browser.
- **RPC:** operator supplied for hosted/node deployments. Blank static/MVR config
  uses a rotating free public pool; serious public traffic should use either a
  same-origin `/rpc` proxy backed by server-side `L1_RPC`, or a browser-visible
  RPC endpoint users/operators knowingly provide.
- **TEE:** trusted game logic for shuffle/deal/hidden cards. LIGHT uses player
  wallet-signed auth directly from the browser. Node mode can also mint operator
  read tokens from `/api/tee/token`.
- **Relays:** node route handlers for same-origin `/rpc`, cash/SNG ready, top-up
  apply, stale cleanup, clear-rake, token metadata, jackpots, hand history, and
  process-local show-cards/player-notes.
- **Indexer:** optional, read-only source process. Crawls the chain and serves
  history, leaderboards, aggregate table stats, and live WebSocket push.

### What Changes By Profile

- **Player actions:** wallet-signed in every profile. This includes cash table
  creation, initial cash sit/deposit, SNG joins, `/earn` staking/claims,
  `/auctions` bids, and `/dealer/license` mints.
- **Relay-assisted protocol work:** available in node/FULL source mode; static LIGHT
  needs an external crank/dealer/relay network for the same helper work.
- **Discovery:** global table listing needs either the node table-list route with
  indexer/server RPC support or direct browser `getProgramAccounts`; free RPC
  providers often block the direct browser fallback.
- **History/stats:** require the source indexer.
- **Real-time:** client polling works everywhere; indexer adds WebSocket push.

---

## 3. Running It

See [SETUP.md](./SETUP.md) for exact setup commands. The short version:

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3005`.

### MVR / LIGHT Static

```bash
npm run build:static
```

Upload `out/` anywhere: CDN, static host, normal web server, GitHub Pages,
Cloudflare Pages, Netlify, or Vercel static hosting. Static export includes no
route handlers and no server dependencies.

### Node Server From Source

```bash
npm run build
PORT=3005 npm start
```

Set `L1_RPC`, `AUTHORITY_KEYPAIR_PATH`, `TEE_RPC`, and `APP_ORIGIN` when enabling
relay-capable routes.

### FULL Source Mode

Run the root Next app plus the `Indexer` package (a separate source package — run
it wherever you keep it):

```bash
npm ci && npm run start   # from the Indexer package directory
```

FULL read parity requires the indexer. The Next node server alone can host relay
routes and an operator RPC proxy, but profiles with indexed stats/achievements,
history, leaderboards, indexed stats, and live indexed push require the indexer.
Those profiles are standalone and read-only: on-chain XP plus the operator's own
indexer MongoDB, not the original fast.poker/clientv2 database.

The indexer needs MongoDB, a paid/dedicated mainnet RPC, and a stream provider for
live production-quality updates. The bundled stream adapter is LaserStream/Geyser
compatible, but `RPC_URL` is provider-neutral and standard Solana RPC history is
supported as a slower fallback. It listens on `INDEXER_PORT` (default 3001); set
the web app's `NEXT_PUBLIC_ENABLE_INDEXER=true` plus `INDEXER_BASE_URL` to turn on
frontend indexed reads, and optionally set
`NEXT_PUBLIC_INDEXER_WS_URL` (browser live push, set before building) at wherever
it's reachable - the on-disk layout doesn't matter.

A free Helius key is useful for frontend smoke testing but is not a production
FULL-indexer answer by itself. Current Helius docs list low free-tier RPC limits
and standard LaserStream WebSocket methods, but not mainnet LaserStream gRPC.
Without `STREAM_ENDPOINT`/`STREAM_API_KEY`, the public indexer falls back to
seeded/polled cache paths that can lag.

---

## 4. Configuration

Client env examples live in `.env.example`. The `Indexer` package has its own
`.env.example`.

- **Network/RPC:** `NEXT_PUBLIC_SOLANA_CLUSTER`, `NEXT_PUBLIC_L1_RPC_URL`,
  `NEXT_PUBLIC_L1_WS_URL`, `NEXT_PUBLIC_DEFAULT_TEE_RPC`, `NEXT_PUBLIC_DEFAULT_TEE_WS`.
  For hosted Node mode, set `NEXT_PUBLIC_L1_RPC_URL=/rpc`, server-side `L1_RPC`,
  and a browser-reachable `NEXT_PUBLIC_L1_WS_URL`.
- **Node relays:** `L1_RPC` or `L1_RPC_PROXY_UPSTREAM`, `AUTHORITY_KEYPAIR_PATH`,
  `TEE_RPC`, optional `TEE_API_KEY`, and `APP_ORIGIN`. This activates helper
  routes only; it does not replace player wallet signing.
- **Branding:** `NEXT_PUBLIC_BRAND_*`, assets under `public/brand/`, and
  `src/lib/branding.ts`.
- **Operator fee:** `NEXT_PUBLIC_OPERATOR_FEE_WALLET`, `NEXT_PUBLIC_SNG_FEE_BPS`,
  `NEXT_PUBLIC_SNG_FEE_FLAT_SOL`, cash equivalents, and
  `NEXT_PUBLIC_OPERATOR_FEE_CAP_SOL`. This is optional and disabled when the
  wallet is blank. It is a frontend-added SOL transfer in builds an operator
  ships, separate from protocol buy-ins, prize pools, rake, and custody.
- **On-chain overrides:** `NEXT_PUBLIC_FASTPOKER_PROGRAM_ID`, `NEXT_PUBLIC_POKER_MINT`,
  `NEXT_PUBLIC_POOL_PDA`, `NEXT_PUBLIC_TREASURY`, `NEXT_PUBLIC_CRANK_PUBKEY`, and
  permission/registry/steel program ids.
- **Privy:** disabled by default. Set your own `NEXT_PUBLIC_PRIVY_APP_ID` plus
  `NEXT_PUBLIC_PRIVY_LOGIN_ENABLED=true` to enable Privy; email, Google, X, and
  Apple login buttons each require their own `NEXT_PUBLIC_PRIVY_LOGIN_*` flag.
- **Indexer wiring:** client root sets `NEXT_PUBLIC_ENABLE_INDEXER=true` plus
  `INDEXER_BASE_URL` for indexed frontend reads; optional
  `NEXT_PUBLIC_INDEXER_WS_URL` enables browser live push. `Indexer` owns
  `RPC_URL`, optional `RPC_WS_URL`, `STREAM_PROVIDER`, `STREAM_ENDPOINT`,
  `STREAM_API_KEY`, `PROGRAM_ID`, `MONGO_URI`, and `MONGO_DB`. These are
  operator/server settings; users do not provide them.
- **Build mode:** `NEXT_OUTPUT=export` only for `npm run build:static`; unset for
  normal source node builds.

---

## 5. Feature Parity

| Feature | MVR free pool | MVR + own RPC | Node server | FULL source mode |
|---|---:|---:|---:|---:|
| SNG join pool -> play | yes | yes | yes | yes |
| Cash create table | yes | yes | yes | yes |
| Cash sit/deposit/play | external relay dependent | yes with capable infra | yes | yes |
| Claims/leave | yes | yes | yes | yes |
| Cash top-up/cleanup/clear-rake | no static relay | no static relay | yes | yes |
| Earn staking/claims | yes | yes | yes | yes |
| Token auction bids | limited by free RPC | yes | yes | yes |
| Dealer license mint | yes | yes | yes | yes |
| SNG tier player counts | yes | yes | yes | yes |
| Cash table discovery | limited by free RPC | yes | yes | yes, indexer-first |
| My tables list | limited by free RPC | yes | yes | yes, indexer-first |
| Public profile / XP / level | wallet XP only | wallet XP only | wallet XP only | indexed stats + XP |
| Achievements | derived locally, limited | derived locally, limited | derived locally, limited | indexed achievements |
| History/leaderboards/avg pot/VPIP | no | no | no | yes |
| Live indexed WebSocket push | no | no | no | yes |

The MVR path is intentionally the easiest route. The tradeoff is that static builds
cannot perform server-side relay work or read-side aggregation.

---

## 6. Open Source & Rebranding

- **License:** MIT (`LICENSE`).
- **Trademark:** the code is open; the original name, logo, `$FP` marks, and brand
  assets are not. Rebrand before shipping. See `TRADEMARK.md`.
- **Secrets:** none ship. `.env`, `.env.local`, keypairs, wallets, build output, and
  generated art are gitignored.
- **One-config reskin:** set `NEXT_PUBLIC_BRAND_*`, replace `public/brand/`, and
  provide your own legal copy.

---

## 7. Status & Release Gates

**Build state:** TypeScript, lint, node build, and static export have been wired and
verified during the port. The source release path is the target.

**Done:** SNG join/play; cash create + sit + play client flow; `/earn` staking and
claims; `/auctions` bid flow; `/dealer/license` mint flow; node relay route ports
for ready/top-up/cleanup/clear-rake/SNG ready; same-origin `/rpc`; metadata/history/
jackpot routes; process-local show-cards/player-notes; my-tables; branding;
operator fee; static export; MIT license and trademark docs.

**Gates before public go-live:**

1. **Mainnet fund-path smoke test.** Cash create + seat follows the production-proven
   sequence, but it moves real funds through the TEE delegation flow and must be
   runtime-certified with a funded wallet: create table, sit, play one hand, cash out,
   plus SNG join/play.
2. **FULL indexer live test.** Run with the operator's real MongoDB, RPC, and
   stream credentials and verify profiles, achievements, history, lobby stats,
   jackpots, and WebSocket updates end-to-end.
3. **Source release commit.** Commit and push the standalone source tree, including
   `package-lock.json` and docs. Ship `Indexer` as its own source package.

---

## 8. Known Limitations

- Free public RPC often blocks direct browser `getProgramAccounts`, so static
  LIGHT global cash table discovery and my-tables can be limited on the free pool.
  The auction leaderboard has the same limitation because rank discovery is a
  registry `getProgramAccounts` scan.
- Static export excludes all route handlers. Static deployments cannot use `/api/*`
  routes or same-origin `/rpc`.
- Process-local social storage works in node mode, but show-cards/player-notes are
  in-memory unless an operator adds a persistent store.
- Indexer operation is not free-pool infrastructure. It needs MongoDB and a
  paid/dedicated RPC; live production updates also need stream credentials.
- Legal copy still needs operator replacement before a public white-label release.

---

## 9. Parked / Roadmap

- **Usernames:** SNS `.sol` subdomains under a parent domain; parked pending SNS
  registrar setup.
- **Desktop binary:** deprioritized because desktop webviews cannot load browser
  wallet extensions; static web is the easier route.
- **Brand string tail:** visible UI is config-driven; operators still replace legal
  copy and any remaining project-specific prose.

---

## 10. Repo Map

```text
README.md                     release overview
SETUP.md                      human source setup instructions
AGENTS.md                     Codex/agent setup guidance
CLAUDE.md                     Claude setup guidance
src/lib/branding.ts           white-label brand config
src/lib/operator-fee.ts       optional frontend fee
src/lib/constants.ts          program ids, mints, PDAs, tiers
src/lib/onchain-game.ts       instruction builders and free-pool-safe reads
src/lib/rpc-pool.ts           rotating free public RPC pool
src/lib/table-discovery.ts    gPA-based table discovery
src/app/lobby/page.tsx        SNG join flow
src/app/game/page.tsx         cash/SNG table
src/app/my-tables/            cash create/list flows
src/app/earn/page.tsx         staking and reward claims
src/app/auctions/page.tsx     token listing auction bids
src/app/dealer/license/       dealer license mint
src/app/api/cash-game/*       node cash relay routes
src/app/api/sitngos/ready     node SNG ready/delegation relay
src/app/api/tee/token         node operator TEE token helper
src/app/api/indexer/[...path] optional Indexer proxy
scripts/build-static.sh       LIGHT static export -> out/
```
