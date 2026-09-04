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
import TierConfigPanel from "@/components/admin/TierConfigPanel";
import SignupPromoPanel from "@/components/admin/SignupPromoPanel";
import UpdatesPanel from "@/components/admin/UpdatesPanel";
import { useLanguage } from "@/components/layout/LanguageProvider";

/**
 * One feedback row's reply. Written here and read by the user on the help
 * page; its presence is the item's status, so sending it marks the item
 * handled and clearing it un-handles it — there is no separate state to
 * forget to update.
 */
function FeedbackReplyBox({ item, onReplied }) {
  const [text, setText] = useState(item.reply || "");
  const [editing, setEditing] = useState(!item.reply);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      const res = await feedbackAPI.reply(item.id, text.trim());
      onReplied(res.data.feedback);
      setEditing(!res.data.feedback.reply);
    } catch {
      // keep the box open so the text is not lost
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="mt-2 flex items-baseline gap-2 text-sm">
        <span className="text-green-400">✅ {item.reply}</span>
        <span className="text-xs text-muted">
          {item.repliedAt ? new Date(item.repliedAt).toLocaleDateString() : ""}
        </span>
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-muted hover:text-theme"
        >
          修改
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) send(); }}
        placeholder="回复用户…"
        maxLength={1000}
        className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
      />
      <button
        onClick={send}
        disabled={busy || !text.trim()}
        className="shrink-0 rounded bg-primary px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
      >
        回复
      </button>
    </div>
  );
}

export default function AdminPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const { user, loading: authLoading, isAdmin } = useAuth();
  const [users, setUsers] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("members");
  // Replied feedback folds away so the list in front of the admin is only
  // what still needs an answer — the "clear it" feeling without deleting
  // anything, since deleting a row deletes the user's copy of the reply too.
  const [showReplied, setShowReplied] = useState(false);

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

  // Swap the replied item in place, so the list does not reload and collapse
  // whatever the admin was doing further down.
  const patchFeedback = useCallback((updated) => {
    setFeedback((prev) => prev.map((f) => (f.id === updated.id ? { ...f, ...updated } : f)));
  }, []);

  // Merge one updated user into the list in place, instead of refetching all of
  // them. Saving a member's billing kept the row where it is — the whole table
  // reloaded and the expanded editor collapsed, dropping the admin back to the
  // top of a long list after every single save. The billing endpoints return a
  // partial user (BILLING_SELECT), so fields the list needs but the endpoint
  // omits — ownedCount, hasCapture, … — are carried over from the existing row.
  const patchUser = useCallback((updated) => {
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)));
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

  // One 待审核 list now: everyone who is PENDING, whether a fresh applicant or
  // a member an admin revoked. They are the same role and the same approval
  // brings them in; a revoked one is only tagged (曾是会员) in the table so the
  // difference is still visible. All their data is untouched by the revoke and
  // returns on approval.
  const pending = users.filter((u) => u.role === "PENDING");

  // Expired is a member past their paid-until date — derived, never stored, so
  // extending a date silently un-expires them. They are still members and now
  // live in the 成员 tab, filterable by 已过期 rather than split into a tab of
  // their own (which also read confusingly as a second "已过期" beside 待审核).
  const members = users.filter((u) => u.role === "MEMBER");
  const admins = users.filter((u) => u.role === "ADMIN");

  const tabs = [
    { key: "members", label: t("members"), dot: "bg-green-400", count: members.length },
    { key: "pending", label: t("pendingApproval"), dot: "bg-yellow-400", count: pending.length },
    { key: "admins", label: t("admins"), dot: "bg-purple-400", count: admins.length },
    { key: "feedback", label: t("feedbackAdmin"), dot: "bg-blue-400", count: feedback.filter((f) => !f.reply).length },
    { key: "updates", label: t("updatesAdminSection"), dot: "bg-pink-400", count: null },
    { key: "bandwidth", label: t("bandwidthTitle"), dot: "bg-cyan-400", count: null },
    { key: "liveUsage", label: "唱卡使用", dot: "bg-rose-400", count: null },
    { key: "taggingUsage", label: "歌P使用", dot: "bg-amber-400", count: null },
    { key: "captureClient", label: "App版本", dot: "bg-lime-400", count: null },
    { key: "tiers", label: "档位设置", dot: "bg-indigo-400", count: null },
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

      {activeTab === "members" && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2 w-2 rounded-full bg-green-400" />
            {t("members")}
            <span className="ml-1 text-sm font-normal text-muted">({members.length})</span>
          </h2>
          <UserTable users={members} onRefresh={fetchUsers} onUserUpdated={patchUser} controls />
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

      {activeTab === "feedback" && (() => {
        // Split, not filtered away: replied items stay one click below, so
        // nothing has to be deleted to keep the working list short.
        const pendingFb = feedback.filter((f) => !f.reply);
        const repliedFb = feedback.filter((f) => f.reply);
        const row = (f) => {
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
                <FeedbackReplyBox item={f} onReplied={patchFeedback} />
              </div>
              <button
                onClick={() => handleDeleteFeedback(f.id)}
                className="shrink-0 text-xs font-medium text-red-400 hover:text-red-300"
              >
                ✕
              </button>
            </div>
          );
        };
        return (
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
              <span className="inline-block h-2 w-2 rounded-full bg-blue-400" />
              {t("feedbackAdmin")}
              <span className="ml-1 text-sm font-normal text-muted">待回复 {pendingFb.length}</span>
            </h2>
            {pendingFb.length === 0 ? (
              <p className="text-sm text-muted">没有待回复的反馈。</p>
            ) : (
              <div className="space-y-2">{pendingFb.map(row)}</div>
            )}
            {repliedFb.length > 0 && (
              <div className="mt-5 border-t border-border pt-3">
                <button
                  onClick={() => setShowReplied((v) => !v)}
                  aria-expanded={showReplied}
                  className="text-sm font-medium text-muted hover:text-theme"
                >
                  {showReplied ? "▾" : "▸"} 已回复 ({repliedFb.length})
                </button>
                {showReplied && (
                  <div className="mt-3 space-y-2">{repliedFb.map(row)}</div>
                )}
              </div>
            )}
          </section>
        );
      })()}

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
      {activeTab === "tiers" && <TierConfigPanel />}

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
