/**
 * Per-syllable timings for the karaoke sweep.
 *
 * The backend stores a normalised shape — QQ writes the timing after the text
 * and NetEase before it, and neither is worth putting in front of the player.
 * Each line is `{ start, end, text, syllables: [{ t, e, w }] }`, all in
 * milliseconds from the top of the track.
 *
 * Two things here: matching a stored line to the LRC line on screen, and
 * working out how far through the current line the singing has got.
 */

/** Nothing shorter than this is a line worth sweeping. */
const MIN_SYLLABLES = 1;

/**
 * Parse the stored payload, defensively.
 *
 * It comes from our own database and should always be well-formed, but a
 * malformed row must degrade to "no word timings" rather than break the panel
 * that also shows the words.
 */
export function parseWordLyric(raw) {
  if (!raw) return null;
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!Array.isArray(data) || !data.length) return null;

  const lines = data
    .filter((l) => l && Array.isArray(l.syllables) && l.syllables.length >= MIN_SYLLABLES
      && typeof l.start === "number")
    .map((l) => ({
      start: l.start,
      end: typeof l.end === "number" ? l.end : l.start,
      text: String(l.text || ""),
      syllables: l.syllables
        .filter((s) => s && typeof s.t === "number")
        .map((s) => ({ t: s.t, e: typeof s.e === "number" ? s.e : s.t, w: String(s.w || "") })),
    }))
    .filter((l) => l.syllables.length);

  return lines.length ? lines : null;
}

/** Trimmed and stripped of the punctuation the two sources disagree about. */
function normalise(text) {
  return String(text || "")
    .replace(/[\s　]/g, "")
    .replace(/[，,。.、!！?？~～\-—…"'"'()（）]/g, "")
    .toLowerCase();
}

/**
 * Match each stored line to the LRC line the panel is already rendering.
 *
 * Keyed on the text rather than the index, because the two are not the same
 * list: the LRC carries credit lines and blank spacers that the word payload
 * omits, so line 12 of one is rarely line 12 of the other. Matching on content
 * survives that, and survives one source having a bracketed annotation the
 * other does not.
 *
 * Returns a Map from LRC index to the word-timed line.
 */
export function alignToLrc(lrcLines, wordLines) {
  const out = new Map();
  if (!Array.isArray(lrcLines) || !Array.isArray(wordLines)) return out;

  // Consumed as we go, in order: a repeated chorus line should match the
  // repeat that comes next, not the first occurrence every time.
  let cursor = 0;
  for (let i = 0; i < lrcLines.length; i++) {
    const want = normalise(lrcLines[i].text);
    if (!want) continue;
    for (let j = cursor; j < wordLines.length; j++) {
      if (normalise(wordLines[j].text) === want) {
        out.set(i, wordLines[j]);
        cursor = j + 1;
        break;
      }
    }
  }
  return out;
}

/**
 * How far through a line the singing has reached, 0 to 1.
 *
 * Interpolates within the syllable being sung rather than stepping between
 * them, so the highlight moves continuously — a held note sweeps slowly across
 * its own character instead of sitting still and then jumping.
 *
 * `at` is in seconds, since that is what an audio element reports.
 */
export function sweepProgress(line, at) {
  if (!line || !line.syllables.length) return 0;
  const ms = at * 1000;
  const syls = line.syllables;

  if (ms <= syls[0].t) return 0;
  const last = syls[syls.length - 1];
  if (ms >= last.e) return 1;

  // Progress is measured in characters, not in time: a line whose first word
  // is held for two seconds should have the highlight a quarter of the way
  // across after it, not most of the way.
  let chars = 0;
  const total = syls.reduce((n, s) => n + (s.w.length || 1), 0);
  for (const s of syls) {
    const width = s.w.length || 1;
    if (ms >= s.e) { chars += width; continue; }
    if (ms >= s.t) {
      const span = s.e - s.t;
      chars += width * (span > 0 ? (ms - s.t) / span : 1);
      break;
    }
    // In the gap before this syllable — an instrumental beat mid-line.
    break;
  }
  return Math.max(0, Math.min(1, chars / total));
}

/**
 * The same question for a line with no per-syllable timing.
 *
 * Even pace across the line, which is a guess and admitted as one: it is right
 * when a line is sung evenly and drifts when it is not. Bounded by the line's
 * own duration rather than the gap to the next line, so a line followed by an
 * instrumental break finishes sweeping and then waits, instead of crawling
 * through the silence.
 */
export function evenProgress(line, nextLine, at, charCount) {
  if (!line || line.time < 0) return 0;
  const start = line.time;
  const gap = nextLine && nextLine.time > start ? nextLine.time - start : null;
  // Roughly the pace of sung Chinese: a third of a second a character. Used to
  // cap the sweep so it does not stretch across a long instrumental gap.
  const estimated = Math.max(1, (charCount || 1) * 0.33);
  const span = gap ? Math.min(gap, estimated) : estimated;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (at - start) / span));
}
