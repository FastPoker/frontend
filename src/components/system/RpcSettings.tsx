'use client';

/**
 * RPC configuration panel — pick a provider and paste an endpoint, with a Test.
 * Precedence: this panel (frontend, localStorage) > host build env > free pool.
 * Same control serves end-users and operators (operators can also bake a default
 * into the build via NEXT_PUBLIC_L1_RPC_URL; this overrides it per browser).
 */
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { getUserRpcUrl, getUserWsUrl, setUserRpc, clearUserRpc, getRequestLevel, setRequestLevel, type RequestLevel } from '@/lib/user-config';
import { getRpcMeter, subscribeRpcMeter, resetRpcMeter, type RpcMeterSnapshot } from '@/lib/rpc-meter';

// Two real tiers. Everything cheap (SNG tiers, jackpot, prices, supply/burn
// stats, claimable, your seated tables) loads at Minimal - single-account /
// chunked reads, slow-polled, so the free pool serves it. Full adds global
// cash + watch discovery through the node route/indexer first, with direct RPC
// scans as the browser/static fallback.
const LEVELS: { id: RequestLevel; label: string; blurb: string }[] = [
  { id: 'mvr', label: 'Minimal', blurb: 'SNG tiers, jackpot, prices, supply/burn stats & claimable - slow-polled. Works on the free pool.' },
  { id: 'full', label: 'Full', blurb: 'Adds cash + watch table discovery. Node FULL uses the table-list route/indexer; static fallback may need your own RPC.' },
];

type ProviderId = 'site' | 'pool' | 'helius' | 'quicknode' | 'custom';

// The operator's configured RPC (build-time env). When present it's the default,
// and gets its own selectable option so a user can revert to it after trying
// their own. NOTE: a keyless operator-proxy URL here is safe; a keyed URL would
// be inlined into the bundle (don't ship that publicly).
const SITE_RPC = (process.env.NEXT_PUBLIC_L1_RPC_URL || '').trim();
const HAS_SITE_RPC = SITE_RPC !== '' && SITE_RPC !== '/rpc' && SITE_RPC.toLowerCase() !== 'pool';

interface Provider {
  id: ProviderId;
  name: string;
  badge?: string;
  recommended?: boolean;
  blurb: string;
  needsUrl: boolean;
  signup?: string;
  signupLabel?: string;
  upgrade?: string;
  placeholder?: string;
  match?: RegExp;
}

const PROVIDERS: Provider[] = [
  // Shown only when the operator baked in an RPC (env). Selecting it clears any
  // per-browser override so you use the site's endpoint.
  ...(HAS_SITE_RPC ? [{
    id: 'site' as ProviderId, name: 'Site default RPC', badge: 'DEFAULT', recommended: true, needsUrl: false,
    blurb: "Use the endpoint this site is configured with by its operator. Recommended on a hosted site — set up for reliability, no key to manage.",
  }] : []),
  {
    id: 'pool', name: 'Free public pool', badge: HAS_SITE_RPC ? 'FREE' : 'DEFAULT', needsUrl: false,
    blurb: 'No setup. Rotates across free public RPCs with automatic failover. Works out of the box, but free endpoints rate-limit under load.',
  },
  {
    id: 'helius', name: 'Helius', badge: 'FREE TIER', recommended: true, needsUrl: true,
    blurb: 'Generous free tier and strong reliability. Best balance for most players.',
    signup: 'https://dashboard.helius.dev/signup', signupLabel: 'Create a free Helius key (1 min)',
    upgrade: 'https://www.helius.dev/pricing',
    placeholder: 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
    match: /helius-rpc\.com/i,
  },
  {
    id: 'quicknode', name: 'QuickNode', badge: 'PAID', needsUrl: true,
    blurb: 'Fast global endpoints with high-throughput paid plans.',
    signup: 'https://www.quicknode.com/signup', signupLabel: 'Get a QuickNode endpoint',
    upgrade: 'https://www.quicknode.com/pricing',
    placeholder: 'https://your-endpoint.solana-mainnet.quiknode.pro/TOKEN/',
    match: /quiknode\.pro|quicknode/i,
  },
  {
    id: 'custom', name: 'Custom RPC', needsUrl: true,
    blurb: 'Any Solana RPC URL, plus an optional WebSocket endpoint.',
    placeholder: 'https://your-rpc.example.com',
  },
];

function detectProvider(url: string): ProviderId {
  if (!url || url.toLowerCase() === 'pool') return 'pool';
  for (const p of PROVIDERS) if (p.match?.test(url)) return p.id;
  return 'custom';
}

type TestState = { kind: 'idle' | 'testing' | 'ok' | 'err'; msg?: string };

async function pingRpc(url: string): Promise<TestState> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion' }), signal: ctrl.signal,
    });
    const ms = Math.round(performance.now() - start);
    const j = await res.json().catch(() => ({}));
    if (res.ok && j?.result) return { kind: 'ok', msg: `Connected · core ${j.result['solana-core']} · ${ms}ms` };
    return { kind: 'err', msg: `HTTP ${res.status}` };
  } catch (e: any) {
    return { kind: 'err', msg: e?.name === 'AbortError' ? 'timed out' : (e?.message || 'failed') };
  } finally { clearTimeout(t); }
}

export function RpcSettings() {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<ProviderId>('pool');
  const [rpc, setRpc] = useState('');
  const [ws, setWs] = useState('');
  const [level, setLevel] = useState<RequestLevel>('mvr');
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [meter, setMeter] = useState<RpcMeterSnapshot>(getRpcMeter);
  useEffect(() => subscribeRpcMeter(setMeter), []);

  function load() {
    const override = getUserRpcUrl(); // '' | 'pool' | <url>
    // Reflect the ACTUAL active provider, not just the override: with no
    // override but an env RPC baked in (e.g. Helius in .env.local), the build is
    // really on that endpoint — show it, so the modal can't claim "Free pool"
    // while quietly using Helius. Never prefill the env URL into the input (it
    // may carry a key); only a user-set URL is shown for editing.
    let selected: ProviderId;
    if (override.toLowerCase() === 'pool') selected = 'pool';
    else if (override) selected = detectProvider(override); // user's own URL
    else selected = HAS_SITE_RPC ? 'site' : 'pool';         // no override → site default / pool
    setSel(selected);
    setRpc(override && override.toLowerCase() !== 'pool' ? override : '');
    setWs(getUserWsUrl());
    // 'higher' is retired (everything cheap is on at Minimal); show it as Minimal.
    setLevel(getRequestLevel() === 'full' ? 'full' : 'mvr');
    setTest({ kind: 'idle' });
    setOpen(true);
  }

  // Let any "off at this level" notice open this panel.
  useEffect(() => {
    const h = () => load();
    window.addEventListener('fp:open-rpc-settings', h);
    return () => window.removeEventListener('fp:open-rpc-settings', h);
  }, []);

  function pick(id: ProviderId) {
    setSel(id);
    setTest({ kind: 'idle' });
    if (id === 'pool' || id === 'site') { setRpc(''); setWs(''); }
  }

  async function runTest() {
    if (!rpc.trim()) { setTest({ kind: 'err', msg: 'enter an RPC URL' }); return; }
    setTest({ kind: 'testing' });
    setTest(await pingRpc(rpc.trim()));
  }

  function save() {
    // 'site'  → clear the override, fall back to the operator's env RPC.
    // 'pool'  → store the sentinel, FORCE the free pool even over an env RPC.
    // else    → bring-your-own URL.
    if (sel === 'site') clearUserRpc();
    else if (sel === 'pool') setUserRpc('pool');
    else setUserRpc(rpc, ws);
    setRequestLevel(level);
    window.location.reload();
  }

  const active = PROVIDERS.find((p) => p.id === sel)!;

  // The visible trigger lives in the footer (FooterStrip renders an RPC chip
  // that dispatches 'fp:open-rpc-settings'); this component only hosts the modal.
  if (!open || typeof document === 'undefined') return null;

  return (
    <>
      {createPortal(
        <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/75 px-4 py-8 overflow-y-auto" onClick={() => setOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl border border-orange/20 bg-[#0d0d10] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 text-lg font-bold tracking-wide text-bone">Choose your RPC</div>
            <p className="mb-4 text-[12px] leading-relaxed text-bone/55">
              Your endpoint powers reads and transactions. The free pool works out of the box;
              your own RPC is faster and more reliable, and overrides the host default.
            </p>

            {/* Request level: how much optional data the app loads/polls */}
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-bone/55">Data &amp; requests</div>
            <div className="mb-5 grid grid-cols-2 gap-2">
              {LEVELS.map((lv) => (
                <button
                  key={lv.id}
                  onClick={() => setLevel(lv.id)}
                  title={lv.blurb}
                  className={`rounded-lg border px-2 py-2 text-left transition ${level === lv.id ? 'border-orange bg-orange/10' : 'border-bone/12 hover:border-bone/30'}`}
                >
                  <div className="text-[12px] font-semibold text-bone">{lv.label}</div>
                  <div className="mt-0.5 text-[9px] leading-tight text-bone/45">{lv.blurb}</div>
                </button>
              ))}
            </div>

            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-bone/55">RPC provider</div>
            <div className="space-y-2">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pick(p.id)}
                  className={`w-full rounded-xl border p-3 text-left transition ${sel === p.id ? 'border-orange bg-orange/10' : 'border-bone/12 hover:border-bone/30'}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`inline-block h-3.5 w-3.5 rounded-full border ${sel === p.id ? 'border-orange bg-orange' : 'border-bone/40'}`} />
                    <span className="text-[13px] font-semibold text-bone">{p.name}</span>
                    {p.recommended && <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-300">Recommended</span>}
                    {p.badge && <span className="rounded bg-bone/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-bone/60">{p.badge}</span>}
                  </div>
                  <div className="mt-1 pl-5 text-[11px] leading-snug text-bone/50">{p.blurb}</div>
                </button>
              ))}
            </div>

            {active.needsUrl && (
              <div className="mt-4 rounded-xl border border-bone/10 bg-black/30 p-3">
                {active.signup && (
                  <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                    <a href={active.signup} target="_blank" rel="noreferrer" className="font-semibold text-orange hover:underline">{active.signupLabel} →</a>
                    {active.upgrade && <a href={active.upgrade} target="_blank" rel="noreferrer" className="text-bone/45 hover:text-bone/70">Upgrade plans →</a>}
                  </div>
                )}
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.1em] text-bone/55">RPC URL (HTTP)</label>
                <input
                  value={rpc}
                  onChange={(e) => { setRpc(e.target.value); setTest({ kind: 'idle' }); }}
                  placeholder={active.placeholder}
                  className="mb-3 w-full rounded-lg border border-bone/15 bg-black/40 px-3 py-2 text-[13px] text-bone outline-none focus:border-orange/50"
                />
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.1em] text-bone/55">WebSocket URL (optional)</label>
                <input
                  value={ws}
                  onChange={(e) => setWs(e.target.value)}
                  placeholder="wss://… (leave blank to auto-derive / poll)"
                  className="mb-3 w-full rounded-lg border border-bone/15 bg-black/40 px-3 py-2 text-[13px] text-bone outline-none focus:border-orange/50"
                />
                <div className="flex items-center gap-3">
                  <button onClick={runTest} className="rounded-lg border border-orange/30 px-3 py-1.5 text-[12px] font-semibold text-orange hover:bg-orange/10">
                    {test.kind === 'testing' ? 'Testing…' : 'Test connection'}
                  </button>
                  {test.kind === 'ok' && <span className="text-[12px] text-emerald-400">{test.msg}</span>}
                  {test.kind === 'err' && <span className="text-[12px] text-red-400">{test.msg}</span>}
                </div>
              </div>
            )}

            {/* L1 usage meter — counts every RPC call we make, weighted by the
                Helius credit table. An estimate (no provider usage API exists). */}
            <div className="mt-5 rounded-xl border border-bone/10 bg-black/30 p-3">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-bone/55">RPC usage today (est.)</div>
                <button onClick={() => resetRpcMeter()} className="text-[10px] text-bone/40 hover:text-bone/80">reset</button>
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="font-mono text-[18px] text-orange tabular-nums">{meter.credits.toLocaleString()}</span>
                <span className="text-[10px] text-bone/50">est. credits</span>
                <span className="ml-2 font-mono text-[12px] text-bone/70 tabular-nums">{meter.calls.toLocaleString()}</span>
                <span className="text-[10px] text-bone/50">calls</span>
              </div>
              {Object.keys(meter.byMethod).length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {Object.entries(meter.byMethod)
                    .sort((a, b) => b[1].credits - a[1].credits)
                    .slice(0, 4)
                    .map(([m, v]) => (
                      <div key={m} className="flex items-center justify-between text-[10px] font-mono">
                        <span className="truncate text-bone/55">{m}</span>
                        <span className="tabular-nums text-bone/45">{v.calls}× · {v.credits} cr</span>
                      </div>
                    ))}
                </div>
              )}
              <p className="mt-2 text-[9px] leading-relaxed text-bone/35">
                Estimated from Helius credit weights (getProgramAccounts = 10, most = 1). Helius has no usage API — check its dashboard for exact billing. On the free pool these are request counts, not credits.
              </p>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-[12px] text-bone/60 hover:text-bone">Cancel</button>
              <button onClick={save} className="rounded-lg bg-orange px-4 py-1.5 text-[12px] font-bold text-black hover:bg-orangeHi">Save &amp; reload</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
