"use client";

import { useCallback } from "react";
import { likesAPI } from "@/lib/api";
import usePlayerStore from "@/store/playerStore";

export default function useLikes({ playlistId, songId }) {
  const isLiked = usePlayerStore((s) => s.isSongLiked(playlistId, songId));
  const toggleSongLike = usePlayerStore((s) => s.toggleSongLike);

  const toggleLike = useCallback(async () => {
    // Optimistic update
    toggleSongLike(playlistId, songId);

    try {
      await likesAPI.toggle({ playlistId, songId });
    } catch {
      // Rollback on error
      toggleSongLike(playlistId, songId);
    }
  }, [playlistId, songId, toggleSongLike]);

  return { isLiked, toggleLike };
}
