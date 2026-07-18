'use client';

// Composite HUD so the PokerTable integration is a single flag-gated mount: the duel-state chip +
// the Bounty Bank, sitting next to the existing LEVEL # in the header. The level number itself is
// already rendered by PokerTable; this adds the two SnG Duels elements beside it.

import BountyBank from './BountyBank';
import DuelStatusChip from './DuelStatusChip';
import { sngDuelsEnabled } from '@/lib/sng-duel-flags';

export default function BountyDuelHud({
  table,
  heroSeat,
  currentBlindLevel,
  pokerPoolUnrefined,
  solPrizePoolLamports,
  className,
}: {
  table: string | null | undefined;
  heroSeat: number | null;
  currentBlindLevel: number;
  pokerPoolUnrefined?: bigint;
  solPrizePoolLamports?: bigint;
  className?: string;
}) {
  if (!sngDuelsEnabled()) return null;
  return (
    <div className={`flex items-center gap-3 ${className ?? ''}`} data-format="bounty">
      <DuelStatusChip table={table} heroSeat={heroSeat} currentBlindLevel={currentBlindLevel} />
      <BountyBank
        table={table}
        heroSeat={heroSeat}
        currentBlindLevel={currentBlindLevel}
        pokerPoolUnrefined={pokerPoolUnrefined}
        solPrizePoolLamports={solPrizePoolLamports}
      />
    </div>
  );
}
