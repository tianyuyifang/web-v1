"use client";

/**
 * The live feed of a 平台打标 run.
 *
 * Four groups, nothing plays: 已点赞 (auto or approved, plus songs that were
 * already in 我喜欢), 待确认 (a match that was not exact — approve or ignore),
 * 未匹配 (dismiss), 失败 (the platform refused — retry or ignore). Rows come
 * over SSE while the run lasts and from the feed endpoint on load, so a
 * reload shows the same panel.
 *
 * Deliberately its own component rather than a mode of CapturePanel: that
 * panel likes into our playlists and is shared by every playlist page, and a
 * prop that changed its meaning would be a change to it. Copying the shape
 * and leaving it alone is the cheaper kind of "no impact".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { platformTaggingAPI, getPlatformTagSSEUrl } from "@/lib/api";

const LIKED = new Set(["liked", "already_liked"]);
const ACTIONABLE = new Set(["pending", "ambiguous"]);

export default function PlatformTagPanel({ sessionId, onLiked }) {
  const [events, setEvents] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  // Unmatched rows the user swiped away. Local only: the server keeps the row
  // (it is what the run saw), the user just does not want to look at it.
  const [dismissed, setDismissed] = useState(() => new Set());
  const esRef = useRef(null);

  const upsert = useCallback((row) => {
    setEvents((prev) => {
      const rest = prev.filter((x) => x.eventId !== row.eventId);
      return [...rest, row].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    });
    if (LIKED.has(row.outcome) && row.likedExternalId && onLiked) onLiked(row.likedExternalId);
  }, [onLiked]);

  // The stream first, then the snapshot -- taken once the stream is open, so
  // nothing can fall between them. Snapshot-then-subscribe left a gap: a
  // capture broadcast after the feed query and before addClient registered
  // was in neither. Re-taken on every (re)open for the same reason.
  useEffect(() => {
    if (!sessionId) return undefined;
    let alive = true;
    const loadFeed = () => {
      platformTaggingAPI.feed(sessionId)
        .then((res) => {
          if (!alive) return;
          const rows = res.data.events || [];
          setEvents((prev) => {
            // Merge rather than replace: a row the stream delivered while the
            // snapshot was in flight must not be rubbed out by it.
            const byId = new Map(rows.map((r) => [r.eventId, r]));
            prev.forEach((r) => { if (!byId.has(r.eventId)) byId.set(r.eventId, r); });
            return [...byId.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
          });
          rows.forEach((r) => {
            if (LIKED.has(r.outcome) && r.likedExternalId && onLiked) onLiked(r.likedExternalId);
          });
        })
        .catch(() => {});
    };

    const es = new EventSource(getPlatformTagSSEUrl(sessionId));
    esRef.current = es;
    es.addEventListener("open", loadFeed);
    // The server could not read the playlist (a lapsed platform login, most
    // likely). Captures are being refused meanwhile; say so, here, where the
    // user is looking.
    es.addEventListener("platform-tag-error", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.sessionId && data.sessionId !== sessionId) return;
        setError(data.message || "读取歌单失败");
      } catch {
        /* malformed */
      }
    });
    es.addEventListener("platform-tag-event", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.outcome === "duplicate") return;
        if (data.sessionId && data.sessionId !== sessionId) return;
        upsert(data);
      } catch {
        /* malformed */
      }
    });
    return () => {
      alive = false;
      es.close();
      esRef.current = null;
    };
  }, [sessionId, upsert, onLiked]);

  const act = useCallback(async (eventId, fn) => {
    setBusyId(eventId);
    setError("");
    try {
      const res = await fn();
      upsert(res.data);
    } catch (err) {
      setError(err.response?.data?.error?.message || "操作失败");
      // A failed approve is written server-side as `failed`; pull it so the
      // row moves to the right column even when the response was the error.
      platformTaggingAPI.feed(sessionId).then((r) => setEvents(r.data.events || [])).catch(() => {});
    } finally {
      setBusyId(null);
    }
  }, [sessionId, upsert]);

  const approve = (ev, externalId) =>
    act(ev.eventId, () => platformTaggingAPI.approve(ev.eventId, externalId));
  const ignore = (ev) => act(ev.eventId, () => platformTaggingAPI.ignore(ev.eventId));

  const liked = events.filter((e) => LIKED.has(e.outcome));
  const pending = events.filter((e) => ACTIONABLE.has(e.outcome));
  const failed = events.filter((e) => e.outcome === "failed");
  const unmatched = events.filter((e) => e.outcome === "no_match" && !dismissed.has(e.eventId));
  const ignored = events.filter((e) => e.outcome === "ignored").length;

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span>抓到 <b className="text-theme">{events.length}</b></span>
        <span>已点赞 <b className="text-green-400">{liked.length}</b></span>
        <span>待确认 <b className="text-yellow-400">{pending.length}</b></span>
        <span>未匹配 <b>{unmatched.length}</b></span>
        {failed.length > 0 && <span>失败 <b className="text-red-400">{failed.length}</b></span>}
        {ignored > 0 && <span>已忽略 {ignored}</span>}
      </div>

      {error && <div className="mb-3 text-xs text-red-400">{error}</div>}

      {events.length === 0 && (
        <p className="py-6 text-center text-sm text-muted">
          还没抓到歌。打开游戏，客户端连接后歌名会出现在这里。
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Column title="待确认" tone="text-yellow-400" rows={[...failed, ...pending].reverse()} empty="—">
          {(ev) => (
            <PendingRow
              event={ev}
              busy={busyId === ev.eventId}
              onApprove={(externalId) => approve(ev, externalId)}
              onIgnore={() => ignore(ev)}
            />
          )}
        </Column>
        <Column title="已点赞" tone="text-green-400" rows={[...liked].reverse()} empty="—">
          {(ev) => <LikedRow event={ev} />}
        </Column>
        <Column title="未匹配" tone="text-muted" rows={[...unmatched].reverse()} empty="—">
          {(ev) => (
            <div className="flex items-center justify-between gap-2 py-1 text-sm">
              <span className="min-w-0 truncate text-muted" title={ev.rawText}>{ev.rawText}</span>
              <button
                type="button"
                onClick={() => setDismissed((d) => new Set(d).add(ev.eventId))}
                className="shrink-0 text-xs text-muted hover:text-theme"
                title="从列表划掉"
              >✕</button>
            </div>
          )}
        </Column>
        <Column title="说明" tone="text-muted" rows={[]} empty="">
          {() => null}
          <ul className="space-y-1 text-xs text-muted">
            <li>· 歌名和歌单里完全一致的，自动点进你平台账号的「我喜欢」。</li>
            <li>· 差括号、差标点、被省略号截断的，列在待确认，由你决定。</li>
            <li>· 已经在「我喜欢」里的，标为「已喜欢」，不重复点。</li>
            <li>· 这里没有撤销；点错了请到平台里取消。</li>
          </ul>
        </Column>
      </div>
    </div>
  );
}

function Column({ title, tone, rows, empty, children }) {
  const render = Array.isArray(children) ? children[0] : children;
  const extra = Array.isArray(children) ? children.slice(1) : null;
  return (
    <section className="min-w-0">
      <h3 className={`mb-1.5 text-xs font-semibold uppercase tracking-wide ${tone}`}>
        {title}{rows.length ? ` · ${rows.length}` : ""}
      </h3>
      <div className="max-h-[50vh] overflow-y-auto divide-y divide-border/40 pr-1">
        {rows.length === 0 && empty ? <p className="py-1 text-xs text-muted">{empty}</p> : null}
        {rows.map((ev) => <div key={ev.eventId}>{render(ev)}</div>)}
        {extra}
      </div>
    </section>
  );
}

function LikedRow({ event }) {
  const c = (event.candidates || [])[0];
  return (
    <div className="py-1.5 text-sm">
      <div className="flex items-center gap-1.5">
        <span className="text-green-400">♥</span>
        <span className="min-w-0 truncate" title={c?.title}>{c?.title || event.rawText}</span>
        {event.outcome === "already_liked" && (
          <span className="shrink-0 rounded bg-white/10 px-1 text-[0.65rem] text-muted">已喜欢</span>
        )}
      </div>
      {c?.artist && <div className="truncate pl-5 text-xs text-muted">{c.artist}</div>}
      {c?.title && c.title !== event.rawText && (
        <div className="truncate pl-5 text-[0.65rem] text-muted/70">抓到：{event.rawText}</div>
      )}
    </div>
  );
}

function PendingRow({ event, busy, onApprove, onIgnore }) {
  const cands = event.candidates || [];
  const isFailed = event.outcome === "failed";
  return (
    <div className="py-2 text-sm">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium" title={event.rawText}>{event.rawText}</div>
          {isFailed && (
            <div className="text-xs text-red-400">点赞失败：{event.error || "平台未接受"}</div>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onIgnore}
          className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted hover:text-theme disabled:opacity-40"
        >忽略</button>
      </div>
      <div className="space-y-1">
        {cands.map((c) => (
          <div key={c.externalId} className="flex items-center justify-between gap-2 rounded bg-black/10 px-2 py-1">
            <div className="min-w-0">
              <div className="truncate text-sm" title={c.title}>{c.title}</div>
              <div className="truncate text-xs text-muted">
                {c.artist}{c.kind && c.kind !== "exact" ? ` · ${KIND_LABEL[c.kind] || c.kind}` : ""}
              </div>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => onApprove(c.externalId)}
              className="shrink-0 rounded bg-accent px-2 py-0.5 text-xs font-medium text-black disabled:opacity-40"
            >{isFailed ? "重试" : "点赞"}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

const KIND_LABEL = {
  bracket: "括号不同",
  punct: "标点不同",
  ellipsis: "被省略",
  loose: "近似",
};
