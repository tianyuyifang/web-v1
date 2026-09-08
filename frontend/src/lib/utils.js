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
 * Format a list of songs as numbered, space-delimited lines and copy to the
 * clipboard. Shared by the 未配置 list and the pending-feedback list so both
 * produce the same shape:
 *
 *   1 歌名1 歌手1
 *   2 歌名2 歌手2
 *
 * The number is this copy's running position, not any id. A row with no artist
 * writes "N 歌名" with nothing trailing; a row with no title is skipped
 * entirely (a general feedback carrying only a message is not a song).
 *
 * Returns the number of rows written, or -1 if the copy itself failed — the
 * caller shows the count, or falls back. clipboard.writeText needs a secure
 * context (https, or localhost); on http it rejects, hence the try/catch and
 * the returned -1 rather than a silent no-op.
 */
export async function copySongLines(items) {
  const lines = [];
  for (const it of items || []) {
    const title = (it && it.title ? String(it.title) : "").trim();
    if (!title) continue; // no song on this row
    const artist = (it && it.artist ? String(it.artist) : "").trim();
    lines.push(artist ? `${lines.length + 1} ${title} ${artist}`
      : `${lines.length + 1} ${title}`);
  }
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    return lines.length;
  } catch {
    return -1;
  }
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
