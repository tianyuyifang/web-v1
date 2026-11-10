"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import api from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";

/**
 * The playlists page's 歌曲 search: every song in the library, each with the
 * caller's own playlists that hold a clip of it. Look only -- no adding here.
 */
export default function SongSearchResults({ query }) {
  const { t } = useLanguage();
  const [songs, setSongs] = useState([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState(0); // where the next page starts (from the server)
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false); // the last request got no answer: say so, "no songs" would be a lie
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    setLoadingMore(false);
    setFailed(false);
    if (!query.trim()) {
      setSongs([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    api.get("/songs/search", { params: { q: query, mine: 1 } })
      .then((res) => {
        if (seq !== seqRef.current) return; // a newer query is on its way
        setSongs(res.data.songs || []);
        setTotal(res.data.total || 0);
        setNext(res.data.nextOffset || 0);
      })
      .catch(() => {
        if (seq === seqRef.current) { setSongs([]); setTotal(0); setNext(0); setFailed(true); }
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
  }, [query]);

  // The next page of the same search, appended below.
  const loadMore = () => {
    const seq = seqRef.current;
    setLoadingMore(true);
    setFailed(false);
    api.get("/songs/search", { params: { q: query, mine: 1, offset: next } })
      .then((res) => {
        if (seq !== seqRef.current) return;
        // The library may have changed between pages: never show a song twice
        const have = new Set(songs.map((s) => s.id));
        setSongs([...songs, ...(res.data.songs || []).filter((s) => !have.has(s.id))]);
        setTotal(res.data.total || 0);
        setNext(res.data.nextOffset || total);
      })
      .catch(() => {
        if (seq === seqRef.current) setFailed(true); // the button stays: clicking again retries
      })
      .finally(() => {
        if (seq === seqRef.current) setLoadingMore(false);
      });
  };

  if (!query.trim()) return null;
  if (loading) return <p className="py-4 text-center text-sm text-muted">{t("searching")}</p>;
  if (failed && !songs.length) return <p className="py-4 text-center text-sm text-muted">{t("songSearchFailed")}</p>;
  if (!songs.length) return <p className="py-4 text-center text-sm text-muted">{t("noSongsFound")}</p>;

  return (
    <div>
      <p className="mb-2 text-xs text-muted">
        {total > songs.length
          ? t("songSearchCountCapped").replace("{n}", total).replace("{shown}", songs.length)
          : t("songSearchCount").replace("{n}", total)}
      </p>
      <div className="rounded-xl border border-border bg-surface">
        {songs.map((song) => (
          <div key={song.id} className="border-b border-border px-4 py-3 last:border-0">
            <p className="text-sm font-medium text-theme">
              {song.title}
              <span className="font-normal text-muted"> · {song.artist.replace(/_/g, "/")}</span>
            </p>
            {song.myPlaylists?.length ? (
              <p className="mt-1 text-xs text-muted">
                {t("songInMyPlaylists")}
                {song.myPlaylists.map((pl, i) => (
                  <span key={pl.id}>
                    {i > 0 && "、"}
                    <Link href={`/playlists/${pl.id}`} className="text-primary hover:underline">
                      {pl.name}
                    </Link>
                  </span>
                ))}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted opacity-70">{t("songNotInMyPlaylists")}</p>
            )}
          </div>
        ))}
      </div>
      {next < total && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="mt-3 w-full rounded-lg border border-border bg-surface py-2 text-sm text-muted hover:text-theme disabled:opacity-60"
        >
          {loadingMore ? t("searching") : t("songSearchMore").replace("{n}", Math.max(total - songs.length, 1))}
        </button>
      )}
      {failed && <p className="mt-2 text-center text-xs text-muted">{t("songSearchFailed")}</p>}
    </div>
  );
}
