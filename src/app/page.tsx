'use client';

import { useEffect } from 'react';

// The pre-launch early-access / waitlist landing has been retired. Launch is
// live, so the root sends players straight to the lobby. Use a hard browser
// navigation instead of next/navigation redirect here: the App Router redirect
// from "/" to "/lobby" can trip a router-level hook-order error during client
// hydration/cached transitions.
export default function Home() {
  useEffect(() => {
    window.location.replace('/lobby');
  }, []);

  return (
    <main className="min-h-screen w-full flex items-center justify-center px-4">
      <div className="w-8 h-8 border-2 border-orange/30 border-t-orange rounded-full animate-spin" />
    </main>
  );
}
