/**
 * A play URL that came from this server, would not load in the browser:
 * ask the server once for a fresh one.
 *
 * The server caches successful resolves for ~10 minutes, and before this every
 * retry inside that window was handed the same dead URL back -- the song stayed
 * unplayable until the user rescanned their music account (which only helped
 * because saving a credential happens to clear the cache). 2026-10-11, NetEase.
 *
 * Only for URLs from this server. A URL QQ gave the browser directly carries
 * res.onPlayFail and has its own retry, which never asks the server; callers
 * must check that first, so 网站 IP plays stay 网站 IP and 用户 IP plays stay
 * 用户 IP. The server answers `fresh` at most once a minute per track; inside
 * that window it returns the cached URL again, which is treated as "no new
 * answer" here.
 *
 * Every outcome is reported to /capture/perf (kinds `loadfail` / `loadretry`),
 * so the next time a URL dies we know whether it was the CDN, an expired link
 * or the network rather than guessing.
 */
import { captureAPI, mappingAPI } from "@/lib/api";

const report = (fields) => {
  try { captureAPI.perf(fields); } catch { /* a measurement is never worth a failed play */ }
};

/**
 * @param mapping   the card's mapping ({ mappingId, source })
 * @param opts      what was asked for ({ tier, vocalsOnly })
 * @param res       the response whose URL failed (axios shape)
 * @param stage     "open" | "swap"
 * @param fail      "error" | "timeout" | "notallowed"
 * @param mediaErr  MediaError code 1-4, or null
 * @returns a response with a NEW url to try; { error } when the server refused
 *   with a message worth showing (throw it); or null (nothing better to try)
 */
export async function refetchAfterFail({ mapping, opts, res, stage, fail, mediaErr }) {
  const base = {
    kind: "loadfail",
    stage,
    fail,
    mediaErr: Number.isInteger(mediaErr) ? mediaErr : null,
    cached: res?.data?.cached === true,
    source: mapping?.source,
    tier: opts?.tier,
    vocalsOnly: opts?.vocalsOnly ? 1 : 0,
  };
  // Autoplay refused: a new URL would be refused the same way.
  if (fail === "notallowed" || !mapping?.mappingId) {
    report({ ...base, retry: "none" });
    return null;
  }
  let again;
  try {
    again = await mappingAPI.preview(mapping.mappingId, undefined, { ...opts, fresh: true });
  } catch (err) {
    report({ ...base, retry: "error" });
    // The server said why (an expired account connection, say: "请到账号页重新
    // 扫码"): that is the likeliest real cause, so the caller shows it rather
    // than its generic failure -- once it has checked the card is still the
    // one open. Anything else ends as it always did.
    return err?.response?.data?.error?.message ? { error: err } : null;
  }
  const url = again?.data?.url;
  if (!url) { report({ ...base, retry: "nourl" }); return null; }
  // The server declined (asked again within a minute) and sent the cached one.
  if (again.data.refreshed !== true) { report({ ...base, retry: "limited" }); return null; }
  if (url === res?.data?.url) { report({ ...base, retry: "same" }); return null; }
  report({ ...base, retry: "sent" });
  return again;
}

/** How the fresh URL fared, once the caller has tried it. */
export function reportRetry({ mapping, opts, stage, ok }) {
  report({
    kind: "loadretry",
    stage,
    retry: ok ? "ok" : "fail",
    source: mapping?.source,
    tier: opts?.tier,
    vocalsOnly: opts?.vocalsOnly ? 1 : 0,
  });
}
