"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { adminAPI, feedbackAPI } from "@/lib/api";
import useAuth from "@/hooks/useAuth";
import UserTable from "@/components/admin/UserTable";
import BandwidthPanel from "@/components/admin/BandwidthPanel";
import LiveUsagePanel from "@/components/admin/LiveUsagePanel";
import TaggingUsagePanel from "@/components/admin/TaggingUsagePanel";
import CaptureClientPanel from "@/components/admin/CaptureClientPanel";
import SignupPromoPanel from "@/components/admin/SignupPromoPanel";
import UpdatesPanel from "@/components/admin/UpdatesPanel";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function AdminPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const { user, loading: authLoading, isAdmin } = useAuth();
  const [users, setUsers] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("members");

  const fetchUsers = useCallback(async () => {
    setFetching(true);
    setError("");
    try {
      const [usersRes, feedbackRes] = await Promise.all([
        adminAPI.listUsers(),
        feedbackAPI.list(),
      ]);
      setUsers(usersRes.data.users);
      setFeedback(feedbackRes.data.feedback);
    } catch (err) {
      setError(err.response?.data?.error?.message || "Failed to load data");
    } finally {
      setFetching(false);
    }
  }, []);

  const handleDeleteFeedback = useCallback(async (id) => {
    try {
      await feedbackAPI.remove(id);
      setFeedback((prev) => prev.filter((f) => f.id !== id));
    } catch {
      // silent
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

  // Both lists are PENDING; demotedAt is what separates someone an admin
  // revoked from someone who has never been approved. Revocations from before
  // the field existed have no stamp, so they read as new applicants.
  const pending = users.filter((u) => u.role === "PENDING" && !u.demotedAt);
  const revoked = users.filter((u) => u.role === "PENDING" && u.demotedAt);
  const guests = users.filter((u) => u.role === "GUEST");
  /**
   * Past their paid-until date.
   *
   * Derived, never stored. Expiry changes nothing about what the account can
   * do — no job downgrades anyone and no route checks the date — so writing a
   * status would create a second source of truth that has to be kept in step
   * with the date it was derived from. Computed here, extending someone's date
   * moves them back to 成员 on the next load with nothing to undo.
   *
   * A member with no date set never expires, which is how an account that was
   * never on a monthly footing is meant to behave.
   */
  const isExpired = (u) => u.expiresAt && new Date(u.expiresAt) <= new Date();

  const members = users.filter((u) => u.role === "MEMBER" && !isExpired(u));
  const expired = users.filter((u) => u.role === "MEMBER" && isExpired(u));
  const admins = users.filter((u) => u.role === "ADMIN");

  const tabs = [
    { key: "members", label: t("members"), dot: "bg-green-400", count: members.length },
    { key: "expired", label: t("statusExpired"), dot: "bg-slate-400", count: expired.length },
    { key: "guests", label: t("guests"), dot: "bg-sky-400", count: guests.length },
    { key: "pending", label: t("pendingApproval"), dot: "bg-yellow-400", count: pending.length },
    { key: "revoked", label: t("revoked"), dot: "bg-orange-400", count: revoked.length },
    { key: "admins", label: t("admins"), dot: "bg-purple-400", count: admins.length },
    { key: "feedback", label: t("feedbackAdmin"), dot: "bg-blue-400", count: feedback.length },
    { key: "updates", label: t("updatesAdminSection"), dot: "bg-pink-400", count: null },
    { key: "bandwidth", label: t("bandwidthTitle"), dot: "bg-cyan-400", count: null },
    { key: "liveUsage", label: "唱卡使用", dot: "bg-rose-400", count: null },
    { key: "taggingUsage", label: "歌P使用", dot: "bg-amber-400", count: null },
    { key: "captureClient", label: "App版本", dot: "bg-lime-400", count: null },
    { key: "tools", label: "管理员工具", dot: "bg-teal-400", count: null },
  ];

  /**
   * Admin-only pages that are too big to live inside a tab.
   *
   * Each of these holds a lot of rows or runs for a long sitting, so they get
   * their own route; this tab is just the way in. Collected in one list so the
   * next one is a line here rather than another block of markup.
   */
  const ADMIN_TOOLS = [
    {
      href: "/mappings",
      name: "唱卡映射审核",
      desc: "把游戏里显示的歌名歌手对应到具体的音源。批准后全站生效，并且不再被自动搜索覆盖。",
    },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text)" }}>{t("userManagement")}</h1>
        <p className="mt-1 text-sm text-muted">{users.length} {t("totalUsers")}</p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400" role="alert">
          {error}
        </div>
      )}

      {/* Underline tab bar — click to switch which section is shown below */}
      <div className="mb-8 flex flex-wrap gap-x-5 gap-y-1 border-b border-border">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              aria-pressed={isActive}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted hover:text-theme"
              }`}
            >
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${tab.dot}`} />
              {tab.label}
              {tab.count !== null && (
                <span className="text-xs text-muted">({tab.count})</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Active section */}
      {activeTab === "pending" && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-yellow-400" />
            {t("pendingApproval")}
            <span className="ml-1 text-sm font-normal text-muted">({pending.length})</span>
          </h2>
          <UserTable users={pending} onRefresh={fetchUsers} />
        </section>
      )}

      {activeTab === "guests" && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-sky-400" />
            {t("guests")}
            <span className="ml-1 text-sm font-normal text-muted">({guests.length})</span>
          </h2>
          <UserTable users={guests} onRefresh={fetchUsers} controls />
        </section>
      )}

      {activeTab === "revoked" && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-orange-400" />
            {t("revoked")}
            <span className="ml-1 text-sm font-normal text-muted">({revoked.length})</span>
          </h2>
          <UserTable users={revoked} onRefresh={fetchUsers} />
        </section>
      )}

      {activeTab === "members" && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-green-400" />
            {t("members")}
            <span className="ml-1 text-sm font-normal text-muted">({members.length})</span>
          </h2>
          <UserTable users={members} onRefresh={fetchUsers} controls />
        </section>
      )}

      {activeTab === "expired" && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-slate-400" />
            {t("statusExpired")}
            <span className="ml-1 text-sm font-normal text-muted">({expired.length})</span>
          </h2>
          {/* Still members, and still able to do everything a member can —
              expiry is a billing fact here, not a restriction. The same
              controls as 成员 because extending a date is the usual next step. */}
          <p className="mb-3 text-xs text-muted">
            这些账号已过期，但功能不受影响。续期后会自动回到「{t("members")}」。
          </p>
          <UserTable users={expired} onRefresh={fetchUsers} controls />
        </section>
      )}

      {activeTab === "admins" && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-purple-400" />
            {t("admins")}
            <span className="ml-1 text-sm font-normal text-muted">({admins.length})</span>
          </h2>
          <UserTable users={admins} onRefresh={fetchUsers} />
        </section>
      )}

      {activeTab === "feedback" && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-blue-400" />
            {t("feedbackAdmin")}
            <span className="ml-1 text-sm font-normal text-muted">({feedback.length})</span>
          </h2>
          {feedback.length === 0 ? (
            <p className="text-sm text-muted">{t("feedbackEmpty")}</p>
          ) : (
            <div className="space-y-2">
              {feedback.map((f) => {
                const typeLabel = f.type === "BAD_SONG" ? t("feedbackBadSong")
                  : f.type === "REQUEST_SONG" ? t("feedbackRequestSong")
                  : t("feedbackGeneral");
                const typeColor = f.type === "BAD_SONG" ? "bg-red-500/15 text-red-400"
                  : f.type === "REQUEST_SONG" ? "bg-blue-500/15 text-blue-400"
                  : "bg-yellow-500/15 text-yellow-400";
                return (
                  <div key={f.id} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${typeColor}`}>{typeLabel}</span>
                        <span className="text-xs text-muted">{f.user.username}</span>
                        <span className="text-xs text-muted">{new Date(f.createdAt).toLocaleDateString()}</span>
                      </div>
                      {f.title && (
                        <div className="text-sm text-theme">
                          {f.title}{f.artist ? ` — ${f.artist}` : ""}
                        </div>
                      )}
                      {f.message && <p className="mt-1 text-sm text-muted">{f.message}</p>}
                    </div>
                    <button
                      onClick={() => handleDeleteFeedback(f.id)}
                      className="shrink-0 text-xs font-medium text-red-400 hover:text-red-300"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {activeTab === "updates" && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-pink-400" />
            {t("updatesAdminSection")}
          </h2>
          <UpdatesPanel />
        </section>
      )}

      {activeTab === "bandwidth" && <BandwidthPanel />}

      {activeTab === "liveUsage" && <LiveUsagePanel />}

      {activeTab === "taggingUsage" && <TaggingUsagePanel />}

      {activeTab === "captureClient" && <CaptureClientPanel />}

      {activeTab === "tools" && (
        <div className="space-y-6">
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-1 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-teal-400" />
            管理员工具
          </h2>
          <p className="mb-4 text-sm text-muted">
            这些页面只有管理员和被授权的账号能打开，且不在导航栏里。
          </p>
          <ul className="space-y-2">
            {ADMIN_TOOLS.map((tool) => (
              <li key={tool.href}>
                <Link
                  href={tool.href}
                  className="block rounded-lg border border-border p-4 transition-colors hover:border-primary hover:bg-surface-hover"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-theme">{tool.name}</span>
                    <span className="shrink-0 text-xs text-muted">{tool.href}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{tool.desc}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {/* Not a link like the ones above — the campaign is a short form, so it
            renders here rather than earning a route of its own. */}
        <SignupPromoPanel />
        </div>
      )}
    </div>
  );
}
