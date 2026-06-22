'use client';

import { CURATED_AVATARS } from '@/lib/profile-data';
import { PixelAvatar } from './PixelAvatar';
import { CuratedAvatar } from './CuratedAvatar';
import { NftAvatar } from './NftAvatar';

export type AvatarType = 'generated' | 'curated' | 'nft';

export interface AvatarSelection {
  type: AvatarType;
  value: string;
  collection?: string;
  seed?: string;
}

export interface NftResolution {
  imageUrl?: string | null;
  collectionColor?: string;
}

interface AvatarRenderProps {
  avatar: AvatarSelection;
  size?: number;
  nft?: NftResolution; // pre-resolved NFT details when type === 'nft'
  className?: string;
}

export function AvatarRender({ avatar, size = 48, nft, className }: AvatarRenderProps) {
  if (avatar.type === 'curated') {
    const data = CURATED_AVATARS.find((a) => a.id === avatar.value);
    if (data) return <CuratedAvatar data={data} size={size} className={className} />;
  }
  if (avatar.type === 'nft') {
    return (
      <NftAvatar
        imageUrl={nft?.imageUrl ?? null}
        seed={avatar.seed || avatar.value}
        size={size}
        collectionColor={nft?.collectionColor || '#F26A1F'}
        className={className}
      />
    );
  }
  return (
    <PixelAvatar
      seed={avatar.value || 'you-wallet'}
      size={size}
      className={className}
    />
  );
}
