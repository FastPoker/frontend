'use client';

import { cn } from '@/lib/utils';

export interface CommunityCardFeltProps {
  /** Card indices 0-51, or null for hidden slot */
  cards: (number | null)[];
  /** Street label (e.g., "FLOP", "TURN", "RIVER") */
  street?: string;
  /** Pot total label (optional, e.g., "0.48 SOL") */
  potLabel?: string;
  /** Optional sub-label under the pot (e.g., "MAIN POT") */
  potSubLabel?: string;
}

const SUITS = ['♠', '♥', '♦', '♣'] as const;
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;

function cardFromIndex(idx: number): { rank: string; suit: string; red: boolean } {
  const suit = SUITS[Math.floor(idx / 13) % 4];
  const rank = RANKS[idx % 13];
  const red = suit === '♥' || suit === '♦';
  return { rank, suit, red };
}

// Bicycle "Large Print" / EZ See style — jumbo rank + suit in two opposing
// corners, no center pip. The rank + suit pair takes ~80% of the card area;
// bottom-right is the same pair rotated 180° for cross-table readability.
function CardFace({ idx }: { idx: number | null }) {
  if (idx === null) {
    return (
      <div className="w-[46px] h-[68px] rounded-[5px] border border-bone/10 bg-ink/30" />
    );
  }
  const { rank, suit, red } = cardFromIndex(idx);
  const colorClass = red ? 'text-rose-500' : 'text-ink';
  return (
    <div className="w-[46px] h-[68px] rounded-[5px] bg-bone shadow-[0_8px_20px_rgba(0,0,0,0.5)] relative overflow-hidden">
      {/* Top-left jumbo rank + suit */}
      <div className="absolute top-[2px] left-[3px] flex flex-col items-center leading-none">
        <span className={cn('font-display font-black text-[26px] leading-none tracking-tighter', colorClass)}>
          {rank}
        </span>
        <span className={cn('text-[20px] leading-none -mt-[2px]', colorClass)}>
          {suit}
        </span>
      </div>
      {/* Bottom-right same pair, rotated for the player on the other side */}
      <div className="absolute bottom-[2px] right-[3px] flex flex-col items-center leading-none rotate-180">
        <span className={cn('font-display font-black text-[26px] leading-none tracking-tighter', colorClass)}>
          {rank}
        </span>
        <span className={cn('text-[20px] leading-none -mt-[2px]', colorClass)}>
          {suit}
        </span>
      </div>
    </div>
  );
}

export function CommunityCardFelt({ cards, street, potLabel, potSubLabel }: CommunityCardFeltProps) {
  const padded: (number | null)[] = [...cards];
  while (padded.length < 5) padded.push(null);
  return (
    <div className="flex flex-col items-center gap-3">
      {street && (
        <div className="font-mono text-[9px] tracking-[0.32em] text-boneDim/55">
          {street}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        {padded.slice(0, 5).map((c, i) => (
          <CardFace key={i} idx={c} />
        ))}
      </div>
      {potLabel && (
        <div className="mt-1 text-center">
          {potSubLabel && (
            <div className="font-mono text-[8px] tracking-[0.3em] text-boneDim/55">
              {potSubLabel}
            </div>
          )}
          <div className="font-display text-xl text-bone tabular-nums tracking-wider">
            {potLabel}
          </div>
        </div>
      )}
    </div>
  );
}
