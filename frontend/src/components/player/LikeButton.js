"use client";

import useLikes from "@/hooks/useLikes";

export default function LikeButton({ playlistId, clipId }) {
  const { isLiked, toggleLike } = useLikes({ playlistId, clipId });

  return (
    <button
      onClick={toggleLike}
      className={`flex h-10 w-10 items-center justify-center rounded-full text-2xl transition-colors hover:bg-surface-hover ${
        isLiked ? "text-red-500" : "text-muted hover:text-red-400"
      }`}
      aria-label={isLiked ? "Unlike" : "Like"}
    >
      {isLiked ? "♥" : "♡"}
    </button>
  );
}
