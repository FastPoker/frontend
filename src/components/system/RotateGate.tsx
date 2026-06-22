'use client';

import { useCallback, useSyncExternalStore } from 'react';

// Phones held in landscape with very little vertical room. The `pointer: coarse`
// clause keeps short desktop windows from ever tripping this, and tablets in
// landscape are taller than 500px so they pass through untouched. Only touch
// phones turned sideways match.
const PHONE_LANDSCAPE_MQ =
  '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)';

function usePhoneLandscape(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia(PHONE_LANDSCAPE_MQ);
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  }, []);
  const getSnapshot = useCallback(() => window.matchMedia(PHONE_LANDSCAPE_MQ).matches, []);
  const getServerSnapshot = useCallback(() => false, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Temporary landscape lock. Landscape support is mid-rework, so for now a phone
 * held sideways gets a full-screen "rotate to portrait" prompt instead of the
 * broken landscape layout. Self-gates via media query, rendering nothing on
 * desktop, tablets, or portrait, and nothing on the server.
 */
export function RotateGate() {
  const phoneLandscape = usePhoneLandscape();
  if (!phoneLandscape) return null;
  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-5 px-8 text-center"
      style={{ background: '#050608' }}
    >
      <svg
        viewBox="0 0 24 24"
        className="w-12 h-12 text-orange animate-pulse"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="8" y="2.5" width="8" height="19" rx="1.6" />
        <path d="M11 18.5h2" />
        <path d="M3 9a9 9 0 0 1 4-4" />
        <path d="M3 5v4h4" />
      </svg>
      <div>
        <h2 className="font-display text-3xl tracking-wide text-bone leading-none">ROTATE YOUR DEVICE</h2>
        <p className="mt-2 font-mono text-[10px] tracking-[0.3em] text-orange/80">PORTRAIT MODE</p>
      </div>
      <p className="max-w-xs text-sm text-boneDim/80 leading-relaxed">
        Fast Poker is built for portrait right now. Turn your phone upright to keep playing. Landscape is coming soon.
      </p>
    </div>
  );
}
