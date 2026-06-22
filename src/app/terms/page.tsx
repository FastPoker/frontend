import Link from 'next/link';

export const metadata = {
  title: 'Terms · Fast Poker',
};

// Minimal placeholder so footer / sign-in links don't 404. Operators deploying
// this standalone should replace this with their own Terms of Service.
export default function TermsPage() {
  return (
    <div className="min-h-screen flex items-start justify-center px-4 py-16">
      <div className="glass-room hairline rounded-xl w-full max-w-2xl p-7 sm:p-9">
        <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-orange/80">Terms of Service</div>
        <h1 className="mt-4 font-display text-[clamp(1.6rem,5vw,2.4rem)] tracking-wide text-bone uppercase">
          Terms of Service
        </h1>
        <p className="mt-4 text-[13px] leading-relaxed text-boneDim/80">
          This is a self-hosted instance of an open client for an on-chain poker protocol on Solana.
          The operator of this site is responsible for providing its terms of service. Gameplay
          happens directly on-chain via your own wallet; no custody is taken by this client.
        </p>
        <p className="mt-4 text-[12px] leading-relaxed text-boneDim/60">
          If you are the operator, replace this page (<code className="text-orange/70">src/app/terms/page.tsx</code>)
          with your own terms.
        </p>
        <p className="mt-8 font-mono text-[10px] text-boneDim/45">
          <Link href="/lobby" className="text-orange/70 hover:text-orange underline underline-offset-2">← Back to lobby</Link>
        </p>
      </div>
    </div>
  );
}
