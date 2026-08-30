"use client";

import { useState, useEffect, useCallback } from "react";
import { adminAPI } from "@/lib/api";

/**
 * What the site tells capture clients is the newest build.
 *
 * Editable here rather than in code because it changes on a different clock
 * from a deploy: shipping an APK means uploading a file and saying so, and
 * having to edit a constant, commit, deploy and restart to finish that is a
 * step easy to forget. Forgetting it is silently wrong — every client then
 * compares itself against a stale number, decides it is current, and nobody is
 * ever told to update.
 */
export default function CaptureClientPanel() {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    adminAPI.getCaptureClient()
      .then((res) => { setForm(res.data); setError(""); })
      .catch((err) => setError(err.response?.data?.error?.message || "读取失败"));
  }, []);

  useEffect(load, [load]);

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await adminAPI.setCaptureClient({
        // Numbers, because everything downstream compares them as numbers. A
        // string here would make every client either permanently current or
        // permanently outdated.
        latest: Number(form.latest),
        minSupported: Number(form.minSupported),
        latestName: form.latestName,
        releasedAt: form.releasedAt,
        url: form.url,
      });
      setForm(res.data);
      setSaved(true);
    } catch (err) {
      setError(err.response?.data?.error?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (!form) {
    return (
      <section className="rounded-xl border border-border bg-surface p-5">
        <p className="text-sm text-muted">{error || "加载中…"}</p>
      </section>
    );
  }

  const field = (key, label, type = "text") => (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <input
        type={type}
        value={form[key] ?? ""}
        onChange={(e) => { setForm({ ...form, [key]: e.target.value }); setSaved(false); }}
        className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-accent"
      />
    </label>
  );

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-1 flex items-center gap-2 text-base font-semibold">
        <span className="inline-block h-2 w-2 rounded-full bg-lime-400" />
        打标 App 版本
      </h2>
      <p className="mb-4 text-xs text-muted">
        发布新版 APK 后在这里更新版本号。客户端启动时会对照这个数字判断自己是否过期。
      </p>

      <div className="space-y-2.5">
        {field("latest", "版本号", "number")}
        {field("latestName", "版本名")}
        {field("releasedAt", "发布日期")}
        {field("url", "下载地址")}
        {/* Rarely changed, and changing it wrongly locks users out mid-game —
            so it sits below the rest rather than beside them. */}
        {field("minSupported", "最低支持", "number")}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {saved ? <span className="text-xs text-green-400">已保存</span> : null}
        {error ? <span className="text-xs text-red-400">{error}</span> : null}
      </div>
    </section>
  );
}
