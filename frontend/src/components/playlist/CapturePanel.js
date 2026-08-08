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
export default function CapturePanel({ playlistId }) {
  const { t } = useLanguage();
  const [session, setSession] = useState(null);
  const [token, setToken] = useState(null);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(true);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const esRef = useRef(null);

  const pending = events.filter((e) => e.outcome === "pending" || e.outcome === "ambiguous");
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
        setEvents((prev) => [data, ...prev.filter((x) => x.eventId !== data.eventId)]);
      } catch {
        /* ignore malformed */
      }
    });

    es.addEventListener("capture-resolved", (e) => {
      try {
        const { eventId } = JSON.parse(e.data);
        setEvents((prev) => prev.filter((x) => x.eventId !== eventId));
      } catch {
        /* ignore */
      }
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [session, playlistId]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await captureAPI.start(playlistId);
      setSession(res.data.session);
      setToken(res.data.token);
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
      setToken(null);
      setShowToken(false);
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

  const ignore = useCallback(async (eventId) => {
    setEvents((prev) => prev.filter((x) => x.eventId !== eventId));
    try {
      await captureAPI.ignore(eventId);
    } catch {
      /* ignore */
    }
  }, []);

  const copyToken = useCallback(() => {
    if (!token) return;
    navigator.clipboard?.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [token]);

  // --- not started: a single unobtrusive button ---
  if (!session) {
    return (
      <button
        onClick={start}
        disabled={busy}
        className="hidden rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-theme transition-colors hover:bg-surface-hover disabled:opacity-50 sm:inline-flex"
      >
        🎯 {t("captureStart")}
      </button>
    );
  }

  // --- running: floating panel, desktop only ---
  return (
    <div className="pointer-events-none fixed bottom-28 right-4 z-40 hidden w-[360px] sm:block">
      <div className="pointer-events-auto overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
        {/* header */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
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
              className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-surface-hover"
            >
              {open ? "▼" : "▲"}
            </button>
            <button
              onClick={stop}
              disabled={busy}
              className="rounded bg-red-600/90 px-2 py-0.5 text-xs text-white hover:bg-red-600 disabled:opacity-50"
            >
              {t("captureStop")}
            </button>
          </div>
        </div>

        {open && (
          <>
            {/* token — hidden until asked for; it can write to this playlist */}
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
              <span className="text-muted">{t("captureToken")}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-300">
                {showToken ? token : "••••••••••••••••"}
              </code>
              <button
                onClick={() => setShowToken((v) => !v)}
                className="rounded px-1.5 py-0.5 text-muted hover:bg-surface-hover"
              >
                {showToken ? t("captureHideToken") : t("captureShowToken")}
              </button>
              <button
                onClick={copyToken}
                className="rounded px-1.5 py-0.5 text-muted hover:bg-surface-hover"
              >
                {copied ? t("captureCopied") : "📋"}
              </button>
            </div>

            {/* work list */}
            <div className="max-h-[45vh] overflow-y-auto">
              {pending.length === 0 && unmatched.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-muted">{t("captureNothingYet")}</p>
              )}

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
                    {unmatched.map((e) => e.rawText).join(" · ")}
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

/** One captured title and what it resolved to. */
function CaptureRow({ event, onApprove, onIgnore, t }) {
  const cands = (event.candidates || []).filter((c) => c.inPlaylist);
  const single = event.outcome === "pending" && cands.length === 1 && cands[0].clips.length === 1;

  return (
    <div className="border-b border-border/50 px-3 py-2">
      <p className="truncate text-xs text-muted">{event.rawText}</p>

      {single ? (
        <div className="mt-1 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-theme">
              {cands[0].title} — {cands[0].artist}
            </p>
            {cands[0].kind !== "exact" && cands[0].note && (
              <p className="truncate text-[11px] text-amber-400">⚠ {cands[0].note}</p>
            )}
          </div>
          <button
            onClick={() => onApprove(event.eventId, cands[0].clips[0].clipId)}
            className="shrink-0 rounded bg-primary px-2 py-0.5 text-xs text-white hover:opacity-90"
          >
            {t("captureApprove")}
          </button>
          <button
            onClick={() => onIgnore(event.eventId)}
            className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted hover:bg-surface-hover"
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
                className="mb-1 block w-full truncate rounded border border-border px-2 py-1 text-left text-xs text-theme hover:bg-surface-hover"
              >
                {c.title} — {c.artist}
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
