"use client";

import { useRef, useCallback, memo } from "react";
import { formatDuration } from "@/lib/utils";

export default memo(function ProgressBar({ currentTime, duration, onSeek }) {
  const barRef = useRef(null);
  const pct = duration ? Math.min((currentTime / duration) * 100, 100) : 0;

  const seekFromEvent = useCallback((clientX) => {
    if (!barRef.current || !duration) return;
    const rect = barRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  }, [duration, onSeek]);

  const handlePointerDown = useCallback((e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromEvent(e.clientX);
  }, [seekFromEvent]);

  const handlePointerMove = useCallback((e) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      seekFromEvent(e.clientX);
    }
  }, [seekFromEvent]);

  return (
    <div className="py-1.5">
      <div
        ref={barRef}
        className="relative h-1 w-full cursor-pointer rounded-sm"
        style={{ background: "var(--border)" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
      >
        {/* Fill */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 rounded-sm bg-primary"
          style={{ width: `${pct}%` }}
        />
        {/* Thumb */}
        <div
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-sm transition-transform hover:scale-125"
          style={{
            left: `${pct}%`,
            border: "2.5px solid var(--surface)",
            boxShadow: "0 0 0 1px rgba(var(--primary-rgb, 91,82,212), 0.2), 0 1px 3px rgba(0,0,0,0.12)",
          }}
        />
      </div>
    </div>
  );
})
