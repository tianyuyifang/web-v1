"use client";

import { useEffect } from "react";
import { getLikesSSEUrl } from "@/lib/api";
import usePlayerStore from "@/store/playerStore";

/**
 * Connects to SSE stream for real-time like updates on a playlist.
 * Updates the shared likedSongs store when events arrive.
 */
export default function usePlaylistLikes(playlistId) {
  useEffect(() => {
    if (!playlistId) return;

    const url = getLikesSSEUrl(playlistId);
    const es = new EventSource(url);

    es.addEventListener("like-update", (e) => {
      try {
        const { songId, liked } = JSON.parse(e.data);
        const key = `${playlistId}:${songId}`;
        const store = usePlayerStore.getState();
        const next = new Set(store.likedSongs);
        if (liked) {
          next.add(key);
        } else {
          next.delete(key);
        }
        usePlayerStore.setState({ likedSongs: next });
      } catch {
        // ignore parse errors
      }
    });

    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do unless permanently closed
    };

    return () => es.close();
  }, [playlistId]);
}
