'use client';

import Link from 'next/link';

import { SectionHeader } from '@/components/ui/SectionHeader';
import { BRAND } from '@/lib/branding';
import { useDealerRegistry } from '@/hooks/useDealerRegistry';
import {
  DEALER_LICENSE_TOTAL_SUPPLY,
  DEALER_LICENSE_FREE_RESERVE,
} from '@/lib/constants';
import {
  calcLicensePrice,
  formatSol,
  isDealerLicenseSaleOpen,
} from '@/lib/dealer-license';

function StatCell({
  label,
  value,
  sub,
}: {
  label: string;
  value: number | string;
  sub?: string;
}) {
  return (
    <div className="glass-card p-4">
      <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.22em] uppercase">{label}</div>
      <div className="font-display text-bone text-3xl md:text-4xl leading-none mt-2 tabular-nums">
        {value}
      </div>
      {sub && <div className="font-mono text-[10px] text-boneDim/55 mt-1">{sub}</div>}
    </div>
  );
}

function HeroSection() {
  const reg = useDealerRegistry();
  const sold = reg.totalSold;
  const remaining = Math.max(0, DEALER_LICENSE_TOTAL_SUPPLY - sold);
  const saleOpen = isDealerLicenseSaleOpen(sold);
  const priceLabel = reg.loading
    ? '—'
    : saleOpen
      ? `${formatSol(calcLicensePrice(sold))} SOL`
      : sold < DEALER_LICENSE_FREE_RESERVE
        ? 'RESERVE'
        : 'SOLD OUT';

  return (
    <div className="glass-room p-6 md:p-8 relative overflow-hidden">
      <div
        className="absolute -top-24 -right-24 w-80 h-80 rounded-full pointer-events-none opacity-20"
        style={{ background: 'radial-gradient(circle, rgb(var(--brand-primary)/0.55), transparent 70%)' }}
      />
      <div className="relative grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-6 items-center">
        <div>
          <div className="font-mono text-[10px] tracking-[0.22em] text-orange/85 mb-2">
            DECENTRALIZED INFRASTRUCTURE
          </div>
          <h1 className="font-display text-bone text-4xl md:text-5xl leading-tight tracking-wide">
            Deal to Earn
          </h1>
          <p className="mt-4 text-bone/75 leading-relaxed max-w-[640px]">
            Dealers are independent operators that keep {BRAND.name} moving. They run a
            crank service, hold a Dealer License, and earn a share of every hand they
            settle. Anyone can run the software; licensed operators are the ones eligible
            for dealer rewards. This page reads the on-chain registry directly — no backend.
          </p>
          <div className="mt-5 flex items-center gap-3 flex-wrap">
            <Link
              href="/dealer/license"
              className="px-4 py-2.5 rounded-sm btn-orange font-mono text-[11px] tracking-[0.22em]"
            >
              MINT A LICENSE
            </Link>
            <Link
              href={BRAND.social.docs}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2.5 rounded-sm hairline font-mono text-[11px] tracking-[0.22em] text-boneDim/85 hover:text-orange hover:border-orange/40"
            >
              OPERATOR DOCS
            </Link>
          </div>
          <div className="mt-4 flex items-center gap-3 flex-wrap font-mono text-[10px] text-boneDim/65">
            <span>20% of cash rake</span>
            <span className="text-boneDim/30">·</span>
            <span>45% of SNG fees</span>
            <span className="text-boneDim/30">·</span>
            <span>SOL + SPL settled per hand</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <StatCell
            label="Licenses Issued"
            value={reg.loading ? '—' : sold.toLocaleString()}
            sub={`of ${DEALER_LICENSE_TOTAL_SUPPLY.toLocaleString()}`}
          />
          <StatCell
            label="Next Price"
            value={priceLabel}
            sub={saleOpen ? 'paid sale open' : 'bonding curve'}
          />
          <StatCell
            label="Remaining"
            value={reg.loading ? '—' : remaining.toLocaleString()}
            sub="before cap"
          />
          <StatCell
            label="Revenue"
            value={reg.loading ? '—' : `${formatSol(reg.totalRevenue)} SOL`}
            sub="registry total"
          />
        </div>
      </div>
      {reg.errored && (
        <div className="relative mt-5 font-mono text-[9.5px] text-amber/80 tracking-[0.15em]">
          Registry read failed on this RPC. Connect your own RPC for live numbers.
        </div>
      )}
    </div>
  );
}

function NetworkPanel() {
  // The top-dealers leaderboard in the hosted client is an indexer aggregation
  // built from a getProgramAccounts scan over the licensed-crank action tally.
  // gPA is blocked on the free public pool and there is no backend here, so this
  // degrades to a static explainer + "use your own RPC" hint instead of crashing.
  return (
    <div className="glass-room p-5 md:p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div>
          <div className="font-display text-bone text-base tracking-[0.12em]">DEALER NETWORK</div>
          <div className="font-mono text-[10px] text-boneDim/55 mt-1">
            Live operator activity and the dealer leaderboard.
          </div>
        </div>
      </div>
      <div className="rounded-sm border border-white/[0.07] bg-inkA p-5 text-center">
        <div className="font-display text-bone text-base tracking-wide mb-1.5">
          Leaderboard needs an indexer
        </div>
        <p className="font-mono text-[10.5px] text-boneDim/70 leading-relaxed max-w-[560px] mx-auto">
          The per-operator hands and top-dealer ranking are aggregated from an on-chain
          program-account scan, which the free public RPC pool blocks. This static
          frontend ships without an indexer. Point your operator service at your own RPC
          + indexer to surface live rankings, or check the {BRAND.name} community channel
          for the public board.
        </p>
        <div className="mt-4 flex items-center justify-center gap-3 flex-wrap">
          <Link
            href={BRAND.social.discord}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3.5 py-2 rounded-sm hairline font-mono text-[10px] tracking-[0.2em] text-boneDim/80 hover:text-orange hover:border-orange/40 transition"
          >
            COMMUNITY →
          </Link>
          <Link
            href={BRAND.social.docs}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3.5 py-2 rounded-sm hairline font-mono text-[10px] tracking-[0.2em] text-boneDim/80 hover:text-orange hover:border-orange/40 transition"
          >
            RUN AN INDEXER →
          </Link>
        </div>
      </div>
    </div>
  );
}

function HowItWorksPanel() {
  const steps: { n: number; title: string; body: string }[] = [
    {
      n: 1,
      title: 'Mint a License',
      body:
        'A Dealer License is wallet-bound during the sale. Paid licenses start at 1 SOL, rise by 0.001 SOL per paid license, and cap at 10 SOL. Purchase proceeds split 50% to stakers and 50% to Platform Fee. NFT wrapping unlocks after sellout.',
    },
    {
      n: 2,
      title: 'Run a crank service',
      body:
        'Run the open-source crank/dealer service locally. It holds your operator keypair, watches for tables, and submits crank actions every few seconds. Configure RPCs, fees, and table filters from its dashboard.',
    },
    {
      n: 3,
      title: 'Earn from every hand',
      body:
        'Each hand you settle credits your operator wallet on-chain. Cash rake: 20% to the dealer pool. SNG entry fees: 45%. Claim at any time, or auto-forward to a separate wallet.',
    },
    {
      n: 4,
      title: 'Compete on the network',
      body:
        'The more responsive your service, the more hands you crank. Top dealers show up on the leaderboard, weighted by the actions your crank processes on user-created tables.',
    },
  ];
  return (
    <div className="glass-room p-5 md:p-6">
      <div className="font-display text-bone text-base tracking-[0.12em] mb-4">HOW IT WORKS</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {steps.map((s) => (
          <div key={s.n} className="glass-card p-4">
            <div className="flex items-start gap-3">
              <div className="font-display text-orange text-2xl leading-none tabular-nums shrink-0">
                {String(s.n).padStart(2, '0')}
              </div>
              <div>
                <div className="font-display text-bone text-base tracking-wide">{s.title}</div>
                <p className="text-[12.5px] text-boneDim/80 leading-relaxed mt-1.5">{s.body}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GetStartedPanel() {
  const cards: { step: string; title: string; body: string; href: string }[] = [
    {
      step: 'Step 1',
      title: 'Mint license →',
      body: 'Required to receive on-chain dealer payouts.',
      href: '/dealer/license',
    },
    {
      step: 'Step 2',
      title: 'Run the service →',
      body: 'Self-hosted operator service. Local dashboard for config + earnings.',
      href: BRAND.social.docs,
    },
    {
      step: 'Step 3',
      title: 'Join the community →',
      body: 'Coordination, support, and earnings updates with other operators.',
      href: BRAND.social.discord,
    },
    {
      step: 'Source',
      title: 'View the code →',
      body: 'This frontend builds every registry transaction in the browser. Read the source.',
      href: BRAND.social.github,
    },
  ];
  return (
    <div className="glass-room p-5 md:p-6">
      <div className="font-display text-bone text-base tracking-[0.12em] mb-3">GET STARTED</div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {cards.map((c) => {
          const external = c.href.startsWith('http');
          return (
            <Link
              key={c.step}
              href={c.href}
              {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="glass-card p-4 hover:border-orange/40 transition group block"
            >
              <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.22em] uppercase">
                {c.step}
              </div>
              <div className="font-display text-bone text-lg tracking-wide leading-[1rem] mt-1 group-hover:text-orange transition">
                {c.title}
              </div>
              <p className="text-[12px] text-boneDim/70 leading-relaxed mt-2">{c.body}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function DealerInfoPage() {
  return (
    <main className="min-h-screen bg-ink">
      <div className="max-w-[1280px] mx-auto w-full px-4 md:px-6 py-6 md:py-8 space-y-5 pb-16">
        <SectionHeader
          eyebrow="DECENTRALIZED · PERMISSIONLESS"
          title="Dealer"
          subtitle="The network's independent operators. Mint a license, run the service, earn from every hand."
        />

        <HeroSection />

        <HowItWorksPanel />

        <NetworkPanel />

        <GetStartedPanel />
      </div>
    </main>
  );
}
