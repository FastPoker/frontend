import Link from 'next/link';

import { PageHeadline } from '@/components/ui/PageHeadline';
import { SectionHeader } from '@/components/ui/SectionHeader';

function Panel({
  title,
  body,
  href,
  cta,
}: {
  title: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <div className="rounded-sm hairline bg-inkA p-5">
      <div className="font-display text-bone text-2xl leading-none tracking-wide">
        {title}
      </div>
      <p className="mt-2 font-sans text-[12px] text-boneDim/70 leading-relaxed">
        {body}
      </p>
      <Link
        href={href}
        className="mt-5 inline-flex h-10 items-center px-4 rounded-sm bg-orange text-black font-display text-lg tracking-wide hover:brightness-110 transition"
      >
        {cta}
      </Link>
    </div>
  );
}

export default function DealerPage() {
  return (
    <main className="max-w-[1180px] mx-auto w-full px-3 sm:px-5 py-7 md:py-10 space-y-8">
      <PageHeadline
        lineOne="Dealer"
        lineTwo="Tools"
        subtitle="Public dealer surfaces for wallets that want to mint a license or operate protocol infrastructure from source."
      />

      <section>
        <SectionHeader
          eyebrow="Dealer"
          title="Operator Entry"
          subtitle="The public frontend includes the mint surface. Running dealer software is a separate operator process and should be documented by the operator's chosen backend."
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Panel
            title="License Mint"
            body="Mint a dealer license from the registry program with a normal wallet transaction. You can mint to yourself or to a beneficiary wallet."
            href="/dealer/license"
            cta="MINT LICENSE"
          />
          <Panel
            title="Source Integration"
            body="Use the standalone source as a reference for how the browser builds registry, staking, auction, and table transactions without private client-v2 services."
            href="/how-to-play"
            cta="VIEW GUIDE"
          />
        </div>
      </section>
    </main>
  );
}
