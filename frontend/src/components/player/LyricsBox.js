"use client";

import { useMemo, useEffect, useRef, memo } from "react";
import { parseLRC, getActiveLyricIndex } from "@/lib/lrc";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default memo(function LyricsBox({ lyrics, currentTime, clipStart }) {
  const { t } = useLanguage();
  const containerRef = useRef(null);
  const innerRef = useRef(null);
  const parsed = useMemo(() => parseLRC(lyrics), [lyrics]);

  const absoluteTime = clipStart + currentTime;
  const activeIndex = getActiveLyricIndex(parsed, absoluteTime);

  // CSS transform-based scrolling like v5
  useEffect(() => {
    if (activeIndex < 0 || !innerRef.current || !containerRef.current) return;
    const activeLine = innerRef.current.children[activeIndex];
    if (!activeLine) return;
    const lineHeight = activeLine.offsetHeight;
    const containerHeight = containerRef.current.offsetHeight;
    const offset = Math.max(0, activeIndex * lineHeight - containerHeight / 2 + lineHeight / 2);
    innerRef.current.style.transform = `translateY(-${offset}px)`;
  }, [activeIndex]);

  if (!parsed.length) {
    return (
      <div className="flex h-[92px] items-center justify-center text-xs text-muted">
        {t("noLyrics")}
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
