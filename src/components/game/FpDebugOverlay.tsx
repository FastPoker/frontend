'use client';
/**
 * On-screen FP-DEBUG log viewer. Renders ONLY when debug is enabled
 * (?debug=1 on the URL, or localStorage fp.debug=1). It mirrors the existing
 * [FP-DEBUG] console stream into a scrollable, copyable panel so game-state
 * bugs (stale board, missed river, showdown timing, positions) can be read on
 * mobile / inside a wallet in-app browser where there is no console.
 *
 * Standalone: does not import or touch any wallet / session / action code.
 */
import { useEffect, useRef, useState } from 'react';
import {
  getFpDebugLines, subscribeFpDebug, clearFpDebug, isFpDebugEnabled,
  setFpDebugEnabled, installFpDebugConsoleMirror,
} from '@/lib/fp-debug';

function hhmmss(t: number): string {
  try { return new Date(t).toISOString().slice(11, 23); } catch { return ''; }
}

export default function FpDebugOverlay() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(true);
  const [, force] = useState(0);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedBottomRef = useRef(true);

  // Install the console mirror + read the enable flag on mount.
  useEffect(() => {
    installFpDebugConsoleMirror();
    setEnabled(isFpDebugEnabled());
  }, []);

  useEffect(() => {
    if (!enabled) return;
    return subscribeFpDebug(() => force((n) => n + 1));
  }, [enabled]);

  // Autoscroll to bottom unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  if (!enabled) return null;

  const lines = getFpDebugLines();

  const copyAll = async () => {
    const text = lines.map((l) => `${hhmmss(l.t)} ${l.msg}${l.n > 1 ? ` x${l.n}` : ''}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard blocked in some webviews */ }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div
      className="fixed left-1 bottom-1 z-[9999] font-mono text-[9px] leading-tight"
      style={{ maxWidth: 'min(96vw, 460px)' }}
    >
      <div className="rounded-md border border-emerald-500/40 bg-black/85 backdrop-blur-sm shadow-lg overflow-hidden">
        {/* Header bar */}
        <div className="flex items-center gap-1.5 px-2 py-1 border-b border-emerald-500/25 bg-emerald-500/10">
          <span className="text-emerald-300 font-bold tracking-[0.12em]">FP-DEBUG</span>
          <span className="text-emerald-200/50">{lines.length}</span>
          <span className="flex-1" />
          <button
            onClick={copyAll}
            className="px-1.5 py-0.5 rounded-sm border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/20 active:scale-95 transition"
          >
            {copied ? 'COPIED' : 'COPY'}
          </button>
          <button
            onClick={() => clearFpDebug()}
            className="px-1.5 py-0.5 rounded-sm border border-white/20 text-white/70 hover:bg-white/10 active:scale-95 transition"
          >
            CLR
          </button>
          <button
            onClick={() => setOpen((o) => !o)}
            className="px-1.5 py-0.5 rounded-sm border border-white/20 text-white/70 hover:bg-white/10 active:scale-95 transition"
          >
            {open ? '–' : '+'}
          </button>
          <button
            onClick={() => { setFpDebugEnabled(false); setEnabled(false); }}
            className="px-1.5 py-0.5 rounded-sm border border-rose-500/40 text-rose-300 hover:bg-rose-500/20 active:scale-95 transition"
            title="Hide (re-enable with ?debug=1)"
          >
            ✕
          </button>
        </div>
        {open && (
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="overflow-y-auto overflow-x-hidden px-2 py-1.5 space-y-0.5"
            style={{ maxHeight: '34vh' }}
          >
            {lines.length === 0 ? (
              <div className="text-white/40">waiting for [FP-DEBUG] events…</div>
            ) : (
              lines.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap break-words text-emerald-100/80">
                  <span className="text-emerald-300/40">{hhmmss(l.t)}</span>{' '}
                  {l.msg.replace(/^\[FP-DEBUG[^\]]*\]\s*/, '')}
                  {l.n > 1 && <span className="text-amber-300/70"> ×{l.n}</span>}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
