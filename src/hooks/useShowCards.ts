import { useCallback, useEffect, useRef, useState } from 'react';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { buildShowCardsMessage } from '@/lib/show-cards-msg';
import { STATIC_EXPORT } from '@/lib/runtime-mode';

export interface ShownCardEntry {
  cards: [number, number];
  signer: string;
}

interface UseShowCards {
  /** seatIndex -> { cards, signer } for the CURRENT hand. The reading client is
   *  responsible for confirming `signer` matches that seat's approved_signer
   *  before trusting the cards. */
  shows: Record<number, ShownCardEntry>;
  /** Sign (session key) + relay the hero's own cards for the current hand. */
  reveal: (cards: [number, number]) => Promise<boolean>;
  /** True once the hero has relayed a show for the current hand. */
  revealedThisHand: boolean;
}

// Voluntary post-hand card show, relayed off-chain. Signing uses the seat's
// session key (gasless, no popup) — entirely separate from the on-chain
// sendAction path. Polled per (table, hand) and reset when the hand advances.
export function useShowCards(
  tablePda: string | null,
  handNumber: number | undefined,
  sessionKey: Keypair | null | undefined,
  mySeatIndex: number | undefined,
): UseShowCards {
  const [shows, setShows] = useState<Record<number, ShownCardEntry>>({});
  const [revealedThisHand, setRevealedThisHand] = useState(false);
  const handRef = useRef<number | undefined>(undefined);

  // Reset on hand change.
  useEffect(() => {
    if (handRef.current !== handNumber) {
      handRef.current = handNumber;
      setShows({});
      setRevealedThisHand(false);
    }
  }, [handNumber]);

  // Poll the relay for shows on the current hand. Only runs once a hand exists;
  // light cadence (3s) since shows are a rare, post-hand event.
  useEffect(() => {
    if (STATIC_EXPORT) return;
    if (!tablePda || handNumber == null || handNumber < 0) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/show-cards?table=${encodeURIComponent(tablePda)}&hand=${handNumber}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const map: Record<number, ShownCardEntry> = {};
        for (const s of (data.shows || [])) {
          if (Array.isArray(s.cards) && s.cards.length === 2) {
            map[s.seat] = { cards: [s.cards[0], s.cards[1]], signer: s.signer };
          }
        }
        setShows(prev => {
          // Preserve an optimistic local show that the server hasn't echoed yet.
          const merged = { ...map };
          for (const k of Object.keys(prev)) {
            const seat = Number(k);
            if (!merged[seat]) merged[seat] = prev[seat];
          }
          return merged;
        });
      } catch {
        /* ignore — relay is best-effort */
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tablePda, handNumber]);

  const reveal = useCallback(async (cards: [number, number]): Promise<boolean> => {
    if (!sessionKey || !tablePda || handNumber == null || mySeatIndex == null || mySeatIndex < 0) return false;
    if (cards[0] === cards[1] || cards.some(c => c < 0 || c > 51)) return false;
    if (STATIC_EXPORT) return false;
    try {
      const issued = new Date().toISOString();
      const signer = sessionKey.publicKey.toBase58();
      const payload = { table: tablePda, hand: handNumber, seat: mySeatIndex, cards, signer, issued };
      const message = buildShowCardsMessage(payload);
      const sigBytes = nacl.sign.detached(new TextEncoder().encode(message), sessionKey.secretKey);
      let binary = '';
      for (const b of sigBytes) binary += String.fromCharCode(b);
      const signature = btoa(binary);
      const res = await fetch('/api/show-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, signature }),
      });
      if (!res.ok) return false;
      // Optimistic local echo so the hero sees their show immediately.
      setShows(prev => ({ ...prev, [mySeatIndex]: { cards, signer } }));
      setRevealedThisHand(true);
      return true;
    } catch {
      return false;
    }
  }, [sessionKey, tablePda, handNumber, mySeatIndex]);

  return { shows, reveal, revealedThisHand };
}
