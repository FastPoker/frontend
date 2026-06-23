'use client';

// ══════════════════════════════════════════════════════════════════════
// CREATE CASH TABLE · fully client-side, keyless, the creator's own wallet
// signs every transaction. No server, no helper keypair.
//
// Standalone cash-table creation. Same 3-phase on-chain setup; private
// production-server dependencies are removed:
//   - table NAME CLAIM (POST /api/...) — DROPPED. Name was cosmetic and indexer
//     only; a plain on-chain create is the source of truth here.
//   - ER index warm-up via /api/tables/list — DROPPED from create flow. Node
//     FULL discovers the table through the table-list route after creation.
//   - TEE-visibility check switched from /api/tee/token to useGameAuth's
//     authenticated teeConnection (authority token, enough to read account
//     presence). Falls through gracefully if TEE auth isn't ready.
//
// Phase 1 (L1): create_table (+ tip jar, + SPL reward pool / escrow ATAs if SPL,
//               + whitelist if private).
// Phase 2 (L1): init each seat + create table / deckState / seat permissions.
// Phase 3 (L1→delegate): delegate the permission PDAs, then DeckState, SlimBuffer,
//               Table, each Seat, and CrankTallyER to the delegation program, then
//               poll the TEE until the table is visible.
//
// Resume (?resume=<tablePda>) is supported: it reads the table from L1, stamps
// localStorage, and re-runs runSetup (every phase is idempotent / skip-if-exists).
// ══════════════════════════════════════════════════════════════════════

import { useState, useEffect, useMemo, useCallback } from 'react';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { useGameAuth } from '@/hooks/useGameAuth';
import { useConnectModal } from '@/components/wallet/FastPokerConnectModal';
import { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import {
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { makeL1Connection, POKER_MINT, USDC_MINT, TREASURY, ANCHOR_PROGRAM_ID, POOL_PDA, requiresTokenTierConfig } from '@/lib/constants';
import { applyPriorityFee } from '@/lib/priority-fee';
import { BRAND } from '@/lib/branding';
import { invalidateMyCashTables } from '@/lib/table-discovery';
import {
  buildCreateUserTableInstruction,
  buildInitSplRewardPoolInstruction,
  buildAddWhitelistInstruction,
  buildInitTipJarInstruction,
  buildInitTableSeatInstruction,
  buildDelegateTableInstruction,
  buildDelegateSeatInstruction,
  buildDelegateDeckStateInstruction,
  buildDelegateSlimBufferInstruction,
  buildCreateTablePermission,
  buildCreateSeatPermission,
  buildCreateDeckStatePermission,
  buildDelegateTablePermission,
  buildDelegateSeatPermission,
  buildDelegateDeckStatePermission,
  buildDelegateCrankTallyInstruction,
  getTablePda,
  getSeatPda,
  getSeatCardsPda,
  getDeckStatePda,
  getSlimBufferPda,
  getPermissionPda,
  getWhitelistPda,
  getVaultPda,
  getReceiptPda,
  getDepositProofPda,
  getCrankTallyErPda,
  getCrankTallyL1Pda,
  getTipJarPda,
  getSplRewardPoolPda,
  getTokenTierConfigPda,
  getMultipleAccountsInfoChunked,
} from '@/lib/onchain-game';

// ─── Protocol constants ─────────────────────────────────────────────────
const RAKE_PCT      = 5.0;
const CREATOR_SHARE = 50;
const DEALER_SHARE = 20;
const STAKER_SHARE = 20;
const TREASURY_SHARE = 10;
const MIN_LISTED_TOKEN_DECIMALS = 6;

// ─── Token options — premium tokens that don't require auction listing ──
interface TokenOption {
  label: string;
  mint: PublicKey;
  symbol: string;   // internal symbol: 'SOL' | 'POKER' | 'USDC'
  decimals: number;
}
const TOKEN_OPTIONS: TokenOption[] = [
  { label: 'SOL',  mint: PublicKey.default, symbol: 'SOL',   decimals: 9 },
  { label: '$FP',  mint: POKER_MINT,        symbol: 'POKER', decimals: 9 },
  { label: 'USDC', mint: USDC_MINT,         symbol: 'USDC',  decimals: 6 },
];

interface ListedTokenInfo {
  mint: string;
  name: string;
  symbol: string;
  logoURI: string | null;
  decimals: number;
  listedAt: number;
}

// Preset blind levels per denomination (raw units).
const BLIND_PRESETS: Record<string, { sb: number; bb: number; label: string }[]> = {
  SOL: [
    { sb: 5_000_000, bb: 10_000_000, label: '0.005 / 0.01' },
    { sb: 10_000_000, bb: 20_000_000, label: '0.01 / 0.02' },
    { sb: 25_000_000, bb: 50_000_000, label: '0.025 / 0.05' },
    { sb: 50_000_000, bb: 100_000_000, label: '0.05 / 0.1' },
    { sb: 100_000_000, bb: 200_000_000, label: '0.1 / 0.2' },
    { sb: 250_000_000, bb: 500_000_000, label: '0.25 / 0.5' },
  ],
  POKER: [
    { sb: 500_000_000, bb: 1_000_000_000, label: '0.5 / 1' },
    { sb: 1_000_000_000, bb: 2_000_000_000, label: '1 / 2' },
    { sb: 2_500_000_000, bb: 5_000_000_000, label: '2.5 / 5' },
    { sb: 5_000_000_000, bb: 10_000_000_000, label: '5 / 10' },
    { sb: 10_000_000_000, bb: 20_000_000_000, label: '10 / 20' },
    { sb: 25_000_000_000, bb: 50_000_000_000, label: '25 / 50' },
  ],
  USDC: [
    { sb: 50_000, bb: 100_000, label: '0.05 / 0.1' },
    { sb: 500_000, bb: 1_000_000, label: '0.5 / 1' },
    { sb: 1_000_000, bb: 2_000_000, label: '1 / 2' },
    { sb: 2_500_000, bb: 5_000_000, label: '2.5 / 5' },
    { sb: 5_000_000, bb: 10_000_000, label: '5 / 10' },
    { sb: 10_000_000, bb: 20_000_000, label: '10 / 20' },
    { sb: 25_000_000, bb: 50_000_000, label: '25 / 50' },
  ],
};

const MAX_PLAYERS_OPTIONS = [
  { value: 2, label: 'Heads-Up (2)' },
  { value: 6, label: '6-Max (6)' },
  { value: 9, label: 'Full Ring (9)' },
];

const BUY_IN_TYPES = [
  { value: 'normal' as const, label: 'Normal',     minBB: 20, maxBB: 100, feeMult: 1, sub: '20-100 BB' },
  { value: 'deep'   as const, label: 'Deep Stack', minBB: 50, maxBB: 250, feeMult: 2, sub: '50-250 BB, 2 BB fee' },
];

type SetupStep = 'config' | 'creating' | 'init-seats' | 'delegating' | 'done';

const STEP_LABELS: Record<SetupStep, string> = {
  config: 'Configure',
  creating: 'Creating Table',
  'init-seats': 'Initializing Seats',
  delegating: 'Encrypting Table',
  done: 'Complete',
};

const DELEG_PROG_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const LAMPORTS_PER_SOL_NUM = 1_000_000_000;
const FLAT_CREATE_FEE_SOL = 0.05;
const ATA_RENT_SOL_ESTIMATE = 0.0021;
const DLP_DEPOSIT_PER_DELEGATED_SOL = 0.001559 + 0.001573;
const PERMISSION_RENT_SOL = 0.004837;
const TOKEN_TIER_MIN_BB_FALLBACK: Record<string, bigint> = {
  SOL: 1_000n,
  USDC: 100_000n,
};
const TOKEN_TIER_MIN_BB_OFFSET = 180;
const CAP_BPS_BY_TIER_AND_TABLE = [
  [0, 0, 0],
  [30000, 50000, 80000],
  [20000, 40000, 60000],
  [10000, 25000, 40000],
  [5000, 10000, 15000],
  [2500, 5000, 7500],
  [900, 1500, 2000],
];
const SOL_TIER_BOUNDARIES = [10_000_000, 25_000_000, 50_000_000, 100_000_000, 500_000_000, 1_000_000_000, Infinity];
const USDC_TIER_BOUNDARIES = [1_000_000, 2_500_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000, Infinity];

// ─── helpers ─────────────────────────────────────────────────────────────
function cx(...args: (string | boolean | null | undefined)[]) {
  return args.filter(Boolean).join(' ');
}

function parseTokenUnitsExact(input: string, decimals: number): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, fraction = ''] = s.split('.');
  if (fraction.length > decimals) return null;
  const scale = 10n ** BigInt(decimals);
  const paddedFraction = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * scale + BigInt(paddedFraction || '0');
}

function minSmallBlindRawForDecimals(decimals: number): bigint {
  if (decimals <= 4) return 1n;
  return 10n ** BigInt(decimals - 4);
}

function teeDepositSol(seats: number): { dlp: number; permission: number; total: number } {
  const dlp = (6 + 2 * seats) * DLP_DEPOSIT_PER_DELEGATED_SOL;
  const permission = (2 + 2 * seats) * PERMISSION_RENT_SOL;
  return { dlp, permission, total: dlp + permission };
}

function knownFastPokerRentSpaces(seats: number): number[] {
  return [
    478,
    113,
    81,
    75,
    241,
    205,
    205,
    ...Array.from({ length: seats }, () => 284),
    ...Array.from({ length: seats }, () => 76),
    ...Array.from({ length: seats }, () => 90),
    ...Array.from({ length: seats }, () => 131),
  ];
}

function localRentLamports(size: number): number {
  return (128 + size) * 3480 * 2;
}

function tableTypeIndex(maxPlayers: number): number {
  if (maxPlayers === 2) return 0;
  if (maxPlayers <= 6) return 1;
  return 2;
}

function tierIndexForBoundary(bigBlind: bigint, boundaries: number[]): number {
  const bb = Number(bigBlind);
  const idx = boundaries.findIndex((max) => bb <= max);
  return idx >= 0 ? idx : boundaries.length - 1;
}

function rakeCapLine(symbol: string, bigBlind: bigint, maxPlayers: number): string {
  const boundaries = symbol === 'SOL'
    ? SOL_TIER_BOUNDARIES
    : symbol === 'USDC'
      ? USDC_TIER_BOUNDARIES
      : null;
  if (!boundaries) return `${RAKE_PCT}% of pot`;
  const tier = tierIndexForBoundary(bigBlind, boundaries);
  const bps = CAP_BPS_BY_TIER_AND_TABLE[tier]?.[tableTypeIndex(maxPlayers)] ?? 0;
  if (bps === 0) return `${RAKE_PCT}% of pot - no cap at this blind tier`;
  const capBb = bps / 10_000;
  return `${RAKE_PCT}% of pot - cap ${capBb.toLocaleString(undefined, { maximumFractionDigits: 2 })} BB`;
}

function formatTokenUnits(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionText}`;
}

// Detect a wallet-popup rejection (vs a genuine failure). Cancel → quietly
// return to the form; a real error stays visible.
function isUserRejection(e: unknown): boolean {
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001) return true;
  const msg = (err?.message || '').toLowerCase();
  return (
    msg.includes('user rejected') ||
    msg.includes('rejected the request') ||
    msg.includes('request rejected') ||
    msg.includes('user denied') ||
    msg.includes('transaction was rejected') ||
    msg.includes('user cancelled') ||
    msg.includes('user canceled') ||
    msg.includes('approval denied')
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-boneDim/60">{children}</div>;
}

function Seg<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string; sub?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex w-full gap-2">
      {options.map(o => {
        const active = value === o.value;
        return (
          <button key={o.value} type="button" onClick={() => onChange(o.value)}
            className={cx(
              'flex-1 px-3 py-2.5 rounded-sm border transition text-left',
              active ? 'bg-orange/10 border-orange/60' : 'border-white/10 bg-black/40 hover:border-orange/30',
            )}>
            <div className={cx('font-display text-[14px] leading-none', active ? 'text-orange' : 'text-bone')}>{o.label}</div>
            {o.sub && <div className="font-mono text-[9.5px] text-boneDim/55 tracking-wide mt-1.5 leading-none">{o.sub}</div>}
          </button>
        );
      })}
    </div>
  );
}

function SegPill({ options, value, onChange }: {
  options: { value: number; label: string }[];
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="inline-flex w-full gap-2">
      {options.map(o => {
        const active = value === o.value;
        return (
          <button key={o.value} type="button" onClick={() => onChange(o.value)}
            className={cx(
              'flex-1 px-3 py-2.5 rounded-sm border transition text-center',
              active ? 'bg-orange/10 border-orange/60 text-orange' : 'border-white/10 bg-black/40 text-bone hover:border-orange/30',
            )}>
            <div className="font-display text-[14px] leading-none">{o.label}</div>
          </button>
        );
      })}
    </div>
  );
}

function SummaryRow({ label, value, sub, tone }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'emerald' | 'amber';
}) {
  return (
    <div className="px-4 py-2.5 flex items-start justify-between gap-4 border-b border-white/[0.06] last:border-b-0">
      <div className="min-w-0">
        <div className="font-mono text-[11px] text-boneDim/75 tracking-wide leading-none">{label}</div>
        {sub && <div className="font-mono text-[9.5px] text-boneDim/45 tracking-wide mt-1 leading-snug">{sub}</div>}
      </div>
      <div className={cx(
        'text-right text-[13px] leading-none pt-[1px]',
        tone === 'emerald' ? 'text-emerald-400' : '',
        tone === 'amber' ? 'text-amber' : '',
      )}>
        {value}
      </div>
    </div>
  );
}

function WhitelistEditor({ addresses, onChange }: {
  addresses: string[];
  onChange: (a: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const valid = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
  const add = () => {
    const v = draft.trim();
    if (!valid(v) || addresses.includes(v)) { setDraft(''); return; }
    onChange([...addresses, v]);
    setDraft('');
  };
  const remove = (a: string) => onChange(addresses.filter(x => x !== a));
  return (
    <div className="mt-3">
      <Eyebrow>Whitelisted wallets</Eyebrow>
      <div className="mt-1.5 flex items-center gap-2">
        <input value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="paste Solana address..."
          className="flex-1 px-3 py-2 rounded-sm border border-white/10 bg-black/40 font-mono text-[12px] text-bone outline-none focus:border-orange/50 tabular-nums" />
        <button type="button" onClick={add} disabled={!valid(draft)}
          className={cx('px-3 py-2 rounded-sm font-mono text-[10px] tracking-wider border transition',
            valid(draft) ? 'border-orange/60 text-orange hover:bg-orange/10' : 'border-white/10 text-boneDim/40 cursor-not-allowed')}>
          + ADD
        </button>
      </div>
      {addresses.length === 0 ? (
        <div className="mt-2 px-3 py-3 rounded-sm border border-dashed border-white/10 font-mono text-[10px] text-boneDim/55 tracking-wide text-center">
          no wallets whitelisted yet - only whitelisted wallets can sit at this table
        </div>
      ) : (
        <div className="mt-2 space-y-1">
          {addresses.map(a => (
            <div key={a} className="flex items-center gap-2 px-2.5 py-1.5 rounded-sm border border-white/10 bg-black/30">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
              <span className="font-mono text-[11px] text-bone tabular-nums truncate flex-1">{a.slice(0, 8)}...{a.slice(-6)}</span>
              <button type="button" onClick={() => remove(a)} className="font-mono text-[10px] text-boneDim/55 hover:text-red-400 px-1">x</button>
            </div>
          ))}
        </div>
      )}
      <div className="font-mono text-[9.5px] text-boneDim/50 tracking-wide mt-1.5 leading-relaxed">
        host wallet is always included · editable after launch
      </div>
    </div>
  );
}

export default function CreateTablePage() {
  const { isConnected: connected, publicKey, sendTransaction, signTransaction, signAllTransactions } = useUnifiedWallet();
  const { open: openConnect } = useConnectModal();
  const { teeConnection, teeAuthenticated } = useGameAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const conn = useMemo(() => makeL1Connection(), []);

  // Batch-sign support: when the wallet can't signAllTransactions, fall back to
  // signing each tx individually (one popup per tx).
  const useSequentialSetup = !signAllTransactions;

  // ── Config state ──
  const [tokenCategory, setTokenCategory] = useState<'premium' | 'listed'>('premium');
  const [denomIdx, setDenomIdx] = useState(0);
  const [presetIdx, setPresetIdx] = useState(1);
  const [customMode, setCustomMode] = useState(false);
  const [customSB, setCustomSB] = useState('');
  const [customBB, setCustomBB] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(6);
  const [buyInType, setBuyInType] = useState<'normal' | 'deep'>('normal');
  const [isPrivate, setIsPrivate] = useState(false);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(false);

  // ── Listed tokens ──
  const [listedTokens, setListedTokens] = useState<ListedTokenInfo[]>([]);
  const [listedLoading, setListedLoading] = useState(false);
  const [selectedListed, setSelectedListed] = useState<ListedTokenInfo | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [tokenBalanceRaw, setTokenBalanceRaw] = useState<bigint | null>(null);
  const [knownRentEstimateSol, setKnownRentEstimateSol] = useState<number | null>(null);
  const [tierMinBigBlindRaw, setTierMinBigBlindRaw] = useState<bigint | null>(null);

  // ── Multi-step state ──
  const [step, setStep] = useState<SetupStep>('config');
  const [stepProgress, setStepProgress] = useState('');
  const [tablePdaKey, setTablePdaKey] = useState<PublicKey | null>(null);
  const [resumeAvailable, setResumeAvailable] = useState(false);

  // ── Fetch listed tokens (proxy-backed, no on-chain gPA in the browser) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setListedLoading(true);
      try {
        const r = await fetch('/api/listed-tokens', { cache: 'no-store' });
        if (!r.ok) { if (!cancelled) setListedTokens([]); return; }
        const body = (await r.json()) as { tokens?: Array<{ mint: string; listedAt: number }> };
        const mints = (body.tokens ?? []).map(t => t.mint).filter(Boolean);
        if (mints.length === 0) { if (!cancelled) setListedTokens([]); return; }
        const conn = makeL1Connection();
        const [meta, ...mintInfos] = await Promise.all([
          fetch(`/api/token-meta?mints=${mints.join(',')}`).then(r2 => r2.ok ? r2.json() : ({})).catch(() => ({})) as Promise<Record<string, { name?: string; symbol?: string; logoURI?: string }>>,
          ...mints.map(m => conn.getAccountInfo(new PublicKey(m)).catch(() => null)),
        ]);
        const out: ListedTokenInfo[] = mints.map((m, i) => {
          const mi = mintInfos[i];
          let decimals = 9;
          if (mi && mi.data.length >= 45) decimals = mi.data[44];
          return {
            mint: m,
            name: meta[m]?.name || m.slice(0, 8) + '...',
            symbol: meta[m]?.symbol || '???',
            logoURI: meta[m]?.logoURI || null,
            decimals,
            listedAt: (body.tokens ?? []).find(t => t.mint === m)?.listedAt ?? 0,
          };
        });
        out.sort((a, b) => b.listedAt - a.listedAt);
        if (!cancelled) setListedTokens(out);
      } catch {
        if (!cancelled) setListedTokens([]);
      } finally {
        if (!cancelled) setListedLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Resume: ?resume=<tablePda> reads the table from L1 and stamps localStorage ──
  useEffect(() => {
    if (!publicKey) return;
    const resumePda = searchParams.get('resume');
    if (!resumePda) {
      // Also surface a banner if local progress exists from a prior interrupt.
      try {
        const saved = localStorage.getItem(`create-table-${publicKey.toBase58()}`);
        if (saved) {
          const data = JSON.parse(saved);
          if (data.tableId && data.tablePda && data.maxPlayers) setResumeAvailable(true);
        }
      } catch { /* ignore */ }
      return;
    }
    (async () => {
      try {
        const conn = makeL1Connection();
        const tablePda = new PublicKey(resumePda);
        const info = await conn.getAccountInfo(tablePda);
        if (!info) { setError('Table not found on L1'); return; }
        const data = Buffer.from(info.data);
        const tableId = Array.from(data.subarray(8, 40));
        const mp = data[121]; // MAX_PLAYERS offset
        localStorage.setItem(`create-table-${publicKey.toBase58()}`, JSON.stringify({
          tableId, tablePda: resumePda, maxPlayers: mp, createdAt: Date.now(),
        }));
        setResumeAvailable(true);
      } catch (e) {
        console.error('Failed to load table for resume:', e);
      }
    })();
  }, [publicKey, searchParams]);

  // ── Active denomination ──
  const denom: TokenOption = useMemo(() => {
    if (tokenCategory === 'listed' && selectedListed) {
      try {
        return {
          label: selectedListed.symbol,
          mint: new PublicKey(selectedListed.mint),
          symbol: selectedListed.symbol,
          decimals: selectedListed.decimals,
        };
      } catch { /* fall through */ }
    }
    return TOKEN_OPTIONS[denomIdx];
  }, [tokenCategory, selectedListed, denomIdx]);

  const presets = BLIND_PRESETS[denom.symbol] || null;
  const effectiveCustomMode = customMode || !presets;
  const listedTokenDecimalsValid = tokenCategory !== 'listed' || denom.decimals >= MIN_LISTED_TOKEN_DECIMALS;
  const activePreset = presets ? (presets[presetIdx] || presets[0]) : null;
  const denomMintStr = denom.mint.toBase58();

  useEffect(() => {
    if (!requiresTokenTierConfig(denom.mint)) {
      setTierMinBigBlindRaw(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const info = await conn.getAccountInfo(getTokenTierConfigPda(denom.mint), 'confirmed');
        if (cancelled) return;
        if (!info || info.data.length < TOKEN_TIER_MIN_BB_OFFSET + 8) {
          setTierMinBigBlindRaw(null);
          return;
        }
        setTierMinBigBlindRaw(Buffer.from(info.data).readBigUInt64LE(TOKEN_TIER_MIN_BB_OFFSET));
      } catch {
        if (!cancelled) setTierMinBigBlindRaw(null);
      }
    })();
    return () => { cancelled = true; };
  }, [conn, denomMintStr, denom.mint]);

  const displaySb = useMemo(() => {
    if (effectiveCustomMode) return parseFloat(customSB) || 0;
    if (!activePreset) return 0;
    return activePreset.sb / 10 ** denom.decimals;
  }, [effectiveCustomMode, customSB, activePreset, denom.decimals]);
  const displayBb = useMemo(() => {
    if (effectiveCustomMode) return parseFloat(customBB) || 0;
    if (!activePreset) return 0;
    return activePreset.bb / 10 ** denom.decimals;
  }, [effectiveCustomMode, customBB, activePreset, denom.decimals]);

  const stakesUnit = denom.symbol === 'POKER' ? '$FP' : denom.symbol;
  const genericMinSmallBlindRaw = useMemo(() => minSmallBlindRawForDecimals(denom.decimals), [denom.decimals]);
  const fallbackMinBigBlindRaw = requiresTokenTierConfig(denom.mint) ? (TOKEN_TIER_MIN_BB_FALLBACK[denom.symbol] ?? null) : null;
  const protocolMinBigBlindRaw = tierMinBigBlindRaw ?? fallbackMinBigBlindRaw;
  const genericMinBigBlindRaw = genericMinSmallBlindRaw * 2n;
  const minBigBlindRaw = protocolMinBigBlindRaw && protocolMinBigBlindRaw > genericMinBigBlindRaw
    ? protocolMinBigBlindRaw
    : genericMinBigBlindRaw;
  const protocolMinSmallBlindRaw = (minBigBlindRaw + 1n) / 2n;
  const minSmallBlindRaw = protocolMinSmallBlindRaw > genericMinSmallBlindRaw
    ? protocolMinSmallBlindRaw
    : genericMinSmallBlindRaw;
  const minBlindLabel = `${formatTokenUnits(minSmallBlindRaw, denom.decimals)} / ${formatTokenUnits(minBigBlindRaw, denom.decimals)} ${stakesUnit}`;

  const { smallBlind, bigBlind, blindsValid, blindError } = useMemo(() => {
    if (!listedTokenDecimalsValid) {
      return { smallBlind: 0n, bigBlind: 0n, blindsValid: false, blindError: `Listed tokens need at least ${MIN_LISTED_TOKEN_DECIMALS} decimals` };
    }
    if (effectiveCustomMode) {
      const sbRaw = parseTokenUnitsExact(customSB, denom.decimals);
      const bbRaw = parseTokenUnitsExact(customBB, denom.decimals);
      if (sbRaw === null || bbRaw === null || sbRaw <= 0n || bbRaw <= 0n) {
        return { smallBlind: 0n, bigBlind: 0n, blindsValid: false, blindError: `Use up to ${denom.decimals} decimals` };
      }
      if (bbRaw !== sbRaw * 2n) {
        return { smallBlind: sbRaw, bigBlind: bbRaw, blindsValid: false, blindError: 'BB must be exactly 2x SB' };
      }
      if (sbRaw < minSmallBlindRaw || bbRaw < minBigBlindRaw) {
        return { smallBlind: sbRaw, bigBlind: bbRaw, blindsValid: false, blindError: `Minimum blinds ${minBlindLabel}` };
      }
      return { smallBlind: sbRaw, bigBlind: bbRaw, blindsValid: true, blindError: null };
    }
    const p = presets![presetIdx] || presets![0];
    const sbRaw = BigInt(p.sb);
    const bbRaw = BigInt(p.bb);
    const valid = sbRaw >= minSmallBlindRaw && bbRaw >= minBigBlindRaw;
    return { smallBlind: sbRaw, bigBlind: bbRaw, blindsValid: valid, blindError: valid ? null : `Minimum blinds ${minBlindLabel}` };
  }, [effectiveCustomMode, customSB, customBB, denom.decimals, listedTokenDecimalsValid, minBigBlindRaw, minBlindLabel, minSmallBlindRaw, presetIdx, presets]);

  const isSol = denom.mint.equals(PublicKey.default);
  const buyInInfo = BUY_IN_TYPES.find(b => b.value === buyInType)!;
  const denomFee = bigBlind * BigInt(buyInInfo.feeMult);
  const denomFeeDisplayAmount = Number(denomFee) / 10 ** denom.decimals;
  const denomFeeDisplay = `${denomFeeDisplayAmount.toLocaleString(undefined, { maximumFractionDigits: 9 })} ${stakesUnit}`;
  const protocolSolFee = FLAT_CREATE_FEE_SOL + (isSol ? denomFeeDisplayAmount : 0);
  const teeDeposit = teeDepositSol(maxPlayers);
  const ataRentSol = isSol ? 0 : ATA_RENT_SOL_ESTIMATE;
  const totalCostSol = protocolSolFee + (knownRentEstimateSol ?? 0) + teeDeposit.total + ataRentSol;
  const refundableSol = (knownRentEstimateSol ?? 0) + teeDeposit.dlp + teeDeposit.permission + ataRentSol;
  const requiredSol = totalCostSol + 0.006;
  const solInsufficient = solBalance !== null && solBalance < requiredSol;
  const tokenInsufficient = !isSol && tokenBalanceRaw !== null && tokenBalanceRaw < denomFee;
  const tokenBalanceDisplay = tokenBalanceRaw !== null ? Number(tokenBalanceRaw) / 10 ** denom.decimals : null;
  const rakeLine = rakeCapLine(denom.symbol, bigBlind, maxPlayers);

  useEffect(() => {
    if (!publicKey) {
      setSolBalance(null);
      setTokenBalanceRaw(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const lamports = await conn.getBalance(publicKey, 'confirmed');
        if (!cancelled) setSolBalance(lamports / LAMPORTS_PER_SOL_NUM);
      } catch {
        if (!cancelled) setSolBalance(null);
      }
      if (isSol) {
        if (!cancelled) setTokenBalanceRaw(null);
        return;
      }
      try {
        const ata = await getAssociatedTokenAddress(denom.mint, publicKey, false);
        const balance = await conn.getTokenAccountBalance(ata);
        if (!cancelled) setTokenBalanceRaw(BigInt(balance.value.amount));
      } catch {
        if (!cancelled) setTokenBalanceRaw(0n);
      }
    })();
    return () => { cancelled = true; };
  }, [conn, denom.mint, denomMintStr, isSol, publicKey]);

  useEffect(() => {
    let cancelled = false;
    const sizes = knownFastPokerRentSpaces(maxPlayers);
    (async () => {
      try {
        const uniqueSizes = Array.from(new Set(sizes));
        const rents = await Promise.all(uniqueSizes.map(size => conn.getMinimumBalanceForRentExemption(size)));
        if (cancelled) return;
        const bySize = new Map(uniqueSizes.map((size, i) => [size, rents[i]]));
        const total = sizes.reduce((sum, size) => sum + (bySize.get(size) ?? localRentLamports(size)), 0);
        setKnownRentEstimateSol(total / LAMPORTS_PER_SOL_NUM);
      } catch {
        if (cancelled) return;
        const total = sizes.reduce((sum, size) => sum + localRentLamports(size), 0);
        setKnownRentEstimateSol(total / LAMPORTS_PER_SOL_NUM);
      }
    })();
    return () => { cancelled = true; };
  }, [conn, maxPlayers]);

  const isProcessing = step !== 'config' && step !== 'done';
  const fmt = (n: number, d = 3) => Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(d);

  // ── localStorage progress ──
  const saveProgress = useCallback((tId: Uint8Array, tPda: PublicKey, mp: number) => {
    if (!publicKey) return;
    localStorage.setItem(`create-table-${publicKey.toBase58()}`, JSON.stringify({
      tableId: Array.from(tId), tablePda: tPda.toBase58(), maxPlayers: mp, createdAt: Date.now(),
    }));
  }, [publicKey]);
  const clearProgress = useCallback(() => {
    if (!publicKey) return;
    localStorage.removeItem(`create-table-${publicKey.toBase58()}`);
    setResumeAvailable(false);
  }, [publicKey]);

  // ── delegation check ──
  const isDelegated = useCallback(async (connection: Connection, pda: PublicKey): Promise<boolean> => {
    const rec = delegationRecordPdaFromDelegatedAccount(pda);
    const info = await connection.getAccountInfo(rec);
    return !!info;
  }, []);

  // ── single TX send + poll confirmation ──
  const sendSingleTx = useCallback(async (tx: Transaction, connection: Connection, label: string): Promise<string> => {
    tx.feePayer = publicKey!;
    const { blockhash, lastValidBlockHeight } = await getLatestBlockhashClient(connection);
    tx.recentBlockhash = blockhash;
    await applyPriorityFee(tx);
    let sig: string;
    if (signTransaction) {
      const signed = await signTransaction(tx);
      sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    } else {
      sig = await sendTransaction!(tx, connection, { skipPreflight: false });
    }
    for (let poll = 0; poll < 60; poll++) {
      const status = await connection.getSignatureStatus(sig);
      const cs = status?.value?.confirmationStatus;
      if (cs === 'confirmed' || cs === 'finalized') {
        if (status!.value!.err) throw new Error(`[${label}] TX confirmed but failed: ${JSON.stringify(status!.value!.err)}`);
        return sig;
      }
      if (poll % 10 === 9) {
        const h = await connection.getBlockHeight('confirmed');
        if (h > lastValidBlockHeight) throw new Error(`[${label}] TX blockhash expired. Click Resume to retry.`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`[${label}] TX confirmation timed out after 60s. Click Resume to retry.`);
  }, [publicKey, sendTransaction, signTransaction]);

  const batchSignTransactions = useCallback(async (txs: Transaction[], connection: Connection): Promise<{ signed: Transaction[]; lastValidBlockHeight: number }> => {
    if (!signAllTransactions) throw new Error('Wallet does not support batch signing');
    const { blockhash, lastValidBlockHeight } = await getLatestBlockhashClient(connection);
    for (const tx of txs) {
      tx.feePayer = publicKey!;
      tx.recentBlockhash = blockhash;
      await applyPriorityFee(tx);
    }
    const signed = await signAllTransactions(txs);
    return { signed: signed as Transaction[], lastValidBlockHeight };
  }, [publicKey, signAllTransactions]);

  const sendSignedTxAndConfirm = useCallback(async (signedTx: Transaction, connection: Connection, label: string, lastValidBlockHeight: number): Promise<string> => {
    const sig = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: false });
    for (let poll = 0; poll < 60; poll++) {
      const status = await connection.getSignatureStatus(sig);
      const cs = status?.value?.confirmationStatus;
      if (cs === 'confirmed' || cs === 'finalized') {
        if (status!.value!.err) throw new Error(`[${label}] TX confirmed but failed: ${JSON.stringify(status!.value!.err)}`);
        return sig;
      }
      if (poll % 10 === 9) {
        const h = await connection.getBlockHeight('confirmed');
        if (h > lastValidBlockHeight) throw new Error(`[${label}] TX blockhash expired. Click Resume to retry.`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`[${label}] TX confirmation timed out after 60s. Click Resume to retry.`);
  }, []);

  const ensureTipJarInitialized = useCallback(async (connection: Connection, tablePda: PublicKey): Promise<void> => {
    const [tipJarPda] = getTipJarPda(tablePda);
    const existing = await connection.getAccountInfo(tipJarPda).catch(() => null);
    if (existing && existing.data.length > 8) return;
    setStepProgress('Approve in wallet: Initialize TipJar...');
    await sendSingleTx(new Transaction().add(buildInitTipJarInstruction(publicKey!, tablePda)), connection, 'init-tip-jar');
  }, [publicKey, sendSingleTx]);

  // ── Core 3-phase setup ──
  const runSetup = useCallback(async (tableId: Uint8Array, tablePda: PublicKey, mp: number) => {
    if (!publicKey || (!sendTransaction && !signTransaction)) return;
    const connection = makeL1Connection();

    // ═══ PHASE 1: Create table (+ tip jar, + SPL ATAs, + whitelist) ═══
    setStep('creating');
    {
      const existing = await connection.getAccountInfo(tablePda);
      if (existing) {
        setStepProgress('Table exists, skipping...');
      } else {
        let creatorAta: PublicKey | undefined;
        let treasuryAta: PublicKey | undefined;
        let poolAta: PublicKey | undefined;
        let tableEscrowAta: PublicKey | undefined;
        const preIxs: TransactionInstruction[] = [];

        if (!isSol) {
          creatorAta = await getAssociatedTokenAddress(denom.mint, publicKey, false);
          treasuryAta = await getAssociatedTokenAddress(denom.mint, TREASURY, true);
          poolAta = await getAssociatedTokenAddress(denom.mint, POOL_PDA, true);
          tableEscrowAta = await getAssociatedTokenAddress(denom.mint, tablePda, true);

          const [creatorAtaInfo, treasuryAtaInfo, poolAtaInfo, escrowAtaInfo] = await Promise.all([
            connection.getAccountInfo(creatorAta),
            connection.getAccountInfo(treasuryAta),
            connection.getAccountInfo(poolAta),
            connection.getAccountInfo(tableEscrowAta),
          ]);

          const denomFeeRaw = Number(bigBlind) * (buyInType === 'deep' ? 2 : 1);
          if (creatorAtaInfo) {
            const tokenBalance = await connection.getTokenAccountBalance(creatorAta);
            if (Number(tokenBalance.value.amount) < denomFeeRaw) {
              throw new Error(`Insufficient ${stakesUnit} balance. Need ${denomFeeRaw / 10 ** denom.decimals} ${stakesUnit} for the denomination fee. Balance: ${tokenBalance.value.uiAmountString}`);
            }
          } else {
            throw new Error(`No ${stakesUnit} tokens. Need ${denomFeeRaw / 10 ** denom.decimals} ${stakesUnit} for the denomination fee.`);
          }

          if (!treasuryAtaInfo) preIxs.push(createAssociatedTokenAccountInstruction(publicKey, treasuryAta, TREASURY, denom.mint));
          if (!poolAtaInfo) preIxs.push(createAssociatedTokenAccountInstruction(publicKey, poolAta, POOL_PDA, denom.mint));
          if (!escrowAtaInfo) preIxs.push(createAssociatedTokenAccountInstruction(publicKey, tableEscrowAta, tablePda, denom.mint));
          const splRewardPool = getSplRewardPoolPda(denom.mint);
          const splRewardPoolInfo = await connection.getAccountInfo(splRewardPool);
          if (!splRewardPoolInfo) preIxs.push(buildInitSplRewardPoolInstruction(publicKey, denom.mint));
        }

        const { instruction: createIx } = buildCreateUserTableInstruction(
          publicKey, tableId, smallBlind, bigBlind, mp,
          denom.mint, creatorAta, treasuryAta, buyInType === 'deep' ? 1 : 0, poolAta, isPrivate, tableEscrowAta,
        );

        setStepProgress('Approve in wallet: Create table (1/3)...');
        const tx = new Transaction();
        preIxs.forEach(ix => tx.add(ix));
        tx.add(createIx);
        await sendSingleTx(tx, connection, 'create-table');

        if (isPrivate && whitelist.length > 0) {
          const players = [...new Set(whitelist.map(a => a.trim()).filter(Boolean))]
            .map(a => new PublicKey(a))
            .filter(pk => !pk.equals(publicKey));
          const missingWhitelistIxs: TransactionInstruction[] = [];
          for (const playerPk of players) {
            const [wlPda] = getWhitelistPda(tablePda, playerPk);
            if (!(await connection.getAccountInfo(wlPda))) {
              missingWhitelistIxs.push(buildAddWhitelistInstruction(publicKey, tablePda, playerPk));
            }
          }
          for (let start = 0; start < missingWhitelistIxs.length; start += 8) {
            const wtx = new Transaction();
            for (const ix of missingWhitelistIxs.slice(start, start + 8)) wtx.add(ix);
            await sendSingleTx(wtx, connection, `seed-whitelist-${start / 8 + 1}`);
          }
        }
      }
      const tableInfo = await connection.getAccountInfo(tablePda);
      if (!tableInfo) throw new Error('Table account not found after create step. Click Resume to retry.');
      await ensureTipJarInitialized(connection, tablePda);
      saveProgress(tableId, tablePda, mp);
    }

    // ═══ PHASE 2: Init seats + create permissions ═══
    setStep('init-seats');
    {
      const phase2Txs: Transaction[] = [];
      const SEAT_INIT_BATCH = 3;
      const seatExists: boolean[] = [];

      // Read every seat PDA at once to figure out which seats need init.
      const seatPdas: PublicKey[] = [];
      for (let i = 0; i < mp; i++) seatPdas.push(getSeatPda(tablePda, i)[0]);
      const seatInfos = await getMultipleAccountsInfoChunked(connection, seatPdas);
      for (let i = 0; i < mp; i++) seatExists[i] = !!seatInfos[i];

      for (let batch = 0; batch < mp; batch += SEAT_INIT_BATCH) {
        const end = Math.min(batch + SEAT_INIT_BATCH, mp);
        const missing: number[] = [];
        for (let i = batch; i < end; i++) if (!seatExists[i]) missing.push(i);
        if (missing.length === 0) continue;
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }));
        for (const i of missing) tx.add(buildInitTableSeatInstruction(publicKey, tablePda, i));
        phase2Txs.push(tx);
      }

      // Create permissions (table, deck, per-seat) — skip any that exist.
      const [tablePermPda] = getPermissionPda(tablePda);
      const [deckStatePdaForPerm] = getDeckStatePda(tablePda);
      const [deckPermPda] = getPermissionPda(deckStatePdaForPerm);
      const permissionChecks: Array<{ pda: PublicKey; ix: () => TransactionInstruction }> = [
        { pda: tablePermPda, ix: () => buildCreateTablePermission(publicKey, tablePda) },
        { pda: deckPermPda, ix: () => buildCreateDeckStatePermission(publicKey, tablePda) },
      ];
      for (let i = 0; i < mp; i++) {
        const [seatPermPda] = getPermissionPda(getSeatPda(tablePda, i)[0]);
        permissionChecks.push({ pda: seatPermPda, ix: () => buildCreateSeatPermission(publicKey, tablePda, i) });
      }
      const permissionInfos = await getMultipleAccountsInfoChunked(connection, permissionChecks.map(p => p.pda));
      const missingPermissionIxs: TransactionInstruction[] = [];
      for (let i = 0; i < permissionChecks.length; i++) if (!permissionInfos[i]) missingPermissionIxs.push(permissionChecks[i].ix());

      if (missingPermissionIxs.length > 0) {
        const PERM_CREATE_BATCH = 6;
        for (let batch = 0; batch < missingPermissionIxs.length; batch += PERM_CREATE_BATCH) {
          const end = Math.min(batch + PERM_CREATE_BATCH, missingPermissionIxs.length);
          const tx = new Transaction();
          tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }));
          for (let i = batch; i < end; i++) tx.add(missingPermissionIxs[i]);
          phase2Txs.push(tx);
        }
      }

      if (phase2Txs.length > 0) {
        setStepProgress(`Approve in wallet: Init seats + permissions (2/3). ${phase2Txs.length} TX${phase2Txs.length === 1 ? '' : 's'}...`);
        if (!useSequentialSetup) {
          const { signed, lastValidBlockHeight } = await batchSignTransactions(phase2Txs, connection);
          for (let i = 0; i < signed.length; i++) {
            setStepProgress(`Initializing seats + permissions (${i + 1}/${signed.length})...`);
            await sendSignedTxAndConfirm(signed[i], connection, `phase2-${i + 1}`, lastValidBlockHeight);
          }
        } else {
          for (let i = 0; i < phase2Txs.length; i++) {
            setStepProgress(`Approve in wallet: seats + permissions (${i + 1}/${phase2Txs.length})...`);
            await sendSingleTx(phase2Txs[i], connection, `phase2-${i + 1}`);
          }
        }
      }
      saveProgress(tableId, tablePda, mp);
    }

    // ═══ PHASE 3: Delegations ═══
    setStep('delegating');
    const delegItems: { name: string; pda: PublicKey; buildTx: () => Transaction }[] = [];
    {
      const permTxs: Transaction[] = [];
      const acctTxs: Transaction[] = [];

      // Permission delegations (table, deck, per-seat).
      const [tablePermPda] = getPermissionPda(tablePda);
      const [deckPermPdaForDeleg] = getPermissionPda(getDeckStatePda(tablePda)[0]);
      const permissionDelegationChecks: Array<{ pda: PublicKey; ix: () => TransactionInstruction }> = [
        { pda: tablePermPda, ix: () => buildDelegateTablePermission(publicKey, tablePda, DELEGATION_PROGRAM_ID, tableId) },
        { pda: deckPermPdaForDeleg, ix: () => buildDelegateDeckStatePermission(publicKey, tablePda, DELEGATION_PROGRAM_ID) },
      ];
      for (let i = 0; i < mp; i++) {
        const [seatPermPda] = getPermissionPda(getSeatPda(tablePda, i)[0]);
        permissionDelegationChecks.push({ pda: seatPermPda, ix: () => buildDelegateSeatPermission(publicKey, tablePda, i, DELEGATION_PROGRAM_ID) });
      }
      const permDelegInfos = await getMultipleAccountsInfoChunked(
        connection, permissionDelegationChecks.map(p => delegationRecordPdaFromDelegatedAccount(p.pda)),
      );
      const missingPermissionDelegationIxs: TransactionInstruction[] = [];
      for (let i = 0; i < permissionDelegationChecks.length; i++) {
        if (!permDelegInfos[i]) missingPermissionDelegationIxs.push(permissionDelegationChecks[i].ix());
      }
      if (missingPermissionDelegationIxs.length > 0) {
        const PERM_BATCH = 4;
        for (let batch = 0; batch < missingPermissionDelegationIxs.length; batch += PERM_BATCH) {
          const end = Math.min(batch + PERM_BATCH, missingPermissionDelegationIxs.length);
          const tx = new Transaction();
          tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }));
          for (let i = batch; i < end; i++) tx.add(missingPermissionDelegationIxs[i]);
          permTxs.push(tx);
        }
      }

      const addDelegTx = (name: string, pda: PublicKey, buildIx: () => TransactionInstruction) => {
        const cu = name === 'table' ? 800_000 : 400_000;
        const makeTx = () => {
          const t = new Transaction();
          t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
          t.add(buildIx());
          return t;
        };
        acctTxs.push(makeTx());
        delegItems.push({ name, pda, buildTx: makeTx });
      };

      // DeckState
      const [dsPda] = getDeckStatePda(tablePda);
      if (!(await isDelegated(connection, dsPda))) {
        const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(dsPda, ANCHOR_PROGRAM_ID);
        const rec = delegationRecordPdaFromDelegatedAccount(dsPda);
        const meta = delegationMetadataPdaFromDelegatedAccount(dsPda);
        addDelegTx('deckState', dsPda, () => buildDelegateDeckStateInstruction(publicKey, tablePda, buf, rec, meta, DELEGATION_PROGRAM_ID));
      }
      // SlimBuffer (must be delegated before the table — delegate_table checks it)
      const [slimPda] = getSlimBufferPda(tablePda);
      if (!(await isDelegated(connection, slimPda))) {
        const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(slimPda, ANCHOR_PROGRAM_ID);
        const rec = delegationRecordPdaFromDelegatedAccount(slimPda);
        const meta = delegationMetadataPdaFromDelegatedAccount(slimPda);
        addDelegTx('slimBuffer', slimPda, () => buildDelegateSlimBufferInstruction(publicKey, tablePda, buf, rec, meta, DELEGATION_PROGRAM_ID));
      }
      // Table (after DeckState + SlimBuffer)
      if (!(await isDelegated(connection, tablePda))) {
        const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(tablePda, ANCHOR_PROGRAM_ID);
        const rec = delegationRecordPdaFromDelegatedAccount(tablePda);
        const meta = delegationMetadataPdaFromDelegatedAccount(tablePda);
        addDelegTx('table', tablePda, () => buildDelegateTableInstruction(publicKey, tablePda, tableId, buf, rec, meta, DELEGATION_PROGRAM_ID, mp));
      }
      // Seats
      for (let i = 0; i < mp; i++) {
        const [seatPda] = getSeatPda(tablePda, i);
        if (!(await isDelegated(connection, seatPda))) {
          const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seatPda, ANCHOR_PROGRAM_ID);
          const rec = delegationRecordPdaFromDelegatedAccount(seatPda);
          const meta = delegationMetadataPdaFromDelegatedAccount(seatPda);
          addDelegTx(`seat${i}`, seatPda, () => buildDelegateSeatInstruction(publicKey, tablePda, i, buf, rec, meta, DELEGATION_PROGRAM_ID));
        }
      }
      // CrankTallyER
      const [ctPda] = getCrankTallyErPda(tablePda);
      if (!(await isDelegated(connection, ctPda))) {
        const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(ctPda, ANCHOR_PROGRAM_ID);
        const rec = delegationRecordPdaFromDelegatedAccount(ctPda);
        const meta = delegationMetadataPdaFromDelegatedAccount(ctPda);
        addDelegTx('crankTallyER', ctPda, () => buildDelegateCrankTallyInstruction(publicKey, tablePda, buf, rec, meta, DELEGATION_PROGRAM_ID));
      }

      const allTxs = [...permTxs, ...acctTxs];
      if (allTxs.length > 0) {
        setStepProgress(`Approve in wallet: Encrypt table (3/3). ${allTxs.length} TX${allTxs.length === 1 ? '' : 's'}...`);
        let batchLastValidBlockHeight: number | null = null;
        let signedPermTxs: Transaction[] = [];
        let signedAcctItems: Array<typeof delegItems[number] & { signedTx?: Transaction }> = delegItems.map(item => ({ ...item }));

        if (!useSequentialSetup) {
          const { signed, lastValidBlockHeight } = await batchSignTransactions(allTxs, connection);
          batchLastValidBlockHeight = lastValidBlockHeight;
          signedPermTxs = signed.slice(0, permTxs.length);
          const signedAcctTxs = signed.slice(permTxs.length);
          signedAcctItems = delegItems.map((item, i) => ({ ...item, signedTx: signedAcctTxs[i] }));
        }

        const waitForDelegated = async (items: Array<{ name: string; pda: PublicKey }>, timeoutSeconds: number) => {
          if (items.length === 0) return;
          for (let poll = 0; poll < timeoutSeconds; poll++) {
            const statuses = await Promise.all(items.map(item => isDelegated(connection, item.pda)));
            if (statuses.every(Boolean)) return;
            await new Promise(r => setTimeout(r, 1000));
          }
          const statuses = await Promise.all(items.map(item => isDelegated(connection, item.pda)));
          const missing = items.filter((_, i) => !statuses[i]).map(item => item.name).join(', ');
          if (missing) throw new Error(`Delegation not confirmed for ${missing}. Click Resume to retry.`);
        };

        // Wave 1: permission delegations
        if (permTxs.length > 0) {
          for (let i = 0; i < permTxs.length; i++) {
            if (useSequentialSetup) {
              setStepProgress(`Approve in wallet: Delegating permissions (${i + 1}/${permTxs.length})...`);
              await sendSingleTx(permTxs[i], connection, `deleg-perms-${i + 1}`);
            } else {
              setStepProgress(`Delegating permissions (${i + 1}/${permTxs.length})...`);
              await sendSignedTxAndConfirm(signedPermTxs[i], connection, `deleg-perms-${i + 1}`, batchLastValidBlockHeight!);
            }
          }
          const [tablePermCheck] = getPermissionPda(tablePda);
          await waitForDelegated([{ name: 'tablePermission', pda: tablePermCheck }], 30);
        }
        saveProgress(tableId, tablePda, mp);

        // Wave 2: account delegations (prerequisites → table → rest)
        if (delegItems.length > 0) {
          const sendDelegItem = async (item: typeof signedAcctItems[number]) => {
            if (useSequentialSetup) {
              setStepProgress(`Approve in wallet: Delegating ${item.name}...`);
              return sendSingleTx(item.buildTx(), connection, `deleg-${item.name}`);
            }
            if (!item.signedTx || batchLastValidBlockHeight === null) throw new Error(`Missing signed delegation TX for ${item.name}. Click Resume to retry.`);
            setStepProgress(`Delegating ${item.name}...`);
            return sendSignedTxAndConfirm(item.signedTx, connection, `deleg-${item.name}`, batchLastValidBlockHeight);
          };

          const tableItems = signedAcctItems.filter(item => item.name === 'table');
          const prerequisiteItems = signedAcctItems.filter(item => item.name === 'deckState' || item.name === 'slimBuffer');
          const remainingItems = signedAcctItems.filter(item => item.name !== 'table' && item.name !== 'deckState' && item.name !== 'slimBuffer');

          for (const item of prerequisiteItems) await sendDelegItem(item);
          await waitForDelegated(prerequisiteItems, 45);

          if (tableItems.length > 0) {
            await waitForDelegated([{ name: 'slimBuffer', pda: getSlimBufferPda(tablePda)[0] }], 45);
            for (const item of tableItems) await sendDelegItem(item);
            await waitForDelegated(tableItems, 45);
          }
          for (const item of remainingItems) await sendDelegItem(item);

          const delegCheckPdas = [
            tablePda,
            getSlimBufferPda(tablePda)[0],
            getDeckStatePda(tablePda)[0],
            getCrankTallyErPda(tablePda)[0],
          ];
          for (let i = 0; i < mp; i++) delegCheckPdas.push(getSeatPda(tablePda, i)[0]);
          for (let poll = 0; poll < 30; poll++) {
            const statuses = await Promise.all(delegCheckPdas.map(p => isDelegated(connection, p)));
            if (statuses.every(Boolean)) break;
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
      saveProgress(tableId, tablePda, mp);
    }

    // ═══ Verify TEE picked up the delegated accounts ═══
    // Uses the authenticated teeConnection from useGameAuth (authority token is
    // enough to read account presence). If TEE auth isn't ready we skip the
    // check rather than block the flow — the table is already delegated on L1.
    setStepProgress('Verifying table on the private layer...');
    const allPdas: { name: string; pda: PublicKey }[] = [
      { name: 'table', pda: tablePda },
      { name: 'slimBuffer', pda: getSlimBufferPda(tablePda)[0] },
      { name: 'deckState', pda: getDeckStatePda(tablePda)[0] },
      { name: 'crankTallyER', pda: getCrankTallyErPda(tablePda)[0] },
    ];
    for (let i = 0; i < mp; i++) allPdas.push({ name: `seat${i}`, pda: getSeatPda(tablePda, i)[0] });

    const checkTeeVisibility = async (): Promise<string[]> => {
      try {
        if (!teeAuthenticated) return allPdas.map(p => p.name);
        const results = await Promise.all(allPdas.map(({ pda }) => teeConnection.getAccountInfo(pda).then(r => !!r).catch(() => false)));
        return allPdas.filter((_, i) => !results[i]).map(p => p.name);
      } catch { return allPdas.map(p => p.name); }
    };

    let missing = await checkTeeVisibility();
    for (let attempt = 0; attempt < 12 && missing.length > 0; attempt++) {
      setStepProgress(`Waiting for the private layer... (${missing.length} pending, attempt ${attempt + 1}/12)`);
      await new Promise(r => setTimeout(r, 2000));
      missing = await checkTeeVisibility();
    }
    if (missing.length > 0) {
      console.warn(`Private-layer sync incomplete: ${missing.length} account(s) pending [${missing.join(', ')}]. Proceeding anyway.`);
    }

    invalidateMyCashTables(publicKey.toBase58());
    clearProgress();
    setStep('done');
    setStepProgress('Table is live!');
    setTimeout(() => router.push(`/game?table=${tablePda.toBase58()}`), 1800);
  }, [
    publicKey, sendTransaction, signTransaction, sendSingleTx, sendSignedTxAndConfirm, batchSignTransactions,
    useSequentialSetup, ensureTipJarInitialized, isDelegated, isSol, denom, smallBlind, bigBlind, buyInType,
    isPrivate, whitelist, saveProgress, clearProgress, router, teeConnection, teeAuthenticated, stakesUnit,
  ]);

  const withErrorHandling = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e: unknown) {
      if (isUserRejection(e)) {
        setStep('config');
        setStepProgress('');
        setError(null);
        return;
      }
      console.error('Table setup failed:', e);
      let msg = 'Transaction failed';
      const err = e as Error;
      if (err?.message) {
        msg = err.message;
        const anchorMatch = msg.match(/custom program error: (0x[0-9a-fA-F]+)/);
        if (anchorMatch) msg = `Program error: ${anchorMatch[1]}. ${msg}`;
      }
      setError(msg);
      setStep('config');
    }
  }, []);

  const handleFullSetup = useCallback(async () => {
    if (!publicKey || (!sendTransaction && !signTransaction) || !blindsValid) return;
    await withErrorHandling(async () => {
      const tableId = new Uint8Array(32);
      crypto.getRandomValues(tableId);
      const [tablePda] = getTablePda(tableId);
      setTablePdaKey(tablePda);
      await runSetup(tableId, tablePda, maxPlayers);
    });
  }, [publicKey, sendTransaction, signTransaction, blindsValid, maxPlayers, runSetup, withErrorHandling]);

  const handleResume = useCallback(async () => {
    if (!publicKey) return;
    await withErrorHandling(async () => {
      const saved = localStorage.getItem(`create-table-${publicKey.toBase58()}`);
      if (!saved) return;
      let tableId: Uint8Array;
      let tablePda: PublicKey;
      let mp: number;
      try {
        const data = JSON.parse(saved);
        if (!Array.isArray(data.tableId) || data.tableId.length !== 32) throw new Error('corrupt tableId');
        tableId = new Uint8Array(data.tableId);
        tablePda = new PublicKey(data.tablePda);
        mp = Number(data.maxPlayers);
        if (!Number.isFinite(mp) || mp < 2 || mp > 9) throw new Error('invalid maxPlayers');
      } catch (parseErr) {
        console.warn('Corrupt resume state, clearing:', parseErr);
        clearProgress();
        setError('Saved setup was corrupted · cleared, please start fresh');
        return;
      }
      setTablePdaKey(tablePda);
      setMaxPlayers(mp);
      await runSetup(tableId, tablePda, mp);
    });
  }, [publicKey, runSetup, withErrorHandling, clearProgress]);

  const stepOrder: SetupStep[] = ['config', 'creating', 'init-seats', 'delegating', 'done'];
  const stepIdx = stepOrder.indexOf(step);
  const canCreate = blindsValid && !(tokenCategory === 'listed' && !selectedListed) && !solInsufficient && !tokenInsufficient;

  // ─── RENDER ─────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-ink text-bone flex flex-col">
      <div className="flex-1 max-w-[640px] w-full mx-auto px-5 pt-6 pb-12">
        <Link href="/my-tables" className="inline-flex items-center gap-1.5 font-mono text-[11px] text-boneDim/70 hover:text-bone tracking-wide mb-4 transition">
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M7.5 3L4.5 6L7.5 9" /></svg>
          Back to My Tables
        </Link>

        <section className="glass-room p-5 fade-in">
          <div className="mb-5">
            <h1 className="font-display text-bone text-[28px] leading-none tracking-wide">Create Cash Game Table</h1>
            <p className="font-mono text-[11px] text-boneDim/70 tracking-wide mt-2 leading-relaxed">
              Earn <span className="text-emerald-400">{CREATOR_SHARE}%</span> of every pot&apos;s rake as the table creator
              <span className="text-boneDim/50"> ({DEALER_SHARE}% dealers, {STAKER_SHARE}% stakers, {TREASURY_SHARE}% Platform Fee)</span>.
              {' '}On {BRAND.name}, your wallet signs every step — no server, no custody.
            </p>
          </div>

          {/* Resume banner */}
          {resumeAvailable && step === 'config' && (
            <div className="mb-5 px-4 py-3 rounded-sm border bg-amber/10 border-amber/20">
              <div className="font-display text-amber text-[13px] leading-none mb-1.5">Incomplete table setup</div>
              <p className="font-mono text-boneDim text-[10px] mb-3 tracking-wide">A previous create was interrupted. Resume picks up where it left off (every step is safe to re-run), or discard to start fresh.</p>
              <div className="flex gap-2">
                <button type="button" onClick={handleResume} className="px-3 py-1.5 font-mono text-[10px] tracking-wider rounded-sm bg-amber/10 text-amber hover:bg-amber/20 transition border border-amber/20">Resume Setup</button>
                <button type="button" onClick={clearProgress} className="px-3 py-1.5 font-mono text-[10px] tracking-wider rounded-sm bg-white/[0.04] text-boneDim hover:bg-white/[0.08] transition border border-white/10">Discard</button>
              </div>
            </div>
          )}

          {/* Step indicator + processing overlay */}
          {step !== 'config' && (
            <div className="mb-5">
              <div className="flex items-center gap-1 mb-2">
                {stepOrder.slice(1).map((s, i) => {
                  const sIdx = i + 1;
                  const isDone = stepIdx > sIdx;
                  const isActive = stepIdx === sIdx;
                  return (
                    <div key={s} className="flex items-center flex-1">
                      <div className={cx('h-1 flex-1 rounded-full transition-all', isDone ? 'bg-emerald-500' : isActive ? 'bg-orange animate-pulse' : 'bg-white/[0.06]')} />
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 mt-2">
                {step === 'done' ? (
                  <span className="font-display text-emerald-400 text-[14px]">Table setup complete!</span>
                ) : (
                  <>
                    <div className="w-3 h-3 border-2 border-orange border-t-transparent rounded-full animate-spin flex-shrink-0" />
                    <span className="font-mono text-orange text-[11px] tracking-wide">{stepProgress}</span>
                  </>
                )}
              </div>
              {tablePdaKey && <div className="mt-2 font-mono text-[9px] text-boneDim/60 break-all">Table: {tablePdaKey.toBase58()}</div>}
              {isProcessing && (
                <div className="mt-3 px-3 py-2 rounded-sm bg-orange/[0.04] border border-orange/20 font-mono text-[10px] text-boneDim/75 leading-relaxed tracking-wide">
                  <span className="text-orange/90 font-bold">Do not close or refresh this tab.</span> Setup has 3 stages and may ask for several wallet confirmations. The final encrypt step syncs in the background (usually 5-15s). If it errors, come back here and use Resume.
                </div>
              )}
            </div>
          )}

          {/* Not connected */}
          {!connected ? (
            <div className="py-10 text-center">
              <p className="font-mono text-[11px] text-boneDim/70 tracking-wide mb-4">connect your wallet to create a table</p>
              <button type="button" onClick={openConnect} className="btn-orange px-5 py-2.5 text-sm font-display tracking-wide rounded-md">Connect wallet</button>
            </div>
          ) : (
            <div className={cx('space-y-5', isProcessing && 'pointer-events-none opacity-50')}>

              {/* TOKEN */}
              <div>
                <Eyebrow>Token (currency)</Eyebrow>
                <div className="mt-2 mb-3 inline-flex w-full gap-0 p-[2px] rounded-sm border border-white/10 bg-black/40">
                  {[{ v: 'premium' as const, label: 'SOL / $FP / USDC' }, { v: 'listed' as const, label: 'Listed Tokens' }].map(t => {
                    const active = tokenCategory === t.v;
                    return (
                      <button key={t.v} type="button"
                        onClick={() => {
                          setTokenCategory(t.v);
                          if (t.v === 'listed') setCustomMode(true);
                          else { setSelectedListed(null); setCustomMode(false); }
                        }}
                        className={cx('flex-1 px-3 py-2 rounded-sm font-mono text-[11px] tracking-[0.14em] transition', active ? 'bg-white/[0.06] text-bone font-bold' : 'text-boneDim hover:text-bone')}>
                        {t.label}
                        {t.v === 'listed' && listedTokens.length > 0 && <span className="ml-1 text-[9px] opacity-60">({listedTokens.length})</span>}
                      </button>
                    );
                  })}
                </div>

                {tokenCategory === 'premium' ? (
                  <div className="grid grid-cols-3 gap-2">
                    {TOKEN_OPTIONS.map((t, idx) => {
                      const active = denomIdx === idx;
                      const label = t.symbol === 'POKER' ? '$FP' : t.symbol;
                      return (
                        <button key={t.symbol} type="button"
                          onClick={() => { setDenomIdx(idx); setPresetIdx(1); setCustomMode(false); setShowPresets(false); }}
                          className={cx('flex flex-col items-center gap-1.5 py-3.5 rounded-sm border transition', active ? 'bg-orange/10 border-orange/60' : 'border-white/10 bg-black/40 hover:border-orange/30')}>
                          <span className={cx('font-display text-[15px] leading-none tracking-wide', active ? 'text-orange' : 'text-bone')}>{label}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div>
                    {listedLoading ? (
                      <div className="px-3 py-4 text-center font-mono text-[10px] text-boneDim/55 tracking-wide">loading listed tokens...</div>
                    ) : listedTokens.length === 0 ? (
                      <div className="px-3 py-4 text-center font-mono text-[10px] text-boneDim/55 tracking-wide">no tokens listed yet</div>
                    ) : (
                      <select
                        value={selectedListed?.mint ?? ''}
                        onChange={e => setSelectedListed(listedTokens.find(t => t.mint === e.target.value) ?? null)}
                        className="w-full px-3 py-2.5 rounded-sm border border-white/10 bg-black/40 font-mono text-[12px] text-bone outline-none focus:border-orange/50">
                        <option value="">select a token...</option>
                        {listedTokens.map(t => (
                          <option key={t.mint} value={t.mint}>{t.symbol} · {t.name} · {t.decimals}d</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>

              {/* BLINDS */}
              <div>
                <div className="flex items-baseline justify-between">
                  <Eyebrow>Blinds ({stakesUnit})</Eyebrow>
                  {presets && (
                    <button type="button"
                      onClick={() => { if (effectiveCustomMode) { setCustomMode(false); setShowPresets(false); } else setShowPresets(s => !s); }}
                      className="font-mono text-[10px] text-orange hover:text-orangeHi tracking-wider">
                      {effectiveCustomMode ? 'Use presets' : showPresets ? 'Hide presets' : 'Use presets'}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div>
                    <div className="font-mono text-[9.5px] text-boneDim/55 tracking-wide mb-1">Small Blind</div>
                    <input type="number" step="any"
                      value={effectiveCustomMode ? customSB : displaySb}
                      onChange={e => {
                        if (!effectiveCustomMode) setCustomMode(true);
                        const val = e.target.value;
                        setCustomSB(val);
                        const num = parseFloat(val);
                        if (!isNaN(num) && num > 0) setCustomBB(String(num * 2));
                      }}
                      placeholder="0.01"
                      className="w-full px-3 py-2.5 rounded-sm border border-white/10 bg-black/40 font-mono text-[14px] text-bone tabular-nums outline-none focus:border-orange/50" />
                  </div>
                  <div>
                    <div className="font-mono text-[9.5px] text-boneDim/55 tracking-wide mb-1">Big Blind</div>
                    <input type="number" step="any"
                      value={effectiveCustomMode ? customBB : displayBb}
                      onChange={e => {
                        if (!effectiveCustomMode) setCustomMode(true);
                        const val = e.target.value;
                        setCustomBB(val);
                        const num = parseFloat(val);
                        if (!isNaN(num) && num > 0) setCustomSB(String(num / 2));
                      }}
                      placeholder="0.02"
                      className="w-full px-3 py-2.5 rounded-sm border border-white/10 bg-black/40 font-mono text-[14px] text-bone tabular-nums outline-none focus:border-orange/50" />
                  </div>
                  {effectiveCustomMode && customSB && customBB && !blindsValid && blindError && (
                    <div className="col-span-2 font-mono text-[10px] text-red-300 tracking-wide">{blindError}</div>
                  )}
                </div>
                {presets && !effectiveCustomMode && showPresets && (
                  <div className="grid grid-cols-3 gap-1.5 mt-2">
                    {presets.map((p, i) => {
                      const rawSb = p.sb / 10 ** denom.decimals;
                      const rawBb = p.bb / 10 ** denom.decimals;
                      const active = presetIdx === i;
                      return (
                        <button key={i} type="button"
                          onClick={() => { setPresetIdx(i); setCustomMode(false); }}
                          className={cx('px-2 py-1.5 rounded-sm border text-center transition', active ? 'bg-orange/10 border-orange/60 text-orange' : 'border-white/10 bg-black/40 text-bone hover:border-orange/30')}>
                          <span className="font-display text-[12.5px] tabular-nums leading-none">{fmt(rawSb, 3)}/{fmt(rawBb, 3)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {!presets && (
                  <div className="font-mono text-[9.5px] text-boneDim/50 tracking-wide mt-1.5">enter blind values in {stakesUnit}; minimum {minBlindLabel}</div>
                )}
                {presets && (
                  <div className="font-mono text-[9.5px] text-boneDim/50 tracking-wide mt-1.5">protocol minimum {minBlindLabel}</div>
                )}
              </div>

              {/* BUY-IN TYPE */}
              <div>
                <Eyebrow>Buy-in type</Eyebrow>
                <div className="mt-2">
                  <Seg value={buyInType} onChange={v => setBuyInType(v)} options={BUY_IN_TYPES.map(b => ({ value: b.value, label: b.label, sub: b.sub }))} />
                </div>
              </div>

              {/* TABLE SIZE */}
              <div>
                <Eyebrow>Table size</Eyebrow>
                <div className="mt-2"><SegPill value={maxPlayers} onChange={setMaxPlayers} options={MAX_PLAYERS_OPTIONS} /></div>
              </div>

              {/* TABLE ACCESS */}
              <div>
                <Eyebrow>Table access</Eyebrow>
                <div className="mt-2">
                  <Seg value={isPrivate ? 'private' : 'public'} onChange={v => setIsPrivate(v === 'private')}
                    options={[{ value: 'public', label: 'Public', sub: 'Anyone can join' }, { value: 'private', label: 'Private', sub: 'Whitelist only' }]} />
                </div>
                {isPrivate && <WhitelistEditor addresses={whitelist} onChange={setWhitelist} />}
              </div>

              {/* SUMMARY */}
              <div className="rounded-sm border border-white/10 bg-black/30 overflow-hidden">
                <SummaryRow label="Token" value={<span className={cx('font-display text-bone', denom.symbol === 'POKER' && 'text-orange')}>{stakesUnit}</span>} />
                <SummaryRow label={`Blinds (${stakesUnit})`} value={<span className="font-display text-bone tabular-nums">{fmt(displaySb, 3)} / {fmt(displayBb, 3)} {stakesUnit}</span>} />
                <SummaryRow label="Table size" value={<span className="font-display text-bone">{maxPlayers === 2 ? 'Heads-Up' : maxPlayers === 6 ? '6-max' : 'Full Ring (9)'}</span>} />
                <SummaryRow label="Buy-in range" value={<span className="font-display text-bone tabular-nums">{buyInInfo.minBB}-{buyInInfo.maxBB} BB{buyInType === 'deep' ? ', deep' : ''}</span>} />
                <SummaryRow label="Access" value={isPrivate ? <span className="font-display text-gold">Private · whitelist</span> : <span className="font-display text-bone">Public</span>} />
                <SummaryRow label="Creator rake" tone="emerald" value={<span className="font-display">{CREATOR_SHARE}% of {RAKE_PCT}% pot rake</span>}
                  sub={<span>{rakeLine} <span className="text-boneDim/50 ml-1">· remaining rake: {DEALER_SHARE}% dealers, {STAKER_SHARE}% stakers, {TREASURY_SHARE}% Platform Fee</span></span>} />
                <div className="h-px bg-white/[0.06]" />
                <SummaryRow label="SOL protocol fee" tone="amber"
                  value={<span className="font-display text-amber tabular-nums">{protocolSolFee.toFixed(3)} SOL</span>}
                  sub={<span className="text-rose-300">{isSol ? `0.05 SOL flat + ${denomFeeDisplay} denomination fee` : '0.05 SOL flat fee via Steel'}</span>} />
                {!isSol && (
                  <SummaryRow label="Token denomination fee" tone="amber"
                    value={<span className="font-display text-amber tabular-nums">{denomFeeDisplay}</span>}
                    sub={<span>Charged in {stakesUnit}; split between Platform Fee and staker pool</span>} />
                )}
                <SummaryRow label="Table setup & rent" tone="emerald"
                  value={<span className="font-display text-emerald-300 tabular-nums">{knownRentEstimateSol == null ? 'calculating...' : `~${refundableSol.toFixed(4)} SOL`}</span>}
                  sub={<span className="text-emerald-300">Refundable later by closing an eligible empty table.{!isSol ? ` Token tables include about ${ATA_RENT_SOL_ESTIMATE.toFixed(4)} SOL of refundable setup rent.` : ''}</span>} />
                <div className="h-px bg-white/[0.06]" />
                <SummaryRow label="Total to create"
                  value={<span className="font-display text-bone tabular-nums text-[15px]">{knownRentEstimateSol == null ? 'calculating...' : `~${totalCostSol.toFixed(4)} SOL`}</span>}
                  sub={<span>Plus a small per-transaction network fee.</span>} />
                {(solInsufficient || tokenInsufficient) && (
                  <div className="px-4 py-3 border-t border-red-500/20 bg-red-500/[0.07] font-mono text-[10px] text-red-300 leading-relaxed space-y-1">
                    <div className="tracking-[0.16em] uppercase text-red-300/90">Not enough funds</div>
                    {solInsufficient && solBalance !== null && (
                      <div>Need ~{requiredSol.toFixed(4)} SOL (fees + setup/rent), wallet has {solBalance.toFixed(4)} SOL.</div>
                    )}
                    {tokenInsufficient && (
                      <div>Need {denomFeeDisplayAmount.toLocaleString(undefined, { maximumFractionDigits: 9 })} {stakesUnit} for the denomination fee, wallet has {(tokenBalanceDisplay ?? 0).toLocaleString(undefined, { maximumFractionDigits: 9 })}.</div>
                    )}
                  </div>
                )}
                <div className="px-4 py-2 font-mono text-[9.5px] text-boneDim/50 tracking-wide leading-relaxed">
                  3 setup stages, all signed by your wallet. Keep this tab open until setup finishes.
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-sm p-3 font-mono text-[11px] text-red-300 tracking-wide break-words">{error}</div>
              )}

              {/* CTA */}
              <button type="button"
                onClick={handleFullSetup}
                disabled={isProcessing || !canCreate || step === 'done'}
                className={cx('w-full rounded-sm py-3.5 font-display text-[15px] tracking-[0.1em] transition',
                  !canCreate ? 'bg-white/[0.04] border border-white/10 text-boneDim/40 cursor-not-allowed'
                    : step === 'done' ? 'bg-emerald-500/20 border border-emerald-400/50 text-emerald-300'
                      : isProcessing ? 'bg-orange/10 border border-orange/30 text-orange cursor-wait' : 'btn-orange')}>
                {!canCreate
                  ? (tokenCategory === 'listed' && !selectedListed
                    ? 'Select a token first'
                    : !blindsValid
                      ? 'Set valid blinds'
                      : solInsufficient
                        ? 'Need more SOL'
                        : tokenInsufficient
                          ? `Need more ${stakesUnit}`
                          : 'Create unavailable')
                  : step === 'done' ? 'Table Live - Redirecting...'
                    : isProcessing ? STEP_LABELS[step] : 'Create & Setup Table'}
              </button>

              <p className="font-mono text-[10px] text-boneDim/55 tracking-wide text-center leading-relaxed">
                Protocol and network fees are non-refundable. Setup rent can be reclaimed later by closing an eligible empty table.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
