"use client";

/**
 * QQ打标's floating panel — the playlist page's capture panel
 * (components/playlist/CapturePanel), behaviour for behaviour: a draggable
 * 自动打标 pill until a run starts, then a floating card with the run's
 * totals, a collapse toggle, a two-click stop, the client's liveness, the
 * pairing code (copy, countdown), and the work list -- failures, the settled
 * songs in red / blue columns row for row as the game shows them, what waits
 * for 确认 / 忽略, and what matched nothing (手动打标).
 *
 * A copy, not a shared component (2026-10-06, by request): the playlist panel
 * is used by every playlist page and likes into our own playlists; nothing
 * here can reach it, nor it this. Its own drag hook too (useQqTagDraggable).
 *
 * Where QQ打标 has to differ, it says so where it does: the run is started by
 * the page (it must read the QQ list first), exact matches are liked by the
 * user's page or phone and tried again on their own (the server's 处理中),
 * and a failure carries QQ's reason.
 *
 * One run only: this playlist's rows since 开始 (`runStartedAt`); a new run
 * begins empty. After a reload, as on the playlist page, what is still waiting
 * comes back and the settled songs do not (the totals still count them).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { platformTaggingAPI, getPlatformTagSSEUrl } from "@/lib/api";
import * as qqTagWrites from "@/lib/qqTagWrites";
import useQqTagDraggable from "./useQqTagDraggable";

const POS_KEY = "qqtag-panel-pos";
const LIKED = new Set(["liked", "already_liked"]);
const ACTIONABLE = new Set(["pending", "ambiguous"]);

export default function PlatformTagPanel({
  running, sessionId, playlistRef, runStartedAt = null, connection = null, onLiked,
  canStart, starting, startError, onStart, onStop,
}) {
  const drag = useQqTagDraggable(POS_KEY, true);
  if (!running || !sessionId) {
    return <StartPill drag={drag} canStart={canStart} busy={starting} error={startError} onStart={onStart} />;
  }
  return (
    <RunPanel
      // A new run (another list, or this one after 停止) is a fresh panel.
      key={`${sessionId}|${playlistRef}|${runStartedAt || ""}`}
      drag={drag}
      sessionId={sessionId}
      playlistRef={playlistRef}
      runStartedAt={runStartedAt}
      connection={connection}
      onLiked={onLiked}
      onStop={onStop}
    />
  );
}

/** Not started: the floating pill, as the playlist page's. */
function StartPill({ drag, canStart, busy, error, onStart }) {
  return (
    <>
      <button
        ref={drag.ref}
        {...drag.dragProps}
        data-drag-handle
        onClick={onStart}
        disabled={busy || !canStart}
        title={canStart ? "自动打标" : "先在左边选一个歌单"}
        style={drag.style}
        className={`fixed bottom-20 right-4 z-40 inline-flex touch-none items-center gap-2 rounded-full border border-border bg-surface/95 py-2.5 pl-3.5 pr-4 text-sm font-medium text-theme shadow-lg backdrop-blur transition-colors hover:border-primary hover:text-primary hover:shadow-xl active:scale-95 disabled:opacity-50 sm:bottom-28 sm:cursor-grab sm:active:cursor-grabbing ${
          busy ? "animate-pulse" : ""
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
        自动打标
      </button>
      {error && !busy && (
        <div className="fixed bottom-32 right-4 z-40 max-w-[16rem] rounded border border-border bg-surface px-3 py-2 text-xs text-red-400 shadow-lg sm:bottom-40">
          {error}
        </div>
      )}
    </>
  );
}

function RunPanel({ drag, sessionId, playlistRef, runStartedAt, connection, onLiked, onStop }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  // Stopping is a two-stage click, as on the playlist page.
  const [stopArmed, setStopArmed] = useState(false);
  // Rows this page acted on and is waiting to hear back about (optimistic).
  const [inFlight, setInFlight] = useState(() => new Set());
  // 重试 of a failed automatic like, here: green, as the playlist page keeps
  // its own retries (another tab, like the playlist page's, shows it amber).
  const retriedRef = useRef(new Set());

  /**
   * One row in, from the stream: newest first, as the playlist panel keeps
   * its list. `side` / `row` come only with the capture's own broadcast;
   * later updates of the same row keep them. Anything the stream delivers is
   * live -- shown even once settled.
   */
  const upsert = useCallback((r) => {
    setRows((prev) => {
      const old = prev.find((x) => x.eventId === r.eventId);
      const merged = old
        ? { ...old, ...r, side: r.side ?? old.side, row: r.row ?? old.row, byHand: r.byHand ?? old.byHand, restored: false }
        : { ...r, restored: false };
      if (retriedRef.current.has(merged.eventId)) merged.byHand = false;
      const rest = prev.filter((x) => x.eventId !== r.eventId);
      return [merged, ...rest].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    });
    if (LIKED.has(r.outcome) && r.likedExternalId && onLiked) onLiked(r.likedExternalId);
  }, [onLiked]);

  // The stream first, then the snapshot -- taken once the stream is open, so
  // nothing can fall between them. Rows first seen in a snapshot are
  // "restored": after a reload the settled ones stay out of the list, as on
  // the playlist page, but count in the totals. The browser gives a stream up
  // for good after an error answer (a restarting server's 502): reopened here.
  useEffect(() => {
    let alive = true;
    const loadFeed = () => {
      platformTaggingAPI.feed(sessionId)
        .then((res) => {
          if (!alive) return;
          const got = res.data.events || [];
          setRows((prev) => {
            const byId = new Map(prev.map((r) => [r.eventId, r]));
            for (const r of got) {
              const old = byId.get(r.eventId);
              byId.set(r.eventId, old
                ? { ...old, ...r, side: old.side, row: old.row, byHand: old.byHand, restored: old.restored }
                : { ...r, restored: true });
            }
            return [...byId.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          });
          got.forEach((r) => {
            if (LIKED.has(r.outcome) && r.likedExternalId && onLiked) onLiked(r.likedExternalId);
          });
        })
        .catch(() => {});
    };
    let es = null;
    let retryMs = 2000;
    let timer = null;
    const listen = (target) => {
      target.addEventListener("open", () => { retryMs = 2000; loadFeed(); });
      target.addEventListener("error", () => {
        if (!alive || target.readyState !== 2) return;
        target.close();
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!alive) return;
          es = new EventSource(getPlatformTagSSEUrl(sessionId));
          listen(es);
        }, retryMs);
        retryMs = Math.min(retryMs * 2, 30000);
      });
      // The server could not read the playlist (a lapsed platform login).
      target.addEventListener("platform-tag-error", (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.sessionId && data.sessionId !== sessionId) return;
          setError(data.message || "读取歌单失败");
        } catch { /* malformed */ }
      });
      target.addEventListener("platform-tag-event", (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.outcome === "duplicate") return;
          if (data.sessionId && data.sessionId !== sessionId) return;
          upsert(data);
        } catch { /* malformed */ }
      });
    };
    es = new EventSource(getPlatformTagSSEUrl(sessionId));
    listen(es);
    return () => {
      alive = false;
      clearTimeout(timer);
      if (es) es.close();
    };
  }, [sessionId, upsert, onLiked]);

  // This run's rows only: this playlist, since 开始.
  const startedMs = runStartedAt ? new Date(runStartedAt).getTime() : null;
  const events = useMemo(() => rows.filter((r) => r.playlistRef === playlistRef
    && (startedMs == null || new Date(r.createdAt).getTime() >= startedMs)), [rows, playlistRef, startedMs]);

  /** Show a row as done at once (the playlist page does), until the server says. */
  const optimistic = useCallback((eventId, patch) => {
    setRows((prev) => prev.map((x) => (x.eventId === eventId ? { ...x, ...patch, restored: false } : x)));
    setInFlight((s) => new Set(s).add(eventId));
  }, []);
  const settle = useCallback((eventId) => {
    setInFlight((s) => { const n = new Set(s); n.delete(eventId); return n; });
  }, []);
  /** The server's word on every row, after an action it refused. */
  const refetch = useCallback(() => {
    platformTaggingAPI.feed(sessionId).then((r) => (r.data.events || []).forEach(upsert)).catch(() => {});
  }, [sessionId, upsert]);

  const failMessage = (err) => {
    // Being liked by an automatic retry right now: nothing went wrong.
    if (err.response?.data?.error?.code === "AUTO_RETRY_IN_FLIGHT") return "";
    return err.response?.data?.error?.message || err.message || "操作失败";
  };

  /**
   * Like one candidate: QQ -- this page writes it from the user's own
   * address, then the server records how it went; NetEase -- the server does.
   * `retry`: 重试 on a failed automatic like (green, as on the playlist page).
   */
  const approve = useCallback(async (ev, externalId, { retry = false } = {}) => {
    const cands = ev.candidates || [];
    const pick = externalId
      ? cands.find((c) => String(c.externalId) === String(externalId))
      : (cands.length === 1 ? cands[0] : null);
    if (!pick) { setError("请选择一首歌"); return; }
    if (retry) retriedRef.current.add(ev.eventId);
    else retriedRef.current.delete(ev.eventId);
    optimistic(ev.eventId, { outcome: "liked", byHand: !retry, candidates: [pick] });
    setError("");
    try {
      let res;
      if (ev.platform !== "qq") {
        res = await platformTaggingAPI.approve(ev.eventId, pick.externalId);
      } else {
        const browserResult = await qqTagWrites.approveLike({ id: pick.externalId, songType: pick.songType });
        res = await platformTaggingAPI.approve(ev.eventId, pick.externalId, browserResult);
      }
      upsert(res.data);
    } catch (err) {
      const m = failMessage(err);
      if (m) setError(m);
      refetch();
    } finally {
      settle(ev.eventId);
    }
  }, [optimistic, settle, upsert, refetch]);

  const ignore = useCallback(async (ev) => {
    optimistic(ev.eventId, { outcome: "ignored" });
    try {
      upsert((await platformTaggingAPI.ignore(ev.eventId)).data);
    } catch (err) {
      const m = failMessage(err);
      if (m) setError(m);
      refetch();
    } finally {
      settle(ev.eventId);
    }
  }, [optimistic, settle, upsert, refetch]);

  // Disarm the stop button if the second click never comes.
  useEffect(() => {
    if (!stopArmed) return undefined;
    const id = setTimeout(() => setStopArmed(false), 3000);
    return () => clearTimeout(id);
  }, [stopArmed]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await onStop();
    } finally {
      setBusy(false);
      setStopArmed(false);
    }
  }, [onStop]);

  // --- the pairing code, as on the playlist page: copy, and a countdown ---
  const client = connection?.client || "waiting";
  const [pairLeft, setPairLeft] = useState(0);
  const pairCode = pairLeft > 0 ? connection?.pairCode || null : null;
  useEffect(() => {
    const until = connection?.pairExpiresAt ? new Date(connection.pairExpiresAt).getTime() : 0;
    if (!until || !connection?.pairCode) { setPairLeft(0); return undefined; }
    const tick = () => setPairLeft(Math.max(0, Math.floor((until - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [connection?.pairExpiresAt, connection?.pairCode]);
  const [copied, setCopied] = useState(false);
  const copyPairCode = useCallback(async () => {
    if (!pairCode) return;
    try {
      await navigator.clipboard.writeText(pairCode);
    } catch {
      // No clipboard outside a secure context: the old way.
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
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  // A restored row that is settled stays out of the list (the playlist page
  // does not bring its receipts back after a reload) -- unless acted on here.
  const shown = events.filter((e) => !e.restored || ACTIONABLE.has(e.outcome)
    || e.outcome === "failed" || e.outcome === "no_match" || inFlight.has(e.eventId));
  const pending = shown.filter((e) => ACTIONABLE.has(e.outcome));
  const settled = shown.filter((e) => LIKED.has(e.outcome) || e.outcome === "ignored");
  const failed = shown.filter((e) => e.outcome === "failed");
  const unmatched = shown.filter((e) => e.outcome === "no_match");
  // Totals count the whole run, shown or not.
  const caught = events.length;
  const tagged = events.filter((e) => LIKED.has(e.outcome)).length;
  const waitingPending = events.filter((e) => ACTIONABLE.has(e.outcome)).length;
  const failedCount = events.filter((e) => e.outcome === "failed").length;
  // Captured while the list was being read again, or being liked right now.
  const working = events.filter((e) => e.outcome === "unread" || e.outcome === "matching").length;

  return (
    <div
      ref={drag.ref}
      {...drag.dragProps}
      style={drag.style}
      data-qqtag-panel
      className="pointer-events-none fixed bottom-14 left-2 right-2 z-40 block touch-none sm:bottom-28 sm:left-auto sm:right-4 sm:w-[360px]"
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
          <span className="text-xs font-medium text-theme">打标中</span>
          <span className="text-xs text-muted">
            {caught} 抓到
            {" · "}
            <span className="text-green-400">{tagged} 已打标</span>
            {waitingPending > 0 && <> · <span className="text-amber-400">{waitingPending} 待确认</span></>}
            {failedCount > 0 && <> · <span className="text-red-400">{failedCount} 打标失败</span></>}
            {working > 0 && <> · <span className="text-amber-400">{working} 处理中</span></>}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setOpen((v) => !v)}
              className="rounded px-2.5 py-1.5 text-xs text-muted hover:bg-surface-hover sm:px-1.5 sm:py-0.5"
            >
              {open ? "▼" : "▲"}
            </button>
            <button
              onClick={() => (stopArmed ? stop() : setStopArmed(true))}
              disabled={busy}
              className={`ml-2 rounded px-3 py-1.5 text-xs text-white transition-colors disabled:opacity-50 sm:px-2 sm:py-0.5 ${
                stopArmed ? "bg-red-500 ring-2 ring-red-300" : "bg-red-600/90 hover:bg-red-600"
              }`}
            >
              {stopArmed ? "再点一次停止" : "停止"}
            </button>
          </div>
        </div>

        {/* client liveness — the reason an empty list is empty */}
        {client !== "connected" && (
          <div className="border-b border-border bg-amber-500/10 px-3 py-1.5">
            <p className="text-[11px] text-amber-400">
              ⚠ {client === "waiting" ? "等待打标 App 连接" : "打标 App 可能已断开"}
            </p>
            {client === "waiting" && (
              <p className="text-[11px] text-muted">模拟器开了吗？APK 启动了吗？token 填了吗？</p>
            )}
          </div>
        )}
        {client === "connected" && events.length === 0 && (
          <div className="border-b border-border px-3 py-1.5">
            <p className="text-[11px] text-green-400">🟢 打标 App 已连接</p>
          </div>
        )}

        {open && (
          <>
            {/* Pairing code — only until the client connects */}
            {pairCode && client !== "connected" && (
              <div className="border-b border-border px-3 py-2">
                <p className="mb-1 text-[11px] text-muted">在 Q你一下 App 里输入这个配对码：</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={copyPairCode}
                    title="点击复制"
                    className="rounded bg-black/30 px-3 py-1 font-mono text-lg tracking-[0.3em] text-theme transition-colors hover:bg-black/50"
                  >
                    {pairCode}
                  </button>
                  <span className={`text-[11px] ${copied ? "text-green-400" : "text-muted"}`}>
                    {copied ? "已复制" : "点击复制"}
                  </span>
                  <span className="ml-auto text-[11px] text-muted">
                    {Math.floor(pairLeft / 60)}:{String(pairLeft % 60).padStart(2, "0")}
                  </span>
                </div>
              </div>
            )}

            {/* work list */}
            <div className="max-h-[35vh] overflow-y-auto sm:max-h-[45vh]">
              {pending.length === 0 && settled.length === 0 && failed.length === 0 && unmatched.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-muted">
                  {working > 0 ? "处理中…" : "还没抓到内容"}
                </p>
              )}

              {/* Failures first: they need action and never go away on their own. */}
              {failed.map((e) => (
                <FailedRow key={e.eventId} event={e} onRetry={() => approve(e, null, { retry: true })} onIgnore={() => ignore(e)} />
              ))}

              <SettledList events={settled} />

              {pending.map((e) => (
                <CaptureRow
                  key={e.eventId}
                  event={e}
                  onApprove={(externalId) => approve(e, externalId)}
                  onIgnore={() => ignore(e)}
                />
              ))}

              {unmatched.length > 0 && (
                <>
                  <p className="border-t border-border px-3 pb-1 pt-2 text-[11px] font-medium text-muted">
                    匹配不到 ({unmatched.length})
                  </p>
                  {unmatched.map((e) => (
                    <UnmatchedRow key={e.eventId} event={e} onDismiss={() => ignore(e)} />
                  ))}
                </>
              )}
            </div>
          </>
        )}

        {error && <p className="border-t border-border px-3 py-1.5 text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}

// --- below: the playlist panel's rows, copied (see the top of this file) ---------

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
 * Settled songs, laid out the way the game shows them: the two 2v2 candidate
 * lists side by side, red row N beside blue row N. One full-width list when no
 * row carries a side (older clients, modes with one list).
 */
function SettledList({ events }) {
  const ordered = [...events].reverse();
  const hasSide = ordered.some((e) => e.side === "red" || e.side === "blue");

  const boxRef = useRef(null);
  // Start true so the first songs land already scrolled to the newest.
  const atBottomRef = useRef(true);

  // Follow the newest only when the viewer is already at the bottom.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && atBottomRef.current) box.scrollTop = box.scrollHeight;
  });

  const onScroll = (e) => {
    const el = e.currentTarget;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  };

  const inner = hasSide ? (() => {
    const rows = settledRows(events);
    return (
      <div className="grid grid-cols-2 gap-px border-b border-border/50 bg-border/30">
        <div className="bg-surface">
          <ColumnHeader label="红队" tone="text-red-400" />
          {rows.map((r, i) => (
            <CompactAutoRow key={r.red ? r.red.eventId : `red-gap-${i}`} event={r.red} />
          ))}
        </div>
        <div className="bg-surface">
          <ColumnHeader label="蓝队" tone="text-blue-400" />
          {rows.map((r, i) => (
            <CompactAutoRow key={r.blue ? r.blue.eventId : `blue-gap-${i}`} event={r.blue} />
          ))}
        </div>
      </div>
    );
  })() : ordered.map((e) => <AutoRow key={e.eventId} event={e} />);

  // ~5 rows tall, so the settled history never pushes the work out of view.
  return (
    <div ref={boxRef} onScroll={onScroll} className="max-h-[130px] overflow-y-auto">
      {inner}
    </div>
  );
}

/** Settled songs as display rows, oldest first (`events` arrives newest first). */
function settledRows(events) {
  const ordered = [...events].reverse();
  // Anything without a side still has to appear; it goes with the reds.
  return alignRows(
    ordered.filter((e) => e.side !== "blue"),
    ordered.filter((e) => e.side === "blue"),
  );
}

/**
 * Pair the two columns up into rows: by the game's row index when there is
 * one (a team missing that row leaves a gap), else side by side in arrival
 * order. A second title on an index already taken gets a line of its own --
 * a song must never be dropped from the panel.
 */
function alignRows(red, blue) {
  const hasRow = (e) => Number.isInteger(e.row);
  const aligned = red.some(hasRow) || blue.some(hasRow);

  if (!aligned) {
    const n = Math.max(red.length, blue.length);
    return Array.from({ length: n }, (_, i) => ({ red: red[i] || null, blue: blue[i] || null }));
  }

  const placed = new Set();
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
  for (const e of red) if (!placed.has(e)) rows.push({ red: e, blue: null });
  for (const e of blue) if (!placed.has(e)) rows.push({ red: null, blue: e });
  return rows;
}

function ColumnHeader({ label, tone }) {
  return (
    <p className={`sticky top-0 z-10 bg-surface px-2 pb-0.5 pt-1 text-[10px] font-medium ${tone}`}>{label}</p>
  );
}

/** Green: liked on its own (or already liked); amber: confirmed by hand; grey: set aside. */
function toneOf(event) {
  if (event.outcome === "ignored") return "text-muted";
  if (event.byHand) return "bg-amber-500/10 text-theme";
  return "bg-green-500/5 text-theme";
}

/** A song inside a column. A gap holds the row when this team has nothing there. */
function CompactAutoRow({ event }) {
  if (!event) {
    return (
      <p aria-hidden className="px-2 py-1 text-[11px] leading-tight">
        &nbsp;
      </p>
    );
  }
  const title = cleanTitle(event.rawText);
  return (
    <p title={title} className={`truncate px-2 py-1 text-[11px] leading-tight ${toneOf(event)}`}>
      {title}
      {/* QQ only: it was in 我喜欢 already, nothing was written. */}
      {event.outcome === "already_liked" && <span className="text-muted"> · 已喜欢</span>}
    </p>
  );
}

/** Which of the 2v2 candidate lists a title was read from; nothing when unknown. */
function SideDot({ side }) {
  if (side !== "red" && side !== "blue") return null;
  return (
    <span
      title={side}
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${side === "red" ? "bg-red-400" : "bg-blue-400"}`}
    />
  );
}

/** A title that matched nothing in the playlist. 手动打标 crosses it off. */
function UnmatchedRow({ event, onDismiss }) {
  return (
    <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
      <SideDot side={event.side} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-gray-500">{cleanTitle(event.rawText)}</p>
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-muted hover:bg-surface-hover hover:text-theme sm:py-0.5"
      >
        手动打标
      </button>
    </div>
  );
}

/** A like that failed: stays until retried or set aside. QQ's reason under it. */
function FailedRow({ event, onRetry, onIgnore }) {
  return (
    <div className="border-b border-border/50 bg-red-500/10 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-red-400">✕</span>
        <SideDot side={event.side} />
        <p className="min-w-0 flex-1 truncate text-sm text-theme">{cleanTitle(event.rawText)}</p>
        <button
          onClick={onRetry}
          className="shrink-0 rounded bg-primary px-3 py-1.5 text-xs text-white hover:opacity-90 sm:px-2 sm:py-0.5"
        >
          重试
        </button>
        <button
          onClick={onIgnore}
          className="shrink-0 rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover sm:px-2 sm:py-0.5"
        >
          忽略
        </button>
      </div>
      {event.error && <p className="mt-0.5 truncate pl-5 text-[11px] text-red-400" title={event.error}>{event.error}</p>}
    </div>
  );
}

/** A settled song in the one-column list (no team information). */
function AutoRow({ event }) {
  const ignored = event.outcome === "ignored";
  return (
    <div className={`flex items-center gap-2 border-b border-border/50 px-3 py-2 ${ignored ? "" : event.byHand ? "bg-amber-500/10" : "bg-green-500/5"}`}>
      <span className={`shrink-0 text-xs ${ignored ? "text-muted" : "text-green-400"}`}>{ignored ? "–" : "✓"}</span>
      <SideDot side={event.side} />
      <p className={`min-w-0 flex-1 truncate text-sm ${ignored ? "text-muted" : "text-theme"}`}>{cleanTitle(event.rawText)}</p>
      <span className={`shrink-0 text-[11px] ${ignored ? "text-muted" : "text-green-400"}`}>
        {ignored ? "已忽略" : event.outcome === "already_liked" ? "已喜欢" : event.byHand ? "已确认" : "已自动确认"}
      </span>
    </div>
  );
}

/** One captured title and what it matched: 确认 / 忽略, or pick one of several. */
function CaptureRow({ event, onApprove, onIgnore }) {
  const cands = event.candidates || [];
  const single = event.outcome === "pending" && cands.length === 1;

  return (
    <div className="border-b border-border/50 px-3 py-2">
      <p className="flex items-center gap-1.5 truncate text-xs text-muted">
        <SideDot side={event.side} />
        {cleanTitle(event.rawText)}
      </p>
      {/* QQ only: why it waits (e.g. tried again on its own). */}
      {event.error && <p className="truncate text-[11px] text-amber-400" title={event.error}>{event.error}</p>}

      {single ? (
        <div className="mt-1 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-theme">{cands[0].title}</p>
            {cands[0].kind !== "exact" && cands[0].note && (
              <p className="truncate text-[11px] text-amber-400">⚠ {cands[0].note}</p>
            )}
          </div>
          <button
            onClick={() => onApprove(cands[0].externalId)}
            className="shrink-0 rounded bg-primary px-3 py-1.5 text-xs text-white hover:opacity-90 sm:px-2 sm:py-0.5"
          >
            确认
          </button>
          <button
            onClick={onIgnore}
            className="shrink-0 rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover sm:px-2 sm:py-0.5"
          >
            忽略
          </button>
        </div>
      ) : (
        <div className="mt-1">
          <p className="mb-1 text-[11px] text-amber-400">选一个</p>
          {cands.map((c) => (
            <button
              key={c.externalId}
              onClick={() => onApprove(c.externalId)}
              className="mb-1 block w-full truncate rounded border border-border px-2 py-2 text-left text-xs text-theme hover:bg-surface-hover sm:py-1"
            >
              {c.title}
              {/* The artist, only when there is more than one to tell apart. */}
              {cands.length > 1 && <span className="text-muted"> · {c.artist}</span>}
            </button>
          ))}
          <button onClick={onIgnore} className="text-[11px] text-muted hover:text-theme">
            忽略
          </button>
        </div>
      )}
    </div>
  );
}
