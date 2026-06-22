'use client';

/**
 * Wrap a feature that needs a higher request level. Below `need`, instead of a
 * blank section, show an explainer with a button that opens the RPC settings so
 * the user can raise the level (and set their own RPC for heavier features).
 */
import type { ReactNode } from 'react';
import { levelAtLeast, getRequestLevel, type RequestLevel } from '@/lib/user-config';

const LABEL: Record<RequestLevel, string> = { mvr: 'Minimal', higher: 'Higher', full: 'Full' };

export function RequestLevelGate({
  need,
  feature,
  children,
}: {
  need: RequestLevel;
  feature: string;
  children: ReactNode;
}) {
  if (levelAtLeast(need)) return <>{children}</>;

  const current = getRequestLevel();
  const needsRpc = need === 'full';

  return (
    <div className="mx-auto max-w-md rounded-xl border border-orange/20 bg-black/30 px-6 py-10 text-center">
      <div className="mb-2 font-display text-bone text-lg">{feature} is off in {LABEL[current]} mode</div>
      <p className="mb-5 text-[12px] leading-relaxed text-boneDim/70">
        This build keeps requests minimal by default. Raise the request level to{' '}
        <span className="text-orange font-semibold">{LABEL[need]}</span>
        {needsRpc ? ' and set your own RPC (free public endpoints can’t enumerate tables).' : ' to enable it.'}
      </p>
      <button
        onClick={() => window.dispatchEvent(new Event('fp:open-rpc-settings'))}
        className="rounded-lg bg-orange px-4 py-2 text-[12px] font-bold text-black hover:bg-orangeHi"
      >
        Open RPC settings &amp; upgrade
      </button>
    </div>
  );
}
