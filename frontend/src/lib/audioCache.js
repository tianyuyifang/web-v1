"use client";

import { getClipStreamUrl } from "@/lib/api";

/**
 * Shared audio buffer cache.
 * Keyed by clipId → { buffer: AudioBuffer, normGain: number, promise: Promise }
 * Prevents duplicate fetches across multiple useAudioPlayer instances.
 */
const MAX_CACHE_SIZE = 30;
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

/**
 * Get a cached AudioBuffer for a clip, or start fetching it.
 * Returns the AudioBuffer if already cached, otherwise fetches and caches it.
 */
export async function getAudioBuffer(clipId, version) {
  const cacheKey = version > 1 ? `${clipId}_v${version}` : clipId;
  const entry = cache.get(cacheKey);
  if (entry?.buffer) {
    touchCache(cacheKey);
    return entry.buffer;
  }
  if (entry?.promise) return entry.promise;

  const promise = (async () => {
    const ctx = getSharedContext();
    const url = getClipStreamUrl(clipId, version);
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const normGain = calcNormGain(audioBuffer);
    cache.set(cacheKey, { buffer: audioBuffer, normGain, promise: null });
    touchCache(cacheKey);
    return audioBuffer;
  })();

  cache.set(cacheKey, { buffer: null, normGain: 1, promise });
  return promise;
}

/**
 * Check if a clip's audio buffer is already cached (synchronous).
 */
export function hasCachedBuffer(clipId, version) {
  const cacheKey = version > 1 ? `${clipId}_v${version}` : clipId;
  return cache.get(cacheKey)?.buffer != null;
}

/**
 * Get the normalization gain for a clip (1.0 if not yet computed).
 */
export function getNormGain(clipId, version) {
  const cacheKey = version > 1 ? `${clipId}_v${version}` : clipId;
  return cache.get(cacheKey)?.normGain ?? 1;
}

/**
 * Preload audio buffers for a list of clip IDs.
 * Fetches concurrently with a concurrency limit to avoid overwhelming the network.
 *
 * @param {string[]} clipIds - Clip IDs to preload
 * @param {number} concurrency - Max concurrent fetches
 */
export async function preloadClips(clips, concurrency = 3) {
  const queue = clips.filter(({ clipId, version }) => {
    const cacheKey = version > 1 ? `${clipId}_v${version}` : clipId;
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
