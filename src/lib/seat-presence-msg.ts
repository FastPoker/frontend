// Canonical signed message for a seat-presence heartbeat. Signed by the seat's
// SESSION key (gasless — no wallet popup for a background ping). Shared by the
// client (signs) and the API route (verifies). No server imports here.

export interface SeatPresencePayload {
  table: string;
  signer: string; // session pubkey (base58)
  issued: string; // ISO timestamp
}

export const PRESENCE_MAX_AGE_MS = 5 * 60 * 1000;
export const PRESENCE_FUTURE_SKEW_MS = 60 * 1000;

export function buildSeatPresenceMessage(p: SeatPresencePayload): string {
  return [
    'FastPoker Seat Presence',
    `Table: ${p.table}`,
    `Signer: ${p.signer}`,
    `Issued: ${p.issued}`,
  ].join('\n');
}
