import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import { requireRateLimit } from '@/lib/api-rate-limit';
import { requireTrustedOrigin, requireWalletSignature } from '@/lib/api-auth';

const PURPOSE = 'player-notes';
const NOTE_MAX_LEN = 500;
const NOTE_MAX_TARGETS = 200;
const NOTE_COLORS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
type NoteColor = (typeof NOTE_COLORS)[number];
type Note = { target: string; note: string; color: NoteColor; updatedAt: string };

const notesByAuthor = new Map<string, Map<string, Note>>();

function isValidPubkey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function sanitizeColor(value: unknown): NoteColor {
  return (NOTE_COLORS as readonly string[]).includes(value as string) ? (value as NoteColor) : 'none';
}

function sanitizeNote(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trimEnd()
    .slice(0, NOTE_MAX_LEN);
}

export async function POST(request: NextRequest) {
  const originError = requireTrustedOrigin(request);
  if (originError) return originError;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const authError = requireWalletSignature(body, PURPOSE);
  if (authError) return authError;

  const author = String(body.wallet ?? '');
  if (!isValidPubkey(author)) return NextResponse.json({ error: 'Invalid author wallet' }, { status: 400 });

  const ipLimited = requireRateLimit(request, 'player-notes-ip', '', 60, 60_000);
  if (ipLimited) return ipLimited;
  const walletLimited = requireRateLimit(request, 'player-notes-wallet', author, 30, 60_000);
  if (walletLimited) return walletLimited;

  const op = String(body.op || 'list');
  const mine = notesByAuthor.get(author) ?? new Map<string, Note>();
  notesByAuthor.set(author, mine);

  if (op === 'list') {
    return NextResponse.json({ notes: Array.from(mine.values()) });
  }

  if (op !== 'set') {
    return NextResponse.json({ error: 'Unknown op' }, { status: 400 });
  }

  const target = String(body.target ?? '');
  if (!isValidPubkey(target)) return NextResponse.json({ error: 'Invalid target wallet' }, { status: 400 });
  if (target === author) return NextResponse.json({ error: 'Cannot note yourself' }, { status: 400 });

  const noteText = sanitizeNote(body.note);
  const color = sanitizeColor(body.color);
  if (!noteText && color === 'none') {
    mine.delete(target);
    return NextResponse.json({ note: null });
  }
  if (!mine.has(target) && mine.size >= NOTE_MAX_TARGETS) {
    return NextResponse.json({ error: 'Note limit reached', code: 'NOTE_LIMIT_REACHED' }, { status: 429 });
  }

  const note = { target, note: noteText, color, updatedAt: new Date().toISOString() };
  mine.set(target, note);
  return NextResponse.json({ note });
}
