/**
 * Parse an LRC format string into an array of { time, text } objects.
 * LRC format: "[mm:ss.xx]lyric text" per line
 */
export function parseLRC(lrcString) {
  if (!lrcString) return [];

  const lines = lrcString.split(/\r?\n/);
  const result = [];

  let hasTimestamps = false;
  for (const line of lines) {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/);
    if (!match) continue;

    hasTimestamps = true;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const ms = parseInt(match[3].padEnd(3, "0"), 10);
    const time = minutes * 60 + seconds + ms / 1000;
    const text = match[4].trim();

    if (text) {
      result.push({ time, text });
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
