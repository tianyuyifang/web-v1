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
 * Does a game line correspond to this real line?
 *
 * The mask character stands for exactly one hidden character, so a masked line
 * is compared on its visible characters in order. Anything the game got wrong
 * outright simply lowers the score.
 */
function linesMatch(gameLine, realLine) {
  const g = normalise(gameLine).replace(/_+/g, "");
  const r = normalise(realLine);
  if (g.length < MIN_LINE_CHARS || !r.length) return false;

  // Walk the visible characters in order; the real line may carry extras where
  // the game masked them out.
  let hits = 0;
  let at = 0;
  for (const ch of g) {
    const found = r.indexOf(ch, at);
    if (found >= 0) { hits++; at = found + 1; }
  }
  return hits / g.length >= MATCH_RATIO;
}

/**
 * Which real lines the game's passage covers.
 *
 * Returns a Set of indexes into the parsed lyrics. Shuffling is handled for
 * free: every game line is matched independently, so their order never matters.
 */
function markPassage(gameLyric, parsed) {
  const marks = new Set();
  if (!gameLyric || !parsed.length) return marks;
  const gameLines = gameLyric
    .split(/[\n\/]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of gameLines) {
    // First match wins: a chorus repeats, and highlighting every repetition
    // would point the singer at several places at once.
    const hit = parsed.findIndex((p) => linesMatch(line, p.text));
    if (hit >= 0) marks.add(hit);
  }
  return marks;
}

export default function LiveLyrics({ mappingId, gameLyric, current, onSeek }) {
  const [lrc, setLrc] = useState(null);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef(null);
  const activeRef = useRef(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (!mappingId) { setLrc(null); setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    mappingAPI.lyrics(mappingId)
      .then((res) => { if (alive) setLrc(res.data.lyric || null); })
      // A song without lyrics is ordinary, not a failure worth shouting about.
      .catch(() => { if (alive) setLrc(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [mappingId]);

  const parsed = useMemo(() => parseLRC(lrc), [lrc]);
  const timed = parsed.length > 0 && parsed[0].time !== -1;
  const activeIndex = timed ? getActiveLyricIndex(parsed, current) : -1;
  const marks = useMemo(() => markPassage(gameLyric, parsed), [gameLyric, parsed]);

  // Jump to the passage the moment it is identified — that is the whole point
  // of showing it, and the singer has seconds to look at it.
  const firstMark = useMemo(() => (marks.size ? Math.min(...marks) : -1), [marks]);
  useEffect(() => {
    if (firstMark < 0 || !scrollRef.current) return;
    const node = scrollRef.current.querySelector(`[data-line="${firstMark}"]`);
    if (node) node.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [firstMark]);

  // Keep the playing line centred, unless the singer has scrolled away.
  useEffect(() => {
    if (!following || activeIndex < 0 || !activeRef.current || !scrollRef.current) return;
    const box = scrollRef.current;
    const line = activeRef.current;
    box.scrollTo({
      top: Math.max(0, line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2),
      behavior: "smooth",
    });
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
        <div className="mb-1 text-[0.65rem] text-yellow-500/80">游戏给出的片段（无完整歌词）</div>
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
      className="max-h-56 overflow-y-auto px-1 py-2"
    >
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
            className={`rounded px-1.5 py-1 text-[0.8rem] leading-snug transition-colors ${
              timed ? "cursor-pointer hover:bg-white/5" : ""
            } ${
              isActive
                ? "font-medium text-accent"
                : inPassage
                  // The passage the game is showing: what the singer has to
                  // perform, and the reason this panel is open.
                  ? "bg-yellow-500/10 text-yellow-500/90"
                  : "text-muted"
            }`}
          >
            {line.text || " "}
          </div>
        );
      })}
    </div>
  );
}
