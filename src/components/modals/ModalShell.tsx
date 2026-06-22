'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  width?: number;
  children: ReactNode;
  className?: string;
}

export function ModalShell({
  open,
  onClose,
  title,
  subtitle,
  width = 480,
  children,
  className,
}: ModalShellProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const node = bodyRef.current;
    if (!node) return;
    const focusable = node.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    focusable?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink/75 backdrop-blur-md"
      />

      <div
        ref={bodyRef}
        style={{ maxWidth: width }}
        className={cn(
          'relative w-full max-h-[80vh] overflow-y-auto glass-room hairline rounded-xl',
          'shadow-[0_24px_80px_rgba(0,0,0,0.55)]',
          'fade-in',
          className
        )}
      >
        <div className="hairline-b px-6 py-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="brand-word text-xl text-bone tracking-wide">{title}</h2>
            {subtitle && (
              <p className="mt-1 text-xs text-boneDim leading-relaxed">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 w-8 h-8 rounded-md hairline text-boneDim hover:text-bone hover:bg-orange/10 transition-colors flex items-center justify-center"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
