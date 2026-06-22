'use client';

// Buffer.prototype.readBigUInt64LE / writeBigUInt64LE polyfill — runs at the
// client-tree entry point so EVERY route (incl. ones that don't mount the full
// `Providers` dynamic chunk) gets the patched Buffer prototype before any
// account-decoding call.
import '@/lib/buffer-polyfill';

import dynamic from 'next/dynamic';

export const Providers = dynamic(
  () => import('./providers').then((mod) => ({ default: mod.Providers })),
  { ssr: false },
);
