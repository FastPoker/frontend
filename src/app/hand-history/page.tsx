'use client';

import { useEffect, useMemo, useState } from 'react';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { BRAND } from '@/lib/branding';
import type { JackpotReceipt } from '@/lib/jpv1';
import { getKindColor, getKindLabel } from '@/lib/jackpot-format';

/**
 * Per-table hand-history list.
 *
 * Discovery is per-table (`/api/hand-history?table=X&limit=N`): the page asks
 * for a table PDA and renders the most recent N hands for that table. Hands
 * where a JPV1 jackpot fired get a badge with the Lucky/Royal kind + color.
 *
 * STATIC-SAFE: the `/api/hand-history` route handler is excluded from the LIGHT
 * static export, so on a CDN host the fetch hits a missing route and returns a
 * 404 / non-JSON page. This page treats any non-OK status, non-JSON body, or
 * fetch failure as "the discovery API is unavailable" and shows a calm empty
 * state instead of crashing or hanging. When a node server (or indexer) is
 * present the same fetch returns `{ table, records, totalRecorded }`.
 */

interface ApiHandRecord {
  handNumber: number;
  timestamp: number;
  pot: number;
  rake: number;
  winners: number[];
  jackpot?: JackpotReceipt | null;
}

interface ApiResponse {
  table: string;
  records: ApiHandRecord[];
  totalRecorded: number;
}

// Distinguish "the API isn't here" (static build / missing route) from a real
// upstream error so we can show the right copy.
const API_UNAVAILABLE = '__api_unavailable__';

function formatTimeAgo(ts: number): string {
  if (!ts) return '—';
  const diffMs = Date.now() - ts * 1000;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function HandHistoryPage() {
  const [tableInput, setTableInput] = useState('');
  const [activeTable, setActiveTable] = useState('');
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [jackpotsOnly, setJackpotsOnly] = useState(false);

  useEffect(() => {
    if (!activeTable) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    (async () => {
      try {
        let r: Response;
        try {
          r = await fetch(
            `/api/hand-history?table=${encodeURIComponent(activeTable)}&limit=50`,
            { cache: 'no-store' },
          );
        } catch {
          // Network-level failure (no server). Treat as API absent.
          throw new Error(API_UNAVAILABLE);
        }

        // Static export serves a 404 (often HTML) for the missing route. Any
        // non-OK status that isn't a real API error JSON => API unavailable.
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          if (body?.error) throw new Error(body.error);
          throw new Error(API_UNAVAILABLE);
        }

        // Guard against a 200 that is not the JSON we expect (e.g. an HTML
        // fallback page from a static host returning 200 for unknown paths).
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
          throw new Error(API_UNAVAILABLE);
        }

        const body = await r.json().catch(() => null);
        if (!body || !Array.isArray(body.records)) {
          throw new Error(API_UNAVAILABLE);
        }
        if (!cancelled) setData(body as ApiResponse);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'fetch failed';
        if (!cancelled) setErr(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTable]);

  const records = useMemo(() => data?.records ?? [], [data]);
  const filtered = useMemo(
    () => (jackpotsOnly ? records.filter(r => r.jackpot) : records),
    [records, jackpotsOnly],
  );

  const apiUnavailable = err === API_UNAVAILABLE;
  const realError = err && !apiUnavailable ? err : null;

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    setActiveTable(tableInput.trim());
  };

  return (
    <main className="max-w-[1100px] mx-auto px-5 md:px-8 py-10 pb-16">
      <SectionHeader
        eyebrow="PUBLIC HAND FEED"
        title="Hand History"
        subtitle={`Look up any ${BRAND.name} table by its PDA and replay every hand. Hands flagged with the jackpot badge fired a Lucky or Royal Jackpot.`}
      />

      <form onSubmit={submit} className="glass-room px-4 py-3 mb-4 flex items-center gap-3 flex-wrap">
        <span className="font-mono text-[9px] text-boneDim/55 tracking-[0.2em]">
          TABLE&nbsp;PDA
        </span>
        <input
          value={tableInput}
          onChange={e => setTableInput(e.target.value)}
          placeholder="Hc4kP2mN…9pL2"
          spellCheck={false}
          className="flex-1 min-w-[220px] bg-ink/50 hairline rounded-sm px-2.5 py-1.5 font-mono text-[11px] text-bone/90 tabular-nums focus:outline-none focus:border-orange/40"
        />
        <button
          type="submit"
          disabled={loading || !tableInput.trim()}
          className="px-3 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] btn-orange disabled:opacity-50"
        >
          {loading ? 'LOADING…' : 'LOAD'}
        </button>
        <label className="flex items-center gap-2 cursor-pointer select-none ml-auto">
          <input
            type="checkbox"
            checked={jackpotsOnly}
            onChange={e => setJackpotsOnly(e.target.checked)}
            className="accent-orange"
          />
          <span className="font-mono text-[10px] tracking-[0.18em] text-boneDim/70">
            JACKPOT HANDS ONLY
          </span>
        </label>
      </form>

      {realError && (
        <div className="glass-room px-4 py-3 mb-4 border-rose-500/40">
          <span className="font-mono text-[11px] text-rose-300">{realError}</span>
        </div>
      )}

      {/* Static / backend-free build: the discovery route was stripped, so the
          fetch came back as not-found. Explain why, don't error out. */}
      {activeTable && apiUnavailable && (
        <div className="glass-room px-6 py-8 text-center">
          <div className="font-display text-bone text-xl tracking-wide leading-none">
            Hand history is unavailable in this build.
          </div>
          <p className="font-mono text-[10px] text-boneDim/65 leading-relaxed max-w-md mx-auto mt-2 tracking-wider">
            Per-table hand discovery needs the node server (or a connected indexer).
            This static deployment ships without it, so the public hand feed is offline here.
          </p>
        </div>
      )}

      {!activeTable && !err && (
        <div className="glass-room px-6 py-8 text-center">
          <div className="font-display text-bone text-xl tracking-wide leading-none">
            Enter a table PDA to load the hand feed.
          </div>
          <p className="font-mono text-[10px] text-boneDim/65 leading-relaxed max-w-md mx-auto mt-2 tracking-wider">
            Discovery is per-table. A protocol-wide feed lands with the persistent indexer.
          </p>
        </div>
      )}

      {activeTable && !err && data && (
        <div className="glass-room overflow-hidden" style={{ padding: 0 }}>
          <div className="px-5 py-3 hairline-b flex items-center justify-between flex-wrap gap-2">
            <div className="font-mono text-[10px] tracking-[0.18em] text-boneDim/70">
              <span className="text-bone">{filtered.length}</span> / {records.length} hands
              {jackpotsOnly && <span className="text-orange ml-2">· JACKPOT FILTER</span>}
            </div>
            <div className="font-mono text-[9px] text-boneDim/45 tracking-wider truncate max-w-[480px]">
              TABLE {data.table}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="px-5 py-8 text-xs text-bone/50 font-mono">
              {jackpotsOnly
                ? 'No jackpot hands in the most recent 50. Toggle off to see all hands.'
                : 'No hands recorded for this table yet.'}
            </div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {filtered.map(h => (
                <HandRow key={h.handNumber} record={h} />
              ))}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function HandRow({ record }: { record: ApiHandRecord }) {
  const jp = record.jackpot;
  const kindColor = !jp ? null : getKindColor(jp.miniHit, jp.grandHit);
  const kindLabel = !jp ? null : getKindLabel(jp.miniHit, jp.grandHit);

  return (
    <div className="px-5 py-3 flex items-center gap-3">
      {jp && (
        <span
          className="font-mono text-[8.5px] tracking-[0.22em] px-1.5 py-0.5 rounded-sm shrink-0 inline-flex items-center gap-1"
          style={{
            color: kindColor!,
            border: `1px solid ${kindColor}55`,
            background: `${kindColor}10`,
          }}
          title={`Jackpot ${kindLabel}`}
        >
          <span aria-hidden>{'💰'}</span>
          {kindLabel}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="font-mono text-[12px] text-bone/90">
          Hand #<span className="tabular-nums">{record.handNumber}</span>
          {record.winners.length > 0 && (
            <>
              <span className="text-boneDim/45 mx-2">·</span>
              <span className="text-boneDim/65">
                Winner{record.winners.length === 1 ? '' : 's'}:{' '}
                {record.winners.map(s => `S${s}`).join(', ')}
              </span>
            </>
          )}
        </div>
        <div className="font-mono text-[9px] text-boneDim/45 mt-0.5 tracking-wider">
          {formatTimeAgo(record.timestamp)} · pot {(record.pot / 1e9).toFixed(4)} SOL · rake {(record.rake / 1e9).toFixed(4)} SOL
        </div>
      </div>
    </div>
  );
}
