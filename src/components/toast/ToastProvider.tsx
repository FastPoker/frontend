'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  buildDebugBlock,
  copyToClipboard,
  normalizeError,
  type ToastDebugContext,
} from '@/lib/toast-debug';

export type ToastKind = 'error' | 'success' | 'info' | 'warning';

interface ToastDebugPayload {
  /** Raw error object the caller already has. */
  error: unknown;
  /** Optional context (action, wallet, rpc, ...). */
  ctx?: ToastDebugContext;
}

interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  title?: string;
  /** When set, the toast shows a "Show debug" toggle and a copy button. */
  debug?: ToastDebugPayload;
  /** ms — 0 means sticky until user dismisses. */
  durationMs: number;
  createdAt: number;
}

interface ShowToastOptions {
  title?: string;
  debug?: ToastDebugPayload;
  /** ms — defaults: 5000 info/success, 0 (sticky) for error with debug. */
  durationMs?: number;
}

interface ShowErrorOptions {
  /** User-friendly headline. Falls back to a sensible default. */
  title?: string;
  /** User-friendly one-liner. Falls back to the normalized error.message. */
  message?: string;
  /** Debug context attached for the Copy button. */
  ctx?: ToastDebugContext;
  /** ms — 0 (sticky) by default; pass a value to auto-dismiss. */
  durationMs?: number;
}

interface ToastApi {
  showToast: (message: string, kind?: ToastKind, opts?: ShowToastOptions) => void;
  showError: (error: unknown, opts?: ShowErrorOptions) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let counter = 0;
function nextId(): string {
  counter = (counter + 1) | 0;
  return `t${Date.now().toString(36)}-${counter.toString(36)}`;
}

const DEFAULTS: Record<ToastKind, number> = {
  info: 5000,
  success: 5000,
  warning: 7000,
  error: 0,
};

function kindStyles(kind: ToastKind): { wrap: string; icon: string; glyph: string } {
  switch (kind) {
    case 'error':
      return {
        wrap: 'bg-red-500/10 border-red-500/40 text-red-200',
        icon: 'text-red-300',
        glyph: 'x',
      };
    case 'success':
      return {
        wrap: 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200',
        icon: 'text-emerald-300',
        glyph: '+',
      };
    case 'warning':
      return {
        wrap: 'bg-amber-500/10 border-amber-500/40 text-amber-200',
        icon: 'text-amber-300',
        glyph: '!',
      };
    default:
      return {
        wrap: 'bg-white/[0.04] border-white/15 text-bone',
        icon: 'text-bone/70',
        glyph: 'i',
      };
  }
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timeouts.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timeouts.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (t: Toast) => {
      setToasts((prev) => {
        // Cap stack at 4 — drop oldest non-error first so error toasts stay sticky.
        const limit = 4;
        let next = [...prev, t];
        while (next.length > limit) {
          const dropIdx = next.findIndex((x) => x.kind !== 'error');
          next.splice(dropIdx === -1 ? 0 : dropIdx, 1);
        }
        return next;
      });
      if (t.durationMs > 0) {
        const handle = setTimeout(() => dismissToast(t.id), t.durationMs);
        timeouts.current.set(t.id, handle);
      }
    },
    [dismissToast],
  );

  const showToast = useCallback<ToastApi['showToast']>(
    (message, kind = 'info', opts) => {
      const id = nextId();
      const defaultMs = opts?.debug ? 0 : DEFAULTS[kind];
      push({
        id,
        kind,
        message,
        title: opts?.title,
        debug: opts?.debug,
        durationMs: opts?.durationMs ?? defaultMs,
        createdAt: Date.now(),
      });
    },
    [push],
  );

  const showError = useCallback<ToastApi['showError']>(
    (error, opts) => {
      const normalized = normalizeError(error);
      const fallbackMessage =
        opts?.message ??
        // Strip very long messages — the full thing is in the debug block.
        (normalized.message.length > 220
          ? normalized.message.slice(0, 217) + '...'
          : normalized.message);
      const id = nextId();
      push({
        id,
        kind: 'error',
        title: opts?.title ?? 'Something went wrong',
        message: fallbackMessage,
        debug: { error, ctx: opts?.ctx },
        durationMs: opts?.durationMs ?? 0,
        createdAt: Date.now(),
      });
    },
    [push],
  );

  // Drain any timeouts on unmount.
  useEffect(() => {
    const handles = timeouts.current;
    return () => {
      for (const h of handles.values()) clearTimeout(h);
      handles.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ showToast, showError, dismissToast }),
    [showToast, showError, dismissToast],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Render no-op stubs server-side / outside provider rather than throwing.
    return {
      showToast: () => {},
      showError: () => {},
      dismissToast: () => {},
    };
  }
  return ctx;
}

function ToastViewport({
  toasts,
  dismiss,
}: {
  toasts: Toast[];
  dismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  // Matches the sonner Toaster placement (bottom-left) — one app, one spot.
  return (
    <div className="pointer-events-none fixed bottom-3 left-3 z-[1100] flex flex-col items-start gap-2 sm:bottom-6 sm:left-6 max-w-[calc(100vw-1.5rem)]">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [showDebug, setShowDebug] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'fail'>('idle');
  const styles = kindStyles(toast.kind);

  const debugText = useMemo(() => {
    if (!toast.debug) return '';
    return buildDebugBlock(toast.debug.error, toast.debug.ctx);
  }, [toast.debug]);

  const handleCopy = useCallback(async () => {
    if (!debugText) return;
    const ok = await copyToClipboard(debugText);
    setCopyState(ok ? 'copied' : 'fail');
    setTimeout(() => setCopyState('idle'), 2200);
  }, [debugText]);

  return (
    <div
      className={`pointer-events-auto w-full max-w-md rounded-md border ${styles.wrap} px-3 py-2.5 sm:px-4 sm:py-3 shadow-lg backdrop-blur-md`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 shrink-0 font-mono text-[11px] uppercase ${styles.icon}`}>
          [{styles.glyph}]
        </span>
        <div className="min-w-0 flex-1">
          {toast.title ? (
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-70 mb-0.5">
              {toast.title}
            </div>
          ) : null}
          <div className="text-sm leading-snug break-words">{toast.message}</div>
          {toast.debug ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-mono">
              <button
                type="button"
                onClick={() => setShowDebug((v) => !v)}
                className="border border-current/30 px-2 py-0.5 uppercase tracking-[0.14em] opacity-80 hover:opacity-100"
              >
                {showDebug ? 'Hide debug' : 'Show debug'}
              </button>
              <button
                type="button"
                onClick={handleCopy}
                className="border border-current/30 px-2 py-0.5 uppercase tracking-[0.14em] opacity-80 hover:opacity-100"
              >
                {copyState === 'copied'
                  ? 'Copied'
                  : copyState === 'fail'
                  ? 'Copy failed'
                  : 'Copy debug'}
              </button>
            </div>
          ) : null}
          {showDebug && debugText ? (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all border border-current/20 bg-black/40 p-2 text-[10px] leading-snug">
              {debugText}
            </pre>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 opacity-50 hover:opacity-100 text-lg leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
