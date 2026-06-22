'use client';

import { cn } from '@/lib/utils';
import { useSngJackpotState, type SngJackpotSnapshot } from '@/hooks/useSngJackpotState';
import { RAW_YIELD_NAME } from '@/lib/jackpot-format';

type JackpotRailVariant = 'header' | 'strip' | 'table';

interface SngJackpotRailProps {
  variant?: JackpotRailVariant;
  /** Only used for `variant="header"`. Renders a single compact box for one tone. */
  tone?: 'mini' | 'grand';
  className?: string;
}

const LUCKY_RULE_TEXT = 'HU pays 25% | 6-max 60% | 9-max 100%, split by opted-in seats';
const ROYAL_RULE_TEXT = 'Royal weight = format x tier; Lucky opt-out still earns Royal';
const ROYAL_TOOLTIP = `Royal pays ${RAW_YIELD_NAME}. Claim All pays ${RAW_YIELD_NAME} and $FP together.`;

function units(raw: string | undefined, decimals: number): number {
  if (!raw) return 0;
  try {
    return Number(BigInt(raw)) / 10 ** decimals;
  } catch {
    return 0;
  }
}

function compact(value: number, digits = 2): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : digits)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : digits)}K`;
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: digits });
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function sinceText(currentRaw: string | undefined): string {
  const current = Number(currentRaw || 0);
  if (!Number.isFinite(current)) return 'hit history syncing';
  if (current === 1) return '1 hand since last hit';
  return `${current.toLocaleString()} hands since last hit`;
}

function JackpotMark({ tone, compact = false }: { tone: 'mini' | 'grand'; compact?: boolean }) {
  const icon = tone === 'mini' ? '/tokens/sol.svg' : '/brand/app-icon.png';
  return (
    <div
      className={cn(
        'shrink-0 rounded-md border flex items-center justify-center',
        compact ? 'w-8 h-8' : 'w-[54px] h-[54px]',
        tone === 'mini'
          ? 'border-gold/30 bg-gold/[0.06]'
          : 'border-amber/30 bg-amber/[0.06]',
      )}
    >
      <img
        src={icon}
        alt=""
        className={cn('select-none', compact ? 'w-5 h-5' : 'w-10 h-10 rounded-[6px]')}
        draggable={false}
      />
    </div>
  );
}

function MetricBlock({
  label,
  value,
  meta,
  rule,
  tone,
  title,
}: {
  label: string;
  value: string;
  meta: string;
  rule: string;
  tone: 'mini' | 'grand';
  title?: string;
}) {
  return (
    <div
      title={title}
      className={cn(
        'relative min-w-0 rounded-md border px-3 py-2.5 bg-ink/35 overflow-hidden',
        tone === 'mini' ? 'border-gold/25' : 'border-amber/25',
      )}
    >
      <div
        className={cn(
          'absolute inset-y-0 right-0 w-28 opacity-25',
          tone === 'mini'
            ? 'bg-[radial-gradient(circle_at_70%_50%,rgba(247,193,94,0.34),transparent_65%)]'
            : 'bg-[radial-gradient(circle_at_70%_50%,rgba(242,106,31,0.36),transparent_65%)]',
        )}
      />
      <div className="relative flex items-center gap-3 min-w-0">
        <JackpotMark tone={tone} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3 min-w-0">
            <span className={cn('font-display text-[15px] tracking-[0.18em] font-bold uppercase leading-none', tone === 'mini' ? 'text-gold' : 'text-amber')}>
              {label}
            </span>
            <span className="font-display text-bone text-[22px] leading-none tabular-nums truncate text-right">{value}</span>
          </div>
          <div className="mt-1.5 font-mono text-[9px] text-boneDim/65 tracking-[0.12em] truncate">{meta}</div>
          <div className="mt-1 font-mono text-[8px] text-boneDim/45 tracking-[0.08em] truncate">{rule}</div>
        </div>
      </div>
    </div>
  );
}

function values(state: SngJackpotSnapshot | null) {
  return {
    miniPool: `${compact(units(state?.miniPoolLamports, 9), 3)} SOL`,
    grandPool: `${compact(units(state?.grandUnrefinedPool, 6), 2)} $FP`,
    miniSince: sinceText(state?.handsSinceMiniHit),
    grandSince: sinceText(state?.handsSinceGrandHit),
    activeMini: Number(state?.activeMiniWeight || 0).toLocaleString(),
    activeGrand: Number(state?.activeGrandWeight || 0).toLocaleString(),
  };
}

export function SngJackpotRail({ variant = 'strip', tone = 'grand', className }: SngJackpotRailProps) {
  const { state, loading, initialized, error } = useSngJackpotState();
  const v = values(state);

  if (variant === 'header') {
    const isGrand = tone === 'grand';
    const value = isGrand ? v.grandPool : v.miniPool;
    const display = loading ? 'SYNC' : initialized ? value : 'INIT';
    const icon = isGrand ? '/brand/app-icon.png' : '/tokens/sol.svg';
    const label = isGrand ? 'ROYAL' : 'LUCKY';
    return (
      <div
        title={isGrand ? ROYAL_TOOLTIP : LUCKY_RULE_TEXT}
        className={cn(
          'hidden lg:flex items-center gap-2 h-[40px] rounded-md border bg-ink/60 backdrop-blur-md px-2 shrink-0',
          isGrand
            ? 'border-amber/25 shadow-[0_0_16px_rgba(242,106,31,0.06)]'
            : 'border-gold/25 shadow-[0_0_16px_rgba(247,193,94,0.06)]',
          className,
        )}
      >
        <img
          src={icon}
          alt=""
          className="w-6 h-6 rounded-[4px] shrink-0 select-none"
          draggable={false}
        />
        <div className="flex flex-col gap-0.5 min-w-0">
          <span
            className={cn(
              'font-mono text-[8px] tracking-[0.22em] font-bold leading-none',
              isGrand ? 'text-amber/85' : 'text-gold/85',
            )}
          >
            {label}
          </span>
          <span className="font-display text-bone text-[12px] leading-none tabular-nums whitespace-nowrap">
            {display}
          </span>
        </div>
      </div>
    );
  }

  const unavailable = !initialized && !loading;
  const title = variant === 'table' ? 'SNG JACKPOTS' : 'SNG JACKPOT REGISTRY';
  const wrapperClass = variant === 'table'
    ? 'grid grid-cols-1 md:grid-cols-[auto_1fr_1fr] gap-2 items-center px-3 py-2 rounded-md border border-gold/15 bg-ink/35'
    : 'glass-room px-3 md:px-4 py-3';

  return (
    <section className={cn(wrapperClass, className)} aria-label="SNG jackpot registry">
      <div className="min-w-[130px]">
        <div className="font-mono text-[9px] tracking-[0.28em] text-orange/80 font-bold">{title}</div>
        <div className="font-mono text-[9px] text-boneDim/65 tracking-[0.14em] mt-1">
          {loading ? 'SYNCING ON-CHAIN STATE' : unavailable ? 'WAITING FOR INIT' : error ? 'LAST READ FAILED' : `${v.activeMini} lucky seats | ${v.activeGrand} royal weight`}
        </div>
      </div>

      <div className={cn('grid grid-cols-1 sm:grid-cols-2 gap-2', variant === 'strip' && 'md:col-span-2')}>
        <MetricBlock
          label="LUCKY"
          value={initialized ? v.miniPool : 'Not live'}
          meta={initialized ? `${v.miniSince} | opted-in seats ${v.activeMini}` : 'Optional add-on, default on'}
          rule={LUCKY_RULE_TEXT}
          tone="mini"
        />
        <MetricBlock
          label="ROYAL"
          value={initialized ? v.grandPool : 'Not live'}
          meta={initialized ? `${v.grandSince} | weighted active seats ${v.activeGrand}` : 'Funded by SNG $FP emission'}
          rule={ROYAL_RULE_TEXT}
          tone="grand"
          title={ROYAL_TOOLTIP}
        />
      </div>
    </section>
  );
}
