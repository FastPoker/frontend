// Real token marks for in-table bounty UI. SOL = /tokens/sol.svg, $FP = /brand/app-icon.png
// (the same mark the live table's $FP pool uses). One place to swap assets.

const SRC: Record<'sol' | 'fp', string> = {
  sol: '/tokens/sol.svg',
  fp: '/brand/app-icon.png',
};

export function TokenMark({ t, size = 12, className = '' }: { t: 'sol' | 'fp'; size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={SRC[t]}
      alt={t === 'sol' ? 'SOL' : '$FP'}
      width={size}
      height={size}
      className={`inline-block shrink-0 rounded-full align-[-0.15em] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
