"use client";

import { useState, useEffect, useCallback } from "react";
import { updatesAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";

const CATEGORY_STYLES = {
  FEATURE: "bg-green-500/15 text-green-400",
  FIX: "bg-blue-500/15 text-blue-400",
  ANNOUNCEMENT: "bg-yellow-500/15 text-yellow-400",
};

function categoryLabel(t, category) {
  if (category === "FEATURE") return t("updateCategoryFeature");
  if (category === "FIX") return t("updateCategoryFix");
  return t("updateCategoryAnnouncement");
}

export default function UpdatesPage() {
  const { t } = useLanguage();
  const [updates, setUpdates] = useState([]);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState("");

  const fetchUpdates = useCallback(async () => {
    setFetching(true);
    setError("");
    try {
      const res = await updatesAPI.list();
      setUpdates(res.data.updates);
    } catch (err) {
      setError(err.response?.data?.error?.message || "Failed to load updates");
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    fetchUpdates();
  }, [fetchUpdates]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text)" }}>{t("updatesTitle")}</h1>
        <p className="mt-1 text-sm text-muted">{t("updatesSubtitle")}</p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400" role="alert">
          {error}
        </div>
      )}

      {fetching ? (
        <div className="flex min-h-[30vh] items-center justify-center text-muted">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : updates.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">{t("updatesEmpty")}</p>
      ) : (
        <div className="space-y-4">
          {updates.map((u) => (
            <article key={u.id} className="rounded-xl border border-border bg-surface p-5">
              <div className="mb-2 flex items-center gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${CATEGORY_STYLES[u.category] || CATEGORY_STYLES.ANNOUNCEMENT}`}>
                  {categoryLabel(t, u.category)}
                </span>
                <span className="text-xs text-muted">{new Date(u.createdAt).toLocaleDateString()}</span>
              </div>
              <h2 className="mb-1 text-base font-semibold text-theme">{u.title}</h2>
              <div className="whitespace-pre-line text-sm text-muted">
                <RichText text={u.body} />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
