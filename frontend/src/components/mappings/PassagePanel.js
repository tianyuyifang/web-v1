"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mappingAPI } from "@/lib/api";

/**
 * The real lines one answer entry covers.
 *
 * An entry is a line index, or a list of them where the platform wrote as
 * several lines what the game showed as one; -1 means no counterpart.
 */
function entryLines(v) {
  if (Array.isArray(v)) return v.filter((n) => n >= 0);
  return v >= 0 ? [v] : [];
}

/** One entry: a line index, a non-empty list of them, or -1. */
function entryOk(e) {
  return Number.isInteger(e)
    || (Array.isArray(e) && e.length > 0 && e.every(Number.isInteger));
}

/**
 * An answer is one placement, or a list of them — a passage is usually sung
 * more than once. Unambiguous: a placement's entries are numbers or lists of
 * numbers, so [[63,64],65] can only be one placement whose first line spans two.
 */
function placementsOf(answer) {
  if (!Array.isArray(answer) || !answer.length) return [];
  const several = answer.every((p) => Array.isArray(p) && p.length && p.every(entryOk));
  return several ? answer : [answer];
}

/** How a placement is written in the box: 63+64,65,66 */
function placementText(place) {
  return place.map((v) => (Array.isArray(v) ? v.join('+') : v)).join(',');
}

/**
 * The queue of proposed lyric-passage answers.
 *
 * The 唱卡 page matches a passage against the real lyrics on its own and gets
 * most of it right. What it cannot do is see that the two sides break lines
 * differently — the game's 「那个傻瓜说的傻话」 is the platform's 「那个傻瓜」
 * plus 「说的傻话」 — so those answers are worked out separately and land here
 * for a person to confirm.
 *
 * Nothing in this queue affects anybody until it is approved: the page ignores
 * a pending row entirely and runs its matcher, exactly as it does today.
 *
 * Each row shows the three things needed to judge it — the passage as the game
 * showed it, the answer being proposed, and the real lyrics with the proposed
 * lines marked — so the decision can be made without leaving the page.
 */
export default function PassagePanel() {
  const [status, setStatus] = useState("pending");
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({ pending: 0, approved: 0, unmatchable: 0 });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  // Which row is open. Only one at a time: the real lyrics run to dozens of
  // lines and several expanded at once is unreadable.
  const [openId, setOpenId] = useState(null);
  // Edited answers, keyed by row id, as the raw text the reviewer typed.
  const [drafts, setDrafts] = useState({});
  // Only redirect on the very first load, never after the reviewer chooses.
  const firstLoad = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, c] = await Promise.all([
        mappingAPI.passages({ status, take: 50 }),
        mappingAPI.passageCounts(),
      ]);
      setItems(list.data.items || []);
      setCounts(c.data || {});
      // Land somewhere with something on it. 待确认 is the tab that wants
      // working through, so it leads — but arriving at an empty queue when
      // there are confirmed rows to see reads as "nothing here at all".
      if (!firstLoad.current) {
        firstLoad.current = true;
        const n = c.data || {};
        if (status === 'pending' && !n.pending && n.approved) setStatus('approved');
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || "读取失败");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  async function decide(row, next) {
    setBusyId(row.id);
    setError(null);
    try {
      const raw = drafts[row.id];
      // Only send an answer when the reviewer actually edited one; otherwise the
      // stored answer stands and only the status changes.
      let answer;
      if (raw !== undefined && next !== "unmatchable") {
        // Checked here rather than left to the server, because half-typed text
        // is the ordinary state of an input: a trailing comma, or a pause after
        // one, parses to NaN and came back as an unexplained failure.
        // One line per occurrence. Within a line: one entry per game line,
        // comma separated; an entry may be several line numbers joined by "+",
        // for where the platform wrote as two lines what the game showed as one
        // — 「你是一只飞鸟飞上我的树梢」 is 「你是一只飞鸟」 plus 「飞上我的树梢」.
        const blocks = raw.split(/\n+/).map((b) => b.trim()).filter(Boolean);
        const parsedPlaces = blocks.map((block) => block
          .split(",").map((s) => s.trim()).filter((s) => s !== "")
          .map((part) => {
            const nums = part.split("+").map((s) => Number(s.trim()));
            return nums.length === 1 ? nums[0] : nums;
          }));

        for (let bi = 0; bi < parsedPlaces.length; bi += 1) {
          const place = parsedPlaces[bi];
          const where = parsedPlaces.length > 1 ? `第 ${bi + 1} 处：` : "";
          const flat = place.flat();
          if (flat.some((n) => !Number.isInteger(n) || n < -1)) {
            setError(`${where}只能是整数，逗号分隔；一行对应多行时用 + 连接，如 63+64`);
            return;
          }
          if (place.length !== row.gameLines.length) {
            setError(`${where}要有 ${row.gameLines.length} 项，现在是 ${place.length} 项`);
            return;
          }
          // Each occurrence is sung as a run, so its own lines must be adjacent.
          // The gaps between occurrences are the verses in between, and are fine.
          const covered = [...new Set(flat.filter((n) => n >= 0))].sort((a, b) => a - b);
          if (covered.length && covered[covered.length - 1] - covered[0] !== covered.length - 1) {
            setError(`${where}标到了 ${covered.join(",")}，中间断开了。一段词是连着唱的，行号必须连续`);
            return;
          }
        }
        if (!parsedPlaces.length) { setError("答案不能为空"); return; }
        answer = parsedPlaces.length === 1 ? parsedPlaces[0] : parsedPlaces;
      }
      const res = await mappingAPI.decidePassage(row.id, {
        status: next, ...(answer ? { answer } : {}),
      });
      if (next === status) {
        // Still belongs on this tab — saving an edit without changing state.
        // Removing it here would read as the row having been lost.
        setItems((prev) => prev.map((r) => (
          r.id === row.id
            ? { ...r, answer: res.data.answer, status: res.data.status, verifiedBy: res.data.verifiedBy }
            : r
        )));
      } else {
        setItems((prev) => prev.filter((r) => r.id !== row.id));
        setCounts((prev) => ({
          ...prev,
          [row.status]: Math.max(0, (prev[row.status] || 0) - 1),
          [next]: (prev[next] || 0) + 1,
        }));
      }
      setDrafts((prev) => { const n = { ...prev }; delete n[row.id]; return n; });
    } catch (err) {
      setError(err.response?.data?.error?.message || "保存失败");
    } finally {
      setBusyId(null);
    }
  }

  const TABS = [
    { key: "pending", label: "待确认" },
    { key: "approved", label: "已确认" },
    { key: "unmatchable", label: "无法匹配" },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        游戏给的歌词片段，对应真实歌词的哪几行。只有「已确认」的会被唱卡页使用；
        其余一律沿用原本的自动匹配，不影响任何人。
      </p>

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { setStatus(t.key); setOpenId(null); }}
            className={`rounded px-3 py-1.5 text-sm transition ${
              status === t.key
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            }`}
          >
            {t.label}
            <span className="ml-2 rounded bg-black/20 px-1.5 py-0.5 text-xs tabular-nums">
              {counts[t.key] ?? 0}
            </span>
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">加载中…</p>
      ) : !items.length ? (
        <p className="text-sm text-gray-500">
          {status === "pending"
            ? "没有待确认的片段。"
            : status === "approved"
              ? "还没有确认过的片段。"
              : "没有标记为无法匹配的片段。"}
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((row) => {
            const open = openId === row.id;
            const places = placementsOf(row.answer);
            // The first occurrence is what the row shows line by line; the rest
            // are summarised, since they repeat the same words.
            const answer = places[0] || [];
            const marked = new Set(places.flatMap((pl) => pl.flatMap(entryLines)));
            return (
              <li
                key={row.id}
                className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 text-xs text-gray-500">
                      {row.source} · {row.externalId}
                      {places.length > 1 && (
                        <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                          {places.length} 处
                        </span>
                      )}
                      {row.verifiedBy === "human" && (
                        <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                          人工
                        </span>
                      )}
                    </div>
                    {/* The passage beside the line it is said to be, so the
                        judgement is a comparison rather than a memory test. */}
                    <ol className="space-y-0.5 text-sm">
                      {row.gameLines.map((line, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="shrink-0 tabular-nums text-gray-400">{i}</span>
                          <span className="min-w-0 flex-1 truncate">{line}</span>
                          <span className="shrink-0 text-gray-400">→</span>
                          <span className="min-w-0 flex-[1.2] truncate text-blue-600 dark:text-blue-400">
                            {entryLines(answer[i]).length
                              ? entryLines(answer[i])
                                .map((n) => `[${n}] ${row.realLines[n] ?? "(超出范围)"}`)
                                .join(" + ")
                              : "(不标)"}
                          </span>
                        </li>
                      ))}
                    </ol>
                    {row.note && (
                      <p className="mt-1 text-xs text-gray-500">{row.note}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : row.id)}
                    className="shrink-0 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    {open ? "收起" : "看歌词"}
                  </button>
                </div>

                {open && (
                  <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
                    <div className="max-h-72 overflow-y-auto rounded bg-gray-50 p-2 text-sm dark:bg-gray-900">
                      {row.realLines.length ? (
                        row.realLines.map((line, i) => (
                          <div
                            key={i}
                            className={`flex gap-2 px-1 ${
                              marked.has(i)
                                ? "rounded bg-yellow-100 dark:bg-yellow-900/40"
                                : ""
                            }`}
                          >
                            <span className="shrink-0 tabular-nums text-gray-400">{i}</span>
                            <span>{line}</span>
                          </div>
                        ))
                      ) : (
                        <p className="text-gray-500">曲库里还没有这首歌的歌词。</p>
                      )}
                    </div>
                    <label className="mt-2 block text-xs text-gray-500">
                      改答案：一行写一处，每个游戏行一项、逗号分隔；
                      一句对应真实歌词多行时用 + 连接（如 63+64）；-1 表示不标。
                      副歌唱几遍就写几行。
                      <textarea
                        rows={Math.max(2, places.length + 1)}
                        defaultValue={places.map(placementText).join("\n")}
                        onChange={(e) =>
                          setDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))
                        }
                        className="mt-1 w-full rounded border border-gray-300 px-2 py-1 font-mono text-sm dark:border-gray-600 dark:bg-gray-900"
                      />
                    </label>
                  </div>
                )}

                {/* Only the moves that would change something. A row already
                    approved has nothing to approve, and offering the button
                    anyway invites a click that does nothing — the reviewer is
                    then left wondering whether it worked. Editing the answer
                    stays available everywhere, since a stored answer can be
                    wrong in any state. */}
                <div className="mt-3 flex flex-wrap gap-2">
                  {status !== "approved" && (
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => decide(row, "approved")}
                      className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      确认
                    </button>
                  )}
                  {status === "approved" && open && (
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => decide(row, "approved")}
                      className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      保存改动
                    </button>
                  )}
                  {status !== "unmatchable" && (
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => decide(row, "unmatchable")}
                      className="rounded bg-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200"
                    >
                      无法匹配
                    </button>
                  )}
                  {status !== "pending" && (
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => decide(row, "pending")}
                      className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      退回待确认
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
