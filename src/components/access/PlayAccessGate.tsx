import type { ReactNode } from 'react';

/**
 * Standalone build: no play-access gating (that was a fast.poker wave/DB feature).
 * This is a passthrough so any wallet can play immediately.
 */
export function PlayAccessGate({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
