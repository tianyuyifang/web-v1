"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { captureAPI, getLikesSSEUrl } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import useAuth from "@/hooks/useAuth";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import useDraggablePosition from "@/hooks/useDraggablePosition";
import useCaptureStore from "@/store/captureStore";

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
/**
 * How many rows of receipts stay on screen. A rolling window rather than a
 * timer: during a busy round the 10s expiry cleared rows while you were still
 * reading them, and in a quiet stretch it left the panel empty. Keeping the
 * last N means the most recent tags are always there to check.
 *
 * Counted in rows, not songs. Counting songs let one team's half of a row be
 * evicted while the other half stayed, which left a lone song beside a gap that
 * looked like a bug rather than a formation — and with ten songs to a round, a
 * ten-song window hit that on the very first song of the next round.
 *
 * Five because that is what a round holds. Only rows that hold something are
 * drawn: the grid grows as the round fills and stops here, rather than opening
 * at full height with blank rows waiting to be used.
 */
const AUTO_KEEP_ROWS = 5;
const POS_KEY = "capture-panel-pos";

/**
 * Remember the running session so a page reload can pick it back up.
 *
 * Keyed per playlist: one key would let a run started on one playlist surface
 * in another's panel. Only the session id and its expiry are kept — the token
 * lives in the capture client and never reaches the browser.
 */
const SESSION_KEY = (playlistId) => `capture-session:${playlistId}`;

function remember(playlistId, session) {
  try {
    localStorage.setItem(SESSION_KEY(playlistId), JSON.stringify(session));
  } catch {
    // private mode or a full quota; losing this only costs the restore
  }
}

function recall(playlistId) {
  try {
    const raw = localStorage.getItem(SESSION_KEY(playlistId));
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.id ? s : null;
  } catch {
    return null;
  }
}

function forget(playlistId) {
  try {
    localStorage.removeItem(SESSION_KEY(playlistId));
  } catch {
    /* nothing to do */
  }
}

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
  const { canCapture } = useAuth();
  // One connection, shared with the nav indicator: this panel aims it rather
  // than owning it, so the two can never disagree about whether it is alive.
  const aim = useCaptureStore((s) => s.aim);
  const stopDelivery = useCaptureStore((s) => s.stop);
  const [showAddOnNotice, setShowAddOnNotice] = useState(false);
  const [session, setSession] = useState(null);
  const [pairCode, setPairCode] = useState(null);
  const [pairExpiresAt, setPairExpiresAt] = useState(null);
  const [pairLeft, setPairLeft] = useState(0);
  const [open, setOpen] = useState(true);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Stopping is a two-stage click. The stop button sits right beside the
  // collapse toggle, so a slip of the mouse used to end a live run outright;
  // arming first means a stray click costs nothing but a second of red.
  const [stopArmed, setStopArmed] = useState(false);
  const [client, setClient] = useState("waiting");
  const esRef = useRef(null);
  const autoDoneRef = useRef(new Set()); // eventIds already auto-approved, never twice

  // Button and panel share one position: to the user they are the same object,
  // so dragging either has to move both — otherwise opening the panel would
  // look like the thing teleported.
  const drag = useDraggablePosition(POS_KEY, !hiddenOnPhone);

  // Running totals for the session. Counted separately from `events`, which
  // only holds what is on screen — receipts expire and dismissed rows are
  // removed, so its length answers "how much is showing", not "how much has
  // happened". `seenRef` keeps the tally idempotent if an event id repeats.
  const [totals, setTotals] = useState({ caught: 0, tagged: 0 });
  const seenRef = useRef(new Set());   // ids counted toward `caught`
  const taggedRef = useRef(new Set()); // ids counted toward `tagged`

  const countCaught = useCallback((eventId) => {
    if (!eventId || seenRef.current.has(eventId)) return;
    seenRef.current.add(eventId);
    setTotals((p) => ({ ...p, caught: p.caught + 1 }));
  }, []);

  /** A song ended up liked — whether auto-approved or confirmed by hand. */
  const countTagged = useCallback((eventId) => {
    if (!eventId || taggedRef.current.has(eventId)) return;
    taggedRef.current.add(eventId);
    setTotals((p) => ({ ...p, tagged: p.tagged + 1 }));
  }, []);

  const pending = events.filter((e) => e.outcome === "pending" || e.outcome === "ambiguous");
  const settled = events.filter((e) => e.outcome === "auto");
  // Failures stay until acted on — they are the one state you must not miss.
  const failed = events.filter((e) => e.outcome === "failed");
  const unmatched = events.filter(
    (e) => e.outcome === "no_match" || e.outcome === "not_in_playlist"
  );
  // How many rows those receipts occupy once the teams are lined up. Drives
  // eviction, which works in rows so a pair is never half-removed.
  const settledRowCount = settledRows(settled).length;

  // Listen for capture events on the playlist's SSE stream.
  useEffect(() => {
    if (!session || !playlistId) return;
    const es = new EventSource(getLikesSSEUrl(playlistId));
    esRef.current = es;

    es.addEventListener("capture-event", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.outcome === "duplicate") return;
        countCaught(data.eventId);
        // Newest first — you should not have to scroll to find new work.
        // Never resurrect a row we already auto-approved: re-inserting it as
        // "pending" would show stale buttons and re-fire the approve call.
        // Same reasoning as capture-resolved — the ref is the reliable check.
        if (autoDoneRef.current.has(data.eventId)) return;
        setEvents((prev) => [data, ...prev.filter((x) => x.eventId !== data.eventId)]);
      } catch {
        /* ignore malformed */
      }
    });

    es.addEventListener("capture-resolved", (e) => {
      try {
        const { eventId, outcome } = JSON.parse(e.data);
        // Counts approvals made in another tab too; countTagged is idempotent,
        // so the ones this tab did are not counted twice.
        if (outcome === "approved") countTagged(eventId);
        // Our own auto-approve triggers this too, so skip rows we auto-took.
        //
        // Checked against autoDoneRef, not against outcome === "auto": the
        // flip to "auto" is a setState and may not have rendered yet when the
        // server's confirmation arrives, in which case the row still reads
        // "pending" here and the receipt gets deleted a moment after it
        // appears. The ref is written synchronously, so it is already true.
        if (autoDoneRef.current.has(eventId)) return;
        setEvents((prev) => prev.filter((x) => x.eventId !== eventId));
      } catch {
        /* ignore */
      }
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [session, playlistId, countCaught, countTagged]);

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
    // Explain the add-on rather than firing a request that will 403. The
    // button stays live so the feature is discoverable — and so the price
    // reaches the people who would pay it.
    if (!canCapture) {
      setShowAddOnNotice(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Point the existing connection here, opening one first if there is
      // none. That auto-connect is what preserves the old habit: pressing this
      // with nothing connected still produces a pairing code, it just now
      // lasts the rest of the game instead of this one playlist.
      const ok = await aim("playlist", playlistId);
      if (!ok) {
        setError(useCaptureStore.getState().error || t("captureStartFailed"));
        return;
      }
      const conn = useCaptureStore.getState().connection;
      setSession({ id: conn.sessionId, expiresAt: conn.expiresAt });
      setPairCode(conn.pairCode || null);
      setPairExpiresAt(conn.pairExpiresAt || null);
      setEvents([]);
      // Totals are per run, so clear the tallies along with the rows.
      seenRef.current = new Set();
      taggedRef.current = new Set();
      setTotals({ caught: 0, tagged: 0 });
      setOpen(true);
      remember(playlistId, { id: conn.sessionId, expiresAt: conn.expiresAt });
    } catch (err) {
      setError(err.response?.data?.error?.message || t("captureStartFailed"));
    } finally {
      setBusy(false);
    }
  }, [playlistId, t, canCapture, aim]);

  // Pick a run back up after a reload.
  //
  // The run lives on the server for hours and the capture client keeps posting
  // to it regardless — a refresh only made the browser forget, so the panel
  // read as disconnected while songs were still being tagged. Restore it, and
  // refill the list from the server so it does not come back connected but
  // blank.
  useEffect(() => {
    const saved = recall(playlistId);
    if (!saved) return;
    let alive = true;

    (async () => {
      try {
        // Confirm it is still live before showing it: a stored id may have
        // expired or been stopped elsewhere.
        const status = await captureAPI.status(saved.id);
        if (!alive) return;
        if (status.data.ended || new Date(status.data.expiresAt) <= new Date()) {
          forget(playlistId);
          return;
        }

        // The connection outlives any one playlist now, so a stored id is no
        // longer proof that captures are coming *here*. Without this check the
        // panel reopens as though it were tagging while the connection has
        // since been aimed at another playlist or at 唱卡 — showing counts
        // that will never move.
        const conn = await useCaptureStore.getState().refresh();
        if (!alive) return;
        const aimedHere = conn && conn.target === "playlist"
          && (conn.playlist?.id || conn.playlistId) === playlistId;
        if (!aimedHere) {
          forget(playlistId);
          return;
        }

        setSession(saved);
        setClient(status.data.client);

        const report = await captureAPI.report(saved.id);
        if (!alive) return;
        const rows = (report.data.events || [])
          .filter((e) => e.outcome === "pending" || e.outcome === "ambiguous" ||
            e.outcome === "no_match" || e.outcome === "not_in_playlist")
          .map((e) => ({
            eventId: e.id,
            rawText: e.rawText,
            outcome: e.outcome,
            candidates: e.candidates || [],
            // Both are undefined here: neither is stored, they only ride the
            // live event. Restored rows are the ones still awaiting a decision,
            // which render as a single list, so nothing depends on them —
            // SettledList only ever holds receipts from this page's own session.
            side: e.side,
            row: e.row,
            createdAt: e.createdAt,
          }));
        setEvents(rows);

        // Rebuild the tallies from history so the header is not reset to zero.
        const all = report.data.events || [];
        for (const e of all) seenRef.current.add(e.id);
        for (const e of all) if (e.outcome === "approved") taggedRef.current.add(e.id);
        setTotals({ caught: seenRef.current.size, tagged: taggedRef.current.size });
      } catch {
        forget(playlistId);   // gone, or not ours any more
      }
    })();

    return () => { alive = false; };
  }, [playlistId]);

  const [copied, setCopied] = useState(false);
  const copyPairCode = useCallback(async () => {
    if (!pairCode) return;
    try {
      await navigator.clipboard.writeText(pairCode);
    } catch {
      // navigator.clipboard is undefined outside a secure context, and can be
      // refused even inside one; fall back so the button is never a dead end.
      const ta = document.createElement("textarea");
      ta.value = pairCode;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* nothing left to try */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
  }, [pairCode]);

  // Clear the "copied" flash. Keyed on the flag so a second copy restarts it.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  // Disarm the stop button if the second click never comes, so it cannot sit
  // armed indefinitely and turn a much later stray click into a stop.
  useEffect(() => {
    if (!stopArmed) return;
    const id = setTimeout(() => setStopArmed(false), 3000);
    return () => clearTimeout(id);
  }, [stopArmed]);

  const stop = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      // Stop delivering here, but keep the connection: the client is mid-game
      // and making it pair again to tag the next playlist is the whole cost
      // this split exists to remove.
      await stopDelivery();
    } catch {
      /* stopping is best-effort; the connection expires on its own anyway */
    } finally {
      setSession(null);
      setPairCode(null);
      setPairExpiresAt(null);
      setEvents([]);
      setBusy(false);
      // Drop the stored id too, or the next visit restores a dead run.
      forget(playlistId);
    }
  }, [session, playlistId, stopDelivery]);

  const approve = useCallback(async (eventId, clipId) => {
    setEvents((prev) => prev.filter((x) => x.eventId !== eventId)); // optimistic
    try {
      await captureAPI.approve(eventId, clipId);
      countTagged(eventId);
    } catch (err) {
      setError(err.response?.data?.error?.message || "Approve failed");
    }
  }, [countTagged]);

  // A perfect match needs no human judgement, so it is liked on arrival. It
  // still shows as a receipt afterwards — you get to see what was tagged,
  // rather than having likes appear silently.
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
            ? { ...x, outcome: "auto", autoClipId: clipId }
            : x
        )
      );
      captureAPI.approve(e.eventId, clipId).then(() => countTagged(e.eventId)).catch(() => {
        // The receipt would otherwise sit there looking successful, leaving
        // you sure the song was tagged when nothing was liked. Mark it
        // failed instead. It deliberately stays "done" in autoDoneRef so this
        // effect will not pick it up again — an automatic retry on a row that
        // keeps failing would loop.
        setEvents((prev) =>
          prev.map((x) =>
            x.eventId === e.eventId ? { ...x, outcome: "failed", autoClipId: clipId } : x
          )
        );
      });
    }
  }, [events, t, countTagged]);

  /** Retry a failed auto-approve. Manual only — see the catch above. */
  const retry = useCallback(async (eventId, clipId) => {
    setEvents((prev) =>
      prev.map((x) =>
        x.eventId === eventId ? { ...x, outcome: "auto" } : x
      )
    );
    try {
      await captureAPI.approve(eventId, clipId);
      countTagged(eventId);
    } catch {
      setEvents((prev) =>
        prev.map((x) => (x.eventId === eventId ? { ...x, outcome: "failed" } : x))
      );
    }
  }, [countTagged]);

  // Keep only the newest AUTO_KEEP_ROWS rows; each new row rolls off the
  // oldest. Nothing here is time-based, so no interval is needed — the list
  // only changes when a receipt is added.
  //
  // Whole rows go at once. Evicting individual songs used to break a row in
  // half, leaving one team's title beside an empty cell that read as a missing
  // capture rather than the formation it was meant to show.
  useEffect(() => {
    if (settledRowCount <= AUTO_KEEP_ROWS) return;
    setEvents((prev) => {
      // Recomputed from `prev` rather than closing over `settled`, which is a
      // fresh array each render and would make this effect re-run forever.
      const rows = settledRows(prev.filter((x) => x.outcome === "auto"));
      if (rows.length <= AUTO_KEEP_ROWS) return prev;
      const drop = new Set();
      for (const r of rows.slice(0, rows.length - AUTO_KEEP_ROWS)) {
        if (r.red) drop.add(r.red.eventId);
        if (r.blue) drop.add(r.blue.eventId);
      }
      return drop.size ? prev.filter((x) => !drop.has(x.eventId)) : prev;
    });
  }, [settledRowCount]);

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
      <>
      <button
        ref={drag.ref}
        {...drag.dragProps}
        data-drag-handle
        onClick={start}
        disabled={busy}
        title={t("captureStart")}
        style={drag.style}
        // transition-colors, not transition-all: the latter animates left/top
        // as well, so every drag frame started a 150ms tween and the button
        // lagged behind the cursor instead of tracking it.
        className={`fixed bottom-20 right-4 z-40 touch-none items-center gap-2 rounded-full border border-border bg-surface/95 py-2.5 pl-3.5 pr-4 text-sm font-medium text-theme shadow-lg backdrop-blur transition-colors hover:border-primary hover:text-primary hover:shadow-xl active:scale-95 disabled:opacity-50 sm:bottom-28 sm:inline-flex sm:cursor-grab sm:active:cursor-grabbing ${
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

      {showAddOnNotice && (
        <ConfirmDialog
          title={t("addOnRequiredTitle")}
          // No contact details here any more: the body sends the user to
          // 账户 → 套餐与续费, and repeating the handles would give two
          // different instructions in one dialog.
          message={t("addOnCaptureBody")}
          confirmLabel={t("confirm")}
          onConfirm={() => setShowAddOnNotice(false)}
          onCancel={() => setShowAddOnNotice(false)}
        />
      )}
      </>
    );
  }

  // --- running: floating panel ---
  // Phone: spans the width just above the fixed search bar, so the work list
  // stays readable without a horizontal squeeze. Desktop: a 360px card.
  return (
    <div
      ref={drag.ref}
      {...drag.dragProps}
      style={drag.style}
      className={`pointer-events-none fixed bottom-14 left-2 right-2 z-40 touch-none sm:bottom-28 sm:left-auto sm:right-4 sm:block sm:w-[360px] ${
        hiddenOnPhone ? "hidden" : "block"
      }`}
    >
      <div className="pointer-events-auto overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
        {/* header — also the drag handle */}
        <div
          data-drag-handle
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2 sm:cursor-grab sm:active:cursor-grabbing"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
          </span>
          <span className="text-xs font-medium text-theme">{t("captureRunning")}</span>
          <span className="text-xs text-muted">
            {totals.caught} {t("captureCaught")}
            {" · "}
            <span className="text-green-400">{totals.tagged} {t("captureTagged")}</span>
            {pending.length > 0 && (
              <> · <span className="text-amber-400">{pending.length} {t("capturePending")}</span></>
            )}
            {/* Surfaced in the header too — a failure hidden inside a collapsed
                panel is exactly the case this state exists to prevent. */}
            {failed.length > 0 && (
              <> · <span className="text-red-400">{failed.length} {t("captureFailed")}</span></>
            )}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setOpen((v) => !v)}
              className="rounded px-2.5 py-1.5 text-xs text-muted hover:bg-surface-hover sm:px-1.5 sm:py-0.5"
            >
              {open ? "▼" : "▲"}
            </button>
            {/* Extra gap from the collapse toggle: these two sat a hair apart,
                which is how the stop got hit by accident in the first place. */}
            <button
              onClick={() => (stopArmed ? stop() : setStopArmed(true))}
              disabled={busy}
              className={`ml-2 rounded px-3 py-1.5 text-xs text-white transition-colors disabled:opacity-50 sm:px-2 sm:py-0.5 ${
                stopArmed
                  ? "bg-red-500 ring-2 ring-red-300"
                  : "bg-red-600/90 hover:bg-red-600"
              }`}
            >
              {stopArmed ? t("captureStopConfirm") : t("captureStop")}
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
                  {/* The whole code is the button — a small icon beside it
                      would be a worse target than the code itself. */}
                  <button
                    onClick={copyPairCode}
                    title={t("captureCopy")}
                    className="rounded bg-black/30 px-3 py-1 font-mono text-lg tracking-[0.3em] text-theme transition-colors hover:bg-black/50"
                  >
                    {pairCode}
                  </button>
                  <span className={`text-[11px] ${copied ? "text-green-400" : "text-muted"}`}>
                    {copied ? t("captureCopied") : t("captureCopy")}
                  </span>
                  <span className="ml-auto text-[11px] text-muted">
                    {Math.floor(pairLeft / 60)}:{String(pairLeft % 60).padStart(2, "0")}
                  </span>
                </div>
              </div>
            )}

            {/* work list */}
            <div className="max-h-[35vh] overflow-y-auto sm:max-h-[45vh]">
              {pending.length === 0 && settled.length === 0 && failed.length === 0 &&
                unmatched.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-muted">{t("captureNothingYet")}</p>
              )}

              {/* Failures first: they need action and never expire on their own. */}
              {failed.map((e) => (
                <FailedRow key={e.eventId} event={e} onRetry={retry} onIgnore={ignore} t={t} />
              ))}

              <SettledList events={settled} t={t} />

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
                <>
                  <p className="border-t border-border px-3 pb-1 pt-2 text-[11px] font-medium text-muted">
                    {t("captureUnmatched")} ({unmatched.length})
                  </p>
                  {/* One row each, dismissable — you tag these by hand in the
                      list below, and crossing them off is how you keep track
                      of which ones you have already dealt with. */}
                  {unmatched.map((e) => (
                    <UnmatchedRow key={e.eventId} event={e} onDismiss={ignore} t={t} />
                  ))}
                </>
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

/**
 * Auto-approved receipts, laid out the way the game shows them: the two 2v2
 * candidate lists side by side.
 *
 * Falls back to one full-width list whenever no row carries a side — clients
 * before v3 never send it, and modes other than 2v2 have only one list. Two
 * empty columns would be worse than the plain list they replaced.
 *
 * When the client reports a row index (v9 and later), the two columns are
 * aligned on it: red row N sits beside blue row N, the same pairing qni shows.
 * A team with nothing at that row leaves a gap rather than pulling its later
 * songs up, so the shape on screen keeps matching the game even when one side
 * has not picked yet, or when its song needed manual approval and never became
 * a receipt. The cost is that the number of rows no longer equals the number of
 * songs tagged — deliberately accepted, since the formation is what makes the
 * panel readable against the game.
 *
 * Without row indices it degrades to the previous behaviour: two independent
 * stacks, each in arrival order.
 */
function SettledList({ events, t }) {
  const ordered = [...events].reverse();
  const hasSide = ordered.some((e) => e.side === "red" || e.side === "blue");

  // No team information at all — clients before v3, and modes with one list.
  // Two empty columns would be worse than the plain list they replaced.
  if (!hasSide) {
    return ordered.map((e) => <AutoRow key={e.eventId} event={e} t={t} />);
  }

  const rows = settledRows(events);

  return (
    <div className="grid grid-cols-2 gap-px border-b border-border/50 bg-border/30">
      <div className="bg-surface">
        <ColumnHeader label={t("captureTeamRed")} tone="text-red-400" />
        {rows.map((r, i) => (
          <CompactAutoRow key={r.red ? r.red.eventId : `red-gap-${i}`} event={r.red} />
        ))}
      </div>
      <div className="bg-surface">
        <ColumnHeader label={t("captureTeamBlue")} tone="text-blue-400" />
        {rows.map((r, i) => (
          <CompactAutoRow key={r.blue ? r.blue.eventId : `blue-gap-${i}`} event={r.blue} />
        ))}
      </div>
    </div>
  );
}

/**
 * Pair the two columns up into rows.
 *
 * With row indices, one output row per index that either team occupies, in
 * ascending order — so a team missing that row renders an empty cell and every
 * later song stays on its own line. Indices are the game's own, and a round
 * that scrolled still reports absolute positions, so they can be compared
 * directly between the teams.
 *
 * Without them there is nothing to align on, so the two lists are simply laid
 * alongside each other in arrival order — which is what the panel did before.
 */
/**
 * Receipts as display rows, oldest first.
 *
 * The single place that decides what a row is, used both to render the grid and
 * to decide what to evict. Two implementations would eventually disagree, and
 * the symptom — a row half-removed — is exactly what counting rows is meant to
 * prevent.
 *
 * `events` arrives newest-first because arrivals are prepended; a column that
 * grows downward reads the other way round, newest at the bottom where your eye
 * already is.
 */
function settledRows(events) {
  const ordered = [...events].reverse();
  // Anything without a side still has to appear; keep it with the reds so it
  // cannot silently vanish. Selected in one pass so it stays in arrival order
  // rather than being appended after the reds.
  return alignRows(
    ordered.filter((e) => e.side !== "blue"),
    ordered.filter((e) => e.side === "blue")
  );
}

function alignRows(red, blue) {
  const hasRow = (e) => Number.isInteger(e.row);
  const aligned = red.some(hasRow) || blue.some(hasRow);

  if (!aligned) {
    const n = Math.max(red.length, blue.length);
    return Array.from({ length: n }, (_, i) => ({
      red: red[i] || null,
      blue: blue[i] || null,
    }));
  }

  // First title to claim an index keeps it; a later one with the same index
  // gets a row of its own further down.
  //
  // Two songs should never share an index — the game numbers a list once — but
  // when it happened, overwriting silently deleted the earlier song from the
  // panel. Nine titles once collapsed onto row 0 and eight disappeared. Losing
  // a song is the one outcome this panel must not produce, so a collision costs
  // alignment for that row and nothing more.
  const placed = new Set();   // events that got an aligned row
  const byRow = (list) => {
    const m = new Map();
    for (const e of list) {
      if (!hasRow(e) || m.has(e.row)) continue;
      m.set(e.row, e);
      placed.add(e);
    }
    return m;
  };
  const rMap = byRow(red);
  const bMap = byRow(blue);
  const indices = [...new Set([...rMap.keys(), ...bMap.keys()])].sort((a, b) => a - b);

  const rows = indices.map((i) => ({ red: rMap.get(i) || null, blue: bMap.get(i) || null }));
  // Anything left over: no index at all, or an index already taken. Each gets
  // its own line on its own side, in arrival order.
  for (const e of red) if (!placed.has(e)) rows.push({ red: e, blue: null });
  for (const e of blue) if (!placed.has(e)) rows.push({ red: null, blue: e });
  return rows;
}

function ColumnHeader({ label, tone }) {
  return (
    <p className={`px-2 pb-0.5 pt-1 text-[10px] font-medium ${tone}`}>{label}</p>
  );
}

/**
 * A receipt inside a column. Half the width means the ✓ and the "auto-approved"
 * label no longer fit alongside the title, so the green tint carries that
 * meaning instead and the title gets the whole line.
 */
function CompactAutoRow({ event }) {
  // A gap: this team has nothing at this row — it has not picked yet, or its
  // song is still waiting to be approved. Holding the line keeps the other
  // team's songs on the rows the game put them on. aria-hidden because it
  // carries no information a screen reader could use; the height is the point.
  if (!event) {
    return (
      <p aria-hidden className="px-2 py-1 text-[11px] leading-tight">
        &nbsp;
      </p>
    );
  }

  const title = cleanTitle(event.rawText);
  return (
    <p
      title={title}
      className="truncate bg-green-500/5 px-2 py-1 text-[11px] leading-tight text-theme"
    >
      {title}
    </p>
  );
}

/**
 * Which of the 2v2 candidate lists a title was read from. Absent for clients
 * before v3 and outside 2v2, in which case nothing is shown.
 */
function SideDot({ side }) {
  if (side !== "red" && side !== "blue") return null;
  return (
    <span
      title={side}
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
        side === "red" ? "bg-red-400" : "bg-blue-400"
      }`}
    />
  );
}

/**
 * A title that matched nothing, or matched a song this playlist does not hold.
 * Nothing to approve — the ✕ just crosses it off once you have handled it.
 */
function UnmatchedRow({ event, onDismiss, t }) {
  const inLibrary = event.outcome === "not_in_playlist";
  return (
    <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
      <SideDot side={event.side} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-gray-500">{cleanTitle(event.rawText)}</p>
        {inLibrary && (
          <p className="truncate text-[11px] text-muted">{t("captureNotInPlaylist")}</p>
        )}
      </div>
      <button
        onClick={() => onDismiss(event.eventId)}
        title={t("captureIgnore")}
        aria-label={t("captureIgnore")}
        className="shrink-0 rounded px-2 py-1 text-xs text-muted hover:bg-surface-hover hover:text-theme sm:px-1.5 sm:py-0.5"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * An auto-approve whose request failed. Unlike a receipt this does not expire:
 * a row that quietly vanished would leave you believing the song was tagged.
 */
function FailedRow({ event, onRetry, onIgnore, t }) {
  return (
    <div className="flex items-center gap-2 border-b border-border/50 bg-red-500/10 px-3 py-2">
      <span className="shrink-0 text-xs text-red-400">✕</span>
      <SideDot side={event.side} />
      <p className="min-w-0 flex-1 truncate text-sm text-theme">{cleanTitle(event.rawText)}</p>
      <button
        onClick={() => onRetry(event.eventId, event.autoClipId)}
        className="shrink-0 rounded bg-primary px-3 py-1.5 text-xs text-white hover:opacity-90 sm:px-2 sm:py-0.5"
      >
        {t("captureRetry")}
      </button>
      <button
        onClick={() => onIgnore(event.eventId)}
        className="shrink-0 rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover sm:px-2 sm:py-0.5"
      >
        {t("captureIgnore")}
      </button>
    </div>
  );
}

/** An exact match that was liked automatically — shown briefly, then gone. */
function AutoRow({ event, t }) {
  return (
    <div className="flex items-center gap-2 border-b border-border/50 bg-green-500/5 px-3 py-2">
      <span className="shrink-0 text-xs text-green-400">✓</span>
      <SideDot side={event.side} />
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
      <p className="flex items-center gap-1.5 truncate text-xs text-muted">
        <SideDot side={event.side} />
        {cleanTitle(event.rawText)}
      </p>

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
