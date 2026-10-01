"use client";

import { useEffect, useState } from "react";
import { adminAPI } from "@/lib/api";

/**
 * How much the server is calling QQ 音乐 / 网易云 right now.
 *
 * The address is judged by its total, and every other protection only reacts
 * after a refusal; this is the one place the total is visible before that.
 * Numbers per kind because they are judged differently: lyric calls carry no
 * credential and are this address alone; writes change a user's account.
 */

const PLATFORM_LABEL = { qq: "QQ 音乐", netease: "网易云" };
const KINDS = ["read", "write", "lyric", "login", "probe"];
const KIND_LABEL = { read: "读", write: "写", lyric: "歌词", login: "登录", probe: "探测" };

/** Kinds with a count; an all-zero row still says 读 0 so it is not blank. */
function Kinds({ b }) {
  const shown = KINDS.filter((k) => (b[k] || 0) > 0 || k === "read");
  return (
    <span className="text-xs text-muted">
      {shown.map((k) => `${KIND_LABEL[k]} ${b[k] || 0}`).join(" · ")}
    </span>
  );
}

const total = (b) => KINDS.reduce((n, k) => n + (b[k] || 0), 0);

/**
 * The breaker, in one badge. Green is the ordinary state; amber means the
 * cooldown is over and a single probe is out; red means the platform sent
 * rate-limit codes three times inside five minutes and everything is being
 * refused for the minutes shown.
 */
function BreakerBadge({ b }) {
  if (!b) return null;
  if (b.open) {
    const min = Math.max(1, Math.ceil(b.retryAfterMs / 60000));
    return <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-xs text-red-400">已熔断 · 剩 {min} 分钟</span>;
  }
  if (b.halfOpen) {
    return <span className="rounded bg-yellow-500/20 px-1.5 py-0.5 text-xs text-yellow-400">半开 · 试探中</span>;
  }
  return (
    <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-xs text-green-400">
      正常{b.failures ? ` · 近 5 分钟被拒 ${b.failures}/3` : ""}
    </span>
  );
}

function Sparkline({ values, limit }) {
  const max = Math.max(limit, ...values, 1);
  return (
    <div className="flex h-8 items-end gap-px" title="最近 60 分钟，每分钟外呼数">
      {values.map((v, i) => (
        <div
          key={i}
          className={`w-1 rounded-t ${v > limit ? "bg-red-500" : "bg-primary/60"}`}
          style={{ height: `${Math.max(2, Math.round((v / max) * 100))}%` }}
        />
      ))}
    </div>
  );
}

export default function OutboundMeterPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () => {
      adminAPI.getOutbound()
        .then((res) => { if (alive) { setData(res.data); setError(""); } })
        .catch((err) => { if (alive) setError(err.response?.data?.error?.message || "读取失败"); });
    };
    load();
    const id = setInterval(load, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-primary" />
        <h2 className="text-base font-semibold">平台外呼</h2>
      </div>
      <p className="mb-4 text-xs text-muted">
        服务器（网站 IP）对音乐平台的请求量，以及熔断状态（平台 5 分钟内三次说「太频繁」就停 15 分钟）。歌词不带凭证，只算这台机器的；写 = 点赞/取消点赞，会改用户账号；登录 = 扫码登录与续期；探测 = 网易检查 CDN 能否直连。超过每分钟阈值会记进日志。「用户 IP」是用户浏览器自己直连平台的次数，不经过服务器，单独列出。
      </p>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {!data ? (
        <div className="flex justify-center py-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(data).map(([platform, m]) => {
            const t = total;
            const user = m.userIp;
            return (
              <div key={platform} className="rounded-lg border border-border/60 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{PLATFORM_LABEL[platform] || platform}</span>
                    <BreakerBadge b={m.breaker} />
                  </span>
                  <span className="text-xs text-muted">阈值 {m.limitPerMinute}/分钟</span>
                </div>
                <Sparkline values={m.recentMinutes} limit={m.limitPerMinute} />
                <dl className="mt-3 space-y-1.5 text-sm">
                  {[["本分钟", m.thisMinute], ["近一小时", m.lastHour], ["今天", m.today], ["昨天", m.yesterday]].map(([label, b]) => (
                    <div key={label} className="flex items-baseline justify-between gap-3">
                      <dt className="text-muted">{label}</dt>
                      <dd className="flex items-baseline gap-2">
                        <b>{t(b)}</b>
                        <Kinds b={b} />
                      </dd>
                    </div>
                  ))}
                </dl>
                {user ? (
                  <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border/60 pt-2 text-sm">
                    <span className="text-muted">用户 IP（浏览器直连）</span>
                    <span className="flex items-baseline gap-1.5 text-xs">
                      <span className="text-muted">近一小时</span><b className="text-sm">{user.lastHour}</b>
                      <span className="text-muted">· 今天</span><b className="text-sm">{user.today}</b>
                      <span className="text-muted">· 昨天 {user.yesterday}</span>
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
