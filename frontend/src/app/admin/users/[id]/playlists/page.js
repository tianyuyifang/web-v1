"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { adminAPI, playlistsAPI } from "@/lib/api";
import useAuth from "@/hooks/useAuth";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";

export default function AdminUserPlaylistsPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const params = useParams();
  const userId = params.id;
  const { user, loading: authLoading, isAdmin } = useAuth();

  const [owner, setOwner] = useState(null);
  const [playlists, setPlaylists] = useState([]);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState({}); // { [playlistId]: "copying" | "copied" }

  const fetchPlaylists = useCallback(async () => {
    setFetching(true);
    setError("");
    try {
      const res = await adminAPI.listUserPlaylists(userId);
      setOwner(res.data.owner);
      setPlaylists(res.data.playlists);
    } catch (err) {
      setError(err.response?.data?.error?.message || t("actionFailed"));
    } finally {
      setFetching(false);
    }
  }, [userId, t]);

  useEffect(() => {
    if (authLoading) return;
    if (!user || !isAdmin) {
      router.push("/dashboard");
      return;
    }
    fetchPlaylists();
  }, [authLoading, user, isAdmin, fetchPlaylists, router]);

  async function handleCopy(playlistId) {
    setCopyState((prev) => ({ ...prev, [playlistId]: "copying" }));
    try {
      await playlistsAPI.copy(playlistId);
      setCopyState((prev) => ({ ...prev, [playlistId]: "copied" }));
    } catch (err) {
      setError(err.response?.data?.error?.message || t("actionFailed"));
      setCopyState((prev) => {
        const next = { ...prev };
        delete next[playlistId];
        return next;
      });
    }
  }

  if (authLoading || fetching) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/admin" className="text-sm text-muted hover:text-theme">
        {t("backToAdmin")}
      </Link>

      <div className="mb-6 mt-3">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text)" }}>
          {owner?.username} {t("userPlaylistsTitle")}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {playlists.length} {playlists.length !== 1 ? t("playlistsPlural") : t("playlist")}
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400" role="alert">
          {error}
        </div>
      )}

      {playlists.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">{t("noPlaylistsForUser")}</p>
      ) : (
        <div className="rounded-xl border border-border bg-surface">
          {playlists.map((p, i) => {
            const state = copyState[p.id];
            return (
              <div
                key={p.id}
                className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0"
              >
                <span className="w-5 shrink-0 text-center text-xs text-muted">{i + 1}</span>
                <Link
                  href={`/playlists/${p.id}`}
                  className="min-w-0 flex-1 truncate text-sm text-theme transition-colors hover:text-primary"
                >
                  <span className="font-medium"><RichText text={p.name} /></span>
                  <span className="ml-2 text-xs text-muted">
                    {p.clipCount} {p.clipCount !== 1 ? t("clips") : t("clip")}
                  </span>
                  {p.description && (
                    <span className="ml-2 hidden text-xs text-muted md:inline">
                      <RichText text={p.description} />
                    </span>
                  )}
                </Link>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    p.isPublic ? "bg-green-600 text-white" : "bg-red-600 text-white"
                  }`}
                >
                  {p.isPublic ? t("public") : t("private")}
                </span>
                <button
                  onClick={() => handleCopy(p.id)}
                  disabled={state === "copying" || state === "copied"}
                  className="shrink-0 rounded-md border border-border px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
                >
                  {state === "copying" ? t("copying") : state === "copied" ? t("copiedToast") : t("copyToMyPlaylists")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
