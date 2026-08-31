"use client";

import { useState, useEffect, useCallback } from "react";
import { adminAPI } from "@/lib/api";

/**
 * The membership tiers, editable in place.
 *
 * A tier bundles the two things that used to be set one user at a time — the
 * 加订 add-on and the device limit — so a member holds a tier and reads their
 * permissions from it. Editing a tier here moves everyone on it at once (a
 * per-user override still wins), which is the whole point: raise 挚友 to ten
 * devices and every 挚友 has ten, no per-user work.
 *
 * The four tiers are fixed; only their two values are editable.
 */

const TIER_ROWS = [
  ["normal", "普通"],
  ["vip", "VIP"],
  ["super_vip", "超级VIP"],
  ["zhiyou", "挚友"],
];

export default function TierConfigPanel() {
  const [tiers, setTiers] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    adminAPI.getTiers()
      .then((res) => { setTiers(res.data); setError(""); })
      .catch((err) => setError(err.response?.data?.error?.message || "读取失败"));
  }, []);

  useEffect(load, [load]);

  const setField = (key, field, value) =>
    setTiers((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      // Coerce device limits to integers here; the server validates again.
      const patch = {};
      for (const [key] of TIER_ROWS) {
        patch[key] = {
          capture: !!tiers[key].capture,
          deviceLimit: parseInt(tiers[key].deviceLimit, 10),
        };
      }
      const res = await adminAPI.setTiers(patch);
      setTiers(res.data);
      setSaved(true);
    } catch (err) {
      setError(err.response?.data?.error?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-primary" />
        <h2 className="text-base font-semibold">档位设置</h2>
      </div>
      <p className="mb-4 text-xs text-muted">
        改这里的值，所有属于该档的用户立即生效（个人破例的用户除外）。
      </p>

      {error ? <p className="mb-3 text-sm text-red-400">{error}</p> : null}

      {!tiers ? (
        <div className="flex justify-center py-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="pb-2 pr-4 font-medium">档位</th>
                  <th className="pb-2 pr-4 font-medium">含加订版</th>
                  <th className="pb-2 font-medium">设备上限</th>
                </tr>
              </thead>
              <tbody>
                {TIER_ROWS.map(([key, label]) => (
                  <tr key={key} className="border-b border-border/50">
                    <td className="py-2.5 pr-4 font-medium" style={{ color: "var(--text)" }}>
                      {label}
                    </td>
                    <td className="py-2.5 pr-4">
                      <input
                        type="checkbox"
                        checked={!!tiers[key].capture}
                        onChange={(e) => setField(key, "capture", e.target.checked)}
                        className="h-4 w-4 rounded border-border accent-primary"
                      />
                    </td>
                    <td className="py-2.5">
                      <input
                        type="number"
                        step="1"
                        min="1"
                        value={tiers[key].deviceLimit}
                        onChange={(e) => setField(key, "deviceLimit", e.target.value)}
                        className="w-24 rounded border border-border bg-background px-2 py-1 text-sm text-theme"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {saved ? <span className="text-xs text-green-400">已保存</span> : null}
          </div>
        </>
      )}
    </section>
  );
}
