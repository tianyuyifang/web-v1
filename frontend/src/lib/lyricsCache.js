"use client";

import { clipsAPI } from "@/lib/api";

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
    .getLyrics(clipId)
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

/**
 * Synchronously get lyrics from cache if available, otherwise null.
 * Used for first-render without triggering a state update.
 */
export function getCachedLyrics(clipId, version) {
  const key = getLyricsCacheKey(clipId, version);
  const entry = cache.get(key);
  return entry?.lyrics ?? null;
}
