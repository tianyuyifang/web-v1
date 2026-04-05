import { create } from "zustand";

const usePlayerStore = create((set, get) => ({
  // Global playback — only one PlayerBox plays at a time
  activePlayerId: null,
  setActivePlayer: (id) => set({ activePlayerId: id }),

  // Sidebar "go to" — clipId to play from start, cleared after consumed
  playFromStartClipId: null,
  triggerPlayFromStart: (clipId) => set({ playFromStartClipId: clipId }),
  clearPlayFromStart: () => set({ playFromStartClipId: null }),

  // Liked songs cache — Set of "playlistId:songId" keys
  likedSongs: new Set(),

  setLikedSongs: (keys) => set({ likedSongs: new Set(keys) }),

  isSongLiked: (playlistId, songId) =>
    get().likedSongs.has(`${playlistId}:${songId}`),

  toggleSongLike: (playlistId, songId) => {
    const key = `${playlistId}:${songId}`;
    const next = new Set(get().likedSongs);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    set({ likedSongs: next });
  },
}));

export default usePlayerStore;
