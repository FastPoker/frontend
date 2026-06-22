// Dev-only hook: expose live game state on `window.__GAMESTATE__` so
// Playwright E2E specs can synchronize against on-chain state shape instead
// of fragile DOM polling.
//
// Production builds short-circuit at the env check — no global is set.
//
// Usage in PokerTable / useOnChainGame: call `publishGameState(state)` on
// every state transition. Playwright tests read via:
//   await page.waitForFunction(() => window.__GAMESTATE__?.phase === 'PreFlop')

import type { OnChainGameState } from '@/hooks/useOnChainGame';

declare global {
  interface Window {
    __GAMESTATE__?: OnChainGameState | null;
    __GAMESTATE_TIMELINE__?: Array<{ at: number; state: OnChainGameState }>;
  }
}

const isDev = process.env.NODE_ENV !== 'production';
const HISTORY_CAP = 100;

/**
 * Publish the current game state to window.__GAMESTATE__ for E2E inspection.
 * No-op in production builds. Maintains a bounded history at
 * __GAMESTATE_TIMELINE__ for race-condition debugging.
 */
export function publishGameState(state: OnChainGameState | null): void {
  if (!isDev || typeof window === 'undefined') return;
  window.__GAMESTATE__ = state;
  if (!state) return;
  const tl = window.__GAMESTATE_TIMELINE__ ?? [];
  tl.push({ at: Date.now(), state });
  if (tl.length > HISTORY_CAP) tl.shift();
  window.__GAMESTATE_TIMELINE__ = tl;
}

/** Clear the published state — useful on table-leave or component unmount. */
export function clearGameState(): void {
  if (!isDev || typeof window === 'undefined') return;
  window.__GAMESTATE__ = null;
}
