"use client";

import { getClipStreamUrl } from "@/lib/api";
import { getClipBytes, putClipBytes, deleteClipBytes } from "@/lib/clipDB";

/**
 * Shared audio buffer cache.
 * Keyed by clipId → { buffer: AudioBuffer, normGain: number, promise: Promise }
 * Prevents duplicate fetches across multiple useAudioPlayer instances.
 */
const MAX_CACHE_SIZE = 80;
const cache = new Map();

/**
 * Move a key to the end of the Map (most recently used).
 * If cache exceeds MAX_CACHE_SIZE, evict the oldest entry.
 */
function touchCache(key) {
  if (cache.has(key)) {
    const val = cache.get(key);
    cache.delete(key);
    cache.set(key, val);
  }
  // Evict oldest entries (first in Map iteration order)
  while (cache.size > MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// Target RMS level for normalization (empirically chosen — typical pop music RMS)
const TARGET_RMS = 0.1;

/**
 * Calculate RMS loudness of an AudioBuffer and return a gain multiplier
 * that would bring it to the target level. Clamped to avoid extreme boosts.
 */
function calcNormGain(audioBuffer) {
  let sumSq = 0;
  let totalSamples = 0;

  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      sumSq += data[i] * data[i];
    }
    totalSamples += data.length;
  }

  const rms = Math.sqrt(sumSq / totalSamples);
  if (rms === 0) return 1;

  // Clamp between 0.3x and 3x to avoid extreme adjustments
  return Math.min(3, Math.max(0.3, TARGET_RMS / rms));
}

let sharedCtx = null;

export function getSharedContext() {
  if (!sharedCtx) {
    sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return sharedCtx;
}

// Per-session retry counter: prevents retrying a persistently broken clip on every click.
// Max 3 attempts per cache key per session; after that, the clip is considered broken.
const retryCounts = new Map();
const MAX_RETRIES = 3;

/**
 * Get a cached AudioBuffer for a clip, or start fetching it.
 *
 * Lookup order:
 *   1. In-memory decoded AudioBuffer (fastest — ready to play)
 *   2. IndexedDB raw bytes (no network — re-decode locally)
 *   3. Network fetch (slowest — then persist to IDB for next session)
 *
 * Error recovery:
 *   - Failed entries are removed from the in-memory cache so the next call retries.
 *   - Corrupted IDB entries are detected by a failed decodeAudioData and deleted.
 *   - Network responses are validated via response.ok before persisting.
 *   - Bytes are persisted to IDB only after a successful decode.
 *   - A per-session retry cap (3 attempts) prevents hammering the server for
 *     persistently broken clips.
 *
 * Returns the AudioBuffer once ready.
 */
export async function getAudioBuffer(clipId, version) {
  const cacheKey = version ? `${clipId}_v${version}` : clipId;
  const entry = cache.get(cacheKey);
  if (entry?.buffer) {
    touchCache(cacheKey);
    return entry.buffer;
  }
  if (entry?.promise) return entry.promise;

  // Check retry cap before starting a new fetch
  const retries = retryCounts.get(cacheKey) || 0;
  if (retries >= MAX_RETRIES) {
    throw new Error(`Clip ${clipId} failed ${MAX_RETRIES} times this session, giving up`);
  }

  const promise = (async () => {
    const ctx = getSharedContext();
    let fromIDB = false;

    // Try IndexedDB first — avoids the network entirely for previously played clips
    let arrayBuffer = await getClipBytes(clipId, version);

    if (arrayBuffer) {
      fromIDB = true;
      // Validate IDB bytes by attempting to decode. If corrupted, delete and fall through to network.
      try {
        // decodeAudioData detaches the ArrayBuffer, so clone before attempting
        const copy = arrayBuffer.slice(0);
        const audioBuffer = await ctx.decodeAudioData(copy);
        const normGain = calcNormGain(audioBuffer);
        cache.set(cacheKey, { buffer: audioBuffer, normGain, promise: null });
        touchCache(cacheKey);
        return audioBuffer;
      } catch {
        // IDB bytes are corrupted — delete and refetch from network
        deleteClipBytes(clipId, version).catch(() => {});
        arrayBuffer = null;
        fromIDB = false;
      }
    }

    // Network fetch
    const url = getClipStreamUrl(clipId, version);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching clip ${clipId}`);
    }
    arrayBuffer = await response.arrayBuffer();

    // Clone before decode (decodeAudioData detaches the buffer)
    const bytesToPersist = arrayBuffer.slice(0);

    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    // Only persist to IDB AFTER successful decode — prevents storing corrupted bytes
    putClipBytes(clipId, version, bytesToPersist).catch(() => {});

    const normGain = calcNormGain(audioBuffer);
    cache.set(cacheKey, { buffer: audioBuffer, normGain, promise: null });
    touchCache(cacheKey);
    return audioBuffer;
  })();

  cache.set(cacheKey, { buffer: null, normGain: 1, promise });

  // If the promise fails, clean up so the next call can retry (up to MAX_RETRIES)
  promise.catch(() => {
    cache.delete(cacheKey);
    retryCounts.set(cacheKey, (retryCounts.get(cacheKey) || 0) + 1);
  });

  return promise;
}

/**
 * Check if a clip's audio buffer is already cached (synchronous).
 */
export function hasCachedBuffer(clipId, version) {
  const cacheKey = version ? `${clipId}_v${version}` : clipId;
  return cache.get(cacheKey)?.buffer != null;
}

/**
 * Get the normalization gain for a clip (1.0 if not yet computed).
 */
export function getNormGain(clipId, version) {
  const cacheKey = version ? `${clipId}_v${version}` : clipId;
  return cache.get(cacheKey)?.normGain ?? 1;
}

/**
 * Preload audio buffers for a list of clips.
 * Only preloads the first `limit` clips (default 8) to save bandwidth.
 * Remaining clips load on-demand when played via getAudioBuffer.
 *
 * @param {Array<{clipId: string, version?: number}>} clips - Clips to preload
 * @param {number} limit - Max clips to preload (0 = all)
 * @param {number} concurrency - Max concurrent fetches
 */
export async function preloadClips(clips, limit = 8, concurrency = 3) {
  const candidates = limit > 0 ? clips.slice(0, limit) : clips;
  const queue = candidates.filter(({ clipId, version }) => {
    const cacheKey = version ? `${clipId}_v${version}` : clipId;
    return !cache.has(cacheKey);
  });
  let i = 0;

  async function next() {
    while (i < queue.length) {
      const { clipId, version } = queue[i++];
      try {
        await getAudioBuffer(clipId, version);
      } catch {
        // skip failed loads silently
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, queue.length); w++) {
    workers.push(next());
  }
  await Promise.all(workers);
}
