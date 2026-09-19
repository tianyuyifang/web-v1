"use client";

import { useCallback, useEffect, useState } from "react";
import { adminAPI } from "@/lib/api";

const PRESETS = [
  { key: "day", label: "1 天" },
  { key: "week", label: "1 周" },
  { key: "month", label: "1 个月" },
  { key: "quarter", label: "1 季度" },
];

// Mirrors TIER_KEYS/TIER_LABELS on the server. Every code carries a tier —
// redeeming sets the account to it (buy the tier you pay for).
const TIERS = [
  { key: "normal", label: "普通" },
  { key: "vip", label: "VIP" },
  { key: "super_vip", label: "超级VIP" },
  { key: "zhiyou", label: "挚友" },
];

function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Generate one-time activation codes and see who has used them.
 *
 * An admin picks a duration (a preset or any number of days) and a count, hits
 * 生成, then copies the codes out of the list to hand to buyers. A user redeems
 * one on the login/account page to renew a lapsed account. Codes are plaintext
 * here on purpose — the whole point is to read and give them out.
 */
export default function ActivationCodesPanel() {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // generation form
  const [preset, setPreset] = useState("month"); // preset key, or "" for custom days
  const [days, setDays] = useState("30");
  const [tier, setTier] = useState("vip"); // every code carries a tier
  const [count, setCount] = useState("10");
  const [generating, setGenerating] = useState(false);

  // "只看未用" filter + copy feedback
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [confirmVoidId, setConfirmVoidId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await adminAPI.listCodes();
      setCodes(res.data.codes || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || "读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const generate = async () => {
    setGenerating(true);
    setError("");
    try {
      const body = preset
        ? { preset, tier, count: Number(count) }
        : { days: Number(days), tier, count: Number(count) };
      const res = await adminAPI.generateCodes(body);
      // Prepend the new batch so they're right at the top to copy.
      setCodes((prev) => [...(res.data.codes || []), ...prev]);
    } catch (err) {
      setError(err.response?.data?.error?.message || "生成失败");
    } finally {
      setGenerating(false);
    }
  };

  const copy = async (row) => {
    try {
      await navigator.clipboard.writeText(row.code);
      setCopiedId(row.id);
      setTimeout(() => setCopiedId((c) => (c === row.id ? null : c)), 1500);
    } catch {
      // Clipboard often refused; the code is on screen to select anyway.
    }
  };

  const voidCode = async (row) => {
    try {
      await adminAPI.voidCode(row.id);
      setCodes((prev) => prev.map((c) => (c.id === row.id ? { ...c, voidedAt: new Date().toISOString() } : c)));
      setConfirmVoidId(null);
    } catch (err) {
      setError(err.response?.data?.error?.message || "作废失败");
    }
  };

  const statusOf = (c) => {
    if (c.usedAt) return { label: "已用", cls: "bg-gray-500/15 text-muted" };
    if (c.voidedAt) return { label: "已作废", cls: "bg-red-500/15 text-red-400" };
    return { label: "未用", cls: "bg-green-500/15 text-green-400" };
  };

  const durationOf = (c) => c.label
    || (c.durationMonths ? `${c.durationMonths} 个月` : `${c.durationDays} 天`);

  const shown = unusedOnly ? codes.filter((c) => !c.usedAt && !c.voidedAt) : codes;
  const unusedCount = codes.filter((c) => !c.usedAt && !c.voidedAt).length;

  return (
    <div className="space-y-6">
      {/* Generate */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 flex items-center gap-2 text-base font-semibold">
          <span className="inline-block h-2 w-2 rounded-full bg-orange-400" />
          生成激活码
        </h2>
        <p className="mb-4 text-sm text-muted">
          选时长和数量，生成后从下方列表复制，线下发给用户。用户在登录页或账户页兑换即可续期。
        </p>

        <div className="mb-3">
          <p className="mb-1.5 text-sm text-muted">时长</p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  preset === p.key
                    ? "border-primary bg-primary/10 text-theme"
                    : "border-border text-muted hover:bg-surface-hover"
                }`}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPreset("")}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                preset === ""
                  ? "border-primary bg-primary/10 text-theme"
                  : "border-border text-muted hover:bg-surface-hover"
              }`}
            >
              自定义天数
            </button>
            {preset === "" && (
              <input
                type="number"
                min="1"
                max="3650"
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="w-24 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-theme"
                placeholder="天数"
              />
            )}
          </div>
        </div>

        <div className="mb-3">
          <p className="mb-1.5 text-sm text-muted">档位</p>
          <div className="flex flex-wrap gap-2">
            {TIERS.map((tr) => (
              <button
                key={tr.key}
                type="button"
                onClick={() => setTier(tr.key)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  tier === tr.key
                    ? "border-primary bg-primary/10 text-theme"
                    : "border-border text-muted hover:bg-surface-hover"
                }`}
              >
                {tr.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4 flex items-end gap-3">
          <div>
            <p className="mb-1.5 text-sm text-muted">数量</p>
            <input
              type="number"
              min="1"
              max="500"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              className="w-24 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-theme"
            />
          </div>
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {generating ? "生成中…" : "生成"}
          </button>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
      </section>

      {/* List */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-theme">
            全部激活码 <span className="text-sm font-normal text-muted">（未用 {unusedCount}）</span>
          </h2>
          <label className="flex items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" checked={unusedOnly} onChange={(e) => setUnusedOnly(e.target.checked)} />
            只看未用
          </label>
        </div>

        {loading ? (
          <p className="text-sm text-muted">加载中…</p>
        ) : !shown.length ? (
          <p className="text-sm text-muted">{unusedOnly ? "没有未使用的码。" : "还没有激活码，先在上面生成。"}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">激活码</th>
                  <th className="py-2 pr-3 font-medium">档位 / 时长</th>
                  <th className="py-2 pr-3 font-medium">状态</th>
                  <th className="py-2 pr-3 font-medium">使用者</th>
                  <th className="py-2 pr-3 font-medium">使用时间</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const st = statusOf(c);
                  return (
                    <tr key={c.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          onClick={() => copy(c)}
                          title="点击复制"
                          className="font-mono text-theme hover:text-primary"
                        >
                          {c.code}
                        </button>
                        {copiedId === c.id && <span className="ml-2 text-xs text-green-400">已复制</span>}
                      </td>
                      <td className="py-2 pr-3 text-muted">{durationOf(c)}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                      </td>
                      <td className="py-2 pr-3 text-muted">{c.usedByName || "—"}</td>
                      <td className="py-2 pr-3 text-muted tabular-nums">{fmt(c.usedAt)}</td>
                      <td className="py-2 text-right">
                        {!c.usedAt && !c.voidedAt && (
                          confirmVoidId === c.id ? (
                            <span className="whitespace-nowrap">
                              <button onClick={() => voidCode(c)} className="text-xs text-red-400 hover:underline">确认作废</button>
                              <button onClick={() => setConfirmVoidId(null)} className="ml-2 text-xs text-muted hover:underline">取消</button>
                            </span>
                          ) : (
                            <button onClick={() => setConfirmVoidId(c.id)} className="text-xs text-muted hover:text-red-400">作废</button>
                          )
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
