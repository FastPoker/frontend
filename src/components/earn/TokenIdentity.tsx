'use client';

import Image from 'next/image';
import { useTokenMeta } from '@/hooks/useTokenMeta';
import { cn } from '@/lib/utils';

export interface TokenIdentityProps {
  /** Base58 token mint address. */
  mint: string;
  /** Compact form without logo. Used in dense table cells. */
  compact?: boolean;
  className?: string;
}

/**
 * Canonical token display for the rake vaults surface. Shows the token
 * logo (if registry-resolved) plus symbol or shortened address. Fully
 * client-side: token metadata is resolved via the standalone useTokenMeta
 * reader, not a server route.
 */
export function TokenIdentity({ mint, compact, className }: TokenIdentityProps) {
  const meta = useTokenMeta(mint);
  const symbol = meta?.symbol ?? shortMint(mint);
  const logo = meta?.logoURI;

  if (compact) {
    return (
      <span
        className={cn('font-mono text-xs text-bone', className)}
        title={mint}
      >
        {symbol}
      </span>
    );
  }

  return (
    <span
      className={cn('inline-flex items-center gap-2', className)}
      title={mint}
    >
      {logo ? (
        <Image
          src={logo}
          alt=""
          width={20}
          height={20}
          className="rounded-full bg-ink"
          unoptimized
        />
      ) : (
        <span className="h-5 w-5 rounded-full bg-ink" aria-hidden />
      )}
      <span className="font-mono text-xs text-bone">{symbol}</span>
    </span>
  );
}

function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}
