import type { ReactNode } from 'react';

/**
 * Canonical section header for every non-lobby surface.
 *
 * Pattern — orange-glass eyebrow pill with a bullet dot + eyebrow text +
 * middle-dot + all-caps title, a horizontal orange hairline extending
 * right, and a glass summary box below with the subtitle. Use this on
 * every page that opens sections (Earn, How-to-play, Auctions, Dealer,
 * Dashboard, Create Table, Profile sub-panels). The Lobby is intentionally
 * excluded — it's dense enough that section headers would get in the way.
 *
 * See fastpoker-design-system skill § 9 for the design rationale.
 */
export function SectionHeader({
  eyebrow,
  title,
  subtitle,
  right,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div id="section-header-shell" className="mb-4 min-w-0 max-w-full">
      <div className="flex items-center gap-3 flex-wrap min-w-0">
        <span
          id="section-header-pill"
          className="flex w-full justify-center md:inline-flex md:w-auto md:justify-start flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-1.5 rounded-t-md rounded-b-none relative z-[1] min-w-0 max-w-full"
          style={{
            background: 'linear-gradient(180deg, rgba(70, 31, 10, 0.8) 0%, rgba(52, 23, 8, 0.67) 100%)',
            border: '1px solid rgba(242, 105, 31, 0.38)',
            borderBottom: 'none',
            boxShadow: '0 -2px 12px rgba(242,106,31,0.10)',
          }}
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-orange shrink-0"
            style={{ boxShadow: '0 0 6px #F26A1F' }}
          />
          {eyebrow && (
            <span className="font-mono text-[10px] tracking-[0.22em] text-bone whitespace-nowrap">
              {eyebrow}
            </span>
          )}
          <span className="font-mono text-[9px] text-boneDim/45 tracking-[0.2em] whitespace-nowrap shrink-0">&middot;</span>
          <h2 className="font-display text-bone text-base md:text-lg leading-none tracking-[0.12em]">
            {title.toUpperCase()}
          </h2>
        </span>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {subtitle && (
        <div
          className="rounded-b-md px-5 py-3 -mt-px relative"
          style={{
            background: 'linear-gradient(180deg, rgba(14,14,22,0.82) 0%, rgba(10,12,18,0.72) 100%)',
            border: '1px solid rgba(242,106,31,0.18)',
            backdropFilter: 'blur(10px) saturate(1.05)',
            WebkitBackdropFilter: 'blur(10px) saturate(1.05)',
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          }}
        >
          <p className="font-mono text-[11px] text-boneDim/75 max-w-3xl leading-relaxed">
            {subtitle}
          </p>
        </div>
      )}
    </div>
  );
}
