"use client";

import Link from "next/link";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";

export default function PlaylistCard({ playlist, listView }) {
  const { t } = useLanguage();
  const clipCount = playlist.clipCount ?? playlist.clips?.length ?? 0;

  const badge = playlist.isOwner
    ? (playlist.isPublic ? t("public") : t("private"))
    : playlist.isShared
      ? t("shared")
      : t("public");

  const badgeClass = playlist.isOwner
    ? (playlist.isPublic ? "bg-green-600 text-white" : "bg-red-600 text-white")
    : playlist.isShared
      ? "bg-blue-600 text-white"
      : "bg-green-600 text-white";

  if (listView) {
    return (
      <Link
        href={`/playlists/${playlist.id}`}
        className="flex items-center gap-3 border-b border-border/50 px-3 py-2.5 transition-colors hover:bg-surface-hover"
      >
        {/* Name */}
        <span className="w-40 shrink-0 truncate text-sm font-medium text-theme sm:w-48 md:w-56">
          <RichText text={playlist.name} />
        </span>

        {/* Owner */}
        <span className="hidden w-16 shrink-0 truncate text-xs text-primary sm:block">
          {playlist.ownerName ? `@${playlist.ownerName}` : ""}
        </span>

        {/* Description */}
        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted md:block">
          {playlist.description ? <RichText text={playlist.description} /> : ""}
        </span>

        {/* Clip count */}
        <span className="shrink-0 text-xs text-muted">
          {clipCount} {clipCount !== 1 ? t("clips") : t("clip")}
        </span>

        {/* Badge */}
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass}`}>
          {badge}
        </span>
      </Link>
    );
  }

  // Default card view
  return (
    <Link
      href={`/playlists/${playlist.id}`}
      className="group relative block rounded-xl border border-border bg-surface p-5 shadow-sm transition-all hover:border-primary/30 hover:bg-surface-hover hover:shadow-md hover:shadow-primary/5"
    >
      {playlist.ownerName && (
        <span className="absolute right-3 top-3 text-sm font-semibold text-primary">
          {playlist.ownerName}
        </span>
      )}
      <h3 className="truncate text-base font-semibold transition-colors group-hover:text-primary" style={{ color: "var(--text)" }}>
        <RichText text={playlist.name} />
      </h3>
      {playlist.description && (
        <p className="mt-1.5 whitespace-pre-line text-xs text-muted">
          <RichText text={playlist.description} />
        </p>
      )}
      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">
          {clipCount} {clipCount !== 1 ? t("clips") : t("clip")}
        </span>
        {badge && (
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeClass}`}>
            {badge}
          </span>
        )}
      </div>
    </Link>
  );
}
