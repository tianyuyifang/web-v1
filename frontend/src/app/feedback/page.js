"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { feedbackAPI } from "@/lib/api";
import useAuth from "@/hooks/useAuth";
import { useLanguage } from "@/components/layout/LanguageProvider";

const TYPES = [
  { key: "BAD_SONG", label: "feedbackTypeBadSong", desc: "feedbackTypeBadSongDesc", color: "text-red-400" },
  { key: "REQUEST_SONG", label: "feedbackTypeRequestSong", desc: "feedbackTypeRequestSongDesc", color: "text-blue-400" },
  { key: "GENERAL", label: "feedbackTypeGeneral", desc: "feedbackTypeGeneralDesc", color: "text-yellow-400" },
];

export default function FeedbackPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [type, setType] = useState(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  if (authLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!user) {
    router.push("/login");
    return null;
  }

  const handleSubmit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await feedbackAPI.submit({
        type,
        title: title.trim() || undefined,
        artist: artist.trim() || undefined,
        message: message.trim() || undefined,
      });
      setSuccess(true);
    } catch (err) {
      setError(err.response?.data?.error?.message || "Failed to submit feedback");
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    setType(null);
    setTitle("");
    setArtist("");
    setMessage("");
    setSuccess(false);
    setError("");
  };

  const isSongType = type === "BAD_SONG" || type === "REQUEST_SONG";
  const canSubmit = isSongType ? title.trim() && artist.trim() : type === "GENERAL" ? message.trim() : false;

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="mb-2 text-2xl font-bold" style={{ color: "var(--text)" }}>
        {t("feedbackTitle")}
      </h1>
      <p className="mb-6 text-sm text-muted">{t("feedbackDesc")}</p>

      {success ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-400">
            {t("feedbackSuccess")}
          </div>
          <div className="flex justify-center gap-2">
            <button
              onClick={handleReset}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-hover"
            >
              {t("feedbackBack")}
            </button>
            <button
              onClick={() => router.push("/playlists")}
              className="rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium transition-colors hover:bg-surface-hover"
              style={{ color: "var(--text)" }}
            >
              {t("return")}
            </button>
          </div>
        </div>
      ) : !type ? (
        <div className="space-y-3">
          {TYPES.map((t_) => (
            <button
              key={t_.key}
              onClick={() => setType(t_.key)}
              className="w-full rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-primary"
            >
              <div className={`font-medium ${t_.color}`}>{t(t_.label)}</div>
              <div className="mt-0.5 text-xs text-muted">{t(t_.desc)}</div>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {isSongType && (
            <>
              <div>
                <label className="mb-1 block text-sm font-medium text-theme">
                  {t("feedbackSongTitle")} *
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-theme">
                  {t("feedbackArtist")} *
                </label>
                <input
                  type="text"
                  value={artist}
                  onChange={(e) => setArtist(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-theme">
                  {t("feedbackMessage")}
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
                />
              </div>
            </>
          )}

          {type === "GENERAL" && (
            <div>
              <label className="mb-1 block text-sm font-medium text-theme">
                {t("feedbackMessage")} *
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
                autoFocus
              />
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleSubmit}
              disabled={submitting || !canSubmit}
              className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {submitting ? t("feedbackSubmitting") : t("feedbackSubmit")}
            </button>
            <button
              onClick={handleReset}
              className="rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium transition-colors hover:bg-surface-hover"
              style={{ color: "var(--text)" }}
            >
              {t("return")}
            </button>
          </div>
        </div>
      )}

      {!type && !success && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={() => router.push("/playlists")}
            className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium transition-colors hover:bg-surface-hover"
            style={{ color: "var(--text)" }}
          >
            {t("return")}
          </button>
        </div>
      )}
    </div>
  );
}
