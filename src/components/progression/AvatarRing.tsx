'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils';

export type TierKey = 'none' | 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'obsidian';

export interface Tier {
  key: TierKey;
  name: string;
  color: string;
  glow: string;
  ring: string;
  accent: string;
  minLevel: number;
}

export function tierForLevel(lvl: number): Tier {
  if (lvl >= 50) return { key: 'obsidian', name: 'OBSIDIAN', color: '#B990FF', glow: '#F0D6FF', ring: '#D8B4FE', accent: '#6EE7F0', minLevel: 50 };
  if (lvl >= 35) return { key: 'diamond',  name: 'DIAMOND',  color: '#6EE7F0', glow: '#9DF0F5', ring: '#BFF5FA', accent: '#B990FF', minLevel: 35 };
  if (lvl >= 20) return { key: 'platinum', name: 'PLATINUM', color: '#D9D9D9', glow: '#FFFFFF', ring: '#F5F5F5', accent: '#B3A8E0', minLevel: 20 };
  if (lvl >= 10) return { key: 'gold',     name: 'GOLD',     color: '#F2C36A', glow: '#FFD96A', ring: '#FFE08A', accent: '#F26A1F', minLevel: 10 };
  if (lvl >= 5)  return { key: 'silver',   name: 'SILVER',   color: '#C0C8D0', glow: '#E0E8F0', ring: '#D6DDE4', accent: '#8FA0B0', minLevel: 5 };
  if (lvl >= 1)  return { key: 'bronze',   name: 'BRONZE',   color: '#B98558', glow: '#D9A374', ring: '#D9A374', accent: '#8B5A2B', minLevel: 1 };
  return            { key: 'none',       name: 'ROOKIE',   color: '#6a6578', glow: '#6a6578', ring: '#3a3a44', accent: '#3a3a44', minLevel: 0 };
}

/**
 * Cumulative XP thresholds. Index = level, value = total XP required to reach
 * that level. Level 0 = 0 XP (bootstrap), level 1 = 100, etc. The ladder is
 * finite - once a wallet exceeds the last threshold we extrapolate with 1.4x
 * growth so UI never divides by zero.
 */
export const LEVEL_THRESHOLDS: number[] = [
  0, 0, 100, 300, 600, 1100, 2000, 3500, 6000, 10000, 20000, 40000, 80000, 150000,
];

/** Total XP required for `level` (cumulative). Extrapolates past the table. */
export function xpForLevel(level: number): number {
  if (level <= 0) return 0;
  if (level < LEVEL_THRESHOLDS.length) return LEVEL_THRESHOLDS[level];
  const last = LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
  const over = level - (LEVEL_THRESHOLDS.length - 1);
  return Math.round(last * Math.pow(1.4, over));
}

/** Level corresponding to a given total XP, by walking the threshold ladder. */
export function levelFromXp(xp: number): number {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 1; i--) {
    if (xp >= LEVEL_THRESHOLDS[i]) return i;
  }
  return 1;
}

/**
 * XP span for the current level - i.e. threshold(level+1) - threshold(level).
 * This is the denominator every progress bar SHOULD use against xpInLevel.
 */
export function xpSpanForLevel(level: number): number {
  return Math.max(1, xpForLevel(level + 1) - xpForLevel(level));
}

/**
 * Legacy export - kept so existing callers compile, now aliased to the
 * per-level span from the threshold table so all UIs agree.
 */
export const LEVEL_XP = (lvl: number) => xpSpanForLevel(lvl);

interface AvatarRingProps {
  size?: number;
  level: number;
  xp: number;
  seed: string;
  avatarSrc?: string | null;
  avatarLabel?: string;
  frameAnim?: 'off' | 'subtle' | 'full';
  /** Custom inner node (e.g. PixelAvatar, NftAvatar). Takes precedence over avatarSrc. */
  innerNode?: React.ReactNode;
  /**
   * Cosmetic frame override. When set to anything other than 'default' or undefined,
   * replaces the auto-tier ring with the named treatment. See profile-data.FRAMES.
   */
  frame?:
    | 'default'
    | 'silver-ring'
    | 'gold-laurel'
    | 'plat-octogram'
    | 'prism-diamond'
    | 'matte-black'
    | 'royal-flush'
    | 'monster-bone'
    | 'infinite-loop'
    | 'early-bird';
  /**
   * Matte-black bezel preset — each render surface (nav pill / profile pill
   * dropdown / avatar picker tile / table seat) has fully independent
   * hardcoded geometry. No shared formula. Default = 'nav' (legacy).
   */
  mattePreset?: 'nav' | 'dropdown' | 'picker' | 'seat';
}

/**
 * Tier-framed avatar with XP progress arc and level chip.
 * Ported from template progression.jsx so level/XP reads identically in
 * the nav, profile page, and dropdowns.
 */
export function AvatarRing({
  size = 46,
  level,
  xp,
  seed,
  avatarSrc,
  avatarLabel = 'avatar',
  innerNode,
  frameAnim = 'subtle',
  frame = 'default',
  mattePreset = 'nav',
}: AvatarRingProps) {
  const tier = tierForLevel(level);
  // Map the named-frame override to a tier key for the level-tier frames so
  // the existing tier-rendering branches below can be reused. Non-tier frames
  // (matte-black / royal-flush / monster-bone / infinite-loop / early-bird)
  // render in their own dedicated branch and skip the auto-tier visuals.
  const overrideTierKey =
    frame === 'silver-ring'   ? 'silver'
    : frame === 'gold-laurel' ? 'gold'
    : frame === 'plat-octogram' ? 'platinum'
    : frame === 'prism-diamond' ? 'diamond'
    : null;
  const renderTierKey = overrideTierKey ?? tier.key;
  const isCustomFrame =
    frame === 'matte-black' ||
    frame === 'royal-flush' ||
    frame === 'monster-bone' ||
    frame === 'infinite-loop' ||
    frame === 'early-bird';
  const nextXp = LEVEL_XP(level);
  const pct = Math.max(0, Math.min(1, xp / nextXp));
  const pad =
    tier.key === 'obsidian' ? 17 :
    tier.key === 'diamond'  ? 16 :
    tier.key === 'platinum' ? 14 :
    tier.key === 'gold'     ? 12 :
    tier.key === 'silver'   ? 10 :
    tier.key === 'bronze'   ? 9  : 8;

  const outer = size + pad;
  const cx = outer / 2;
  const cy = outer / 2;
  const xpR = outer * 0.47;
  const xpC = 2 * Math.PI * xpR;
  const animOn = frameAnim !== 'off';
  const safeSeed = seed.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'x';

  return (
    <div className="relative inline-block align-middle" style={{ width: outer, height: outer }}>
      <svg width={outer} height={outer} className="absolute inset-0 overflow-visible pointer-events-none">
        <defs>
          <linearGradient id={`xpg-${safeSeed}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%"   stopColor={tier.ring} />
            <stop offset="100%" stopColor={tier.glow} />
          </linearGradient>
          <radialGradient id={`halo-${safeSeed}`}>
            <stop offset="0%"   stopColor={tier.glow} stopOpacity="0.55" />
            <stop offset="70%"  stopColor={tier.glow} stopOpacity="0.08" />
            <stop offset="100%" stopColor={tier.glow} stopOpacity="0" />
          </radialGradient>
          {(tier.key === 'diamond' || tier.key === 'obsidian') && (
            <linearGradient id={`prism-${safeSeed}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%"   stopColor="#6EE7F0" />
              <stop offset="33%"  stopColor="#B990FF" />
              <stop offset="66%"  stopColor="#FFD96A" />
              <stop offset="100%" stopColor="#6EE7F0" />
            </linearGradient>
          )}
        </defs>

        {!isCustomFrame && renderTierKey !== 'none' && (
          <circle cx={cx} cy={cy} r={outer * 0.5} fill={`url(#halo-${safeSeed})`} className={animOn ? 'xp-breathe' : ''} />
        )}

        {!isCustomFrame && renderTierKey === 'none' && (
          <circle cx={cx} cy={cy} r={xpR} fill="none" stroke={tier.color} strokeOpacity="0.35" strokeWidth={1.4} strokeDasharray="2 3" />
        )}

        {/* MATTE BLACK frame: four fully-independent surface presets.
            Each preset hardcodes its own textR / fontPx / label / textLength
            / inner+outer ring radii. They do NOT share a formula — change
            one preset and the others stay exactly the same. */}
        {frame === 'matte-black' && mattePreset === 'nav' && (() => {
          // ── NAV BAR PILL (size 26) — legacy values, do not edit ──
          return (
            <g>
              <circle cx={cx} cy={cy} r={outer * 0.5} fill="rgba(0,0,0,0.55)" />
              <circle cx={cx} cy={cy} r={xpR + 2.5} fill="none" stroke="#1a1a1a" strokeWidth={1.2} opacity={0.85} />
              <circle cx={cx} cy={cy} r={xpR} fill="none" stroke="#0a0a0a" strokeWidth={2.4} />
              <circle cx={cx} cy={cy} r={xpR} fill="none"
                stroke="rgba(255,255,255,0.22)" strokeWidth={1.2}
                strokeLinecap="round"
                strokeDasharray={`${xpC * 0.18} ${xpC * 0.82}`}
                transform={`rotate(-135 ${cx} ${cy})`}
                style={{ filter: 'drop-shadow(0 0 2px rgba(255,255,255,0.12))' }} />
            </g>
          );
        })()}

        {frame === 'matte-black' && mattePreset === 'dropdown' && (() => {
          // ── PROFILE PILL DROPDOWN (size 40) — hardcoded, isolated ──
          const innerR = 19.5;
          const outerR = 25.5;
          return (
            <g>
              <circle cx={cx} cy={cy} r={outer * 0.5} fill="rgba(0,0,0,0.6)" />
              <circle cx={cx} cy={cy} r={outerR} fill="none" stroke="#1a1a1a" strokeWidth={1.3} opacity={0.9} />
              <circle cx={cx} cy={cy} r={innerR} fill="none" stroke="#0a0a0a" strokeWidth={2.4} />
              <circle cx={cx} cy={cy} r={innerR} fill="none"
                stroke="rgba(255,255,255,0.22)" strokeWidth={1.2}
                strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * innerR * 0.18} ${2 * Math.PI * innerR * 0.82}`}
                transform={`rotate(-135 ${cx} ${cy})`} />
            </g>
          );
        })()}

        {frame === 'matte-black' && mattePreset === 'picker' && (() => {
          // ── AVATAR PICKER TILE (size 56) — hardcoded, isolated ──
          const innerR = 27;
          const outerR = 35;
          return (
            <g>
              <circle cx={cx} cy={cy} r={outer * 0.5} fill="rgba(0,0,0,0.6)" />
              <circle cx={cx} cy={cy} r={outerR} fill="none" stroke="#1a1a1a" strokeWidth={1.4} opacity={0.9} />
              <circle cx={cx} cy={cy} r={innerR} fill="none" stroke="#0a0a0a" strokeWidth={2.6} />
              <circle cx={cx} cy={cy} r={innerR} fill="none"
                stroke="rgba(255,255,255,0.22)" strokeWidth={1.4}
                strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * innerR * 0.18} ${2 * Math.PI * innerR * 0.82}`}
                transform={`rotate(-135 ${cx} ${cy})`} />
            </g>
          );
        })()}

        {frame === 'matte-black' && mattePreset === 'seat' && (() => {
          // ── TABLE SEAT (size ~100+) — hardcoded, isolated ──
          const textR = size / 2 + 6;
          const innerR = textR - 4;
          const outerR = textR + 4;
          return (
            <g>
              <circle cx={cx} cy={cy} r={outer * 0.5} fill="rgba(0,0,0,0.6)" />
              <circle cx={cx} cy={cy} r={outerR} fill="none" stroke="#1a1a1a" strokeWidth={1.6} opacity={0.9} />
              <circle cx={cx} cy={cy} r={innerR} fill="none" stroke="#0a0a0a" strokeWidth={3} />
              <circle cx={cx} cy={cy} r={innerR} fill="none"
                stroke="rgba(255,255,255,0.22)" strokeWidth={1.4}
                strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * innerR * 0.18} ${2 * Math.PI * innerR * 0.82}`}
                transform={`rotate(-135 ${cx} ${cy})`} />
            </g>
          );
        })()}

        {/* ROYAL FLUSH frame: crimson breathing halo + crown beacon at 12 o'clock. */}
        {frame === 'royal-flush' && (
          <g>
            <circle cx={cx} cy={cy} r={outer * 0.5} fill="rgba(204,62,62,0.30)" className={animOn ? 'xp-breathe' : ''} />
            <circle cx={cx} cy={cy} r={xpR + 1.5} fill="none" stroke="#CC3E3E" strokeWidth={1} opacity={0.55} />
            <circle cx={cx} cy={cy} r={xpR} fill="none" stroke="#CC3E3E" strokeWidth={2.2} style={{ filter: 'drop-shadow(0 0 4px rgba(204,62,62,0.55))' }} />
            <g transform={`translate(${cx}, ${cy - xpR - 4})`}>
              <path d="M -4 2 L -3 -2 L -1 0 L 0 -3 L 1 0 L 3 -2 L 4 2 Z" fill="#FFD96A" stroke="#CC3E3E" strokeWidth={0.6} />
            </g>
          </g>
        )}

        {/* MONSTER BONE frame: heavy bone ring with inner orange glow. */}
        {frame === 'monster-bone' && (
          <g>
            <circle cx={cx} cy={cy} r={outer * 0.5} fill="rgba(245,241,230,0.18)" className={animOn ? 'xp-breathe' : ''} />
            <circle cx={cx} cy={cy} r={xpR + 2} fill="none" stroke="#F5F1E6" strokeWidth={0.9} opacity={0.45} />
            <circle cx={cx} cy={cy} r={xpR} fill="none" stroke="#F5F1E6" strokeWidth={2.8} style={{ filter: 'drop-shadow(0 0 5px rgba(242,106,31,0.55))' }} />
            <circle cx={cx} cy={cy} r={xpR - 2.5} fill="none" stroke="rgba(242,106,31,0.35)" strokeWidth={1} />
          </g>
        )}

        {/* INFINITE LOOP frame: two dashed rings counter-rotating. */}
        {frame === 'infinite-loop' && (
          <g>
            <circle cx={cx} cy={cy} r={outer * 0.5} fill="rgba(110,231,240,0.16)" />
            <g className={animOn ? 'xp-rotate' : ''} style={{ transformOrigin: `${cx}px ${cy}px` }}>
              <circle cx={cx} cy={cy} r={xpR + 3} fill="none" stroke="#6EE7F0" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
            </g>
            <g style={{ transformOrigin: `${cx}px ${cy}px`, animation: animOn ? 'xp-rotate 18s linear infinite reverse' : 'none' }}>
              <circle cx={cx} cy={cy} r={xpR} fill="none" stroke="#9DF0F5" strokeWidth={1.4} strokeDasharray="2 4" opacity={0.85} />
            </g>
          </g>
        )}

        {/* EARLY BIRD frame: amber pulse + subtle waitlist halo. */}
        {frame === 'early-bird' && (
          <g>
            <circle cx={cx} cy={cy} r={outer * 0.5} fill="rgba(255,198,58,0.28)" className={animOn ? 'xp-breathe' : ''} />
            <circle cx={cx} cy={cy} r={xpR + 1.5} fill="none" stroke="#FFC63A" strokeWidth={0.9} opacity={0.55} />
            <circle cx={cx} cy={cy} r={xpR} fill="none" stroke="#FFC63A" strokeWidth={1.8} style={{ filter: 'drop-shadow(0 0 4px rgba(255,198,58,0.55))' }} />
            <circle cx={cx} cy={cy - xpR - 1} r={1.6} fill="#FFD96A" className={animOn ? 'xp-breathe' : ''} />
          </g>
        )}

        {!isCustomFrame && renderTierKey === 'bronze' && (
          <g>
            <circle cx={cx} cy={cy} r={xpR} fill="none" stroke={tier.color} strokeOpacity="0.35" strokeWidth={2.2} />
            {[0, 1, 2, 3].map(i => {
              const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
              const x1 = cx + Math.cos(a) * (xpR - 1);
              const y1 = cy + Math.sin(a) * (xpR - 1);
              const x2 = cx + Math.cos(a) * (xpR + 4);
              const y2 = cy + Math.sin(a) * (xpR + 4);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={tier.glow} strokeWidth={2.2} strokeLinecap="round" />;
            })}
          </g>
        )}

        {!isCustomFrame && renderTierKey === 'silver' && (
          <g>
            <circle cx={cx} cy={cy} r={xpR + 3} fill="none" stroke={tier.color} strokeOpacity="0.45" strokeWidth={1} />
            <circle cx={cx} cy={cy} r={xpR}     fill="none" stroke={tier.color} strokeOpacity="0.3"  strokeWidth={1.6} />
            {Array.from({ length: 16 }).map((_, i) => {
              const a = (i / 16) * Math.PI * 2;
              const x1 = cx + Math.cos(a) * (xpR + 0.5);
              const y1 = cy + Math.sin(a) * (xpR + 0.5);
              const x2 = cx + Math.cos(a) * (xpR + 2.5);
              const y2 = cy + Math.sin(a) * (xpR + 2.5);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={tier.glow} strokeWidth={0.8} opacity={0.55} />;
            })}
          </g>
        )}

        {!isCustomFrame && renderTierKey === 'gold' && (
          <g className={animOn ? 'xp-rotate' : ''} style={{ transformOrigin: `${cx}px ${cy}px` }}>
            <circle cx={cx} cy={cy} r={xpR} fill="none" stroke={tier.color} strokeOpacity="0.3" strokeWidth={2} />
            {Array.from({ length: 6 }).map((_, i) => {
              const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
              const lx = cx + Math.cos(a) * (xpR + 3);
              const ly = cy + Math.sin(a) * (xpR + 3);
              const tail = a + 0.28;
              const tx = cx + Math.cos(tail) * (xpR + 5);
              const ty = cy + Math.sin(tail) * (xpR + 5);
              return (
                <g key={i}>
                  <path d={`M ${cx + Math.cos(a) * xpR} ${cy + Math.sin(a) * xpR} Q ${lx} ${ly} ${tx} ${ty}`} stroke={tier.glow} strokeWidth={1.6} fill="none" strokeLinecap="round" />
                  <circle cx={lx} cy={ly} r={1.6} fill={tier.glow} />
                </g>
              );
            })}
          </g>
        )}

        {!isCustomFrame && renderTierKey === 'platinum' && (
          <g>
            <polygon
              points={Array.from({ length: 8 }).map((_, i) => {
                const a = (i / 8) * Math.PI * 2 - Math.PI / 8;
                return `${cx + Math.cos(a) * (xpR + 4)},${cy + Math.sin(a) * (xpR + 4)}`;
              }).join(' ')}
              fill="none" stroke={tier.color} strokeOpacity="0.55" strokeWidth={1.2}
            />
            <polygon
              points={Array.from({ length: 8 }).map((_, i) => {
                const a = (i / 8) * Math.PI * 2 - Math.PI / 8;
                return `${cx + Math.cos(a) * (xpR + 1)},${cy + Math.sin(a) * (xpR + 1)}`;
              }).join(' ')}
              fill="none" stroke={tier.glow} strokeOpacity="0.35" strokeWidth={0.8}
            />
            {Array.from({ length: 8 }).map((_, i) => {
              const a = (i / 8) * Math.PI * 2 - Math.PI / 8;
              const x = cx + Math.cos(a) * (xpR + 4);
              const y = cy + Math.sin(a) * (xpR + 4);
              return (
                <g key={i}>
                  <circle cx={x} cy={y} r={1.8} fill={tier.glow} />
                  <circle cx={x} cy={y} r={0.8} fill={tier.accent} />
                </g>
              );
            })}
          </g>
        )}

        {!isCustomFrame && (renderTierKey === 'diamond' || renderTierKey === 'obsidian') && (
          <g>
            <g className={animOn ? 'xp-rotate' : ''} style={{ transformOrigin: `${cx}px ${cy}px` }}>
              <circle cx={cx} cy={cy} r={xpR + 4} fill="none" stroke={`url(#prism-${safeSeed})`} strokeWidth={1} strokeDasharray="3 2" opacity={0.85} />
              {Array.from({ length: 12 }).map((_, i) => {
                const a = (i / 12) * Math.PI * 2;
                const x = cx + Math.cos(a) * (xpR + 4);
                const y = cy + Math.sin(a) * (xpR + 4);
                return <circle key={i} cx={x} cy={y} r={0.9} fill={tier.glow} />;
              })}
            </g>
            <g style={{ transformOrigin: `${cx}px ${cy}px`, animation: animOn ? 'xp-rotate 14s linear infinite reverse' : 'none' }}>
              <circle cx={cx} cy={cy} r={xpR + 1.5} fill="none" stroke={tier.ring} strokeWidth={0.8} strokeDasharray="1 3" opacity={0.65} />
            </g>
            <g transform={`translate(${cx}, ${cy - xpR - 5})`}>
              <polygon points="0,-3 3,0 0,3 -3,0" fill={`url(#prism-${safeSeed})`} stroke={tier.glow} strokeWidth={0.6} />
            </g>
          </g>
        )}

        {/* XP progress arc — bone-tinted for matte-black frame, otherwise tier-gradient. */}
        <circle
          cx={cx} cy={cy} r={xpR} fill="none"
          stroke={frame === 'matte-black' ? '#F5F1E6' : `url(#xpg-${safeSeed})`}
          strokeOpacity={frame === 'matte-black' ? 0.55 : 1}
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeDasharray={`${xpC * pct} ${xpC}`}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{
            filter: frame === 'matte-black'
              ? 'drop-shadow(0 0 2px rgba(245,241,230,0.25))'
              : level >= 5 ? `drop-shadow(0 0 3px ${tier.glow}aa)` : 'none',
          }}
        />
      </svg>

      <div
        className="absolute rounded-full overflow-hidden flex items-center justify-center bg-ink"
        style={{
          top: pad / 2,
          left: pad / 2,
          width: size,
          height: size,
          border: frame === 'matte-black'
            ? '1px solid rgba(255,255,255,0.10)'
            : frame === 'royal-flush'
              ? '1px solid rgba(204,62,62,0.45)'
              : frame === 'monster-bone'
                ? '1px solid rgba(245,241,230,0.30)'
                : frame === 'infinite-loop'
                  ? '1px solid rgba(110,231,240,0.30)'
                  : frame === 'early-bird'
                    ? '1px solid rgba(255,198,58,0.40)'
                    : '1px solid rgba(242,106,31,0.20)',
        }}
      >
        {innerNode ? (
          innerNode
        ) : avatarSrc ? (
          <Image src={avatarSrc} alt={avatarLabel} width={size} height={size} className="w-full h-full object-cover" />
        ) : (
          <span className="text-[10px] font-bold font-mono text-orange">{seed.slice(0, 2).toUpperCase()}</span>
        )}
      </div>

      {tier.key !== 'none' && (
        <div
          className={cn('absolute flex items-center justify-center leading-none')}
          style={{
            bottom: -2,
            right: tier.key === 'obsidian' || tier.key === 'diamond' || tier.key === 'platinum' ? -4 : -2,
            padding: '1px 3px',
            minWidth: 18,
            background: frame === 'matte-black'
              ? '#000000'
              : tier.key === 'obsidian'
                ? 'linear-gradient(135deg,#07090B,#201334)'
                : tier.key === 'diamond'
                  ? 'linear-gradient(135deg,#0A0D10,#1A2428)'
                  : '#07090B',
            border: `1px solid ${frame === 'matte-black' ? 'rgba(245,241,230,0.55)' : tier.color}`,
            borderRadius: frame === 'matte-black' ? 3 : (tier.key === 'platinum' || tier.key === 'diamond' || tier.key === 'obsidian' ? 0 : 3),
            clipPath: frame === 'matte-black' ? undefined : (tier.key === 'platinum' || tier.key === 'obsidian' ? 'polygon(15% 0, 100% 0, 100% 85%, 85% 100%, 0 100%, 0 15%)' : undefined),
            boxShadow: frame === 'matte-black'
              ? 'inset 0 1px 0 rgba(255,255,255,0.15)'
              : (tier.key === 'diamond' || tier.key === 'obsidian' ? `0 0 8px ${tier.glow}66` : 'none'),
          }}
        >
          <span
            className="font-mono text-[8px] font-bold tabular-nums"
            style={{ color: frame === 'matte-black' ? '#F5F1E6' : tier.color }}
          >
            {level}
          </span>
        </div>
      )}
    </div>
  );
}
