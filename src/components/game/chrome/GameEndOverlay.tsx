'use client';

import { useEffect, useRef, useState } from 'react';
import { useClaimableTotals } from '@/hooks/useClaimableTotals';
import { formatPoints } from '@/lib/sng-duel-view';
import { createPortal } from 'react-dom';

export type GameEndResult = 'winner' | 'itm' | 'out';

export type DistributionStatus = 'pending' | 'in_progress' | 'complete';

export interface GameEndOverlayProps {
  open: boolean;
  onClose: () => void;
  result: GameEndResult;
  place: number;
  /** False when the hero busted but the SNG is still running (others playing).
   *  Prizes only distribute when the tournament ends, so while false the overlay
   *  shows "claimable after the game finishes" instead of "distributing now",
   *  and the refine/claim actions stay locked. Defaults to true. */
  tournamentOver?: boolean;
  tierName: string;
  playerName?: string;
  payout: { poker: number; sol: number };
  /** Total table reward pools, before per-place split. */
  rewards?: { pokerPool: number; solPool: number };
  /** SnG Duels: the hero's bounty breakdown. Bounty pays even OUT of the money, so this section
   *  renders regardless of finish; it's the mode's core reward story. */
  bounty?: {
    koCount: number;
    fpBounty: number;      // hero's $FP from bounties (matured share; $FP is pure bounty in duel mode)
    solBounty: number;     // hero's SOL from the bounty half
    maturityPct: number;   // maturity the bounties settled/project at
    topHunters: { name: string; ko: number }[];
    /** Bounty Shield (ruleset 1): counts are HELD POINTS, not knockouts - labels switch. */
    shield?: boolean;
    /** Sidecar paid flag. Under shield, points MOVE on the final bust itself, so the
     *  at-open snapshot can be one transfer stale - re-snapshot once when this flips. */
    settled?: boolean;
  };
  xpEarned?: number;
  onShare?: () => void;
  onPlayAgain?: () => void;
  onLobby?: () => void;

  // ─── Optional: claim-side actions for the raw $FP earned at this table ────
  //
  // Three paths the player can take with unrefined $FP:
  //   • Leave to earn — keep as raw $FP, refined slowly grows from the
  //     tax-redistribution pool. No tx, no fee.
  //   • Claim now — refine raw → liquid $POKER in your wallet. Steel charges
  //     a 10% burn tax on the unrefined portion (calculate_claim_after_tax).
  //   • Claim + stake — refine then burn into your stake position in one TX.
  //     Same 10% Steel claim tax, then the refined remainder is burned into
  //     stake; earns ongoing yield from rake.
  //
  // If the corresponding handler is undefined the modal hides that button.
  /** Raw (unrefined) $FP just earned at this table. */
  rawPoker?: number;
  /** Steel claim tax in basis points (1000 = 10%). Defaults to 1000. */
  claimTaxBps?: number;
  /** Where the on-chain prize distribution currently is. Drives the
   *  progress strip above the earnings cards. */
  distribution?: { status: DistributionStatus; current?: number; total?: number };
  onLeaveToEarn?: () => void;
  onClaimRaw?: () => void | Promise<void>;
  onClaimAndStake?: () => void | Promise<void>;
}

function ChipRain() {
  const [chips] = useState(() =>
    Array.from({ length: 40 }).map((_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 1.2,
      dur: 2.4 + Math.random() * 2.4,
      size: 10 + Math.random() * 14,
      rot: Math.random() * 360,
      color: ['#FFC63A', '#F26A1F', '#F5F1E6', '#FFD96A'][Math.floor(Math.random() * 4)],
      key: i,
    })),
  );
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {chips.map(c => (
        <div
          key={c.key}
          className="absolute chip-fall"
          style={{
            left: `${c.left}%`,
            top: -20,
            width: c.size,
            height: c.size,
            background: `radial-gradient(circle at 35% 30%, #fff 0%, ${c.color} 35%, ${c.color}88 100%)`,
            border: `1px solid ${c.color}`,
            borderRadius: '50%',
            animationDuration: `${c.dur}s`,
            animationDelay: `${c.delay}s`,
            boxShadow: `0 0 8px ${c.color}66`,
            transform: `rotate(${c.rot}deg)`,
          }}
        />
      ))}
    </div>
  );
}

function placeSuffix(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

export function GameEndOverlay({
  open,
  onClose,
  result,
  place,
  tournamentOver = true,
  tierName,
  playerName = 'You',
  payout,
  bounty,
  rewards,
  xpEarned,
  onShare,
  onPlayAgain,
  onLobby,
  rawPoker = 0,
  claimTaxBps = 1000,
  distribution,
  onLeaveToEarn,
  onClaimRaw,
  onClaimAndStake,
}: GameEndOverlayProps) {
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState<null | 'claim' | 'stake'>(null);
  useEffect(() => { setMounted(true); }, []);
  // Freeze the RESULT data at open (finding 2026-07-04): the table resets underneath the
  // open overlay (tournamentStartTime -> 0, roster cleared) and the live-derived props
  // degrade in place - SOL pool flips to 0.000, the prize row vanishes, top-hunter names
  // fall back to "Seat N", and the bounty footer contradicts the header. Process props
  // (open/distribution/tournamentOver/claim totals) stay live; the snapshot refreshes
  // once on the tournamentOver false->true edge, the moment results actually finalize.
  type ResultSnap = {
    result: GameEndResult; place: number; tierName: string; playerName: string;
    payout: { poker: number; sol: number };
    rewards?: GameEndOverlayProps['rewards'];
    bounty?: GameEndOverlayProps['bounty'];
    xpEarned?: number; rawPoker: number;
  };
  const [snap, setSnap] = useState<ResultSnap | null>(null);
  const wasOverRef = useRef(false);
  const wasSettledRef = useRef(false);
  useEffect(() => {
    if (!open) { setSnap(null); wasOverRef.current = false; wasSettledRef.current = false; return; }
    // Re-snapshot on the tournamentOver edge (results finalize) AND, under Bounty
    // Shield, once when the sidecar settles - the final bust moves points, so the
    // at-open bounty reading can be one transfer stale (live find: overlay said
    // "2 points / 0.09" while settlement paid 1 retained point / 0.045).
    const settledEdge = !!bounty?.shield && !!bounty?.settled && !wasSettledRef.current;
    setSnap((prev) =>
      !prev || (tournamentOver && !wasOverRef.current) || settledEdge
        ? { result, place, tierName, playerName, payout, rewards, bounty, xpEarned, rawPoker }
        : prev,
    );
    wasOverRef.current = tournamentOver;
    if (bounty?.settled) wasSettledRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tournamentOver, bounty?.settled]);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);
  // Keyboard dismissal (finding 2026-07-03: the overlay traps the whole page with a
  // mouse-only escape hatch).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  // Fast-pay awareness: E1 pays claimable SOL ~40-70s after Complete - often before the
  // legacy distribution signal flips. Watch the shared claimable poll; once sngSol RISES
  // above its at-open snapshot, the "distributing" spinner becomes a claim-ready state.
  const { totals: claimTotals } = useClaimableTotals();
  const sngSolAtOpenRef = useRef<number | null>(null);
  useEffect(() => {
    if (open && sngSolAtOpenRef.current === null) sngSolAtOpenRef.current = claimTotals?.sngSol ?? 0;
    if (!open) sngSolAtOpenRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const prizeLanded =
    sngSolAtOpenRef.current !== null && (claimTotals?.sngSol ?? 0) > sngSolAtOpenRef.current;

  if (!open || !mounted) return null;

  // Render from the at-open snapshot; live props only feed the very first paint
  // (identical values at that moment) and the process-state panels below.
  if (snap) {
    ({ result, place, tierName, playerName, payout, rewards, bounty, xpEarned, rawPoker } = snap);
  }

  const isWinner = result === 'winner';
  const isItm = result === 'itm';
  const label = isWinner ? 'VICTORY' : isItm ? 'IN THE MONEY' : 'ELIMINATED';
  const tone = isWinner ? '#FFD96A' : isItm ? '#F2C36A' : '#B84515';
  const suffix = placeSuffix(place);
  // Fallback mirrors the CONTRACT XP awards (XP_SNG_WIN/ITM/PLAY = 200/75/25) - the old
  // 250/150/100 guesses displayed prizes the chain never paid (finding 2026-07-03).
  const defaultXp = xpEarned ?? (isWinner ? 200 : isItm ? 75 : 25);

  // ─── Refine / distribution state ────────────────────────────────────────
  // While the crank settles the SNG on L1 the prize hasn't been credited yet;
  // we hold the refine actions back until distribution.status === 'complete'.
  // Distribution only runs once the whole tournament finishes. While it's still
  // running (hero busted, others playing) there is nothing settling yet — show
  // the pending block instead, and keep claim/refine locked.
  const stillSettling = tournamentOver && !!distribution && distribution.status !== 'complete';
  const netAfterTax = rawPoker > 0 ? rawPoker * (1 - claimTaxBps / 10000) : 0;
  const taxPct = (claimTaxBps / 100).toFixed(claimTaxBps % 100 === 0 ? 0 : 1);
  // A finisher who won NOTHING must never see the table pools — with the
  // personal prize row hidden at zero, the pool boxes alone read as "you won
  // 0.180 SOL" to a player who busted with no cash. Show an explicit zero
  // line instead; the pools only render for paid finishers, as context next
  // to their actual prize.
  const heroWonNothing = !isWinner && !isItm && payout.poker <= 0 && payout.sol <= 0;
  const showRewards =
    !!rewards && !heroWonNothing && (rewards.solPool > 0 || rewards.pokerPool > 0);
  const hasRefineActions =
    tournamentOver && rawPoker > 0 && !stillSettling && (!!onClaimRaw || !!onClaimAndStake || !!onLeaveToEarn);
  const runAction = async (which: 'claim' | 'stake', fn?: () => void | Promise<void>) => {
    if (!fn || busy) return;
    setBusy(which);
    try { await fn(); } finally { setBusy(null); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background: isWinner
            ? 'radial-gradient(ellipse at 50% 40%, rgba(255,198,58,0.24), rgba(7,9,11,0.95) 60%, #07090B)'
            : isItm
            ? 'radial-gradient(ellipse at 50% 40%, rgba(242,195,106,0.20), rgba(7,9,11,0.96) 65%, #07090B)'
            : 'radial-gradient(ellipse at 50% 40%, rgba(184,69,21,0.25), rgba(7,9,11,0.97) 70%, #07090B)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      />
      {isWinner && <ChipRain />}

      <div className="relative w-[560px] max-w-[calc(100vw-32px)] text-center px-6 py-10 fade-in">
        {/* Close (top-right) */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-2 right-2 w-8 h-8 rounded-sm hover:bg-bone/10 flex items-center justify-center text-boneDim/70 hover:text-bone transition"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>

        {/* Sunburst (winners only) */}
        {isWinner && (
          <svg
            className="absolute inset-0 m-auto pointer-events-none"
            width="560"
            height="560"
            viewBox="-100 -100 200 200"
            style={{ opacity: 0.35 }}
          >
            {Array.from({ length: 24 }).map((_, i) => {
              const a = (i / 24) * Math.PI * 2;
              return (
                <line
                  key={i}
                  x1={Math.cos(a) * 40}
                  y1={Math.sin(a) * 40}
                  x2={Math.cos(a) * 120}
                  y2={Math.sin(a) * 120}
                  stroke="#FFC63A"
                  strokeWidth={0.6}
                  className="sunburst-ray"
                  style={{ animationDelay: `${i * 0.05}s` }}
                />
              );
            })}
          </svg>
        )}

        <div className="relative">
          <div className="flex items-center justify-center gap-3 mb-3">
            <span className="h-px w-12" style={{ background: `linear-gradient(90deg, transparent, ${tone})` }} />
            <span className="font-mono text-[11px] tracking-[0.5em]" style={{ color: tone }}>{label}</span>
            <span className="h-px w-12" style={{ background: `linear-gradient(90deg, ${tone}, transparent)` }} />
          </div>
          <div
            className="font-display leading-none tabular-nums text-[96px]"
            style={{
              color: tone,
              textShadow: `0 0 40px ${tone}80, 0 2px 0 rgba(0,0,0,0.5)`,
            }}
          >
            {place}
            <span className="text-[48px]">{suffix}</span>
          </div>
          <div className="font-display text-bone/90 text-2xl italic leading-none mt-2">{playerName}</div>
          <span className="font-mono text-[10px] text-boneDim/60 tracking-[0.3em] block mt-1">
            {tierName.toUpperCase()} · SIT & GO
          </span>

          {heroWonNothing && (
            <div className="mt-5 mx-auto max-w-sm rounded-md border border-bone/10 bg-[#0B0D10]/80 px-3 py-2.5">
              <span className="font-mono text-[9px] tracking-[0.28em] text-boneDim/60 uppercase">
                No prize · +0.000 SOL · +0 $FP
              </span>
            </div>
          )}

          {showRewards && (
            <div className="mt-5 mx-auto grid max-w-sm grid-cols-2 gap-2">
              <div className="rounded-md border border-emerald-400/25 bg-[#0B0D10]/80 px-3 py-2.5">
                <span className="font-mono text-[8px] tracking-[0.24em] text-emerald-300/70 uppercase">SOL pool</span>
                <div className="mt-1 flex items-baseline justify-center gap-1">
                  <span className="font-display text-bone text-2xl leading-none tabular-nums">
                    {rewards!.solPool.toFixed(3)}
                  </span>
                  <span className="font-mono text-[8px] text-boneDim/60">SOL</span>
                </div>
              </div>
              <div className="rounded-md border border-amber/25 bg-[#0B0D10]/80 px-3 py-2.5">
                <span className="font-mono text-[8px] tracking-[0.24em] text-amber/75 uppercase">$FP player pool</span>
                <div className="mt-1 flex items-baseline justify-center gap-1">
                  <span className="font-display text-amber text-2xl leading-none tabular-nums">
                    {Math.round(rewards!.pokerPool).toLocaleString()}
                  </span>
                  <span className="font-mono text-[8px] text-boneDim/60">$FP</span>
                </div>
              </div>
            </div>
          )}

          {/* Prize-distribution progress: shown while the crank settles the
              SNG on L1 (undelegate -> distribute_prizes). The payout figures
              below update the moment the credit lands on-chain. */}
          {stillSettling && prizeLanded && (
            <div className="mt-6 mx-auto max-w-sm rounded-lg border border-emerald-400/60 bg-[#0B0D10]/95 px-4 py-3.5 shadow-[0_12px_44px_rgba(0,0,0,0.75)] backdrop-blur-md ring-1 ring-emerald-400/10">
              <div className="font-mono text-[11px] tracking-[0.24em] uppercase text-emerald-400 font-bold text-center" style={{ textShadow: '0 0 12px rgba(52,211,153,0.45)' }}>
                Prizes landed
              </div>
              <div className="font-mono text-[10px] text-bone/75 text-center mt-2 leading-relaxed">
                Your SOL is already claimable - the table is still tidying up behind the scenes.
              </div>
              <button
                className="mt-3 w-full rounded-md bg-emerald-500/90 hover:bg-emerald-400 py-2 font-mono text-[11px] font-bold tracking-[0.2em] uppercase text-black transition-colors"
                onClick={() => {
                  // Deep-link into the footer claim drawer (its confirm modal guards the spend).
                  const btn = Array.from(document.querySelectorAll('button')).find(
                    (b) => b.textContent?.includes('CLAIMABLE'),
                  ) as HTMLButtonElement | undefined;
                  onClose();
                  btn?.click();
                }}
              >
                Open claims
              </button>
            </div>
          )}
          {stillSettling && !prizeLanded && (
            <div className="mt-6 mx-auto max-w-sm rounded-lg border border-amber/70 bg-[#0B0D10]/95 px-4 py-3.5 shadow-[0_12px_44px_rgba(0,0,0,0.75)] backdrop-blur-md ring-1 ring-amber/10">
              <div className="flex items-center justify-center gap-2.5">
                <span className="w-4 h-4 border-2 border-amber/30 border-t-amber rounded-full animate-spin" />
                <span className="font-mono text-[11px] tracking-[0.24em] uppercase text-amber font-bold" style={{ textShadow: '0 0 12px rgba(244,165,42,0.5)' }}>
                  {distribution!.status === 'pending' ? 'Waiting for prizes' : 'Distributing prizes'}
                </span>
              </div>
              {typeof distribution!.current === 'number' &&
                typeof distribution!.total === 'number' &&
                distribution!.total > 0 && (
                  <div className="mt-3 h-1.5 rounded-full bg-amber/20 overflow-hidden">
                    <div
                      className="h-full bg-amber transition-all duration-500"
                      style={{ width: `${Math.min(100, (distribution!.current! / distribution!.total!) * 100)}%` }}
                    />
                  </div>
                )}
              <div className="font-mono text-[10px] text-bone/75 text-center mt-2.5 leading-relaxed">
                Your emissions are settling on-chain. The payout updates the moment it lands.
              </div>
            </div>
          )}

          {/* Prizes already claimable with nothing left to settle: the celebratory
              "Prizes landed" panel above keys off a RISE in claimable SOL after open,
              so prizes that land BEFORE the overlay opens (E1 fast-pay beats the
              overlay regularly) or after distribution completes would otherwise show
              no claim path at all (finding 2026-07-04). Quiet row, same deep-link. */}
          {/* Also covers landed-then-completed: the celebratory panel above dies with
              stillSettling when distribution finishes, so without this row a player who
              watched "Prizes landed" would see the claim path vanish (game 1 live). */}
          {tournamentOver && !stillSettling && (claimTotals?.sngSol ?? 0) > 0 && (
            <div className="mt-6 mx-auto max-w-sm rounded-md border border-emerald-400/30 bg-[#0B0D10]/80 px-4 py-2.5 flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] text-bone/70 tabular-nums text-left">
                {(claimTotals!.sngSol).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} SOL claimable in your bank
              </span>
              <button
                type="button"
                className="shrink-0 rounded-md border border-emerald-400/50 hover:bg-emerald-500/15 px-3 py-1.5 font-mono text-[10px] font-bold tracking-[0.18em] uppercase text-emerald-300 transition-colors"
                onClick={() => {
                  const btn = Array.from(document.querySelectorAll('button')).find(
                    (b) => b.textContent?.includes('CLAIMABLE'),
                  ) as HTMLButtonElement | undefined;
                  onClose();
                  btn?.click();
                }}
              >
                Open claims
              </button>
            </div>
          )}

          {/* Hero finished but the SNG is still running: distribution only
              happens when the tournament ends, so show the result + (if owed)
              the pending amount, claimable once the table finishes. */}
          {!tournamentOver && (
            <div className="mt-6 mx-auto max-w-sm rounded-lg border border-amber/40 bg-[#0B0D10]/95 px-4 py-3.5 shadow-[0_12px_44px_rgba(0,0,0,0.75)] backdrop-blur-md">
              <div className="font-mono text-[11px] tracking-[0.24em] uppercase text-amber/90 font-bold text-center">
                Game still in progress
              </div>
              <div className="font-mono text-[10px] text-bone/75 text-center mt-2.5 leading-relaxed">
                {(isWinner || isItm) && (payout.poker > 0 || payout.sol > 0) ? (
                  <>You&apos;ve locked {place}{suffix}. Prizes pay out when the table finishes. Your{' '}
                    <span className="text-amber font-bold">
                      {[
                        payout.sol > 0 ? `+${payout.sol.toFixed(3)} SOL` : null,
                        payout.poker > 0 ? `+${payout.poker.toLocaleString()} $FP` : null,
                      ].filter(Boolean).join(' + ')}
                    </span>{' '}
                    will be claimable then.</>
                ) : (
                  <>You finished {place}{suffix}. The table is still playing down to a winner.</>
                )}
              </div>
            </div>
          )}

          {(isWinner || isItm) && tournamentOver && (
            <div className="flex items-center justify-center gap-8 mt-8 pt-5 border-t border-white/[0.08]">
              {payout.poker > 0 && (
                <div className="text-center">
                  <span className="font-mono text-[9px] text-boneDim/60 tracking-[0.28em] inline-flex items-center gap-1">
                    <img src="/brand/app-icon.png" alt="$FP" width={10} height={10} className="rounded-full opacity-90" />
                    $FP EARNED
                  </span>
                  <div className="flex items-baseline justify-center gap-1 mt-1">
                    <span
                      className="font-display text-amber text-4xl leading-none tabular-nums"
                      style={{ textShadow: '0 0 20px rgba(255,198,58,0.4)' }}
                    >
                      +{payout.poker.toLocaleString()}
                    </span>
                  </div>
                </div>
              )}
              {payout.sol > 0 && (
                <>
                  <div className="h-12 w-px bg-gold/20" />
                  <div className="text-center">
                    <span className="font-mono text-[9px] text-boneDim/60 tracking-[0.28em] inline-flex items-center gap-1">
                      <img src="/tokens/sol.svg" alt="SOL" width={10} height={10} className="rounded-full opacity-90" />
                      SOL PRIZE
                    </span>
                    <div className="flex items-baseline justify-center gap-1 mt-1">
                      <span className="font-display text-bone text-4xl leading-none tabular-nums">
                        +{payout.sol.toFixed(3)}
                      </span>
                    </div>
                  </div>
                </>
              )}
              <div className="h-12 w-px bg-gold/20" />
              <div className="text-center">
                <span className="font-mono text-[9px] text-boneDim/60 tracking-[0.28em]">XP EARNED</span>
                <div className="flex items-baseline justify-center gap-1 mt-1">
                  <span className="font-display text-bone text-4xl leading-none tabular-nums">
                    +{defaultXp}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* SnG Duels: bounty breakdown. Rendered for EVERY finish (bounty pays out of the money
              too - that's the mode). Mobile-first: wraps to a 2x2 grid on phones. */}
          {bounty && (
            <div className="mt-6 mx-auto max-w-sm rounded-xl border border-amber/25 bg-black/60 px-4 py-3.5 backdrop-blur-md" data-format="bounty">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] tracking-[0.24em] uppercase text-amber font-bold">Bounty Bank</span>
                <span className="font-mono text-[9px] tracking-[0.18em] uppercase text-bone/45">Duel mode</span>
              </div>
              {/* Tightened 2026-07-03 (user crop): text-2xl x4 columns overflowed a max-w-sm
                  card - "+0.000" crashed into "100%". Uniform text-xl, trailing-zero-trimmed
                  SOL, nowrap cells. */}
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-2 gap-y-3 text-center">
                <div className="min-w-0">
                  <div className="whitespace-nowrap font-display text-xl leading-none tabular-nums text-amber">{formatPoints(bounty.koCount)}</div>
                  <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.2em] text-bone/45">{bounty.shield ? 'Points held' : 'Knockouts'}</div>
                </div>
                <div className="min-w-0">
                  <div className="inline-flex max-w-full items-baseline gap-1 whitespace-nowrap font-display text-xl leading-none tabular-nums text-gold">
                    +{Math.round(bounty.fpBounty).toLocaleString()}
                    <img src="/brand/app-icon.png" alt="$FP" width={11} height={11} className="rounded-full opacity-90" />
                  </div>
                  <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.2em] text-bone/45">$FP banked</div>
                </div>
                <div className="min-w-0">
                  <div className="inline-flex max-w-full items-baseline gap-1 whitespace-nowrap font-display text-xl leading-none tabular-nums text-emerald-400">
                    +{(bounty.solBounty.toFixed(3).replace(/\.?0+$/, '') || '0')}
                    <img src="/tokens/sol.svg" alt="SOL" width={11} height={11} className="rounded-full opacity-90" />
                  </div>
                  <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.2em] text-bone/45">SOL banked</div>
                </div>
                <div className="min-w-0">
                  <div className="whitespace-nowrap font-display text-xl leading-none tabular-nums text-gold">{bounty.maturityPct}%</div>
                  <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.2em] text-bone/45">Maturity</div>
                </div>
              </div>
              {bounty.topHunters.length > 0 && (
                <div className="mt-3 border-t border-white/[0.08] pt-2.5">
                  <div className="font-mono text-[8px] uppercase tracking-[0.2em] text-bone/40 mb-1.5">Top hunters</div>
                  <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
                    {bounty.topHunters.slice(0, 3).map((h) => (
                      <span key={h.name} className="font-mono text-[10px] text-bone/75">
                        {h.name} <span className="text-amber tabular-nums">&times;{formatPoints(h.ko)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {bounty.koCount > 0 && payout.sol <= 0 && payout.poker <= 0 && (
                <div className="mt-2.5 text-center font-mono text-[9px] text-bone/55 leading-relaxed">
                  {bounty.shield
                    ? 'Out of the money, but your points still pay.'
                    : 'Out of the money, but your bounties still pay.'}
                </div>
              )}
            </div>
          )}

          {/* Refine actions for the raw $FP earned at this table. Three paths:
              leave-to-earn (no tx), claim now (refine -> liquid $FP, taxPct
              burn), claim + stake (refine then burn into stake for rake yield). */}
          {hasRefineActions && (
            <div className="mt-7 mx-auto max-w-md rounded-md border border-white/[0.08] bg-inkB/40 p-4 text-left">
              <div className="flex items-center justify-between mb-3">
                <span className="font-mono text-[9px] tracking-[0.24em] uppercase text-boneDim/60">
                  Your raw $FP
                </span>
                <span className="font-mono text-[10px] text-amber tabular-nums inline-flex items-center gap-1">
                  <img src="/brand/app-icon.png" alt="$FP" width={10} height={10} className="rounded-full opacity-90" />
                  {rawPoker.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              </div>
              <div className="grid gap-2">
                {onClaimRaw && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => runAction('claim', onClaimRaw)}
                    className="w-full px-4 py-2.5 btn-orange rounded-md font-mono text-[11px] tracking-[0.18em] font-bold disabled:opacity-50 flex items-center justify-between"
                  >
                    <span>{busy === 'claim' ? 'CLAIMING…' : 'CLAIM NOW'}</span>
                    <span className="font-normal opacity-90 normal-case tracking-normal">
                      +{netAfterTax.toLocaleString(undefined, { maximumFractionDigits: 2 })} $FP
                    </span>
                  </button>
                )}
                {onClaimAndStake && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => runAction('stake', onClaimAndStake)}
                    className="w-full px-4 py-2.5 rounded-md border border-amber/40 bg-amber/10 hover:bg-amber/20 font-mono text-[11px] tracking-[0.18em] text-amber disabled:opacity-50 flex items-center justify-between transition"
                  >
                    <span>{busy === 'stake' ? 'STAKING…' : 'CLAIM + STAKE'}</span>
                    <span className="font-normal opacity-80 normal-case tracking-normal">earns rake yield</span>
                  </button>
                )}
                {onLeaveToEarn && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={onLeaveToEarn}
                    className="w-full px-4 py-2.5 rounded-md border border-bone/15 hover:border-bone/30 bg-inkB/50 font-mono text-[11px] tracking-[0.18em] text-bone/80 hover:text-bone disabled:opacity-50 flex items-center justify-between transition"
                  >
                    <span>LEAVE TO EARN</span>
                    <span className="font-normal opacity-70 normal-case tracking-normal">keep raw, no tax</span>
                  </button>
                )}
              </div>
              <div className="font-mono text-[9px] text-boneDim/55 mt-3 leading-relaxed">
                Claiming refines raw $FP to liquid $FP with a {taxPct}% burn that
                redistributes to everyone still holding raw. Leave it to skip the
                tax and keep earning from other refiners.
              </div>
            </div>
          )}

          {/* No standalone LOBBY button: the primary CTA (FIND NEW TABLE /
              PLAY AGAIN) already routes to the lobby, so a separate LOBBY
              button was the same destination twice. */}
          <div className="flex gap-3 mt-8 justify-center flex-wrap">
            {(isWinner || isItm) && onShare && (
              <button
                type="button"
                onClick={onShare}
                className="px-6 py-2.5 rounded-md border border-bone/15 hover:border-bone/30 bg-inkB/50 font-mono text-[11px] tracking-[0.24em] text-bone/80 hover:text-bone transition"
              >
                SHARE
              </button>
            )}
            <button
              type="button"
              onClick={onPlayAgain || onClose}
              className="px-6 py-2.5 btn-orange rounded-md font-mono text-[11px] tracking-[0.24em] font-bold"
            >
              {isWinner ? 'PLAY AGAIN' : 'FIND NEW TABLE'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
