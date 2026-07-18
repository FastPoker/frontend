'use client';

// Per-seat badge: the number that matters in v1 (flat credits) is KOs earned by this seat.
// (bounty-on-head is uniform in v1; it becomes per-seat only when survived-depth ships.)

import { sngDuelsEnabled } from '@/lib/sng-duel-flags';

export default function SeatBountyBadge({
  koCount,
  className,
}: {
  koCount: number;
  className?: string;
}) {
  if (!sngDuelsEnabled() || koCount <= 0) return null;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full border border-amber/40 bg-amber/15 px-1.5 py-0.5 text-[9px] font-display tabular-nums text-amber ${className ?? ''}`}
      title={`${koCount} knockout${koCount === 1 ? '' : 's'} (bounties collected)`}
      data-format="bounty"
    >
      KO {koCount}
    </span>
  );
}
