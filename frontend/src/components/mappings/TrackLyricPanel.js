"use client";

/**
 * A tall lyrics panel that sits beside the review list.
 *
 * Lyrics are how a mapping actually gets judged: a cover shares the title and
 * often the duration, and the words are what give it away. So this shows many
 * lines rather than a handful, and keeps them readable by blurring with
 * distance instead of clipping — the trick QQ Music and Apple Music both use.
 * Far lines stay visible as texture without competing for attention, so twenty
 * lines read as calmly as five.
 *
 * The blur curve is taken from applemusic-like-lyrics rather than invented:
 * one pixel per line of distance, capped, dropped entirely while the reviewer
 * is scrolling by hand so they can aim at a line to click it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseLRC, getActiveLyricIndex } from "@/lib/lrc";
import { mappingAPI } from "@/lib/api";

/** Matches the reference: 1px per line away, never past this. */
const MAX_BLUR_PX = 4;

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * How a line looks, given how far it is from the one playing.
 *
 * Blur and fade rise together so distance reads as depth. Hovering or manual
 * scrolling clears both — a blurred line is hard to aim at, and clicking to
 * seek is the point of showing them.
 */
function lineStyle(distance, isActive, suppressed) {
  if (isActive) return { opacity: 1, filter: "none" };
  if (suppressed) return { opacity: 0.65, filter: "none" };
  const blur = Math.min(MAX_BLUR_PX, distance);
  const opacity = distance === 1 ? 0.55 : distance === 2 ? 0.4 : 0.28;
  return { opacity, filter: `blur(${blur}px)` };
}

export default function TrackLyricPanel({
  row,
  isPlaying,
  current,
  duration,
  onTogglePlay,
  onSeekSeconds,
  onClose,
  busy,
  error,
}) {
  const [lyrics, setLyrics] = useState(null);
  const [loading, setLoading] = useState(true);
  // While the reviewer is reading rather than following, blur would fight them.
  const [suppressed, setSuppressed] = useState(false);
  const suppressTimer = useRef(null);
  const scrollRef = useRef(null);
  const activeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLyrics(null);
    const request = row.kind === "imported"
      ? mappingAPI.trackLyrics(row.id)
      : mappingAPI.lyrics(row.id);
    request
      .then((res) => { if (!cancelled) setLyrics(res.data.lyric || null); })
      // A song without lyrics is ordinary, not a failure worth shouting about.
      .catch(() => { if (!cancelled) setLyrics(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [row.id, row.kind]);

  useEffect(() => () => clearTimeout(suppressTimer.current), []);

  const parsed = useMemo(() => parseLRC(lyrics), [lyrics]);
  // parseLRC marks untimed lyrics by giving the first line time -1.
  const isTimed = parsed.length > 0 && parsed[0].time !== -1;
  const activeIndex = isTimed ? getActiveLyricIndex(parsed, current) : -1;

  // Keep the playing line centred, unless the reviewer has taken over.
  useEffect(() => {
    if (suppressed || activeIndex < 0 || !activeRef.current || !scrollRef.current) return;
    const container = scrollRef.current;
    const line = activeRef.current;
    const target = line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [activeIndex, suppressed]);

  /**
   * Hand control to the reviewer for a moment after they scroll.
   *
   * Without this the auto-scroll yanks the list back mid-read on the next
   * timeupdate, which makes finding a line by hand impossible.
   */
  const noteManualScroll = useCallback(() => {
    setSuppressed(true);
    clearTimeout(suppressTimer.current);
    suppressTimer.current = setTimeout(() => setSuppressed(false), 4000);
  }, []);

  const seekToLine = useCallback((line) => {
    if (!isTimed || line.time < 0) return;
    onSeekSeconds(line.time);
    // Following again is the natural intent after picking a line.
    clearTimeout(suppressTimer.current);
    setSuppressed(false);
  }, [isTimed, onSeekSeconds]);

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <aside className="flex h-[calc(100vh-8rem)] flex-col rounded-lg border border-border bg-surface">
      <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.82rem] font-medium">{row.title}</div>
          <div className="truncate text-[0.68rem] text-muted">
            {row.artist || "（无歌手）"}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="收起"
          className="shrink-0 rounded border border-border px-1.5 text-xs text-muted hover:text-fg"
        >
          ✕
        </button>
      </div>

      {/* Lyrics take the height that is left, so the panel is mostly words. */}
      <div
        ref={scrollRef}
        onWheel={noteManualScroll}
        onTouchMove={noteManualScroll}
        onMouseEnter={() => setSuppressed(true)}
        onMouseLeave={() => setSuppressed(false)}
        className="flex-1 overflow-y-auto px-3 py-4"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted">
            歌词加载中…
          </div>
        ) : !parsed.length ? (
          <div className="flex h-full items-center justify-center text-xs text-muted">
            暂无歌词
          </div>
        ) : (
          parsed.map((line, i) => {
            const isActive = i === activeIndex;
            const distance = activeIndex < 0 ? 0 : Math.abs(i - activeIndex);
            return (
              <div
                key={i}
                ref={isActive ? activeRef : null}
                role={isTimed ? "button" : undefined}
                tabIndex={isTimed ? 0 : undefined}
                onClick={() => seekToLine(line)}
                onKeyDown={(e) => { if (e.key === "Enter") seekToLine(line); }}
                style={{
                  ...lineStyle(distance, isActive, suppressed || !isTimed),
                  transition: "opacity 0.4s ease, filter 0.4s ease",
                }}
                className={`py-1.5 text-[0.82rem] leading-snug ${
                  isTimed ? "cursor-pointer hover:!opacity-100 hover:!blur-0" : ""
                } ${isActive ? "font-medium text-accent" : "text-fg"}`}
              >
                {line.text || " "}
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-border/60 px-3 py-2">
        {error && <div className="mb-1.5 text-xs text-red-400">{error}</div>}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onTogglePlay}
            disabled={busy}
            className="h-8 w-8 shrink-0 rounded-full border border-border text-xs hover:border-accent disabled:opacity-30"
          >
            {busy ? "…" : isPlaying ? "❚❚" : "▶"}
          </button>

          <div
            role="presentation"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              if (duration > 0) onSeekSeconds(((e.clientX - rect.left) / rect.width) * duration);
            }}
            className="h-1.5 flex-1 cursor-pointer rounded-full bg-black/30"
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>

          <span className="shrink-0 font-mono text-[0.68rem] text-muted">
            {formatTime(current)} / {formatTime(duration)}
          </span>
        </div>
      </div>
    </aside>
  );
}
