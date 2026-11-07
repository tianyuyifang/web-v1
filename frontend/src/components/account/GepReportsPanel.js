"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { gepReportsAPI } from "@/lib/api";

/**
 * 歌P战报 — what each 歌P run saw, for the last 7 days.
 *
 * A report is fixed once its run is over: the songs, and which of them the
 * list was missing, stay as they were that game. Adding songs from it does
 * not change it — the point is a list to work from later.
 *
 * Renaming a song only changes this report (it is a note for looking the song
 * up); the singer, when set, picks among same-named songs in the catalogue.
 */

const SOURCE_LABEL = { site: "网站歌单", qq: "QQ 歌单", netease: "网易云歌单" };
const POLL_MS = 10000;

function errMsg(err, fallback) {
  return err?.response?.data?.error?.message || fallback;
}

function hm(d) {
  const x = new Date(d);
  return `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`;
}

function dayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
}

function dayLabel(d) {
  const x = new Date(d);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (dayKey(x) === dayKey(today)) return "今天";
  if (dayKey(x) === dayKey(yesterday)) return "昨天";
  return `${x.getMonth() + 1}月${x.getDate()}日`;
}

export default function GepReportsPanel({ initialReportId = null }) {
  const [openId, setOpenId] = useState(initialReportId === "latest" ? null : initialReportId);
  const [resolving, setResolving] = useState(initialReportId === "latest");

  // 查看本局战报 links here with "latest": open the newest report straight away.
  useEffect(() => {
    if (initialReportId !== "latest") return;
    let cancelled = false;
    gepReportsAPI.latest()
      .then((res) => { if (!cancelled && res.data.id) setOpenId(res.data.id); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setResolving(false); });
    return () => { cancelled = true; };
  }, [initialReportId]);

  if (resolving) return <p className="py-8 text-center text-sm text-muted">加载中…</p>;
  if (openId) return <ReportDetail id={openId} onBack={() => setOpenId(null)} />;
  return <ReportList onOpen={setOpenId} />;
}

function ReportList({ onOpen }) {
  const [reports, setReports] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    gepReportsAPI.list()
      .then((res) => { if (!cancelled) setReports(res.data.reports || []); })
      .catch((err) => { if (!cancelled) setError(errMsg(err, "战报加载失败")); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className="py-8 text-center text-sm text-red-400">{error}</p>;
  if (!reports) return <p className="py-8 text-center text-sm text-muted">加载中…</p>;

  const groups = [];
  for (const r of reports) {
    const label = dayLabel(r.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.reports.push(r);
    else groups.push({ label, reports: [r] });
  }

  return (
    <div>
      <p className="mb-4 text-xs text-muted">每一局歌P一份战报，保留最近 7 天。</p>
      {!reports.length && (
        <div className="rounded-xl border border-border bg-surface px-4 py-10 text-center text-sm text-muted">
          还没有战报。打一局歌P，结束后会出现在这里。
        </div>
      )}
      <div className="space-y-6">
        {groups.map((g) => (
          <div key={g.label}>
            <p className="mb-2 text-xs font-medium text-muted">{g.label}</p>
            <div className="space-y-2">
              {g.reports.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onOpen(r.id)}
                  className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-hover"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="shrink-0 text-sm tabular-nums text-muted">
                        {hm(r.startedAt)}{r.running ? "" : r.endedAt ? `–${hm(r.endedAt)}` : ""}
                      </span>
                      {r.singer ? <span className="truncate text-sm font-medium text-theme">{r.singer}</span> : null}
                      {r.running && (
                        <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">进行中</span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {SOURCE_LABEL[r.source] || "歌单"} · {r.playlistName} · 共 {r.total} 首
                    </p>
                  </div>
                  <span className={`shrink-0 text-sm font-medium ${r.missing ? "text-amber-500" : "text-muted"}`}>
                    {r.missing ? `歌单缺 ${r.missing} 首` : "歌单都有"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const RESULT_TEXT = {
  added: { text: "已加入", cls: "text-green-500" },
  exists: { text: "已在歌单", cls: "text-muted" },
  failed: { text: "加入失败", cls: "text-red-400" },
  not_found: { text: "没找到这首", cls: "text-red-400" },
  invalid: { text: "加入失败", cls: "text-red-400" },
};

function ReportDetail({ id, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(() => new Set());
  // Which catalogue song each row will add, where the user picked another.
  const [choice, setChoice] = useState(() => new Map());
  const [results, setResults] = useState(() => new Map());
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(null); // item id being renamed
  const [editText, setEditText] = useState("");
  const [singerEditing, setSingerEditing] = useState(false);
  const [singerText, setSingerText] = useState("");

  const load = useCallback(async () => {
    const res = await gepReportsAPI.get(id);
    setData(res.data);
    return res.data;
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => {
        if (cancelled) return;
        // The run's own playlist when it is the user's. A QQ run, or a list
        // someone shared, has none: the user picks every time -- the list
        // used last was for another singer's game.
        setDest(d.report.defaultPlaylistId || "");
      })
      .catch((err) => { if (!cancelled) setError(errMsg(err, "战报加载失败")); });
    return () => { cancelled = true; };
  }, [load]);

  // A run still going keeps filling in.
  const running = data?.report.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { load().catch(() => {}); }, POLL_MS);
    return () => clearInterval(t);
  }, [running, load]);

  const items = useMemo(() => data?.items || [], [data]);
  const counts = useMemo(() => ({
    all: items.length,
    missing: items.filter((i) => i.status === "missing").length,
    have: items.filter((i) => i.status === "have").length,
  }), [items]);
  const visible = useMemo(() => (
    filter === "all" ? items : items.filter((i) => i.status === filter)
  ), [items, filter]);
  const selectable = useCallback((i) => i.status === "missing" && i.lookup?.found, []);
  // Added (or found already there) from this page: not offered again.
  const isDone = (i) => results.get(i.id) === "added" || results.get(i.id) === "exists";
  const visibleSelectable = visible.filter((i) => selectable(i) && !isDone(i));
  const allVisibleSelected = visibleSelectable.length > 0 && visibleSelectable.every((i) => selected.has(i.id));

  if (error) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <p className="py-8 text-center text-sm text-red-400">{error}</p>
      </div>
    );
  }
  if (!data) return <p className="py-8 text-center text-sm text-muted">加载中…</p>;
  const { report, myPlaylists } = data;

  const toggle = (itemId) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
    return next;
  });

  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allVisibleSelected) visibleSelectable.forEach((i) => next.delete(i.id));
    else visibleSelectable.forEach((i) => next.add(i.id));
    return next;
  });

  const startRename = (item) => {
    setEditing(item.id);
    setEditText(item.title || item.rawText);
  };

  const saveRename = async (item) => {
    try {
      const res = await gepReportsAPI.rename(id, item.id, editText);
      const updated = res.data.item;
      setData((d) => ({ ...d, items: d.items.map((i) => (i.id === item.id ? updated : i)) }));
      setChoice((m) => { const n = new Map(m); n.delete(item.id); return n; });
      if (!updated.lookup?.found) setSelected((s) => { const n = new Set(s); n.delete(item.id); return n; });
      setEditing(null);
    } catch (err) {
      setNotice(errMsg(err, "改名失败"));
    }
  };

  const saveSinger = async () => {
    try {
      const res = await gepReportsAPI.setSinger(id, singerText);
      setData((d) => ({ ...d, ...res.data }));
      setChoice(new Map());
      setSingerEditing(false);
    } catch (err) {
      setNotice(errMsg(err, "保存失败"));
    }
  };

  const add = async () => {
    const picks = items
      .filter((i) => selected.has(i.id) && selectable(i) && !isDone(i))
      .map((i) => ({ itemId: i.id, songId: choice.get(i.id) || i.lookup.pick }));
    if (!picks.length || !dest) return;
    setBusy(true);
    setNotice("");
    try {
      const res = await gepReportsAPI.add(id, dest, picks);
      const rs = res.data.results || [];
      setResults((m) => { const n = new Map(m); rs.forEach((r) => n.set(r.itemId, r.result)); return n; });
      setSelected((s) => {
        const n = new Set(s);
        rs.forEach((r) => { if (r.result === "added" || r.result === "exists") n.delete(r.itemId); });
        return n;
      });
      const added = rs.filter((r) => r.result === "added").length;
      const exists = rs.filter((r) => r.result === "exists").length;
      const failed = rs.length - added - exists;
      const name = myPlaylists.find((p) => p.id === dest)?.name || "歌单";
      setNotice([
        added ? `已加入「${name}」${added} 首` : "",
        exists ? `${exists} 首已在歌单里` : "",
        failed ? `${failed} 首没加上` : "",
      ].filter(Boolean).join("，"));
    } catch (err) {
      setNotice(errMsg(err, "加入失败，请重试"));
    } finally {
      setBusy(false);
    }
  };

  const selectedCount = items.filter((i) => selected.has(i.id) && selectable(i) && !isDone(i)).length;
  const canAddAny = items.some(selectable);

  return (
    <div>
      <BackButton onBack={onBack} />

      {/* Header */}
      <div className="mb-4 rounded-xl border border-border bg-surface px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm tabular-nums text-muted">
            {dayLabel(report.startedAt)} {hm(report.startedAt)}{report.endedAt ? `–${hm(report.endedAt)}` : ""}
          </span>
          {report.running && (
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">进行中</span>
          )}
        </div>
        <p className="mt-1 text-sm text-theme">
          {SOURCE_LABEL[report.source] || "歌单"} · <span className="font-medium">{report.playlistName}</span>
        </p>
        <div className="mt-2 flex items-center gap-2 text-sm">
          <span className="text-muted">歌手</span>
          {singerEditing ? (
            <>
              <input
                value={singerText}
                onChange={(e) => setSingerText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveSinger(); if (e.key === "Escape") setSingerEditing(false); }}
                maxLength={64}
                autoFocus
                className="w-40 min-w-0 rounded border border-border bg-background px-2 py-1 text-base text-theme focus:border-primary focus:outline-none sm:text-sm"
              />
              <button type="button" onClick={saveSinger} className="text-primary hover:underline">保存</button>
              <button type="button" onClick={() => setSingerEditing(false)} className="text-muted hover:underline">取消</button>
            </>
          ) : (
            <>
              <span className={report.singer ? "text-theme" : "text-muted"}>{report.singer || "未记录"}</span>
              <button
                type="button"
                onClick={() => { setSingerText(report.singer || ""); setSingerEditing(true); }}
                className="text-xs text-primary hover:underline"
              >
                修改
              </button>
            </>
          )}
        </div>
        {report.singer ? (
          <p className="mt-1 text-xs text-muted">同名的歌优先找这位歌手的。</p>
        ) : null}
      </div>

      {/* Filter */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {[
          { key: "all", label: `全部 ${counts.all}` },
          { key: "missing", label: `缺的歌 ${counts.missing}` },
          { key: "have", label: `已有 ${counts.have}` },
        ].map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`rounded-full border px-3 py-1 text-sm transition-colors ${
              filter === f.key
                ? "border-primary bg-primary/15 text-primary"
                : "border-border text-muted hover:text-theme"
            }`}
          >
            {f.label}
          </button>
        ))}
        {visibleSelectable.length > 0 && (
          <button type="button" onClick={toggleAll} className="ml-auto text-sm text-primary hover:underline">
            {allVisibleSelected ? "取消全选" : "全选"}
          </button>
        )}
      </div>

      {/* Songs, in the order the game showed them */}
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {!visible.length && (
          <p className="px-4 py-8 text-center text-sm text-muted">
            {filter === "missing" ? "这一局歌单都有。" : "这一局还没有识别到歌。"}
          </p>
        )}
        {visible.map((item) => {
          const idx = items.indexOf(item) + 1;
          const result = results.get(item.id);
          const found = item.lookup?.found;
          // Once in the playlist there is nothing left to pick it for.
          const canPick = selectable(item) && !isDone(item);
          return (
            <div key={item.id} className="flex gap-3 border-b border-border px-3 py-2.5 last:border-0 sm:px-4">
              <div className="flex w-5 shrink-0 justify-center pt-0.5">
                {canPick ? (
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    aria-label={`选择 ${item.title || item.rawText}`}
                    className="h-4 w-4 accent-primary"
                  />
                ) : null}
              </div>
              <span className="w-6 shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted">{idx}</span>
              <div className="min-w-0 flex-1">
                {editing === item.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveRename(item); if (e.key === "Escape") setEditing(null); }}
                      maxLength={100}
                      autoFocus
                      className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-base text-theme focus:border-primary focus:outline-none sm:text-sm"
                    />
                    <button type="button" onClick={() => saveRename(item)} className="text-sm text-primary hover:underline">确定</button>
                    <button type="button" onClick={() => setEditing(null)} className="text-sm text-muted hover:underline">取消</button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="break-all text-sm text-theme">{item.title || item.rawText}</span>
                    {item.title ? <span className="text-xs text-muted">原：{item.rawText}</span> : null}
                  </div>
                )}
                {item.status === "missing" && editing !== item.id && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    {found ? (
                      item.lookup.options.length > 1 ? (
                        <select
                          value={choice.get(item.id) || item.lookup.pick}
                          onChange={(e) => setChoice((m) => new Map(m).set(item.id, e.target.value))}
                          className="max-w-full rounded border border-border bg-background px-1 py-0.5 text-base text-muted sm:text-xs"
                        >
                          {item.lookup.options.map((o) => (
                            <option key={o.songId} value={o.songId}>
                              {o.title} — {o.artist.replace(/_/g, "/")}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-muted">
                          曲库：{item.lookup.options[0].title} — {item.lookup.options[0].artist.replace(/_/g, "/")}
                        </span>
                      )
                    ) : (
                      <span className="text-red-400">曲库没找到，可能歌名不对</span>
                    )}
                    <button type="button" onClick={() => startRename(item)} className="text-primary hover:underline">
                      改名
                    </button>
                  </div>
                )}
              </div>
              <div className="shrink-0 pt-0.5 text-right text-xs">
                {result ? (
                  <span className={RESULT_TEXT[result]?.cls || "text-muted"}>{RESULT_TEXT[result]?.text || ""}</span>
                ) : item.status === "missing" ? (
                  <span className="text-amber-500">歌单缺</span>
                ) : item.status === "have" ? (
                  <span className="text-muted">已有</span>
                ) : (
                  <span className="text-muted">未判断</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {notice && <p className="mt-3 text-sm text-theme">{notice}</p>}

      {/* Add bar: stays at the bottom of the screen while the list scrolls */}
      {canAddAny && (
        <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-border bg-surface px-4 py-3 sm:mx-0 sm:rounded-xl sm:border">
          {myPlaylists.length ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">已选 {selectedCount} 首</span>
              <span className="text-sm text-muted">加入</span>
              <select
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                className="min-w-0 max-w-[14rem] flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-base text-theme focus:border-primary focus:outline-none sm:flex-none sm:text-sm"
              >
                <option value="">选择歌单…</option>
                {myPlaylists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button
                type="button"
                onClick={add}
                disabled={busy || !selectedCount || !dest}
                className="ml-auto rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
              >
                {busy ? "加入中…" : "加入歌单"}
              </button>
            </div>
          ) : (
            <p className="text-sm text-muted">
              你在网站上还没有歌单，<Link href="/playlists/new" className="text-primary underline">先新建一个</Link>再来加。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function BackButton({ onBack }) {
  return (
    <button type="button" onClick={onBack} className="mb-4 text-sm text-primary hover:underline">
      ← 全部战报
    </button>
  );
}
