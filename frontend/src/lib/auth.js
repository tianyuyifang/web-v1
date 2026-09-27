const TOKEN_KEY = "music_app_token";

export function getToken() {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // localStorage unavailable (private browsing)
  }
  document.cookie = `${TOKEN_KEY}=${token}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage unavailable
  }
  document.cookie = `${TOKEN_KEY}=; path=/; max-age=0`;
}

// The token's claims (exp, role, ...), or null when there is none or it can't
// be read. The payload is base64url, and atob takes standard base64 only: it
// throws on "-" and "_", which some usernames put in the payload (小芳 always
// does). Read ASCII claims only — atob returns raw bytes, so a non-ASCII
// username comes back garbled.
export function getTokenPayload() {
  const token = getToken();
  if (!token) return null;
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

export function isAuthenticated() {
  return !!getToken();
}
