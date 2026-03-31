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
function sliceLRC(lrcString, startSec, endSec) {
  if (!lrcString) return null;

  const lines = lrcString.split(/\r?\n/);
  const parsed = [];

  for (const line of lines) {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/);
    if (!match) continue;

    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const ms = parseInt(match[3].padEnd(3, '0'), 10);
    const timeSec = minutes * 60 + seconds + ms / 1000;
    const text = match[4];

    parsed.push({ timeSec, text, raw: line });
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

module.exports = { sliceLRC };
