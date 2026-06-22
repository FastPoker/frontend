'use client';

import { useMemo } from 'react';

interface NftPlaceholderProps {
  seed: string;
  size?: number;
  collectionColor?: string;
  className?: string;
}

export function NftPlaceholder({
  seed,
  size = 72,
  collectionColor = '#F26A1F',
  className,
}: NftPlaceholderProps) {
  const n = useMemo(() => {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }, [seed]);
  const patternType = n % 4;
  const hue = (n >> 3) % 360;
  const hue2 = (hue + 40) % 360;
  const gradId = `nft-g-${seed.replace(/[^a-z0-9]/gi, '')}-${n}`;

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
      <svg width={size} height={size} viewBox="0 0 100 100">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={`hsl(${hue} 60% 42%)`} />
            <stop offset="100%" stopColor={`hsl(${hue2} 55% 18%)`} />
          </linearGradient>
        </defs>
        <rect width="100" height="100" fill={`url(#${gradId})`} />
        {patternType === 0 &&
          Array.from({ length: 6 }).map((_, i) => (
            <circle
              key={i}
              cx={20 + (i % 3) * 30}
              cy={25 + Math.floor(i / 3) * 50}
              r="10"
              fill={collectionColor}
              opacity="0.55"
            />
          ))}
        {patternType === 1 && (
          <polygon points="50,15 85,50 50,85 15,50" fill={collectionColor} opacity="0.75" />
        )}
        {patternType === 2 &&
          Array.from({ length: 5 }).map((_, i) => (
            <rect
              key={i}
              x={15 + i * 15}
              y="30"
              width="10"
              height="40"
              fill={collectionColor}
              opacity={0.3 + i * 0.15}
            />
          ))}
        {patternType === 3 && (
          <g>
            <circle cx="50" cy="40" r="15" fill={collectionColor} opacity="0.8" />
            <rect x="35" y="60" width="30" height="25" fill={collectionColor} opacity="0.5" />
          </g>
        )}
        <circle cx="38" cy="45" r="3" fill="#070710" />
        <circle cx="62" cy="45" r="3" fill="#070710" />
        <path
          d={`M 38 ${60 + (n % 10)} Q 50 ${66 + (n % 6)} 62 ${60 + (n % 10)}`}
          stroke="#070710"
          strokeWidth="2"
          fill="none"
        />
      </svg>
    </div>
  );
}
