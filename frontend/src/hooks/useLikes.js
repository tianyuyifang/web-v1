"use client";

import { useCallback } from "react";
import { likesAPI } from "@/lib/api";
import usePlayerStore from "@/store/playerStore";

// Tracks clip keys with in-flight toggle requests.
// usePlaylistLikes checks this to skip SSE echoes of our own actions.
export const pendingLikeKeys = new Set();

export default function useLikes({ playlistId, clipId }) {
  const isLiked = usePlayerStore((s) => s.isClipLiked(playlistId, clipId));
  const toggleClipLike = usePlayerStore((s) => s.toggleClipLike);

  const toggleLike = useCallback(async () => {
    const key = `${playlistId}:${clipId}`;
    // Optimistic update
    toggleClipLike(playlistId, clipId);
    pendingLikeKeys.add(key);

    try {
      await likesAPI.toggle({ playlistId, clipId });
    } catch {
      // Rollback on error
      toggleClipLike(playlistId, clipId);
    } finally {
      pendingLikeKeys.delete(key);
    }
  }, [playlistId, clipId, toggleClipLike]);

  return { isLiked, toggleLike };
}
