"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { playlistsAPI } from "@/lib/api";
import PlaylistCard from "@/components/playlist/PlaylistCard";
import SearchBar from "@/components/library/SearchBar";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { getPlaylistView, setPlaylistView } from "@/lib/utils";

export default function PlaylistsPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [playlists, setPlaylists] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("grid");

  useEffect(() => { setView(getPlaylistView()); }, []);

  const toggleView = (v) => {
    setView(v);
    setPlaylistView(v);
  };

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

  const isList = view === "list";

  const gridClass = "grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";
  const listClass = "rounded-xl border border-border bg-surface";

  function renderSection(title, items) {
    if (items.length === 0) return null;
    return (
      <section>
        <h2 className="mb-4 text-lg font-semibold" style={{ color: "var(--text)" }}>
          {title}
        </h2>
        {isList ? (
          <div className={listClass}>
            {items.map((playlist) => (
              <PlaylistCard key={playlist.id} playlist={playlist} listView />
            ))}
          </div>
        ) : (
          <div className={gridClass}>
            {items.map((playlist) => (
              <PlaylistCard key={playlist.id} playlist={playlist} />
            ))}
          </div>
        )}
      </section>
    );
  }

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

      <div className="mb-6 flex items-center gap-3">
        <div className="flex-1">
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder={t("searchPlaylists")}
          />
        </div>
        {/* View toggle — exact height match with SearchBar */}
        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background px-0.5">
          <button
            onClick={() => toggleView("grid")}
            className={`rounded-md px-2 py-1.5 transition-colors ${
              !isList ? "bg-primary text-white shadow-sm" : "text-muted hover:text-theme"
            }`}
            title="Grid"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
              <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5v3A1.5 1.5 0 0 1 5.5 7h-3A1.5 1.5 0 0 1 1 5.5v-3ZM9 2.5A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v3A1.5 1.5 0 0 1 13.5 7h-3A1.5 1.5 0 0 1 9 5.5v-3ZM1 10.5A1.5 1.5 0 0 1 2.5 9h3A1.5 1.5 0 0 1 7 10.5v3A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5v-3ZM9 10.5A1.5 1.5 0 0 1 10.5 9h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 13.5v-3Z" />
            </svg>
          </button>
          <button
            onClick={() => toggleView("list")}
            className={`rounded-md px-2 py-1.5 transition-colors ${
              isList ? "bg-primary text-white shadow-sm" : "text-muted hover:text-theme"
            }`}
            title="List"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
              <path fillRule="evenodd" d="M2 4a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11A.5.5 0 0 1 2 4Zm0 4a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11A.5.5 0 0 1 2 8Zm0 4a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11A.5.5 0 0 1 2 12Z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </div>

      {loading ? (
        isList ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-surface" />
            ))}
          </div>
        ) : (
          <div className={gridClass}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-28 animate-pulse rounded-xl bg-surface" />
            ))}
          </div>
        )
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
          {renderSection(t("myPlaylists"), myPlaylists)}
          {renderSection(t("sharedPlaylists"), sharedPlaylists)}
          {renderSection(t("publicPlaylists"), publicPlaylists)}
        </div>
      )}
    </div>
  );
}
