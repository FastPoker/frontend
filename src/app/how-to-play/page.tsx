'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { BRAND } from '@/lib/branding';

// ══════════════════════════════════════════════════════════════════════
// HOW TO PLAY · the rulebook + the economics, in one page
// Ported from Fast Poker_UI_MOCKUP1.4/parts/howto.jsx into the live app.
// Uses 1.4 design tokens (orange #F26A1F, Bebas Neue, hairline, font-mono).
// Chrome (navbar, bottom bar, footer) comes from LayoutShell.
// ══════════════════════════════════════════════════════════════════════

const HAND_RANKINGS = [
  { rank: 1,  name: 'Royal Flush',     desc: 'A K Q J 10, all same suit',           example: 'A♠ K♠ Q♠ J♠ T♠', rarity: '0.000154%' },
  { rank: 2,  name: 'Straight Flush',  desc: 'Five consecutive cards, same suit',    example: '9♥ 8♥ 7♥ 6♥ 5♥', rarity: '0.00139%'  },
  { rank: 3,  name: 'Four of a Kind',  desc: 'Four cards of the same rank',          example: 'Q♠ Q♥ Q♦ Q♣ 7♠', rarity: '0.0240%'   },
  { rank: 4,  name: 'Full House',      desc: 'Three of a kind plus a pair',          example: 'J♠ J♥ J♦ 8♣ 8♠', rarity: '0.144%'    },
  { rank: 5,  name: 'Flush',           desc: 'Five cards, same suit, any order',     example: 'A♦ J♦ 8♦ 6♦ 2♦', rarity: '0.197%'    },
  { rank: 6,  name: 'Straight',        desc: 'Five consecutive cards, mixed suits',  example: 'T♠ 9♥ 8♦ 7♣ 6♠', rarity: '0.392%'    },
  { rank: 7,  name: 'Three of a Kind', desc: 'Three cards of the same rank',         example: '7♠ 7♥ 7♦ K♣ 3♠', rarity: '2.11%'     },
  { rank: 8,  name: 'Two Pair',        desc: 'Two different pairs',                  example: 'A♠ A♥ 9♦ 9♣ 4♠', rarity: '4.75%'     },
  { rank: 9,  name: 'One Pair',        desc: 'Two cards of the same rank',           example: 'K♠ K♥ J♦ 8♣ 3♠', rarity: '42.3%'     },
  { rank: 10, name: 'High Card',       desc: 'No made hand, highest card plays',     example: 'A♠ J♥ 8♦ 6♣ 2♠', rarity: '50.1%'     },
];

const SECTIONS = [
  { id: 'rules',     num: '01', label: 'Rules'         },
  { id: 'rankings',  num: '02', label: 'Rankings'      },
  { id: 'modes',     num: '03', label: 'Game modes'    },
  { id: 'fees',      num: '04', label: 'Fees & rake'   },
  { id: 'fair',      num: '05', label: 'Provably fair' },
  { id: 'sessions',  num: '06', label: 'Sessions'      },
];

// SectionHeader moved to @/components/ui/SectionHeader — shared across all
// non-lobby surfaces. See fastpoker-design-system skill § 9.

function KV({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 hairline-b last:border-b-0">
      <div>
        <div className="font-mono text-[10px] text-boneDim/75">{k}</div>
        {sub && <div className="font-mono text-[9px] text-boneDim/45 mt-0.5">{sub}</div>}
      </div>
      <div className="font-mono text-[12px] text-bone tabular-nums text-right shrink-0">{v}</div>
    </div>
  );
}

function RakeRow({ color, label, pct, note }: { color: string; label: string; pct: string; note: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ background: color }}/>
        <span className="font-mono text-[11px] text-bone">{label}</span>
        <span className="font-mono text-[9px] text-boneDim/50">· {note}</span>
      </div>
      <span className="font-mono text-[11px] tabular-nums" style={{ color }}>{pct}</span>
    </div>
  );
}

// ─── Hero ────────────────────────────────────────────────────────────
function HowToHero() {
  return (
    <div className="relative overflow-hidden rounded-sm hairline bg-gradient-to-br from-inkB via-inkA to-ink">
      <div
        className="absolute inset-0 pointer-events-none opacity-40"
        style={{ background: 'radial-gradient(ellipse at top left, rgba(242,106,31,0.18), transparent 60%)' }}
      />
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.04]"
        style={{ backgroundImage: 'repeating-linear-gradient(45deg, #F26A1F 0 1px, transparent 1px 14px)' }}
      />
      <div className="absolute right-6 top-1/2 -translate-y-1/2 flex gap-3 pointer-events-none select-none">
        {['♠', '♥', '♦', '♣'].map((s, i) => (
          <span
            key={i}
            className="font-display text-[88px] leading-none opacity-[0.05]"
            style={{ color: s === '♥' || s === '♦' ? '#F26A1F' : '#F5F1E6' }}
          >
            {s}
          </span>
        ))}
      </div>
      <div className="relative p-6 lg:p-8">
        <div className="font-mono text-[10px] tracking-[0.22em] text-orange/80 mb-3">PLAYBOOK</div>
        <h1 className="font-display text-bone text-5xl lg:text-6xl leading-[0.92] tracking-wide max-w-2xl">
          HOW TO PLAY<br/>
          <span className="italic text-orange">TEXAS HOLD&apos;EM</span>
        </h1>
        <p className="font-mono text-[11px] text-boneDim/70 mt-4 max-w-xl leading-relaxed">
          The complete guide to playing poker on FAST POKER, fully on-chain, cards dealt in a
          <span className="text-emerald-300"> TEE</span>, chips in
          <span className="text-emerald-300"> PDA escrow</span>, gasless via session keys.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          {SECTIONS.map(s => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="group flex items-center gap-2 px-3 py-1.5 rounded-sm hairline bg-ink/40 hover:bg-orange/10 hover:border-orange/40 transition"
            >
              <span className="font-mono text-[9px] text-orange/60 tracking-wider group-hover:text-orange">{s.num}</span>
              <span className="font-mono text-[10px] text-bone/85 group-hover:text-bone tracking-wider">{s.label.toUpperCase()}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 01 · Rules ──────────────────────────────────────────────────────
function RulesSection() {
  const rounds = [
    { num: '1', k: 'Preflop',  v: 'Two hole cards dealt face down. Action starts left of big blind.' },
    { num: '2', k: 'Flop',     v: 'Three community cards revealed. Betting starts left of dealer.'   },
    { num: '3', k: 'Turn',     v: 'Fourth community card revealed. Another betting round.'           },
    { num: '4', k: 'River',    v: 'Fifth community card revealed. Final betting round.'              },
    { num: '5', k: 'Showdown', v: 'Best 5-card hand wins the pot.'                                   },
  ];
  const actions = [
    { k: 'Fold',    v: 'Surrender your hand. Forfeit any bets already in the pot.' },
    { k: 'Check',   v: 'Pass action without betting. Only legal if no outstanding bet to you.' },
    { k: 'Call',    v: 'Match the current bet to stay in the hand.' },
    { k: 'Raise',   v: 'Increase the bet. Minimum raise equals the size of the previous raise.' },
    { k: 'All-In',  v: 'Push your entire stack. Caps the bet you can face.' },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-4">
      <div id="rules-game-card" className="rounded-sm hairline bg-inkA overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between" style={{ background: 'linear-gradient(180deg, rgba(242,106,31,0.28) 0%, rgba(242,106,31,0.08) 100%)', borderBottom: '1px solid rgba(242,106,31,0.45)' }}>
          <div className="flex items-center gap-2.5">
            <span className="w-1.5 h-1.5 rounded-full bg-orange"/>
            <span className="font-display text-bone text-sm leading-none">THE GAME</span>
          </div>
          <span className="font-mono text-[9px] text-boneDim/50 tracking-wider">52-CARD DECK</span>
        </div>
        <div className="p-5 space-y-4">
          <p className="font-mono text-[12px] text-boneDim/85 leading-relaxed">
            Every player is dealt <span className="text-bone">2 hole cards</span> face down, and
            <span className="text-bone"> 5 community cards</span> are turned face up on the board.
            Make your best 5-card hand using any combination of the seven cards available to you.
          </p>
          <div>
            <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em] mb-2">BETTING ROUNDS</div>
            <div className="space-y-1.5">
              {rounds.map(r => (
                <div key={r.num} className="flex gap-3 p-2.5 rounded-sm hairline bg-ink/30">
                  <span className="font-display text-orange/60 text-xl leading-none tabular-nums shrink-0 w-6 text-center">{r.num}</span>
                  <div>
                    <div className="font-mono text-[11px] text-bone">{r.k}</div>
                    <div className="font-mono text-[10px] text-boneDim/60 leading-relaxed mt-0.5">{r.v}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-sm hairline bg-orange/[0.04] p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full flex items-center justify-center border border-orange/50 bg-orange/10 font-mono text-[9px] text-orange font-bold">D</span>
              <div className="font-mono text-[10px] text-orange/90 tracking-[0.18em]">BLINDS &amp; DEALER BUTTON</div>
            </div>
            <p className="font-mono text-[10px] text-boneDim/75 leading-relaxed">
              Each hand, the dealer button rotates clockwise. The player to the left posts the
              <span className="text-bone"> small blind</span>, the next posts the
              <span className="text-bone"> big blind</span>. These forced bets seed the pot
              and ensure there&apos;s action every hand.
            </p>
          </div>
        </div>
      </div>

      <div id="rules-actions-card" className="rounded-sm hairline bg-inkA overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between" style={{ background: 'linear-gradient(180deg, rgba(242,106,31,0.28) 0%, rgba(242,106,31,0.08) 100%)', borderBottom: '1px solid rgba(242,106,31,0.45)' }}>
          <div className="flex items-center gap-2.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber"/>
            <span className="font-display text-bone text-sm leading-none">YOUR ACTIONS</span>
          </div>
          <span className="font-mono text-[9px] text-boneDim/50 tracking-wider">ON YOUR TURN</span>
        </div>
        <div className="p-5">
          <div className="space-y-1">
            {actions.map(a => (
              <div key={a.k} className="grid grid-cols-[92px_1fr] gap-3 py-2.5 hairline-b last:border-b-0">
                <span className="font-display text-amber text-lg leading-none tracking-wide">{a.k.toUpperCase()}</span>
                <span className="font-mono text-[10px] text-boneDim/75 leading-relaxed">{a.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 02 · Hand rankings ──────────────────────────────────────────────
function HandRankingsSection() {
  return (
    <div className="rounded-sm hairline bg-inkA overflow-hidden">
      <div className="hidden md:grid grid-cols-[40px_1.4fr_1.8fr_200px_80px] gap-3 px-4 py-2.5 hairline-b bg-ink/40">
        <span className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em]">#</span>
        <span className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em]">HAND</span>
        <span className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em]">DESCRIPTION</span>
        <span className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em]">EXAMPLE</span>
        <span className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em] text-right">FREQUENCY</span>
      </div>
      {HAND_RANKINGS.map(h => (
        <div
          key={h.rank}
          className="md:grid md:grid-cols-[40px_1.4fr_1.8fr_200px_80px] md:gap-3 md:items-center px-4 py-3 hairline-b last:border-b-0 hover:bg-orange/[0.04] transition"
        >
          <div className="md:hidden flex items-baseline justify-between gap-3 mb-1">
            <div className="flex items-baseline gap-2">
              <span className={cn(
                'font-display text-2xl leading-none tabular-nums',
                h.rank <= 3 ? 'text-orange' : h.rank <= 6 ? 'text-amber/80' : 'text-boneDim/40'
              )}>{h.rank}</span>
              <span className="font-display text-bone text-base leading-none tracking-wide">{h.name.toUpperCase()}</span>
            </div>
            <span className="font-mono text-[10px] text-boneDim/60 tabular-nums shrink-0">{h.rarity}</span>
          </div>
          <span className={cn(
            'hidden md:block font-display text-2xl leading-none tabular-nums',
            h.rank <= 3 ? 'text-orange' : h.rank <= 6 ? 'text-amber/80' : 'text-boneDim/40'
          )}>{h.rank}</span>
          <div className="hidden md:flex flex-col gap-0.5">
            <span className="font-display text-bone text-base leading-none tracking-wide">{h.name.toUpperCase()}</span>
            {h.rank === 1 && <span className="font-mono text-[8px] text-orange tracking-wider">STRONGEST</span>}
            {h.rank === 10 && <span className="font-mono text-[8px] text-boneDim/50 tracking-wider">WEAKEST</span>}
          </div>
          <span className="font-mono text-[11px] text-boneDim/75 leading-relaxed block md:inline">{h.desc}</span>
          <span className="font-mono text-[11px] text-bone tabular-nums tracking-wider mt-2 md:mt-0 block md:inline">{h.example}</span>
          <span className="hidden md:block font-mono text-[10px] text-boneDim/50 tabular-nums text-right">{h.rarity}</span>
        </div>
      ))}
      <div className="px-4 py-2.5 bg-ink/30 font-mono text-[9px] text-boneDim/50 tracking-wider leading-relaxed">
        Frequency is the probability of making this hand in a random 5-card draw.
        Ties broken by kickers (higher unpaired cards). A ≥ K ≥ Q ≥ J ≥ T ... ≥ 2.
      </div>
    </div>
  );
}

// ─── 03 · Game modes ─────────────────────────────────────────────────
function ModeCard({
  accent, glyph, title, tagline, specs, tiers, tiersLabel = 'TIERS', footer,
}: {
  accent: 'orange' | 'amber';
  glyph: string;
  title: string;
  tagline: string;
  specs: { k: string; v: string }[];
  tiers: string[];
  tiersLabel?: string;
  footer: string;
}) {
  const accentCls = accent === 'amber' ? 'text-amber' : 'text-orange';
  const dotBg = accent === 'amber' ? 'bg-amber' : 'bg-orange';
  const tintBg = accent === 'amber' ? 'bg-amber/5' : 'bg-orange/5';
  return (
    <div className="rounded-sm hairline bg-inkA overflow-hidden flex flex-col">
      <div className="px-5 py-3 flex items-center justify-between" style={{ background: 'linear-gradient(180deg, rgba(242,106,31,0.28) 0%, rgba(242,106,31,0.08) 100%)', borderBottom: '1px solid rgba(242,106,31,0.45)' }}>
        <div className="flex items-center gap-2.5">
          <span className={cn('w-1.5 h-1.5 rounded-full', dotBg)}/>
          <span className="font-display text-bone text-sm leading-none tracking-wide">{title}</span>
        </div>
        <span className={cn('font-mono text-[9px] tracking-[0.18em] px-1.5 py-0.5 rounded-sm hairline', accentCls)}>{glyph}</span>
      </div>
      <div className="p-5 flex-1 flex flex-col">
        <p className="font-mono text-[11px] text-boneDim/70 leading-relaxed mb-4">{tagline}</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-4">
          {specs.map(s => (
            <div key={s.k} className="py-2 hairline-b">
              <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em] mb-0.5">{s.k.toUpperCase()}</div>
              <div className="font-mono text-[10px] text-bone leading-tight">{s.v}</div>
            </div>
          ))}
        </div>
        <div className="mt-auto">
          <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.18em] mb-2">{tiersLabel}</div>
          <div className="flex flex-wrap gap-1.5">
            {tiers.map(t => (
              <span
                key={t}
                className={cn(
                  'font-mono text-[9px] px-2 py-1 rounded-sm hairline tracking-wider',
                  accentCls,
                  tintBg,
                )}
              >
                {t}
              </span>
            ))}
          </div>
          <div className="font-mono text-[10px] text-boneDim/55 leading-relaxed mt-4 pt-3 border-t border-orange/10">{footer}</div>
        </div>
      </div>
    </div>
  );
}

function GameModesSection() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <ModeCard
        accent="orange"
        glyph="SNG"
        title="SIT & GO"
        tagline="Tournament-style, fixed buy-in, last one standing."
        specs={[
          { k: 'Buy-in',  v: 'Fixed SOL entry + fee' },
          { k: 'Players', v: '2 to 9 per table' },
          { k: 'Chips',   v: 'Virtual tournament chips' },
          { k: 'Blinds',  v: 'Escalate on a timer' },
          { k: 'Prizes',  v: 'Top finishers split pool' },
          { k: 'End',     v: 'Last player standing wins' },
        ]}
        tiers={['Copper','Bronze','Silver','Gold','Platinum','Diamond','Black']}
        footer="Every SNG mints unrefined $FP per seat. Every tier, including Copper, includes a SOL prize pool."
      />
      <ModeCard
        accent="amber"
        glyph="CASH"
        title="CASH GAMES"
        tagline="Any stakes, sit and leave anytime, real tokens."
        specs={[
          { k: 'Buy-in',  v: 'Normal 20-100 BB or deep 50-250 BB' },
          { k: 'Players', v: '2 to 9 per table' },
          { k: 'Chips',   v: '1:1 backed by deposit (PDA escrow)' },
          { k: 'Blinds',  v: 'Fixed (e.g. 0.005 / 0.01 SOL)' },
          { k: 'Stakes',  v: 'SOL, $FP, or any listed SPL token' },
          { k: 'Leave',   v: 'Cash out between hands, no lock' },
        ]}
        tiers={['SOL','$FP','USDC','Listed SPLs']}
        tiersLabel="DENOMINATIONS"
        footer="Create your own table or join an existing one from the lobby."
      />
    </div>
  );
}

// ─── 04 · Fees & rake ────────────────────────────────────────────────
function FeesSection() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div id="fees-cash-rake-card" className="rounded-sm hairline bg-inkA overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between" style={{ background: 'linear-gradient(180deg, rgba(242,106,31,0.28) 0%, rgba(242,106,31,0.08) 100%)', borderBottom: '1px solid rgba(242,106,31,0.45)' }}>
          <div className="flex items-center gap-2.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber"/>
            <span className="font-display text-bone text-sm leading-none">CASH TABLE RAKE</span>
          </div>
          <span className="font-mono text-[9px] text-boneDim/50 tracking-wider">5% OF POT</span>
        </div>
        <div className="p-5 space-y-5">
          <div>
            <div className="flex items-baseline gap-3 mb-1">
              <span className="font-display text-amber text-6xl leading-none tabular-nums">5%</span>
              <span className="font-mono text-[11px] text-boneDim/70">of every pot when the flop is reached</span>
            </div>
            <div className="font-mono text-[10px] text-boneDim/55 leading-relaxed mt-2">
              No rake on hands that end preflop. Rake is deducted from the pot before winnings are
              distributed, paid in whatever token the pot was played in.
            </div>
          </div>
          <div>
            <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em] mb-3">WHERE THE 5% GOES</div>
            <div className="flex h-2 rounded-sm overflow-hidden mb-3">
              <div style={{ width: '50%', background: '#FFC63A', opacity: 0.9 }}/>
              <div style={{ width: '20%', background: '#F26A1F', opacity: 0.85 }}/>
              <div style={{ width: '20%', background: '#34D399' }}/>
              <div style={{ width: '10%', background: '#A78BFA', opacity: 0.8 }}/>
            </div>
            <div className="space-y-1.5">
              <RakeRow color="#FFC63A" label="Table creator" pct="50%" note="whoever spun up the table"/>
              <RakeRow
                color="#F26A1F"
                label="Licensed dealers"
                pct="20%"
                note={
                  <>
                    {'→ '}
                    <a href={BRAND.social.docs} target="_blank" rel="noreferrer" className="text-orange hover:text-orangeHi underline decoration-orange/30">read the operator docs</a>
                  </>
                }
              />
              <RakeRow color="#34D399" label="Staker pool" pct="20%" note="routes to SOL / $FP / SPL vaults"/>
              <RakeRow color="#A78BFA" label="Platform Fee" pct="10%" note="protocol development + operations"/>
            </div>
          </div>
        </div>
      </div>

      <div id="fees-sng-card" className="rounded-sm hairline bg-inkA overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between" style={{ background: 'linear-gradient(180deg, rgba(242,106,31,0.28) 0%, rgba(242,106,31,0.08) 100%)', borderBottom: '1px solid rgba(242,106,31,0.45)' }}>
          <div className="flex items-center gap-2.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"/>
            <span className="font-display text-bone text-sm leading-none">SNG ENTRY FEES</span>
          </div>
          <span className="font-mono text-[9px] text-boneDim/50 tracking-wider">INCLUDED IN BUY-IN</span>
        </div>
        <div className="p-5 space-y-5">
          <div>
            <div className="flex items-baseline gap-3 mb-1">
              <span className="font-display text-emerald-300 text-6xl leading-none tabular-nums">45%</span>
              <span className="font-mono text-[11px] text-boneDim/70">of every SNG entry fee goes to the staker pool. Another 45% to licensed dealers, 10% to Platform Fee.</span>
            </div>
            <div className="font-mono text-[10px] text-boneDim/55 leading-relaxed mt-2">
              Each listed buy-in is split between the SOL prize pool and the protocol fee. The
              current SNG model takes a flat 10% fee; the remaining 90% funds prizes.
            </div>
          </div>
          <div>
            <div className="font-mono text-[9px] text-boneDim/60 tracking-[0.18em] mb-3">TIER ENTRY</div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { k: 'Copper',   v: '0.05 SOL', sub: '0.045 prize + 0.005 fee' },
                { k: 'Bronze',   v: '0.10 SOL', sub: '0.09 prize + 0.01 fee' },
                { k: 'Silver',   v: '0.25 SOL', sub: '0.225 prize + 0.025 fee' },
                { k: 'Gold',     v: '0.50 SOL', sub: '0.45 prize + 0.05 fee' },
                { k: 'Platinum', v: '1.00 SOL', sub: '0.90 prize + 0.10 fee' },
                { k: 'Diamond',  v: '2.00 SOL', sub: '1.80 prize + 0.20 fee' },
                { k: 'Black',    v: '5.00 SOL', sub: '4.50 prize + 0.50 fee' },
              ].map(t => (
                <div key={t.k} className="rounded-sm hairline bg-ink/30 p-2.5">
                  <div className="font-mono text-[9px] text-boneDim/55 tracking-wider">{t.k.toUpperCase()}</div>
                  <div className="font-mono text-[11px] text-bone tabular-nums mt-0.5">{t.v}</div>
                  <div className="font-mono text-[8px] text-boneDim/45 mt-0.5">{t.sub}</div>
                </div>
              ))}
            </div>
            <div className="font-mono text-[9px] text-boneDim/45 tracking-wider mt-2">Totals shown are the live public tier ladder.</div>
          </div>
        </div>
      </div>

      <div className="lg:col-span-2 rounded-sm hairline bg-inkA p-5">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] items-center gap-4">
          <div>
            <div className="font-mono text-[10px] tracking-[0.18em] text-orange/80 mb-1">EARN ON ALL OF IT</div>
            <div id="fees-earn-cta-headline" className="font-display text-bone text-xl leading-tight">Everything above flows to staker vaults.</div>
            <div className="font-mono text-[11px] text-boneDim/70 mt-1 leading-relaxed max-w-2xl">
              Cash rake, SNG entry fees, dealer license sales, token listing auctions.
              Burn $FP to claim a permanent share of every vault.
            </div>
          </div>
          <a
            href={BRAND.social.docs}
            target="_blank"
            rel="noreferrer"
            className="px-4 py-2.5 rounded-sm hairline bg-orange/10 border-orange/40 hover:bg-orange/20 hover:border-orange/60 font-mono text-[10px] tracking-[0.22em] text-orange transition whitespace-nowrap"
          >
            READ DOCS {'→'}
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── 05 · Provably fair ──────────────────────────────────────────────
function FairSection() {
  const pillars = [
    {
      k: 'TEE CARD DEALING',
      v: 'Cards are shuffled and dealt inside a Trusted Execution Environment, a hardware-secured enclave that produces provably random outcomes from slot hashes. No one (not even us) can predict or manipulate the deck.',
      tag: 'HARDWARE-SEALED',
    },
    {
      k: 'TEE HOLE-CARD PRIVACY',
      v: 'Your hole cards live inside the same enclave until showdown. The server never sees them. Opponents never see them. Only you, and only on your device.',
      tag: 'END-TO-END SEALED',
    },
    {
      k: 'EPHEMERAL ROLLUP',
      v: 'Game actions execute on a MagicBlock Ephemeral Rollup for instant, gasless play. Solana remains the settlement layer, with chips and hand flow verifiable on-chain.',
      tag: '< 50MS ACTIONS',
    },
    {
      k: 'PDA ESCROW',
      v: 'Cash-table deposits live in a program-owned account on Solana. Funds can only move according to the smart-contract rules. No custody, no rehypothecation, no human in the loop.',
      tag: 'NON-CUSTODIAL',
    },
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {pillars.map(p => (
        <div key={p.k} className="rounded-sm hairline bg-inkA overflow-hidden">
          <div className="px-5 py-3 flex items-center justify-between" style={{ background: 'linear-gradient(180deg, rgba(242,106,31,0.28) 0%, rgba(242,106,31,0.08) 100%)', borderBottom: '1px solid rgba(242,106,31,0.45)' }}>
            <div className="flex items-center gap-2.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"/>
              <span className="font-display text-bone text-sm leading-none tracking-wide">{p.k}</span>
            </div>
            <span className="font-mono text-[9px] text-emerald-400/80 tracking-wider px-1.5 py-0.5 rounded-sm bg-emerald-400/10 border border-emerald-400/20">{p.tag}</span>
          </div>
          <div className="p-5">
            <p className="font-mono text-[11px] text-boneDim/80 leading-relaxed">{p.v}</p>
          </div>
        </div>
      ))}
      <div className="md:col-span-2 rounded-sm hairline bg-inkA p-4 flex items-center gap-4">
        <svg className="w-10 h-10 text-emerald-400/80 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M12 2L4 6v6c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V6l-8-4z"/>
          <path d="M9 12l2 2 4-4"/>
        </svg>
        <div className="flex-1">
          <div className="font-mono text-[10px] tracking-[0.18em] text-emerald-400/80 mb-0.5">VERIFY ANY HAND</div>
          <div className="font-mono text-[11px] text-boneDim/75 leading-relaxed">
            Every hand leaves a cryptographic audit trail. Pull up the hand number and inspect the slot hash, shuffle commitment, and action trace.
          </div>
        </div>
        <a
          href={BRAND.social.docs}
          target="_blank"
          rel="noreferrer"
          className="px-4 py-2.5 rounded-sm hairline bg-emerald-400/10 border-emerald-400/40 hover:bg-emerald-400/20 hover:border-emerald-400/60 font-mono text-[10px] tracking-[0.22em] text-emerald-300 transition whitespace-nowrap"
        >
          READ VERIFIER DOCS {'→'}
        </a>
      </div>
    </div>
  );
}

// ─── 06 · Sessions ───────────────────────────────────────────────────
function SessionsSection() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-4">
      <div id="sessions-how-card" className="rounded-sm hairline bg-inkA overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between" style={{ background: 'linear-gradient(180deg, rgba(242,106,31,0.28) 0%, rgba(242,106,31,0.08) 100%)', borderBottom: '1px solid rgba(242,106,31,0.45)' }}>
          <div className="flex items-center gap-2.5">
            <span className="w-1.5 h-1.5 rounded-full bg-orange"/>
            <span className="font-display text-bone text-sm leading-none">HOW SESSIONS WORK</span>
          </div>
          <span className="font-mono text-[9px] text-boneDim/50 tracking-wider">GASLESS PLAY</span>
        </div>
        <div className="p-5 space-y-4">
          <p className="font-mono text-[11px] text-boneDim/80 leading-relaxed">
            FAST POKER uses <span className="text-bone">session keys</span> so you don&apos;t approve every
            check, call, and raise in your wallet. When you start a session, a temporary keypair is
            generated in your browser and registered on-chain. It can sign game actions on your behalf,
            but can&apos;t touch your wallet funds.
          </p>
          <div className="space-y-2">
            {[
              { num: '1', k: 'Create session', v: 'Browser generates a local keypair and registers it on-chain as your approved signer. No funding required, TEE play is gasless.' },
              { num: '2', k: 'Play gaslessly', v: 'Every action is signed by the session key, no wallet popup, no friction, sub-50ms latency in the Ephemeral Rollup.' },
              { num: '3', k: 'Extend or close', v: 'Rotate the key periodically for hygiene, or close early to revoke signing authority. Your wallet funds are untouched either way.' },
            ].map(s => (
              <div key={s.num} className="flex gap-3 p-3 rounded-sm hairline bg-ink/30">
                <span className="font-display text-orange/60 text-xl leading-none tabular-nums shrink-0 w-6 text-center">{s.num}</span>
                <div>
                  <div className="font-mono text-[11px] text-bone">{s.k}</div>
                  <div className="font-mono text-[10px] text-boneDim/60 leading-relaxed mt-0.5">{s.v}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div id="sessions-glance-card" className="rounded-sm hairline bg-inkA overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between" style={{ background: 'linear-gradient(180deg, rgba(242,106,31,0.28) 0%, rgba(242,106,31,0.08) 100%)', borderBottom: '1px solid rgba(242,106,31,0.45)' }}>
          <div className="flex items-center gap-2.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber"/>
            <span className="font-display text-bone text-sm leading-none">AT A GLANCE</span>
          </div>
          <span className="font-mono text-[9px] text-boneDim/50 tracking-wider">SESSION ACCOUNT</span>
        </div>
        <div className="p-5 space-y-3">
          <KV k="Cost to create"    v="None"          sub="on-chain registration only, no session fee"/>
          <KV k="Validity"          v="Until revoked" sub="remains valid until you rotate or close"/>
          <KV k="Action latency"    v="< 50 ms"       sub="via Ephemeral Rollup"/>
          <KV k="Wallet access"     v="None"          sub="game actions only, funds stay in your wallet"/>
          <KV k="Revoke"            v="Anytime"       sub="close the session to invalidate the key"/>
        </div>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────
export default function HowToPlayPage() {
  const [active, setActive] = useState(SECTIONS[0].id);

  useEffect(() => {
    const ids = SECTIONS.map(s => s.id);
    const onScroll = () => {
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 140) current = id;
      }
      setActive(current);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <main className="flex-1 max-w-[1400px] mx-auto w-full px-5 py-8 pb-32">
      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-8">
        <aside className="hidden lg:block">
          <div className="sticky top-20 glass-card rounded-lg p-4 space-y-1">
            <div className="font-mono text-[9px] text-boneDim/50 tracking-[0.22em] mb-3">CONTENTS</div>
            {SECTIONS.map(s => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className={cn(
                  'flex items-baseline gap-3 px-3 py-2 rounded-sm transition border-l-2',
                  active === s.id
                    ? 'bg-orange/[0.08] border-orange text-bone'
                    : 'border-transparent text-boneDim/60 hover:text-bone hover:bg-orange/[0.04] hover:border-orange/40',
                )}
              >
                <span className="font-mono text-[9px] text-orange/70 tabular-nums tracking-wider w-5">{s.num}</span>
                <span className="font-mono text-[11px] tracking-wider">{s.label}</span>
              </a>
            ))}
            <div className="pt-6 mt-6 border-t border-orange/10">
              <div className="font-mono text-[9px] text-boneDim/50 tracking-[0.22em] mb-2">RELATED</div>
              <a href={BRAND.social.docs} target="_blank" rel="noreferrer" className="block px-3 py-2 rounded-sm hairline bg-ink/30 hover:bg-orange/10 transition">
                <div className="font-mono text-[10px] text-orange tracking-wider">DOCS {'→'}</div>
                <div className="font-mono text-[9px] text-boneDim/55 mt-0.5">Public setup and economics</div>
              </a>
              <Link href="/lobby" className="block px-3 py-2 rounded-sm hairline bg-ink/30 hover:bg-orange/10 transition mt-2">
                <div className="font-mono text-[10px] text-orange tracking-wider">LOBBY {'→'}</div>
                <div className="font-mono text-[9px] text-boneDim/55 mt-0.5">Find a game</div>
              </Link>
              <a
                href={BRAND.social.docs}
                target="_blank"
                rel="noopener noreferrer"
                className="block px-3 py-2 rounded-sm hairline bg-ink/30 hover:bg-orange/10 transition mt-2"
              >
                <div className="font-mono text-[10px] text-orange tracking-wider">DOCS {'↗'}</div>
                <div className="font-mono text-[9px] text-boneDim/55 mt-0.5">Guides & protocol reference</div>
              </a>
            </div>
          </div>
        </aside>

        <div className="space-y-10">
          <HowToHero/>

          <section id="rules">
            <SectionHeader
              eyebrow="01 · BASIC RULES"
              title="How a hand plays out"
              subtitle="Texas Hold'em is played with a standard 52-card deck. Two hole cards per player, five community cards on the board, five betting rounds."
            />
            <RulesSection/>
          </section>

          <section id="rankings">
            <SectionHeader
              eyebrow="02 · HAND RANKINGS"
              title="Strongest to weakest"
              subtitle="Ten hand types. Lower rank number beats higher. Frequency is the probability of making that hand in any random 5-card draw."
            />
            <HandRankingsSection/>
          </section>

          <section id="modes">
            <SectionHeader
              eyebrow="03 · GAME MODES"
              title="Tournaments & cash"
              subtitle="Pick your format. SNG tournaments pay top finishers and emit $FP at higher tiers. Cash games let you sit and leave whenever in any listed token."
            />
            <GameModesSection/>
          </section>

          <section id="fees">
            <SectionHeader
              eyebrow="04 · FEES & RAKE"
              title="Where the 5% rake flows"
              subtitle="Cash games rake 5% of every post-flop pot. SNGs charge an entry fee on top of the buy-in. Only 10% of the rake goes to Platform Fee. The rest flows to the table creator, licensed dealers, and the staker pool."
            />
            <FeesSection/>
            <div className="mt-3">
              <Link
                href={BRAND.social.docs}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-sm hairline bg-orange/[0.04] hover:bg-orange/[0.08] transition font-mono text-[10px] tracking-[0.18em] text-orange"
              >
                READ THE PUBLIC DOCS &rarr;
              </Link>
            </div>
          </section>

          <section id="fair">
            <SectionHeader
              eyebrow="05 · PROVABLY FAIR"
              title="Trust nothing, verify everything"
              subtitle="Cards dealt in hardware-sealed enclaves. Funds in program-owned escrow. Every action settles to Solana L1."
            />
            <FairSection/>
          </section>

          <section id="sessions">
            <SectionHeader
              eyebrow="06 · SESSION KEYS"
              title="Play without the wallet popup"
              subtitle="A temporary keypair signs your game actions so you're not approving every check and call. It can't touch your funds, only play your hands."
            />
            <SessionsSection/>
          </section>
        </div>
      </div>
    </main>
  );
}
