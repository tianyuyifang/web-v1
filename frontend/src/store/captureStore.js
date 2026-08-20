import { create } from "zustand";
import { captureAPI } from "@/lib/api";

/**
 * The one capture connection, shared by everything that touches it.
 *
 * Three places care: the nav indicator (is it alive, where is it going), the
 * playlist panel, and 唱卡. They must agree — a panel that thinks it is
 * delivering while the nav says disconnected is worse than either being wrong
 * on its own, and that is what separate per-component state produced.
 *
 * Deliberately holds no pairing code beyond what the server reports. The code
 * is short-lived and single-use, so a copy kept here outlives its usefulness
 * and shows the user something that no longer works.
 */
const useCaptureStore = create((set, get) => ({
  /** Server's view: { sessionId, client, target, playlist, pairCode, ... } or null. */
  connection: null,
  loading: false,
  error: "",

  /** True once a fetch has completed, so "no connection" is distinguishable from "not asked yet". */
  loaded: false,

  refresh: async () => {
    try {
      const res = await captureAPI.connection();
      set({ connection: res.data.connection, loaded: true });
      return res.data.connection;
    } catch {
      // A missed poll says nothing: the connection lives on the server and the
      // next tick will answer. Clearing it here would flash "disconnected"
      // every time the network hiccups.
      set({ loaded: true });
      return get().connection;
    }
  },

  connect: async () => {
    set({ loading: true, error: "" });
    try {
      const res = await captureAPI.connect({});
      // Use the fresh pairing code from this response rather than re-reading
      // it: the connection endpoint hides a code once it expires, and the user
      // needs to see this one immediately.
      set({
        connection: {
          sessionId: res.data.session.id,
          client: "waiting",
          target: res.data.session.target,
          playlist: null,
          pairCode: res.data.pairCode,
          pairExpiresAt: res.data.pairExpiresAt,
          expiresAt: res.data.session.expiresAt,
          lastSeenAt: null,
        },
        loaded: true,
      });
      return true;
    } catch (err) {
      set({ error: err.response?.data?.error?.message || "连接失败" });
      return false;
    } finally {
      set({ loading: false });
    }
  },

  /**
   * Point the connection somewhere, connecting first if needed.
   *
   * The auto-connect is what keeps the old habit working: pressing 自动打标
   * with nothing connected used to show a pairing code, and it still does —
   * the code just now lasts the rest of the game instead of one playlist.
   */
  aim: async (target, playlistId) => {
    set({ error: "" });
    if (!get().connection) {
      const ok = await get().connect();
      if (!ok) return false;
    }
    try {
      const res = await captureAPI.setTarget(target, playlistId);
      set((s) => ({
        connection: {
          ...s.connection,
          target: res.data.session.target,
          playlistId: res.data.session.playlistId,
        },
      }));
      // Pull the playlist name and liveness the server knows about.
      get().refresh();
      return true;
    } catch (err) {
      set({ error: err.response?.data?.error?.message || "切换失败" });
      return false;
    }
  },

  /** Stop delivering, without dropping the connection. */
  stop: async () => get().aim("none"),

  /** Drop the connection entirely; the client must pair again. */
  disconnect: async () => {
    const c = get().connection;
    if (!c) return;
    try {
      await captureAPI.stop(c.sessionId);
    } catch {
      // Already gone server-side is the same outcome as disconnecting.
    }
    set({ connection: null });
  },

  /** Is this playlist the current destination? */
  isAiming: (playlistId) => {
    const c = get().connection;
    if (!c || c.target !== "playlist") return false;
    // The server reports the destination as a nested playlist; the id set
    // optimistically by aim() is the same value before that arrives.
    return (c.playlist?.id || c.playlistId) === playlistId;
  },
}));

export default useCaptureStore;
