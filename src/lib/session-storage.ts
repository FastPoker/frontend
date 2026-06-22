/**
 * Session-key storage with LAYERED persistence:
 *   in-memory (per page session)  →  IndexedDB (primary)  →  localStorage (fallback).
 *
 * Why the layers: IndexedDB is the preferred persistent store, but in WALLET
 * IN-APP BROWSERS and some mobile webviews IndexedDB is unavailable or silently
 * cleared. When that happens a fresh session key is generated on every load /
 * hook remount, so the seat's on-chain `approved_signer` never matches the local
 * key — which forces a wallet-signed takeover (update_approved_signer) on EVERY
 * action (a wallet popup every turn, mobile-only). The in-memory cache keeps the
 * key stable across remounts within a page session; the localStorage mirror lets
 * it survive a reload where IndexedDB didn't persist.
 *
 * Trade-off: a gasless session key is a LOW-privilege signer (per-table, rotatable,
 * only signs game actions — never moves funds), so mirroring it to localStorage so
 * webviews work is an acceptable trade vs the original IndexedDB-only design.
 */

const DB_NAME = 'fastpoker_sessions';
const STORE_NAME = 'session_keys';
const DB_VERSION = 1;
const LS_PREFIX = 'fp.sessionkey.v1'; // localStorage fallback (distinct from the legacy prefix migrateFromLocalStorage handles)
const lsKey = (w: string) => `${LS_PREFIX}.${w}`;

// Module-level cache: stable across hook remounts within a page session, even
// when neither IndexedDB nor localStorage persist (locked-down webviews).
const memCache = new Map<string, Uint8Array>();

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function lsGet(walletPubkey: string): Uint8Array | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(lsKey(walletPubkey));
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? Uint8Array.from(arr) : null;
  } catch {
    return null;
  }
}

function lsSet(walletPubkey: string, secretKey: Uint8Array): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(lsKey(walletPubkey), JSON.stringify(Array.from(secretKey)));
  } catch {
    /* quota / private mode — in-memory + IndexedDB still cover it */
  }
}

function lsRemove(walletPubkey: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(lsKey(walletPubkey)); } catch { /* ignore */ }
}

export async function getSessionKey(walletPubkey: string): Promise<Uint8Array | null> {
  // 1. In-memory — survives hook remounts within the page session.
  const mem = memCache.get(walletPubkey);
  if (mem) return mem;

  // 2. IndexedDB — the primary persistent store (desktop, normal mobile browsers).
  try {
    const db = await openDB();
    const fromIdb = await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(walletPubkey);
      req.onsuccess = () => {
        const data = req.result;
        if (data instanceof Uint8Array) resolve(data);
        else if (Array.isArray(data)) resolve(Uint8Array.from(data));
        else resolve(null);
      };
      req.onerror = () => reject(req.error);
    });
    if (fromIdb) {
      memCache.set(walletPubkey, fromIdb);
      lsSet(walletPubkey, fromIdb); // mirror so a later IndexedDB-clear (webview) still recovers it
      return fromIdb;
    }
  } catch (e) {
    console.warn('IndexedDB getSessionKey unavailable; falling back to localStorage:', e);
  }

  // 3. localStorage fallback — in-app/webview where IndexedDB is blocked or cleared.
  const fromLs = lsGet(walletPubkey);
  if (fromLs) {
    memCache.set(walletPubkey, fromLs);
    return fromLs;
  }
  return null;
}

export async function setSessionKey(walletPubkey: string, secretKey: Uint8Array): Promise<void> {
  // Write to all layers so the key persists regardless of which store works.
  memCache.set(walletPubkey, secretKey);
  lsSet(walletPubkey, secretKey);
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(secretKey, walletPubkey);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('IndexedDB setSessionKey failed; in-memory + localStorage hold the key:', e);
  }
}

export async function removeSessionKey(walletPubkey: string): Promise<void> {
  memCache.delete(walletPubkey);
  lsRemove(walletPubkey);
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(walletPubkey);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('IndexedDB removeSessionKey error:', e);
  }
}

/**
 * One-time migration: move any existing localStorage session keys to IndexedDB.
 * Called on first load. After migration, localStorage entries are removed.
 */
export async function migrateFromLocalStorage(prefix: string): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(prefix));
    for (const key of keys) {
      const walletPubkey = key.replace(`${prefix}_`, '');
      const raw = localStorage.getItem(key);
      if (raw) {
        try {
          const secretKey = Uint8Array.from(JSON.parse(raw));
          await setSessionKey(walletPubkey, secretKey);
          localStorage.removeItem(key);
          console.log(`Migrated session key for ${walletPubkey.slice(0, 8)}... from localStorage to IndexedDB`);
        } catch {}
      }
    }
  } catch (e) {
    console.error('Migration from localStorage failed:', e);
  }
}
