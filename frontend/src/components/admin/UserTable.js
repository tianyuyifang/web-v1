"use client";

import { useState, Fragment } from "react";
import { useRouter } from "next/navigation";
import { adminAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import ConfirmDialog from "@/components/ui/ConfirmDialog";

// The tier chip keys the member filter offers. Every member has a tier now
// (promo-on signups and approvals both land on one, so there is no 无档位 to
// filter for); "expired" is handled separately in passesFilters.
const TIER_FILTER_KEYS = ["normal", "vip", "super_vip", "zhiyou"];

// Relative time for the 最近使用 column. "3 天前" answers "is this account still
// in use" at a glance; the exact instant is on the cell's title. Computed from
// two absolute times, so it needs no timezone.
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.round(months / 12)} 年前`;
}

export default function UserTable({ users, onRefresh, onUserUpdated, controls = false }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [loading, setLoading] = useState({});
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [resetTarget, setResetTarget] = useState(null);
  const [resetResult, setResetResult] = useState(null); // { username, tempPassword }
  const [copied, setCopied] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [billingDraft, setBillingDraft] = useState({});
  const [sortKey, setSortKey] = useState("registered"); // registered | expiration | owned | shared
  const [sortDir, setSortDir] = useState("desc"); // asc | desc
  const [activeFilters, setActiveFilters] = useState({}); // { vip, super_vip, zhiyou, normal, __none__ }
  const [search, setSearch] = useState(""); // username substring, member tab only

  function draftFor(user) {
    const d = billingDraft[user.id];
    if (d) return d;
    return {
      expiresAt: user.expiresAt ? String(user.expiresAt).slice(0, 10) : "",
      monthlyFee: user.monthlyFee != null ? String(user.monthlyFee) : "",
      paymentStatus: user.paymentStatus || "",
      billingNotes: user.billingNotes || "",
      deviceLimit: user.deviceLimit != null ? String(user.deviceLimit) : "",
      tier: user.tier || "",
    };
  }

  // Tier is a one-click change of its own, not part of the billing save: it
  // decides add-on and device limit from its config, and setting it should not
  // require also pressing 保存 on the money fields beside it.
  async function changeTier(user, tier) {
    setDraft(user.id, { tier });
    await performInPlace(user.id, () => adminAPI.setUserTier(user.id, tier || null));
  }

  const TIER_OPTIONS = [
    ["", "无档位"],
    ["normal", "普通"],
    ["vip", "VIP"],
    ["super_vip", "超级VIP"],
    ["zhiyou", "挚友"],
  ];

  function setDraft(userId, patch) {
    setBillingDraft((prev) => ({ ...prev, [userId]: { ...draftFor({ id: userId, ...users.find((u) => u.id === userId) }), ...patch } }));
  }

  async function saveBilling(user) {
    const d = draftFor(user);
    // entitlements is deliberately not sent: the add-on is tier-driven now and
    // the editor no longer edits it, so a save touches only billing fields and
    // the device-limit override.
    await performInPlace(user.id, () => adminAPI.updateBilling(user.id, {
      expiresAt: d.expiresAt ? new Date(d.expiresAt + "T00:00:00.000Z").toISOString() : null,
      monthlyFee: d.monthlyFee === "" ? null : d.monthlyFee,
      paymentStatus: d.paymentStatus || null,
      billingNotes: d.billingNotes || null,
      deviceLimit: d.deviceLimit === "" ? null : parseInt(d.deviceLimit, 10),
    }));
    setBillingDraft((prev) => { const n = { ...prev }; delete n[user.id]; return n; });
  }

  async function extend(user) {
    await performInPlace(user.id, () => adminAPI.extendOneMonth(user.id));
    setBillingDraft((prev) => { const n = { ...prev }; delete n[user.id]; return n; });
  }

  async function doReset(user) {
    setLoading((prev) => ({ ...prev, [user.id]: true }));
    setError("");
    try {
      const res = await adminAPI.resetPassword(user.id);
      setResetResult({ username: res.data.username, tempPassword: res.data.tempPassword });
      setCopied(false);
    } catch (err) {
      setError(err.response?.data?.error?.message || t("actionFailed"));
    } finally {
      setLoading((prev) => ({ ...prev, [user.id]: false }));
    }
  }

  async function copyTempPassword() {
    if (!resetResult) return;
    try {
      await navigator.clipboard.writeText(resetResult.tempPassword);
      setCopied(true);
    } catch {
      // clipboard may be unavailable; the password is visible to select manually
    }
  }

  async function perform(userId, action) {
    setLoading((prev) => ({ ...prev, [userId]: true }));
    setError("");
    try {
      await action();
      onRefresh();
    } catch (err) {
      setError(err.response?.data?.error?.message || t("actionFailed"));
    } finally {
      setLoading((prev) => ({ ...prev, [userId]: false }));
    }
  }

  // Like perform, but for edits that leave the user in this same tab (billing,
  // tier, extend): merge the returned user in place instead of refetching the
  // whole list, so the row stays put, the editor stays open, and the admin can
  // move straight to the next one. Falls back to onRefresh if no merge callback
  // was given (tabs that do not pass one) or the endpoint returned no user.
  async function performInPlace(userId, action) {
    setLoading((prev) => ({ ...prev, [userId]: true }));
    setError("");
    try {
      const res = await action();
      const updated = res && res.data && res.data.user;
      if (updated && onUserUpdated) onUserUpdated(updated);
      else onRefresh();
    } catch (err) {
      setError(err.response?.data?.error?.message || t("actionFailed"));
    } finally {
      setLoading((prev) => ({ ...prev, [userId]: false }));
    }
  }

  function toggleFilter(key) {
    setActiveFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // Filter + sort (only meaningful when controls are shown; harmless otherwise).
  const SORT_ACCESSORS = {
    registered: (u) => new Date(u.createdAt).getTime(),
    expiration: (u) => (u.expiresAt ? new Date(u.expiresAt).getTime() : -Infinity),
    owned: (u) => u.ownedCount ?? 0,
    shared: (u) => u.sharedCount ?? 0,
    // Never-active users sort to the bottom of a descending sort (the default),
    // which is where "who has not used it" belongs when scanning most-recent-first.
    lastActive: (u) => (u.lastActiveAt ? new Date(u.lastActiveAt).getTime() : -Infinity),
  };

  function passesFilters(u) {
    // Name search: a case-insensitive username substring, ANDed with the chips
    // below. Empty search matches everyone, so it costs nothing when unused.
    const q = search.trim().toLowerCase();
    if (q && !u.username.toLowerCase().includes(q)) return false;
    // Tier filter, multi-select: with any tier chip on, show only users whose
    // tier is among those picked (a union). No chip on means no filtering.
    const picked = TIER_FILTER_KEYS.filter((k) => activeFilters[k]);
    if (picked.length) {
      if (!picked.includes(u.tier)) return false;
    }
    // 已过期: past the paid-until date. Derived, not a stored status — the same
    // rule the members list is built on. A member with no date never expires.
    if (activeFilters.expired) {
      if (!(u.expiresAt && new Date(u.expiresAt).getTime() <= Date.now())) return false;
    }
    return true;
  }

  const displayUsers = (() => {
    if (!controls) return users;
    const filtered = users.filter(passesFilters);
    const accessor = SORT_ACCESSORS[sortKey];
    const sorted = [...filtered].sort((a, b) => accessor(a) - accessor(b));
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  })();

  // No users at all in this group — nothing to filter/sort.
  if (users.length === 0) {
    return <p className="py-3 text-center text-sm text-muted">{t("noUsersInGroup")}</p>;
  }

  const sortOptions = [
    { key: "registered", label: t("sortRegistered") },
    { key: "lastActive", label: t("sortLastActive") },
    { key: "expiration", label: t("sortExpiration") },
    { key: "owned", label: t("sortOwned") },
    { key: "shared", label: t("sortShared") },
  ];
  const filterChips = [
    { key: "expired", label: "已过期" },
    { key: "normal", label: "普通" },
    { key: "vip", label: "VIP" },
    { key: "super_vip", label: "超级VIP" },
    { key: "zhiyou", label: "挚友" },
  ];

  return (
    <>
      {error && (
        <div className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {controls && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {/* Name search: narrows the visible rows to a username substring,
              combined with the sort and tier chips below. Purely client-side —
              the member list is already loaded, so this is instant. */}
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchMembersPlaceholder")}
              className="w-48 rounded border border-border bg-background px-2 py-1 pr-6 text-sm text-theme placeholder:text-muted"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label={t("clearSearch")}
                title={t("clearSearch")}
                className="absolute right-1 top-1/2 -translate-y-1/2 px-1 text-muted hover:text-theme"
              >
                ×
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">{t("sortByLabel")}</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1 text-sm text-theme"
            >
              {sortOptions.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
            <button
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              className="rounded border border-border px-2 py-1 text-sm text-theme hover:bg-surface-hover"
              aria-label={sortDir === "asc" ? "ascending" : "descending"}
              title={sortDir === "asc" ? "ascending" : "descending"}
            >
              {sortDir === "asc" ? "↑" : "↓"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {filterChips.map((c) => {
              const on = !!activeFilters[c.key];
              return (
                <button
                  key={c.key}
                  onClick={() => toggleFilter(c.key)}
                  aria-pressed={on}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    on
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted hover:bg-surface-hover"
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted">
            <th className="pb-2 pr-4">{t("username")}</th>
            <th className="pb-2 pr-4">{t("role")}</th>
            <th className="pb-2 pr-4">{t("joined")}</th>
            {controls && <th className="pb-2 pr-4">{t("lastActiveColumn")}</th>}
            <th className="pb-2 pr-4">{t("expiresColumn")}</th>
            <th className="pb-2 pr-4">{t("ownedColumn")}</th>
            <th className="pb-2 pr-4">{t("sharedColumn")}</th>
            <th className="pb-2">{t("actions")}</th>
          </tr>
        </thead>
        <tbody>
          {displayUsers.length === 0 && (
            <tr>
              <td colSpan={controls ? 8 : 7} className="py-4 text-center text-sm text-muted">
                {search.trim() ? t("noMembersMatch") : t("noUsersInGroup")}
              </td>
            </tr>
          )}
          {displayUsers.map((user) => (
            <Fragment key={user.id}>
            <tr className="border-b border-border/50 last:border-0">
              <td className="py-3 pr-4 font-medium" style={{ color: "var(--text)" }}>
                {user.username}
              </td>
              <td className="py-3 pr-4">
                <span
                  className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    user.role === "ADMIN"
                      ? "bg-purple-500/15 text-purple-400"
                      : user.role === "MEMBER"
                      ? "bg-green-500/15 text-green-400"
                      : user.role === "GUEST"
                      ? "bg-sky-500/15 text-sky-400"
                      : "bg-yellow-500/15 text-yellow-400"
                  }`}
                >
                  {user.role}
                </span>
                {/* Tier beside the role: the role is the ladder, the tier is
                    what they bought. Only shown when set and not for admins,
                    who hold everything regardless. */}
                {user.tier && user.role !== "ADMIN" ? (
                  <span className="ml-1 inline-flex rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                    {{ normal: "普通", vip: "VIP", super_vip: "超级VIP", zhiyou: "挚友" }[user.tier] || user.tier}
                  </span>
                ) : null}
                {/* A PENDING user with a demotion stamp was a member the admin
                    revoked, not a fresh applicant — flagged so the two are
                    told apart now that they share the 待审核 tab. Their data is
                    intact and returns on approval. */}
                {user.role === "PENDING" && user.demotedAt ? (
                  <span className="ml-1 inline-flex rounded-full bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-400">
                    曾是会员
                  </span>
                ) : null}
              </td>
              <td className="py-3 pr-4 text-muted">
                {new Date(user.createdAt).toLocaleDateString()}
                {/* Revoked members only — says why they are back in PENDING. */}
                {user.demotedAt && (
                  <div className="text-xs text-orange-400">
                    {t("revokedOn")} {new Date(user.demotedAt).toLocaleDateString()}
                  </div>
                )}
              </td>
              {/* Most recent moment the user changed their own data —唱卡, 听歌流量,
                  建/改歌单或片段, 点赞, 打标, 反馈… Member tab only (controls), the
                  one place ranking accounts by activity is the point. Relative,
                  because "who is still around vs gone" is the question; exact
                  time on hover. A dash for accounts that never did anything. */}
              {controls && (
                <td
                  className="py-3 pr-4 text-muted"
                  title={user.lastActiveAt ? new Date(user.lastActiveAt).toLocaleString() : ""}
                >
                  {user.lastActiveAt ? timeAgo(user.lastActiveAt) : "—"}
                </td>
              )}
              <td className="py-3 pr-4 text-muted">
                {user.expiresAt ? new Date(user.expiresAt).toLocaleDateString() : "—"}
              </td>
              <td className="py-3 pr-4 text-muted">{user.ownedCount ?? 0}</td>
              <td className="py-3 pr-4 text-muted">{user.sharedCount ?? 0}</td>
              <td className="flex flex-wrap gap-2 py-3">
                <button
                  onClick={() => setExpandedId((id) => (id === user.id ? null : user.id))}
                  aria-expanded={expandedId === user.id}
                  className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                    expandedId === user.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-primary hover:bg-primary/10"
                  }`}
                >
                  {t("edit")}
                </button>
                <button
                  onClick={() => router.push(`/admin/users/${user.id}/playlists`)}
                  className="rounded-md border border-border px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                >
                  {t("viewPlaylists")}
                </button>
                {/* Promoting stays on the row — it is the one action wanted at
                    a glance. The rest live in the edit panel, where a click is
                    a deliberate step rather than something to hit by mistake
                    while scanning a list. */}
                {user.role !== "ADMIN" && user.role !== "MEMBER" && (
                  <button
                    onClick={() => perform(user.id, () => adminAPI.approveUser(user.id))}
                    disabled={loading[user.id]}
                    className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white shadow-sm transition-colors hover:bg-green-500 disabled:opacity-50"
                  >
                    {t("approve")}
                  </button>
                )}
              </td>
            </tr>
              {expandedId === user.id && (
              <tr className="border-b border-border/50 last:border-0">
                <td colSpan={controls ? 8 : 7} className="pb-3">
                  <div className="flex flex-wrap items-end gap-2 rounded-lg bg-background/60 px-3 py-2">
                    <label className="flex flex-col text-xs text-muted">
                      {t("expiresColumn")}
                      <input
                        type="date"
                        value={draftFor(user).expiresAt}
                        onChange={(e) => setDraft(user.id, { expiresAt: e.target.value })}
                        className="mt-0.5 rounded border border-border bg-background px-2 py-1 text-sm text-theme"
                      />
                    </label>
                    <button
                      onClick={() => extend(user)}
                      disabled={loading[user.id]}
                      className="rounded-md border border-primary/40 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                    >
                      {t("extendOneMonth")}
                    </button>
                    <label className="flex flex-col text-xs text-muted">
                      {t("feeColumn")}
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={draftFor(user).monthlyFee}
                        onChange={(e) => setDraft(user.id, { monthlyFee: e.target.value })}
                        className="mt-0.5 w-24 rounded border border-border bg-background px-2 py-1 text-sm text-theme"
                      />
                    </label>
                    {user.role !== "ADMIN" && (
                      <label className="flex flex-col text-xs text-muted">
                        档位
                        <select
                          value={draftFor(user).tier}
                          onChange={(e) => changeTier(user, e.target.value)}
                          disabled={loading[user.id]}
                          className="mt-0.5 rounded border border-primary/40 bg-background px-2 py-1 text-sm font-medium text-theme"
                          title="选档位即改加订与设备上限（下方两项是个人破例，留空则跟随档位）"
                        >
                          {TIER_OPTIONS.map(([v, label]) => (
                            <option key={v} value={v}>{label}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="flex flex-col text-xs text-muted">
                      设备上限
                      <input
                        type="number"
                        step="1"
                        min="1"
                        value={draftFor(user).deviceLimit}
                        onChange={(e) => setDraft(user.id, { deviceLimit: e.target.value })}
                        className="mt-0.5 w-24 rounded border border-border bg-background px-2 py-1 text-sm text-theme"
                        placeholder="跟档位"
                        title="留空 = 跟随档位；填数字 = 给这个用户单独设"
                      />
                    </label>
                    <label className="flex flex-col text-xs text-muted">
                      {t("paymentStatusColumn")}
                      <select
                        value={draftFor(user).paymentStatus}
                        onChange={(e) => setDraft(user.id, { paymentStatus: e.target.value })}
                        className="mt-0.5 rounded border border-border bg-background px-2 py-1 text-sm text-theme"
                      >
                        <option value="">—</option>
                        <option value="PAID">{t("payPaid")}</option>
                        <option value="UNPAID">{t("payUnpaid")}</option>
                        <option value="OVERDUE">{t("payOverdue")}</option>
                      </select>
                    </label>
                    <label className="flex flex-1 flex-col text-xs text-muted">
                      {t("notesColumn")}
                      <input
                        type="text"
                        value={draftFor(user).billingNotes}
                        onChange={(e) => setDraft(user.id, { billingNotes: e.target.value })}
                        className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm text-theme"
                      />
                    </label>
                    {/* Add-on is decided entirely by the tier — a VIP/超级VIP/挚友
                        has it, 普通 does not. So this is a read-only reflection
                        of the tier's state, not an editable field: to change
                        it, change the tier. Disabled and label-only. */}
                    <label className="flex items-center gap-2 text-xs text-muted"
                      title="加订由档位决定，改档位即可">
                      <input
                        type="checkbox"
                        checked={user.role === "ADMIN" || !!user.hasCapture}
                        disabled
                        readOnly
                        className="h-3.5 w-3.5 rounded border-border accent-primary opacity-70"
                      />
                      加订
                    </label>
                    <button
                      onClick={() => saveBilling(user)}
                      disabled={loading[user.id]}
                      className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
                    >
                      {t("save")}
                    </button>

                    {/* The account actions, kept off the row: each one changes
                        what someone can do or wipes their data, so they belong
                        behind a deliberate click rather than next to the
                        billing fields you skim. */}
                    {user.role !== "ADMIN" && (
                      <div className="flex w-full flex-wrap items-center gap-2 border-t border-border pt-2">
                        {user.role !== "PENDING" && (
                          <button
                            onClick={() => setRevokeTarget(user)}
                            disabled={loading[user.id]}
                            className="rounded-md border border-yellow-500/30 px-3 py-1 text-xs font-medium text-yellow-400 transition-colors hover:bg-yellow-500/10 disabled:opacity-50"
                          >
                            {t("revoke")}
                          </button>
                        )}
                        <button
                          onClick={() => setResetTarget(user)}
                          disabled={loading[user.id]}
                          className="rounded-md border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface-hover hover:text-theme disabled:opacity-50"
                        >
                          {t("resetPassword")}
                        </button>
                        <button
                          onClick={() => setDeleteTarget(user)}
                          disabled={loading[user.id]}
                          className="rounded-md border border-red-500/30 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                        >
                          {t("delete")}
                        </button>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title={t("deleteUserTitle")}
          message={`${t("deleteUserConfirm")} "${deleteTarget.username}"?`}
          confirmLabel={t("delete")}
          cancelLabel={t("cancel")}
          danger
          onConfirm={() => {
            perform(deleteTarget.id, () => adminAPI.deleteUser(deleteTarget.id));
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {revokeTarget && (
        <ConfirmDialog
          title={t("revokeUserTitle")}
          message={`${t("revokeUserConfirm")} "${revokeTarget.username}"?`}
          confirmLabel={t("revoke")}
          cancelLabel={t("cancel")}
          danger
          onConfirm={() => {
            perform(revokeTarget.id, () => adminAPI.demoteUser(revokeTarget.id));
            setRevokeTarget(null);
          }}
          onCancel={() => setRevokeTarget(null)}
        />
      )}

      {resetTarget && (
        <ConfirmDialog
          title={t("resetPasswordTitle")}
          message={`${t("resetPasswordConfirm")} "${resetTarget.username}"?`}
          confirmLabel={t("resetPassword")}
          cancelLabel={t("cancel")}
          onConfirm={() => {
            doReset(resetTarget);
            setResetTarget(null);
          }}
          onCancel={() => setResetTarget(null)}
        />
      )}

      {resetResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-5">
            <h2 className="mb-1 text-lg font-semibold" style={{ color: "var(--text)" }}>
              {t("resetPasswordDoneTitle")}
            </h2>
            <p className="mb-3 text-sm text-muted">
              {t("resetPasswordDoneBody").replace("{name}", resetResult.username)}
            </p>
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
              <code className="flex-1 select-all text-base font-semibold tracking-wide" style={{ color: "var(--text)" }}>
                {resetResult.tempPassword}
              </code>
              <button
                onClick={copyTempPassword}
                className="shrink-0 rounded-md border border-primary/40 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10"
              >
                {copied ? t("copied") : t("copy")}
              </button>
            </div>
            <p className="mb-4 text-xs text-muted">{t("resetPasswordDoneHint")}</p>
            <div className="flex justify-end">
              <button
                onClick={() => setResetResult(null)}
                className="rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-white hover:bg-primary/90"
              >
                {t("done")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
