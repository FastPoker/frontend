'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ChatPanel } from './ChatPanel';

const STORAGE_KEY = 'fp.tableChat.open';

/**
 * Table chat widget for /game/<id> routes.
 * - Desktop (md+): bottom-right floating button + panel.
 * - Mobile (portrait + landscape): triggered from the table info bar; renders
 *   a full-screen overlay on top of everything.
 *
 * Viewport split is done via Tailwind .md:* breakpoint classes so there is no
 * SSR/hydration race — previously useSyncExternalStore would render the
 * desktop float on first paint and only switch on the client, which leaked
 * the bottom-right widget into mobile portrait briefly (and in some dev
 * builds, persistently).
 */
export function TableChatWidget() {
  const pathname = usePathname() || '';
  const [open, setOpen] = useState(false);
  const [panelH, setPanelH] = useState(320);

  // Recompute overlay height on viewport resize.
  useEffect(() => {
    const compute = () => setPanelH(Math.max(180, window.innerHeight - 60));
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, []);

  useEffect(() => {
    // Restore persisted state on desktop only; mobile always starts closed.
    if (window.innerWidth >= 768) {
      try { setOpen(window.localStorage.getItem(STORAGE_KEY) === '1'); } catch { /* ignore */ }
    } else {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  }, []);

  const toggle = useCallback(() => {
    setOpen((v) => {
      const nv = !v;
      try { window.localStorage.setItem(STORAGE_KEY, nv ? '1' : '0'); } catch { /* ignore */ }
      return nv;
    });
  }, []);

  // Toolbar button (in PokerTable cockpit) dispatches `table-chat-toggle` to open/close.
  useEffect(() => {
    window.addEventListener('table-chat-toggle', toggle);
    return () => window.removeEventListener('table-chat-toggle', toggle);
  }, [toggle]);

  // Resolve channel — accept /game/<id> and /table-preview (dev preview).
  let tablePda: string;
  if (pathname === '/table-preview') {
    tablePda = 'PreviewTable1111111111111111111111111111111';
  } else {
    const m = pathname.match(/^\/game\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\/|$)/);
    if (!m) return null;
    tablePda = m[1];
  }

  return (
    <>
      {/* Mobile overlay — only mounts when open, hidden on desktop via CSS. */}
      {open && (
        <div
          id="table-chat-mobile-overlay"
          // Compact = portrait mobile (<md) OR a landscape phone (short height).
          // md:hidden covers portrait; the landscape override re-shows it on
          // landscape phones, which are usually >=768px wide and would otherwise
          // fall through to the desktop floating widget.
          className="md:hidden [@media(orientation:landscape)_and_(max-height:500px)]:!flex fixed z-[300] flex flex-col bg-ink/98 backdrop-blur-md"
          style={{ top: 0, left: 0, width: '100vw', height: '100dvh', animation: 'fade-in 120ms ease-out' }}
        >
          <div
            id="table-chat-overlay-header"
            className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-orange/15"
          >
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-orange/70" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M2.5 4.5h11v6h-4l-2.5 2v-2h-4.5z" />
              </svg>
              <span className="font-mono text-[10px] tracking-[0.3em] text-orange/80">TABLE CHAT</span>
            </div>
            <button
              onClick={toggle}
              aria-label="Close chat"
              className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-orange/10 text-bone/55 hover:text-bone transition"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div id="table-chat-overlay-body" className="flex-1 overflow-hidden">
            <ChatPanel
              channel={`table:${tablePda}`}
              title="TABLE CHAT"
              heightPx={panelH}
              showAvatars={false}
            />
          </div>
        </div>
      )}

      {/* Desktop floating widget — always mounted, hidden on mobile via CSS.
          Also hidden on landscape phones (short height): those are >=768px wide
          so md:block would otherwise leak this bottom-right widget into a phone
          held sideways — that landscape chat uses the full-screen overlay above. */}
      <div
        id="table-chat-float-shell"
        className="hidden md:block [@media(orientation:landscape)_and_(max-height:500px)]:!hidden fixed z-40 bottom-12 right-3 md:right-5 select-none"
        style={{ pointerEvents: 'none' }}
      >
        <div className="flex flex-col items-end gap-2" style={{ pointerEvents: 'auto' }}>
          {open && (
            <div
              id="table-chat-float-panel"
              className="w-[300px] md:w-[340px] shadow-[0_18px_60px_rgba(0,0,0,0.55)] rounded-sm overflow-hidden"
              style={{ animation: 'fade-in 120ms ease-out' }}
            >
              <ChatPanel
                channel={`table:${tablePda}`}
                title="TABLE CHAT"
                heightPx={360}
                showAvatars={false}
              />
            </div>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-label={open ? 'Collapse table chat' : 'Open table chat'}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-sm border border-orange/40 bg-ink/90 backdrop-blur-md hover:border-orange hover:bg-orange/15 font-mono text-[10px] tracking-[0.22em] text-orange/90 hover:text-bone transition shadow-[0_8px_24px_rgba(0,0,0,0.6)]"
            title={open ? 'Collapse table chat' : 'Open table chat (seated players only)'}
          >
            <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M2.5 4.5h11v6h-4l-2.5 2v-2h-4.5z" />
            </svg>
            <span>{open ? 'CLOSE CHAT' : 'TABLE CHAT'}</span>
          </button>
        </div>
      </div>
    </>
  );
}
