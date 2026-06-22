import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--font-display)', '"Bebas Neue"', '"Playfair Display"', 'Georgia', 'serif'],
        serif:   ['var(--font-serif)', '"Playfair Display"', 'Georgia', 'serif'],
        mono:    ['var(--font-mono)', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans:    ['var(--font-sans)', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        heading: ['var(--font-display)', '"Bebas Neue"', 'serif'],
        body:    ['var(--font-sans)', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        // shadcn HSL-var surface stays so ui/ components keep working.
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Mockup 1.4 canonical palette (flat hex, matches every .html 1:1).
        ink:      '#07090B',
        inkA:     '#0A0D10',
        inkB:     '#10141A',
        inkC:     '#161B24',
        felt:     '#0B2B1F',
        feltHi:   '#113929',
        feltLo:   '#051811',
        // Brand tokens resolve to CSS variables (defaults in globals.css :root,
        // overridable per-operator via branding.ts → brandCssVars()). One
        // NEXT_PUBLIC_BRAND_PRIMARY reskins every bg-orange/text-orange/etc.
        orange:   'rgb(var(--brand-primary) / <alpha-value>)',
        orangeHi: 'rgb(var(--brand-primary-hi) / <alpha-value>)',
        orangeLo: 'rgb(var(--brand-primary-lo) / <alpha-value>)',
        amber:    'rgb(var(--brand-amber) / <alpha-value>)',
        amberHi:  '#FFD96A',
        // `gold` — warm accent for prize winnings / tournament accent.
        gold:     'rgb(var(--brand-gold) / <alpha-value>)',
        goldHi:   '#E8CB72',
        goldLo:   '#A88C35',
        bone:     'rgb(var(--brand-bone) / <alpha-value>)',
        boneDim:  '#B8B4A8',
        muted:    '#6a6578',
        // brand.* alias kept so any lingering `bg-brand-gold` class still
        // renders. Maps to the brand primary.
        brand: {
          gold:    'rgb(var(--brand-primary) / <alpha-value>)',
          goldHi:  'rgb(var(--brand-primary-hi) / <alpha-value>)',
          goldLo:  'rgb(var(--brand-primary-lo) / <alpha-value>)',
          ink:     '#07090B',
          inkElev1:'#0A0D10',
          inkElev2:'#10141A',
          bone:    'rgb(var(--brand-bone) / <alpha-value>)',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'card-deal': {
          '0%': { transform: 'translateY(-100px) rotate(-20deg)', opacity: '0' },
          '100%': { transform: 'translateY(0) rotate(0)', opacity: '1' },
        },
        'chip-toss': {
          '0%': { transform: 'translateY(0) scale(1)' },
          '50%': { transform: 'translateY(-20px) scale(1.1)' },
          '100%': { transform: 'translateY(0) scale(1)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(1)', opacity: '1' },
          '100%': { transform: 'scale(1.5)', opacity: '0' },
        },
        'float-slow': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
      },
      animation: {
        'card-deal': 'card-deal 0.3s ease-out',
        'chip-toss': 'chip-toss 0.5s ease-in-out',
        'pulse-ring': 'pulse-ring 1s ease-out infinite',
        'float-slow': 'float-slow 6s ease-in-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
