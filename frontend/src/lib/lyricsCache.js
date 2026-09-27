"use client";

import { clipsAPI, playlistsAPI } from "@/lib/api";

/**
 * Shared in-memory cache for clip lyrics.
 * Keyed by `${clipId}_v${version}`. Since lyrics are immutable for a given
 * (clipId, version), we can cache them for the entire session without bounds —
 * at ~5KB per entry, 1000 clips = 5MB.
 *
 * A single in-flight promise per key prevents duplicate concurrent fetches.
 */
const cache = new Map();

export function getLyricsCacheKey(clipId, version) {
  return version ? `${clipId}_v${version}` : clipId;
}

/**
 * Get lyrics for a clip. Returns a Promise that resolves to a string or null.
 * Uses cached value if present; otherwise fetches and caches.
 */
export function fetchLyrics(clipId, version) {
  const key = getLyricsCacheKey(clipId, version);
  const entry = cache.get(key);
  if (entry && entry.lyrics !== undefined) return Promise.resolve(entry.lyrics);
  if (entry?.promise) return entry.promise;

  const promise = clipsAPI
    .getLyrics(clipId, version)
    .then((res) => {
      const lyrics = res.data?.lyrics ?? null;
      cache.set(key, { lyrics, promise: null });
      return lyrics;
    })
    .catch(() => {
      cache.delete(key);
      return null;
    });

  cache.set(key, { lyrics: undefined, promise });
  return promise;
}

// FNV-1a over the playlist's clip ids + versions: a short, stable name for
// one exact set of lyrics, so the batch response can be cached like the
// per-clip ones (whose URLs carry ?v=version).
function clipSetFingerprint(clips) {
  const s = clips.map((pc) => `${pc.clipId}:${pc.clip?.version ?? ""}`).sort().join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${clips.length}-${h.toString(16)}`;
}

/**
 * Fetch every clip's lyrics for a playlist in one request, before its cards
 * mount. Each card used to fetch its own — a request per clip on open. Call it
 * before rendering the cards: each clip gets a pending entry here, so a card's
 * fetchLyrics waits for the batch instead of sending its own request.
 *
 * A clip missing from the batch (its version moved on) or a failed batch
 * falls back to the per-clip fetch, which is what every card did before.
 */
export function prefetchPlaylistLyrics(playlistId, clips) {
  if (!playlistId || !Array.isArray(clips) || clips.length === 0) return;
  const wanted = clips.filter((pc) => !cache.has(getLyricsCacheKey(pc.clipId, pc.clip?.version)));
  if (wanted.length === 0) return;

  const batch = playlistsAPI.getLyrics(playlistId, clipSetFingerprint(clips)).then((res) => {
    const byId = new Map();
    for (const c of res.data?.lyrics || []) byId.set(c.id, c);
    return byId;
  });

  for (const pc of wanted) {
    const version = pc.clip?.version;
    const key = getLyricsCacheKey(pc.clipId, version);
    const fallback = () => {
      cache.delete(key);
      return fetchLyrics(pc.clipId, version);
    };
    const promise = batch.then(
      (byId) => {
        const row = byId.get(pc.clipId);
        // Matched by id; a clip whose version moved on since the page loaded
        // takes the per-clip path. (A clip without a version is taken as is.)
        if (!row || (version != null && row.version !== version)) return fallback();
        const lyrics = row.lyrics ?? null;
        cache.set(key, { lyrics, promise: null });
        return lyrics;
      },
      fallback
    );
    cache.set(key, { lyrics: undefined, promise });
  }
}

/**
 * Synchronously get lyrics from cache if available, otherwise null.
 * Used for first-render without triggering a state update.
 */
export function getCachedLyrics(clipId, version) {
  const key = getLyricsCacheKey(clipId, version);
  const entry = cache.get(key);
  return entry?.lyrics ?? null;
}
