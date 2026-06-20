"use client";

import { useMemo, useCallback } from "react";
import usePlayerStore from "@/store/playerStore";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { findAdjacentUnliked } from "@/lib/clipNav";

/**
 * Floating bottom-center control to jump to the previous/next *unliked* clip,
 * relative to the currently-active (last-played) clip in this playlist.
 *
 * Rendered once per playlist page. Hidden until a clip in this playlist has
 * been played. Reuses findAdjacentUnliked + triggerPlayFromStart so its
 * behavior matches the auto-advance.
 */
export default function FloatingClipNav({ clips, playlistId }) {
  const { t } = useLanguage();
  const activePlayerId = usePlayerStore((s) => s.activePlayerId);
  const triggerPlayFromStart = usePlayerStore((s) => s.triggerPlayFromStart);
  // Subscribe so disabled state updates live as likes change.
  const likedClips = usePlayerStore((s) => s.likedClips);

  // activePlayerId is `${playlistId}-${clipId}`. Derive the active clip's index
  // within this playlist; -1 / null if nothing in this playlist is active.
  const activeIndex = useMemo(() => {
    if (!activePlayerId || !Array.isArray(clips)) return -1;
    const prefix = `${playlistId}-`;
    if (!activePlayerId.startsWith(prefix)) return -1;
    const clipId = activePlayerId.slice(prefix.length);
    return clips.findIndex((c) => c && c.clipId === clipId);
  }, [activePlayerId, clips, playlistId]);

  const prevIdx = useMemo(
    () => findAdjacentUnliked(clips, activeIndex, -1, likedClips, playlistId),
    [clips, activeIndex, likedClips, playlistId]
  );
  const nextIdx = useMemo(
    () => findAdjacentUnliked(clips, activeIndex, 1, likedClips, playlistId),
    [clips, activeIndex, likedClips, playlistId]
  );

  const goPrev = useCallback(() => {
    if (prevIdx >= 0) triggerPlayFromStart(clips[prevIdx].clipId);
  }, [prevIdx, clips, triggerPlayFromStart]);
  const goNext = useCallback(() => {
    if (nextIdx >= 0) triggerPlayFromStart(clips[nextIdx].clipId);
  }, [nextIdx, clips, triggerPlayFromStart]);

  // Hidden until a clip in this playlist is active.
  if (activeIndex < 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface/95 px-1.5 py-1.5 shadow-lg backdrop-blur">
      <button
        onClick={goPrev}
        disabled={prevIdx < 0}
        aria-label={t("prevUnliked")}
        title={t("prevUnliked")}
        className="flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
          <rect x="5" y="5" width="2.5" height="14" rx="1" />
          <polygon points="20,5 20,19 9,12" />
        </svg>
      </button>
      <button
        onClick={goNext}
        disabled={nextIdx < 0}
        aria-label={t("nextUnliked")}
        title={t("nextUnliked")}
        className="flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
          <polygon points="4,5 4,19 15,12" />
          <rect x="16.5" y="5" width="2.5" height="14" rx="1" />
        </svg>
      </button>
    </div>
  );
}
