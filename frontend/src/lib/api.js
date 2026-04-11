import axios from "axios";
import { getToken, setToken, clearToken } from "./auth";

const api = axios.create({
  baseURL: "/api",
  headers: { "Content-Type": "application/json" },
});

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// --- Silent token refresh ---
// Refreshes the JWT in the background when it has < 1 day until expiry.
// Uses a flag to prevent multiple concurrent refresh calls.
let isRefreshing = false;

function getTokenExp() {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function maybeRefreshToken() {
  if (isRefreshing) return;
  const exp = getTokenExp();
  if (!exp) return;
  const remainingMs = exp - Date.now();
  // Refresh when less than 1 day remains
  if (remainingMs > 24 * 60 * 60 * 1000) return;
  // Don't refresh if already expired by more than 1 hour (let the 401 handler take over)
  if (remainingMs < -60 * 60 * 1000) return;

  isRefreshing = true;
  api.post("/auth/refresh", null, { timeout: 10000 })
    .then((res) => {
      if (res.data?.token) {
        setToken(res.data.token);
      }
    })
    .catch(() => {
      // Refresh failed — do nothing. The existing token will either
      // still work (not expired yet) or trigger a 401 → login redirect.
    })
    .finally(() => {
      isRefreshing = false;
    });
}

// Handle 401 — redirect to login (skip for auth endpoints)
// Also trigger silent refresh check on every successful response.
api.interceptors.response.use(
  (response) => {
    // Check if token needs refreshing after each successful API call
    const url = response.config?.url || "";
    if (!url.includes("/auth/refresh")) {
      maybeRefreshToken();
    }
    return response;
  },
  (error) => {
    const url = error.config?.url || "";
    const isAuthRoute = url.includes("/auth/login") || url.includes("/auth/register") || url.includes("/auth/refresh");

    // Session replaced by another login — clear token and redirect with reason
    if (error.response?.status === 403 && error.response?.data?.error?.code === "SESSION_REPLACED") {
      clearToken();
      if (typeof window !== "undefined") {
        window.location.href = "/login?reason=session_replaced";
      }
      return Promise.reject(error);
    }

    // Expired or invalid token — clear and redirect to login
    if (error.response?.status === 401 && !isAuthRoute) {
      clearToken();
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

// --- Auth ---
export const authAPI = {
  register: (data) => api.post("/auth/register", data),
  login: (data) => api.post("/auth/login", data),
  me: () => api.post("/auth/me"),
  refresh: () => api.post("/auth/refresh"),
  changePassword: (data) => api.put("/auth/password", data),
  changeUsername: (data) => api.put("/auth/username", data),
  updatePreferences: (preferences) => api.put("/auth/preferences", { preferences }),
};

// --- Songs ---
export const songsAPI = {
  search: (params) => api.get("/songs", { params }),
  getById: (id) => api.get(`/songs/${id}`),
  getClips: (id) => api.get(`/songs/${id}/clips`),
};

// --- Clips ---
export const clipsAPI = {
  create: (data) => api.post("/clips", data),
  autoClip: (data) => api.post("/clips/auto", data),
  toggleGlobal: (id) => api.put(`/clips/${id}/toggle-global`),
  delete: (id) => api.delete(`/clips/${id}`),
  getLyrics: (id, version) => api.get(`/clips/${id}/lyrics${version ? `?v=${version}` : ''}`),
};

// --- Playlists ---
export const playlistsAPI = {
  list: (params) => api.get("/playlists", { params }),
  create: (data) => api.post("/playlists", data),
  getById: (id) => api.get(`/playlists/${id}`),
  update: (id, data) => api.put(`/playlists/${id}`, data),
  delete: (id) => api.delete(`/playlists/${id}`),
  importPlaylist: (data) => api.post("/playlists/import", data),
  copy: (id) => api.post(`/playlists/${id}/copy`),

  // Import clips
  importClipsByQQ: (id, qqPlaylistId) =>
    api.post(`/playlists/${id}/import/by-qq`, { qqPlaylistId }),
  importClipsByNetease: (id, neteasePlaylistId) =>
    api.post(`/playlists/${id}/import/by-netease`, { neteasePlaylistId }),
  importClipsByFile: (id, file) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.post(`/playlists/${id}/import/by-file`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },

  // Clips within playlist
  addClip: (id, data) => api.post(`/playlists/${id}/clips`, data),
  removeClip: (id, data) => api.delete(`/playlists/${id}/clips`, { data }),
  reorderClips: (id, data) => api.put(`/playlists/${id}/clips/reorder`, data),
  batchUpdateClips: (id, updates) => api.put(`/playlists/${id}/clips/batch`, { updates }),
  updateClip: (id, clipId, data) =>
    api.put(`/playlists/${id}/clips/${clipId}`, data),
  swapClip: (id, clipId, newClipId) =>
    api.put(`/playlists/${id}/clips/${clipId}/swap`, { newClipId }),

  // Compare
  compareWithQQ: (id, qqPlaylistId) =>
    api.post(`/playlists/${id}/compare/qq`, { qqPlaylistId }),
  compareWithNetease: (id, neteasePlaylistId) =>
    api.post(`/playlists/${id}/compare/netease`, { neteasePlaylistId }),

  // Shares
  getShares: (id) => api.get(`/playlists/${id}/shares`),
  addShare: (id, data) => api.post(`/playlists/${id}/shares`, data),
  removeShare: (id, userId) =>
    api.delete(`/playlists/${id}/shares/${userId}`),

  // Copy permissions
  getCopyPermissions: (id) => api.get(`/playlists/${id}/copy-permissions`),
  addCopyPermission: (id, data) =>
    api.post(`/playlists/${id}/copy-permissions`, data),
  removeCopyPermission: (id, userId) =>
    api.delete(`/playlists/${id}/copy-permissions/${userId}`),
};

// --- Likes ---
export const likesAPI = {
  toggle: (data) => api.post("/likes/toggle", data),
  getAll: (playlistId) => api.get("/likes", { params: playlistId ? { playlistId } : {} }),
  unlikeAll: (playlistId) => api.delete(`/likes/playlist/${playlistId}`),
};

// --- Admin ---
export const adminAPI = {
  listUsers: () => api.get("/admin/users"),
  listPending: () => api.get("/admin/users/pending"),
  approveUser: (id) => api.patch(`/admin/users/${id}/approve`),
  demoteUser: (id) => api.patch(`/admin/users/${id}/demote`),
  deleteUser: (id) => api.delete(`/admin/users/${id}`),
  getBandwidth: (days = 30) => api.get(`/admin/bandwidth?days=${days}`),
};

// --- Feedback ---
export const feedbackAPI = {
  submit: (data) => api.post("/feedback", data),
  list: () => api.get("/feedback"),
  remove: (id) => api.delete(`/feedback/${id}`),
};

// --- Streaming ---
const streamBase = () => {
  const base = "/api";
  const token = typeof window !== "undefined" ? localStorage.getItem("music_app_token") : "";
  return { base, token };
};

export const getStreamUrl = (songId) => {
  const { base, token } = streamBase();
  return `${base}/stream/song/${songId}${token ? `?token=${token}` : ""}`;
};

export const getClipStreamUrl = (clipId, version) => {
  const { base, token } = streamBase();
  const params = [token ? `token=${token}` : "", version ? `v=${version}` : ""].filter(Boolean).join("&");
  return `${base}/stream/clip/${clipId}${params ? `?${params}` : ""}`;
};

export const getLikesSSEUrl = (playlistId) => {
  const { base, token } = streamBase();
  return `${base}/sse/playlists/${playlistId}/likes${token ? `?token=${token}` : ""}`;
};

export default api;
