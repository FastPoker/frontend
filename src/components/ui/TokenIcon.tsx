'use client';

import Image from 'next/image';
import { useTokenLogo } from '@/hooks/useTokenLogo';

const SOL_B58 = '11111111111111111111111111111111';

interface TokenIconProps {
  mint?: string;
  size?: number;
  className?: string;
  alt?: string;
}

export function TokenIcon({ mint, size = 14, className, alt = '' }: TokenIconProps) {
  const src = useTokenLogo(mint);
  return (
    <Image
      src={src}
      alt={alt}
      width={size}
      height={size}
      unoptimized
      className={className}
      style={{ width: size, height: size, display: 'inline-block', verticalAlign: '-2px', flexShrink: 0 }}
    />
  );
}

export function SolIcon({ size = 14, className, alt = 'SOL' }: Omit<TokenIconProps, 'mint'>) {
  return <TokenIcon mint={SOL_B58} size={size} className={className} alt={alt} />;
}
