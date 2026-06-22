'use client';

import type { CuratedAvatarData } from '@/lib/profile-data';

interface CuratedAvatarProps {
  data: CuratedAvatarData;
  size?: number;
  className?: string;
}

export function CuratedAvatar({ data, size = 48, className }: CuratedAvatarProps) {
  const cells = data.grid.split('');
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        width: size,
        height: size,
        background: data.colors[0],
        borderRadius: Math.round(size * 0.22),
      }}
    >
      <svg viewBox="0 0 8 8" width={size} height={size} shapeRendering="crispEdges">
        {cells.map((ch, i) => {
          if (ch === '.') return null;
          const idx = parseInt(ch, 10);
          if (isNaN(idx) || idx === 0) return null;
          const fill = data.colors[idx] || data.colors[1];
          const x = i % 8;
          const y = Math.floor(i / 8);
          return <rect key={i} x={x} y={y} width={1.02} height={1.02} fill={fill} />;
        })}
      </svg>
    </div>
  );
}
