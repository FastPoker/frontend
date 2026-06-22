import { useEffect, useState } from 'react';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { buildSeatPresenceMessage } from '@/lib/seat-presence-msg';
import { getDeviceId } from '@/lib/device-id';
import { INTEGRITY_API_ENABLED } from '@/lib/feature-flags';

// SNG anti-collusion transparency: while seated, heartbeat a device-presence
// record signed by the seat's SESSION key (gasless, no popup), and poll which
// session keys at the table are device-linked. Returns the set of linked signer
// pubkeys; the table maps signer → seat via each seat's approvedSigner and
// badges those seats. Cash same-device is hard-blocked at seat time, so in
// practice links only ever appear on SNG.
export function useLinkedSeats(
  tablePda: string | null,
  seated: boolean,
  sessionKey: Keypair | null | undefined,
): Set<string> {
  const [linked, setLinked] = useState<Set<string>>(new Set());

  // Heartbeat presence while seated.
  useEffect(() => {
    // Standalone: integrity/linked-seat detection is a backend+DB feature; disabled.
    if (!INTEGRITY_API_ENABLED) return;
    if (!tablePda || !seated || !sessionKey) return;
    let cancelled = false;
    const ping = async () => {
      try {
        const issued = new Date().toISOString();
        const signer = sessionKey.publicKey.toBase58();
        const msg = buildSeatPresenceMessage({ table: tablePda, signer, issued });
        const sig = nacl.sign.detached(new TextEncoder().encode(msg), sessionKey.secretKey);
        let bin = '';
        for (const b of sig) bin += String.fromCharCode(b);
        await fetch('/api/integrity/seat-ping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table: tablePda, signer, issued, signature: btoa(bin), deviceId: getDeviceId() }),
        });
      } catch { /* best-effort */ }
    };
    void ping();
    const id = setInterval(() => { if (!cancelled) void ping(); }, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tablePda, seated, sessionKey]);

  // Poll the linked-signer groups for this table.
  useEffect(() => {
    if (!INTEGRITY_API_ENABLED) return;
    if (!tablePda) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/integrity/linked-seats?table=${encodeURIComponent(tablePda)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const s = new Set<string>();
        for (const group of (data.linkedSigners || [])) {
          for (const signer of group) s.add(signer);
        }
        setLinked(s);
      } catch { /* best-effort */ }
    };
    void poll();
    const id = setInterval(poll, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tablePda]);

  return linked;
}
