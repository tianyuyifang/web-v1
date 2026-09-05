"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mappingAPI } from "@/lib/api";
// Shared with the 唱卡 page: both must read an answer the same way, or the page
// marks lines the reviewer never approved.
import { entryLines, placementsOf } from "@/lib/passageAnswer";
import CataloguePanel from "./CataloguePanel";

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
  const [counts, setCounts] = useState({ pending: 0, ai_reviewed: 0, approved: 0, unmatchable: 0 });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  // Which row is open. Only one at a time: the real lyrics run to dozens of
  // lines and several expanded at once is unreadable.
  const [openId, setOpenId] = useState(null);
  // Edited answers, keyed by row id, as the raw text the reviewer typed.
  const [drafts, setDrafts] = useState({});
  // 首末快填草稿(每行「首-末」), 优先于逐行 drafts。
  const [flDrafts, setFlDrafts] = useState({});
  // 待删除确认的行 id(点一次亮确认, 再点才删)
  const [confirmDelId, setConfirmDelId] = useState(null);
  // The approved tab's 「只看被报告的」 filter. Off by default; reset when
  // leaving the tab so it cannot silently narrow another one.
  const [reportedOnly, setReportedOnly] = useState(false);
  // Only redirect on the very first load, never after the reviewer chooses.
  const firstLoad = useRef(false);

  const load = useCallback(async () => {
    if (status === 'catalogue') { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const [list, c] = await Promise.all([
        mappingAPI.passages({ status, take: 50, reported: status === 'approved' && reportedOnly }),
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
        if (status === 'pending' && !n.pending) {
          if (n.ai_reviewed) setStatus('ai_reviewed');
          else if (n.approved) setStatus('approved');
        }
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || "读取失败");
    } finally {
      setLoading(false);
    }
  }, [status, reportedOnly]);

  useEffect(() => { load(); }, [load]);

  async function decide(row, next) {
    setBusyId(row.id);
    setError(null);
    try {
      const fl = flDrafts[row.id];
      const raw = drafts[row.id];
      // Only send an answer when the reviewer actually edited one; otherwise the
      // stored answer stands and only the status changes.
      let answer;
      // 首末优先: 每行「首-末」, 存成 { ranges:[[f,l],...] }。唱卡页只用首末,
      // 中间行按连续性自动补; 不涉及一对多。
      if (fl !== undefined && fl.trim() && next !== "unmatchable") {
        const ranges = [];
        for (const line of fl.split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
          const m = line.match(/^(\d+)\s*[-~]\s*(\d+)$/);
          if (!m) { setError(`「${line}」格式应为 首行-末行, 如 14-20`); return; }
          const f = Number(m[1]); const l = Number(m[2]);
          if (f > l) { setError(`「${line}」首行不能大于末行`); return; }
          if (l >= row.realLines.length) { setError(`「${line}」末行超出歌词范围(共 ${row.realLines.length} 行)`); return; }
          ranges.push([f, l]);
        }
        if (!ranges.length) { setError("首末不能为空"); return; }
        answer = { ranges };
      } else if (raw !== undefined && next !== "unmatchable") {
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
            ? { ...r, answer: res.data.answer, status: res.data.status, verifiedBy: res.data.verifiedBy, reportCount: res.data.reportCount, lastReportedAt: res.data.lastReportedAt }
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
      setFlDrafts((prev) => { const n = { ...prev }; delete n[row.id]; return n; });
    } catch (err) {
      setError(err.response?.data?.error?.message || "保存失败");
    } finally {
      setBusyId(null);
    }
  }

  async function removeRow(row) {
    setBusyId(row.id);
    setError(null);
    try {
      await mappingAPI.deletePassage(row.id);
      setItems((prev) => prev.filter((r) => r.id !== row.id));
      setCounts((prev) => ({ ...prev, [row.status]: Math.max(0, (prev[row.status] || 0) - 1) }));
      setConfirmDelId(null);
    } catch (err) {
      setError(err.response?.data?.error?.message || "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  const TABS = [
    { key: "pending", label: "待确认" },
    // The assistant's confident answers wait here for a person. Not served to
    // the page until a reviewer moves them to approved — until then the
    // passage keeps running the matcher, exactly as if this tab did not exist.
    { key: "ai_reviewed", label: "AI语义校对" },
    { key: "approved", label: "已确认" },
    { key: "unmatchable", label: "无法匹配" },
    // 浏览用, 与审核无关 —— 选中时整块换成 CataloguePanel。
    { key: "catalogue", label: "唱卡集" },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        游戏给的歌词片段，对应真实歌词的哪几行。只有「已确认」的会被唱卡页使用；
        其余（含 AI 语义校对）一律沿用自动匹配，不影响任何人。
        AI 校对结果逐条看一眼、点「确认」即生效；拿不准的可退回或标无法匹配。
      </p>

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { setStatus(t.key); setOpenId(null); setReportedOnly(false); }}
            className={`rounded px-3 py-1.5 text-sm transition ${
              status === t.key
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            }`}
          >
            {t.label}
            {t.key !== "catalogue" && (
              <span className="ml-2 rounded bg-black/20 px-1.5 py-0.5 text-xs tabular-nums">
                {counts[t.key] ?? 0}
              </span>
            )}
            {/* Approved rows singers are still reporting. Shown on the label so
                a contested answer is visible without opening the tab. */}
            {t.key === "approved" && (counts.reportedApproved || 0) > 0 && (
              <span className="ml-1.5 rounded bg-red-500/20 px-1.5 py-0.5 text-xs text-red-500">
                ⚠{counts.reportedApproved}
              </span>
            )}
          </button>
        ))}
        {status === "approved" && (counts.reportedApproved || 0) > 0 && (
          <button
            type="button"
            onClick={() => setReportedOnly((v) => !v)}
            className={`rounded px-3 py-1.5 text-sm transition ${
              reportedOnly
                ? "bg-red-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            }`}
          >
            只看被报告的
          </button>
        )}
      </div>

      {status === "catalogue" ? (
        <CataloguePanel />
      ) : (
      <>
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
            : status === "ai_reviewed"
              ? "没有等待审核的 AI 校对结果。对助手说「语义校对 待确认 歌词段落」可以发起一轮。"
              : status === "approved"
                ? "还没有确认过的片段。"
                : "没有标记为无法匹配的片段。"}
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((row) => {
            const open = openId === row.id;
            const places = placementsOf(row.answer, row.gameLines.length);
            // The first occurrence is what the row shows line by line; the rest
            // are summarised, since they repeat the same words.
            const answer = places[0] || [];
            // 有答案高亮答案; 报告产生的空行没答案, 就高亮算法猜测, 让审核
            // 展开时那片黄正是算法当前标的, 一眼看出错在哪。
            const answerMarks = places.flatMap((pl) => pl.flatMap(entryLines));
            const marked = new Set(answerMarks.length ? answerMarks : (row.algoGuess || []).flat());
            return (
              <li
                key={row.id}
                className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 text-sm font-medium text-gray-800 dark:text-gray-100">
                      {row.gameTitle || "（未匹配歌曲）"}
                      {row.gameArtist ? <span className="text-gray-500"> — {row.gameArtist}</span> : null}
                    </div>
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
                      {(row.reportCount || 0) > 0 && (
                        <span
                          className="ml-2 cursor-help rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-900/60 dark:text-red-300"
                          title={(row.reporters || []).length
                            ? `报告者: ${(row.reporters || []).map((r) => r.name || "?").join("、")}`
                            : "早期报告未记名"}
                        >
                          {row.status === "approved"
                            ? `⚠ 已确认但仍被 ${row.reportCount} 人报告`
                            : `${row.reportCount} 人报告`}
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
                    {(row.reportCount || 0) > 0 && (
                      // Hover 在手机上不存在, 展开时把名单直接摆出来。
                      <p className="mb-2 text-xs text-red-600 dark:text-red-400">
                        报告者：
                        {(row.reporters || []).length
                          ? (row.reporters || []).map((r) => r.name || "?").join("、")
                          : "早期报告未记名"}
                      </p>
                    )}
                    {(row.algoGuess && row.algoGuess.some((g) => g.length)) ? (
                      <p className="mb-2 text-xs text-gray-500">
                        算法猜测：
                        {row.algoGuess.filter((g) => g.length)
                          .map((g) => (g.length === 1 ? `第 ${g[0]} 行` : `第 ${g[0]}–${g[g.length - 1]} 行`))
                          .join("；")}
                        （下方黄色高亮即此结果，仅供参考）
                      </p>
                    ) : (
                      <p className="mb-2 text-xs text-gray-400">算法没能匹配出连续段落。</p>
                    )}
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
                    <label className="mt-2 block text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      首末标注：一行一处，写「首行-末行」（如 14-20）；副歌多处就写多行。
                      中间行按连续性自动补齐，只需首末。
                      <textarea
                        rows={2}
                        placeholder={"14-20"}
                        value={flDrafts[row.id] ?? ""}
                        onChange={(e) => setFlDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        className="mt-1 w-full rounded border border-emerald-400 px-2 py-1 font-mono text-sm dark:border-emerald-600 dark:bg-gray-900"
                      />
                    </label>
                    <label className="mt-3 block text-xs text-gray-500">
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
                  {confirmDelId === row.id ? (
                    <>
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => removeRow(row)}
                        className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        确认删除
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelId(null)}
                        className="rounded px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelId(row.id)}
                      className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-500 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950"
                    >
                      删除
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      </>
      )}
    </div>
  );
}
