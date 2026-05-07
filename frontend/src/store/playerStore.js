import { create } from "zustand";

const AUTOPLAY_KEY = "music_app_autoplay";

const readAutoPlay = () => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AUTOPLAY_KEY) === "true";
  } catch {
    return false;
  }
};

const writeAutoPlay = (v) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTOPLAY_KEY, v ? "true" : "false");
  } catch {
    // ignore quota / private-mode errors
  }
};

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

  // Admin auto-play mode — persisted in localStorage
  autoPlayEnabled: readAutoPlay(),
  setAutoPlayEnabled: (v) => {
    writeAutoPlay(v);
    set({ autoPlayEnabled: !!v });
  },
}));

export default usePlayerStore;
