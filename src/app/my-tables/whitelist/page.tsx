'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import WhitelistManager from './WhitelistManager';

function WhitelistFromQuery() {
  const searchParams = useSearchParams();
  return <WhitelistManager tableId={searchParams.get('id') ?? ''} />;
}

export default function WhitelistPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-[#0a0a0f] text-white">
          <div className="max-w-2xl mx-auto px-4 py-8 text-boneDim/70 text-sm">Loading...</div>
        </main>
      }
    >
      <WhitelistFromQuery />
    </Suspense>
  );
}
