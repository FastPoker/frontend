import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { requireRateLimit } from '@/lib/api-rate-limit';
import { requireTrustedOrigin } from '@/lib/api-auth';
import {
  buildShowCardsMessage,
  isValidCard,
  SHOW_CARDS_FUTURE_SKEW_MS,
  SHOW_CARDS_MAX_AGE_MS,
  type ShowCardsPayload,
} from '@/lib/show-cards-msg';

type ShownCard = {
  seat: number;
  cards: [number, number];
  signer: string;
  createdAt: number;
};

const TTL_MS = 30 * 60 * 1000;
const store = new Map<string, Map<number, ShownCard>>();

function isValidPubkey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function cleanup(now = Date.now()): void {
  for (const [key, handShows] of store) {
    for (const [seat, show] of handShows) {
      if (now - show.createdAt > TTL_MS) handShows.delete(seat);
    }
    if (handShows.size === 0) store.delete(key);
  }
}

function keyFor(table: string, hand: number): string {
  return `${table}:${hand}`;
}

function verifyPayload(payload: ShowCardsPayload, signature: string): string | null {
  const { table, hand, seat, cards, signer, issued } = payload;
  if (!isValidPubkey(table)) return 'BAD_TABLE';
  if (!isValidPubkey(signer)) return 'BAD_SIGNER';
  if (!Number.isInteger(hand) || hand < 0) return 'BAD_HAND';
  if (!Number.isInteger(seat) || seat < 0 || seat > 8) return 'BAD_SEAT';
  if (!Array.isArray(cards) || cards.length !== 2 || !isValidCard(cards[0]) || !isValidCard(cards[1]) || cards[0] === cards[1]) {
    return 'BAD_CARDS';
  }

  const issuedMs = new Date(issued).getTime();
  const nowMs = Date.now();
  if (!Number.isFinite(issuedMs) || issuedMs < nowMs - SHOW_CARDS_MAX_AGE_MS || issuedMs > nowMs + SHOW_CARDS_FUTURE_SKEW_MS) {
    return 'STALE';
  }

  try {
    const message = buildShowCardsMessage(payload);
    const sigBytes = Uint8Array.from(Buffer.from(signature, 'base64'));
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      sigBytes,
      new PublicKey(signer).toBytes(),
    );
    return ok ? null : 'BAD_SIGNATURE';
  } catch {
    return 'BAD_SIGNATURE';
  }
}

export async function POST(request: NextRequest) {
  const originError = requireTrustedOrigin(request);
  if (originError) return originError;

  const ipLimited = requireRateLimit(request, 'show-cards-ip', '', 30, 60_000);
  if (ipLimited) return ipLimited;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const payload: ShowCardsPayload = {
    table: String(body?.table ?? ''),
    hand: Number(body?.hand),
    seat: Number(body?.seat),
    cards: Array.isArray(body?.cards) ? [Number(body.cards[0]), Number(body.cards[1])] : [-1, -1],
    signer: String(body?.signer ?? ''),
    issued: String(body?.issued ?? ''),
  };
  const signature = typeof body?.signature === 'string' ? body.signature : '';
  if (!signature) return NextResponse.json({ error: 'signature required' }, { status: 400 });

  const signerLimited = requireRateLimit(request, 'show-cards-signer', payload.signer, 12, 60_000);
  if (signerLimited) return signerLimited;

  const err = verifyPayload(payload, signature);
  if (err) {
    const status = err === 'BAD_SIGNATURE' || err === 'STALE' ? 401 : 400;
    return NextResponse.json({ error: err }, { status });
  }

  cleanup();
  const key = keyFor(payload.table, payload.hand);
  const handShows = store.get(key) ?? new Map<number, ShownCard>();
  handShows.set(payload.seat, {
    seat: payload.seat,
    cards: payload.cards,
    signer: payload.signer,
    createdAt: Date.now(),
  });
  store.set(key, handShows);

  return NextResponse.json({ ok: true });
}

export async function GET(request: NextRequest) {
  const table = request.nextUrl.searchParams.get('table') ?? '';
  const hand = Number(request.nextUrl.searchParams.get('hand'));
  if (!isValidPubkey(table) || !Number.isInteger(hand) || hand < 0) {
    return NextResponse.json({ shows: [] });
  }

  cleanup();
  const shows = Array.from(store.get(keyFor(table, hand))?.values() ?? [])
    .map(({ seat, cards, signer }) => ({ seat, cards, signer }));
  return NextResponse.json({ shows });
}
