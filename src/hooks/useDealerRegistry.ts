'use client';

import { useEffect, useState } from 'react';

import { makeL1Connection } from '@/lib/constants';
import {
  calcLicensePrice,
  getRegistryPda,
  parseRegistry,
  type DealerRegistryView,
} from '@/lib/dealer-license';

export interface DealerRegistryRead extends DealerRegistryView {
  nextPriceLamports: number;
  loading: boolean;
  errored: boolean;
}

/**
 * Light, fully client-side reader for the DealerRegistry PDA. One single-account
 * getAccountInfo (NOT a getProgramAccounts scan), so it works on the free public
 * pool. No polling: the registry moves slowly and remounts pick up the latest.
 */
export function useDealerRegistry(): DealerRegistryRead {
  const [view, setView] = useState<DealerRegistryView | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const conn = makeL1Connection();
    const [registryPda] = getRegistryPda();
    conn
      .getAccountInfo(registryPda)
      .then((info) => {
        if (cancelled) return;
        if (!info) {
          setView({ totalSold: 0, totalRevenue: 0 });
          return;
        }
        const parsed = parseRegistry(Buffer.from(info.data));
        if (parsed) setView(parsed);
        else setErrored(true);
      })
      .catch(() => {
        if (!cancelled) setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const totalSold = view?.totalSold ?? 0;
  const totalRevenue = view?.totalRevenue ?? 0;
  const nextPriceLamports = calcLicensePrice(totalSold);

  return {
    totalSold,
    totalRevenue,
    nextPriceLamports,
    loading: view === null && !errored,
    errored,
  };
}
