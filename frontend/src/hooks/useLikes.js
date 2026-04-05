"use client";

import { useCallback } from "react";
import { likesAPI } from "@/lib/api";
import usePlayerStore from "@/store/playerStore";

export default function useLikes({ playlistId, clipId }) {
  const isLiked = usePlayerStore((s) => s.isClipLiked(playlistId, clipId));
  const toggleClipLike = usePlayerStore((s) => s.toggleClipLike);

  const toggleLike = useCallback(async () => {
    // Optimistic update
    toggleClipLike(playlistId, clipId);

    try {
      await likesAPI.toggle({ playlistId, clipId });
    } catch {
      // Rollback on error
      toggleClipLike(playlistId, clipId);
    }
  }, [playlistId, clipId, toggleClipLike]);

  return { isLiked, toggleLike };
}
