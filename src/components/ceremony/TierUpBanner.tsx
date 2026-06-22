'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export interface TierUpBannerProps {
  /** Show banner */
  open: boolean;
  /** Tier label reached (e.g., "BRONZE II", "RUBY I") */
  tierLabel: string;
  /** Short hook (e.g., "You unlocked the Velvet card skin") */
  unlockLabel?: string;
  /** Tier tone — drives glow + accent */
  tone?: 'bronze' | 'silver' | 'gold' | 'ruby' | 'diamond';
  /** Auto-dismiss after N ms (default 6000). Pass 0 to stay until closed. */
  autoDismissMs?: number;
  onClose?: () => void;
}

const TONE_CLASS: Record<NonNullable<TierUpBannerProps['tone']>, { ring: string; glow: string; accent: string }> = {
  bronze: {
    ring: 'ring-[#b87333]/55',
    glow: 'shadow-[0_20px_55px_rgba(184,115,51,0.35)]',
    accent: 'text-[#d8954d]',
  },
  silver: {
    ring: 'ring-bone/45',
    glow: 'shadow-[0_20px_55px_rgba(245,241,230,0.22)]',
    accent: 'text-bone',
  },
  gold: {
    ring: 'ring-amber/60',
    glow: 'shadow-[0_20px_55px_rgba(244,165,42,0.35)]',
    accent: 'text-amber',
  },
  ruby: {
    ring: 'ring-rose-400/55',
    glow: 'shadow-[0_20px_55px_rgba(244,63,94,0.3)]',
    accent: 'text-rose-300',
  },
  diamond: {
    ring: 'ring-orange/60',
    glow: 'shadow-[0_20px_55px_rgba(242,106,31,0.4)]',
    accent: 'text-orange',
  },
};

export function TierUpBanner({
  open,
  tierLabel,
  unlockLabel,
  tone = 'gold',
  autoDismissMs = 6000,
  onClose,
}: TierUpBannerProps) {
  const [visible, setVisible] = useState(open);

  useEffect(() => setVisible(open), [open]);

  useEffect(() => {
    if (!visible || !autoDismissMs) return;
    const id = setTimeout(() => {
      setVisible(false);
      onClose?.();
    }, autoDismissMs);
    return () => clearTimeout(id);
  }, [visible, autoDismissMs, onClose]);

  if (!visible) return null;

  const toneCls = TONE_CLASS[tone];

  return (
    <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[100] pointer-events-none fade-in">
      <div
        className={cn(
          'glass-pop hairline rounded-md px-6 py-4 ring-1 pointer-events-auto flex items-center gap-4',
          toneCls.ring,
          toneCls.glow,
        )}
      >
        <div className="w-10 h-10 rounded-full flex items-center justify-center bg-ink/60 hairline">
          <svg viewBox="0 0 24 24" className={cn('w-5 h-5', toneCls.accent)} fill="currentColor">
            <path d="M12 2 l3 6 7 1 -5 5 1 7 -6 -3 -6 3 1 -7 -5 -5 7 -1z" />
          </svg>
        </div>
        <div>
          <div className="font-mono text-[9px] tracking-[0.32em] text-boneDim/60">
            TIER UP
          </div>
          <div className={cn('font-display text-xl tracking-[0.18em]', toneCls.accent)}>
            {tierLabel}
          </div>
          {unlockLabel && (
            <div className="font-mono text-[10px] text-boneDim/75 mt-0.5">{unlockLabel}</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setVisible(false);
            onClose?.();
          }}
          className="ml-2 w-6 h-6 rounded-sm text-boneDim/55 hover:text-bone hover:bg-bone/10 transition-colors flex items-center justify-center"
          aria-label="Dismiss"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
