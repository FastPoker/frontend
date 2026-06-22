'use client';

import Image from 'next/image';
import { useState } from 'react';
import { NftPlaceholder } from './NftPlaceholder';

interface NftAvatarProps {
  imageUrl?: string | null;
  seed: string;
  size?: number;
  collectionColor?: string;
  className?: string;
}

// Renders a wallet-held NFT image. Falls back to procedural placeholder if no URL
// is provided or the image fails to load.
export function NftAvatar({
  imageUrl,
  seed,
  size = 72,
  collectionColor = '#F26A1F',
  className,
}: NftAvatarProps) {
  const [broken, setBroken] = useState(false);

  if (!imageUrl || broken) {
    return (
      <NftPlaceholder
        seed={seed}
        size={size}
        collectionColor={collectionColor}
        className={className}
      />
    );
  }

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 2,
        width: size,
        height: size,
      }}
    >
      <Image
        src={imageUrl}
        alt=""
        width={size}
        height={size}
        unoptimized
        onError={() => setBroken(true)}
        style={{ width: size, height: size, objectFit: 'cover' }}
      />
    </div>
  );
}
