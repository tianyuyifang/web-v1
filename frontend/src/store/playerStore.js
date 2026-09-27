import { create } from "zustand";

const usePlayerStore = create((set, get) => ({
  // Global playback — only one PlayerBox plays at a time
  activePlayerId: null,
  setActivePlayer: (id) => set({ activePlayerId: id }),

  // Bumped to stop every player and rewind it to the start. Toggling edit mode
  // on the playlist page does this on purpose — it used to happen as a side
  // effect of the grid rebuilding every card.
  stopAllSeq: 0,
  stopAll: () => set((s) => ({ stopAllSeq: s.stopAllSeq + 1 })),

  // Bumped each time a player starts a play (requestPlay). Any other player
  // still loading its clip cancels itself, so a slow load can't finish later
  // and cut off the clip the user picked since. Players already playing are
  // left alone — they stop when the new one becomes active, as before.
  playRequestSeq: 0,
  playRequestBy: null,
  requestPlay: (id) => set((s) => ({ playRequestSeq: s.playRequestSeq + 1, playRequestBy: id })),

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
