// Stable per-browser device id, used for cash-table anti-collusion (hard-block
// two wallets on the SAME device from sitting at the same table). This is a
// frontend-level deterrent: it's clearable (incognito / clear storage / a
// second device evades it), which is why the server pairs it with a SOFT IP
// flag. It is NOT a security boundary — just friction against the casual case.

const KEY = 'fp_device_id';

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return (crypto as Crypto).randomUUID();
    }
    const a = new Uint8Array(16);
    (crypto as Crypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Last-resort (no crypto): time + index-free pseudo id. Collisions are
    // acceptable here — the server treats device match as a hard block but
    // pairs it with the soft IP flag, and a missing/odd id just won't match.
    return `d${Date.now().toString(36)}${Math.floor(performance.now()).toString(36)}`;
  }
}

/** Get (or lazily create + persist) this browser's device id. */
export function getDeviceId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id) {
      id = randomId();
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // localStorage blocked (private mode / embedded webview): fall back to a
    // per-session id so the request still carries something stable-ish.
    return randomId();
  }
}
