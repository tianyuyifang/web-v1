/**
 * Extract LRC lyric lines that fall within a clip's time range.
 * Includes boundary lines (the last line before startSec and the first line after endSec)
 * to ensure no lyrics are lost. Adjusts timestamps so the clip starts at 00:00.00.
 *
 * LRC format: "[mm:ss.xx]lyric text" per line.
 *
 * @param {string|null} lrcString - Full LRC lyrics
 * @param {number} startSec - Clip start time in seconds
 * @param {number} endSec - Clip end time in seconds
 * @returns {string|null} Sliced and time-adjusted LRC lines, or null if none found
 */
const TIME_TAG = /^\[(\d{2}):(\d{2})\.(\d{1,3})\]/;

function sliceLRC(lrcString, startSec, endSec) {
  if (!lrcString) return null;

  const lines = lrcString.split(/\r?\n/);
  const parsed = [];

  for (const line of lines) {
    // Same reading as frontend/src/lib/lrc.js parseLRC: every tag stacked at
    // the start ("[00:41.20][01:52.80]我爱你" = one line sung twice), and one
    // to three fraction digits. Reading only the first tag left a repeat that
    // falls inside the clip out of the clip's lyrics altogether (2026-10-27).
    const times = [];
    let rest = line;
    let match;
    while ((match = rest.match(TIME_TAG))) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const ms = parseInt(match[3].padEnd(3, '0'), 10);
      times.push(minutes * 60 + seconds + ms / 1000);
      rest = rest.slice(match[0].length);
    }
    for (const timeSec of times) parsed.push({ timeSec, text: rest, raw: line });
  }

  if (parsed.length === 0) {
    // Fallback: return raw non-empty lines (no timestamps) so frontend can show static lyrics
    const rawLines = lines.map(l => l.trim()).filter(l => l && !l.startsWith('['));
    return rawLines.length > 0 ? rawLines.join('\n') : null;
  }

  // Sort by time
  parsed.sort((a, b) => a.timeSec - b.timeSec);

  // Find boundary: include the last line before startSec (rather include more)
  let firstIdx = 0;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i].timeSec <= startSec) {
      firstIdx = i;
      break;
    }
  }

  // Find boundary: include the first line after endSec (rather include more)
  let lastIdx = parsed.length - 1;
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].timeSec >= endSec) {
      lastIdx = i;
      break;
    }
  }

  const selected = parsed.slice(firstIdx, lastIdx + 1);
  if (selected.length === 0) return null;

  // Adjust timestamps so clip starts at 0
  const result = selected.map((entry) => {
    const adjusted = Math.max(0, entry.timeSec - startSec);
    const min = Math.floor(adjusted / 60);
    const sec = adjusted % 60;
    const secWhole = Math.floor(sec);
    const msec = Math.round((sec - secWhole) * 100);
    return `[${String(min).padStart(2, '0')}:${String(secWhole).padStart(2, '0')}.${String(msec).padStart(2, '0')}]${entry.text}`;
  });

  return result.join('\n');
}

/** A line that starts with two or more time tags: "[00:41.20][01:52.80]我爱你". */
const STACKED_LINE = /^\[\d{2}:\d{2}\.\d{1,3}\]\[\d{2}:\d{2}\.\d{1,3}\]/m;

/**
 * The lines the 唱卡 page shows, as frontend/src/lib/lrc.js parseLRC reads
 * them: one { time, text } per time tag, empty text dropped, sorted by time.
 * The two must agree line for line -- passage answers are line indexes into
 * this list -- so any change here goes there too.
 */
function parseLRCLines(lrcString) {
  if (!lrcString) return [];
  const result = [];
  let hasTimestamps = false;
  for (const line of String(lrcString).split(/\r?\n/)) {
    const times = [];
    let rest = line;
    let match;
    while ((match = rest.match(TIME_TAG))) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const ms = parseInt(match[3].padEnd(3, '0'), 10);
      times.push(minutes * 60 + seconds + ms / 1000);
      rest = rest.slice(match[0].length);
    }
    if (!times.length) continue;
    hasTimestamps = true;
    const text = rest.trim();
    if (text) for (const time of times) result.push({ time, text });
  }
  if (hasTimestamps) return result.sort((a, b) => a.time - b.time);
  for (const line of String(lrcString).split(/\r?\n/)) {
    const text = line.trim();
    if (text) result.push({ time: -1, text });
  }
  return result;
}

module.exports = { sliceLRC, parseLRCLines, STACKED_LINE };
