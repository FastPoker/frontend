'use client';

// Cool, centered DUEL overlay (replaces the old bottom-right corner modal). Sits over the community
// cards. Shows the round tracker, the two duelists clashing with their per-round choice, a countdown,
// and the hero's all-in / fold buttons. Hero is detected by PUBKEY at the duel seats (robust during
// the Waiting-phase duel, when myPlayer.seatIndex can be unreliable). Gated on sngDuelRoundsEnabled.

import { useEffect, useRef, useState } from 'react';
import { useSngBountyState } from '@/hooks/useSngBountyState';
import { duelView, type DuelView } from '@/lib/sng-duel-view';
import { sngDuelRoundsEnabled } from '@/lib/sng-duel-flags';
import { fpEvent } from '@/lib/fp-events';
import { bountyExposedStake } from '@/lib/sng-duel';
import { duelActionLabel, duelBlindsLine, duelStakesLine } from '@/lib/bounty-format';

export type DuelAction = 'all-in' | 'fold';

// 0 none / 1 accept deal / 2 redeal. DESIGN DECISION (CONTRACT_FIXES_2026-07-02.md section 4): duel
// choices are intentionally VISIBLE the moment a duelist commits - the sequential information is
// part of the game, not a leak. Flat bounty (2026-07-14): the stake is symmetric and neither
// choice opts out, so the labels are PLAY (accept this deal) / NEXT CARDS (redeal).
function choiceBadge(choice: number) {
  if (choice === 1) return { label: 'PLAY', cls: 'border-amber/60 bg-amber/15 text-amber' };
  if (choice === 2) return { label: 'NEXT CARDS', cls: 'border-white/15 bg-white/5 text-bone/50' };
  return { label: 'DECIDING', cls: 'border-white/10 bg-white/5 text-bone/35 animate-pulse' };
}

export default function DuelOverlay({
  table,
  heroPubkey,
  seatPubkey,
  seatName,
  onAction,
  compact = false,
  alivePlayers,
  blindLevel,
  smallBlind,
  bigBlind,
}: {
  table: string | null | undefined;
  heroPubkey?: string | null;
  seatPubkey?: (seat: number) => string | null;
  seatName?: (seat: number) => string;
  onAction?: (action: DuelAction, seatA: number, seatB: number) => void | Promise<unknown>;
  /** Board cards are up (the duel's own run-out): render a slim top banner instead of the
   *  centered modal, so the duel stays readable without covering the community cards.
   *  The component must NOT unmount in that state - the resolve linger lives here. */
  compact?: boolean;
  /** Flat Bounty context label/stakes math. */
  alivePlayers?: number;
  blindLevel?: number;
  smallBlind?: number;
  bigBlind?: number;
}) {
  const { state, initialized } = useSngBountyState(table ?? null, 1200);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [submitting, setSubmitting] = useState<DuelAction | null>(null);
  const [submittedChoice, setSubmittedChoice] = useState<DuelAction | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 500);
    return () => window.clearInterval(id);
  }, []);

  const dv = state ? duelView(state, null) : null;
  const active = mounted && sngDuelRoundsEnabled() && initialized && !!dv?.active;

  // Hero detection by pubkey at the duel seats (heroSeat can be stale in Waiting phase).
  const heroA = active && !!heroPubkey && seatPubkey?.(dv!.seatA) === heroPubkey;
  const heroB = active && !!heroPubkey && seatPubkey?.(dv!.seatB) === heroPubkey;
  const heroInDuel = heroA || heroB;
  const localChoiceCode = submittedChoice === 'all-in' ? 1 : submittedChoice === 'fold' ? 2 : 0;
  const choiceA = heroA && localChoiceCode ? localChoiceCode : dv?.choiceA ?? 0;
  const choiceB = heroB && localChoiceCode ? localChoiceCode : dv?.choiceB ?? 0;
  const heroChoice = heroA ? choiceA : heroB ? choiceB : 0;
  const heroNeedsAction = !!dv?.active && heroInDuel && heroChoice === 0;

  const remain = (dv?.deadlineTs ?? 0) > 0 ? Math.max(0, dv!.deadlineTs - now) : null;
  const heroCanAct = heroNeedsAction && (remain == null || remain > 0);
  const nameA = dv ? seatName?.(dv.seatA) ?? `Seat ${dv.seatA}` : 'Seat';
  const nameB = dv ? seatName?.(dv.seatB) ?? `Seat ${dv.seatB}` : 'Seat';

  // ---- Flat bounty: the symmetric stake this duel is playing for ----
  const shieldCtx = (() => {
    if (!state || !dv?.active) return null;
    const lvl = blindLevel ?? state.lastDuelBlindLevel;
    const bb = bigBlind ?? 0;
    const stake = bb > 0 ? bountyExposedStake(lvl, bb) : 0;
    return { stake };
  })();
  const resolved = !!dv && ((dv.choiceA !== 0 && dv.choiceB !== 0) || dv.round >= dv.maxRound);
  const badgeA = choiceBadge(choiceA);
  const badgeB = choiceBadge(choiceB);

  useEffect(() => {
    if (!submittedChoice) return;
    if (!dv?.active || !heroInDuel || (heroA ? dv.choiceA !== 0 : heroB ? dv.choiceB !== 0 : false)) {
      setSubmittedChoice(null);
      setSubmitting(null);
    }
  }, [submittedChoice, dv?.active, dv?.choiceA, dv?.choiceB, heroA, heroB, heroInDuel]);

  // Run-out pacing (#6): when the duel resolves and the sidecar flips inactive, LINGER the final
  // resolved view for a few beats - the showdown reads on the overlay while the duelists' revealed
  // cards land at their seats - instead of the whole thing snapping away in one poll.
  const lastViewRef = useRef<{ dv: DuelView; nameA: string; nameB: string } | null>(null);
  const firstSeenRef = useRef<number | null>(null);
  const sawChoiceRef = useRef(false);
  const [linger, setLinger] = useState<{ dv: DuelView; nameA: string; nameB: string } | null>(null);
  // Latch the freshest ACTIVE view on EVERY render, not inside the effect below - its
  // dep is [dv?.active], so an effect-side latch only ever captured the FIRST active
  // frame (choices 0/0) and the resolve path mis-read every played duel as
  // "vanished untouched". Caught by the [FP-EVT] timeline on 2026-07-03.
  if (dv?.active) {
    lastViewRef.current = { dv, nameA, nameB };
    // Choices reset to 0/0 on a round transition (1->2->3), so the latest view alone
    // can't answer "did the client watch a choice this duel" - a multi-round duel that
    // resolves inside round 2's first poll frame would misread as sub-poll (live find
    // 2026-07-04, hand 467: round-1 CALL_IN watched for 6s, then round 2 resolved
    // sub-poll and the branch below picked the 3s beat instead of min-dwell).
    if (dv.choiceA !== 0 || dv.choiceB !== 0) sawChoiceRef.current = true;
  }
  useEffect(() => {
    if (dv?.active) {
      if (firstSeenRef.current == null) {
        firstSeenRef.current = Date.now();
        fpEvent('duel.overlay_shown', { seatA: dv.seatA, seatB: dv.seatB, round: dv.round });
      }
      setLinger(null);
      return;
    }
    const last = lastViewRef.current;
    const sawChoice = sawChoiceRef.current;
    sawChoiceRef.current = false;
    // Only linger when the duel actually PLAYED (a choice was made); a duel that vanished
    // untouched (timeout cleanup elsewhere) just disappears. sawChoice covers multi-round
    // duels whose final round resolved sub-poll after earlier rounds' choices were watched.
    if (last && (last.dv.choiceA !== 0 || last.dv.choiceB !== 0 || sawChoice)) {
      // #6 pacing (live finding 2026-07-03): when both duelists answer near-instantly
      // (bots, or two snap call-ins), the whole duel can resolve inside one poll tick and
      // the overlay flashes. Hold the resolved view long enough that the duel reads on
      // screen for at least ~7s TOTAL, never less than the 4.2s showdown linger.
      const seenMs = firstSeenRef.current != null ? Date.now() - firstSeenRef.current : 0;
      const hold = Math.max(4200, 7000 - seenMs);
      lastViewRef.current = null;
      firstSeenRef.current = null;
      fpEvent('duel.overlay_linger_start', { seenMs, holdMs: hold });
      setLinger(last);
      const t = setTimeout(() => {
        fpEvent('duel.overlay_hidden', { via: 'linger_end' }, 'timer');
        setLinger(null);
      }, hold);
      return () => clearTimeout(t);
    }
    if (last && firstSeenRef.current != null) {
      // Sub-poll resolution (live finding 2026-07-04): BOTH call-ins can land and resolve
      // inside one 1.2s poll tick, so the client never sees a nonzero choice - yet the
      // duel's all-in showdown is playing on the felt right now. Vanishing here orphans
      // that showdown from its duel. Hold a short resolved linger (compact banner when
      // board cards are up) so the duel visibly owns its outcome.
      const seenMs = Date.now() - firstSeenRef.current;
      lastViewRef.current = null;
      firstSeenRef.current = null;
      // holdMs is a FIXED 3s beat regardless of seenMs (spec rule 6 exception); seenMs is
      // telemetry only - it distinguishes untouched-timeout (large) from true sub-poll (~0).
      fpEvent('duel.overlay_linger_start', { seenMs, holdMs: 3000, via: 'sub_poll_resolution' });
      setLinger(last);
      const t = setTimeout(() => {
        fpEvent('duel.overlay_hidden', { via: 'linger_end' }, 'timer');
        setLinger(null);
      }, 3000);
      return () => clearTimeout(t);
    }
    if (firstSeenRef.current != null) {
      fpEvent('duel.overlay_hidden', { via: 'vanished_untouched' });
    }
    firstSeenRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dv?.active]);

  // RESOLVING beat: the deadline ran out with the duel unresolved - the UI is waiting on
  // the crank's timeout TX. Emit once per zero-crossing so the timeline shows the gap.
  const resolvingShownRef = useRef(false);
  useEffect(() => {
    const showResolving = !!dv?.active && remain === 0 && !resolved;
    if (showResolving && !resolvingShownRef.current) {
      resolvingShownRef.current = true;
      fpEvent('duel.resolving_shown', { round: dv?.round }, 'timer');
    } else if (!showResolving) {
      resolvingShownRef.current = false;
    }
  }, [dv?.active, remain, resolved, dv?.round]);

  // Compact-mode proof event (pixel-free evidence the banner rendered). Must live ABOVE
  // the early return with every other hook - Rules of Hooks.
  const overlayVisible = (mounted && sngDuelRoundsEnabled() && initialized && !!dv?.active) || !!linger;
  useEffect(() => {
    if (compact && overlayVisible) fpEvent('duel.overlay_compact', { live: !!dv?.active });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, overlayVisible]);

  const act = async (a: DuelAction) => {
    if (!onAction || submitting || !dv || !heroCanAct) return;
    setSubmitting(a);
    try {
      await onAction(a, dv.seatA, dv.seatB);
      setSubmittedChoice(a);
      setSubmitting(null);
    } catch {
      setSubmitting(null);
    }
  };

  const showLive = active && !!dv;
  if (!showLive && !linger) return null;

  // Unified view: live sidecar data while the duel runs, the latched final state while lingering.
  const view = showLive ? dv! : linger!.dv;
  const viewNameA = showLive ? nameA : linger!.nameA;
  const viewNameB = showLive ? nameB : linger!.nameB;
  const viewHeroA = !!heroPubkey && seatPubkey?.(view.seatA) === heroPubkey;
  const viewHeroB = !!heroPubkey && seatPubkey?.(view.seatB) === heroPubkey;
  const viewChoiceA = showLive ? choiceA : view.choiceA;
  const viewChoiceB = showLive ? choiceB : view.choiceB;
  const viewBadgeA = choiceBadge(viewChoiceA);
  const viewBadgeB = choiceBadge(viewChoiceB);
  const viewResolved = showLive ? resolved : true;
  const viewRemain = showLive ? remain : null;

  if (compact) {
    // Slim banner above the board: title + duelists + choice badges + timer/resolving.
    return (
      <div className="pointer-events-none absolute inset-x-0 top-[8%] z-[65] flex justify-center px-4" data-format="bounty">
        <div className="pointer-events-auto inline-flex max-w-full items-center gap-2.5 rounded-full border border-white/10 bg-black/80 px-4 py-1.5 shadow-xl backdrop-blur animate-in fade-in slide-in-from-top-2 duration-300">
          <span className="inline-flex items-center gap-1 font-display text-[11px] uppercase tracking-[0.22em] text-amber">
            <span className="leading-none">&#9876;</span> Duel
          </span>
          <span className="h-3.5 w-px bg-white/10" />
          <span className={`truncate font-display text-xs ${viewHeroA ? 'text-amber' : 'text-bone'}`}>{viewHeroA ? 'YOU' : viewNameA}</span>
          <span className={`rounded-full border px-1.5 py-px font-display text-[8px] uppercase tracking-wider ${viewBadgeA.cls}`}>{viewBadgeA.label}</span>
          <span className="font-display text-[10px] text-amber/60">vs</span>
          <span className={`truncate font-display text-xs ${viewHeroB ? 'text-amber' : 'text-bone'}`}>{viewHeroB ? 'YOU' : viewNameB}</span>
          <span className={`rounded-full border px-1.5 py-px font-display text-[8px] uppercase tracking-wider ${viewBadgeB.cls}`}>{viewBadgeB.label}</span>
          {viewRemain != null && (viewRemain > 0 && !viewResolved ? (
            <span className={`font-display text-xs tabular-nums ${viewRemain <= 5 ? 'text-red-400' : 'text-bone/60'}`}>{viewRemain}s</span>
          ) : viewResolved ? (
            <span className="font-mono text-[8px] uppercase tracking-[0.14em] text-emerald-400/80">showdown</span>
          ) : (
            <span className="font-mono text-[8px] uppercase tracking-[0.14em] text-amber/70 animate-pulse">resolving</span>
          ))}
        </div>
      </div>
    );
  }

  return (
    // Absolute inset-0: centers over the felt container it's mounted in (the glass-room), which
    // excludes the right rail - so it lands on the community cards, not the viewport center.
    <div className="pointer-events-none absolute inset-0 z-[65] flex items-center justify-center px-4" data-format="bounty">
      <div className="pointer-events-auto w-[440px] max-w-full animate-in fade-in zoom-in-95 duration-300 rounded-xl border border-white/10 bg-black/85 p-4 shadow-2xl backdrop-blur">
        {/* header: title · round tracker · timer */}
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 font-display text-sm uppercase tracking-[0.22em] text-amber">
            <span className="text-base leading-none">&#9876;</span> Duel
          </span>
          <div className="flex items-center gap-1.5">
            {[1, 2, 3].map((r) => (
              <span
                key={r}
                className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-display tabular-nums ${
                  r === view.round ? 'bg-amber text-black' : r < view.round ? 'bg-amber/20 text-amber/70' : 'bg-white/5 text-bone/30'
                }`}
              >
                {r}
              </span>
            ))}
          </div>
          {viewRemain != null ? (
            viewRemain > 0 || viewResolved ? (
              <span className={`w-9 text-right font-display text-sm tabular-nums ${viewRemain <= 5 ? 'text-red-400' : 'text-bone/60'}`}>
                {viewRemain}s
              </span>
            ) : (
              // Deadline elapsed but the timeout/resolve TX hasn't landed yet - a frozen
              // "0s" reads as broken; the duel is waiting on the crank, so say so.
              <span className="text-right font-mono text-[9px] uppercase tracking-[0.14em] text-amber/70 animate-pulse">
                resolving
              </span>
            )
          ) : (
            <span className="w-9" />
          )}
        </div>

        {/* clash */}
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className={`flex flex-col items-center gap-1 rounded-xl border p-2 ${viewHeroA ? 'border-amber/40 bg-amber/[0.06]' : 'border-white/10 bg-white/[0.02]'}`}>
            <span className={`max-w-full truncate text-sm ${viewHeroA ? 'text-amber' : 'text-bone'}`}>{viewHeroA ? 'YOU' : viewNameA}</span>
            <span className={`rounded-full border px-2 py-0.5 font-display text-[10px] uppercase tracking-wider ${viewBadgeA.cls}`}>{viewBadgeA.label}</span>
          </div>
          <span className="font-display text-lg text-amber/70">VS</span>
          <div className={`flex flex-col items-center gap-1 rounded-xl border p-2 ${viewHeroB ? 'border-amber/40 bg-amber/[0.06]' : 'border-white/10 bg-white/[0.02]'}`}>
            <span className={`max-w-full truncate text-sm ${viewHeroB ? 'text-amber' : 'text-bone'}`}>{viewHeroB ? 'YOU' : viewNameB}</span>
            <span className={`rounded-full border px-2 py-0.5 font-display text-[10px] uppercase tracking-wider ${viewBadgeB.cls}`}>{viewBadgeB.label}</span>
          </div>
        </div>

        {viewResolved && (
          <div className="mt-2 text-center font-display text-[11px] uppercase tracking-[0.22em] text-amber">
            Showdown{!showLive ? ' · cards on the table' : ''}
          </div>
        )}

        {/* Flat bounty: blinds committed + the symmetric stake line - same wording for
            duelists and spectators (no hero-oriented asymmetry to phrase around). */}
        {shieldCtx && shieldCtx.stake > 0 && !viewResolved && (
          <div className="mt-2 text-center font-mono text-[10px] leading-relaxed">
            {smallBlind != null && bigBlind != null && bigBlind > 0 && (
              <div className="text-amber/70">{duelBlindsLine(smallBlind, bigBlind)}</div>
            )}
            <div className="text-bone/55">{duelStakesLine(shieldCtx.stake)}</div>
          </div>
        )}

        {/* hero action: PLAY accepts this deal, NEXT CARDS redeals - neither opts
            out of the stake (round 3 plays whatever is dealt). */}
        {heroCanAct && onAction && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={() => act('all-in')} disabled={!!submitting} className="fp-cta-join py-2 font-display text-sm disabled:opacity-50">
              {submitting === 'all-in' ? '···' : duelActionLabel(shieldCtx?.stake)}
            </button>
            <button onClick={() => act('fold')} disabled={!!submitting} className="rounded-lg border border-white/15 py-2 font-display text-sm text-bone/70 disabled:opacity-50">
              {submitting === 'fold' ? '···' : 'NEXT CARDS'}
            </button>
          </div>
        )}
        {heroInDuel && !heroNeedsAction && !resolved && (
          <div className="mt-3 text-center font-mono text-[11px] text-bone/45">choice locked · waiting on opponent</div>
        )}
      </div>
    </div>
  );
}
