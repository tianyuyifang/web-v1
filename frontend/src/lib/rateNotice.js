// The server refuses a kind of request for a while once an account has asked
// for far more than anyone uses (429, code RATE_LIMITED). Whatever met the
// refusal calls this; RateLimitNotice shows one line so it does not look like
// the site is broken.
export const RATE_LIMITED_EVENT = "qni:rate-limited";

export function notifyRateLimited() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(RATE_LIMITED_EVENT));
}
