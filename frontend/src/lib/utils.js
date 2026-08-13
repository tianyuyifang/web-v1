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
 * Whether a playlist clip survives the grid's filters. Lives here because both
 * the grid and the section-jump buttons above it must agree on what is visible
 * — a jump button for a section the grid has hidden scrolls to nothing.
 */
export function clipMatchesFilters(pc, searchQuery, colorFilter) {
  // A clip can carry several colours, stored pipe-separated, so match on
  // membership rather than equality.
  if (colorFilter && !(pc.colorTag || "").split("|").includes(colorFilter)) {
    return false;
  }
  if (!searchQuery) return true;
  return matchesSearch(
    searchQuery,
    pc.clip.song.title,
    pc.clip.song.artist,
    pc.comment,
    pc.clip.song.titlePinyin,
    pc.clip.song.titlePinyinInitials,
    pc.clip.song.titlePinyinConcat,
    pc.clip.song.artistPinyinConcat
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
