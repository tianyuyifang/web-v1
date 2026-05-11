"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { playlistsAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import PlaylistPicker from "@/components/tools/PlaylistPicker";

function formatSummary(template, summary, name) {
  return template
    .replace("{name}", name)
    .replace("{added}", summary.added)
    .replace("{merged}", summary.merged)
    .replace("{markedDifferent}", summary.markedDifferent)
    .replace("{markedDeleted}", summary.markedDeleted);
}

export default function MergePage() {
  const { t } = useLanguage();
  const router = useRouter();

  const [aPlaylist, setAPlaylist] = useState(null);
  const [bPlaylist, setBPlaylist] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const canMerge = aPlaylist && bPlaylist && aPlaylist.id !== bPlaylist.id;

  const handleConfirm = async () => {
    setSubmitting(true);
    setError("");
    try {
      const res = await playlistsAPI.merge(aPlaylist.id, bPlaylist.id);
      const { id, name, summary } = res.data;
      const message = formatSummary(t("mergeSuccessSummary"), summary, name);
      if (typeof window !== "undefined") {
        sessionStorage.setItem("lastMergeSummary", message);
      }
      router.push(`/playlists/${id}`);
    } catch (err) {
      setError(err.response?.data?.error?.message || "Failed to merge");
      setShowConfirm(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isDesktop) {
    return (
      <main className="mx-auto max-w-screen-md p-6">
        <p className="text-center text-muted">{t("toolsDesktopOnly")}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-screen-lg p-6">
      <h1 className="mb-4 text-2xl font-bold" style={{ color: "var(--text)" }}>
        {t("merge")}
      </h1>

      <div className="mb-6 space-y-3 rounded-lg border border-border bg-surface p-4">
        <PlaylistPicker
          label={t("mergeBaseline")}
          value={aPlaylist}
          onChange={setAPlaylist}
          excludeId={bPlaylist?.id}
          ownerOnly
        />
        <PlaylistPicker
          label={t("mergeSource")}
          value={bPlaylist}
          onChange={setBPlaylist}
          excludeId={aPlaylist?.id}
        />
        <div>
          <button
            type="button"
            disabled={!canMerge || submitting}
            onClick={() => setShowConfirm(true)}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("mergeButton")}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {showConfirm && aPlaylist && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-xl border border-border bg-surface p-5">
            <h2 className="mb-2 text-lg font-semibold" style={{ color: "var(--text)" }}>
              {t("mergeConfirmTitle")}
            </h2>
            <p className="mb-4 text-sm text-muted">
              {t("mergeConfirmBody").replace("{name}", `更新版 ${aPlaylist.name}`)}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setShowConfirm(false)}
                className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium hover:bg-surface-hover disabled:opacity-50"
                style={{ color: "var(--text)" }}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={handleConfirm}
                className="rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-primary-hover disabled:opacity-50"
              >
                {t("mergeButton")}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
