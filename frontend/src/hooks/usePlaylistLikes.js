"use client";

import { useEffect, useRef } from "react";
import { getLikesSSEUrl, likesAPI } from "@/lib/api";
import usePlayerStore from "@/store/playerStore";
import { pendingLikeKeys } from "@/hooks/useLikes";

/**
 * Connects to SSE stream for real-time like updates on a playlist.
 * Updates the shared likedClips store when events arrive.
 *
 * - Skips SSE events for clips with in-flight toggle requests (prevents
 *   optimistic-update flicker when our own echo arrives).
 * - Refetches all likes on reconnect to catch events missed while
 *   disconnected (mobile sleep, network blips, etc.).
 */
export default function usePlaylistLikes(playlistId) {
  const hasConnectedRef = useRef(false);

  useEffect(() => {
    if (!playlistId) return;

    const url = getLikesSSEUrl(playlistId);
    const es = new EventSource(url);

    es.addEventListener("like-update", (e) => {
      try {
        const { clipId, liked } = JSON.parse(e.data);
        const key = `${playlistId}:${clipId}`;

        // Skip SSE events for clips we're currently toggling — our optimistic
        // update already shows the correct state, and the echo would flip it back.
        if (pendingLikeKeys.has(key)) return;

        const store = usePlayerStore.getState();
        const next = new Set(store.likedClips);
        if (liked) {
          next.add(key);
        } else {
          next.delete(key);
        }
        usePlayerStore.setState({ likedClips: next });
      } catch {
        // ignore parse errors
      }
    });

    // On (re)connect: refetch all likes to catch any events missed during
    // disconnect. Skip the initial connect (likes are already loaded by the
    // page's useEffect alongside the playlist fetch).
    es.onopen = () => {
      if (!hasConnectedRef.current) {
        hasConnectedRef.current = true;
        return; // skip initial connect — likes already loaded
      }
      // Reconnect — refetch to catch up
      likesAPI.getAll(playlistId)
        .then((res) => {
          usePlayerStore.getState().setLikedClips(res.data.likes);
        })
        .catch(() => {
          // ignore — will retry on next reconnect
        });
    };

    es.onerror = () => {
      // EventSource auto-reconnects. When it succeeds, onopen fires and
      // triggers the refetch above.
    };

    return () => {
      es.close();
      hasConnectedRef.current = false;
    };
  }, [playlistId]);
}
