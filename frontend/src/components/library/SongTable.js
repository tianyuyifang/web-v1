"use client";

import { useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatDuration, getDefaultStart } from "@/lib/utils";

export default function SongTable({
  songs,
  loading,
  hasMore,
  onLoadMore,
  onCreateClip,
}) {
  const parentRef = useRef(null);

  const virtualizer = useVirtualizer({
    count: songs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 20,
  });

  // Infinite scroll — load more when reaching the bottom
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || !hasMore || loading) return;

    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) onLoadMore();
  }, [hasMore, loading, onLoadMore]);

  return (
    <div
      ref={parentRef}
      onScroll={handleScroll}
      className="h-[calc(100vh-14rem)] overflow-y-auto rounded-lg border border-border"
    >
      {/* Header */}
      <div className="sticky top-0 z-10 grid grid-cols-[1fr_1fr_80px_80px_140px] gap-2 border-b border-border bg-surface px-4 py-2 text-xs font-semibold text-muted">
        <span>Title</span>
        <span>Artist</span>
        <span>Duration</span>
        <span>Clips</span>
        <span>Actions</span>
      </div>

      {/* Virtualized rows */}
      <div
        style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const song = songs[virtualRow.index];
          const clipCount = song.clips?.length ?? 0;
          const defaultStart =
            clipCount > 0 ? formatDuration(getDefaultStart(song)) : "--";

          return (
            <div
              key={song.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className="grid grid-cols-[1fr_1fr_80px_80px_140px] items-center gap-2 border-b border-border px-4 text-sm hover:bg-surface-hover"
            >
              <span className="truncate text-theme">{song.title}</span>
              <span className="truncate text-muted">{song.artist}</span>
              <span className="text-muted">
                {formatDuration(song.duration)}
              </span>
              <span className="text-muted">
                {clipCount > 0 ? `${clipCount} (${defaultStart})` : "0"}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => onCreateClip(song)}
                  className="rounded bg-primary px-2 py-0.5 text-xs text-white hover:bg-primary-hover"
                >
                  {clipCount > 0 ? "New Clip" : "Create Clip"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {loading && (
        <div className="py-4 text-center text-sm text-muted">Loading...</div>
      )}
    </div>
  );
}
