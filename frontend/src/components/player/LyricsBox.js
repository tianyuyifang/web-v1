"use client";

import { useMemo, useEffect, useRef, useState, memo } from "react";
import { parseLRC, getActiveLyricIndex } from "@/lib/lrc";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { fetchLyrics, getCachedLyrics } from "@/lib/lyricsCache";
import usePlayerStore from "@/store/playerStore";

export default memo(function LyricsBox({ clipId, clipVersion, currentTime, clipStart }) {
  const { t } = useLanguage();
  const containerRef = useRef(null);
  const innerRef = useRef(null);
  const staticRef = useRef(null);

  // Toggling edit mode stops and rewinds every player (store.stopAll). Cards
  // used to be rebuilt then, so lyrics came back at the top at once; do the
  // same here. Without it, a clip whose first line starts after 0 kept its old
  // scroll with nothing highlighted. Only boxes actually scrolled are touched.
  useEffect(() => usePlayerStore.subscribe((state, prev) => {
    if (state.stopAllSeq === prev.stopAllSeq) return;
    const inner = innerRef.current;
    if (inner && inner.style.transform && inner.style.transform !== "translateY(-0px)") {
      inner.style.transition = "none"; // jump, as a fresh box would
      inner.style.transform = "";
      requestAnimationFrame(() => { inner.style.transition = ""; });
    }
    if (staticRef.current && staticRef.current.scrollTop) staticRef.current.scrollTop = 0;
  }), []);

  // Lyrics are fetched on demand from /api/clips/:id/lyrics.
  // Seed with cached value (if any) so first render is instant for revisits.
  const [lyrics, setLyrics] = useState(() => getCachedLyrics(clipId, clipVersion));

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedLyrics(clipId, clipVersion);
    setLyrics(cached);
    if (cached !== null) return;
    fetchLyrics(clipId, clipVersion).then((result) => {
      if (!cancelled) setLyrics(result);
    });
    return () => { cancelled = true; };
  }, [clipId, clipVersion]);

  const parsed = useMemo(() => parseLRC(lyrics), [lyrics]);

  const isStatic = parsed.length > 0 && parsed[0].time === -1;
  const absoluteTime = clipStart + currentTime;
  const activeIndex = isStatic ? -1 : getActiveLyricIndex(parsed, absoluteTime);

  // CSS transform-based scrolling for timestamped lyrics
  useEffect(() => {
    if (isStatic || activeIndex < 0 || !innerRef.current || !containerRef.current) return;
    const activeLine = innerRef.current.children[activeIndex];
    if (!activeLine) return;
    const lineHeight = activeLine.offsetHeight;
    const containerHeight = containerRef.current.offsetHeight;
    const offset = Math.max(0, activeIndex * lineHeight - containerHeight / 2 + lineHeight / 2);
    innerRef.current.style.transform = `translateY(-${offset}px)`;
  }, [activeIndex, isStatic]);

  if (!parsed.length) {
    return (
      <div className="flex h-[92px] items-center justify-center text-xs text-muted">
        {t("noLyrics")}
      </div>
    );
  }

  // Static lyrics: scrollable, no highlight
  if (isStatic) {
    return (
      <div ref={staticRef} className="h-[92px] overflow-y-auto mb-3">
        {parsed.map((line, i) => (
          <p key={i} className="text-[0.72rem] leading-[1.8] text-muted">
            {line.text}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-[92px] overflow-hidden mb-3"
    >
      <div
        ref={innerRef}
        className="transition-transform duration-400"
        style={{ transitionTimingFunction: "cubic-bezier(0.25, 0.1, 0.25, 1)" }}
      >
        {parsed.map((line, i) => (
          <p
            key={i}
            className={`cursor-pointer truncate transition-colors ${
              i === activeIndex
                ? "text-[0.82rem] font-semibold leading-[1.65] text-primary"
                : "text-[0.72rem] leading-[1.8] text-muted opacity-60 hover:opacity-80"
            }`}
          >
            {line.text}
          </p>
        ))}
      </div>
    </div>
  );
})
