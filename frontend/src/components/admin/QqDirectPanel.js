"use client";

import { useCallback, useEffect, useState } from "react";
import { adminAPI } from "@/lib/api";

/**
 * Who asks QQ for 唱卡's play URLs: this server (网站 IP) or the singer's own
 * browser (用户 IP) -- and the evidence for choosing, as the browsers report it.
 *
 * Switching takes effect on the next card anyone opens; nothing is deployed.
 */

const MODES = [
  ["server", "网站 IP", "和以前完全一样：服务器去问 QQ。"],
  ["shadow", "仅测速", "照旧用网站 IP 的地址播放；歌开始播放后，浏览器再从用户 IP 问一次，只计时、核对，不使用。用户感觉不到。"],
  ["browser", "用户 IP", "浏览器先直连 QQ；超过这台设备平时走网站的时间还没回，就同时问服务器，谁先回用谁。失败自动回退网站 IP。"],
];

const REASON_LABEL = {
  ok: "成功",
  timeout: "超时",
  "script-error": "连不上",
  "bad-response": "返回异常",
  "credential-expired": "凭证过期",
  unavailable: "无可用文件",
  "no-cdn": "无 CDN",
  skipped: "未直连",
  unplayable: "播不了",
  null: "—",
};
const WINNER_LABEL = { direct: "用户 IP", server: "网站 IP", cache: "缓存", none: "都失败", null: "—" };

const ms = (v) => (v === null || v === undefined ? "—" : `${v}ms`);

function Counts({ map, labels }) {
  const entries = Object.entries(map || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <span className="text-muted">—</span>;
  return (
    <span className="text-xs">
      {entries.map(([k, n]) => `${labels[k] || k} ${n}`).join(" · ")}
    </span>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function Stats({ s }) {
  if (!s) return null;
  const sh = s.shadow;
  const br = s.browser;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="rounded-lg border border-border/60 p-3">
        <div className="mb-1 font-medium">仅测速 · 近 {s.hours} 小时</div>
        <dl className="text-sm">
          <Row label="样本">{sh.n}</Row>
          <Row label="用户 IP 中位 / 90%">
            {ms(sh.directMs.p50)} / {ms(sh.directMs.p90)}
            <span className="text-xs text-muted">（{sh.directMs.n} 次成功）</span>
          </Row>
          <Row label="网站 IP 中位 / 90%">
            {ms(sh.serverMs.p50)} / {ms(sh.serverMs.p90)}
            <span className="text-xs text-muted">（{sh.serverMs.n} 次）</span>
          </Row>
          <Row label="用户 IP 结果"><Counts map={sh.directReasons} labels={REASON_LABEL} /></Row>
          <Row label="两边挑的音质不一致">
            <span className={sh.mismatches ? "text-red-400" : ""}>{sh.mismatches}</span>
            <span className="text-xs text-muted"> / {sh.compared} 次可比</span>
          </Row>
          <Row label="用户 IP 地址下载不了">
            <span className={sh.notPlayable ? "text-red-400" : ""}>{sh.notPlayable}</span>
            <span className="text-xs text-muted"> / {sh.playableChecked} 次检查</span>
          </Row>
          <Row label="CDN 节点"><Counts map={sh.hosts} labels={{}} /></Row>
        </dl>
      </div>
      <div className="rounded-lg border border-border/60 p-3">
        <div className="mb-1 font-medium">用户 IP 模式 · 近 {s.hours} 小时</div>
        <dl className="text-sm">
          <Row label="样本">{br.n}</Row>
          <Row label="等待中位 / 90%">{ms(br.waitMs.p50)} / {ms(br.waitMs.p90)}</Row>
          <Row label="谁的地址被用了"><Counts map={br.winners} labels={WINNER_LABEL} /></Row>
          <Row label="触发对冲（也问了网站）">{br.hedged}</Row>
          <Row label="地址播不了，改用网站的">
            <span className={br.playFailed ? "text-red-400" : ""}>{br.playFailed}</span>
          </Row>
          <Row label="直接走网站（原因）"><Counts map={br.skippedFor} labels={{ page: "本页停用", device: "设备更快/播不了", gesture: "iPhone 首次播放" }} /></Row>
          <Row label="设备重新测速">{br.reprobes ?? 0}</Row>
          <Row label="用户 IP 结果"><Counts map={br.directReasons} labels={REASON_LABEL} /></Row>
        </dl>
      </div>
    </div>
  );
}

export default function QqDirectPanel() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [window48, setWindow48] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback((alsoForm) => {
    adminAPI.getQqDirect()
      .then((res) => {
        setData(res.data);
        if (alsoForm) setForm(res.data.settings);
        setError("");
      })
      .catch((err) => setError(err.response?.data?.error?.message || "读取失败"));
  }, []);

  useEffect(() => {
    load(true);
    const id = setInterval(() => load(false), 30000);
    return () => clearInterval(id);
  }, [load]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const res = await adminAPI.setQqDirect({
        mode: form.mode,
        adminsOnly: form.adminsOnly,
        hedgeMs: Number(form.hedgeMs),
      });
      setForm(res.data.settings);
      setData((d) => (d ? { ...d, settings: res.data.settings } : d));
      setSaved(true);
    } catch (err) {
      setError(err.response?.data?.error?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const changed = data && form && (
    form.mode !== data.settings.mode
    || form.adminsOnly !== data.settings.adminsOnly
    || Number(form.hedgeMs) !== data.settings.hedgeMs
  );

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-primary" />
        <h2 className="text-base font-semibold">QQ 播放解析</h2>
      </div>
      <p className="mb-4 text-xs text-muted">
        唱卡页点卡片时，由谁去问 QQ 要播放地址。改完保存，开着的唱卡页约 15 秒内按新的方式走，不用部署；随时可以切回「网站 IP」。
      </p>

      {error ? <p className="mb-3 text-sm text-red-400">{error}</p> : null}

      {!form ? (
        <div className="flex justify-center py-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {MODES.map(([key, label, hint]) => (
              <label key={key} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="qq-direct-mode"
                  checked={form.mode === key}
                  onChange={() => setForm({ ...form, mode: key })}
                  className="mt-0.5 h-4 w-4 accent-primary"
                />
                <span>
                  <span className="font-medium" style={{ color: "var(--text)" }}>{label}</span>
                  <span className="block text-xs text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!form.adminsOnly}
                onChange={(e) => setForm({ ...form, adminsOnly: e.target.checked })}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              只对管理员生效
            </label>
            <label className="flex items-center gap-2">
              默认对冲等待
              <input
                type="number"
                step="50"
                min="250"
                max="2000"
                value={form.hedgeMs}
                onChange={(e) => setForm({ ...form, hedgeMs: e.target.value })}
                className="w-24 rounded border border-border bg-background px-2 py-1 text-sm text-theme"
              />
              <span className="text-xs text-muted">毫秒（设备自己量出走网站的时间后，以设备的为准）</span>
            </label>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving || !changed}
              className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {saved && !changed ? <span className="text-xs text-green-400">已保存，约 15 秒内生效</span> : null}
          </div>

          <div className="mt-6 mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">浏览器上报</h3>
            <button
              onClick={() => setWindow48((v) => !v)}
              className="text-xs text-primary hover:underline"
            >
              {window48 ? "看近 24 小时" : "看近 48 小时"}
            </button>
          </div>
          <Stats s={window48 ? data?.last48h : data?.last24h} />

        </>
      )}
    </section>
  );
}
