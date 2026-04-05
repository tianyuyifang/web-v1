"use client";

import { memo } from "react";
import useLikes from "@/hooks/useLikes";

export default memo(function LikeButton({ playlistId, songId }) {
  const { isLiked, toggleLike } = useLikes({ playlistId, songId });

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
})
