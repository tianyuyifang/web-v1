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
import { placementsOf, isRangeAnswer } from "@/lib/passageAnswer";
import { markPassage } from "@/lib/passageMatch";


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
  onUsedVerified, onChorusTime,
  override,
}) {
  const [lrc, setLrc] = useState(null);
  /**
   * Where the platform says the chorus starts, in milliseconds.
   *
   * Known as soon as the song is known — it rides along on the lyric response
   * and needs no game card, which is exactly what makes it worth drawing: the
   * singer sees the hook coming before the passage has been matched.
   */
  const [chorusMs, setChorusMs] = useState(null);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef(null);
  const activeRef = useRef(null);
  const [following, setFollowing] = useState(true);

  // Split out so the effect depends on the two strings rather than on an object
  // rebuilt every render, which would refetch the words on every tick.
  const ovSource = override?.source || null;
  const ovId = override?.externalId || null;

  const [words, setWords] = useState(null);

  /**
   * A verified answer for this passage, when one has been checked.
   *
   * The matcher below places 91% of lines on its own; what it misses is the two
   * sides breaking lines differently — the game's 「那个傻瓜说的傻话」 is the
   * platform's 「那个傻瓜」 plus 「说的傻话」 — which takes reading the words
   * rather than comparing them. Those answers are decided once and stored.
   *
   * Null unless an approved answer exists, which is the ordinary case. Null
   * means the matcher runs, exactly as it always has.
   */
  const [verified, setVerified] = useState(null);

  // Which recording the words on screen belong to. The fetch below also runs
  // when only `gameLyric` changes — the passage answer is keyed on it — and
  // that case must not blank the box: the words are the same words, and the
  // singer is mid-song. Measured before this existed, one song was fetched up
  // to twelve times as recognition updated the passage, and every fetch swapped
  // the lyrics for 「歌词加载中…」 for a beat — seen from the stage as flicker.
  const recordingRef = useRef(null);

  useEffect(() => {
    if (!mappingId) {
      recordingRef.current = null;
      setLrc(null); setWords(null); setVerified(null); setLoading(false);
      return undefined;
    }
    let alive = true;
    const recording = `${mappingId}|${ovSource || ""}|${ovId || ""}`;
    const sameSong = recordingRef.current === recording;
    recordingRef.current = recording;
    // A new recording clears the box and says so; the same recording refreshes
    // quietly behind the words already showing. The checked answer is dropped
    // either way: it belongs to the previous passage, and when the two happen
    // to have the same line count it would survive the length check and mark
    // the wrong lines until the fresh one lands. The matcher covers the gap.
    if (!sameSong) {
      setLrc(null); setWords(null); setChorusMs(null);
      setLoading(true);
    }
    setVerified(null);
    // While an alternative is being auditioned the words must be that
    // recording's: a cover is usually spotted by reading along, and the
    // original's words under someone else's take is exactly the wrong answer.
    mappingAPI
      .lyrics(
        mappingId,
        ovSource && ovId ? { source: ovSource, externalId: ovId } : undefined,
        true,
        gameLyric || null,
      )
      .then((res) => {
        if (!alive) return;
        setLrc(res.data.lyric || null);
        // Absent for most NetEase tracks and a handful of QQ ones. The sweep
        // falls back to an even pace rather than disappearing.
        setWords(res.data.wordLyric || null);
        // Null for a song the backfill has not reached, or one the platform
        // has no chorus for. Either way the page simply draws no green dot.
        setChorusMs(Number.isFinite(res.data.chorusMs) ? res.data.chorusMs : null);
        // Absent unless this passage has a checked answer — see `verified`.
        const pm = res.data.passageMatch;
        setVerified((Array.isArray(pm) || isRangeAnswer(pm)) ? pm : null);
      })
      // A song without lyrics is ordinary, not a failure worth shouting about.
      // A failed quiet refresh keeps the words it already has: they are the
      // right words, and clearing them for a passage lookup would trade a
      // readable lyric for an empty box.
      .catch(() => { if (alive && !sameSong) { setLrc(null); setWords(null); setVerified(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [mappingId, ovSource, ovId, gameLyric]);

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
  /**
   * Where the passage sits: the checked answer if there is one, else worked out.
   *
   * The stored answer is one place rather than several, because it was chosen
   * knowing which one is right — the matcher returns every candidate precisely
   * because it cannot tell them apart.
   *
   * Length is checked again here even though the server checks it. The two run
   * the same split on the same string, so a disagreement means one of them has
   * changed; falling back to the matcher is the safe reading of that, since an
   * answer one line out would highlight the wrong lines with full confidence.
   */
  // places 之外还产出一个布尔: 这一刻标行用的是人工答案还是算法。
  // 报告按钮只对算法标的段落有意义 —— 人工核过的藏掉它; 而人工答案
  // 因行数对不上回退到算法时, 用户看到的是算法标的, 按钮就该回来。
  const { places, usedVerified } = useMemo(() => {
    if (Array.isArray(verified) || isRangeAnswer(verified)) {
      const lines = String(gameLyric || '')
        .split(/[\n\/]+/).map((l) => l.trim()).filter(Boolean);
      // A stored answer is one placement, or a list of them — a passage is
      // usually sung more than once, and the page marks every occurrence and
      // draws a dot per occurrence, so an answer naming only the first would
      // quietly take the rest away. Which it is takes reading; see
      // `passageAnswer` for why, and for the rule that decides it.
      //
      // Each placement flattens to the lines it covers, in one place: a place
      // is an occurrence, so splitting a placement's continuation lines into a
      // place of their own would invent an occurrence and put a dot in the
      // middle of the real one.
      // 首末(ranges)型每处长度=区间行数, 本就≠游戏行数, 不能按游戏行数过滤;
      // 逐行型仍要求长度匹配(防错位答案标错行)。
      const range = isRangeAnswer(verified);
      const flat = placementsOf(verified, lines.length)
        .filter((p) => range || p.length === lines.length)
        .map((p) => p.flatMap((v) => (Array.isArray(v) ? v : [v])));
      if (flat.length && lines.length) return { places: flat, usedVerified: true };
    }
    return { places: markPassage(gameLyric, parsed), usedVerified: false };
  }, [verified, gameLyric, parsed]);

  // 上报给页面, 和 onPassageTimes 同款。
  useEffect(() => {
    if (!onUsedVerified) return;
    onUsedVerified(usedVerified);
  }, [usedVerified, onUsedVerified]);
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
   * The chorus, snapped onto the line it starts.
   *
   * The platforms report a moment, not a line, and it lands a beat either side
   * of the words: measured over thirty songs, every one fell within 2.5s of a
   * lyric line and most within one. Left raw the dot sits mid-phrase and reads
   * as a mistake, so it moves to the nearest line inside that window — the same
   * 2.5s the offline backfill uses, and the reason the number is not larger is
   * that a wider window starts capturing the *next* line instead.
   *
   * Outside the window it stays where the platform put it: better a dot a
   * second off than one moved to the wrong phrase. Untimed lyrics report the
   * raw position too, since there are no lines to snap to.
   */
  const chorusTime = useMemo(() => {
    // Under a second is not a chorus — the earliest real one measured across
    // 6830 songs is 1057ms. The bound is really a unit check: if a platform
    // ever reports seconds where this expects milliseconds, every value lands
    // here and the dot simply stops appearing, which is obvious. Without it
    // the same mistake would park every dot at the far left of the bar and
    // still snap to the first lyric, looking plausible and being wrong.
    if (!Number.isFinite(chorusMs) || chorusMs < 1000) return null;
    const raw = chorusMs / 1000;
    if (!timed || !parsed.length) return raw;
    let best = null;
    for (const line of parsed) {
      const t = line?.time;
      if (!Number.isFinite(t) || t < 0) continue;
      if (best === null || Math.abs(t - raw) < Math.abs(best - raw)) best = t;
    }
    return best !== null && Math.abs(best - raw) <= 2.5 ? best : raw;
  }, [chorusMs, parsed, timed]);

  useEffect(() => {
    if (!onChorusTime) return;
    onChorusTime(chorusTime);
  }, [chorusTime, onChorusTime]);

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
