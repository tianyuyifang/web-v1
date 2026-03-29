"use client";

import { useState, useMemo, Fragment } from "react";
import { matchesSearch, formatDuration } from "@/lib/utils";
import LikeButton from "@/components/player/LikeButton";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ClipSidebar({ clips, playlistId, onClipClick }) {
  const { t } = useLanguage();
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search) return clips;
    return clips.filter((pc) =>
      matchesSearch(
        search,
        pc.clip.song.title,
        pc.clip.song.artist,
        pc.clip.song.titlePinyin,
        pc.clip.song.titlePinyinInitials,
        pc.clip.song.titlePinyinConcat,
        pc.clip.song.artistPinyinConcat
      )
    );
  }, [clips, search]);

  return (
    <aside className="sticky top-[5.75rem] hidden max-h-[calc(100vh-5.75rem)] w-64 shrink-0 flex-col self-start rounded-lg border border-border bg-surface lg:flex">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <h2 className="mb-2 text-sm font-semibold text-theme">{t("clipsSidebar")}</h2>
        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("filterClipsSidebar")}
            className="w-full rounded border border-border bg-background px-2 py-1 pr-6 text-xs text-theme placeholder-muted focus:border-primary focus:outline-none"
          />
          {search && (
            <button
              onMouseDown={(e) => { e.preventDefault(); setSearch(""); }}
              className="absolute right-0 top-0 flex h-full w-7 items-center justify-center text-muted hover:text-theme"
              aria-label="Clear search"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="p-3 text-xs text-muted">{t("noClipsFound")}</p>
        ) : (
          filtered.map((pc) => (
            <Fragment key={pc.clipId}>
            {pc.sectionLabel && (
              <div className="flex items-center gap-2 bg-background px-3 py-1.5">
                <div className="h-px flex-1 bg-border" />
                <span className="shrink-0 text-xs font-semibold text-muted">{pc.sectionLabel}</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
            <div
              className="flex items-center gap-2 border-b border-border px-3 py-2.5"
            >
              <span className="w-5 shrink-0 text-right text-xs text-muted -ml-1">{pc.position + 1}</span>
              {pc.colorTag && (
                <div className="flex shrink-0 gap-0.5 self-stretch">
                  {pc.colorTag.split("|").filter(Boolean).map((c) => (
                    <div key={c} className="w-[3px] rounded-full" style={{ background: c }} />
                  ))}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-theme">{pc.clip.song.title}</p>
                <p className="truncate text-xs text-muted">
                  {pc.clip.song.artist.replace(/_/g, "/")} · {formatDuration(pc.clip.start)}
                </p>
              </div>
              <LikeButton playlistId={playlistId} clipId={pc.clipId} />
              {onClipClick && (
                <button
                  onClick={() => onClipClick(pc.clipId)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-theme"
                  title="Play"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 translate-x-px">
                    <path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.84Z" />
                  </svg>
                </button>
              )}
            </div>
            </Fragment>
          ))
        )}
      </div>
    </aside>
  );
}
