"use client";

import { useState } from "react";
import { adminAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import ConfirmDialog from "@/components/ui/ConfirmDialog";

export default function UserTable({ users: initialUsers, onRefresh }) {
  const { t } = useLanguage();
  const [users, setUsers] = useState(initialUsers);
  const [loading, setLoading] = useState({});
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);

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

  if (users.length === 0) {
    return <p className="py-3 text-center text-sm text-muted">{t("noUsersInGroup")}</p>;
  }

  return (
    <>
      {error && (
        <div className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted">
            <th className="pb-2 pr-4">{t("username")}</th>
            <th className="pb-2 pr-4">{t("role")}</th>
            <th className="pb-2 pr-4">{t("joined")}</th>
            <th className="pb-2">{t("actions")}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-b border-border/50 last:border-0">
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
              <td className="flex gap-2 py-3">
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
                    onClick={() => perform(user.id, () => adminAPI.demoteUser(user.id))}
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
    </>
  );
}
