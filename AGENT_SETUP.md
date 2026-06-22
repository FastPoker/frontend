# Agent Setup Runbook

Use this file with Codex, Claude, or another coding agent when you want help
installing, configuring, or verifying this public source release.

## Agent Prompt

Copy this into your agent:

```text
You are helping me run the FastPoker public frontend source release.

Start with the easiest MVR path unless I explicitly ask for FULL:
1. Verify Node is available and install dependencies with npm ci.
2. Copy .env.example to .env.local if it does not exist.
3. Run npm run dev and tell me the local URL.

For a static release, run npm run build:static and confirm out/ was created.

For hosted Node mode, help me set:
- NEXT_PUBLIC_L1_RPC_URL=/rpc
- NEXT_PUBLIC_L1_WS_URL=<browser-reachable websocket RPC>
- L1_RPC=<server-side paid/dedicated mainnet RPC>

For FULL indexed reads, also help me run the separate Indexer package. MongoDB is
required for FULL. SQLite is not supported in this release. The indexer also
needs a paid/dedicated Solana RPC, and production live updates should use a
stream provider. Wire the frontend with:
- NEXT_PUBLIC_ENABLE_INDEXER=true
- INDEXER_BASE_URL=http://localhost:3001
- NEXT_PUBLIC_INDEXER_WS_URL=ws://localhost:3001/ws if browser live push is needed

Do not add Docker or IPFS setup. Do not commit .env files, keypairs, node_modules,
.next, out, logs, or generated runtime data.
```

## Human Checklist

MVR local:

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Static LIGHT:

```bash
npm ci
cp .env.example .env.local
npm run build:static
```

Node server:

```bash
npm ci
cp .env.example .env.local
npm run build
PORT=3005 npm start
```

FULL source mode:

1. Run the frontend as a Node server.
2. Run the separate Indexer package with MongoDB and a paid/dedicated RPC.
3. Set `NEXT_PUBLIC_ENABLE_INDEXER=true` and `INDEXER_BASE_URL` in the frontend.
4. Rebuild/restart the frontend after changing any `NEXT_PUBLIC_*` values.

Validation:

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run build
npm run build:static
```
