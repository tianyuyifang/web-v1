"use client";

/**
 * A tall lyrics panel that sits beside the review list.
 *
 * Lyrics are how a mapping actually gets judged: a cover shares the title and
 * often the duration, and the words are what give it away. So this shows a
 * whole verse at once rather than a handful of lines.
 *
 * Distance from the playing line is shown by fading only. Blurring the far
 * lines looks the part — it is what the phone players do — but those players
 * are glanced at while listening, whereas this one is read while comparing two
 * recordings, and a blurred line cannot be read or aimed at.
 *
 * The panel is sized to end above the fold, since the transport sits at its
 * bottom and a play button below the viewport cannot be clicked.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseLRC, getActiveLyricIndex } from "@/lib/lrc";
import { mappingAPI } from "@/lib/api";

/** Half a second — the scale at which a mistimed line becomes obvious. */
const NUDGE_SEC = 0.5;

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * How a line looks, given how far it is from the one playing.
 *
 * Fade only. Blurring distant lines looks the part but works against the
 * reason they are on screen: these are read, not glanced at, and a reviewer
 * comparing a cover against the original needs the whole verse legible at once.
 */
function lineStyle(distance, isActive, suppressed) {
  if (isActive) return { opacity: 1 };
  if (suppressed) return { opacity: 0.8 };
  if (distance === 1) return { opacity: 0.7 };
  if (distance <= 3) return { opacity: 0.55 };
  return { opacity: 0.42 };
}

export default function TrackLyricPanel({
  row,
  isPlaying,
  current,
  duration,
  onTogglePlay,
  onSeekSeconds,
  onNudge,
  onClose,
  busy,
  error,
}) {
  const [lyrics, setLyrics] = useState(null);
  const [loading, setLoading] = useState(true);
  // While the reviewer is reading rather than following, auto-scroll fights them.
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

  const nudge = useCallback((delta) => {
    onNudge(delta);
  }, [onNudge]);

  /**
   * a and d nudge backwards and forwards while the panel is open.
   *
   * Bound on the window rather than the panel, since the reviewer's focus is
   * usually still in the list they clicked from — requiring them to click the
   * panel first would make the keys feel broken.
   *
   * Ignored while typing: the search box is on the same page, and "d" in a
   * song title must not jump the audio.
   */
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      const typing = el instanceof HTMLElement
        && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (key !== "a" && key !== "d") return;
      e.preventDefault();
      nudge(key === "a" ? -NUDGE_SEC : NUDGE_SEC);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nudge]);

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <aside className="flex h-[calc(100vh-9rem)] max-h-[42rem] flex-col rounded-lg border border-border bg-surface">
      <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.82rem] font-medium">{row.title}</div>
          <div className="truncate text-[0.68rem] text-muted">
            {row.artist || "（无歌手）"}
          </div>
          {/* Kept out of the list, where it crowded the artist name, but still
              one click away: this is what a track is looked up by elsewhere. */}
          {row.externalId && (
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(row.externalId)}
              title="点击复制 ID"
              className="mt-0.5 max-w-full truncate rounded bg-black/20 px-1 py-px font-mono text-[0.6rem] text-muted hover:text-fg"
            >
              {row.externalId}
            </button>
          )}
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
                  transition: "opacity 0.3s ease",
                }}
                className={`py-1.5 text-[0.82rem] leading-snug ${
                  isTimed ? "cursor-pointer hover:!opacity-100" : ""
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
            onClick={() => nudge(-NUDGE_SEC)}
            title="后退 0.5 秒（A）"
            className="h-8 w-8 shrink-0 rounded-full border border-border text-[0.62rem] text-muted hover:border-accent hover:text-fg"
          >
            −0.5
          </button>

          <button
            type="button"
            onClick={onTogglePlay}
            disabled={busy}
            className="h-8 w-8 shrink-0 rounded-full border border-border text-xs hover:border-accent disabled:opacity-30"
          >
            {busy ? "…" : isPlaying ? "❚❚" : "▶"}
          </button>

          <button
            type="button"
            onClick={() => nudge(NUDGE_SEC)}
            title="前进 0.5 秒（D）"
            className="h-8 w-8 shrink-0 rounded-full border border-border text-[0.62rem] text-muted hover:border-accent hover:text-fg"
          >
            +0.5
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
