"use client";

/**
 * 好友标记 tab：把自己的标记分享给搭子，看搭子分享过来的标记。
 *
 * 上半是分享管理 —— 搜用户名分享、看自己分享给了谁、随时取消（取消后
 * 对方那侧立刻 403）。下半是好友视图：谁分享给了我做成一排 chips，选中
 * 谁就用只读版的 MarkedSongs 看谁 —— 和本人的已标记 tab 同一个组件、
 * 同一条服务端路径，好友看到的就是你自己看到的。
 *
 * 没人分享给我时下半区只显示一句邀请文案；上半照常可用 —— 先把自己
 * 分享出去正是打破这个状态的方式。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import api, { captureAPI } from "@/lib/api";
import MarkedSongs from "./MarkedSongs";

export default function FriendMarks() {
  const [outgoing, setOutgoing] = useState([]);
  const [incoming, setIncoming] = useState([]);
  const [friend, setFriend] = useState(null);        // 选中的分享者 {userId, username}
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const searchRun = useRef(0);

  const applyOverview = useCallback((data) => {
    setOutgoing(data.outgoing || []);
    setIncoming(data.incoming || []);
    // 默认选中第一位分享者；当前选中的人取消了分享就换下一位。
    setFriend((prev) => {
      const list = data.incoming || [];
      if (prev && list.some((f) => f.userId === prev.userId)) return prev;
      return list[0] || null;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    captureAPI.markShares()
      .then((res) => { if (alive) applyOverview(res.data); })
      .catch((err) => { if (alive) setError(err.response?.data?.error?.message || "读取失败"); })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [applyOverview]);

  // 用户搜索：2 字起搜，丢弃乱序返回 —— 和歌单分享弹窗同款行为。
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return undefined; }
    const run = ++searchRun.current;
    const t = setTimeout(() => {
      api.get(`/users/search?q=${encodeURIComponent(q)}`)
        .then((res) => { if (run === searchRun.current) setResults(res.data || []); })
        .catch(() => { if (run === searchRun.current) setResults([]); });
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const share = async (user) => {
    setBusy(true);
    setError("");
    try {
      const res = await captureAPI.shareMarks(user.id);
      applyOverview(res.data);
      setQuery("");
      setResults([]);
    } catch (err) {
      setError(err.response?.data?.error?.message || "分享失败");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (userId) => {
    setBusy(true);
    setError("");
    try {
      const res = await captureAPI.revokeMarkShare(userId);
      applyOverview(res.data);
    } catch (err) {
      setError(err.response?.data?.error?.message || "取消失败");
    } finally {
      setBusy(false);
    }
  };

  const sharedIds = new Set(outgoing.map((u) => u.userId));

  return (
    <div className="space-y-4">
      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* ---- 上半：分享管理 ---- */}
      <div className="rounded-lg border border-border bg-surface p-3">
        <div className="mb-2 text-sm font-medium">我的分享</div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入用户名，把你的标记分享给TA…"
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
        {results.length > 0 && (
          <div className="mt-1 overflow-hidden rounded-lg border border-border">
            {results.map((u) => (
              <button
                key={u.id}
                type="button"
                disabled={busy}
                onClick={() => share(u)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-black/10 disabled:opacity-50"
              >
                <span>{u.username}</span>
                <span className="text-xs text-muted">
                  {sharedIds.has(u.id) ? "已分享过" : "分享"}
                </span>
              </button>
            ))}
          </div>
        )}
        {outgoing.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted">已分享给：</span>
            {outgoing.map((u) => (
              <span
                key={u.userId}
                className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5"
              >
                {u.username}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => revoke(u.userId)}
                  className="text-muted hover:text-red-400 disabled:opacity-50"
                  title="取消分享"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ---- 下半：看好友的 ---- */}
      {loaded && incoming.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
          很遗憾！目前还没有人给你分享，快把你的搭子喊过来一起玩吧！
        </div>
      ) : incoming.length > 0 ? (
        <div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {incoming.map((f) => (
              <button
                key={f.userId}
                type="button"
                onClick={() => setFriend(f)}
                className={`rounded-full px-3 py-1 text-sm transition ${
                  friend?.userId === f.userId
                    ? "bg-accent text-white"
                    : "border border-border text-muted hover:text-theme"
                }`}
              >
                {f.username}
              </button>
            ))}
          </div>
          {/* key 换人时整棵重挂，列表/过滤/分页全部回到初始 —— 比在组件里
              到处对 friendId 做重置省心得多。 */}
          {friend && <MarkedSongs key={friend.userId} friendId={friend.userId} />}
        </div>
      ) : null}
    </div>
  );
}
