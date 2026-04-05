"use client";

import { useState } from "react";
import { playlistsAPI } from "@/lib/api";
import useSearch from "@/hooks/useSearch";
import ClipCreator from "@/components/library/ClipCreator";
import { formatDuration } from "@/lib/utils";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function AddClipModal({ playlistId, onClose, onClipAdded, onClipSelected, initialSong }) {
  const { t } = useLanguage();
  const [clipSong, setClipSong] = useState(initialSong || null);

  // --- Search ---
  const { query, setQuery, results, isSearching } = useSearch({
    endpoint: "/songs",
    extraParams: { strict: 1 },
  });

  const handleSelectClip = async (clipId) => {
    if (onClipSelected) {
      onClipSelected(clipId);
      return;
    }
    try {
      const res = await playlistsAPI.addClip(playlistId, { clipId });
      onClipAdded(res.data);
    } catch {
      // silent
    }
  };

  const handleClipCreated = async (clip) => {
    setClipSong(null);
    await handleSelectClip(clip.id);
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center">
        <div className="max-h-[90vh] w-full overflow-y-auto rounded-t-xl border border-border bg-surface p-4 sm:max-w-2xl sm:rounded-xl sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold">{t("addClipToPlaylist")}</h2>
            <button onClick={onClose} className="text-muted hover:text-theme">
              ✕
            </button>
          </div>

          {clipSong ? (
            <ClipCreator
              song={clipSong}
              onClose={() => setClipSong(null)}
              onClipCreated={handleClipCreated}
            />
          ) : (
            <>
              {/* Search */}
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("searchSongs")}
                className="mb-4 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
                autoFocus
              />

              <div className="max-h-80 overflow-y-auto">
                {isSearching && (
                  <p className="py-4 text-center text-sm text-muted">
                    {t("searching")}
                  </p>
                )}

                {!isSearching && results.length === 0 && query && (
                  <p className="py-4 text-center text-sm text-muted">
                    {t("noSongsFound")}
                  </p>
                )}

                {results.map((song) => (
                  <div
                    key={song.id}
                    className="border-b border-border py-3 last:border-0"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-theme">
                          {song.title}
                        </p>
                        <p className="text-xs text-muted">
                          {song.artist.replace(/_/g, "/")} · {formatDuration(song.duration)}
                        </p>
                      </div>
                      {(!song.clips || song.clips.length === 0) && (
                        <button
                          onClick={() => setClipSong(song)}
                          className="rounded bg-primary px-2 py-1 text-xs text-white hover:bg-primary-hover"
                        >
                          {t("createClip")}
                        </button>
                      )}
                    </div>

                    {song.clips && song.clips.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {song.clips.map((clip) => (
                          <button
                            key={clip.id}
                            onClick={() => handleSelectClip(clip.id)}
                            className="rounded border border-border bg-background px-2 py-0.5 text-xs text-muted hover:border-primary hover:text-theme"
                          >
                            {formatDuration(clip.start)}
                          </button>
                        ))}
                        <button
                          onClick={() => setClipSong(song)}
                          className="rounded border border-border bg-background px-2 py-0.5 text-xs text-muted hover:border-primary hover:text-theme"
                        >
                          {t("newClipButton")}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

    </>
  );
}
