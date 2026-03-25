import { create } from "zustand";
import { authAPI } from "@/lib/api";
import { getToken, setToken, clearToken } from "@/lib/auth";

const useAuthStore = create((set) => ({
  user: null,
  loading: true,

  // Called once on app boot (in Navbar) to restore session from stored token
  init: async () => {
    const token = getToken();
    if (!token) {
      set({ loading: false });
      return;
    }
    try {
      const res = await authAPI.me();
      set({ user: res.data.user, loading: false });
    } catch {
      clearToken();
      set({ user: null, loading: false });
    }
  },

  login: async (username, password) => {
    const res = await authAPI.login({ username, password });
    setToken(res.data.token);
    set({ user: res.data.user });
    return res.data;
  },

  logout: () => {
    clearToken();
    set({ user: null });
  },

  updatePreferences: async (preferences) => {
    const res = await authAPI.updatePreferences(preferences);
    set((state) => ({ user: { ...state.user, preferences: res.data.user.preferences } }));
    return res.data.user.preferences;
  },
}));

export default useAuthStore;
