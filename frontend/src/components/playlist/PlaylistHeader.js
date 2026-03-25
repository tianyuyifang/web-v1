"use client";

import { useState } from "react";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";

const COLUMN_OPTIONS = [1, 2, 3, 4, 5];

export default function PlaylistHeader({
  playlist,
  editMode,
  onReturn,
  onToggleEditMode,
  columns,
  onColumnChange,
  onCopy,
  onUpdatePlaylist,
  onUnlikeAll,
  // Edit toolbar props
  onToggleCompact,
  onToggleBatch,
  onTogglePublic,
  onAddClip,
  onShare,
  onDelete,
  onCompare,
  compactView,
  batchMode,
}) {
  const { t } = useLanguage();
  const [editName, setEditName] = useState(playlist.name);
  const [editDesc, setEditDesc] = useState(playlist.description || "");

  const handleNameBlur = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== playlist.name) {
      onUpdatePlaylist?.({ name: trimmed });
    }
  };

  const handleDescBlur = () => {
    const trimmed = editDesc.trim();
    if (trimmed !== (playlist.description || "")) {
      onUpdatePlaylist?.({ description: trimmed || null });
    }
  };

  return (
    <div className="mb-4 space-y-1.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 shrink-0">
          {editMode ? (
            <>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleNameBlur}
                className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xl font-bold text-theme focus:border-primary focus:outline-none sm:text-2xl"
              />
              <input
                type="text"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                onBlur={handleDescBlur}
                placeholder={t("descriptionPlaceholder")}
                className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1 text-sm text-muted placeholder-muted focus:border-primary focus:outline-none"
              />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold sm:text-2xl" style={{ color: "var(--text)" }}>
                  <RichText text={playlist.name} />
                </h1>
                <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted">
                  {playlist.clips?.length || 0} {t("clips")}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${
                  playlist.isPublic
                    ? "bg-green-600 text-white"
                    : "bg-red-600 text-white"
                }`}>
                  {playlist.isPublic ? t("publicLabel") : t("privateLabel")}
                </span>
              </div>
              {playlist.description && (
                <p className="mt-1 text-sm text-muted">
                  <RichText text={playlist.description} />
                </p>
              )}
            </>
          )}
        </div>

        {/* Column selector — centered, hidden on mobile */}
        <div className="hidden flex-1 flex-col items-center gap-1 sm:flex">
          <span className="text-xs text-muted">{t("columnsPerRow")}</span>
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5">
            {COLUMN_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => onColumnChange(n)}
                aria-label={`${n} columns`}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  columns === n
                    ? "bg-primary text-white shadow-sm"
                    : "text-muted hover:bg-surface-hover hover:text-theme"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-col items-end gap-1.5">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={onReturn}
              className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium transition-colors hover:bg-surface-hover"
              style={{ color: "var(--text)" }}
            >
              {t("return")}
            </button>

            {playlist.isOwner && (
              <button
                onClick={onUnlikeAll}
                className="rounded-lg border border-red-500/30 px-3.5 py-1.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
              >
                {t("unlikeAll")}
              </button>
            )}

            {!editMode && (
              <button
                onClick={onCompare}
                className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium transition-colors hover:bg-surface-hover"
                style={{ color: "var(--text)" }}
              >
                {t("comparePlaylist")}
              </button>
            )}

            {playlist.isOwner && (
              <button
                onClick={onToggleEditMode}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  editMode
                    ? "bg-accent text-black shadow-sm"
                    : "border border-border bg-surface hover:bg-surface-hover"
                }`}
                style={editMode ? {} : { color: "var(--text)" }}
              >
                {editMode ? t("done") : t("edit")}
              </button>
            )}

            {!playlist.isOwner && playlist.canCopy && (
              <button
                onClick={onCopy}
                className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium hover:bg-surface-hover"
                style={{ color: "var(--text)" }}
              >
                {t("copyPlaylist")}
              </button>
            )}
          </div>

          {editMode && playlist.isOwner && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                onClick={onToggleCompact}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  compactView
                    ? "bg-primary text-white shadow-sm"
                    : "border border-border bg-surface hover:bg-surface-hover"
                }`}
                style={compactView ? {} : { color: "var(--text)" }}
              >
                {compactView ? t("fullView") : t("compactView")}
              </button>
              <button
                onClick={onToggleBatch}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  batchMode
                    ? "bg-purple-600 text-white shadow-sm"
                    : "border border-border bg-surface hover:bg-surface-hover"
                }`}
                style={batchMode ? {} : { color: "var(--text)" }}
              >
                {t("batch")}
              </button>
              <button
                onClick={onTogglePublic}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  playlist.isPublic
                    ? "bg-green-600 text-white hover:bg-green-500"
                    : "border border-border bg-surface hover:bg-surface-hover"
                }`}
                style={playlist.isPublic ? {} : { color: "var(--text)" }}
              >
                {playlist.isPublic ? t("publicLabel") : t("privateLabel")}
              </button>
              <button
                onClick={onAddClip}
                className="rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-primary-hover"
              >
                {t("addClip")}
              </button>
              <button
                onClick={onShare}
                className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium hover:bg-surface-hover"
                style={{ color: "var(--text)" }}
              >
                {t("share")}
              </button>
              <button
                onClick={onDelete}
                className="rounded-lg border border-red-500/30 px-3.5 py-1.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
              >
                {t("delete")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
