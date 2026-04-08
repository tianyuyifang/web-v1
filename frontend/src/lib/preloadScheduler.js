"use client";

import { getAudioBuffer, hasCachedBuffer } from "@/lib/audioCache";
import { getClipBytes } from "@/lib/clipDB";

/**
 * Clip preload scheduler.
 *
 * Manages three preload sources with different priorities:
 *   - HOVER (high)        — user is about to click play
 *   - NEIGHBORHOOD (med)  — next N clips after a clip starts playing
 *   - VIEWPORT (low)      — clip card visible for >= dwell time
 *
 * Dedup rules:
 *   - already in memory cache → skip
 *   - already in IDB cache    → skip (but still prime memory via getAudioBuffer)
 *   - already queued at equal-or-higher priority → skip
 *   - already queued at lower priority → upgrade priority
 *
 * Respects navigator.connection.saveData and effectiveType '2g'/'slow-2g'
 * by disabling viewport + neighborhood and keeping hover only.
 */

export const PRIORITY = {
  HOVER: 3,
  NEIGHBORHOOD: 2,
  VIEWPORT: 1,
};

// Max concurrent fetches per priority tier
const CONCURRENCY = {
  [PRIORITY.HOVER]: 3,
  [PRIORITY.NEIGHBORHOOD]: 2,
  [PRIORITY.VIEWPORT]: 1,
};

// Map<cacheKey, { clipId, version, priority }>
const queue = new Map();
// Map<cacheKey, true> — currently being fetched
const inFlight = new Map();
// Per-priority running counts
const running = { [PRIORITY.HOVER]: 0, [PRIORITY.NEIGHBORHOOD]: 0, [PRIORITY.VIEWPORT]: 0 };

function buildKey(clipId, version) {
  return version ? `${clipId}_v${version}` : clipId;
}

function shouldSkipForSaveData(priority) {
  if (typeof navigator === "undefined" || !navigator.connection) return false;
  const saveData = navigator.connection.saveData === true;
  const slow = navigator.connection.effectiveType === "2g" || navigator.connection.effectiveType === "slow-2g";
  if (!saveData && !slow) return false;
  // Under data-saver or slow connection, only allow highest-priority (hover)
  return priority < PRIORITY.HOVER;
}

/**
 * Enqueue a clip at the given priority. No-op if already cached.
 * Upgrades priority if the clip is already queued at a lower level.
 */
function enqueue(clipId, version, priority) {
  if (!clipId) return;
  if (shouldSkipForSaveData(priority)) return;

  const key = buildKey(clipId, version);
  // Already decoded in memory? Nothing to do.
  if (hasCachedBuffer(clipId, version)) return;

  const existing = queue.get(key);
  if (existing) {
    if (existing.priority < priority) {
      existing.priority = priority;
    }
    return;
  }
  if (inFlight.has(key)) return;

  queue.set(key, { clipId, version, priority });
  drain();
}

/**
 * Pop the highest-priority queued clip whose tier has a free slot.
 */
function pickNext() {
  let bestKey = null;
  let bestPriority = -1;
  for (const [key, entry] of queue) {
    if (running[entry.priority] >= CONCURRENCY[entry.priority]) continue;
    if (entry.priority > bestPriority) {
      bestKey = key;
      bestPriority = entry.priority;
    }
  }
  if (!bestKey) return null;
  const entry = queue.get(bestKey);
  queue.delete(bestKey);
  return { key: bestKey, ...entry };
}

async function drain() {
  const next = pickNext();
  if (!next) return;

  const { key, clipId, version, priority } = next;
  inFlight.set(key, true);
  running[priority] += 1;

  try {
    // Check IDB first to avoid network entirely. If in IDB, we still call
    // getAudioBuffer so the bytes get decoded and cached in memory — but
    // that's nearly free (no network).
    const idbHit = await getClipBytes(clipId, version);
    if (idbHit) {
      // Already persisted; don't bother warming memory cache — it would
      // waste RAM on a clip the user may never actually play. The next
      // real play() call will decode from IDB on demand.
    } else {
      // Not in IDB — fetch from network. getAudioBuffer handles the full
      // fetch → persist → decode pipeline and stores everything.
      await getAudioBuffer(clipId, version);
    }
  } catch {
    // Ignore — user will re-fetch on click if needed
  } finally {
    inFlight.delete(key);
    running[priority] -= 1;
    // Drain more if any capacity remains
    drain();
  }
}

/**
 * Viewport preload: called when a clip card has been continuously visible
 * for >= dwell time (handled by the caller via IntersectionObserver).
 */
export function enqueueVisible(clipId, version) {
  enqueue(clipId, version, PRIORITY.VIEWPORT);
}

/**
 * Hover preload: called on mouseenter over a play button.
 * Highest priority, bumps ahead of viewport/neighborhood queue.
 */
export function enqueueHover(clipId, version) {
  enqueue(clipId, version, PRIORITY.HOVER);
}

/**
 * Neighborhood preload: called when a clip starts playing.
 * Preloads the next `count` clips in the playlist.
 *
 * @param {Array} allClips — the playlist's clips array (with .clipId and .clip.version)
 * @param {number} currentIndex — index of the clip that just started playing
 * @param {number} count — how many neighbors to preload (default 8)
 */
export function enqueueNeighborhood(allClips, currentIndex, count = 8) {
  if (!Array.isArray(allClips) || currentIndex < 0) return;
  const end = Math.min(allClips.length, currentIndex + 1 + count);
  for (let i = currentIndex + 1; i < end; i++) {
    const pc = allClips[i];
    if (!pc) continue;
    enqueue(pc.clipId, pc.clip?.version, PRIORITY.NEIGHBORHOOD);
  }
}
