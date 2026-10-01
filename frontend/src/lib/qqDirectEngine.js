/**
 * The working half of 唱卡's "ask QQ from the singer's own address" (see
 * lib/qqDirect for the switch and the modes). Loaded only once the status poll
 * reports a mode other than `server`, so pages in the default mode never
 * download it.
 *
 *   shadow  -- the server's URL plays, exactly as before. Once the song has
 *              finished downloading (the network is quiet again, so the timing
 *              is fair), the browser asks QQ for the same song too, only to
 *              time it, compare the answer and check the file downloads.
 *   browser -- the browser asks QQ first. If no answer has come within the
 *              time this device usually waits for the server, the server is
 *              asked as well and whichever answers first plays.
 *
 * Never slower than the server path is the rule, so the browser stops trying
 * on its own wherever it is not winning:
 *   - this page, after QQ could not be reached, after two cards where the
 *     browser found no file (or a URL that would not start) but the server
 *     did, or after two races the server won;
 *   - this device, while its own history says QQ answers it slower than the
 *     server does (re-measured now and then, after the sound has started),
 *     or for a day after a URL from QQ failed to play here.
 *
 * Apple's WebKit (every iPhone browser, WeChat on iOS, Safari) lets a fresh
 * audio element start only from the tap itself. Whether the old XHR path and a
 * JSONP answer count the same there could not be tested without a phone, so
 * QQ is asked only when it cannot matter: on an element that has already
 * played (later cards on the page). The first card of a page and
 * quality/vocals switches (which build a new element) stay on the server path
 * on those devices. Shadow mode never plays QQ's own URL and is unaffected.
 *
 * QQ's JSONP answers are scripts, so they run inside a sandboxed iframe (no
 * same-origin): QQ's code can reach nothing of this page -- not its storage,
 * not its login -- and hands back only data, by postMessage.
 *
 * The rule for choosing a file is the server's (lib/qqDirectCore); the answer
 * has the server's shape, so the page cannot tell which path it came from.
 * The account values live in this module's memory only: never in storage,
 * never in a URL of ours, gone when the page goes.
 */
import { qqDirectAPI } from "@/lib/api";
import { getToken } from "@/lib/auth";
import {
  normalise, cdnRequest, parseCdn, detailRequest, parseMediaMid, attemptsFor, vkeyRequest, pick,
} from "@/lib/qqDirectCore";

const ENDPOINT = "https://u.y.qq.com/cgi-bin/musicu.fcg";

// The account values are re-fetched this often while a non-server mode holds,
// and at once whenever QQ says the key has died.
const KEY_TTL_MS = 30 * 60 * 1000;
// A `server` answer to that (no QQ connected, no 唱卡) is asked again after this.
const NO_KEY_RETRY_MS = 5 * 60 * 1000;
// shadow: the measurement waits for the song's own download to finish, at most this long.
const QUIET_WAIT_MS = 15000;
const CDN_TTL_MS = 10 * 60 * 1000;
// Refreshed in the background this long before it expires, off any tap.
const CDN_REFRESH_EARLY_MS = 60 * 1000;
// After a failed warm-up, not tried again in the background for this long.
const CDN_RETRY_MS = 10 * 60 * 1000;
// The server keeps a resolved URL 10 minutes (playbackUrlCache); so does this.
const URL_TTL_MS = 10 * 60 * 1000;
const URL_CACHE_MAX = 200;
// Longest the browser's own request is given. In browser mode the server has
// long since been asked by then; in shadow mode this only bounds a measurement.
const DIRECT_TIMEOUT_MS = 8000;
// The sandbox frame is given this long to come up before a call fails.
const FRAME_READY_MS = 5000;
// Device memory of how long each path takes here.
const SERVER_MS_KEY = "qqDirect.serverMs";
const DIRECT_MS_KEY = "qqDirect.directMs";
const HISTORY_KEEP = 20;
const HISTORY_MIN = 5;
// Same bounds the server accepts for the default (settingsService).
const HEDGE_MIN_MS = 250;
const HEDGE_MAX_MS = 2000;
// After the server has failed, how much longer QQ's own answer is waited for
// before the server's error is shown.
const ERROR_GRACE_MS = 500;
// Page-level give-ups.
const MISSES_BEFORE_STICKY = 2;
const LOSSES_BEFORE_STICKY = 2;
// On a device that goes to the server first, how often QQ is still timed
// (after the sound has started) so the device can change its mind.
const REPROBE_EVERY = 5;
const REPORT_EVERY_MS = 20000;
const REPORT_BATCH = 10;
const REPORT_MAX = 20;
// A device where a URL from QQ would not play skips QQ for this long.
const UNPLAYABLE_KEY = "qqDirect.unplayableUntil";
const UNPLAYABLE_MS = 24 * 3600 * 1000;
// Apple's WebKit: every iOS browser and Safari. Not Chrome/Edge/Android, which
// remember that the page has been interacted with.
const APPLE_WEBKIT = typeof navigator !== "undefined"
  && /AppleWebKit/.test(navigator.userAgent)
  && !/Chrome\/|Chromium\/|Android/.test(navigator.userAgent);

let active = false; // the 唱卡 page is mounted
let currentMode = null; // as last reported by the status poll
let session = null; // { mode, hedgeMs, uin, musicKey, at }
let sessionInflight = null;
let cdn = null; // { hosts, guid, at }
let cdnInflight = null;
let cdnFailedAt = 0;
const urlCache = new Map(); // key -> { data, at, direct }
let sticky = false; // this page has stopped asking QQ directly
let misses = 0; // browser found no file / its URL did not start, server's did
let losses = 0; // consecutive races the server won
let serverFirstTaps = 0;
let queue = [];
let flushTimer = null;
// QQ calls made outside a reported sample (the background CDN warm-up).
let unreportedCalls = 0;

// ---------------------------------------------------------------- helpers

function fail(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  (window.crypto || window.msCrypto).getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- the sandbox

// Runs inside the frame. Accepts only musicu.fcg URLs from its parent, loads
// each as a script with its own callback, and posts back the data or a code.
// A classic script has run by the time `load` fires, so a callback that has
// not happened by then is not coming (an error page, plain JSON).
const FRAME_HTML = `<!doctype html><meta charset="utf-8"><script>
(function () {
  var n = 0;
  addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || typeof d.id !== "string" || typeof d.url !== "string") return;
    if (d.url.indexOf(${JSON.stringify(`${ENDPOINT}?`)}) !== 0) return;
    n += 1;
    var cb = "qqd" + n + "x" + Math.random().toString(36).slice(2, 8);
    var s = document.createElement("script");
    var done = false;
    function reply(m) {
      if (done) return;
      done = true;
      window[cb] = function () {};
      s.onerror = s.onload = null;
      if (s.parentNode) s.parentNode.removeChild(s);
      parent.postMessage(m, "*");
    }
    window[cb] = function (j) {
      reply(j && typeof j === "object" ? { id: d.id, ok: true, json: j } : { id: d.id, ok: false, code: "bad-response" });
    };
    s.onerror = function () { reply({ id: d.id, ok: false, code: "script-error" }); };
    s.onload = function () { reply({ id: d.id, ok: false, code: "bad-response" }); };
    s.src = d.url + "&callback=" + cb + "&jsonpCallback=" + cb;
    document.head.appendChild(s);
  });
})();
</script>`;

let frame = null;
let frameReady = null;
const pending = new Map(); // id -> { resolve, reject, timer }

function onFrameMessage(e) {
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data;
  if (!d || typeof d.id !== "string") return;
  const p = pending.get(d.id);
  if (!p) return; // answered after its timeout
  pending.delete(d.id);
  clearTimeout(p.timer);
  if (d.ok && d.json && typeof d.json === "object") p.resolve(d.json);
  else p.reject(fail(typeof d.code === "string" ? d.code : "bad-response"));
}

function ensureFrame() {
  if (frameReady) return frameReady;
  frameReady = new Promise((resolve, reject) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    f.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    const t = setTimeout(() => reject(fail("script-error")), FRAME_READY_MS);
    f.addEventListener("load", () => { clearTimeout(t); resolve(f); }, { once: true });
    f.srcdoc = FRAME_HTML;
    window.addEventListener("message", onFrameMessage);
    document.body.appendChild(f);
    frame = f;
  }).catch((err) => {
    // Let a later call try again from scratch.
    if (frame) frame.remove();
    frame = null;
    frameReady = null;
    window.removeEventListener("message", onFrameMessage);
    throw err;
  });
  return frameReady;
}

/**
 * One JSONP call to musicu.fcg, made inside the sandbox. Resolves with the
 * parsed object, or rejects with code timeout / script-error / bad-response.
 */
async function jsonp(data, timeoutMs) {
  const f = await ensureFrame();
  return new Promise((resolve, reject) => {
    const id = randomHex(8);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(fail("timeout"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    f.contentWindow.postMessage({
      id,
      url: `${ENDPOINT}?format=jsonp&inCharset=utf8&outCharset=utf-8&data=${encodeURIComponent(JSON.stringify(data))}`,
    }, "*");
  });
}

function usable(s) {
  return !!(s && s.mode !== "server" && s.uin && s.musicKey);
}

// ---------------------------------------------------------------- session

/**
 * The account values (and the server's own view of the mode for this user).
 * Asked for only while the status poll reports a mode other than `server`.
 * Never awaited on a tap: a tap uses whatever is ready.
 */
function loadSession() {
  if (sessionInflight) return sessionInflight;
  sessionInflight = qqDirectAPI.session()
    .then((res) => {
      // Switched to `server` while this was on its way: not kept.
      if (currentMode === "server" || currentMode === null) { session = null; return null; }
      const at = res.data?.mode === "server"
        // No QQ connected, or no 唱卡: asked again in a few minutes, not every poll.
        ? Date.now() - KEY_TTL_MS + NO_KEY_RETRY_MS
        : Date.now();
      session = { ...res.data, at };
      return session;
    })
    // Unreachable: behave as `server`, and ask again a minute from now.
    .catch(() => { session = { mode: "server", at: Date.now() - KEY_TTL_MS + 60 * 1000 }; return session; })
    .finally(() => { sessionInflight = null; });
  return sessionInflight;
}

/**
 * The CDN hosts, in the background: once the account values are in, again
 * shortly before they expire (so a tap never waits for them), and not again for
 * a while after a failure.
 */
function warmCdn(s) {
  if (!active || !usable(s) || currentMode === "server" || currentMode === null) return;
  if (cdn && Date.now() - cdn.at < CDN_TTL_MS - CDN_REFRESH_EARLY_MS) return;
  if (cdnFailedAt && Date.now() - cdnFailedAt < CDN_RETRY_MS) return;
  const count = { calls: 0 };
  cdnHosts(s, count, true)
    .then(() => { cdnFailedAt = 0; })
    .catch(() => { cdnFailedAt = Date.now(); })
    .finally(() => {
      unreportedCalls += count.calls;
      if (count.calls && !flushTimer) flushTimer = setTimeout(flush, REPORT_EVERY_MS);
    });
}

/** The CDN hosts, asked from this device so QQ picks hosts near it. */
async function cdnHosts(s, count, refresh = false) {
  if (!refresh && cdn && Date.now() - cdn.at < CDN_TTL_MS) return cdn;
  if (cdnInflight) return cdnInflight;
  cdnInflight = (async () => {
    const guid = randomHex(16);
    if (count) count.calls += 1;
    const hosts = parseCdn(await jsonp(cdnRequest(s, guid), DIRECT_TIMEOUT_MS));
    if (!hosts.length) throw fail("no-cdn");
    cdn = { hosts, guid, at: Date.now() };
    return cdn;
  })();
  try {
    return await cdnInflight;
  } finally {
    cdnInflight = null;
  }
}

// ---------------------------------------------------------------- resolve

function cacheKey(mid, o) {
  return `${mid}#${o.tier}${o.vocalsOnly ? ":v" : ""}`;
}

/**
 * Ask QQ directly. Resolves with the server-shaped answer (data.url null when
 * QQ had no file). Rejects with a coded error when QQ could not be asked or
 * answered something that is not an answer. `count.calls` counts every JSONP
 * call made, whichever way it ends.
 */
async function askQq(mid, o, s, count) {
  const host = await cdnHosts(s, count);

  let mediaMid = null;
  if (o.vocalsOnly) {
    count.calls += 1;
    mediaMid = parseMediaMid(await jsonp(detailRequest(mid), DIRECT_TIMEOUT_MS));
    // A refusal here is the server's error, not "this song has no stem".
    if (mediaMid === undefined) throw fail("bad-response");
  }

  const attempts = attemptsFor(mid, o, mediaMid);
  count.calls += 1;
  const json = await jsonp(vkeyRequest(s, mid, attempts, host.guid), DIRECT_TIMEOUT_MS);
  const data = pick(json, attempts, o, host.hosts[0]);
  if (!data) throw fail("bad-response");
  return data;
}

/** Do the first bytes of this URL actually download here? (shadow measurements only) */
async function downloads(url) {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-15" }, mode: "cors", cache: "no-store", signal: ctl?.signal });
    if (r.status !== 200 && r.status !== 206) return false;
    // One chunk is the answer. A CDN that ignores Range would otherwise send
    // the whole song, on the singer's connection, while they sing.
    if (!r.body?.getReader) return true;
    const reader = r.body.getReader();
    const first = await reader.read();
    reader.cancel().catch(() => {});
    return !!(first.value && first.value.byteLength > 0);
  } catch {
    return false;
  } finally {
    try { ctl?.abort(); } catch { /* already done */ }
  }
}

// ---------------------------------------------------------------- device memory

function readHistory(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "number" && x > 0) : [];
  } catch {
    return [];
  }
}

function note(key, ms) {
  if (!(ms > 0)) return;
  try {
    const v = readHistory(key);
    v.push(Math.round(ms));
    localStorage.setItem(key, JSON.stringify(v.slice(-HISTORY_KEEP)));
  } catch { /* a private window: defaults are used */ }
}

function median(v) {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

/** How long to give QQ before also asking the server: what the server usually takes here. */
function hedgeMs(fallback) {
  const v = readHistory(SERVER_MS_KEY);
  const base = v.length >= HISTORY_MIN ? median(v) : fallback;
  return Math.min(HEDGE_MAX_MS, Math.max(HEDGE_MIN_MS, base || 500));
}

function markUnplayable() {
  try { localStorage.setItem(UNPLAYABLE_KEY, String(Date.now() + UNPLAYABLE_MS)); } catch { /* best effort */ }
}

function unplayableHere() {
  try { return Number(localStorage.getItem(UNPLAYABLE_KEY) || 0) > Date.now(); } catch { return false; }
}

/** This device's own record says QQ answers it slower than the server does, or its URLs do not play here. */
function deviceSaysServer() {
  if (unplayableHere()) return true;
  const sv = readHistory(SERVER_MS_KEY);
  const dv = readHistory(DIRECT_MS_KEY);
  if (sv.length < HISTORY_MIN || dv.length < HISTORY_MIN) return false;
  return median(dv) > median(sv);
}

// ---------------------------------------------------------------- reporting

function send(batch, extra, keepalive) {
  if (!keepalive) {
    qqDirectAPI.report(batch, extra);
    return;
  }
  // Leaving the page: a request that survives the page going away.
  try {
    const token = getToken();
    fetch("/api/qq-direct/report", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ samples: batch, calls: extra }),
    }).catch(() => {});
  } catch { /* evidence only */ }
}

function flush(keepalive = false) {
  clearTimeout(flushTimer);
  flushTimer = null;
  while (queue.length || unreportedCalls) {
    const batch = queue.slice(0, REPORT_MAX);
    queue = queue.slice(REPORT_MAX);
    const extra = unreportedCalls;
    unreportedCalls = 0;
    send(batch, extra, keepalive);
  }
}

function report(sample) {
  queue.push(sample);
  if (queue.length >= REPORT_BATCH) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, REPORT_EVERY_MS);
}

function onVisibility() {
  if (document.visibilityState === "hidden") flush(true);
}

// ---------------------------------------------------------------- lifecycle (from lib/qqDirect)

/** The 唱卡 page mounted: a fresh page starts with QQ allowed again. */
export function activate() {
  if (active) return;
  active = true;
  sticky = false;
  misses = 0;
  losses = 0;
  document.addEventListener("visibilitychange", onVisibility);
}

/** The 唱卡 page went away: quiet, and hand in what was measured. */
export function deactivate() {
  if (!active) return;
  active = false;
  document.removeEventListener("visibilitychange", onVisibility);
  flush();
}

/**
 * The mode from the page's status poll. `server` drops the account values;
 * any other fetches them when missing, old, or answered for another mode.
 */
export function noteMode(next) {
  currentMode = next;
  if (next === "server") {
    session = null;
    return;
  }
  if (!active) return;
  // A `server` answer (no QQ connected, no 唱卡) is not re-asked every 15 s:
  // loadSession dates it so that it falls due in a few minutes.
  const old = !session || Date.now() - session.at >= KEY_TTL_MS;
  const stale = old || (session.mode !== next && session.mode !== "server");
  if (stale) loadSession().then(warmCdn);
  else warmCdn(session);
}

/**
 * A play URL in a non-server mode (lib/qqDirect has already checked the mode is
 * fresh). Falls through to the server path whenever the account values for
 * this mode are not in hand. See lib/qqDirect resolve() for the contract.
 */
export function resolve(mapping, opts, askServer, ctx, mode) {
  const s = session;
  if (!usable(s) || s.mode !== mode) return askServer();
  const mid = String(mapping.externalId);
  const o = normalise(opts);
  if (mode === "shadow") return shadowMode(mid, o, s, askServer);
  return browserMode(mid, o, s, askServer, ctx || {});
}

/** Run `fn` once `quiet()` says so, or after QUIET_WAIT_MS, whichever first. */
function whenQuiet(quiet, fn) {
  const t0 = Date.now();
  const check = () => {
    if (!active) return;
    let ready = false;
    try { ready = !quiet || quiet(); } catch { ready = true; }
    if (ready || Date.now() - t0 >= QUIET_WAIT_MS) fn();
    else setTimeout(check, 250);
  };
  check();
}

/** Time QQ for a song whose server answer is already playing; check the file downloads. */
function measure(mid, o, s, serverData, serverMs, mode, reprobe = false) {
  const base = {
    mode,
    reprobe,
    tier: o.tier,
    vocals: o.vocalsOnly,
    serverMs: serverData?.cached ? null : Math.round(serverMs),
    serverOk: !!serverData?.url,
    serverTier: serverData?.playedTier || null,
    serverVocals: serverData?.url ? !!serverData.vocalsPlayed : null,
  };
  // A server answer from its own cache is not a fair race, and asking QQ again
  // for a song just resolved only adds a request. Recorded, not repeated.
  if (serverData?.cached) {
    report({ ...base, directReason: "skipped", calls: 0 });
    return;
  }
  const t0 = now();
  const count = { calls: 0 };
  askQq(mid, o, s, count)
    .then(async (data) => {
      const directMs = now() - t0;
      if (data.url) note(DIRECT_MS_KEY, directMs);
      // The server has just used the account successfully: a dead key here is
      // the browser's copy being old.
      if (data.reason === "credential-expired") loadSession();
      const both = !!(data.url && serverData?.url);
      const playable = data.url ? await downloads(data.url) : null;
      let host = null;
      try { host = data.url ? new URL(data.url).hostname : null; } catch { /* left null */ }
      report({
        ...base,
        directReason: data.url ? "ok" : data.reason || "unavailable",
        directMs: Math.round(directMs),
        directTier: data.playedTier,
        directVocals: data.url ? data.vocalsPlayed : null,
        match: both ? data.playedTier === serverData.playedTier && data.vocalsPlayed === !!serverData.vocalsPlayed : null,
        directPlayable: playable,
        directHost: host,
        calls: count.calls,
      });
      // The device was sent to the server because QQ's URLs would not play;
      // they play again, so it may try QQ again.
      if (playable === true && reprobe) { try { localStorage.removeItem(UNPLAYABLE_KEY); } catch { /* fine */ } }
    })
    .catch((err) => {
      report({ ...base, directReason: err?.code || "bad-response", directMs: Math.round(now() - t0), calls: count.calls });
    });
}

async function timedServer(askServer) {
  const t0 = now();
  const res = await askServer();
  const ms = now() - t0;
  if (!res?.data?.cached) note(SERVER_MS_KEY, ms);
  return { res, ms };
}

/** shadow: the server's answer plays; QQ is timed once the song has downloaded. */
async function shadowMode(mid, o, s, askServer) {
  const { res, ms } = await timedServer(askServer);
  res.afterPlay = (quiet) => whenQuiet(quiet, () => measure(mid, o, s, res.data, ms, "shadow"));
  return res;
}

function remember(key, data, direct) {
  // An answer the server itself served from its cache may already be minutes
  // old; keeping it another ten could outlive the URL.
  if (!data?.url || data.cached) return;
  urlCache.delete(key);
  urlCache.set(key, { data, at: Date.now(), direct });
  while (urlCache.size > URL_CACHE_MAX) urlCache.delete(urlCache.keys().next().value);
}

/** browser: QQ first, the server alongside once this device's usual wait has passed. */
function browserMode(mid, o, s, askServer, ctx) {
  const key = cacheKey(mid, o);
  const base = { mode: "browser", tier: o.tier, vocals: o.vocalsOnly };
  // Apple's WebKit with an element that has never played: QQ's URL must not be
  // what it starts with (see the header) -- cached or fresh.
  const gestureBlocked = APPLE_WEBKIT && !ctx.elementHasPlayed;

  const fromServer = (res, extra) => {
    remember(key, res?.data, false);
    report({ ...base, winner: "server", serverOk: !!res?.data?.url, ...extra });
    return res;
  };
  // A URL from QQ that did not play: the server's instead. A real playback
  // error means QQ's CDN does not work from here, so this page stops asking QQ
  // and the device skips it for a day; a URL that was merely slow to start is
  // one miss, like a card QQ had no file for.
  const serverInstead = async (why = "error") => {
    urlCache.delete(key);
    if (why === "error") {
      sticky = true;
      cdn = null;
      markUnplayable();
    } else {
      misses += 1;
      if (misses >= MISSES_BEFORE_STICKY) sticky = true;
    }
    const { res, ms } = await timedServer(askServer);
    return fromServer(res, { directReason: "unplayable", playFailed: true, serverMs: Math.round(ms), waitMs: Math.round(ms) });
  };

  const hit = urlCache.get(key);
  if (hit && Date.now() - hit.at < URL_TTL_MS && !(hit.direct && gestureBlocked)) {
    report({ ...base, winner: "cache", waitMs: 0, directReason: "skipped", calls: 0 });
    const res = { data: { ...hit.data, cached: true } };
    if (hit.direct) res.serverInstead = serverInstead;
    return Promise.resolve(res);
  }

  // Not trying QQ here: the page has given up, this device is faster via the
  // server, or (Apple's WebKit) the element has never played.
  const skip = sticky ? "page"
    : deviceSaysServer() ? "device"
      : gestureBlocked ? "gesture" : null;
  if (skip) {
    return timedServer(askServer).then(({ res, ms }) => {
      fromServer(res, { directReason: "skipped", skippedFor: skip, serverMs: Math.round(ms), waitMs: Math.round(ms) });
      // Now and then, once the song has downloaded, see whether QQ got faster.
      if (skip === "device") {
        serverFirstTaps += 1;
        // Recorded as a (re-probe) shadow measurement: the tap itself has
        // already been counted above.
        if (serverFirstTaps % REPROBE_EVERY === 0) res.afterPlay = (quiet) => whenQuiet(quiet, () => measure(mid, o, s, res.data, ms, "shadow", true));
      }
      return res;
    });
  }

  const t0 = now();
  const sample = { ...base, hedged: false, calls: 0 };
  const count = { calls: 0 };

  return new Promise((resolvePlay, rejectPlay) => {
    let settled = false;
    let serverStarted = false;
    let serverError = null;
    let serverAnswered = null; // the server's response once it is in
    let directOver = false;
    let serverOver = false;
    let reported = false;
    let refreshAfterServer = false;

    const done = () => {
      if (reported || !(directOver && (serverOver || !serverStarted))) return;
      reported = true;
      sample.calls = count.calls;
      // Pages give up where they are not winning.
      if (sample.winner === "server" && sample.hedged) losses += 1;
      else if (sample.winner === "direct") losses = 0;
      if (losses >= LOSSES_BEFORE_STICKY) sticky = true;
      report(sample);
    };
    const settle = (fn, value, winner) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sample.winner = winner;
      sample.waitMs = Math.round(now() - t0);
      fn(value);
    };

    const startServer = () => {
      if (serverStarted || settled) return;
      serverStarted = true;
      sample.hedged = !directOver;
      timedServer(askServer)
        .then(({ res, ms }) => {
          sample.serverMs = Math.round(ms);
          sample.serverOk = !!res?.data?.url;
          remember(key, res?.data, false);
          serverOver = true;
          serverAnswered = res;
          // The browser had no file where the server found one: a second time
          // and this page stops asking QQ (a region-locked address, a dead key).
          if (directOver && sample.directReason !== "ok" && res?.data?.url) {
            misses += 1;
            if (misses >= MISSES_BEFORE_STICKY) sticky = true;
          }
          // A dead key: the server has just renewed it, so now is when a fresh
          // one can be fetched without racing that renewal.
          if (refreshAfterServer) loadSession();
          settle(resolvePlay, res, "server");
          done();
        })
        .catch((err) => {
          serverOver = true;
          serverError = err;
          sample.serverOk = false;
          // QQ's own answer may still come, but a failure must not be much
          // slower than it was: a short grace, then the server's error shows.
          if (directOver) settle(rejectPlay, err, "none");
          else setTimeout(() => settle(rejectPlay, err, "none"), ERROR_GRACE_MS);
          done();
        });
    };

    const timer = setTimeout(startServer, hedgeMs(s.hedgeMs));

    askQq(mid, o, s, count)
      .then((data) => {
        directOver = true;
        sample.directMs = Math.round(now() - t0);
        sample.directReason = data.url ? "ok" : data.reason || "unavailable";
        if (data.url) {
          note(DIRECT_MS_KEY, now() - t0);
          sample.directTier = data.playedTier;
          sample.directVocals = data.vocalsPlayed;
          remember(key, data, true);
          settle(resolvePlay, { data, serverInstead }, "direct");
        } else {
          // No file: the server decides, as it always has -- it renews a dead
          // key, and its message is the one the page knows how to show.
          if (data.reason === "credential-expired") {
            if (serverOver) loadSession();
            else refreshAfterServer = true;
          }
          if (serverError) settle(rejectPlay, serverError, "none");
          else if (serverAnswered) settle(resolvePlay, serverAnswered, "server");
          else startServer();
        }
        done();
      })
      .catch((err) => {
        directOver = true;
        sample.directMs = Math.round(now() - t0);
        sample.directReason = err?.code || "bad-response";
        // QQ could not be reached from here: stop trying on this page.
        sticky = true;
        if (serverError) settle(rejectPlay, serverError, "none");
        else if (serverAnswered) settle(resolvePlay, serverAnswered, "server");
        else startServer();
        done();
      });
  });
}
