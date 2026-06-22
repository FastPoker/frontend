import { useCallback, useRef, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import { buildWalletApiAuth } from '@/lib/wallet-api-auth';

export type NoteColor = 'none' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

export interface PlayerNoteEntry {
  note: string;
  color: NoteColor;
  updatedAt?: string;
}

interface UsePlayerNotes {
  /** target wallet (base58) -> note. Only populated after ensureLoaded(). */
  notes: Record<string, PlayerNoteEntry>;
  loaded: boolean;
  loading: boolean;
  /** Fetch the author's notes once (lazy — triggers a one-time signMessage). */
  ensureLoaded: () => Promise<void>;
  /** Upsert/clear a note for `target`. Empty text + 'none' color clears it. */
  saveNote: (target: string, note: string, color: NoteColor) => Promise<boolean>;
  get: (target: string | undefined | null) => PlayerNoteEntry | undefined;
}

// Private notes: the author signs ONCE (cached 4min by buildWalletApiAuth) and
// that signature gates both the read and every write. Lazy by design — nothing
// fetches until the player actually opens a note, so page load never pops a
// signing prompt.
export function usePlayerNotes(
  publicKey: PublicKey | null | undefined,
  signMessage: ((m: Uint8Array) => Promise<Uint8Array>) | undefined,
): UsePlayerNotes {
  const [notes, setNotes] = useState<Record<string, PlayerNoteEntry>>({});
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  const ensureLoaded = useCallback(async () => {
    if (loaded || loadingRef.current) return;
    if (!publicKey || !signMessage) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const auth = await buildWalletApiAuth(publicKey, signMessage, 'player-notes');
      const res = await fetch('/api/player-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'list', ...auth }),
      });
      if (res.ok) {
        const data = await res.json();
        const map: Record<string, PlayerNoteEntry> = {};
        for (const n of (data.notes || [])) {
          map[n.target] = { note: n.note || '', color: (n.color || 'none') as NoteColor, updatedAt: n.updatedAt };
        }
        setNotes(map);
        setLoaded(true);
      }
    } catch (e) {
      console.warn('[player-notes] load failed', e);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [loaded, publicKey, signMessage]);

  const saveNote = useCallback(async (target: string, note: string, color: NoteColor): Promise<boolean> => {
    if (!publicKey || !signMessage) return false;
    try {
      const auth = await buildWalletApiAuth(publicKey, signMessage, 'player-notes');
      const res = await fetch('/api/player-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'set', target, note, color, ...auth }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      setNotes(prev => {
        const next = { ...prev };
        if (data.note) {
          next[target] = { note: data.note.note || '', color: (data.note.color || 'none') as NoteColor, updatedAt: data.note.updatedAt };
        } else {
          delete next[target];
        }
        return next;
      });
      setLoaded(true);
      return true;
    } catch (e) {
      console.warn('[player-notes] save failed', e);
      return false;
    }
  }, [publicKey, signMessage]);

  const get = useCallback((target: string | undefined | null) => (target ? notes[target] : undefined), [notes]);

  return { notes, loaded, loading, ensureLoaded, saveNote, get };
}
