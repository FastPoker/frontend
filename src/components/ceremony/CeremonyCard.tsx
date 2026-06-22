'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export type CeremonyBand = 'bronze' | 'silver' | 'gold' | 'ruby' | 'diamond';

export interface CeremonyCardProps {
  open: boolean;
  /** Ceremony band / tier */
  band: CeremonyBand;
  /** e.g., "DEALER OATH" / "FIRST HAND" / "MILESTONE" */
  eventLabel: string;
  /** Line of copy under the title */
  flavor?: string;
  /** Token line (e.g., "+120 $FP · Skin unlocked") */
  rewardLabel?: string;
  /** Primary CTA */
  primaryLabel?: string;
  onPrimary?: () => void;
  onClose?: () => void;
}

const BAND_CLASS: Record<CeremonyBand, { bg: string; border: string; accent: string; glow: string; title: string }> = {
  bronze: {
    bg: 'bg-[radial-gradient(circle_at_50%_0%,rgba(184,115,51,0.18),transparent_70%)]',
    border: 'border-[#b87333]/40',
    accent: 'text-[#d8954d]',
    glow: 'shadow-[0_40px_120px_rgba(184,115,51,0.25)]',
    title: 'Bronze Ceremony',
  },
  silver: {
    bg: 'bg-[radial-gradient(circle_at_50%_0%,rgba(245,241,230,0.14),transparent_70%)]',
    border: 'border-bone/30',
    accent: 'text-bone',
    glow: 'shadow-[0_40px_120px_rgba(245,241,230,0.18)]',
    title: 'Silver Ceremony',
  },
  gold: {
    bg: 'bg-[radial-gradient(circle_at_50%_0%,rgba(244,165,42,0.2),transparent_70%)]',
    border: 'border-amber/45',
    accent: 'text-amber',
    glow: 'shadow-[0_40px_120px_rgba(244,165,42,0.28)]',
    title: 'Gold Ceremony',
  },
  ruby: {
    bg: 'bg-[radial-gradient(circle_at_50%_0%,rgba(244,63,94,0.2),transparent_70%)]',
    border: 'border-rose-400/45',
    accent: 'text-rose-300',
    glow: 'shadow-[0_40px_120px_rgba(244,63,94,0.28)]',
    title: 'Ruby Ceremony',
  },
  diamond: {
    bg: 'bg-[radial-gradient(circle_at_50%_0%,rgba(242,106,31,0.22),transparent_70%)]',
    border: 'border-orange/55',
    accent: 'text-orange',
    glow: 'shadow-[0_40px_120px_rgba(242,106,31,0.35)]',
    title: 'Diamond Ceremony',
  },
};

export function CeremonyCard({
  open,
  band,
  eventLabel,
  flavor,
  rewardLabel,
  primaryLabel = 'CONTINUE',
  onPrimary,
  onClose,
}: CeremonyCardProps) {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);
    else {
      const id = setTimeout(() => setMounted(false), 200);
      return () => clearTimeout(id);
    }
  }, [open]);

  if (!mounted) return null;
  const cls = BAND_CLASS[band];

  return (
    <div
      className={cn(
        'fixed inset-0 z-[90] flex items-center justify-center bg-ink/80 backdrop-blur-md transition-opacity duration-200',
        open ? 'opacity-100' : 'opacity-0',
      )}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'glass-pop rounded-lg border max-w-[480px] w-[92vw] px-8 py-8 text-center fade-in',
          cls.bg,
          cls.border,
          cls.glow,
        )}
      >
        <div className="font-mono text-[9px] tracking-[0.38em] text-boneDim/55">
          {cls.title.toUpperCase()}
        </div>
        <div className={cn('font-display text-3xl tracking-[0.2em] mt-2', cls.accent)}>
          {eventLabel}
        </div>
        {flavor && (
          <div className="font-mono text-[11px] tracking-wide text-boneDim/80 mt-3 max-w-[360px] mx-auto">
            {flavor}
          </div>
        )}
        {rewardLabel && (
          <div className="mt-5 inline-flex items-center rounded-sm border border-bone/15 bg-ink/45 px-3 py-2 font-mono text-[11px] tabular-nums text-bone tracking-wide">
            {rewardLabel}
          </div>
        )}
        <div className="mt-6">
          <button
            type="button"
            onClick={onPrimary ?? onClose}
            className="btn-orange px-6 py-2.5 rounded-sm font-mono text-[11px] tracking-[0.22em] font-bold"
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
