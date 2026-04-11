/**
 * Format seconds into mm:ss display.
 */
export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Get/set the user's preferred column count from localStorage.
 */
const COLUMNS_KEY = "playerbox-columns";
const DEFAULT_COLUMNS = 3;

export function getColumnCount() {
  if (typeof window === "undefined") return DEFAULT_COLUMNS;
  const stored = localStorage.getItem(COLUMNS_KEY);
  return stored ? parseInt(stored, 10) : DEFAULT_COLUMNS;
}

export function setColumnCount(count) {
  localStorage.setItem(COLUMNS_KEY, String(count));
}

/**
 * Check if a string contains CJK characters.
 */
export function containsCJK(str) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(str);
}

/**
 * Client-side text matching for sidebar/grid search filtering.
 * Matches if the query appears as a substring in any of the target fields.
 * Supports Chinese text, pinyin (with/without spaces), and pinyin initials.
 */
export function matchesSearch(query, ...fields) {
  if (!query) return true;
  const lower = query.toLowerCase();
  return fields.some(
    (field) => field && field.toLowerCase().includes(lower)
  );
}

/**
 * Get/set playlist view preference (grid or list).
 */
const VIEW_KEY = "playlist-view";
export function getPlaylistView() {
  if (typeof window === "undefined") return "list";
  return localStorage.getItem(VIEW_KEY) || "list";
}
export function setPlaylistView(view) {
  localStorage.setItem(VIEW_KEY, view);
}

/**
 * Get the earliest clip start time for a song.
 */
export function getDefaultStart(song) {
  if (!song.clips || song.clips.length === 0) return 0;
  return Math.min(...song.clips.map((c) => c.start));
}
