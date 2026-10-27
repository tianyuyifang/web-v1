/**
 * One time tag at the start of what is left of a line: minutes and seconds
 * with one to three fraction digits, in square brackets. One digit is common
 * in NetEase and older local files ("[01:16.0]"); requiring two dropped those
 * lines without a trace. (Tag shapes are not spelled out in brackets here:
 * Tailwind scans this folder and turns bracketed words into CSS rules.)
 */
const TIME_TAG = /^\[(\d{2}):(\d{2})\.(\d{1,3})\]/;

/**
 * Parse an LRC format string into an array of { time, text } objects.
 * LRC format: "[mm:ss.xx]lyric text" per line.
 *
 * A line sung more than once may be written once with every time it is sung,
 * tags stacked at the start: "[00:41.20][01:52.80]我爱你". That is one entry
 * per time -- reading only the first tag lost every repeat and printed the
 * rest of the tags as lyric text (2026-10-27).
 */
export function parseLRC(lrcString) {
  if (!lrcString) return [];

  const lines = lrcString.split(/\r?\n/);
  const result = [];

  let hasTimestamps = false;
  for (const line of lines) {
    const times = [];
    let rest = line;
    let match;
    while ((match = rest.match(TIME_TAG))) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const ms = parseInt(match[3].padEnd(3, "0"), 10);
      times.push(minutes * 60 + seconds + ms / 1000);
      rest = rest.slice(match[0].length);
    }
    if (!times.length) continue;

    hasTimestamps = true;
    const text = rest.trim();

    if (text) {
      for (const time of times) result.push({ time, text });
    }
  }

  if (hasTimestamps) return result.sort((a, b) => a.time - b.time);

  // Fallback: plain text lyrics without timestamps
  for (const line of lines) {
    const text = line.trim();
    if (text) result.push({ time: -1, text });
  }
  return result;
}

/**
 * Find the index of the active lyric line based on current playback time.
 */
export function getActiveLyricIndex(lyrics, currentTime) {
  if (!lyrics.length) return -1;

  for (let i = lyrics.length - 1; i >= 0; i--) {
    if (currentTime >= lyrics[i].time) {
      return i;
    }
  }
  return -1;
}
