/**
 * 唱卡歌词匹配算法 —— 前端渲染与后端审核页共用同一份, 杜绝两份漂移。
 *
 * 从 LiveLyrics.js 原样抽出(2026-09-05)。算法改动只改这里。
 * 前端 import { markPassage }; 后端 require 读同一文件。
 */
/* eslint-disable */
const MATCH_RATIO = 0.66;

/** Shortest game line worth matching: below this, everything matches. */
const MIN_LINE_CHARS = 4;

function normalise(s) {
  return String(s || "")
    .replace(/[\s,.!?;:，。！？；：、"'"'()（）\[\]]/g, "")
    .toLowerCase();
}

/**
 * How far a masked line's length may differ from the real line's.
 *
 * Zero would do: measured against reference lines identified independently, a
 * mask block predicted the length exactly in 15 of 20 cases, and the other
 * five were the platform writing two sung lines as one. The slack is only for
 * punctuation the two sides render differently, and widening it to 3 or
 * narrowing it to 0 changed nothing across the whole ground-truth set.
 */
const LENGTH_SLACK = 2;

/**
 * Split a game line into character slots, one per character of the real line.
 *
 * The game writes a hidden character as a run of underscores, so a run counts
 * as one character rather than as its own length. That is what lets a line
 * showing a single character still say how long it is — and length is most of
 * what such a line has to offer.
 */
function slotsOf(gameLine) {
  const s = String(gameLine == null ? "" : gameLine).trim();
  const slots = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " ") { i += 1; continue; }
    if (c === "_") {
      while (i < s.length && s[i] === "_") i += 1;
      slots.push(null);
      continue;
    }
    slots.push(c);
    i += 1;
  }
  return slots;
}

/** Every visible character present, in order. */
function visibleInOrder(chars, real) {
  let hits = 0;
  let at = 0;
  for (const ch of chars) {
    const found = real.indexOf(ch, at);
    if (found >= 0) { hits += 1; at = found + 1; }
  }
  return hits;
}

/**
 * Does a game line correspond to this real line?
 *
 * Two cases, because a masked line and an unmasked one carry different
 * evidence.
 *
 * Unmasked: unchanged — the visible characters must appear in order, two
 * thirds of them at least, which tolerates the game's own misspellings.
 *
 * Masked: the line used to be thrown away. Deleting the underscores left "春"
 * from "春 __ __ __ __", one character, below the minimum, so the heaviest
 * masking — 85% of masked lines show a single character — matched nothing at
 * all. Counting the runs instead recovers the line's length, which is enough
 * to place it: "春" plus "five characters long" finds 春去春又回. Every visible
 * character must then be present, since the mask hides characters rather than
 * altering them.
 *
 * Characters are compared as code points throughout. Rare Han characters live
 * outside the BMP, where `.length` counts them twice and halved the ratio —
 * failing the threshold on exactly the characters that identify a line best.
 */
function linesMatch(gameLine, realLine) {
  const real = [...normalise(realLine)];
  if (!real.length) return false;

  const slots = slotsOf(gameLine);
  const masked = slots.filter((c) => c === null).length;
  const shown = [...normalise(slots.filter((c) => c !== null).join(""))];

  if (!masked) {
    if (shown.length < MIN_LINE_CHARS) return false;
    return visibleInOrder(shown, real) / shown.length >= MATCH_RATIO;
  }

  if (!shown.length) return false;
  if (Math.abs(real.length - slots.length) > LENGTH_SLACK) return false;
  return visibleInOrder(shown, real) === shown.length;
}

/**
 * How much wider than the passage a window may be.
 *
 * Slack for the platform splitting a sung line in two. Sweeping this between 2
 * and 6 changed no result in the ground-truth set, so it is loose on purpose.
 */
const WINDOW_SLACK = 4;

/** How many characters a line holds, a mask run counting as the one it hides. */
function lengthOf(text) {
  return slotsOf(text).length;
}

/**
 * Give each game line a real line within the window, without overfilling one.
 *
 * Each line used to pick the first candidate inside the window on its own,
 * knowing nothing of what the others had taken. Where a song repeats itself —
 * and songs repeat themselves constantly — that put several game lines on the
 * same real line and left the rest of the run unmarked: 「大海」 placed six
 * lines onto three, both 「所有受过的伤」 and 「所有流过的泪」 landing on 「所有
 * 受过的伤」 while 「所有流过的泪」 sat unclaimed on the next line.
 *
 * Sharing a line cannot simply be forbidden: it is often right, because the
 * platform writes as one line what the game shows as two — the same 「大海」 has
 * 「如果大海能够」 and 「带走我的哀愁」 correctly sharing one twelve-character
 * line. What separates the two cases is length. A real line holds about as many
 * characters as it has; a second game line fits only if room is left.
 *
 * So each line takes the first candidate that still has room, and the room it
 * uses is its own length. Measured over 7,085 passages: 493 improved, 211 more
 * lines placed, none lost, and the twenty-six the metric flagged as worse were
 * read by hand and were improvements too — the flag was counting backward steps,
 * which are normal in a passage the game shuffled.
 */
function assignWithinWindow(candidates, start, width, gameLines, parsed) {
  const room = new Map();
  return candidates.map((hits, gi) => {
    const inside = hits.filter((i) => i >= start && i < start + width);
    const want = lengthOf(gameLines[gi]);
    let pick = -1;
    for (const i of inside) {
      if (!room.has(i)) room.set(i, [...normalise(parsed[i].text)].length + LENGTH_SLACK);
      if (room.get(i) >= want) { pick = i; break; }
    }
    // Nothing has room: take the first candidate anyway. A line marked twice is
    // the old behaviour, and better than a line the singer cannot see at all.
    if (pick < 0 && inside.length) pick = inside[0];
    if (pick >= 0) room.set(pick, room.get(pick) - want);
    return pick;
  });
}

/**
 * Where the game's passage sits in the real lyrics.
 *
 * Returns every distinct place it occurs, earliest first, each an array of
 * line indexes parallel to the game's own lines (-1 where a line found
 * nothing).
 *
 * What changed and why. Each game line used to search the whole song alone and
 * take the first line it matched. That threw away the strongest thing known
 * about a passage: it is sung as a run, so the lines it covers are adjacent.
 * Measured on 117 real passages, 99% are contiguous — and the exceptions were
 * the matcher's own errors, not passages that genuinely scatter. Judged
 * per-line, a repeated chorus made the choice a coin flip, and a line matching
 * the "title - artist" header at the top of the file beat the real one 14
 * times.
 *
 * So contiguity is a gate rather than a preference: a placement whose lines
 * have a gap is not a worse answer, it is not an answer. Among those that
 * pass, the one accounting for the most game lines wins, and the earliest wins
 * a tie. The header needs no special case — it sits alone at the top, so no
 * contiguous window reaches both it and the passage.
 *
 * Order inside a window is not assumed. The game shuffles what it shows; one
 * real passage arrived as lines 14, 16, 17, 15, 13.
 */
export function markPassage(gameLyric, parsed) {
  if (!gameLyric || !parsed.length) return [];
  const gameLines = gameLyric
    .split(/[\n\/]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!gameLines.length) return [];

  const candidates = gameLines.map((line) => {
    const hits = [];
    parsed.forEach((p, i) => { if (linesMatch(line, p.text)) hits.push(i); });
    return hits;
  });
  if (candidates.every((c) => !c.length)) return [];

  // A window may be narrower than the passage: the platform sometimes writes
  // as one line what the game shows as two.
  const minWidth = Math.max(1, Math.ceil(gameLines.length / 2));
  const maxWidth = gameLines.length + WINDOW_SLACK;

  let best = -1;
  let placements = [];
  for (let width = minWidth; width <= maxWidth; width += 1) {
    for (let start = 0; start + width <= parsed.length; start += 1) {
      const chosen = assignWithinWindow(candidates, start, width, gameLines, parsed);
      const used = [...new Set(chosen.filter((i) => i >= 0))].sort((a, b) => a - b);
      if (!used.length) continue;
      // The gate. A gap means these lines are not one passage.
      if (used[used.length - 1] - used[0] !== used.length - 1) continue;

      const placed = chosen.filter((i) => i >= 0).length;
      if (placed > best) { best = placed; placements = [{ chosen, used, at: used[0] }]; }
      else if (placed === best) placements.push({ chosen, used, at: used[0] });
    }
  }
  if (!placements.length) return [];

  // Earliest first, and each place claims its lines: without that, a window
  // sliding along by one produced a family of near-duplicates that read as
  // nine occurrences of a chorus which occurs twice.
  placements.sort((a, b) => a.at - b.at);
  const claimed = new Set();
  const places = [];
  for (const p of placements) {
    if (p.used.some((i) => claimed.has(i))) continue;
    p.used.forEach((i) => claimed.add(i));
    places.push(p.chosen);
  }
  return places;
}


if (typeof module !== "undefined" && module.exports) {
  module.exports = { markPassage };
}
