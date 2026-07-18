'use client';

// Pre-buy-in disclosure for the SnG Duels join modal (audit requirement). Tight spec rows, not
// prose: how SOL and $FP pay, the Duel itself, and that the Bounty Bank survives busting.
// Only for 6max/9max.

import { sngDuelsEnabled } from '@/lib/sng-duel-flags';
import { DUEL_FORMAT_NAME, SHIELD_RULESET_NAME } from '@/lib/bounty-format';
import { TokenMark } from './TokenMark';

const K = 'w-10 shrink-0 inline-flex items-center font-mono text-[8px] uppercase tracking-[0.18em] text-bone/40 leading-none';
const V = 'font-mono text-[10px] text-bone/80 leading-none min-w-0';
const DIM = 'text-bone/35';

export default function BountyDisclosure({
  maxPlayers,
  className,
}: {
  maxPlayers: number;
  className?: string;
}) {
  if (!sngDuelsEnabled() || (maxPlayers !== 6 && maxPlayers !== 9)) return null;
  // Flat Bounty is the only SnG Duel ruleset (2026-07-14 rework: knockout-only
  // points, symmetric duel stakes, fractional tie splits).
  return (
    <div className={`rounded-lg border border-amber/25 bg-amber/5 px-3 py-2 ${className ?? ''}`} data-format="bounty">
      <div className="font-display text-[10px] uppercase tracking-[0.18em] text-amber">
        {DUEL_FORMAT_NAME} &middot; {SHIELD_RULESET_NAME}
      </div>
      <div className="mt-1.5 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={K}><span className="mr-1 text-[10px] leading-none text-amber">&#9876;</span>Duel</span>
          <span className={V}>1v1 each blind level <span className={DIM}>&middot;</span> symmetric chip stake <span className={DIM}>&middot;</span> play or redeal <span className={DIM}>&times;</span>3</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={K}>Points</span>
          <span className={V}>everyone starts with 1 <span className={DIM}>&middot;</span> knockouts take them <span className={DIM}>&middot;</span> tied winners split</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={K}><TokenMark t="sol" size={10} className="mr-1" />SOL</span>
          <span className={V}>50% split by points held <span className={DIM}>&middot;</span> 50% finish (ITM)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={K}><TokenMark t="fp" size={10} className="mr-1" />$FP</span>
          <span className={V}>100% split by points <span className={DIM}>&times;</span> maturity <span className="text-bone/40">(grows per level)</span></span>
        </div>
      </div>
    </div>
  );
}
