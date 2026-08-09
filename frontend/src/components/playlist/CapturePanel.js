"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { captureAPI, getLikesSSEUrl } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";

/**
 * Floating capture panel — desktop only.
 *
 * Floats above the page rather than sitting inline so the clip list never
 * shifts and stays visible: approving a match lights up its heart in the
 * list below, and you want to see that happen.
 *
 * Reuses the playlist's existing SSE connection by opening its own
 * EventSource on the same endpoint — the server broadcasts capture-event
 * and capture-resolved alongside like-update.
 */
const AUTO_LINGER_MS = 10000; // how long an auto-approved row stays visible as a receipt

/**
 * A match safe to act on without asking: exactly one song in the playlist,
 * exactly one clip of it, and the title matched exactly. `ellipsis` and `loose`
 * are deliberately excluded — those are guesses, and a wrong like is shared
 * with everyone who can see the playlist.
 */
function isPerfect(e) {
  if (e.outcome !== "pending") return false;
  const cands = (e.candidates || []).filter((c) => c.inPlaylist);
  return cands.length === 1 && cands[0].kind === "exact" && cands[0].clips.length === 1;
}

export default function CapturePanel({ playlistId, hiddenOnPhone = false }) {
  const { t } = useLanguage();
  const [session, setSession] = useState(null);
  const [pairCode, setPairCode] = useState(null);
  const [pairExpiresAt, setPairExpiresAt] = useState(null);
  const [pairLeft, setPairLeft] = useState(0);
  const [open, setOpen] = useState(true);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState("waiting");
  const esRef = useRef(null);
  const autoDoneRef = useRef(new Set()); // eventIds already auto-approved, never twice

  const pending = events.filter((e) => e.outcome === "pending" || e.outcome === "ambiguous");
  const settled = events.filter((e) => e.outcome === "auto");
  const unmatched = events.filter(
    (e) => e.outcome === "no_match" || e.outcome === "not_in_playlist"
  );

  // Listen for capture events on the playlist's SSE stream.
  useEffect(() => {
    if (!session || !playlistId) return;
    const es = new EventSource(getLikesSSEUrl(playlistId));
    esRef.current = es;

    es.addEventListener("capture-event", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.outcome === "duplicate") return;
        // Newest first — you should not have to scroll to find new work.
        setEvents((prev) => {
          // Never resurrect a row we already auto-approved: re-inserting it as
          // "pending" would show stale buttons and re-fire the approve call.
          if (prev.some((x) => x.eventId === data.eventId && x.outcome === "auto")) return prev;
          return [data, ...prev.filter((x) => x.eventId !== data.eventId)];
        });
      } catch {
        /* ignore malformed */
      }
    });

    es.addEventListener("capture-resolved", (e) => {
      try {
        const { eventId } = JSON.parse(e.data);
        // Our own auto-approve triggers this too. Dropping the row here would
        // erase the receipt the instant the server confirmed it, so leave
        // auto rows to the linger sweep and only clear ones resolved elsewhere.
        setEvents((prev) =>
          prev.filter((x) => x.eventId !== eventId || x.outcome === "auto")
        );
      } catch {
        /* ignore */
      }
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [session, playlistId]);

  // Poll liveness. An empty list has three very different causes — client
  // never started, client died, or the game simply has no song list up — and
  // the user cannot act without knowing which.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const tick = () => {
      captureAPI
        .status(session.id)
        .then((res) => alive && setClient(res.data.client))
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [session]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await captureAPI.start(playlistId);
      setSession(res.data.session);
      setPairCode(res.data.pairCode);
      setPairExpiresAt(res.data.pairExpiresAt);
      setEvents([]);
      setOpen(true);
    } catch (err) {
      setError(err.response?.data?.error?.message || t("captureStartFailed"));
    } finally {
      setBusy(false);
    }
  }, [playlistId, t]);

  const stop = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      await captureAPI.stop(session.id);
    } catch {
      /* stopping is best-effort; the token expires on its own anyway */
    } finally {
      setSession(null);
      setPairCode(null);
      setPairExpiresAt(null);
      setEvents([]);
      setBusy(false);
    }
  }, [session]);

  const approve = useCallback(async (eventId, clipId) => {
    setEvents((prev) => prev.filter((x) => x.eventId !== eventId)); // optimistic
    try {
      await captureAPI.approve(eventId, clipId);
    } catch (err) {
      setError(err.response?.data?.error?.message || "Approve failed");
    }
  }, []);

  // A perfect match needs no human judgement, so it is liked on arrival. It
  // still lingers in the panel for AUTO_LINGER_MS as a receipt — you get to see
  // what was tagged, and undo it, rather than having likes appear silently.
  useEffect(() => {
    const ready = events.filter(
      (e) => e.outcome === "pending" && !autoDoneRef.current.has(e.eventId) && isPerfect(e)
    );
    if (!ready.length) return;

    for (const e of ready) {
      autoDoneRef.current.add(e.eventId);
      const clipId = e.candidates.filter((c) => c.inPlaylist)[0].clips[0].clipId;
      // Flip to the "auto" receipt state first so the row never renders its
      // manual Approve/Ignore buttons, even for one frame.
      setEvents((prev) =>
        prev.map((x) =>
          x.eventId === e.eventId
            ? { ...x, outcome: "auto", autoClipId: clipId, autoAt: Date.now() }
            : x
        )
      );
      captureAPI
        .approve(e.eventId, clipId)
        .catch((err) =>
          setError(err.response?.data?.error?.message || t("captureStartFailed"))
        );
    }
  }, [events, t]);

  // Sweep expired receipts. One interval for all of them beats a timer per row,
  // which would leak on unmount and fight React's batching.
  useEffect(() => {
    if (!settled.length) return;
    const id = setInterval(() => {
      const cutoff = Date.now() - AUTO_LINGER_MS;
      setEvents((prev) => prev.filter((x) => x.outcome !== "auto" || (x.autoAt ?? 0) > cutoff));
    }, 500);
    return () => clearInterval(id);
  }, [settled.length]);

  const ignore = useCallback(async (eventId) => {
    setEvents((prev) => prev.filter((x) => x.eventId !== eventId));
    try {
      await captureAPI.ignore(eventId);
    } catch {
      /* ignore */
    }
  }, []);

  // Countdown on the pairing code — it expires in 5 minutes, and a user
  // staring at a dead code with no indication would have no idea why.
  useEffect(() => {
    if (!pairExpiresAt) return;
    const tick = () => {
      const left = Math.max(0, Math.floor((new Date(pairExpiresAt).getTime() - Date.now()) / 1000));
      setPairLeft(left);
      if (left === 0) setPairCode(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pairExpiresAt]);

  // --- not started: floating pill, matching FloatingClipNav's visual language ---
  // On phones it sits higher, clearing the fixed search bar at the bottom.
  if (!session) {
    return (
      <button
        onClick={start}
        disabled={busy}
        title={t("captureStart")}
        className={`fixed bottom-20 right-4 z-40 items-center gap-2 rounded-full border border-border bg-surface/95 py-2.5 pl-3.5 pr-4 text-sm font-medium text-theme shadow-lg backdrop-blur transition-all hover:border-primary hover:text-primary hover:shadow-xl active:scale-95 disabled:opacity-50 sm:bottom-28 sm:inline-flex ${
          hiddenOnPhone ? "hidden" : "inline-flex"
        }`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="h-4 w-4"
        >
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="4.5" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        </svg>
        {t("captureStart")}
      </button>
    );
  }

  // --- running: floating panel ---
  // Phone: spans the width just above the fixed search bar, so the work list
  // stays readable without a horizontal squeeze. Desktop: a 360px card.
  return (
    <div
      className={`pointer-events-none fixed bottom-14 left-2 right-2 z-40 sm:bottom-28 sm:left-auto sm:right-4 sm:block sm:w-[360px] ${
        hiddenOnPhone ? "hidden" : "block"
      }`}
    >
      <div className="pointer-events-auto overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
        {/* header */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
          </span>
          <span className="text-xs font-medium text-theme">{t("captureRunning")}</span>
          <span className="text-xs text-muted">
            {events.length} {t("captureCaught")}
            {pending.length > 0 && (
              <> · <span className="text-amber-400">{pending.length} {t("capturePending")}</span></>
            )}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setOpen((v) => !v)}
              className="rounded px-2.5 py-1.5 text-xs text-muted hover:bg-surface-hover sm:px-1.5 sm:py-0.5"
            >
              {open ? "▼" : "▲"}
            </button>
            <button
              onClick={stop}
              disabled={busy}
              className="rounded bg-red-600/90 px-3 py-1.5 text-xs text-white hover:bg-red-600 disabled:opacity-50 sm:px-2 sm:py-0.5"
            >
              {t("captureStop")}
            </button>
          </div>
        </div>

        {/* client liveness — the reason an empty list is empty */}
        {client !== "connected" && (
          <div className="border-b border-border bg-amber-500/10 px-3 py-1.5">
            <p className="text-[11px] text-amber-400">
              ⚠ {client === "waiting" ? t("captureWaitingClient") : t("captureStale")}
            </p>
            {client === "waiting" && (
              <p className="text-[11px] text-muted">{t("captureWaitingHint")}</p>
            )}
          </div>
        )}
        {client === "connected" && events.length === 0 && (
          <div className="border-b border-border px-3 py-1.5">
            <p className="text-[11px] text-green-400">🟢 {t("captureConnected")}</p>
          </div>
        )}

        {open && (
          <>
            {/* Pairing code — only until the client connects, then it is noise */}
            {pairCode && client !== "connected" && (
              <div className="border-b border-border px-3 py-2">
                <p className="mb-1 text-[11px] text-muted">{t("capturePairHint")}</p>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-black/30 px-3 py-1 font-mono text-lg tracking-[0.3em] text-theme">
                    {pairCode}
                  </code>
                  <span className="text-[11px] text-muted">
                    {Math.floor(pairLeft / 60)}:{String(pairLeft % 60).padStart(2, "0")}
                  </span>
                </div>
              </div>
            )}

            {/* work list */}
            <div className="max-h-[35vh] overflow-y-auto sm:max-h-[45vh]">
              {pending.length === 0 && settled.length === 0 && unmatched.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-muted">{t("captureNothingYet")}</p>
              )}

              {settled.map((e) => (
                <AutoRow key={e.eventId} event={e} t={t} />
              ))}

              {pending.map((e) => (
                <CaptureRow
                  key={e.eventId}
                  event={e}
                  onApprove={approve}
                  onIgnore={ignore}
                  t={t}
                />
              ))}

              {unmatched.length > 0 && (
                <div className="border-t border-border px-3 py-2">
                  <p className="mb-1 text-[11px] font-medium text-muted">
                    {t("captureUnmatched")} ({unmatched.length})
                  </p>
                  <p className="text-[11px] leading-relaxed text-gray-500">
                    {unmatched.map((e) => cleanTitle(e.rawText)).join(" · ")}
                  </p>
                </div>
              )}
            </div>
          </>
        )}

        {error && (
          <p className="border-t border-border px-3 py-1.5 text-xs text-red-400">{error}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The game wraps titles in 《》; they add nothing here and cost a line of width.
 * Only the outermost pair is peeled — a title can legitimately contain 《》 of
 * its own (《我和我的《祖国》》), and a blanket strip would mangle it.
 */
function cleanTitle(s) {
  const t = (s || "").trim();
  return t.startsWith("《") && t.endsWith("》") && t.length >= 2
    ? t.slice(1, -1).trim()
    : t;
}

/** An exact match that was liked automatically — shown briefly, then gone. */
function AutoRow({ event, t }) {
  return (
    <div className="flex items-center gap-2 border-b border-border/50 bg-green-500/5 px-3 py-2">
      <span className="shrink-0 text-xs text-green-400">✓</span>
      <p className="min-w-0 flex-1 truncate text-sm text-theme">
        {cleanTitle(event.rawText)}
      </p>
      <span className="shrink-0 text-[11px] text-green-400">{t("captureAutoApproved")}</span>
    </div>
  );
}

/** One captured title and what it resolved to. */
function CaptureRow({ event, onApprove, onIgnore, t }) {
  const cands = (event.candidates || []).filter((c) => c.inPlaylist);
  const single = event.outcome === "pending" && cands.length === 1 && cands[0].clips.length === 1;

  return (
    <div className="border-b border-border/50 px-3 py-2">
      <p className="truncate text-xs text-muted">{cleanTitle(event.rawText)}</p>

      {single ? (
        <div className="mt-1 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-theme">{cands[0].title}</p>
            {cands[0].kind !== "exact" && cands[0].note && (
              <p className="truncate text-[11px] text-amber-400">⚠ {cands[0].note}</p>
            )}
          </div>
          {/* Roomier hit areas on phones — py-0.5 is a ~20px target, well
              under what a thumb can reliably land on. */}
          <button
            onClick={() => onApprove(event.eventId, cands[0].clips[0].clipId)}
            className="shrink-0 rounded bg-primary px-3 py-1.5 text-xs text-white hover:opacity-90 sm:px-2 sm:py-0.5"
          >
            {t("captureApprove")}
          </button>
          <button
            onClick={() => onIgnore(event.eventId)}
            className="shrink-0 rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover sm:px-2 sm:py-0.5"
          >
            {t("captureIgnore")}
          </button>
        </div>
      ) : (
        <div className="mt-1">
          <p className="mb-1 text-[11px] text-amber-400">{t("captureAmbiguous")}</p>
          {cands.flatMap((c) =>
            c.clips.map((cl) => (
              <button
                key={cl.clipId}
                onClick={() => onApprove(event.eventId, cl.clipId)}
                className="mb-1 block w-full truncate rounded border border-border px-2 py-2 text-left text-xs text-theme hover:bg-surface-hover sm:py-1"
              >
                {c.title}
                {/* Artist survives only here: with two same-titled songs it is
                    the only thing telling the choices apart. */}
                {cands.length > 1 && <span className="text-muted"> · {c.artist}</span>}
                {c.clips.length > 1 && <span className="text-muted"> @{cl.start}s</span>}
              </button>
            ))
          )}
          <button
            onClick={() => onIgnore(event.eventId)}
            className="text-[11px] text-muted hover:text-theme"
          >
            {t("captureIgnore")}
          </button>
        </div>
      )}
    </div>
  );
}
