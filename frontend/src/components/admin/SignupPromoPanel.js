"use client";

import { useEffect, useState } from "react";
import { adminAPI } from "@/lib/api";

/** <input type="date"> wants YYYY-MM-DD; the API speaks ISO. */
function toDateInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** End of the chosen day, so a campaign "until the 20th" includes the 20th. */
function endOfDay(value) {
  if (!value) return null;
  const d = new Date(`${value}T23:59:59`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
}

/**
 * Runs the "sign up and you are a member" campaign.
 *
 * Two dates that are easy to conflate, so the form keeps them apart: 截止日期
 * is when the campaign stops applying to new signups, 会员时长 is how long the
 * membership each signup receives lasts. A one-week campaign can hand out a
 * month.
 */
export default function SignupPromoPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [active, setActive] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState("days"); // days | until
  const [grantDays, setGrantDays] = useState(30);
  const [grantUntil, setGrantUntil] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    adminAPI
      .getSignupPromo()
      .then((res) => {
        if (!alive) return;
        const p = res.data?.promo || {};
        setActive(Boolean(res.data?.active));
        setEnabled(Boolean(p.enabled));
        setEndsAt(toDateInput(p.endsAt));
        setNote(p.note || "");
        if (p.grantUntil) {
          setMode("until");
          setGrantUntil(toDateInput(p.grantUntil));
        } else {
          setMode("days");
          if (p.grantDays) setGrantDays(p.grantDays);
        }
      })
      .catch((err) =>
        setError(err.response?.data?.error?.message || "读取失败")
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  async function save(nextEnabled) {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const body = { enabled: nextEnabled };
      if (nextEnabled) {
        body.endsAt = endOfDay(endsAt);
        body.note = note;
        if (mode === "days") body.grantDays = Number(grantDays);
        else body.grantUntil = endOfDay(grantUntil);
      }
      const res = await adminAPI.setSignupPromo(body);
      setEnabled(Boolean(res.data?.promo?.enabled));
      setActive(Boolean(res.data?.active));
      setSaved(true);
    } catch (err) {
      setError(err.response?.data?.error?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
        读取中…
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-theme">
        <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
        注册即会员（推广活动）
      </h2>
      <p className="mb-4 text-sm text-muted">
        活动期间，任何人注册后直接成为会员，不再是游客。到了截止日期自动恢复，不需要你回来关。
      </p>

      {/* What it is doing right now — which is not the same as what is saved,
          once the end date has passed. */}
      <div
        className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
          active
            ? "border-green-500/30 bg-green-500/10 text-theme"
            : "border-border bg-background/40 text-muted"
        }`}
      >
        {active ? (
          <>
            <span className="font-semibold text-theme">进行中</span>
            ：现在注册的人会直接成为会员
            {endsAt && <>，{fmt(endOfDay(endsAt))} 截止</>}
          </>
        ) : enabled ? (
          <>
            <span className="font-semibold text-theme">已结束</span>
            ：配置还在，但截止日期已过，现在注册的人是游客
          </>
        ) : (
          <>
            <span className="font-semibold text-theme">未开启</span>
            ：现在注册的人是游客
          </>
        )}
      </div>

      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-theme">
            活动截止日期
          </label>
          <input
            type="date"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <p className="mt-1 text-xs text-muted">
            这天之后注册的人恢复成游客。留空则一直有效，需要你手动关。
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-theme">
            送多久的会员
          </label>
          <div className="mb-2 flex gap-4 text-sm">
            <label className="flex items-center gap-1.5 text-theme">
              <input
                type="radio"
                checked={mode === "days"}
                onChange={() => setMode("days")}
              />
              固定天数
            </label>
            <label className="flex items-center gap-1.5 text-theme">
              <input
                type="radio"
                checked={mode === "until"}
                onChange={() => setMode("until")}
              />
              统一到期日
            </label>
          </div>
          {mode === "days" ? (
            <>
              <input
                type="number"
                min="1"
                max="3650"
                value={grantDays}
                onChange={(e) => setGrantDays(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="mt-1 text-xs text-muted">
                每个人从自己注册那天算起。
              </p>
            </>
          ) : (
            <>
              <input
                type="date"
                value={grantUntil}
                onChange={(e) => setGrantUntil(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="mt-1 text-xs text-muted">
                活动期间注册的所有人都用这一个到期日。
              </p>
            </>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-theme">
            备注（只有你看得到）
          </label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：8 月抖音推广"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {error && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}
        {saved && !error && (
          <p className="text-sm text-green-400">已保存</p>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => save(true)}
            disabled={saving}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {enabled ? "保存修改" : "开启活动"}
          </button>
          {enabled && (
            <button
              onClick={() => save(false)}
              disabled={saving}
              className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            >
              立即结束
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
