import type { ReactNode } from 'react';

/**
 * Canonical top-of-page headline used by Lobby, About, and Earn.
 * Two display lines (line two italic + orange) and an optional
 * subtitle + right-side slot. Styling locked to the EARN reference:
 * `font-display text-bone text-5xl lg:text-6xl leading-[0.92] tracking-wide`.
 */
export function PageHeadline({
  lineOne,
  lineTwo,
  subtitle,
  right,
  id,
  singleLine = false,
  subtitleAside = false,
}: {
  lineOne: string;
  lineTwo: string;
  subtitle?: string;
  right?: ReactNode;
  id?: string;
  /** Keep both words on one line at every breakpoint (font scales down to fit). */
  singleLine?: boolean;
  /** Render the subtitle as a second column beside the headline (one row on
      larger screens, stacks below on narrow screens). Default: stacked under. */
  subtitleAside?: boolean;
}) {
  return (
    <div
      id={id ?? 'page-headline'}
      className="flex items-start justify-between gap-3 sm:gap-4 flex-wrap"
    >
      <div className={`min-w-0 text-center sm:text-left ${subtitleAside ? 'basis-full sm:basis-0 sm:grow-[3]' : 'flex-1 basis-[18rem]'}`}>
        <h1
          className={
            singleLine
              ? 'font-display text-bone leading-[0.92] tracking-wide whitespace-nowrap text-[clamp(1.65rem,8.5vw,3.75rem)] [@media(orientation:landscape)_and_(max-height:500px)]:text-[2.6rem]'
              : 'font-display text-bone leading-[0.92] tracking-wide text-[clamp(1.65rem,8.5vw,3.75rem)]'
          }
        >
          {lineOne.toUpperCase()}
          {!singleLine && <br className="lg:hidden" />}
          <span className={`italic text-orange ${singleLine ? 'ml-2' : 'lg:ml-3'}`}>{lineTwo.toUpperCase()}</span>
        </h1>
        {subtitle && !subtitleAside && (
          <p className="font-sans text-[12px] text-boneDim/70 mt-3 max-w-xl leading-relaxed mx-auto sm:mx-0">
            {subtitle}
          </p>
        )}
      </div>
      {subtitle && subtitleAside && (
        <div className="min-w-0 basis-full sm:basis-0 sm:grow-[2] sm:self-center text-center sm:text-left">
          <p className="font-sans text-[12px] text-boneDim/70 max-w-xl leading-relaxed mx-auto sm:mx-0">
            {subtitle}
          </p>
        </div>
      )}
      {right && (
        <div className="flex flex-col items-center sm:items-end gap-1 shrink-0 w-full sm:w-auto">
          {right}
        </div>
      )}
    </div>
  );
}
