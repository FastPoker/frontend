import Link from 'next/link';

export const metadata = {
  title: 'Privacy · Fast Poker',
};

// Minimal placeholder so footer / sign-in links don't 404. Operators deploying
// this standalone should replace this with their own Privacy Policy.
export default function PrivacyPage() {
  return (
    <div className="min-h-screen flex items-start justify-center px-4 py-16">
      <div className="glass-room hairline rounded-xl w-full max-w-2xl p-7 sm:p-9">
        <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-orange/80">Privacy</div>
        <h1 className="mt-4 font-display text-[clamp(1.6rem,5vw,2.4rem)] tracking-wide text-bone uppercase">
          Privacy Policy
        </h1>
        <p className="mt-4 text-[13px] leading-relaxed text-boneDim/80">
          This standalone client is backend-free by default: it talks directly to public Solana RPCs
          and the MagicBlock TEE from your browser. It does not run an analytics backend or collect
          accounts; your wallet address is the only identifier, and it stays client-side.
        </p>
        <p className="mt-4 text-[12px] leading-relaxed text-boneDim/60">
          If you are the operator and add any data collection (analytics, RPC proxy logs, an
          indexer), document it here. Replace this page (<code className="text-orange/70">src/app/privacy/page.tsx</code>)
          with your own policy.
        </p>
        <p className="mt-8 font-mono text-[10px] text-boneDim/45">
          <Link href="/lobby" className="text-orange/70 hover:text-orange underline underline-offset-2">← Back to lobby</Link>
        </p>
      </div>
    </div>
  );
}
