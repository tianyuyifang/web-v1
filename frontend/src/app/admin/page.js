"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { adminAPI } from "@/lib/api";
import useAuth from "@/hooks/useAuth";
import UserTable from "@/components/admin/UserTable";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function AdminPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const { user, loading: authLoading, isAdmin } = useAuth();
  const [users, setUsers] = useState([]);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState("");

  const fetchUsers = useCallback(async () => {
    setFetching(true);
    setError("");
    try {
      const res = await adminAPI.listUsers();
      setUsers(res.data.users);
    } catch (err) {
      setError(err.response?.data?.error?.message || "Failed to load users");
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user || !isAdmin) {
      router.push("/dashboard");
      return;
    }
    fetchUsers();
  }, [authLoading, user, isAdmin, fetchUsers, router]);

  if (authLoading || fetching) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const pending = users.filter((u) => u.role === "PENDING");
  const members = users.filter((u) => u.role === "MEMBER");
  const admins = users.filter((u) => u.role === "ADMIN");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text)" }}>{t("userManagement")}</h1>
        <p className="mt-1 text-sm text-muted">{users.length} {t("totalUsers")}</p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400" role="alert">
          {error}
        </div>
      )}

      <div className="space-y-8">
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-yellow-400" />
            {t("pendingApproval")}
            <span className="ml-1 text-sm font-normal text-muted">({pending.length})</span>
          </h2>
          <UserTable users={pending} onRefresh={fetchUsers} />
        </section>

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-green-400" />
            {t("members")}
            <span className="ml-1 text-sm font-normal text-muted">({members.length})</span>
          </h2>
          <UserTable users={members} onRefresh={fetchUsers} />
        </section>

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-purple-400" />
            {t("admins")}
            <span className="ml-1 text-sm font-normal text-muted">({admins.length})</span>
          </h2>
          <UserTable users={admins} onRefresh={fetchUsers} />
        </section>
      </div>
    </div>
  );
}
