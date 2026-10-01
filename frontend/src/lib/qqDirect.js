/**
 * 唱卡: who asks QQ for a play URL -- this server (as always), or the singer's
 * own browser, from the singer's own address.
 *
 * The server has always resolved QQ play URLs, which means every card anyone
 * opens is a request to QQ from this one server, carrying that user's account.
 * QQ's musicu.fcg answers JSONP and accepts the account in the request body
 * (measured 2026-09-30), so the browser can ask instead.
 *
 * Decided in 档位设置 (settingsService QQ_DIRECT_KEY): `server` (the default),
 * `shadow` or `browser` -- see lib/qqDirectEngine for the last two. The mode
 * arrives on the 唱卡 page's own 15-second status poll (noteMode), so this
 * costs no request of its own.
 *
 * This file is all a page in `server` mode ever runs, and it is deliberately
 * nothing but the switch: resolve() then calls the server exactly as before,
 * synchronously and with nothing in between. The engine, with everything the
 * other modes need, is downloaded only when the status poll first reports one
 * of them.
 */

// A mode not confirmed by a status poll for this long is not trusted on a tap
// (a page frozen in the background): that tap takes the server path.
const MODE_STALE_MS = 60 * 1000;
// A URL that came from QQ directly and has not started playing within this is
// given up on (the page then takes serverInstead).
const DIRECT_START_MS = 4000;

let mode = null; // as last reported by the status poll
let modeAt = 0;
let active = false; // the 唱卡 page is mounted
let engine = null;
let engineLoading = null;

function loadEngine() {
  if (engine) return Promise.resolve(engine);
  if (!engineLoading) {
    engineLoading = import("@/lib/qqDirectEngine")
      .then((m) => {
        engine = m;
        if (active) engine.activate();
        return m;
      })
      // Could not be fetched: the server path, and another try on a later poll.
      .catch(() => { engineLoading = null; return null; });
  }
  return engineLoading;
}

/** Called by the 唱卡 page on mount; returns its cleanup. Makes no request. */
export function init() {
  if (typeof window === "undefined") return () => {};
  active = true;
  if (engine) engine.activate();
  return () => {
    active = false;
    if (engine) engine.deactivate();
  };
}

/**
 * The mode the server reported on the page's status poll. `server` touches
 * nothing (and tells an already-loaded engine to drop its account values);
 * any other loads the engine and hands it the mode.
 */
export function noteMode(next) {
  if (next !== "server" && next !== "shadow" && next !== "browser") return;
  mode = next;
  modeAt = Date.now();
  if (next === "server") {
    if (engine) engine.noteMode("server");
    return;
  }
  if (!active) return;
  loadEngine().then((m) => {
    if (m && active && mode === next) m.noteMode(next);
  });
}

/**
 * A play URL for one card. `mapping` is the card's ({ source, externalId });
 * `opts` the same { tier, vocalsOnly } the page sends the server; `askServer`
 * performs the server request (an axios call) and is used exactly as before.
 *
 * In `server` mode (or with no recent mode, or the engine not loaded) this is
 * `askServer()` itself, called at once and returned as is.
 *
 * Otherwise it resolves like an axios response ({ data }), and rejects with
 * the server's own error when the server path was needed and failed -- so the
 * page's handling is unchanged. Two optional extras on the response:
 *   afterPlay(quiet)      -- call once the sound has started (shadow timing);
 *                            `quiet()` says the song's own download is done.
 *   serverInstead(why)    -- present when the URL came from QQ directly; call
 *                            it if that URL will not play ("error") or has not
 *                            started in time ("timeout"), for the server's.
 * `ctx.elementHasPlayed`: whether the audio element this URL goes to has made
 * sound before (Apple's WebKit, see lib/qqDirectEngine).
 */
export function resolve(mapping, opts, askServer, ctx) {
  const fresh = mode && mode !== "server" && Date.now() - modeAt < MODE_STALE_MS;
  if (!fresh || !engine || mapping?.source !== "QQ" || !mapping.externalId) return askServer();
  return engine.resolve(mapping, opts, askServer, ctx, mode);
}

/**
 * For a URL that came from QQ directly: the player's start, given up on after
 * DIRECT_START_MS so a stalled CDN costs a few seconds rather than however long
 * the browser waits. The original start is left to settle on its own (it is
 * superseded by the next load).
 */
export function withStartLimit(starting) {
  starting.catch(() => {});
  return Promise.race([
    starting,
    new Promise((_, reject) => setTimeout(() => {
      const e = new Error("did not start");
      e.name = "StartTimeout";
      reject(e);
    }, DIRECT_START_MS)),
  ]);
}
