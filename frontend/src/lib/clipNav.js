/**
 * Clip navigation helpers for the playlist player.
 *
 * "Unliked" navigation: find the nearest clip in a given direction whose
 * like-key (`${playlistId}:${clipId}`) is NOT in the user's likedClips set.
 * Used by both the manual prev/next-unliked buttons and the auto-advance.
 */

/**
 * Find the nearest clip in `direction` starting from `fromIndex`, whose
 * like-key is NOT in `likedClips`.
 *
 * @param {Array<{clipId: string}|null>} allClips - ordered clip list (may have holes)
 * @param {number} fromIndex - index of the reference clip (excluded from the search)
 * @param {number} direction - +1 forward, -1 backward
 * @param {Set<string>} likedClips - set of "playlistId:clipId" keys
 * @param {string} playlistId
 * @returns {number} matching index, or -1 if none (no wrap-around)
 */
function findAdjacentUnliked(allClips, fromIndex, direction, likedClips, playlistId) {
  if (!Array.isArray(allClips) || fromIndex == null) return -1;
  for (let i = fromIndex + direction; i >= 0 && i < allClips.length; i += direction) {
    const clip = allClips[i];
    if (!clip) continue;
    const key = `${playlistId}:${clip.clipId}`;
    if (!likedClips.has(key)) return i;
  }
  return -1;
}

export { findAdjacentUnliked };

// Dual export so the plain-Node test (clipNav.test.js) can require() this
// module without a build step. Harmless in the browser/Next bundle.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { findAdjacentUnliked };
}
