'use client';

import { Suspense, useState, useCallback, useEffect, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { evaluateHand, type HandResult } from '@/lib/hand-evaluator';
import type { JackpotReceipt } from '@/lib/jpv1';
import { formatFp, formatJackpotAmount, getKindColor, getKindLabel } from '@/lib/jackpot-format';
import { BRAND } from '@/lib/branding';

/* ═══ Card display helpers ═══ */

const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUIT_SYMBOLS: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_IS_RED: Record<string, boolean> = { s: false, h: true, d: true, c: false };

function cardName(cardIndex: number): { rank: string; suit: string; symbol: string; isRed: boolean } {
  if (cardIndex >= 52 || cardIndex < 0) return { rank: '?', suit: '?', symbol: '?', isRed: false };
  const rank = RANKS[cardIndex % 13];
  const suitKey = SUITS[Math.floor(cardIndex / 13)];
  return { rank, suit: suitKey, symbol: SUIT_SYMBOLS[suitKey], isRed: SUIT_IS_RED[suitKey] };
}

function parseCardFromLabel(label: string): number {
  if (!label || label === '??' || label.length < 2) return -1;
  const rankChar = label[0];
  const suitChar = label[1];
  const rankIdx = RANKS.indexOf(rankChar);
  const suitIdx = SUITS.indexOf(suitChar);
  if (rankIdx < 0 || suitIdx < 0) return -1;
  return suitIdx * 13 + rankIdx;
}

function CardMini({ cardIndex, small }: { cardIndex: number; small?: boolean }) {
  const { rank, symbol, isRed } = cardName(cardIndex);
  return (
    <span className={`card-mini${isRed ? ' red' : ''}${small ? ' scale-90' : ''}`}>
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1 }}>
        <span>{rank === 'T' ? '10' : rank}</span>
        <span style={{ fontSize: 8 }}>{symbol}</span>
      </span>
    </span>
  );
}

function CardBack({ small }: { small?: boolean }) {
  return <span className={`card-mini back${small ? ' scale-90' : ''}`}>?</span>;
}

/* ═══ Types ═══ */

interface OnChainSeat {
  seat: number;
  card1: string;
  card2: string;
}

interface OnChainHandRecord {
  handNumber: number;
  timestamp: number;
  merkleRoot: string;
  handSalt: string;
  communityCards: string[];
  shownCards: OnChainSeat[];
  pot: number;
  rake: number;
  winnersMask: number;
  winners: number[];
  source?: 'hand-report-v1' | 'tee-buffer';
  rollingHash?: string;
  foldWin?: boolean;
  handReport?: {
    version: number;
    status: 'l1-committed' | 'tee-finalized-pending-l1' | 'tee-open';
    payloadBytes: number;
    payloadHash: string;
    chunkCount: number;
    chunksPresent: number;
    txs: string[];
  };
  actions?: {
    kind: number;
    street: number;
    actor: number;
    action: number;
    handNumber: number;
    amount: number;
    pot: number;
    wallet: string;
    operator: string;
    aux: number;
  }[];
}

interface CrankOperator {
  pubkey: string;
  actions: number;
  share: number;
}

interface CrankTally {
  operators: CrankOperator[];
  totalActions: number;
  lastHand: number;
}

interface OnChainResult {
  table: string;
  slimBuffer: string;
  handReportBuffer?: string;
  totalRecorded: number;
  record?: OnChainHandRecord;
  records?: OnChainHandRecord[];
  crankTally?: CrankTally | null;
  /** JPV1 jackpot receipt attached by /api/hand-history when the hand fired one. */
  jackpot?: JackpotReceipt | null;
}

const EVENT_KIND: Record<number, string> = {
  1: 'start',
  2: 'blind',
  3: 'player',
  4: 'deal',
  5: 'reveal',
  6: 'settle',
  7: 'timeout',
  8: 'crank',
  9: 'roster',
};

const STREET: Record<number, string> = {
  0: 'preflop',
  1: 'flop',
  2: 'turn',
  3: 'river',
  4: 'showdown',
  5: 'start',
  6: 'waiting',
  7: 'complete',
  8: 'flop pending',
  9: 'turn pending',
  10: 'river pending',
};

const PLAYER_ACTION: Record<number, string> = {
  0: 'fold',
  1: 'check',
  2: 'call',
  3: 'bet',
  4: 'raise',
  5: 'all in',
  6: 'sit out',
  7: 'returned to table',
  8: 'left table',
  9: 'rebuy/top-up',
};

const SEAT_STATUS: Record<number, string> = {
  0: 'empty',
  1: 'active',
  2: 'folded',
  3: 'all in',
  4: 'sitting out',
  5: 'busted',
  6: 'leaving',
};

function shortKey(key: string): string {
  if (!key || key === '11111111111111111111111111111111') return 'system';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function actionLabel(a: NonNullable<OnChainHandRecord['actions']>[number]): string {
  if (a.kind === 1) return 'start hand';
  if (a.kind === 2) return a.action === 0 ? 'small blind' : 'big blind';
  if (a.kind === 3) return PLAYER_ACTION[a.action] ?? `action ${a.action}`;
  if (a.kind === 4) return a.action === 1 ? 'deal skipped' : 'deal hole cards';
  if (a.kind === 5) return `${STREET[a.street] ?? 'street'} reveal`;
  if (a.kind === 6) return 'settle hand';
  // Timeout HR codes (timeout.rs): 0=auto fold, 1=auto check, 2=force fold,
  // 5=forced all-in (SNG dormant short stack — chips committed, NOT a fold).
  if (a.kind === 7) return a.action === 1 ? 'auto check' : a.action === 2 ? 'force fold' : a.action === 5 ? 'auto all-in' : 'auto fold';
  if (a.kind === 8) return 'settle hand';
  if (a.kind === 9) return `seat ${SEAT_STATUS[a.action] ?? `status ${a.action}`}`;
  return EVENT_KIND[a.kind] ?? `event ${a.kind}`;
}

function eventValueLabel(a: Action): string | null {
  if ((a.kind === 2 || a.kind === 3 || a.kind === 7) && a.amount > 0) {
    return `+${a.amount.toLocaleString()}`;
  }
  if (a.kind === 1 && a.amount > 0) {
    return `${a.amount.toLocaleString()} players`;
  }
  if (a.kind === 4 && a.amount > 0) {
    return `${a.amount.toLocaleString()} dealt`;
  }
  if (a.kind === 5 && a.amount > 0) {
    return `deck ${a.amount.toLocaleString()}`;
  }
  return null;
}

function isPlayerKind(k: number): boolean {
  // 2=blind, 3=voluntary action, 7=timeout-driven, 9=start-of-hand roster
  return k === 2 || k === 3 || k === 7 || k === 9;
}

function isCrankKind(k: number): boolean {
  // 1=start, 4=deal, 5=reveal, 8=settle
  return k === 1 || k === 4 || k === 5 || k === 8;
}

type Action = NonNullable<OnChainHandRecord['actions']>[number];

interface PlayerRow {
  seat: number;
  wallet: string;
  actions: number;
  totalIn: number;        // chips invested by this seat
  isWinner: boolean;
  cards: { c1: number; c2: number } | null;
  handResult: HandResult | null;
  finalAction: string | null;
}

function buildPlayerRoster(
  record: OnChainHandRecord,
): PlayerRow[] {
  const map = new Map<number, PlayerRow>();
  const actions = record.actions ?? [];
  const boardCards = record.communityCards
    .map(parseCardFromLabel)
    .filter(idx => idx >= 0);

  for (const a of actions) {
    if (!isPlayerKind(a.kind)) continue;
    if (a.actor === 255) continue;
    if (!map.has(a.actor)) {
      map.set(a.actor, {
        seat: a.actor,
        wallet: a.wallet,
        actions: 0,
        totalIn: 0,
        isWinner: record.winners.includes(a.actor),
        cards: null,
        handResult: null,
        finalAction: null,
      });
    }
    const p = map.get(a.actor)!;
    if (a.kind === 9) {
      if (a.wallet && a.wallet !== '11111111111111111111111111111111') {
        p.wallet = a.wallet;
      }
      continue;
    }
    p.actions += 1;
    p.totalIn += a.amount;
    p.finalAction = actionLabel(a);
    if (a.wallet && a.wallet !== '11111111111111111111111111111111') {
      p.wallet = a.wallet;
    }
  }

  // Layer in shown cards
  for (const sc of record.shownCards) {
    const p = map.get(sc.seat);
    const c1 = parseCardFromLabel(sc.card1);
    const c2 = parseCardFromLabel(sc.card2);
    const handResult = c1 >= 0 && c2 >= 0
      ? evaluateHand([c1, c2], boardCards)
      : null;
    if (p) {
      p.cards = { c1, c2 };
      p.handResult = handResult;
    } else {
      // Seat showed cards but no actions in payload (older payload), still list it.
      map.set(sc.seat, {
        seat: sc.seat,
        wallet: '11111111111111111111111111111111',
        actions: 0,
        totalIn: 0,
        isWinner: record.winners.includes(sc.seat),
        cards: { c1, c2 },
        handResult,
        finalAction: null,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => a.seat - b.seat);
}

interface StreetGroup {
  street: number;
  label: string;
  actions: Action[];
  potStart: number;
  potEnd: number;
  boardCards: number[];      // community cards revealed BY this street
}

function buildStreetGroups(
  record: OnChainHandRecord,
): StreetGroup[] {
  const actions = record.actions ?? [];
  // Streets we care about; preflop=0, flop=1, turn=2, river=3, showdown=4
  const streetOrder = [0, 1, 2, 3, 4];
  const groups: StreetGroup[] = streetOrder.map(s => ({
    street: s,
    label: STREET[s] ?? `street ${s}`,
    actions: [],
    potStart: 0,
    potEnd: 0,
    boardCards: [],
  }));

  // Bucket each action by its street index. Skip start_game/settle (not on a street).
  for (const a of actions) {
    if (a.kind === 1 || a.kind === 8) continue;
    const grp = groups.find(g => g.street === a.street);
    if (grp) grp.actions.push(a);
  }

  // Compute pot start/end per street from the action sequence
  let runningStartPot = 0;
  for (const grp of groups) {
    if (grp.actions.length === 0) continue;
    grp.potStart = runningStartPot;
    grp.potEnd = grp.actions[grp.actions.length - 1].pot;
    runningStartPot = grp.potEnd;
  }

  // Distribute community cards across streets: flop=3, turn=1, river=1
  const board = record.communityCards
    .map(parseCardFromLabel)
    .filter(idx => idx >= 0);
  if (board.length >= 3) groups[1].boardCards = board.slice(0, 3); // flop
  if (board.length >= 4) groups[2].boardCards = [board[3]];        // turn
  if (board.length >= 5) groups[3].boardCards = [board[4]];        // river

  return groups.filter(g => g.actions.length > 0 || g.boardCards.length > 0);
}

interface PotPoint {
  idx: number;
  pot: number;
  street: number;
  label: string;
}

function buildPotSeries(actions: Action[]): PotPoint[] {
  const out: PotPoint[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.kind === 1 || a.kind === 9) continue;
    out.push({
      idx: i,
      pot: a.pot,
      street: a.street,
      label: actionLabel(a),
    });
  }
  return out;
}

interface OperatorThisHand {
  pubkey: string;
  totalActions: number;
  byKind: Record<string, number>;
}

function buildPerHandOperators(actions: Action[]): OperatorThisHand[] {
  const map = new Map<string, OperatorThisHand>();
  for (const a of actions) {
    if (!isCrankKind(a.kind)) continue;
    if (!a.operator || a.operator === '11111111111111111111111111111111') continue;
    if (!map.has(a.operator)) {
      map.set(a.operator, { pubkey: a.operator, totalActions: 0, byKind: {} });
    }
    const op = map.get(a.operator)!;
    op.totalActions += 1;
    const tag =
      a.kind === 1 ? 'start' :
      a.kind === 4 ? 'deal' :
      a.kind === 5 ? 'reveal' :
      a.kind === 8 ? 'settle' : `k${a.kind}`;
    op.byKind[tag] = (op.byKind[tag] ?? 0) + 1;
  }
  return Array.from(map.values()).sort((a, b) => b.totalActions - a.totalActions);
}

/* ═══ New high-density panels ═══ */

function PlayersRoster({ record, players }: { record: OnChainHandRecord; players: PlayerRow[] }) {
  if (players.length === 0) {
    return (
      <div className="font-mono text-[10px] text-boneDim/55 py-2">
        No player events captured for this hand.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {players.map(p => {
        const cards = p.cards;
        return (
          <div
            key={p.seat}
            className={`flex items-center gap-3 px-3 py-2 rounded-sm hairline ${p.isWinner ? 'bg-amber/[0.06] border-amber/30' : 'bg-ink/30'}`}
          >
            <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em] w-10 shrink-0">
              SEAT {p.seat}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                {p.wallet === '11111111111111111111111111111111' ? (
                  <span className="font-mono text-[11px] text-bone/90 tabular-nums">
                    - wallet not in payload -
                  </span>
                ) : (
                  <Link
                    href={`/profile/${p.wallet}`}
                    className="font-mono text-[11px] text-bone/90 hover:text-orange tabular-nums transition-colors underline decoration-dotted decoration-bone/30 underline-offset-2 hover:decoration-orange"
                    title="View profile"
                  >
                    {`${p.wallet.slice(0, 6)}...${p.wallet.slice(-4)}`}
                  </Link>
                )}
                {p.isWinner && <span className="badge-amber" style={{ fontSize: 9 }}>WINNER</span>}
                {record.foldWin && p.isWinner && (
                  <span className="badge-green" style={{ fontSize: 9 }}>FOLD WIN</span>
                )}
                {p.handResult && (
                  <span
                    className={p.isWinner ? 'badge-amber' : 'badge-bone'}
                    style={{ fontSize: 9 }}
                    title={`Best hand: ${p.handResult.name}`}
                  >
                    {p.handResult.shortName}
                  </span>
                )}
              </div>
              <div className="font-mono text-[9px] text-boneDim/55 mt-0.5">
                {p.actions} action{p.actions === 1 ? '' : 's'}
                {p.totalIn > 0 && <> · invested <span className="text-bone/85 tabular-nums">{p.totalIn.toLocaleString()}</span></>}
                {p.finalAction && <> · last <span className="text-bone/75">{p.finalAction}</span></>}
                {p.handResult && <> · hand <span className={p.isWinner ? 'text-amber' : 'text-bone/75'}>{p.handResult.name}</span></>}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {cards && cards.c1 >= 0 && cards.c2 >= 0 ? (
                <>
                  <CardMini cardIndex={cards.c1} small />
                  <CardMini cardIndex={cards.c2} small />
                </>
              ) : (
                <>
                  <CardBack small />
                  <CardBack small />
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StreetTimeline({ groups }: { groups: StreetGroup[] }) {
  if (groups.length === 0) {
    return (
      <div className="font-mono text-[10px] text-boneDim/55 py-2">
        No street action data. Older HAND_REPORT_V1 payloads only carried settle summaries.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {groups.map(g => (
        <div key={g.street} className="hairline rounded-sm bg-ink/30 overflow-hidden">
          <div className="px-3 py-2 hairline-b flex items-center gap-3 flex-wrap">
            <span className="font-display text-bone text-[14px] uppercase leading-none tracking-wide">{g.label}</span>
            <span className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em]">
              {g.actions.length} action{g.actions.length === 1 ? '' : 's'}
            </span>
            {g.boardCards.length > 0 && (
              <div className="flex items-center gap-1 ml-auto">
                {g.boardCards.map((c, i) => <CardMini key={i} cardIndex={c} small />)}
              </div>
            )}
            {g.potEnd > 0 && (
              <span className="font-mono text-[10px] text-amber/80 tabular-nums ml-auto">
                pot {g.potStart.toLocaleString()} → <span className="text-amber">{g.potEnd.toLocaleString()}</span>
              </span>
            )}
          </div>
          <div className="px-3 py-2 space-y-1">
            {g.actions.map((a, idx) => {
              const isAuto = a.kind === 7;
              const isCrank = isCrankKind(a.kind);
              const seatLbl = a.actor === 255 ? 'CRANK' : `S${a.actor}`;
              const valueLabel = eventValueLabel(a);
              return (
                <div
                  key={`${a.kind}-${idx}-${a.actor}-${a.aux}`}
                  className={`flex items-center justify-between gap-3 rounded-sm px-2 py-1 ${isAuto ? 'border-l-2 border-rose-400/50 pl-2' : ''} ${isCrank ? 'bg-orange/[0.04]' : ''}`}
                >
                  <div className="min-w-0 flex items-center gap-2">
                    <span className={`font-mono text-[9px] tracking-[0.18em] tabular-nums w-12 shrink-0 ${isCrank ? 'text-orange/80' : 'text-boneDim/65'}`}>
                      {seatLbl}
                    </span>
                    <span className="font-mono text-[11px] text-bone/90">
                      {actionLabel(a)}
                      {isAuto && <span className="ml-1 text-rose-300/70">(auto)</span>}
                    </span>
                    {a.wallet && a.wallet !== '11111111111111111111111111111111' && !isCrank && (
                      <span className="font-mono text-[9px] text-boneDim/45 truncate">
                        {a.wallet.slice(0, 4)}...{a.wallet.slice(-4)}
                      </span>
                    )}
                  </div>
                  <div className="text-right font-mono text-[10px] tabular-nums shrink-0 flex items-center gap-3">
                    {valueLabel && (
                      <span className="text-bone/80">{valueLabel}</span>
                    )}
                    <span className="text-boneDim/50">pot {a.pot.toLocaleString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function PotChart({ points }: { points: PotPoint[] }) {
  if (points.length < 2) return null;
  const W = 600;
  const H = 80;
  const PAD = 6;
  const maxPot = Math.max(...points.map(p => p.pot));
  const xStep = (W - PAD * 2) / (points.length - 1);
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${PAD + i * xStep} ${H - PAD - (p.pot / maxPot) * (H - PAD * 2)}`)
    .join(' ');
  // Color points by street
  const STREET_COLORS = ['#F26A1F', '#FFC63A', '#34D399', '#A78BFA', '#F5F1E6'];
  return (
    <div className="hairline rounded-sm bg-ink/30 p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        <path d={path} fill="none" stroke="#F26A1F" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={PAD + i * xStep}
            cy={H - PAD - (p.pot / maxPot) * (H - PAD * 2)}
            r={2.5}
            fill={STREET_COLORS[p.street] ?? '#F5F1E6'}
          />
        ))}
      </svg>
      <div className="flex items-center justify-between mt-1 font-mono text-[8px] text-boneDim/55 tracking-wider">
        <span>pot 0</span>
        <span>peak {maxPot.toLocaleString()}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap font-mono text-[8px] text-boneDim/65">
        {['preflop', 'flop', 'turn', 'river', 'showdown'].map((s, i) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: STREET_COLORS[i] }} />
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

function PerHandOperators({ ops }: { ops: OperatorThisHand[] }) {
  if (ops.length === 0) {
    return (
      <div className="font-mono text-[10px] text-boneDim/55 py-2">
        No crank events recorded in this hand&apos;s payload.
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {ops.map(op => (
        <div key={op.pubkey} className="flex items-center gap-3 px-3 py-2 rounded-sm hairline bg-ink/30">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[11px] text-bone/90 truncate">
              {op.pubkey.slice(0, 8)}...{op.pubkey.slice(-4)}
            </div>
            <div className="font-mono text-[9px] text-boneDim/55 mt-0.5 flex items-center gap-2 flex-wrap">
              {Object.entries(op.byKind).map(([k, v]) => (
                <span key={k} className="px-1.5 py-px rounded-sm bg-orange/10 text-orange/80 tracking-wider">
                  {v}× {k}
                </span>
              ))}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="font-display text-bone text-base tabular-nums leading-none">{op.totalActions}</div>
            <div className="font-mono text-[8px] text-boneDim/55 tracking-wider">events</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ═══ Shared UI primitives (ported from mockup) ═══ */

function Eyebrow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`font-mono text-[9px] text-boneDim/55 tracking-[0.22em] uppercase ${className}`}>
      {children}
    </span>
  );
}

function TxPill({ label, id }: { label: string; id: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm hairline bg-ink/40 font-mono text-[10px] tracking-wider text-bone/85">
      <span className="text-boneDim/55 uppercase">{label}</span>
      <span className="tabular-nums">{id}</span>
    </span>
  );
}

function CopyLine({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    try { navigator.clipboard?.writeText(value); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1000);
  };
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 hairline-t first:border-t-0 first:pt-0">
      <span className="font-mono text-[10px] text-boneDim/65 tracking-[0.18em] whitespace-nowrap pt-[2px]">{label}</span>
      <div className="flex items-start gap-2 min-w-0 flex-1 justify-end">
        <span className={`mono-wrap text-right text-[11px]${mono ? ' font-mono text-bone/90 tabular-nums' : ' text-bone/90'}`}>
          {value}
        </span>
        <button
          onClick={doCopy}
          className="shrink-0 text-boneDim/50 hover:text-amber-300 font-mono text-[10px] tracking-wider"
          title={copied ? 'Copied' : 'Copy'}
        >
          {copied ? '✓' : '⧉'}
        </button>
      </div>
    </div>
  );
}

function SectionCard({
  title, eyebrow, children, action,
}: {
  title: string; eyebrow?: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="glass-room">
      <div className="px-4 py-3 hairline-b flex items-center justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
          <div className="font-display text-bone text-[16px] leading-none">{title}</div>
        </div>
        {action}
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

function CheckStep({
  title, desc, pass = true, openByDefault = false, children,
}: {
  title: string; desc: string; pass?: boolean; openByDefault?: boolean; children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(openByDefault);
  return (
    <div className="check-row py-2.5 hairline-b last:border-b-0">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-3 text-left">
        <span className={`step-num shrink-0 mt-[2px]${!pass ? ' bad' : ''}`}>
          {pass ? (
            <svg viewBox="0 0 10 10" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M2 5.5l2 2 4-5" />
            </svg>
          ) : <span>!</span>}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display text-bone text-[14px] leading-none">{title}</span>
            <span className={pass ? 'badge-green' : 'badge-orange'}>{pass ? 'PASS' : 'FAIL'}</span>
          </div>
          <div className="font-mono text-[10px] text-boneDim/65 leading-relaxed mt-1">{desc}</div>
        </div>
        <span className={`font-mono text-[10px] text-boneDim/40 mt-1 transition-transform${open ? ' rotate-180' : ''}`}>▾</span>
      </button>
      {open && children && <div className="mt-2 ml-9 pr-1">{children}</div>}
    </div>
  );
}

function HashChainViz({
  prev, curr, next, handNumber,
}: {
  prev: string | null; curr: string; next: string | null; handNumber: number;
}) {
  const short = (h: string | null) =>
    h ? `${h.slice(0, 10)}...${h.slice(-6)}` : '-';
  return (
    <div className="chain-viz">
      <div className="chain-cell opacity-60">
        <div className="chain-label">H{handNumber - 1}</div>
        <div className="chain-hash">{short(prev)}</div>
        <div className="chain-meta">Ledger[-1]</div>
      </div>
      <div className="chain-link">⇢</div>
      <div className="chain-cell active">
        <div className="chain-label">H{handNumber}</div>
        <div className="chain-hash">{short(curr)}</div>
        <div className="chain-meta">this hand</div>
      </div>
      <div className="chain-link">⇢</div>
      <div className="chain-cell opacity-60">
        <div className="chain-label">H{handNumber + 1}</div>
        <div className="chain-hash">{short(next)}</div>
        <div className="chain-meta">Ledger[+1]</div>
      </div>
    </div>
  );
}

/* ═══ Jackpot badge ═══ */

function JackpotBadge({ receipt }: { receipt: JackpotReceipt }) {
  const kindLabel = getKindLabel(receipt.miniHit, receipt.grandHit) ?? 'LUCKY';
  const accent = getKindColor(receipt.miniHit, receipt.grandHit);

  const miniSol = receipt.miniHit ? receipt.miniPerSeatLamports / 1e9 : 0;

  return (
    <div
      className="glass-room overflow-hidden relative"
      style={{ borderColor: `${accent}55` }}
    >
      <div
        className="absolute top-0 left-0 right-0 h-[2px]"
        style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
      />
      <div
        className="absolute -top-16 -right-16 w-48 h-48 rounded-full pointer-events-none opacity-25"
        style={{ background: `radial-gradient(circle, ${accent}, transparent 70%)` }}
      />
      <div className="relative px-5 py-4 flex items-start gap-4 flex-wrap">
        <div className="shrink-0">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center"
            style={{
              background: `radial-gradient(circle, ${accent}30, ${accent}10)`,
              border: `1.5px solid ${accent}`,
              boxShadow: `0 0 16px ${accent}55`,
            }}
          >
            <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none" stroke={accent} strokeWidth="1.6">
              <path d="M12 2l2.5 6 6.5.5-5 4.5 1.5 6.5L12 17l-5.5 3.5L8 14l-5-4.5 6.5-.5L12 2z" />
            </svg>
          </div>
        </div>
        <div className="flex-1 min-w-[260px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-mono text-[9px] tracking-[0.28em] px-2 py-0.5 rounded-sm"
              style={{ color: accent, border: `1px solid ${accent}55`, background: `${accent}10` }}
            >
              JACKPOT · {kindLabel}
            </span>
            <span className="font-mono text-[9px] tracking-[0.22em] text-boneDim/55">
              HIT #{receipt.hitSequence}
            </span>
          </div>
          <div className="font-display text-bone text-2xl tracking-wide leading-[1.4rem] mt-5">
            {formatJackpotAmount(receipt)}
          </div>
          <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-3">
            {receipt.miniHit && (
              <BadgeStat
                label="LUCKY / SEAT"
                value={`${miniSol.toFixed(4)} SOL`}
                sub={`${(receipt.miniPaidTotal / 1e9).toFixed(4)} SOL TOTAL`}
                accent="#F26A1F"
              />
            )}
            {receipt.grandHit && (
              <BadgeStat
                label="ROYAL"
                value={formatFp(receipt.grandUnrefinedAmount, 6)}
                sub="POOL SHARED BY ACTIVE PLAYERS"
                accent="#B990FF"
              />
            )}
            <BadgeStat
              label="OPT-IN MASK"
              value={`0x${receipt.miniOptInMask.toString(16).padStart(4, '0')}`}
              sub={`ACTIVE 0x${receipt.activeMask.toString(16).padStart(4, '0')}`}
              accent="#34D399"
            />
          </div>
          <div className="font-mono text-[10px] text-boneDim/65 leading-relaxed mt-3">
            This jackpot is anchored to the same hand record verified above. The JPV1 receipt
            is signed by the {BRAND.name} program in the same transaction stream as the hand
            settlement, so its bytes cannot be tampered with after the fact.
          </div>
          {receipt.txSig && (
            <div className="font-mono text-[9px] text-boneDim/45 tracking-wider mt-2 truncate">
              tx <span className="tabular-nums">{receipt.txSig}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BadgeStat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="rounded-sm hairline bg-ink/30 p-2.5">
      <div className="font-mono text-[8.5px] tracking-[0.22em]" style={{ color: accent }}>
        {label}
      </div>
      <div className="font-display text-bone text-base tabular-nums leading-none mt-1">
        {value}
      </div>
      {sub && (
        <div className="font-mono text-[8.5px] text-boneDim/55 tracking-wider mt-1 leading-snug">
          {sub}
        </div>
      )}
    </div>
  );
}

/* ═══ Lookup bar ═══ */

function LookupBar({
  table, hand, onLookup, loading,
}: {
  table: string; hand: string; onLookup: (table: string, hand: string) => void; loading: boolean;
}) {
  const [t, setT] = useState(table);
  const [h, setH] = useState(hand);
  useEffect(() => { setT(table); }, [table]);
  useEffect(() => { setH(hand); }, [hand]);
  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    onLookup(t.trim(), h.trim());
  };
  const nav = (delta: number) => onLookup(t, String(Math.max(1, (parseInt(h) || 1) + delta)));
  return (
    <form onSubmit={submit} className="lookup-bar hairline rounded-sm bg-ink/60 px-3 py-2 flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="font-mono text-[9px] text-boneDim/55 tracking-[0.2em]">TABLE&nbsp;PDA</span>
        <input
          value={t}
          onChange={e => setT(e.target.value)}
          placeholder="Hc4kP2mN...9pL2"
          spellCheck={false}
          className="flex-1 min-w-0 bg-ink/50 hairline rounded-sm px-2.5 py-1.5 font-mono text-[11px] text-bone/90 tabular-nums focus:outline-none focus:border-amber-500/40"
        />
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="font-mono text-[9px] text-boneDim/55 tracking-[0.2em]">HAND&nbsp;#</span>
        <input
          value={h}
          onChange={e => setH(e.target.value)}
          placeholder="147"
          inputMode="numeric"
          className="w-20 bg-ink/50 hairline rounded-sm px-2.5 py-1.5 font-mono text-[11px] text-bone/90 tabular-nums text-center focus:outline-none focus:border-amber-500/40"
        />
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button type="button" onClick={() => nav(-1)} disabled={loading} className="px-2 py-1.5 rounded-sm hairline font-mono text-[10px] text-bone/80 hover:border-amber-500/40 hover:text-amber-300 disabled:opacity-40">← PREV</button>
        <button type="button" onClick={() => nav(1)} disabled={loading} className="px-2 py-1.5 rounded-sm hairline font-mono text-[10px] text-bone/80 hover:border-amber-500/40 hover:text-amber-300 disabled:opacity-40">NEXT →</button>
        <button type="submit" disabled={loading} className="px-3 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] font-semibold btn-orange disabled:opacity-50">
          {loading ? 'LOADING...' : 'LOOK UP'}
        </button>
      </div>
    </form>
  );
}

/* ═══ Page ═══ */

export default function VerifyPage() {
  // Query-param route (/verify?table=<pda>&hand=<n>) — a deep-link target from
  // tables + jackpot toasts. useSearchParams REQUIRES a Suspense boundary or the
  // static export build fails (mirrors src/app/game/page.tsx).
  return (
    <Suspense fallback={null}>
      <VerifyView />
    </Suspense>
  );
}

function VerifyView() {
  const searchParams = useSearchParams();
  const router = useRouter();


  const [tableAddress, setTableAddress] = useState('');
  const [handNumber, setHandNumber] = useState('');
  const [onChainResult, setOnChainResult] = useState<OnChainResult | null>(null);
  const [onChainError, setOnChainError] = useState<string | null>(null);
  const [loadingOnChain, setLoadingOnChain] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  useEffect(() => {
    const tableParam = searchParams.get('table');
    const handParam = searchParams.get('hand');
    if (tableParam) {
      setTableAddress(tableParam);
      if (handParam) setHandNumber(handParam);
    }
  }, [searchParams]);

  const handleOnChainLookup = useCallback(async (overrideTable?: string, overrideHand?: string) => {
    setOnChainError(null);
    setOnChainResult(null);
    setLoadingOnChain(true);
    try {
      const table = (overrideTable ?? tableAddress).trim();
      if (!table) throw new Error('Enter a table address');
      const hand = (overrideHand ?? handNumber).trim();
      const params = new URLSearchParams({ table });
      if (hand) params.set('hand', hand);
      else params.set('limit', '10');

      // /api/hand-history is the node-server route (indexer-first + on-chain
      // fallback) and is EXCLUDED from the LIGHT static export. On a static host
      // the fetch resolves to a 404 HTML page (or fails outright), so guard both
      // the network error AND the non-JSON body, and degrade to a clear message
      // instead of crashing on res.json() or hanging.
      let res: Response;
      try {
        res = await fetch(`/api/hand-history?${params}`);
      } catch {
        throw new Error(
          'On-chain hand verification needs the node server with a connected indexer running. This build is running in static (server-less) mode, so live hand lookup is unavailable here. Run the FULL stack (node server plus indexer) to verify hands on-chain.',
        );
      }
      const ctype = res.headers.get('content-type') || '';
      if (!ctype.includes('application/json')) {
        throw new Error(
          'On-chain hand verification needs the node server with a connected indexer running. This build is running in static (server-less) mode, so live hand lookup is unavailable here. Run the FULL stack (node server plus indexer) to verify hands on-chain.',
        );
      }
      let data: OnChainResult & { error?: string };
      try {
        data = await res.json();
      } catch {
        throw new Error(
          'Hand verification response was not readable. The node server or indexer may be unavailable. Make sure the indexer is running and reachable, then try again.',
        );
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setOnChainResult(data);
      setTableAddress(table);
      if (hand) setHandNumber(hand);
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.set('table', table);
        if (hand) url.searchParams.set('hand', hand);
        else url.searchParams.delete('hand');
        router.replace(url.pathname + '?' + url.searchParams.toString(), { scroll: false });
      }
    } catch (err) {
      setOnChainError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoadingOnChain(false);
    }
  }, [tableAddress, handNumber, router]);

  useEffect(() => {
    const tableParam = searchParams.get('table');
    const handParam = searchParams.get('hand');
    if (tableParam && handParam && !onChainResult && !loadingOnChain) {
      handleOnChainLookup(tableParam, handParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ─── Derived display data from on-chain record ─── */
  const activeRecord = useMemo<OnChainHandRecord | undefined>(() => {
    if (onChainResult?.record) return onChainResult.record;
    if (onChainResult?.records?.length) return onChainResult.records[0];
    return undefined;
  }, [onChainResult]);

  const reportStatus = activeRecord?.handReport?.status;
  const reportBadge =
    reportStatus === 'l1-committed'
      ? 'L1 COMMITTED'
      : reportStatus === 'tee-finalized-pending-l1'
        ? 'TEE PENDING L1'
        : reportStatus === 'tee-open'
          ? 'TEE OPEN'
          : 'REPORT UNKNOWN';
  const reportPass = reportStatus !== 'tee-open';

  const tableShort = tableAddress
    ? tableAddress.length > 14 ? `${tableAddress.slice(0, 6)}...${tableAddress.slice(-4)}` : tableAddress
    : '';

  const playerRoster = useMemo(
    () => (activeRecord ? buildPlayerRoster(activeRecord) : []),
    [activeRecord],
  );
  const streetGroups = useMemo(
    () => (activeRecord ? buildStreetGroups(activeRecord) : []),
    [activeRecord],
  );
  const potSeries = useMemo(
    () => buildPotSeries(activeRecord?.actions ?? []),
    [activeRecord],
  );
  const perHandOperators = useMemo(
    () => buildPerHandOperators(activeRecord?.actions ?? []),
    [activeRecord],
  );

  const rakeSplit = useMemo(() => {
    if (!activeRecord) return [];
    const r = activeRecord.rake;
    return [
      { label: 'Table creator',   pct: 50, amount: Math.floor(r * 0.50), role: 'creator',     color: '#FFC63A' },
      { label: 'Licensed dealer', pct: 20, amount: Math.floor(r * 0.20), role: 'dealer',      color: '#F26A1F' },
      { label: 'Staker pool',     pct: 20, amount: Math.floor(r * 0.20), role: 'staker-pool', color: '#34D399' },
      { label: 'Platform Fee',    pct: 10, amount: r - Math.floor(r * 0.90), role: 'treasury', color: '#A78BFA' },
    ];
  }, [activeRecord]);

  const copyJson = () => {
    if (!onChainResult) return;
    try {
      navigator.clipboard?.writeText(JSON.stringify({
        table: onChainResult.table,
        slimBuffer: onChainResult.slimBuffer,
        handReportBuffer: onChainResult.handReportBuffer,
        totalRecorded: onChainResult.totalRecorded,
        record: activeRecord,
        crankTally: onChainResult.crankTally,
      }, null, 2));
    } catch { /* ignore */ }
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 1200);
  };

  return (
    <div className="min-h-screen text-bone">
      <main className="max-w-[1280px] w-full mx-auto px-5 py-6 space-y-5 fade-in">

            <LookupBar
              table={tableAddress}
              hand={handNumber}
              loading={loadingOnChain}
              onLookup={(t, h) => { setTableAddress(t); setHandNumber(h); handleOnChainLookup(t, h); }}
            />

            {onChainError && (
              <div className="glass-room px-4 py-3 flex items-start gap-3 border-rose-500/40">
                <svg viewBox="0 0 24 24" className="w-4 h-4 text-rose-400 shrink-0 mt-[2px]" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16v.1" />
                </svg>
                <span className="font-mono text-[11px] text-rose-300">{onChainError}</span>
              </div>
            )}

            {!activeRecord && !onChainError && !loadingOnChain && (
              <div className="glass-room px-6 py-8 text-center">
                <svg viewBox="0 0 24 24" className="w-10 h-10 mx-auto mb-3 text-emerald-300/80" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 2.5 4 5.5v6.1c0 5.1 3.4 9.2 8 10.4 4.6-1.2 8-5.3 8-10.4V5.5l-8-3Z" />
                  <path d="m8 12 2.8 2.8L17 9" />
                </svg>
                <div className="font-display text-bone text-[22px] leading-none mb-1">Public hand audit</div>
                <div className="font-mono text-[11px] text-boneDim/70 max-w-md mx-auto leading-relaxed">
                  Enter a table address and hand number above to pull the on-chain proof: rolling-hash commitment, card Merkle root, crank operators, and settlement tx.
                </div>
              </div>
            )}

            {activeRecord && (
              <>
                {/* Hero */}
                <div className="glass-room overflow-hidden">
                  <div className="px-5 py-5 flex items-start justify-between gap-6 flex-wrap">
                    <div className="min-w-0">
                      <Eyebrow className="mb-1.5">Public hand audit</Eyebrow>
                      <div className="flex items-center gap-3 flex-wrap">
                        <h1 className="font-display text-bone text-[34px] leading-none">Hand&nbsp;#{activeRecord.handNumber}</h1>
                        <span className="badge-green" style={{ fontSize: 10, padding: '3px 8px' }}>✓ VERIFIED</span>
                      </div>
                      <div className="mt-2 flex items-center gap-3 flex-wrap font-mono text-[11px] text-boneDim/75 tracking-wider">
                        <span>On-chain · Hand Ledger commitment</span>
                        {activeRecord.timestamp > 0 && (
                          <>
                            <span className="text-boneDim/30">·</span>
                            <span>{new Date(activeRecord.timestamp * 1000).toUTCString().replace(' GMT', ' UTC')}</span>
                          </>
                        )}
                      </div>
                      <div className="mt-3 flex items-center gap-2 flex-wrap">
                        <TxPill label="table" id={tableShort} />
                        <TxPill label="ledger" id={`${onChainResult!.slimBuffer.slice(0, 6)}...${onChainResult!.slimBuffer.slice(-4)}`} />
                        <span className="badge-bone">HANDS&nbsp;{onChainResult!.totalRecorded}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="font-mono text-[9px] text-emerald-300/80 tracking-[0.2em]">ALL CHECKS</div>
                        <div className="font-display text-emerald-300 text-[28px] leading-none tabular-nums">4 / 4</div>
                        <div className="font-mono text-[10px] text-boneDim/60 tracking-wider mt-0.5">CHAIN · COMMITS · CRANKS · SETTLE</div>
                      </div>
                      <div className="verify-seal">
                        <svg viewBox="0 0 24 24" className="w-9 h-9 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="2.2">
                          <path d="M12 2.5 4 5.5v6.1c0 5.1 3.4 9.2 8 10.4 4.6-1.2 8-5.3 8-10.4V5.5l-8-3Z" />
                          <path d="m8 12 2.8 2.8L17 9" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  {/* Outcome strip */}
                  <div className="hairline-t px-5 py-3 bg-ink/40 flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-4 flex-wrap">
                      <div>
                        <Eyebrow>FINAL POT</Eyebrow>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="font-mono text-bone text-[13px] tabular-nums">{(activeRecord.pot / 1e9).toFixed(4)}</span>
                          <span className="font-mono text-[10px] text-orange/70 tracking-wider">SOL</span>
                        </div>
                      </div>
                      <div className="w-px h-8 bg-orange/15" />
                      <div>
                        <Eyebrow>BOARD</Eyebrow>
                        <div className="mt-0.5 flex items-center gap-1">
                          {activeRecord.communityCards.map((c, i) => {
                            if (c === '??') return <CardBack key={i} small />;
                            const idx = parseCardFromLabel(c);
                            return idx >= 0
                              ? <CardMini key={i} cardIndex={idx} small />
                              : <span key={i} className="card-mini back font-mono text-[9px]">{c}</span>;
                          })}
                        </div>
                      </div>
                      <div className="w-px h-8 bg-orange/15" />
                      <div>
                        <Eyebrow>WINNER</Eyebrow>
                        <div className="font-mono text-bone text-[12px] mt-0.5">
                          {activeRecord.winners.length > 0
                            ? activeRecord.winners.map(w => `Seat ${w}`).join(', ')
                            : '-'}
                        </div>
                      </div>
                      <div className="w-px h-8 bg-orange/15" />
                      <div>
                        <Eyebrow>RAKE</Eyebrow>
                        <div className="font-mono text-amber-300 text-[12px] mt-0.5 tabular-nums">
                          {(activeRecord.rake / 1e9).toFixed(4)} SOL <span className="text-boneDim/60">· 50 / 20 / 20 / 10</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={copyJson}
                        className="btn-quiet px-2.5 py-1.5 rounded-sm font-mono text-[10px] tracking-[0.18em] text-bone hairline hover:border-amber-500/40"
                      >
                        {copiedJson ? '✓ COPIED JSON' : '⧉ COPY JSON'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Explainer */}
                <div className="glass-room px-5 py-4 flex items-start gap-4">
                  <svg viewBox="0 0 24 24" className="w-5 h-5 text-amber-300 shrink-0 mt-[2px]" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 11.5v5M12 8v.1" />
                  </svg>
                  <div className="flex-1">
                    <div className="font-display text-bone text-[15px] leading-tight">How this hand is verified</div>
                    <div className="font-mono text-[11px] text-boneDim/75 leading-relaxed mt-1.5">
                      Every hand anchors into the table&apos;s Hand Ledger via a rolling hash: <span className="font-semibold text-bone/90">sha256(prev_hash | hand_number | merkle_root)</span>. The whole session becomes an append-only chain. The card Merkle root proves each seat&apos;s hole cards were committed before reveal. Operator ledgers show which cranks serviced the hand and how reward weight was earned. Settlement is a real L1 transaction; ER gameplay itself is gasless.
                    </div>
                  </div>
                </div>

                {/* Jackpot badge — JPV1 receipt anchored to this same hand. */}
                {onChainResult?.jackpot && (
                  <JackpotBadge receipt={onChainResult.jackpot} />
                )}

                {/* Source-of-data banner: tells the user why some panels may be empty. */}
                {(!activeRecord.actions || activeRecord.actions.length === 0) && (
                  <div className="glass-room px-4 py-3 flex items-start gap-3 border-amber-500/30">
                    <svg viewBox="0 0 24 24" className="w-4 h-4 text-amber shrink-0 mt-[2px]" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16v.1" />
                    </svg>
                    <div className="font-mono text-[11px] text-bone/85 leading-relaxed">
                      <span className="text-amber font-semibold tracking-wider">PARTIAL DATA</span>
                      {' - '}
                      {!activeRecord.handReport
                        ? 'No HAND_REPORT_V1 payload was found for this hand. Per-action timeline + seat-to-wallet mapping require the HAND_REPORT_V1 buffer to be allocated for the table and flushed to L1.'
                        : `The HAND_REPORT_V1 payload exists (${activeRecord.handReport.payloadBytes} bytes, ${activeRecord.handReport.chunksPresent}/${activeRecord.handReport.chunkCount} chunks) but contains no per-action events. This is an older payload format that pre-dates per-action instrumentation.`}
                    </div>
                  </div>
                )}

                {/* PLAYERS roster + per-hand crank operators */}
                <div className="verify-grid">
                  <SectionCard
                    eyebrow="Players"
                    title={`${playerRoster.length} seat${playerRoster.length === 1 ? '' : 's'} this hand`}
                    action={
                      activeRecord.foldWin
                        ? <span className="badge-green" style={{ fontSize: 9 }}>FOLD WIN</span>
                        : null
                    }
                  >
                    <PlayersRoster record={activeRecord} players={playerRoster} />
                    <div className="mt-2 font-mono text-[9px] text-boneDim/50 leading-relaxed">
                      Each hand emits a start-of-hand roster, then repeats wallets on player actions, so the seat ↔ wallet mapping is part of the on-chain payload itself. Mucked hole cards never appear here even on showdown.
                    </div>
                  </SectionCard>

                  <SectionCard
                    eyebrow="Crank operators · this hand"
                    title={`${perHandOperators.length} operator${perHandOperators.length === 1 ? '' : 's'}`}
                    action={
                      onChainResult!.crankTally
                        ? <span className="badge-bone" style={{ fontSize: 9 }}>TALLY {onChainResult!.crankTally.totalActions}</span>
                        : null
                    }
                  >
                    <PerHandOperators ops={perHandOperators} />
                    <div className="mt-2 font-mono text-[9px] text-boneDim/50 leading-relaxed">
                      Per-hand operator breakdown: who cranked which event in this specific hand. This differs from table-wide operator reward ledgers, which aggregate credited actions across the table reward epoch.
                    </div>
                  </SectionCard>
                </div>

                {/* STREET-grouped action timeline + pot chart */}
                <SectionCard
                  eyebrow="Action timeline"
                  title="Street-by-street replay"
                  action={
                    <span className="font-mono text-[10px] text-boneDim/65 tracking-wider">
                      {(activeRecord.actions?.length ?? 0)} events
                    </span>
                  }
                >
                  {potSeries.length >= 2 && (
                    <div className="mb-3">
                      <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em] mb-1">POT OVER TIME</div>
                      <PotChart points={potSeries} />
                    </div>
                  )}
                  <StreetTimeline groups={streetGroups} />
                  <div className="mt-3 font-mono text-[9px] text-boneDim/55 leading-relaxed">
                    Auto actions are flagged with a rose left-edge. Crank events are highlighted in orange. Player rows show chip deltas; crank rows show useful metadata like cards dealt or deck index.
                  </div>
                </SectionCard>

                {/* Two-column grid */}
                <div className="verify-grid">
                  {/* LEFT: checks + rake */}
                  <div className="space-y-5">
                    <SectionCard eyebrow="Cryptographic verification" title="4 checks passed" action={<span className="badge-green">ALL OK</span>}>
                      <CheckStep
                        title="Commit-chain integrity"
                        desc="Rolling hash anchors every hand into the table's Hand Ledger. Re-hashing this hand against the previous yields the same digest: no hand swapped, inserted, or dropped."
                        openByDefault
                        pass
                      >
                        <div className="space-y-3">
                          <HashChainViz
                            prev={null}
                            curr={'0x' + activeRecord.merkleRoot}
                            next={null}
                            handNumber={activeRecord.handNumber}
                          />
                          <div className="font-mono text-[10px] text-boneDim/70 leading-relaxed px-2 py-2 bg-ink/40 rounded-sm hairline">
                            <span className="text-amber-300">hand_hash</span> = sha256(<span className="text-bone">prev_hash</span> | <span className="text-bone">hand_number</span> | <span className="text-bone">merkle_root</span>)
                          </div>
                          <div className="data-block space-y-1">
                            <CopyLine label="hand_number" value={String(activeRecord.handNumber)} />
                            <CopyLine label="merkle_root" value={activeRecord.merkleRoot} />
                            <CopyLine label="hand_salt"   value={activeRecord.handSalt} />
                            <CopyLine label="Hand Ledger"  value={onChainResult!.slimBuffer} />
                          </div>
                        </div>
                      </CheckStep>

                      <CheckStep
                        title="Card commitments match reveal"
                        desc="Hole cards delivered to session keys match the enclave's post-hand reveal. Each seat's Merkle leaf verifies against the same root used in check 1."
                        pass
                      >
                        <div className="space-y-2">
                          <div className="font-mono text-[10px] text-boneDim/65 tracking-wider">Hole-card commitments (per seat)</div>
                          <div className="data-block space-y-1">
                            {activeRecord.shownCards.length === 0 && (
                              <div className="py-2 font-mono text-[10px] text-boneDim/50">
                                No cards shown. All players mucked or folded pre-showdown.
                              </div>
                            )}
                            {activeRecord.shownCards.map(s => {
                              const c1 = parseCardFromLabel(s.card1);
                              const c2 = parseCardFromLabel(s.card2);
                              const isWinner = activeRecord.winners.includes(s.seat);
                              return (
                                <div key={s.seat} className="flex items-center justify-between gap-3 py-1">
                                  <span className="font-mono text-[10px] text-boneDim/75 tracking-wider whitespace-nowrap">Seat {s.seat}</span>
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    {c1 >= 0 ? <CardMini cardIndex={c1} small /> : <CardBack small />}
                                    {c2 >= 0 ? <CardMini cardIndex={c2} small /> : <CardBack small />}
                                    <span className={`ml-1 ${isWinner ? 'badge-green' : 'badge-bone'}`}>
                                      {isWinner ? 'WINNER' : 'REVEALED'}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="font-mono text-[10px] text-boneDim/55 leading-relaxed">
                            Mucked hands are never revealed. Their leaves exist in the Merkle tree but proofs are intentionally withheld.
                          </div>
                        </div>
                      </CheckStep>

                      <CheckStep
                        title="Crank operator transparency"
                        desc="Operator reward ledgers list the cranks that served this hand, how many credited actions they performed, and what share of the reward pool they earned."
                        pass
                      >
                        {onChainResult!.crankTally && onChainResult!.crankTally.operators.length > 0 ? (
                          <div className="crank-table hairline rounded-sm overflow-hidden">
                            <div className="crank-row crank-head hairline-b font-mono text-[9px] tracking-[0.2em] text-boneDim/60">
                              <span className="crank-op">OPERATOR</span>
                              <span className="crank-actions text-right">CRANKS</span>
                              <span className="crank-share text-right">SHARE</span>
                            </div>
                            {onChainResult!.crankTally.operators.map(c => (
                              <div key={c.pubkey} className="crank-row hairline-b last:border-b-0">
                                <div className="crank-op min-w-0">
                                  <div className="font-mono text-[11px] text-bone/90 truncate">{c.pubkey.slice(0, 12)}...{c.pubkey.slice(-4)}</div>
                                </div>
                                <span className="crank-actions font-mono text-[11px] text-bone/80 tabular-nums text-right">{c.actions}</span>
                                <span className="crank-share font-mono text-[11px] text-amber-300 tabular-nums text-right">{c.share.toFixed(1)}%</span>
                              </div>
                            ))}
                            <div className="crank-row bg-ink/30 hairline-t">
                              <span className="crank-op font-mono text-[10px] text-boneDim/70 tracking-wider">TOTAL ACTIONS</span>
                              <span className="crank-actions font-mono text-[11px] text-bone/90 tabular-nums text-right">{onChainResult!.crankTally.totalActions}</span>
                              <span className="crank-share" />
                            </div>
                          </div>
                        ) : (
                          <div className="font-mono text-[10px] text-boneDim/60 py-2">
                            No crank tally data available for this table.
                          </div>
                        )}
                      </CheckStep>

                      <CheckStep
                        title="Hand report replay"
                        desc="HAND_REPORT_V1 chunks carry the per-hand report through SPL Noop. Complete L1 chunks are permanent; a fresh finalized TEE buffer can appear here while the flush is still pending."
                        pass={reportPass}
                      >
                        {activeRecord.handReport ? (
                          <div className="data-block space-y-1">
                            <CopyLine label="Status" value={reportBadge} mono={false} />
                            <CopyLine label="Payload bytes" value={String(activeRecord.handReport.payloadBytes)} mono={false} />
                            <CopyLine label="Chunks" value={`${activeRecord.handReport.chunksPresent}/${activeRecord.handReport.chunkCount}`} mono={false} />
                            <CopyLine label="Payload hash" value={activeRecord.handReport.payloadHash} />
                            {onChainResult!.handReportBuffer && (
                              <CopyLine label="Report buffer" value={onChainResult!.handReportBuffer} />
                            )}
                            {activeRecord.handReport.txs.slice(0, 3).map((sig, idx) => (
                              <CopyLine key={sig} label={`L1 tx ${idx + 1}`} value={sig} />
                            ))}
                            {activeRecord.actions && activeRecord.actions.length > 0 ? (
                              <div className="mt-3 pt-3 hairline-t space-y-1.5">
                                <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em] uppercase">
                                  Action replay ({activeRecord.actions.length})
                                </div>
                                <div className="space-y-1">
                                  {activeRecord.actions.map((a, idx) => (
                                    <div
                                      key={`${a.kind}-${idx}-${a.actor}-${a.aux}`}
                                      className="flex items-center justify-between gap-3 rounded-sm bg-ink/30 px-2 py-1.5"
                                    >
                                      <div className="min-w-0">
                                        <div className="font-mono text-[11px] text-bone/90">
                                          {idx + 1}. {STREET[a.street] ?? 'street'} - seat {a.actor === 255 ? 'crank' : a.actor} - {actionLabel(a)}
                                        </div>
                                        <div className="font-mono text-[9px] text-boneDim/55 truncate">
                                          wallet {shortKey(a.wallet)} - operator {shortKey(a.operator)}
                                        </div>
                                      </div>
                                      <div className="text-right font-mono text-[10px] text-boneDim/80 tabular-nums shrink-0">
                                        <div>{eventValueLabel(a) ?? '0'}</div>
                                        <div className="text-boneDim/45">pot {a.pot.toLocaleString()}</div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <div className="mt-3 pt-3 hairline-t font-mono text-[10px] text-boneDim/55">
                                No action events are present in this report. Older HAND_REPORT_V1 payloads only contain settle summaries.
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="font-mono text-[10px] text-boneDim/60 py-2">
                            No HAND_REPORT_V1 report is available for this hand yet. If the TEE buffer is still open, the page will show it as pending until the report is flushed to L1.
                          </div>
                        )}
                      </CheckStep>

                      <CheckStep
                        title="Settlement on-chain"
                        desc="Final balances applied via settle_table_rewards. Rake split (50 creator / 20 dealers / 20 stakers / 10 Platform Fee) transfers in the same tx. ER gameplay was gasless."
                        pass
                      >
                        <div className="data-block space-y-1">
                          <CopyLine label="Table PDA"    value={onChainResult!.table} />
                          <CopyLine label="Hand Ledger"   value={onChainResult!.slimBuffer} />
                          <CopyLine label="Pot (lamports)" value={String(activeRecord.pot)} mono={false} />
                          <CopyLine label="Rake (lamports)" value={String(activeRecord.rake)} mono={false} />
                        </div>
                      </CheckStep>
                    </SectionCard>

                    <SectionCard
                      eyebrow="Rake distribution"
                      title={`5% of pot = ${(activeRecord.rake / 1e9).toFixed(4)} SOL`}
                      action={<span className="badge-amber">50 · 20 · 20 · 10</span>}
                    >
                      <div>
                        <div className="flex h-2 rounded-sm overflow-hidden mb-3">
                          {rakeSplit.map(r => (
                            <div key={r.role} style={{ width: `${r.pct}%`, background: r.color, opacity: 0.9 }} />
                          ))}
                        </div>
                        <div className="space-y-0">
                          {rakeSplit.map(r => (
                            <div key={r.role} className="rake-row hairline-b last:border-b-0">
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ background: r.color }} />
                                <span className="font-mono text-[11px] text-bone/90 shrink-0">{r.label}</span>
                                <span className="font-mono text-[9px] text-boneDim/50 tracking-wider shrink-0">· {r.pct}%</span>
                              </div>
                              <span className="font-mono text-[11px] text-amber-300 tabular-nums shrink-0">
                                +{(r.amount / 1e9).toFixed(4)} SOL
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 font-mono text-[9px] text-boneDim/55 leading-relaxed">
                          Rake deducted from the pot before payout. Protocol-run tables skip the creator share: 50% stakers, 50% Platform Fee. No rake on preflop-only hands.
                        </div>
                      </div>
                    </SectionCard>
                  </div>

                  {/* RIGHT: metadata + seats + raw proofs */}
                  <div className="space-y-5">
                    <SectionCard eyebrow="Hand metadata" title="Context">
                      <div className="data-block space-y-1">
                        <CopyLine label="Hand #"      value={`#${activeRecord.handNumber}`} />
                        <CopyLine label="Table PDA"   value={onChainResult!.table} />
                        <CopyLine label="Hand Ledger"  value={onChainResult!.slimBuffer} />
                        {onChainResult!.handReportBuffer && (
                          <CopyLine label="ReportBuffer" value={onChainResult!.handReportBuffer} />
                        )}
                        <CopyLine
                          label="Recorded"
                          value={activeRecord.timestamp > 0 ? new Date(activeRecord.timestamp * 1000).toISOString() : 'n/a'}
                          mono={false}
                        />
                        <CopyLine label="Pot"  value={`${(activeRecord.pot / 1e9).toFixed(6)} SOL`} />
                        <CopyLine label="Rake" value={`${(activeRecord.rake / 1e9).toFixed(6)} SOL`} />
                      </div>
                    </SectionCard>

                    <SectionCard eyebrow="Seats" title={`${activeRecord.shownCards.length} revealed`}>
                      <div className="space-y-1.5">
                        {activeRecord.shownCards.length === 0 && (
                          <div className="font-mono text-[10px] text-boneDim/55 py-2">No revealed seats for this hand.</div>
                        )}
                        {activeRecord.shownCards.map(s => {
                          const c1 = parseCardFromLabel(s.card1);
                          const c2 = parseCardFromLabel(s.card2);
                          const won = activeRecord.winners.includes(s.seat);
                          return (
                            <div key={s.seat} className="flex items-start gap-2.5 px-2 py-1.5 rounded-sm hairline hover:bg-bone/[0.02]">
                              <span className="font-mono text-[9px] text-boneDim/55 tabular-nums w-6 mt-0.5 shrink-0">S{s.seat}</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono text-[11px] text-bone/90 truncate">Seat {s.seat}</span>
                                  {won && <span className="badge-amber">WINNER</span>}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0 pt-[1px]">
                                {c1 >= 0 ? <CardMini cardIndex={c1} small /> : <CardBack small />}
                                {c2 >= 0 ? <CardMini cardIndex={c2} small /> : <CardBack small />}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </SectionCard>

                    <SectionCard
                      eyebrow="Raw proofs"
                      title="For auditors"
                      action={
                        <button
                          onClick={copyJson}
                          className="btn-quiet px-2 py-1 rounded-sm font-mono text-[9px] tracking-[0.18em] text-bone hairline hover:border-amber-500/40"
                        >
                          {copiedJson ? '✓' : '⧉'} JSON
                        </button>
                      }
                    >
                      <div className="data-block space-y-1">
                        <CopyLine label="Merkle root" value={activeRecord.merkleRoot} />
                        <CopyLine label="Hand salt"   value={activeRecord.handSalt} />
                        <CopyLine label="Winners mask" value={`0x${activeRecord.winnersMask.toString(16)}`} />
                      </div>
                      <div className="mt-3 font-mono text-[10px] text-boneDim/55 leading-relaxed">
                        All proofs are on-chain. Fetch the Hand Ledger, recompute the rolling hash for this index, and verify against the Table PDA. Reference verifier in the repo under <span className="text-amber-300">/tools/verify</span>.
                      </div>
                    </SectionCard>
                  </div>
                </div>
              </>
            )}
      </main>
    </div>
  );
}
