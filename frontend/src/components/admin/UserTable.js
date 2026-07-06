"use client";

import { useState, Fragment } from "react";
import { useRouter } from "next/navigation";
import { adminAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import ConfirmDialog from "@/components/ui/ConfirmDialog";

export default function UserTable({ users, onRefresh, controls = false }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [loading, setLoading] = useState({});
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [billingDraft, setBillingDraft] = useState({});
  const [sortKey, setSortKey] = useState("registered"); // registered | expiration | owned | shared
  const [sortDir, setSortDir] = useState("desc"); // asc | desc
  const [activeFilters, setActiveFilters] = useState({}); // { expired, expiringSoon, noPlaylists }

  function draftFor(user) {
    const d = billingDraft[user.id];
    if (d) return d;
    return {
      expiresAt: user.expiresAt ? String(user.expiresAt).slice(0, 10) : "",
      monthlyFee: user.monthlyFee != null ? String(user.monthlyFee) : "",
      paymentStatus: user.paymentStatus || "",
      billingNotes: user.billingNotes || "",
    };
  }

  function setDraft(userId, patch) {
    setBillingDraft((prev) => ({ ...prev, [userId]: { ...draftFor({ id: userId, ...users.find((u) => u.id === userId) }), ...patch } }));
  }

  async function saveBilling(user) {
    const d = draftFor(user);
    await perform(user.id, () => adminAPI.updateBilling(user.id, {
      expiresAt: d.expiresAt ? new Date(d.expiresAt + "T00:00:00.000Z").toISOString() : null,
      monthlyFee: d.monthlyFee === "" ? null : d.monthlyFee,
      paymentStatus: d.paymentStatus || null,
      billingNotes: d.billingNotes || null,
    }));
    setBillingDraft((prev) => { const n = { ...prev }; delete n[user.id]; return n; });
  }

  async function extend(user) {
    await perform(user.id, () => adminAPI.extendOneMonth(user.id));
    setBillingDraft((prev) => { const n = { ...prev }; delete n[user.id]; return n; });
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

  function toggleFilter(key) {
    setActiveFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // Filter + sort (only meaningful when controls are shown; harmless otherwise).
  const SORT_ACCESSORS = {
    registered: (u) => new Date(u.createdAt).getTime(),
    expiration: (u) => (u.expiresAt ? new Date(u.expiresAt).getTime() : -Infinity),
    owned: (u) => u.ownedCount ?? 0,
    shared: (u) => u.sharedCount ?? 0,
  };

  function passesFilters(u) {
    if (activeFilters.expired) {
      if (!(u.expiresAt && new Date(u.expiresAt).getTime() < Date.now())) return false;
    }
    if (activeFilters.expiringSoon) {
      if (!u.expiresAt) return false;
      const ms = new Date(u.expiresAt).getTime() - Date.now();
      if (!(ms >= 0 && ms <= 30 * 24 * 60 * 60 * 1000)) return false;
    }
    if (activeFilters.noPlaylists) {
      if ((u.ownedCount ?? 0) !== 0) return false;
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
    { key: "expiration", label: t("sortExpiration") },
    { key: "owned", label: t("sortOwned") },
    { key: "shared", label: t("sortShared") },
  ];
  const filterChips = [
    { key: "expired", label: t("filterExpired") },
    { key: "expiringSoon", label: t("filterExpiringSoon") },
    { key: "noPlaylists", label: t("filterNoPlaylists") },
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
            <th className="pb-2 pr-4">{t("expiresColumn")}</th>
            <th className="pb-2 pr-4">{t("ownedColumn")}</th>
            <th className="pb-2 pr-4">{t("sharedColumn")}</th>
            <th className="pb-2">{t("actions")}</th>
          </tr>
        </thead>
        <tbody>
          {displayUsers.length === 0 && (
            <tr>
              <td colSpan={7} className="py-4 text-center text-sm text-muted">
                {t("noUsersInGroup")}
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
                      : "bg-yellow-500/15 text-yellow-400"
                  }`}
                >
                  {user.role}
                </span>
              </td>
              <td className="py-3 pr-4 text-muted">
                {new Date(user.createdAt).toLocaleDateString()}
              </td>
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
                {user.role === "PENDING" && (
                  <button
                    onClick={() => perform(user.id, () => adminAPI.approveUser(user.id))}
                    disabled={loading[user.id]}
                    className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white shadow-sm transition-colors hover:bg-green-500 disabled:opacity-50"
                  >
                    {t("approve")}
                  </button>
                )}
                {user.role === "MEMBER" && (
                  <button
                    onClick={() => setRevokeTarget(user)}
                    disabled={loading[user.id]}
                    className="rounded-md border border-yellow-500/30 px-3 py-1 text-xs font-medium text-yellow-400 transition-colors hover:bg-yellow-500/10 disabled:opacity-50"
                  >
                    {t("revoke")}
                  </button>
                )}
                {user.role !== "ADMIN" && (
                  <button
                    onClick={() => setDeleteTarget(user)}
                    disabled={loading[user.id]}
                    className="rounded-md border border-red-500/30 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                  >
                    {t("delete")}
                  </button>
                )}
              </td>
            </tr>
              {expandedId === user.id && (
              <tr className="border-b border-border/50 last:border-0">
                <td colSpan={7} className="pb-3">
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
                    <button
                      onClick={() => saveBilling(user)}
                      disabled={loading[user.id]}
                      className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
                    >
                      {t("save")}
                    </button>
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
    </>
  );
}
