"use client";

/**
 * IndexedDB persistence for raw clip MP3 bytes.
 *
 * We store ArrayBuffers (not decoded AudioBuffers — those can't be serialized).
 * On replay, the bytes are retrieved from IDB and re-decoded by the browser,
 * which is much cheaper than re-fetching from the network.
 *
 * Cache policy:
 *   - Up to MAX_ENTRIES clips (~200 * ~175KB = ~35MB)
 *   - LRU eviction based on `lastAccessedAt`
 *   - Entries keyed by `clipId_v${version}` so force-regenerate invalidates old
 */

const DB_NAME = "musicapp-clips";
const DB_VERSION = 1;
const STORE = "clips";
const MAX_ENTRIES = 200;

let dbPromise = null;

function isSupported() {
  return typeof indexedDB !== "undefined";
}

function openDB() {
  if (!isSupported()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("lastAccessedAt", "lastAccessedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function buildKey(clipId, version) {
  return version ? `${clipId}_v${version}` : clipId;
}

/**
 * Get raw clip bytes from IndexedDB. Returns ArrayBuffer or null on miss/error.
 */
export async function getClipBytes(clipId, version) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve(null);
      return;
    }
    const store = tx.objectStore(STORE);
    const key = buildKey(clipId, version);
    const req = store.get(key);
    req.onsuccess = () => {
      const entry = req.result;
      if (!entry) {
        resolve(null);
        return;
      }
      // Touch lastAccessedAt for LRU
      entry.lastAccessedAt = Date.now();
      store.put(entry);
      resolve(entry.bytes);
    };
    req.onerror = () => resolve(null);
  });
}

/**
 * Store raw clip bytes in IndexedDB. Best-effort; fails silently if IDB quota
 * is exceeded or the store is unavailable.
 */
export async function putClipBytes(clipId, version, bytes) {
  const db = await openDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const key = buildKey(clipId, version);
    store.put({
      key,
      bytes,
      size: bytes.byteLength,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    tx.oncomplete = () => {
      // After a successful write, check if we need to evict old entries
      maybeEvict().catch(() => {});
    };
    tx.onerror = () => {}; // ignore (e.g. QuotaExceededError)
  } catch {
    // ignore
  }
}

/**
 * If the store holds more than MAX_ENTRIES clips, delete the oldest-accessed
 * entries until we're back under the limit.
 */
async function maybeEvict() {
  const db = await openDB();
  if (!db) return;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const overflow = countReq.result - MAX_ENTRIES;
      if (overflow <= 0) {
        resolve();
        return;
      }
      // Delete oldest `overflow` entries by walking the lastAccessedAt index
      const index = store.index("lastAccessedAt");
      const cursorReq = index.openCursor();
      let remaining = overflow;
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || remaining <= 0) {
          resolve();
          return;
        }
        cursor.delete();
        remaining -= 1;
        cursor.continue();
      };
      cursorReq.onerror = () => resolve();
    };
    countReq.onerror = () => resolve();
  });
}
