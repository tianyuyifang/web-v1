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


/**
 * First sung line's time in whole seconds, for a song's initial clip.
 *
 * Timestamps in the wild vary, so this accepts [m:ss], [mm:ss], [mm:ss.s],
 * [mm:ss.xx], [mm:ss.xxx], [mm:ss:xx] and [h:mm:ss(.xx)], and skips metadata
 * tags such as [ti:], [ar:] and [offset:]. Lines may be out of order, so the
 * earliest timestamp wins rather than the first one seen.
 *
 * Returns 0 when nothing is parseable, so an instrumental or a "No Lyrics"
 * placeholder still gets a clip from the top of the song instead of no clip
 * at all — matching the songs already in the library that are cut at 0.
 *
 * Pass the song duration to reject a timestamp past the end of the song:
 * some files carry a broken tag such as [10:00.00] on every line, which would
 * otherwise ask for a clip starting after the audio ends.
 *
 * @param {string|null} lrcString - Full LRC lyrics
 * @param {number|null} [durationSec] - Song length, to reject impossible tags
 * @returns {number} Whole seconds, floored; 0 if nothing parseable
 */
function getFirstLyricStart(lrcString, durationSec) {
  if (typeof lrcString !== 'string' || !lrcString) return 0;

  // Only a positive duration can rule a timestamp out. A 0 or missing duration
  // means the length is unknown (a truncated mp3 reads as 0), and must not
  // reject every tag and silently collapse the start to 0.
  const limit = typeof durationSec === 'number' && durationSec > 0 ? durationSec : null;

  // Two or three colon-separated numbers, with an optional fraction after a
  // '.' or ':'. Captures: 1=first, 2=second, 3=third (absent for mm:ss).
  const TAG = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
  const TAG_HMS = /^\[(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/;

  let best = null;
  for (const rawLine of lrcString.split(/\r?\n/)) {
    // A stray doubled bracket ('[[00:23.25]') appears in real files; drop the
    // extra so the line is still read rather than silently skipped.
    const line = rawLine.trim().replace(/^\[+/, '[');
    if (!line.startsWith('[')) continue;

    let total = null;
    const hms = line.match(TAG_HMS);
    if (hms) {
      // [h:mm:ss] only when the first field is a plausible hour (>0) and the
      // middle field is a valid minute. '[00:18:50]' is mm:ss with a ':'
      // fraction separator, not 0h18m50s, so it falls through to TAG.
      const h = parseInt(hms[1], 10);
      const mi = parseInt(hms[2], 10);
      const se = parseInt(hms[3], 10);
      if (h > 0 && mi <= 59 && se <= 59) total = h * 3600 + mi * 60 + se;
    }
    if (total === null) {
      const m = line.match(TAG);
      if (!m) continue;
      const minutes = parseInt(m[1], 10);
      const seconds = parseInt(m[2], 10);
      if (seconds > 59) continue;
      total = minutes * 60 + seconds;
    }

    // A tag at or past the end of the song cannot start a clip.
    if (limit !== null && total >= limit) continue;

    if (best === null || total < best) best = total;
  }

  return best === null ? 0 : best;
}

module.exports = { sliceLRC, parseLRCLines, STACKED_LINE, getFirstLyricStart };
