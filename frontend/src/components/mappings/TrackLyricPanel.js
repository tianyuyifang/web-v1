"use client";

/**
 * The panel a mapping row expands into: transport, progress, and synced lyrics.
 *
 * Lyrics are the point. Reviewing a mapping means answering "is this the same
 * recording the game means", and the words settle that faster than the audio
 * does — a cover has the same title and often the same duration, but the timing
 * of the lines gives it away.
 *
 * Clicking a line seeks to it, so a reviewer can jump to the chorus instead of
 * waiting through an intro. That is the whole reason the lyrics are timestamped
 * here rather than shown as a static block.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseLRC, getActiveLyricIndex } from "@/lib/lrc";
import { mappingAPI } from "@/lib/api";

/** Eight lines, per the review workflow: enough to judge a verse at a glance. */
const VISIBLE_LINES = 8;
const LINE_HEIGHT_PX = 26;

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function TrackLyricPanel({
  row,
  isPlaying,
  current,
  duration,
  onTogglePlay,
  onSeekSeconds,
  busy,
  error,
}) {
  const [lyrics, setLyrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const innerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const request = row.kind === "imported"
      ? mappingAPI.trackLyrics(row.id)
      : mappingAPI.lyrics(row.id);
    request
      .then((res) => { if (!cancelled) setLyrics(res.data.lyric || null); })
      // A song without lyrics is ordinary; the panel says so rather than
      // treating it as a failure worth shouting about.
      .catch(() => { if (!cancelled) setLyrics(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [row.id, row.kind]);

  const parsed = useMemo(() => parseLRC(lyrics), [lyrics]);
  // parseLRC marks lyrics with no timestamps by giving the first line time -1.
  const isTimed = parsed.length > 0 && parsed[0].time !== -1;
  const activeIndex = isTimed ? getActiveLyricIndex(parsed, current) : -1;

  // Keep the active line centred. Transform rather than scrollTop so the
  // browser can animate it without laying the list out again each frame.
  useEffect(() => {
    if (!isTimed || activeIndex < 0 || !innerRef.current) return;
    const offset = Math.max(
      0,
      activeIndex * LINE_HEIGHT_PX - (VISIBLE_LINES * LINE_HEIGHT_PX) / 2 + LINE_HEIGHT_PX / 2,
    );
    innerRef.current.style.transform = `translateY(-${offset}px)`;
  }, [activeIndex, isTimed]);

  const seekToLine = useCallback((line) => {
    if (!isTimed || line.time < 0) return;
    onSeekSeconds(line.time);
  }, [isTimed, onSeekSeconds]);

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <div className="border-t border-border/60 bg-black/10 px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onTogglePlay}
          disabled={busy}
          className="h-7 w-7 shrink-0 rounded-full border border-border text-xs hover:border-accent disabled:opacity-30"
        >
          {busy ? "…" : isPlaying ? "❚❚" : "▶"}
        </button>

        {/* Click anywhere on the bar to seek; the reviewer is usually hunting
            for one passage rather than listening through. */}
        <div
          role="presentation"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const fraction = (e.clientX - rect.left) / rect.width;
            if (duration > 0) onSeekSeconds(fraction * duration);
          }}
          className="h-1.5 flex-1 cursor-pointer rounded-full bg-black/30"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>

        <span className="shrink-0 font-mono text-[0.68rem] text-muted">
          {formatTime(current)} / {formatTime(duration)}
        </span>
      </div>

      {error && <div className="mt-1.5 text-xs text-red-400">{error}</div>}

      <div
        className="mt-2 overflow-hidden"
        style={{ height: VISIBLE_LINES * LINE_HEIGHT_PX }}
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
          <div
            ref={innerRef}
            className="transition-transform duration-300 ease-out"
          >
            {parsed.map((line, i) => (
              <div
                key={i}
                role={isTimed ? "button" : undefined}
                tabIndex={isTimed ? 0 : undefined}
                onClick={() => seekToLine(line)}
                onKeyDown={(e) => { if (e.key === "Enter") seekToLine(line); }}
                style={{ height: LINE_HEIGHT_PX }}
                className={`flex items-center truncate text-[0.78rem] leading-none ${
                  isTimed ? "cursor-pointer hover:text-fg" : ""
                } ${i === activeIndex ? "font-medium text-accent" : "text-muted"}`}
              >
                {line.text || " "}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
