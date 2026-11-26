"use client";

import { useCallback, useEffect, useState } from "react";
import { adminAPI } from "@/lib/api";
import { alertText, LEVEL_STYLE } from "@/lib/rateAlerts";

/**
 * Usage limits: how much one account may ask for, per kind of request.
 *
 * The first line refuses that kind of request for a while (the account itself
 * is untouched). The second line — the first times the factor — means a
 * program, not a person: it raises a red alert and, with the switch on,
 * revokes the account. Saving takes effect within half a minute; nothing is
 * deployed. Below: everyone who went over a line in the last 30 days.
 */
export default function RateLimitsPanel() {
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [history, setHistory] = useState({ recent: [], labels: {} });
  const [showHistory, setShowHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const toForm = (c) => ({
    factor: String(c.revokeFactor),
    autoRevoke: !!c.autoRevoke,
    limits: Object.fromEntries(Object.keys(c.categories || c.limits).map((k) => [k, {
      ten: c.limits[k].ten == null ? "" : String(c.limits[k].ten),
      day: c.limits[k].day == null ? "" : String(c.limits[k].day),
    }])),
  });

  const load = useCallback(async () => {
    try {
      const limits = await adminAPI.getRateLimits();
      setCfg(limits.data);
      setForm(toForm(limits.data));
      // The history is the lesser half: without it the numbers still show.
      adminAPI.rateAlerts()
        .then((alerts) => setHistory({ recent: alerts.data.recent || [], labels: alerts.data.labels || {} }))
        .catch(() => {});
    } catch (err) {
      setError(err.response?.data?.error?.message || "加载失败");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!cfg || !form) {
    return <p className="py-3 text-center text-sm text-muted">{error || "加载中…"}</p>;
  }

  const keys = Object.keys(cfg.categories);
  const setLimit = (k, w, v) => setForm((f) => ({ ...f, limits: { ...f.limits, [k]: { ...f.limits[k], [w]: v.replace(/[^0-9]/g, "") } } }));
  const factorOk = /^\d+(\.\d+)?$/.test(form.factor) && Number(form.factor) >= 1.5 && Number(form.factor) <= 100;
  const factor = factorOk ? Number(form.factor) : cfg.revokeFactor;
  const second = (v) => (v === "" ? "—" : Math.ceil(Number(v) * factor));

  const save = async () => {
    setError(""); setSaved(false);
    // Said here rather than saved as something else: 0 is not "none" (leave
    // the box empty for that), and the server refuses it too.
    if (!factorOk) { setError("第二道线倍数请填 1.5 到 100 之间的数"); return; }
    for (const k of keys) {
      for (const w of ["ten", "day"]) {
        const v = form.limits[k][w];
        if (v !== "" && (Number(v) < 1 || Number(v) > 10000000)) {
          setError(`${cfg.categories[k].label}：请填 1 到 10000000 的整数，或留空表示不限`);
          return;
        }
      }
    }
    setSaving(true);
    try {
      const limits = {};
      for (const k of keys) {
        limits[k] = {
          ten: form.limits[k].ten === "" ? null : Number(form.limits[k].ten),
          day: form.limits[k].day === "" ? null : Number(form.limits[k].day),
        };
      }
      const res = await adminAPI.setRateLimits({ limits, revokeFactor: Number(form.factor), autoRevoke: form.autoRevoke });
      const next = { ...cfg, ...res.data };
      setCfg(next);
      setForm(toForm(next));
      setSaved(true);
    } catch (err) {
      setError(err.response?.data?.error?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const input = "w-24 rounded-md border border-border bg-background px-2 py-1 text-right text-sm";

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-1 flex items-center gap-2 text-base font-semibold">
        <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
        用量限制
      </h2>
      <p className="mb-4 text-sm text-muted">
        每个账号在 10 分钟内、一天内（北京时间）最多能用多少。超过第一道线，那一项暂时用不了，账号不受影响；
        达到第二道线（第一道线 × 倍数）会出现红色提醒。管理员不受限制。留空表示这一格不设限。
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="pb-2 pr-4 font-medium">项目</th>
              <th className="pb-2 pr-4 font-medium">10 分钟</th>
              <th className="pb-2 pr-4 font-medium">一天</th>
              <th className="pb-2 font-medium">第二道线（10 分钟 / 一天）</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k} className="border-b border-border/50 last:border-0">
                <td className="py-2 pr-4">{cfg.categories[k].label}</td>
                <td className="py-2 pr-4">
                  <input className={input} inputMode="numeric" value={form.limits[k].ten} onChange={(e) => setLimit(k, "ten", e.target.value)} aria-label={`${cfg.categories[k].label} 10 分钟`} />
                </td>
                <td className="py-2 pr-4">
                  <input className={input} inputMode="numeric" value={form.limits[k].day} onChange={(e) => setLimit(k, "day", e.target.value)} aria-label={`${cfg.categories[k].label} 一天`} />
                </td>
                <td className="py-2 text-muted">{second(form.limits[k].ten)} / {second(form.limits[k].day)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        <label className="flex items-center gap-2">
          第二道线倍数
          <input className="w-16 rounded-md border border-border bg-background px-2 py-1 text-right text-sm" value={form.factor} onChange={(e) => setForm((f) => ({ ...f, factor: e.target.value.replace(/[^0-9.]/g, "") }))} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={form.autoRevoke} onChange={(e) => setForm((f) => ({ ...f, autoRevoke: e.target.checked }))} />
          达到第二道线时自动撤销账号
          <span className="text-xs text-muted">（关着时只提醒）</span>
        </label>
        <button onClick={save} disabled={saving} className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50">
          {saving ? "保存中…" : "保存"}
        </button>
        {saved && <span className="text-xs text-green-400">已保存，半分钟内生效</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      <div className="mt-6 border-t border-border pt-4">
        <button onClick={() => setShowHistory((v) => !v)} className="text-sm text-muted hover:text-theme" aria-expanded={showHistory}>
          {showHistory ? "▾" : "▸"} 最近 30 天碰过线的记录（{history.recent.length}）
        </button>
        {showHistory && (
          history.recent.length === 0 ? (
            <p className="mt-3 text-sm text-muted">没有人碰过线。</p>
          ) : (
            <ul className="mt-3 space-y-1.5 text-sm">
              {history.recent.map((a) => (
                <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="w-24 shrink-0 text-xs text-muted">{a.day}</span>
                  <span className={`font-medium ${LEVEL_STYLE[a.level]?.name || ""}`}>{a.username}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${LEVEL_STYLE[a.level]?.tag || ""}`}>{alertText(a, history.labels)}</span>
                  {a.ackedAt && <span className="text-xs text-muted">已看过</span>}
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </section>
  );
}
