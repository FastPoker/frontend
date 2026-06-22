'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

// Generative 8x8 symmetric deterministic identicon.
// Ported from Mockup 1.4 parts/avatar.jsx. Palettes tuned to the bone/orange/ink palette
// with one muted accent hue per avatar.

const AVATAR_PALETTES = [
  { bg: '#1a1a2a', fg: '#C9A84C', accent: '#E2C36A', eye: '#070710' },
  { bg: '#0e1a1a', fg: '#8FB39A', accent: '#C8D9C6', eye: '#070710' },
  { bg: '#1a0e1a', fg: '#B98FB3', accent: '#D9C6D4', eye: '#070710' },
  { bg: '#1a1210', fg: '#C9965C', accent: '#E2B97C', eye: '#070710' },
  { bg: '#0e1420', fg: '#8FA5C9', accent: '#C6D2E2', eye: '#070710' },
  { bg: '#20140e', fg: '#C98F5C', accent: '#E2B47C', eye: '#070710' },
  { bg: '#1a1a20', fg: '#A89AC9', accent: '#C6C0E2', eye: '#070710' },
  { bg: '#10201a', fg: '#5CC99C', accent: '#7CE2B4', eye: '#070710' },
];

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

interface PixelAvatarProps {
  seed?: string;
  size?: number;
  gridSize?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function PixelAvatar({
  seed = 'x',
  size = 40,
  gridSize = 8,
  className,
  style,
}: PixelAvatarProps) {
  const cells = useMemo(() => {
    const r = rng(hash32(seed || 'x'));
    const pal = AVATAR_PALETTES[Math.floor(r() * AVATAR_PALETTES.length)];
    const half = Math.ceil(gridSize / 2);
    const grid: (string | null)[][] = [];
    for (let y = 0; y < gridSize; y++) {
      const row: (string | null)[] = [];
      for (let x = 0; x < half; x++) {
        const edge = x === 0 || y === 0 || y === gridSize - 1;
        const p = edge ? 0.35 : 0.55;
        const on = r() < p;
        const accent = on && r() < 0.12;
        row.push(on ? (accent ? 'a' : 'f') : null);
      }
      const full = row.concat([...row].reverse().slice(gridSize % 2 === 0 ? 0 : 1));
      grid.push(full);
    }
    const eyeRow = Math.floor(gridSize * 0.4);
    const eyeCol = Math.floor(gridSize * 0.28);
    grid[eyeRow][eyeCol] = 'e';
    grid[eyeRow][gridSize - 1 - eyeCol] = 'e';
    return { grid, pal };
  }, [seed, gridSize]);

  return (
    <div
      className={cn('pixel-avatar relative overflow-hidden', className)}
      style={{
        width: size,
        height: size,
        background: cells.pal.bg,
        borderRadius: Math.round(size * 0.22),
        ...style,
      }}
    >
      <svg
        viewBox={`0 0 ${gridSize} ${gridSize}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
      >
        {cells.grid.flatMap((row, y) =>
          row.map((v, x) => {
            if (!v) return null;
            const fill =
              v === 'f' ? cells.pal.fg : v === 'a' ? cells.pal.accent : cells.pal.eye;
            return (
              <rect
                key={`${x}-${y}`}
                x={x}
                y={y}
                width={1.02}
                height={1.02}
                fill={fill}
              />
            );
          }),
        )}
      </svg>
    </div>
  );
}
