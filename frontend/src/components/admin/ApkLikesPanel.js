"use client";

import { useCallback, useEffect, useState } from "react";
import { adminAPI } from "@/lib/api";

/**
 * QQ打标: who performs the likes. Since 2026-10-04 never this server: the
 * page writes the heart and the 待确认 button itself, and a run's automatic
 * likes go to the open QQ打标 page first, then -- when this switch allows --
 * to the phone (capture APK v28+); with neither, the capture waits in 待确认.
 * Also the 网易云打标 switch (off: NetEase can only go through the site).
 *
 * Saving takes effect on the next like; nothing is deployed.
 */

const KINDS = [
  ["auto", "自动点赞", "完美匹配时自动点的赞（网页不在线时交给手机）"],
];

const PURPOSE_LABEL = { auto: "自动点赞" };
const OUTCOME_LABEL = {
  page: "网页完成",
  phone: "手机完成",
  "page:unclaimed": "网页没接单",
  "page:timeout": "网页超时",
  "page:failed": "网页失败",
  "page:noCredential": "网页·无 QQ 凭证",
  "phone:unclaimed": "手机没接单",
  "phone:timeout": "手机超时",
  "phone:failed": "手机失败",
  "phone:noCredential": "手机·无 QQ 凭证",
  "page:unavailable": "网页来不及/账号已变",
  "phone:unavailable": "手机来不及/账号已变",
  noExecutor: "都不在线→待确认",
};

const ms = (v) => (v === null || v === undefined ? "—" : `${v}ms`);

function Counts({ map, labels }) {
  const entries = Object.entries(map || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <span className="text-muted">—</span>;
  return <span className="text-xs">{entries.map(([k, n]) => `${labels[k] || k} ${n}`).join(" · ")}</span>;
}

function Row({ label, children }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

export default function ApkLikesPanel() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback((alsoForm) => {
    adminAPI.getApkLikes()
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
      const res = await adminAPI.setApkLikes(form);
      setForm(res.data.settings);
      setData((d) => (d ? { ...d, settings: res.data.settings } : d));
      setSaved(true);
    } catch (err) {
      setError(err.response?.data?.error?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const changed = data && form
    && ["enabled", "adminsOnly", "auto", "approve", "manual"].some((k) => form[k] !== data.settings[k]);
  const s = data?.stats;

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-primary" />
        <h2 className="text-base font-semibold">QQ打标 点赞方式</h2>
      </div>
      <p className="mb-4 text-xs text-muted">
        QQ打标 从不由网站去 QQ 点赞或读歌单。手动 ♥ 和待确认的「点赞」由用户的浏览器完成；
        自动点赞先交给开着的 QQ打标 网页，网页不在线时交给手机上的打标 APK（v28 起，这里的开关控制），
        都不在线就留在待确认。
      </p>

      {error ? <p className="mb-3 text-sm text-red-400">{error}</p> : null}

      {!form ? (
        <div className="flex justify-center py-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <span className="font-medium" style={{ color: "var(--text)" }}>由手机执行（总开关）</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!form.adminsOnly}
                onChange={(e) => setForm({ ...form, adminsOnly: e.target.checked })}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              只对管理员生效
            </label>
            <div className={`ml-6 space-y-1.5 ${form.enabled ? "" : "opacity-50"}`}>
              {KINDS.map(([key, label, hint]) => (
                <label key={key} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={!!form[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
                    className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                  />
                  <span>
                    {label}
                    <span className="block text-xs text-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving || !changed}
              className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {saved && !changed ? <span className="text-xs text-green-400">已保存，下一次点赞起生效</span> : null}
          </div>

          {s ? (
            <div className="mt-6 rounded-lg border border-border/60 p-3">
              <div className="mb-1 font-medium">本次启动以来</div>
              <dl className="text-sm">
                {Object.keys(PURPOSE_LABEL).map((p) => (
                  <Row key={p} label={PURPOSE_LABEL[p]}>
                    <Counts map={s.byPurpose?.[p]} labels={OUTCOME_LABEL} />
                  </Row>
                ))}
                <Row label="完成用时 中位 / 90%">
                  {ms(s.phoneMs?.p50)} / {ms(s.phoneMs?.p90)}
                  <span className="text-xs text-muted">（{s.phoneMs?.n ?? 0} 次）</span>
                </Row>
                <Row label="开着的执行网页">{s.pagesOpen ?? 0}</Row>
                <Row label="失败原因"><Counts map={s.failCodes} labels={{ 1000: "QQ 登录过期", 2001: "QQ 限频" }} /></Row>
              </dl>
              <p className="mt-1 text-xs text-muted">统计从 {s.since ? new Date(s.since).toLocaleString() : "—"} 起，重启后端会清零。</p>
            </div>
          ) : null}
        </>
      )}

      <NeteaseTagging />
    </section>
  );
}

/** 网易云打标: offered or not. Off by default -- NetEase can only go through the site. */
function NeteaseTagging() {
  const [on, setOn] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    adminAPI.getNeteaseTagging()
      .then((res) => setOn(res.data.settings.enabled === true))
      .catch((err) => setError(err.response?.data?.error?.message || "读取失败"));
  }, []);

  const toggle = async (next) => {
    setSaving(true);
    setError("");
    try {
      const res = await adminAPI.setNeteaseTagging({ enabled: next });
      setOn(res.data.settings.enabled === true);
    } catch (err) {
      setError(err.response?.data?.error?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 border-t border-border/60 pt-4">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!on}
          disabled={on === null || saving}
          onChange={(e) => toggle(e.target.checked)}
          className="h-4 w-4 rounded border-border accent-primary"
        />
        <span className="font-medium" style={{ color: "var(--text)" }}>提供网易云打标</span>
      </label>
      <p className="ml-6 mt-1 text-xs text-muted">
        网易云只能由网站服务器访问（会用网站 IP），默认不提供。关掉后 QQ打标 页面不显示网易云，也不接受网易云打标。
      </p>
      {error ? <p className="ml-6 mt-1 text-xs text-red-400">{error}</p> : null}
    </div>
  );
}
