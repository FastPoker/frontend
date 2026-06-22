// Canonical signed message for the voluntary off-chain card "show". Shared by
// the client (which signs it with the seat's session key) and the API route
// (which verifies it). NO server imports here so the client can use it too.

export interface ShowCardsPayload {
  table: string;
  hand: number;
  seat: number;
  cards: [number, number];
  signer: string;
  issued: string; // ISO timestamp
}

export const SHOW_CARDS_MAX_AGE_MS = 5 * 60 * 1000;
export const SHOW_CARDS_FUTURE_SKEW_MS = 60 * 1000;

export function isValidCard(c: unknown): c is number {
  return typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 51;
}

export function buildShowCardsMessage(p: ShowCardsPayload): string {
  return [
    'FastPoker Show Cards',
    `Table: ${p.table}`,
    `Hand: ${p.hand}`,
    `Seat: ${p.seat}`,
    `Cards: ${p.cards[0]},${p.cards[1]}`,
    `Signer: ${p.signer}`,
    `Issued: ${p.issued}`,
  ].join('\n');
}
