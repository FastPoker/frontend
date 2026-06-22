'use client';

import { useSyncExternalStore } from 'react';

export type DeckColors = '2color' | '4color';
export type CardFont = 'display' | 'serif' | 'mono' | 'cards' | 'bigez';
export type HeroPosition = 'left' | 'center' | 'table';
export type CardSize = 'small' | 'default' | 'large' | 'xl';
/** A bet-sizing preset: either a percent-of-pot ('pot') or a big-blind
 *  multiple ('bb', value × big blind). */
export interface BetPreset { kind: 'pot' | 'bb'; value: number; }

export interface CardPrefs {
  deckColors: DeckColors;
  cardFont: CardFont;
  heroPosition: HeroPosition;
  /** Bet-sizing presets on the strip — each is a percent-of-pot ('pot') or a
   *  big-blind multiple ('bb'). ALL-IN is always pinned at the end and not
   *  stored here. Default: 1 pot + 2×BB + 3×BB. Legacy number[] (pot-%) is
   *  migrated to {kind:'pot'} by sanitizeBetPresets. */
  betPresets: BetPreset[];
  /** When true, render SOL amounts as USD on the table (cash games only).
   *  Uses the live CoinGecko price via usePrices(). SPL-token games are
   *  unaffected today — they need a per-token price oracle to convert. */
  showFiat: boolean;
  /** Hero card scale. Affects only the hero's hole cards (rail + felt), not
   *  opponent cards or the community board. */
  cardSize: CardSize;
  /** Bottom-corner rank/suit orientation. Standard playing cards rotate the
   *  bottom corners 180° (so they read from the opposite side), which makes 6
   *  and 9 visually swap. When true, both corners stay upright so a 6 always
   *  reads as 6 and a 9 always reads as 9. */
  uprightCorners: boolean;
}

export const BET_PRESET_DEFAULTS: BetPreset[] = [
  { kind: 'pot', value: 100 },
  { kind: 'bb', value: 2 },
  { kind: 'bb', value: 3 },
];
export const BET_PRESET_MIN_COUNT = 2;
export const BET_PRESET_MAX_COUNT = 8;
export const BET_PRESET_MIN_PCT = 1;
export const BET_PRESET_MAX_PCT = 1000;
export const BET_PRESET_MIN_BB = 1;
export const BET_PRESET_MAX_BB = 500;

const STORAGE_KEY = 'fastpoker:card-prefs:v1';
// One-time marker: reset stale custom bet presets to BET_PRESET_DEFAULTS once.
// Earlier builds saved percent-based presets that render a "%" quick-bet button;
// this clears them to POT/2BB/3BB without disturbing other card prefs.
const BET_PRESETS_MIGRATION_KEY = 'fastpoker:card-prefs:betpresets-v2';

const DEFAULTS: CardPrefs = {
  deckColors: '2color',
  cardFont: 'display',
  heroPosition: 'left',
  betPresets: [...BET_PRESET_DEFAULTS],
  showFiat: false,
  cardSize: 'default',
  uprightCorners: false,
};

function sanitizeBetPresets(raw: unknown): BetPreset[] {
  if (!Array.isArray(raw)) return [...BET_PRESET_DEFAULTS];
  const out: BetPreset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let p: BetPreset | null = null;
    if (typeof item === 'number') {
      // Legacy pot-% number → migrate to a 'pot' preset.
      const v = Math.round(item);
      if (Number.isFinite(v) && v >= BET_PRESET_MIN_PCT && v <= BET_PRESET_MAX_PCT) p = { kind: 'pot', value: v };
    } else if (item && typeof item === 'object') {
      const k = (item as { kind?: unknown }).kind;
      const v = Math.round(Number((item as { value?: unknown }).value));
      if (k === 'bb' && Number.isFinite(v) && v >= BET_PRESET_MIN_BB && v <= BET_PRESET_MAX_BB) p = { kind: 'bb', value: v };
      else if (k === 'pot' && Number.isFinite(v) && v >= BET_PRESET_MIN_PCT && v <= BET_PRESET_MAX_PCT) p = { kind: 'pot', value: v };
    }
    if (!p) continue;
    const key = `${p.kind}:${p.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  if (out.length < BET_PRESET_MIN_COUNT) return [...BET_PRESET_DEFAULTS];
  // pot presets first (ascending), then bb presets (ascending).
  out.sort((a, b) => (a.kind === b.kind ? a.value - b.value : a.kind === 'pot' ? -1 : 1));
  return out.slice(0, BET_PRESET_MAX_COUNT);
}

function sanitize(raw: Partial<CardPrefs> | null | undefined): CardPrefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const deckColors: DeckColors = raw.deckColors === '4color' ? '4color' : '2color';
  const cardFont: CardFont =
    raw.cardFont === 'serif' || raw.cardFont === 'mono'
    || raw.cardFont === 'cards' || raw.cardFont === 'bigez'
      ? raw.cardFont
      : 'display';
  // 'center' was retired; migrate any stored value to 'left'. Only 'left' and
  // 'table' are selectable now.
  const heroPosition: HeroPosition =
    raw.heroPosition === 'table' ? 'table' : 'left';
  const betPresets = sanitizeBetPresets(raw.betPresets);
  const showFiat = raw.showFiat === true;
  const cardSize: CardSize =
    raw.cardSize === 'small' || raw.cardSize === 'large' || raw.cardSize === 'xl'
      ? raw.cardSize
      : 'default';
  const uprightCorners = raw.uprightCorners === true;
  return { deckColors, cardFont, heroPosition, betPresets, showFiat, cardSize, uprightCorners };
}

let cached: CardPrefs | null = null;
const listeners = new Set<() => void>();

function readFromStorage(): CardPrefs {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const prefs = raw ? sanitize(JSON.parse(raw) as Partial<CardPrefs>) : { ...DEFAULTS };
    // One-time bet-presets reset: clear stale custom presets (e.g. a percent
    // preset that shows a "%" quick-bet button) to the current POT/2BB/3BB
    // defaults. Runs once per browser, leaves all other card prefs intact, and
    // any presets the user sets afterwards persist normally.
    if (window.localStorage.getItem(BET_PRESETS_MIGRATION_KEY) !== '1') {
      prefs.betPresets = [...BET_PRESET_DEFAULTS];
      try {
        window.localStorage.setItem(BET_PRESETS_MIGRATION_KEY, '1');
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      } catch { /* quota / private mode — non-fatal */ }
    }
    return prefs;
  } catch {
    return { ...DEFAULTS };
  }
}

function applyToDocument(prefs: CardPrefs): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-deck-colors', prefs.deckColors);
  root.setAttribute('data-card-font', prefs.cardFont);
  root.setAttribute('data-hero-position', prefs.heroPosition);
  root.setAttribute('data-upright-corners', prefs.uprightCorners ? 'on' : 'off');
}

export function getCardPrefs(): CardPrefs {
  if (cached) return cached;
  cached = readFromStorage();
  applyToDocument(cached);
  return cached;
}

export function setCardPrefs(updates: Partial<CardPrefs>): void {
  const next = sanitize({ ...getCardPrefs(), ...updates });
  cached = next;
  applyToDocument(next);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* quota / private mode — non-fatal */
    }
  }
  listeners.forEach(fn => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): CardPrefs {
  return getCardPrefs();
}

function getServerSnapshot(): CardPrefs {
  return DEFAULTS;
}

export function useCardPrefs(): CardPrefs {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
