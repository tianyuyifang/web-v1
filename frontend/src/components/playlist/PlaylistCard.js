"use client";

import Link from "next/link";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";

export default function PlaylistCard({ playlist }) {
  const { t } = useLanguage();
  const clipCount = playlist.clipCount ?? playlist.clips?.length ?? 0;

  const badge = playlist.isOwner
    ? (playlist.isPublic ? t("public") : t("private"))
    : playlist.isShared
      ? t("shared")
      : t("public");

  return (
    <Link
      href={`/playlists/${playlist.id}`}
      className="group block rounded-xl border border-border bg-surface p-5 shadow-sm transition-all hover:border-primary/30 hover:bg-surface-hover hover:shadow-md hover:shadow-primary/5"
    >
      <h3 className="truncate text-sm font-semibold transition-colors group-hover:text-primary" style={{ color: "var(--text)" }}>
        <RichText text={playlist.name} />
      </h3>
      {playlist.description && (
        <p className="mt-1.5 truncate text-xs text-muted">
          <RichText text={playlist.description} />
        </p>
      )}
      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">
          {clipCount} {clipCount !== 1 ? t("clips") : t("clip")}
        </span>
        {badge && (
          <span className="rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium text-muted">
            {badge}
          </span>
        )}
      </div>
    </Link>
  );
}
