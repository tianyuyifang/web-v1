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
  copy: (id) => api.post(`/playlists/${id}/copy`),

  // Import clips
  importClipsByQQ: (id, qqPlaylistId) =>
    api.post(`/playlists/${id}/import/by-qq`, { qqPlaylistId }),
  importClipsByNetease: (id, neteasePlaylistId) =>
    api.post(`/playlists/${id}/import/by-netease`, { neteasePlaylistId }),
  importClipsByKugou: (id, kugouPlaylistId) =>
    api.post(`/playlists/${id}/import/by-kugou`, { kugouPlaylistId }),
  importClipsByInternal: (id, targetPlaylistId) =>
    api.post(`/playlists/${id}/import/by-internal`, { targetPlaylistId }),
  importClipsByFile: (id, file) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.post(`/playlists/${id}/import/by-file`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
  // Poll the status of an async import job (returns { state, progress, result, error }).
  getImportJob: (id, jobId) => api.get(`/playlists/${id}/import/jobs/${jobId}`),

  // Clips within playlist
  addClip: (id, data) => api.post(`/playlists/${id}/clips`, data),
  removeClip: (id, data) => api.delete(`/playlists/${id}/clips`, { data }),
  batchRemoveClips: (id, clipIds) => api.delete(`/playlists/${id}/clips/batch`, { data: { clipIds } }),
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
  compareWithKugou: (id, kugouPlaylistId) =>
    api.post(`/playlists/${id}/compare/kugou`, { kugouPlaylistId }),
  compareWithInternal: (id, targetPlaylistId) =>
    api.post(`/playlists/${id}/compare/internal`, { targetPlaylistId }),

  // Diff
  diff: (aId, bId) => api.get(`/playlists/diff`, { params: { a: aId, b: bId } }),

  // Merge
  merge: (aId, bId, options) => api.post(`/playlists/merge`, { aId, bId, options }),

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

  // Batch share
  getBatchShareStatus: (userId) =>
    api.get("/playlists/batch-share-status", { params: { userId } }),
  batchShare: (data) => api.post("/playlists/batch-share", data),
};

// --- Likes ---
export const likesAPI = {
  toggle: (data) => api.post("/likes/toggle", data),
  getAll: (playlistId) => api.get("/likes", { params: playlistId ? { playlistId } : {} }),
  unlikeAll: (playlistId) => api.delete(`/likes/playlist/${playlistId}`),
};

// --- Screen capture ---
export const captureAPI = {
  start: (playlistId, opts = {}) => api.post("/capture/sessions", { playlistId, ...opts }),
  stop: (sessionId) => api.delete(`/capture/sessions/${sessionId}`),
  status: (sessionId) => api.get(`/capture/sessions/${sessionId}/status`),
  report: (sessionId) => api.get(`/capture/sessions/${sessionId}/report`),
  approve: (eventId, clipId) => api.post(`/capture/events/${eventId}/approve`, clipId ? { clipId } : {}),
  ignore: (eventId) => api.post(`/capture/events/${eventId}/ignore`),
  version: () => api.get("/capture/version"),
  // A live (唱卡) run names no playlist: titles are resolved against the
  // mapping table instead of matched against a list's clips.
  startLive: (opts = {}) => api.post("/capture/sessions", { mode: "live", ...opts }),
  // Open a connection with no destination. The pairing code it returns lasts
  // the whole game — changing destination moves the target, not the token.
  connect: (opts = {}) => api.post("/capture/connect", opts),
  // The current connection, or null. Polled by the nav indicator.
  connection: () => api.get("/capture/connection"),
  // Point the open connection at a playlist, at 唱卡, or at nothing.
  setTarget: (target, playlistId) =>
    api.patch("/capture/target", playlistId ? { target, playlistId } : { target }),
  liveFeed: (sessionId, limit) =>
    api.get(`/capture/sessions/${sessionId}/live${limit ? `?limit=${limit}` : ""}`),
};

// --- Admin ---
export const adminAPI = {
  listUsers: () => api.get("/admin/users"),
  listPending: () => api.get("/admin/users/pending"),
  approveUser: (id) => api.patch(`/admin/users/${id}/approve`),
  makeGuest: (id) => api.patch(`/admin/users/${id}/guest`),
  demoteUser: (id) => api.patch(`/admin/users/${id}/demote`),
  deleteUser: (id) => api.delete(`/admin/users/${id}`),
  listUserPlaylists: (id) => api.get(`/admin/users/${id}/playlists`),
  getBandwidth: (days = 30) => api.get(`/admin/bandwidth?days=${days}`),
  updateBilling: (id, data) => api.patch(`/admin/users/${id}/billing`, data),
  extendOneMonth: (id) => api.post(`/admin/users/${id}/extend`),
  resetPassword: (id) => api.post(`/admin/users/${id}/reset-password`),
  getSignupPromo: () => api.get("/admin/signup-promo"),
  setSignupPromo: (data) => api.put("/admin/signup-promo", data),
};

// --- Feedback ---
export const feedbackAPI = {
  submit: (data) => api.post("/feedback", data),
  list: () => api.get("/feedback"),
  remove: (id) => api.delete(`/feedback/${id}`),
};

// --- Updates / announcements ---
export const updatesAPI = {
  list: () => api.get("/updates"),
  getHighlighted: () => api.get("/updates/highlighted"),
  create: (data) => api.post("/updates", data),
  edit: (id, data) => api.patch(`/updates/${id}`, data),
  remove: (id) => api.delete(`/updates/${id}`),
  toggleHighlight: (id) => api.post(`/updates/${id}/highlight`),
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

// A user's own QQ / NetEase credentials. Reads report connection state only —
// a stored cookie is never sent back to the browser.
export const musicSourcesAPI = {
  list: () => api.get("/music-sources"),
  get: (platform) => api.get(`/music-sources/${platform}`),
  save: (platform, cookie) => api.put(`/music-sources/${platform}`, { cookie }),
  clear: (platform) => api.delete(`/music-sources/${platform}`),
  // QR login. Polling is a long poll: "waiting" is the normal answer and the
  // caller simply asks again.
  // provider picks which QR to show: "wechat" or "qq". It must stay the same
  // across create and poll, because the identifier is issued by that provider
  // and means nothing to the other.
  createQr: (provider = "wechat") =>
    api.post(`/music-sources/qq/qrcode?provider=${provider}`),
  pollQr: (uuid, provider = "wechat") =>
    api.get(`/music-sources/qq/qrcode/${encodeURIComponent(uuid)}?provider=${provider}`),
  // Only works for a scanned connection; a pasted one has no refresh key and
  // is answered with a 400 that says so.
  refresh: () => api.post("/music-sources/qq/refresh"),
};

// Song mappings. NOT uniformly admin-only, despite what the review page might
// suggest: `candidates`, `preview` and `lyrics` answer any approved member,
// because 唱卡 needs them to play a song and offer other recordings of it.
// Everything else 403s for a non-editor. Check the route file before assuming
// a call here is safe to make from a page ordinary members can reach.
export const mappingAPI = {
  counts: () => api.get("/mappings/counts"),
  list: ({ bucket = "pending", q = "", cursor = null, take = 50 } = {}) => {
    const params = new URLSearchParams({ bucket, take: String(take) });
    if (q) params.set("q", q);
    if (cursor) params.set("cursor", cursor);
    return api.get(`/mappings?${params}`);
  },
  get: (id) => api.get(`/mappings/${id}`),
  candidates: (id) => api.get(`/mappings/${id}/candidates`),
  // Resolves through the reviewer's own credential; the browser then fetches
  // the audio from the CDN directly.
  // An optional {source, externalId} names a different track, so a reviewer can
  // hear an alternative before approving it. The server checks the pair against
  // the imported pool rather than resolving whatever it is handed.
  preview: (id, override) => api.get(
    `/mappings/${id}/preview${override
      ? `?source=${encodeURIComponent(override.source)}&externalId=${encodeURIComponent(override.externalId)}`
      : ""}`
  ),
  // Public on both platforms, so this answers even for a track the reviewer
  // cannot play — knowing the words is often how a cover is spotted.
  // Takes the same optional {source, externalId} as preview: while an
  // alternative is being auditioned the words must be that recording's, not
  // the one the mapping still points at.
  lyrics: (id, override) => api.get(
    `/mappings/${id}/lyrics${override
      ? `?source=${encodeURIComponent(override.source)}&externalId=${encodeURIComponent(override.externalId)}`
      : ""}`
  ),
  trackLyrics: (trackId) => api.get(`/mappings/track/${trackId}/lyrics`),
  // Same thing for a pool track nobody has claimed yet — you have to hear it
  // before you can say it is the right one.
  previewTrack: (trackId) => api.get(`/mappings/track/${trackId}/preview`),
  create: (body) => api.post("/mappings", body),
  approve: (id, body = {}) => api.post(`/mappings/${id}/approve`, body),
  unapprove: (id) => api.post(`/mappings/${id}/unapprove`),
  remove: (id) => api.delete(`/mappings/${id}`),
  // What "不是这首" would destroy — asked before the confirmation is shown,
  // because deleting a pool track takes every mapping that names it.
  rejectImpact: (id) => api.get(`/mappings/${id}/reject-impact`),
  reject: (id, body = {}) => api.post(`/mappings/${id}/reject`, body),

  // 未配置 — songs the game showed that nothing answers. Recomputed on every
  // read, so the numbers move as the catalogue and the artist list change.
  unconfigured: (q = "") => api.get(`/mappings/unconfigured${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  // Runs the queue back through the resolver the game itself uses.
  reresolve: () => api.post("/mappings/unconfigured/reresolve"),
  // The catalogue by eye, for titles no key can match across platforms.
  poolSearch: (q) => api.get(`/mappings/unconfigured/search?q=${encodeURIComponent(q)}`),
  configure: (body) => api.post("/mappings/unconfigured/configure", body),
  // The 曲库没有 rows as a spreadsheet. Fetched as a blob through the client
  // rather than opened as a link, because the route needs the auth header and
  // a plain <a href> cannot send one.
  absentXlsx: () => api.get("/mappings/unconfigured/absent.xlsx", { responseType: "blob" }),
  forget: (rawText) => api.post("/mappings/unconfigured/forget", { rawText }),

  // The list that decides whether a "-" belongs to a name or to the split.
  dashedArtists: () => api.get("/mappings/dashed-artists"),
  addDashedArtist: (body) => api.post("/mappings/dashed-artists", body),
  removeDashedArtist: (id) => api.delete(`/mappings/dashed-artists/${id}`),
};

/**
 * Stream for a live run. Separate from the playlist stream because a live
 * session has no playlist to key on — the server keys these by user.
 */
export const getLiveSSEUrl = (sessionId) => {
  const { base, token } = streamBase();
  return `${base}/sse/capture/live/${sessionId}${token ? `?token=${token}` : ""}`;
};

export const getLikesSSEUrl = (playlistId) => {
  const { base, token } = streamBase();
  return `${base}/sse/playlists/${playlistId}/likes${token ? `?token=${token}` : ""}`;
};

export default api;
