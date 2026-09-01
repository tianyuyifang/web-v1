"use client";

/**
 * Lyrics for a 唱卡 card, with the passage the game is showing marked in it.
 *
 * Two sets of words are in play. The real ones come from the platform with
 * timestamps and can be seeked to. The ones on the game screen have no
 * timestamps and are deliberately degraded: lines arrive shuffled, characters
 * are masked with underscores, and the game misspells words on its own. They
 * are what the singer is about to perform, so the useful thing is to find where
 * they sit in the real lyrics and let the singer jump there.
 *
 * Matching is therefore per line and fuzzy. Matching the passage as a block
 * fails on the first shuffled line, and exact comparison fails on the first
 * mask.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { parseLRC, getActiveLyricIndex } from "@/lib/lrc";
import { parseWordLyric, alignToLrc, sweepProgress, evenProgress } from "@/lib/wordLyric";
import { mappingAPI } from "@/lib/api";

/**
 * How much of a line must survive to call it the same line.
 *
 * The game masks characters rather than dropping them, so a match is scored on
 * the characters it did show. Two thirds tolerates heavy masking while still
 * refusing lines that merely share common words.
 */
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
function markPassage(gameLyric, parsed) {
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
      const chosen = candidates.map((hits) => {
        const inside = hits.filter((i) => i >= start && i < start + width);
        return inside.length ? inside[0] : -1;
      });
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

/**
 * One line with the sung part filled in behind it.
 *
 * Two copies of the same text, one clipped to the progress point. That is what
 * keeps the characters from moving: colouring them individually would reflow
 * the line every few hundred milliseconds as weights changed, and a line that
 * shifts under the eye is harder to read than one that does not move at all.
 *
 * The clipped copy sits on top and is revealed left to right, so the glyphs
 * underneath never change position — only what is painted over them.
 */
function SweptLine({ text, progress }) {
  const pct = Math.max(0, Math.min(100, progress * 100));
  return (
    <span className="relative inline-block whitespace-pre-wrap">
      {/* The words not yet sung, in the line's own dimmed colour. */}
      <span aria-hidden="true">{text}</span>
      {/* The same words in the highlight colour, revealed left to right. Laid
          over the first copy rather than replacing it, so the glyphs never
          move: recolouring characters one at a time would reflow the line
          every few hundred milliseconds, and a line that shifts under the eye
          is harder to read than one that does not move at all. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 whitespace-pre-wrap text-accent"
        // Not a transition: the value already updates every animation frame
        // from the audio clock, and easing on top of that fights the music.
        style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
      >
        {text}
      </span>
      {/* The readable copy for anything not looking at pixels. */}
      <span className="sr-only">{text}</span>
    </span>
  );
}

export default function LiveLyrics({
  mappingId, gameLyric, current, onSeek, onTimesChange, onPassageTimes,
  override,
}) {
  const [lrc, setLrc] = useState(null);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef(null);
  const activeRef = useRef(null);
  const [following, setFollowing] = useState(true);

  // Split out so the effect depends on the two strings rather than on an object
  // rebuilt every render, which would refetch the words on every tick.
  const ovSource = override?.source || null;
  const ovId = override?.externalId || null;

  const [words, setWords] = useState(null);

  useEffect(() => {
    if (!mappingId) { setLrc(null); setWords(null); setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    // While an alternative is being auditioned the words must be that
    // recording's: a cover is usually spotted by reading along, and the
    // original's words under someone else's take is exactly the wrong answer.
    mappingAPI
      .lyrics(mappingId, ovSource && ovId ? { source: ovSource, externalId: ovId } : undefined, true)
      .then((res) => {
        if (!alive) return;
        setLrc(res.data.lyric || null);
        // Absent for most NetEase tracks and a handful of QQ ones. The sweep
        // falls back to an even pace rather than disappearing.
        setWords(res.data.wordLyric || null);
      })
      // A song without lyrics is ordinary, not a failure worth shouting about.
      .catch(() => { if (alive) { setLrc(null); setWords(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [mappingId, ovSource, ovId]);

  const parsed = useMemo(() => parseLRC(lrc), [lrc]);

  /**
   * Per-syllable timings, matched to the lines actually on screen.
   *
   * Aligned by text rather than by index: the LRC carries credits and blank
   * spacers the word payload omits, so the two lists do not line up.
   */
  const wordLines = useMemo(() => parseWordLyric(words), [words]);
  const wordByIndex = useMemo(
    () => (wordLines ? alignToLrc(parsed, wordLines) : new Map()),
    [parsed, wordLines]
  );
  const timed = parsed.length > 0 && parsed[0].time !== -1;

  /**
   * Hand the line times up, so the page can jump between lines from the
   * keyboard.
   *
   * Reported rather than re-parsed: these are already in memory, and a second
   * copy of the parse would be a second thing to keep in step with the words on
   * screen. Untimed lyrics report nothing — there is nowhere to jump to.
   */
  useEffect(() => {
    if (!onTimesChange) return;
    onTimesChange(timed ? parsed.map((p) => p.time) : []);
  }, [parsed, timed, onTimesChange]);

  const activeIndex = timed ? getActiveLyricIndex(parsed, current) : -1;

  /**
   * Every place the passage occurs, earliest first.
   *
   * All of them are marked: a chorus sung once appears several times in the
   * words, and the singer is better served seeing each than being shown one
   * chosen by a rule that cannot tell them apart. Measured on the ground-truth
   * set, 96% of ties are between two or three places reading identically.
   */
  const places = useMemo(() => markPassage(gameLyric, parsed), [gameLyric, parsed]);
  const marks = useMemo(() => {
    const s = new Set();
    for (const place of places) for (const i of place) if (i >= 0) s.add(i);
    return s;
  }, [places]);

  // Scroll to the earliest occurrence — that is the whole point of finding it,
  // and the singer has seconds to look.
  const firstMark = useMemo(() => {
    const first = places[0];
    if (!first) return -1;
    const used = first.filter((i) => i >= 0);
    return used.length ? Math.min(...used) : -1;
  }, [places]);

  /**
   * When each occurrence starts, so the transport can show where in the song
   * they fall.
   *
   * Reported rather than derived twice: the passage has already been located
   * here, and asking the page to work it out again would be a second copy of
   * the rule to keep in step. Untimed lyrics report nothing — there is no
   * position to point at.
   */
  const placeTimes = useMemo(() => {
    if (!timed) return [];
    return places
      .map((place) => {
        const used = place.filter((i) => i >= 0);
        if (!used.length) return null;
        const t = parsed[Math.min(...used)]?.time;
        return Number.isFinite(t) && t >= 0 ? t : null;
      })
      .filter((t) => t !== null);
  }, [places, parsed, timed]);

  useEffect(() => {
    if (!onPassageTimes) return;
    onPassageTimes(placeTimes);
  }, [placeTimes, onPassageTimes]);

  /**
   * Put a line in the middle of the lyric box.
   *
   * Not scrollIntoView: that scrolls whichever ancestor can move, and on a
   * page this long the one that moved was the page, which threw the card the
   * singer was reading off the screen.
   */
  const centreLine = (index, smooth) => {
    const box = scrollRef.current;
    if (!box) return;
    const line = box.querySelector(`[data-line="${index}"]`);
    if (!line) return;
    // Measured against the box, not read off offsetTop. offsetTop is relative
    // to the nearest positioned ancestor, and this box is not positioned, so
    // the number came from somewhere further up the page -- far larger than
    // the line's real position inside the box, which scrolled the words clean
    // out of view. Rects are always relative to the viewport, so subtracting
    // one from the other gives the distance actually wanted, whatever the
    // ancestors happen to be.
    const boxTop = box.getBoundingClientRect().top;
    const lineTop = line.getBoundingClientRect().top;
    const offsetInBox = lineTop - boxTop + box.scrollTop;
    box.scrollTo({
      top: Math.max(0, offsetInBox - box.clientHeight / 2 + line.clientHeight / 2),
      behavior: smooth ? "smooth" : "auto",
    });
  };

  // Jump to the passage the moment it is identified — that is the whole point
  // of showing it, and the singer has seconds to look at it.
  useEffect(() => {
    if (firstMark < 0) return;
    centreLine(firstMark, true);
  }, [firstMark]);

  // Keep the playing line centred, unless the singer has scrolled away.
  useEffect(() => {
    if (!following || activeIndex < 0) return;
    centreLine(activeIndex, true);
  }, [activeIndex, following]);

  if (loading) {
    return <div className="py-6 text-center text-xs text-muted">歌词加载中…</div>;
  }

  // No real lyrics, but the game gave us a passage — show that rather than
  // nothing, since it is what the singer is about to perform.
  if (!parsed.length) {
    if (!gameLyric) {
      return <div className="py-6 text-center text-xs text-muted">暂无歌词</div>;
    }
    return (
      <div className="max-h-56 overflow-y-auto px-1 py-2 text-[0.8rem] leading-relaxed text-muted">
        <div className="mb-1 text-[0.65rem] text-muted dark:text-yellow-500/80">游戏给出的片段（无完整歌词）</div>
        {gameLyric.split(/[\n\/]+/).map((l, i) => (
          <div key={i} className="py-0.5">{l.trim()}</div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onWheel={() => setFollowing(false)}
      onTouchMove={() => setFollowing(false)}
      onMouseLeave={() => setFollowing(true)}
      // Height fixed rather than max-, because centring is arithmetic on
      // clientHeight and a box that shrinks to its content computes an offset
      // too small to move: the "centred" line ends up at the top.
      //
      // The blank half-screens above and below are spacer divs, not padding on
      // this element. Tailwind sets border-box, so padding here comes out of
      // the height rather than adding to it -- py-[6.5rem] left a 16px slot,
      // too short for one line, and the words scrolled up out of sight.
      //
      // 320px from the sm breakpoint up, 224px below it. That is a width test
      // standing in for a height one: phones are the narrow case and also the
      // short one, and the controls sit below this box, so a tall box on a
      // small screen pushes them out of reach.
      //
      // The spacers below scale with it. They exist so the first and last lines
      // can reach the middle, which takes half the box height -- left at h-24
      // they were 64px short of a 320px box and the opening lines sat high.
      className="h-56 overflow-y-auto px-1 sm:h-80"
    >
      {/* Lets the first line reach the middle; without it there is nothing to
          scroll past and line one stays pinned to the top. */}
      <div aria-hidden className="h-24 sm:h-40" />
      {parsed.map((line, i) => {
        const isActive = i === activeIndex;
        const inPassage = marks.has(i);
        return (
          <div
            key={i}
            data-line={i}
            ref={isActive ? activeRef : null}
            role={timed ? "button" : undefined}
            tabIndex={timed ? 0 : undefined}
            onClick={() => {
              if (!timed || line.time < 0) return;
              onSeek(line.time);
              setFollowing(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && timed && line.time >= 0) onSeek(line.time);
            }}
            // The line being sung is bigger, not merely a different colour.
            // Someone singing reads this from arm's length and out of the
            // corner of an eye, where a hue change is easy to miss and a size
            // change is not.
            className={`rounded px-1.5 py-1 leading-snug transition-all ${
              timed ? "cursor-pointer hover:bg-white/5" : ""
            } ${
              // The pale tint marks the whole passage the game is showing —
              // what the singer has to perform — and stays on every line of it,
              // including the one currently being sung. Kept separate from the
              // size/colour choice below so the line being sung keeps its tint
              // rather than trading it for the sweep.
              inPassage ? "bg-yellow-500/10" : ""
            } ${
              isActive
                // The line being sung: larger and swept, not tinted-by-colour —
                // the sweep supplies the highlight, and a line already in the
                // highlight colour would leave it nothing to reveal. The unsung
                // part reads as dimmed against it.
                ? "text-[0.95rem] font-semibold text-muted"
                : inPassage
                  // A passage line not currently sung: the words stay yellow on
                  // the dark grounds (dark / high-contrast), where yellow reads
                  // well, but drop to the muted grey on the light grounds
                  // (light / warm), where the yellow washed out against the pale
                  // panel. dark: keys off the .dark class the dark grounds carry
                  // and the light ones do not.
                  ? "text-[0.8rem] text-muted dark:text-yellow-500/90"
                  : "text-[0.8rem] text-muted"
            }`}
          >
            {isActive && line.text
              ? (
                <SweptLine
                  text={line.text}
                  progress={
                    wordByIndex.get(i)
                      ? sweepProgress(wordByIndex.get(i), current)
                      : evenProgress(line, parsed[i + 1], current, line.text.length)
                  }
                />
              )
              : (line.text || " ")}
          </div>
        );
      })}
      {/* And the same below, so the last line can be centred rather than
          stopping halfway up the box. */}
      <div aria-hidden className="h-24 sm:h-40" />
    </div>
  );
}
