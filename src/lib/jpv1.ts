/**
 * JPV1 jackpot receipt decoder.
 *
 * JPV1 receipts are emitted by the FastPoker program from
 * `settle_sng_hand_jackpot` whenever a Mini or Grand jackpot resolves on
 * a single SNG hand. The receipt is durably inlined as an SPL Memo CPI
 * (131 bytes) and also surfaced as an Anchor `JackpotEvent`.
 *
 * On-chain layout (programs/fastpoker/src/state/jpv1.rs):
 *
 *   off  field                     type
 *   ---  ------------------------  --------
 *   0    magic                     b"JPV1"
 *   4    version                   u8 (=1)
 *   5    table                     [u8; 32]
 *   37   hand_number               u64 LE
 *   45   active_mask               u16 LE
 *   47   mini_opt_in_mask          u16 LE
 *   49   mini_hit                  u8 (0/1)
 *   50   mini_paid_total           u64 LE
 *   58   mini_per_seat_lamports    u64 LE
 *   66   grand_hit                 u8 (0/1)
 *   67   grand_unrefined_amount    u64 LE
 *   75   grand_acc_delta           u128 LE
 *   91   hit_sequence              u64 LE
 *   99   rolling_hash              [u8; 32]
 *   131  END
 */
import { PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';

export const JPV1_MAGIC = 'JPV1';
export const JPV1_PAYLOAD_LEN = 131;
export const JPV1_VERSION = 1;
export const JPV1_MEMO_PREFIX = 'JPV1B64:';

/** SPL Memo program id (used by the JPV1 emission CPI). */
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export interface JackpotReceipt {
  /** Base58 table pubkey the receipt was emitted for. */
  table: string;
  /** SNG hand number the jackpot resolved on. */
  handNumber: number;
  /** Bitmask of seats that were active during the hand. */
  activeMask: number;
  /** Bitmask of seats that opted-in to Mini for this hand. */
  miniOptInMask: number;
  /** True if the Mini jackpot triggered. */
  miniHit: boolean;
  /** Total lamports paid out to Mini opt-in seats (sum across seats). */
  miniPaidTotal: number;
  /** Per-seat Mini payout in lamports (paid to each opted-in active seat). */
  miniPerSeatLamports: number;
  /** True if the Grand jackpot triggered on this hand. */
  grandHit: boolean;
  /** Captured `global.grand_unrefined_pool` immediately before the Grand zero step. */
  grandUnrefinedAmount: number;
  /** Grand accumulator delta (u128 stringified to avoid precision loss). */
  grandAccDelta: string;
  /** Monotonic post-increment hit counter (first hit = 1). */
  hitSequence: number;
  /** SlimBuffer rolling-hash chain head at the hand boundary, hex-encoded. */
  rollingHash: string;
  /** Source transaction signature (only set when sourced from a tx). */
  txSig: string;
  /** Slot of the source transaction (0 if unknown). */
  slot: number;
  /** Block time of the source transaction (Unix seconds, null if unknown). */
  blockTime: number | null;
}

function bytesEquals(a: Uint8Array, b: Uint8Array | number[], len: number): boolean {
  if (a.length < len) return false;
  for (let i = 0; i < len; i++) {
    if (a[i] !== (b as any)[i]) return false;
  }
  return true;
}

function readU16LE(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

function readU64LE(buf: Uint8Array, off: number): number {
  // Solana lamport amounts comfortably fit Number.MAX_SAFE_INTEGER (2^53-1)
  // for all realistic FastPoker payouts. Use BigInt to compute then narrow.
  const view = Buffer.from(buf.buffer, buf.byteOffset + off, 8);
  const v = view.readBigUInt64LE(0);
  return Number(v);
}

function readU128LE(buf: Uint8Array, off: number): string {
  const lo = Buffer.from(buf.buffer, buf.byteOffset + off, 8).readBigUInt64LE(0);
  const hi = Buffer.from(buf.buffer, buf.byteOffset + off + 8, 8).readBigUInt64LE(0);
  return ((hi << BigInt(64)) | lo).toString();
}

function toHex(buf: Uint8Array): string {
  return Buffer.from(buf).toString('hex');
}

const JPV1_MAGIC_BYTES = Buffer.from(JPV1_MAGIC, 'utf8');

/**
 * Decode a 131-byte JPV1 payload. Returns null on bad magic, wrong
 * version, or wrong length. Does not throw on malformed input.
 *
 * `txSig`, `slot`, and `blockTime` default to empty/0/null and are
 * normally filled in by `extractJpv1FromMemo` when sourced from a tx.
 */
export function parseJpv1Bytes(
  bytes: Buffer | Uint8Array,
  ctx?: { txSig?: string; slot?: number; blockTime?: number | null },
): JackpotReceipt | null {
  if (bytes.length !== JPV1_PAYLOAD_LEN) return null;
  const buf = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  if (!bytesEquals(buf, JPV1_MAGIC_BYTES, 4)) return null;
  if (buf[4] !== JPV1_VERSION) return null;

  const tablePk = new PublicKey(buf.subarray(5, 37));
  return {
    table: tablePk.toBase58(),
    handNumber: readU64LE(buf, 37),
    activeMask: readU16LE(buf, 45),
    miniOptInMask: readU16LE(buf, 47),
    miniHit: buf[49] === 1,
    miniPaidTotal: readU64LE(buf, 50),
    miniPerSeatLamports: readU64LE(buf, 58),
    grandHit: buf[66] === 1,
    grandUnrefinedAmount: readU64LE(buf, 67),
    grandAccDelta: readU128LE(buf, 75),
    hitSequence: readU64LE(buf, 91),
    rollingHash: toHex(buf.subarray(99, 131)),
    txSig: ctx?.txSig ?? '',
    slot: ctx?.slot ?? 0,
    blockTime: ctx?.blockTime ?? null,
  };
}

/** Base58 alphabet used by Solana public keys / tx data. */
const BS58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str: string): Buffer {
  let n = BigInt(0);
  for (const c of str) {
    const i = BS58.indexOf(c);
    if (i < 0) throw new Error('Bad b58 char: ' + c);
    n = n * BigInt(58) + BigInt(i);
  }
  const hexValue = n.toString(16);
  const padded = hexValue.length % 2 ? '0' + hexValue : hexValue;
  const bytes = Buffer.from(padded, 'hex');
  const leading = str.match(/^1*/)?.[0].length ?? 0;
  return Buffer.concat([Buffer.alloc(leading), bytes]);
}

function ixDataToBuffer(data: unknown): Buffer {
  if (typeof data === 'string') return base58Decode(data);
  if (Array.isArray(data)) return Buffer.from(data as number[]);
  if (data && typeof data === 'object' && 'type' in (data as any) && (data as any).type === 'Buffer') {
    return Buffer.from((data as any).data ?? []);
  }
  return Buffer.alloc(0);
}

function memoBytesToJpv1Payload(dataBuf: Buffer): Buffer | null {
  if (dataBuf.length === JPV1_PAYLOAD_LEN) return dataBuf;
  const text = dataBuf.toString('utf8');
  if (!text.startsWith(JPV1_MEMO_PREFIX)) return null;
  try {
    const decoded = Buffer.from(text.slice(JPV1_MEMO_PREFIX.length), 'base64');
    return decoded.length === JPV1_PAYLOAD_LEN ? decoded : null;
  } catch {
    return null;
  }
}

function keyToString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const obj = value as any;
    if (typeof obj.pubkey === 'string') return obj.pubkey;
    if (typeof obj.pubkey?.toBase58 === 'function') return obj.pubkey.toBase58();
    if (typeof obj.toBase58 === 'function') return obj.toBase58();
    if (typeof obj.toString === 'function') {
      const s = obj.toString();
      return s === '[object Object]' ? null : s;
    }
  }
  return null;
}

function keyAt(message: any, index: number, loadedAddresses?: any): string | null {
  const staticKeys = message?.accountKeys ?? message?.staticAccountKeys ?? [];
  if (index < staticKeys.length) return keyToString(staticKeys[index]);
  const loadedWritable = loadedAddresses?.writable ?? [];
  const loadedReadonly = loadedAddresses?.readonly ?? [];
  const loaded = [...loadedWritable, ...loadedReadonly];
  return keyToString(loaded[index - staticKeys.length]);
}

/**
 * Scan the parsed transaction for SPL Memo program instructions and
 * extract every JPV1 receipt found. Inspects both top-level and
 * inner instructions — the FastPoker program emits the Memo CPI from
 * inside `settle_sng_hand_jackpot` so the bytes live in inner ix.
 *
 * Returns null if the tx is missing/null. Returns an empty array when
 * there are no Memo instructions at all (caller can distinguish "no
 * tx" from "tx had no jackpot receipt").
 */
export function extractJpv1FromMemo(tx: ParsedTransactionWithMeta | null): JackpotReceipt[] | null {
  if (!tx) return null;
  const sig = tx.transaction?.signatures?.[0] ?? '';
  const slot = tx.slot ?? 0;
  const blockTime = tx.blockTime ?? null;

  const message: any = tx.transaction?.message ?? {};
  const loadedAddresses = (tx.meta as any)?.loadedAddresses;

  const receipts: JackpotReceipt[] = [];

  const inspect = (ix: any) => {
    // Parsed form: getParsedTransaction returns either ParsedInstruction
    // (`programId`, `parsed`) or PartiallyDecodedInstruction
    // (`programId`, `data`). Memo bytes only appear in the latter.
    let programId: string | null = null;
    let dataBuf: Buffer = Buffer.alloc(0);

    if (ix?.programId) {
      programId = keyToString(ix.programId);
    } else if (typeof ix?.programIdIndex === 'number') {
      programId = keyAt(message, ix.programIdIndex, loadedAddresses);
    } else if (typeof ix?.programAddressIndex === 'number') {
      programId = keyAt(message, ix.programAddressIndex, loadedAddresses);
    }

    if (programId !== MEMO_PROGRAM_ID) return;

    if (typeof ix?.data === 'string' || Array.isArray(ix?.data)) {
      dataBuf = ixDataToBuffer(ix.data);
    } else if (ix?.parsed && typeof ix.parsed === 'string') {
      // Parsed memo program returns the decoded utf-8 string. JPV1 is
      // raw bytes so it surfaces as a non-utf8 fallback or as a
      // base58 string in `ix.data` — fall through to the raw
      // representation only.
      dataBuf = Buffer.from(ix.parsed, 'utf8');
    }

    const payload = memoBytesToJpv1Payload(dataBuf);
    if (!payload) return;
    const r = parseJpv1Bytes(payload, { txSig: sig, slot, blockTime });
    if (r) receipts.push(r);
  };

  for (const ix of message?.instructions ?? []) inspect(ix);
  for (const group of (tx.meta?.innerInstructions ?? [])) {
    for (const ix of group.instructions ?? []) inspect(ix);
  }

  return receipts;
}
