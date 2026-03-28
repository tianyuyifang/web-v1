"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { playlistsAPI } from "@/lib/api";
import PlaylistCard from "@/components/playlist/PlaylistCard";
import SearchBar from "@/components/library/SearchBar";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function PlaylistsPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [playlists, setPlaylists] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchPlaylists = useCallback((q) => {
    setLoading(true);
    playlistsAPI
      .list({ q: q || undefined })
      .then((res) => {
        const data = res.data;
        setPlaylists(Array.isArray(data) ? data : data.playlists || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchPlaylists(query);
  }, [query, fetchPlaylists]);

  const myPlaylists = useMemo(
    () => playlists.filter((p) => p.isOwner),
    [playlists]
  );
  const sharedPlaylists = useMemo(
    () => playlists.filter((p) => !p.isOwner && p.isShared),
    [playlists]
  );
  const publicPlaylists = useMemo(
    () => playlists.filter((p) => !p.isOwner && !p.isShared),
    [playlists]
  );

  return (
    <div className="pt-4">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--text)" }}>{t("playlists")}</h1>
          <p className="mt-1 text-sm text-muted">
            {playlists.length} {playlists.length !== 1 ? t("playlistsPlural") : t("playlist")}
          </p>
        </div>
        <button
          onClick={() => router.push("/playlists/new")}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover"
        >
          {t("newPlaylist")}
        </button>
      </div>

      <div className="mb-6">
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder={t("searchPlaylists")}
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-surface" />
          ))}
        </div>
      ) : playlists.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-lg font-medium text-muted">
            {query ? t("noPlaylistsMatch") : t("noPlaylistsYet")}
          </p>
          {!query && (
            <p className="mt-2 text-sm text-muted">{t("createToStart")}</p>
          )}
        </div>
      ) : (
        <div className="space-y-10">
          {/* My Playlists */}
          {myPlaylists.length > 0 && (
            <section>
              <h2 className="mb-4 text-lg font-semibold" style={{ color: "var(--text)" }}>
                {t("myPlaylists")}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {myPlaylists.map((playlist) => (
                  <PlaylistCard key={playlist.id} playlist={playlist} />
                ))}
              </div>
            </section>
          )}

          {/* Shared */}
          {sharedPlaylists.length > 0 && (
            <section>
              <h2 className="mb-4 text-lg font-semibold" style={{ color: "var(--text)" }}>
                {t("sharedPlaylists")}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {sharedPlaylists.map((playlist) => (
                  <PlaylistCard key={playlist.id} playlist={playlist} />
                ))}
              </div>
            </section>
          )}

          {/* Public */}
          {publicPlaylists.length > 0 && (
            <section>
              <h2 className="mb-4 text-lg font-semibold" style={{ color: "var(--text)" }}>
                {t("publicPlaylists")}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {publicPlaylists.map((playlist) => (
                  <PlaylistCard key={playlist.id} playlist={playlist} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
