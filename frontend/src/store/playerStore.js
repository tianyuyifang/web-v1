import { create } from "zustand";

const usePlayerStore = create((set, get) => ({
  // Global playback — only one PlayerBox plays at a time
  activePlayerId: null,
  setActivePlayer: (id) => set({ activePlayerId: id }),

  // Sidebar "go to" — clipId to play from start, cleared after consumed
  playFromStartClipId: null,
  triggerPlayFromStart: (clipId) => set({ playFromStartClipId: clipId }),
  clearPlayFromStart: () => set({ playFromStartClipId: null }),

  // Liked clips cache — Set of "playlistId:clipId" keys
  likedClips: new Set(),

  setLikedClips: (clipKeys) => set({ likedClips: new Set(clipKeys) }),

  isClipLiked: (playlistId, clipId) =>
    get().likedClips.has(`${playlistId}:${clipId}`),

  toggleClipLike: (playlistId, clipId) => {
    const key = `${playlistId}:${clipId}`;
    const next = new Set(get().likedClips);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    set({ likedClips: next });
  },
}));

export default usePlayerStore;
