'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { toast } from 'sonner';

import { PageHeadline } from '@/components/ui/PageHeadline';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { applyPriorityFee } from '@/lib/priority-fee';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { confirmFundsAction } from '@/lib/funds-confirmation';
import { makeL1Connection } from '@/lib/constants';
import { sendWalletTx } from '@/lib/send-wallet-tx';
import {
  DEALER_LICENSE_FREE_RESERVE,
  DEALER_LICENSE_TOTAL_SUPPLY,
} from '@/lib/constants';
import {
  buildPurchaseLicenseIx,
  calcLicensePrice,
  formatSol,
  getLicensePda,
  getRegistryPda,
  isDealerLicenseSaleOpen,
  parseLicense,
  parseRegistry,
  type DealerLicenseView,
  type DealerRegistryView,
} from '@/lib/dealer-license';

const FEE_BUFFER_LAMPORTS = 10_000_000;

function short(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function sol(lamports: number): string {
  return `${formatSol(lamports)} SOL`;
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-sm hairline bg-inkA px-4 py-3">
      <div className="font-mono text-[9px] text-boneDim/55 tracking-[0.2em] uppercase">
        {label}
      </div>
      <div className="mt-2 font-display text-bone text-3xl leading-none tabular-nums">
        {value}
      </div>
      {sub && <div className="mt-1 font-mono text-[10px] text-boneDim/55">{sub}</div>}
    </div>
  );
}

function LicenseSummary({ license }: { license: DealerLicenseView }) {
  return (
    <div className="rounded-sm border border-emerald-400/25 bg-emerald-500/10 px-4 py-3">
      <div className="font-mono text-[9px] tracking-[0.18em] text-emerald-300 uppercase">
        Existing license
      </div>
      <div className="mt-2 font-display text-bone text-3xl leading-none">
        #{license.licenseNumber}
      </div>
      <div className="mt-2 font-mono text-[10px] text-boneDim/65 leading-relaxed">
        {short(license.wallet)} · paid {sol(license.pricePaid)} ·{' '}
        {new Date(license.purchasedAt * 1000).toLocaleDateString()}
      </div>
    </div>
  );
}

export default function DealerLicensePage() {
  const connection = useMemo(() => makeL1Connection(), []);
  const { publicKey, isConnected, sendTransaction, signTransaction } = useUnifiedWallet();
  const [registry, setRegistry] = useState<DealerRegistryView | null>(null);
  const [targetInput, setTargetInput] = useState('');
  const [targetLicense, setTargetLicense] = useState<DealerLicenseView | null>(null);
  const [balanceLamports, setBalanceLamports] = useState(0);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [slippageBuffer, setSlippageBuffer] = useState(5);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wallet = params.get('beneficiary') || params.get('operator') || params.get('wallet');
    if (!wallet) return;
    try {
      setTargetInput(new PublicKey(wallet.trim()).toBase58());
    } catch {
      // Ignore malformed handoff links.
    }
  }, []);

  const targetWallet = useMemo(() => {
    const raw = targetInput.trim();
    if (raw) {
      try {
        return new PublicKey(raw);
      } catch {
        return null;
      }
    }
    return publicKey;
  }, [publicKey, targetInput]);
  const targetBase58 = targetWallet?.toBase58() ?? '';
  const targetIsValid = !!targetWallet;

  const loadRegistry = useCallback(async (): Promise<DealerRegistryView | null> => {
    const [registryPda] = getRegistryPda();
    const info = await connection.getAccountInfo(registryPda);
    if (!info) return null;
    return parseRegistry(Buffer.from(info.data));
  }, [connection]);

  const checkLicense = useCallback(
    async (wallet: PublicKey): Promise<DealerLicenseView | null> => {
      const [licensePda] = getLicensePda(wallet);
      const info = await connection.getAccountInfo(licensePda);
      if (!info) return null;
      return parseLicense(Buffer.from(info.data));
    },
    [connection],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextRegistry, balance, license] = await Promise.all([
        loadRegistry(),
        publicKey ? connection.getBalance(publicKey).catch(() => 0) : Promise.resolve(0),
        targetWallet ? checkLicense(targetWallet).catch(() => null) : Promise.resolve(null),
      ]);
      setRegistry(nextRegistry);
      setBalanceLamports(balance);
      setTargetLicense(license);
    } finally {
      setLoading(false);
    }
  }, [checkLicense, connection, loadRegistry, publicKey, targetWallet]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  const currentPriceLamports = registry ? calcLicensePrice(registry.totalSold) : 0;
  const maxAcceptedSold = registry ? registry.totalSold + slippageBuffer : slippageBuffer;
  const maxAcceptedPriceLamports = calcLicensePrice(maxAcceptedSold);
  const sold = registry?.totalSold ?? 0;
  const saleOpen = registry ? isDealerLicenseSaleOpen(registry.totalSold) : false;
  const salePendingReserve = registry ? registry.totalSold < DEALER_LICENSE_FREE_RESERVE : false;
  const saleComplete = registry ? registry.totalSold >= DEALER_LICENSE_TOTAL_SUPPLY : false;
  const progressPct = Math.min(100, (sold / DEALER_LICENSE_TOTAL_SUPPLY) * 100);
  const canAfford = balanceLamports >= maxAcceptedPriceLamports + FEE_BUFFER_LAMPORTS;

  const purchase = useCallback(async () => {
    if (!publicKey || !targetWallet) {
      toast.error('Connect wallet and enter a valid recipient.');
      return;
    }
    setPurchasing(true);
    setTxSig(null);
    try {
      const [latestRegistry, existing, balance] = await Promise.all([
        loadRegistry(),
        checkLicense(targetWallet),
        connection.getBalance(publicKey).catch(() => balanceLamports),
      ]);
      if (!latestRegistry) throw new Error('Dealer registry is not initialized.');
      if (!isDealerLicenseSaleOpen(latestRegistry.totalSold)) {
        throw new Error(
          latestRegistry.totalSold < DEALER_LICENSE_FREE_RESERVE
            ? 'Paid sale is not open until reserved licenses are issued.'
            : 'Dealer license supply is sold out.',
        );
      }
      if (existing) throw new Error(`Target wallet already owns License #${existing.licenseNumber}.`);

      const latestPriceLamports = calcLicensePrice(latestRegistry.totalSold);
      const maxTotalSold = latestRegistry.totalSold + slippageBuffer;
      const maxPriceLamports = calcLicensePrice(maxTotalSold);
      if (balance < maxPriceLamports + FEE_BUFFER_LAMPORTS) {
        throw new Error(
          `Insufficient balance. Need ${sol(maxPriceLamports + FEE_BUFFER_LAMPORTS)} including fee buffer.`,
        );
      }

      const ix = buildPurchaseLicenseIx(publicKey, targetWallet, maxTotalSold);
      const latestBlockhash = await getLatestBlockhashClient(connection, 'confirmed');
      const tx = new Transaction({
        feePayer: publicKey,
        recentBlockhash: latestBlockhash.blockhash,
      }).add(ix);
      await applyPriorityFee(tx);

      if (!(await confirmFundsAction({
        title: 'Confirm Dealer License',
        action: targetWallet.equals(publicKey)
          ? 'Purchase dealer license'
          : 'Purchase dealer license for another wallet',
        amount: sol(latestPriceLamports),
        details: [
          `License wallet: ${targetWallet.toBase58()}`,
          `Max accepted price: ${sol(maxPriceLamports)}`,
          'Revenue split is handled by the on-chain registry program.',
        ],
        transaction: tx,
      }))) {
        return;
      }

      const sig = await sendWalletTx(tx, connection, { sendTransaction, signTransaction });
      await connection.confirmTransaction({ signature: sig, ...latestBlockhash }, 'confirmed');
      setTxSig(sig);
      toast.success('Dealer license minted.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Dealer license purchase failed.');
    } finally {
      setPurchasing(false);
    }
  }, [
    balanceLamports,
    checkLicense,
    connection,
    loadRegistry,
    publicKey,
    refresh,
    sendTransaction,
    signTransaction,
    slippageBuffer,
    targetWallet,
  ]);

  return (
    <main className="max-w-[1180px] mx-auto w-full px-3 sm:px-5 py-7 md:py-10 space-y-8">
      <PageHeadline
        lineOne="Dealer"
        lineTwo="License"
        subtitle="Mint a dealer license directly from the registry program. The public frontend builds the purchase transaction in the browser and your wallet signs it."
        right={
          <button
            type="button"
            onClick={() => void refresh()}
            className="h-9 px-3 rounded-sm border border-bone/15 bg-inkA font-mono text-[10px] tracking-[0.18em] text-bone hover:border-orange/60 transition"
          >
            REFRESH
          </button>
        }
      />

      <section>
        <SectionHeader
          eyebrow="Registry"
          title="Mint Status"
          subtitle="This page reads the public dealer registry PDA and the target wallet license PDA. It does not depend on the original fast.poker database."
        />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Sold" value={loading && !registry ? '--' : sold.toLocaleString()} sub={`of ${DEALER_LICENSE_TOTAL_SUPPLY.toLocaleString()}`} />
          <Stat label="Next price" value={registry ? sol(currentPriceLamports) : '--'} sub={saleOpen ? 'paid sale open' : salePendingReserve ? 'reserve phase' : saleComplete ? 'sold out' : 'unavailable'} />
          <Stat label="Revenue" value={registry ? sol(registry.totalRevenue) : '--'} sub="registry total" />
          <Stat label="Wallet SOL" value={isConnected ? sol(balanceLamports) : '--'} sub={canAfford ? 'ready' : 'may need more SOL'} />
        </div>
        <div className="mt-4 h-2 rounded-full bg-black/40 overflow-hidden hairline">
          <div className="h-full rounded-full bg-orange" style={{ width: `${progressPct}%` }} />
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-[1fr_0.9fr] gap-4 items-start">
        <div className="rounded-sm hairline bg-inkA p-5">
          <div className="font-display text-bone text-2xl leading-none tracking-wide">
            Mint License
          </div>
          <p className="mt-2 font-sans text-[12px] text-boneDim/70 leading-relaxed">
            Leave recipient blank to mint to the connected wallet, or enter a
            beneficiary wallet to mint for an operator running dealer software.
          </p>
          <div className="mt-5 space-y-3">
            <label className="block">
              <span className="font-mono text-[9px] tracking-[0.18em] text-boneDim/60 uppercase">
                Recipient wallet
              </span>
              <input
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                className="mt-1 h-11 w-full rounded-sm bg-black/35 border border-bone/15 px-3 font-mono text-[12px] text-bone outline-none focus:border-orange/60"
                placeholder={publicKey ? publicKey.toBase58() : 'Connect wallet or paste beneficiary'}
              />
            </label>
            <label className="block">
              <span className="font-mono text-[9px] tracking-[0.18em] text-boneDim/60 uppercase">
                Price protection licenses
              </span>
              <input
                type="number"
                min={0}
                max={100}
                value={slippageBuffer}
                onChange={(e) => setSlippageBuffer(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                className="mt-1 h-11 w-full rounded-sm bg-black/35 border border-bone/15 px-3 font-mono text-[12px] text-bone outline-none focus:border-orange/60"
              />
              <span className="mt-1 block font-mono text-[9px] text-boneDim/50">
                Max accepted price: {sol(maxAcceptedPriceLamports)}
              </span>
            </label>
            <button
              type="button"
              disabled={!isConnected || !saleOpen || !targetIsValid || !!targetLicense || purchasing}
              onClick={() => void purchase()}
              className="h-11 w-full rounded-sm bg-orange text-black font-display text-lg tracking-wide disabled:opacity-45 disabled:cursor-not-allowed hover:brightness-110 transition"
            >
              {purchasing ? 'MINTING...' : `MINT FOR ${registry ? sol(currentPriceLamports) : '--'}`}
            </button>
            {!saleOpen && (
              <div className="font-mono text-[10px] text-amber leading-relaxed">
                {salePendingReserve
                  ? 'Paid sale opens after reserved licenses are issued.'
                  : saleComplete
                    ? 'Dealer license supply is sold out.'
                    : 'Registry unavailable.'}
              </div>
            )}
            {txSig && (
              <div className="font-mono text-[10px] text-emerald-300 break-all">
                Confirmed: {txSig}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {targetLicense ? (
            <LicenseSummary license={targetLicense} />
          ) : (
            <div className="rounded-sm hairline bg-inkA px-4 py-3">
              <div className="font-mono text-[9px] tracking-[0.18em] text-boneDim/55 uppercase">
                Target wallet
              </div>
              <div className="mt-2 font-mono text-[12px] text-bone break-all">
                {targetBase58 || 'No recipient selected'}
              </div>
              <div className="mt-2 font-mono text-[10px] text-boneDim/55">
                {targetIsValid ? 'No license found for this wallet.' : 'Enter a valid Solana wallet.'}
              </div>
            </div>
          )}
          <div className="rounded-sm hairline bg-inkA p-4">
            <div className="font-display text-bone text-xl leading-none tracking-wide">
              Signing Model
            </div>
            <p className="mt-2 font-sans text-[12px] text-boneDim/70 leading-relaxed">
              Dealer minting is not a helper-authority route. The buyer wallet
              signs the purchase transaction and the registry program enforces
              the price, recipient, supply, and revenue split on-chain.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
