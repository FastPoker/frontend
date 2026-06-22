import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, ConfirmedSignatureInfo } from '@solana/web3.js';
import { ANCHOR_PROGRAM_ID } from '@/lib/constants';
import { requireRateLimit } from '@/lib/api-rate-limit';
import { getTeeConnection } from '@/lib/tee-auth-server';
import { getL1Rpc } from '@/lib/rpc-config';
import { findReceiptForHand } from '@/lib/jackpot-scanner';
import type { JackpotReceipt } from '@/lib/jpv1';
import { createHash } from 'crypto';
import { getIndexerBaseUrl } from '@/lib/indexer-env';

const INDEXER_BASE = getIndexerBaseUrl();
const NOOP_PROGRAM_ID = 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV';
const HRV1_MAGIC = 'HRV1';
const HRV1_HEADER_LEN = 81;
const HR_BUFFER_HEADER_LEN = 52;
const HAND_CACHE_VERSION = 1;
const HAND_CACHE_MAX_RECORDS = Number(process.env.HAND_HISTORY_CACHE_MAX || 5000);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];

function cardLabel(card: number): string {
  if (card === 255 || card > 51) return '??';
  return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;
}

function hex(buf: Buffer): string {
  return buf.toString('hex');
}

function getSlimBufferPda(table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('slim_buffer'), table.toBuffer()],
    ANCHOR_PROGRAM_ID,
  )[0];
}

function getHandReportBufferPda(table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('hand_report_buf'), table.toBuffer()],
    ANCHOR_PROGRAM_ID,
  )[0];
}

interface ParsedSeatCards {
  seat: number;
  card1: string;
  card2: string;
}

interface HandReportMeta {
  version: number;
  status: 'l1-committed' | 'tee-finalized-pending-l1' | 'tee-open';
  payloadBytes: number;
  payloadHash: string;
  chunkCount: number;
  chunksPresent: number;
  txs: string[];
}

interface HandActionEvent {
  kind: number;
  street: number;
  actor: number;
  action: number;
  handNumber: number;
  amount: number;
  pot: number;
  wallet: string;
  operator: string;
  aux: number;
}

interface ParsedHandRecord {
  handNumber: number;
  timestamp: number;
  merkleRoot: string;
  handSalt: string;
  communityCards: string[];
  shownCards: ParsedSeatCards[];
  winnersMask: number;
  winners: number[];
  pot: number;
  rake: number;
  sig: string;
  slot: number;
  source: 'hand-report-v1' | 'tee-buffer';
  rollingHash?: string;
  foldWin?: boolean;
  handReport?: HandReportMeta;
  actions?: HandActionEvent[];
}

interface CachedHandRecord {
  table: string;
  handNumber: number;
  record: ParsedHandRecord;
  indexedAt: number;
  lastSeenSlot: number;
}

interface HandHistoryCacheFile {
  version: number;
  records: Record<string, CachedHandRecord>;
}

function emptyHandCache(): HandHistoryCacheFile {
  return { version: HAND_CACHE_VERSION, records: {} };
}

function handCacheKey(table: string, handNumber: number): string {
  return `${table}:${handNumber}`;
}

const handCache = emptyHandCache();

async function loadHandCache(): Promise<HandHistoryCacheFile> {
  return handCache;
}

async function saveHandCache(_cache: HandHistoryCacheFile): Promise<void> {
  // Standalone keeps this cache process-local so a clone does not trace or
  // require writable repo-adjacent cache paths during Next builds/deploys.
}

function pruneHandCache(cache: HandHistoryCacheFile): void {
  const maxRecords = Number.isFinite(HAND_CACHE_MAX_RECORDS) && HAND_CACHE_MAX_RECORDS > 0
    ? HAND_CACHE_MAX_RECORDS
    : 5000;
  const entries = Object.entries(cache.records);
  if (entries.length <= maxRecords) return;
  entries
    .sort((a, b) => (b[1].indexedAt || 0) - (a[1].indexedAt || 0))
    .slice(maxRecords)
    .forEach(([key]) => delete cache.records[key]);
}

function cacheRecord(cache: HandHistoryCacheFile, table: string, record: ParsedHandRecord): boolean {
  if (record.source === 'tee-buffer') return false;
  const key = handCacheKey(table, record.handNumber);
  const existing = cache.records[key];

  const next: CachedHandRecord = {
    table,
    handNumber: record.handNumber,
    record,
    indexedAt: Date.now(),
    lastSeenSlot: record.slot || existing?.lastSeenSlot || 0,
  };

  const changed = !existing
    || existing.record.source !== record.source
    || existing.record.sig !== record.sig
    || existing.record.handReport?.payloadHash !== record.handReport?.payloadHash
    || (existing.record.actions?.length ?? 0) !== (record.actions?.length ?? 0);

  if (!changed) return false;
  cache.records[key] = next;
  pruneHandCache(cache);
  return true;
}

function cachedRecord(cache: HandHistoryCacheFile, table: string, handNumber: number): ParsedHandRecord | null {
  return cache.records[handCacheKey(table, handNumber)]?.record ?? null;
}

function cachedTableRecords(cache: HandHistoryCacheFile, table: string): ParsedHandRecord[] {
  return Object.values(cache.records)
    .filter(entry => entry.table === table)
    .map(entry => entry.record);
}

async function fetchIndexerHandRecord(table: string, handNumber: number, sync: boolean): Promise<ParsedHandRecord | null> {
  if (!INDEXER_BASE) return null;
  try {
    const qs = sync ? '?sync=1' : '';
    const res = await fetch(
      `${INDEXER_BASE}/hand-report/${encodeURIComponent(table)}/${handNumber}${qs}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    const body = await res.json() as { handReport?: { record?: ParsedHandRecord } };
    return body.handReport?.record ?? null;
  } catch {
    return null;
  }
}

async function fetchIndexerTableRecords(table: string, limit: number, sync: boolean): Promise<ParsedHandRecord[]> {
  if (!INDEXER_BASE) return [];
  try {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (sync) qs.set('sync', '1');
    const res = await fetch(
      `${INDEXER_BASE}/hand-reports/table/${encodeURIComponent(table)}?${qs.toString()}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    const body = await res.json() as { handReports?: Array<{ record?: ParsedHandRecord }> };
    return (body.handReports ?? []).map(doc => doc.record).filter((record): record is ParsedHandRecord => Boolean(record));
  } catch {
    return [];
  }
}

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
  return Buffer.alloc(0);
}

function keyToString(value: any): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value?.pubkey === 'string') return value.pubkey;
  if (typeof value?.toBase58 === 'function') return value.toBase58();
  if (typeof value?.toString === 'function') return value.toString();
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

function collectNoopData(txData: any): Buffer[] {
  const out: Buffer[] = [];
  const msg = txData?.transaction?.message ?? {};
  const loadedAddresses = txData?.meta?.loadedAddresses;

  const inspect = (ix: any) => {
    const pidIdx = ix?.programIdIndex ?? ix?.programAddressIndex;
    if (typeof pidIdx !== 'number') return;
    if (keyAt(msg, pidIdx, loadedAddresses) !== NOOP_PROGRAM_ID) return;
    const buf = ixDataToBuffer(ix.data);
    if (buf.length > 0) out.push(buf);
  };

  for (const ix of msg.instructions ?? msg.compiledInstructions ?? []) inspect(ix);
  for (const group of txData?.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) inspect(ix);
  }
  return out;
}

interface Hrv1Chunk {
  handNumber: number;
  chunkIdx: number;
  chunkCount: number;
  payloadHash: Buffer;
  chunkBytes: Buffer;
  sig: string;
  slot: number;
  timestamp: number;
}

function decodeHrv1Chunk(buf: Buffer, table: PublicKey, sig: string, slot: number, timestamp: number): Hrv1Chunk | null {
  if (buf.length < HRV1_HEADER_LEN) return null;
  if (buf.subarray(0, 4).toString('utf8') !== HRV1_MAGIC) return null;
  const version = buf[4];
  if (version !== 1) return null;
  const reportTable = new PublicKey(buf.subarray(5, 37));
  if (!reportTable.equals(table)) return null;
  return {
    handNumber: Number(buf.readBigUInt64LE(37)),
    chunkIdx: buf.readUInt16LE(45),
    chunkCount: buf.readUInt16LE(47),
    payloadHash: buf.subarray(49, 81),
    chunkBytes: buf.subarray(81),
    sig,
    slot,
    timestamp,
  };
}

function parseHandReportPayload(payload: Buffer, meta: HandReportMeta, sig: string, slot: number, timestamp: number): ParsedHandRecord | null {
  const actions: HandActionEvent[] = [];
  let settle: ParsedHandRecord | null = null;
  let offset = 0;

  while (offset < payload.length) {
    const kind = payload[offset];
    if (kind === 6) {
      if (offset + 160 > payload.length) break;
      const e = payload.subarray(offset, offset + 160);
      const handNumber = Number(e.readBigUInt64LE(1));
      const pot = Number(e.readBigUInt64LE(9));
      const rake = Number(e.readBigUInt64LE(17));
      const winnersMask = e.readUInt16LE(25);
      const foldWin = e[27] === 1;
      const communityCards = Array.from(e.subarray(28, 33)).map(cardLabel);
      const shownBytes = e.subarray(33, 51);
      const shownCards: ParsedSeatCards[] = [];
      for (let seat = 0; seat < 9; seat++) {
        const c1 = shownBytes[seat * 2];
        const c2 = shownBytes[seat * 2 + 1];
        if (c1 !== 255 && c1 <= 51 && c2 !== 255 && c2 <= 51) {
          shownCards.push({ seat, card1: cardLabel(c1), card2: cardLabel(c2) });
        }
      }
      const winners: number[] = [];
      for (let i = 0; i < 9; i++) {
        if (winnersMask & (1 << i)) winners.push(i);
      }

      settle = {
        handNumber,
        timestamp,
        merkleRoot: hex(e.subarray(51, 83)),
        handSalt: hex(e.subarray(83, 115)),
        rollingHash: hex(e.subarray(115, 147)),
        communityCards,
        shownCards,
        winnersMask,
        winners,
        pot,
        rake,
        sig,
        slot,
        source: meta.status === 'l1-committed' ? 'hand-report-v1' : 'tee-buffer',
        foldWin,
        handReport: meta,
        actions,
      };
      offset += 160;
      continue;
    }

    if (offset + 96 > payload.length) break;
    const e = payload.subarray(offset, offset + 96);
    actions.push({
      kind: e[0],
      street: e[1],
      actor: e[2],
      action: e[3],
      handNumber: Number(e.readBigUInt64LE(4)),
      amount: Number(e.readBigUInt64LE(12)),
      pot: Number(e.readBigUInt64LE(20)),
      wallet: new PublicKey(e.subarray(28, 60)).toBase58(),
      operator: new PublicKey(e.subarray(60, 92)).toBase58(),
      aux: e.readUInt32LE(92),
    });
    offset += 96;
  }

  return settle;
}

async function readTeeHandReport(table: PublicKey, targetHand: number | null): Promise<ParsedHandRecord | null> {
  try {
    const tee = await getTeeConnection();
    const pda = getHandReportBufferPda(table);
    const info = await tee.getAccountInfo(pda);
    if (!info || info.data.length < HR_BUFFER_HEADER_LEN) return null;
    const data = Buffer.from(info.data);
    const version = data[0];
    const finalized = data[2];
    const capacity = data.readUInt32LE(4);
    const cursor = data.readUInt32LE(8);
    const handNumber = Number(data.readBigUInt64LE(12));
    const storedTable = new PublicKey(data.subarray(20, 52));
    if (version !== 1 || cursor === 0 || !storedTable.equals(table)) return null;
    if (targetHand !== null && handNumber !== targetHand) return null;
    if (cursor > capacity || HR_BUFFER_HEADER_LEN + cursor > data.length) return null;
    const payload = data.subarray(HR_BUFFER_HEADER_LEN, HR_BUFFER_HEADER_LEN + cursor);
    const payloadHash = createHash('sha256').update(payload).digest();
    const meta: HandReportMeta = {
      version,
      status: finalized === 1 ? 'tee-finalized-pending-l1' : 'tee-open',
      payloadBytes: payload.length,
      payloadHash: hex(payloadHash),
      chunkCount: Math.max(1, Math.ceil(payload.length / 800)),
      chunksPresent: 0,
      txs: [],
    };
    return parseHandReportPayload(payload, meta, '', 0, 0);
  } catch {
    return null;
  }
}

async function readCrankTally(tablePda: PublicKey) {
  try {
    const crankTallyPda = PublicKey.findProgramAddressSync(
      [Buffer.from('crank_tally_er'), tablePda.toBuffer()],
      ANCHOR_PROGRAM_ID,
    )[0];
    const teeConn = await getTeeConnection();
    const crankInfo = await teeConn.getAccountInfo(crankTallyPda);
    if (!crankInfo || crankInfo.data.length < 197) return null;

    const d = Buffer.from(crankInfo.data);
    const totalActions = d.readUInt32LE(184);
    const lastHand = Number(d.readBigUInt64LE(188));
    const operators: { pubkey: string; actions: number; share: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const pk = new PublicKey(d.subarray(40 + i * 32, 72 + i * 32));
      if (pk.equals(PublicKey.default)) continue;
      const actions = d.readUInt32LE(168 + i * 4);
      operators.push({
        pubkey: pk.toBase58(),
        actions,
        share: totalActions > 0 ? Math.round((actions / totalActions) * 10000) / 100 : 0,
      });
    }
    return { operators, totalActions, lastHand };
  } catch {
    return null;
  }
}

/**
 * Resolve the JPV1 jackpot receipt (if any) for a given (table, hand).
 * Returns null on miss or scanner failure — callers should not 502 on
 * jackpot-lookup failures since the hand record itself is the primary
 * payload.
 */
async function lookupJackpot(table: string, handNumber: number): Promise<JackpotReceipt | null> {
  try {
    return await findReceiptForHand(table, handNumber);
  } catch {
    return null;
  }
}

/**
 * Bulk attach jackpot receipts to a list of records by reusing the
 * 60s scanner cache (one warm fetch per call). Records without a
 * matching receipt simply get `jackpot: null` left off — undefined.
 */
async function attachJackpotsToRecords(
  table: string,
  records: ParsedHandRecord[],
): Promise<Array<ParsedHandRecord & { jackpot?: JackpotReceipt }>> {
  if (records.length === 0) return records;
  const out = await Promise.all(
    records.map(async (r) => {
      const jackpot = await lookupJackpot(table, r.handNumber);
      return jackpot ? { ...r, jackpot } : r;
    }),
  );
  return out;
}

export async function GET(req: NextRequest) {
  // Per-IP cap: indexer-first + file-cached, but the fallback path does a
  // getSignaturesForAddress sweep (the slow jackpots-class pattern), so cap
  // abuse. Only throttle real external traffic (has a forwarded client IP) —
  // internal same-origin proxy calls (e.g. /api/verify -> here) have no XFF and
  // must not all share one 'unknown' bucket. Generous vs real use.
  if (req.headers.get('x-forwarded-for')) {
    const limited = requireRateLimit(req, 'hand-history', '', 90, 60_000);
    if (limited) return limited;
  }

  const tableParam = req.nextUrl.searchParams.get('table');
  const handParam = req.nextUrl.searchParams.get('hand');
  const limitParam = req.nextUrl.searchParams.get('limit');
  const refresh = req.nextUrl.searchParams.get('refresh') === '1';

  if (!tableParam) {
    return NextResponse.json({ error: 'Missing required query param: table' }, { status: 400 });
  }

  let tablePda: PublicKey;
  try {
    tablePda = new PublicKey(tableParam);
  } catch {
    return NextResponse.json({ error: 'Invalid table pubkey' }, { status: 400 });
  }

  const slimBuffer = getSlimBufferPda(tablePda);
  const limit = Math.min(parseInt(limitParam || '10', 10) || 10, 100);
  const targetHandRaw = handParam ? parseInt(handParam, 10) : null;
  const targetHand = targetHandRaw !== null && !isNaN(targetHandRaw) ? targetHandRaw : null;
  const conn = new Connection(getL1Rpc(), 'confirmed');
  const cache = await loadHandCache();
  let cacheDirty = false;

  let slimInfo = null as Awaited<ReturnType<Connection['getAccountInfo']>>;
  // Retry transient RPC blips before surfacing a 502 — a single getAccountInfo
  // hiccup shouldn't fail a hand-history lookup.
  let slimErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      slimInfo = await conn.getAccountInfo(slimBuffer);
      slimErr = null;
      break;
    } catch (e: any) {
      slimErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  if (slimErr) {
    return NextResponse.json({ error: `Failed to fetch SlimBuffer: ${slimErr?.message?.slice(0, 100)}` }, { status: 502 });
  }

  const crankTally = await readCrankTally(tablePda);
  const totalRecorded = slimInfo && slimInfo.data.length >= 49
    ? Number(Buffer.from(slimInfo.data).readBigUInt64LE(41))
    : 0;

  if (targetHand !== null) {
    const indexed = await fetchIndexerHandRecord(tableParam, targetHand, refresh);
    if (indexed?.source === 'hand-report-v1') {
      const jackpot = await lookupJackpot(tableParam, targetHand);
      return NextResponse.json({
        table: tableParam,
        slimBuffer: slimBuffer.toBase58(),
        handReportBuffer: getHandReportBufferPda(tablePda).toBase58(),
        totalRecorded,
        record: indexed,
        crankTally,
        indexed: true,
        indexSource: 'mongo-indexer',
        ...(jackpot ? { jackpot } : {}),
      });
    }

    if (!refresh) {
      const synced = await fetchIndexerHandRecord(tableParam, targetHand, true);
      if (synced?.source === 'hand-report-v1') {
        const jackpot = await lookupJackpot(tableParam, targetHand);
        return NextResponse.json({
          table: tableParam,
          slimBuffer: slimBuffer.toBase58(),
          handReportBuffer: getHandReportBufferPda(tablePda).toBase58(),
          totalRecorded,
          record: synced,
          crankTally,
          indexed: true,
          indexSource: 'mongo-indexer-sync',
          ...(jackpot ? { jackpot } : {}),
        });
      }
    }
  } else {
    const indexedRecords = await fetchIndexerTableRecords(tableParam, limit, refresh);
    if (indexedRecords.length > 0) {
      const sliced = indexedRecords
        .sort((a, b) => b.handNumber - a.handNumber)
        .slice(0, limit);
      const enriched = await attachJackpotsToRecords(tableParam, sliced);
      return NextResponse.json({
        table: tableParam,
        slimBuffer: slimBuffer.toBase58(),
        handReportBuffer: getHandReportBufferPda(tablePda).toBase58(),
        totalRecorded,
        records: enriched,
        crankTally,
        indexed: true,
        indexSource: refresh ? 'mongo-indexer-sync' : 'mongo-indexer',
      });
    }
  }

  const recordsByHand = new Map<number, ParsedHandRecord>();
  const chunksByReport = new Map<string, Hrv1Chunk[]>();

  if (!refresh) {
    for (const record of cachedTableRecords(cache, tableParam)) {
      recordsByHand.set(record.handNumber, record);
    }

    const found = targetHand !== null ? cachedRecord(cache, tableParam, targetHand) : null;
    if (found?.source === 'hand-report-v1') {
      const jackpot = await lookupJackpot(tableParam, found.handNumber);
      return NextResponse.json({
        table: tableParam,
        slimBuffer: slimBuffer.toBase58(),
        handReportBuffer: getHandReportBufferPda(tablePda).toBase58(),
        totalRecorded,
        record: found,
        crankTally,
        indexed: true,
        indexSource: 'read-through-cache',
        ...(jackpot ? { jackpot } : {}),
      });
    }
  }

  let before: string | undefined = undefined;
  for (let page = 0; page < 20; page++) {
    if (targetHand === null && recordsByHand.size >= limit) break;
    if (targetHand !== null && recordsByHand.get(targetHand)?.source === 'hand-report-v1') break;

    const sigs: ConfirmedSignatureInfo[] = await conn.getSignaturesForAddress(
      tablePda,
      { limit: 100, ...(before ? { before } : {}) },
      'confirmed',
    ).catch(() => []);

    if (!sigs.length) break;
    before = sigs[sigs.length - 1].signature;

    const batchBody = sigs.map((si: ConfirmedSignatureInfo, idx: number) => ({
      jsonrpc: '2.0',
      id: idx,
      method: 'getTransaction',
      params: [si.signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }],
    }));
    const batchRes = await fetch(getL1Rpc(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchBody),
    });
    const batchJson = await batchRes.json() as any[];
    const txById = new Map<number, any>(
      (Array.isArray(batchJson) ? batchJson : [])
        .filter((r: any) => typeof r?.id === 'number')
        .map((r: any) => [r.id, r.result]),
    );

    for (let i = 0; i < sigs.length; i++) {
      const si = sigs[i];
      const txData = txById.get(i) ?? (Array.isArray(batchJson) ? batchJson[i]?.result : null);
      if (!txData || txData.meta?.err) continue;

      for (const data of collectNoopData(txData)) {
        const hrv1 = decodeHrv1Chunk(data, tablePda, si.signature, si.slot ?? 0, txData.blockTime ?? 0);
        if (hrv1) {
          const k = `${hrv1.handNumber}:${hrv1.chunkCount}:${hex(hrv1.payloadHash)}`;
          if (!chunksByReport.has(k)) chunksByReport.set(k, []);
          chunksByReport.get(k)!.push(hrv1);
          continue;
        }

      }
    }

    for (const [_reportId, chunks] of Array.from(chunksByReport.entries())) {
      const byIdx = new Map<number, Hrv1Chunk>();
      for (const c of chunks) if (!byIdx.has(c.chunkIdx)) byIdx.set(c.chunkIdx, c);
      const first = chunks[0];
      if (!first || byIdx.size !== first.chunkCount) continue;

      const ordered: Buffer[] = [];
      for (let idx = 0; idx < first.chunkCount; idx++) {
        const chunk = byIdx.get(idx);
        if (!chunk) break;
        ordered.push(chunk.chunkBytes);
      }
      if (ordered.length !== first.chunkCount) continue;
      const payload = Buffer.concat(ordered);
      const computedHash = createHash('sha256').update(payload).digest();
      if (!computedHash.equals(first.payloadHash)) continue;

      const chunkList = Array.from(byIdx.values()).sort((a, b) => b.slot - a.slot);
      const meta: HandReportMeta = {
        version: 1,
        status: 'l1-committed',
        payloadBytes: payload.length,
        payloadHash: hex(first.payloadHash),
        chunkCount: first.chunkCount,
        chunksPresent: byIdx.size,
        txs: chunkList.map(c => c.sig),
      };
      const latest = chunkList[0];
      const record = parseHandReportPayload(payload, meta, latest.sig, latest.slot, latest.timestamp);
      if (record) {
        cacheDirty = cacheRecord(cache, tableParam, record) || cacheDirty;
        recordsByHand.set(record.handNumber, record);
      }
    }

    if (targetHand !== null && recordsByHand.get(targetHand)?.source === 'hand-report-v1') break;
    if (sigs.length < 100) break;
  }

  if (cacheDirty) await saveHandCache(cache);

  if (targetHand !== null) {
    const found = recordsByHand.get(targetHand);
    if (found) {
      const jackpot = await lookupJackpot(tableParam, targetHand);
      return NextResponse.json({
        table: tableParam,
        slimBuffer: slimBuffer.toBase58(),
        handReportBuffer: getHandReportBufferPda(tablePda).toBase58(),
        totalRecorded,
        record: found,
        crankTally,
        ...(jackpot ? { jackpot } : {}),
      });
    }

    const teePending = await readTeeHandReport(tablePda, targetHand);
    if (teePending) {
      const jackpot = await lookupJackpot(tableParam, targetHand);
      return NextResponse.json({
        table: tableParam,
        slimBuffer: slimBuffer.toBase58(),
        handReportBuffer: getHandReportBufferPda(tablePda).toBase58(),
        totalRecorded,
        record: teePending,
        crankTally,
        ...(jackpot ? { jackpot } : {}),
      });
    }

    return NextResponse.json({
      error: `Hand #${targetHand} not found in L1 TX history or TEE hand-report buffer`
        + ` (table has recorded ${totalRecorded} hand${totalRecorded === 1 ? '' : 's'} so far)`,
      totalRecorded,
    }, { status: 404 });
  }

  const records = Array.from(recordsByHand.values())
    .sort((a, b) => b.handNumber - a.handNumber)
    .slice(0, limit);

  const teePending = await readTeeHandReport(tablePda, null);
  if (teePending && !records.some(r => r.handNumber === teePending.handNumber)) {
    records.unshift(teePending);
  }

  const final = records.slice(0, limit);
  const enriched = await attachJackpotsToRecords(tableParam, final);

  return NextResponse.json({
    table: tableParam,
    slimBuffer: slimBuffer.toBase58(),
    handReportBuffer: getHandReportBufferPda(tablePda).toBase58(),
    totalRecorded,
    records: enriched,
    crankTally,
  });
}
