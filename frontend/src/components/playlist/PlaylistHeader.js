"use client";

import { useState } from "react";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";
import OverflowMenu from "@/components/ui/OverflowMenu";
import useAuth from "@/hooks/useAuth";
import usePlayerStore from "@/store/playerStore";

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
  const { isAdmin } = useAuth();
  const autoPlayEnabled = usePlayerStore((s) => s.autoPlayEnabled);
  const setAutoPlayEnabled = usePlayerStore((s) => s.setAutoPlayEnabled);
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

  const overflowItems = [
    {
      id: "autoplay",
      label: autoPlayEnabled ? t("autoPlayOn") : t("autoPlayOff"),
      onClick: () => setAutoPlayEnabled(!autoPlayEnabled),
      active: autoPlayEnabled,
      hidden: !isAdmin,
    },
    {
      id: "compare",
      label: t("comparePlaylist"),
      onClick: () => onCompare?.(),
      hidden: editMode,
    },
    {
      id: "copy",
      label: t("copyPlaylist"),
      onClick: () => onCopy?.(),
      hidden: !(playlist.isOwner || playlist.canCopy),
    },
    {
      id: "compact",
      label: compactView ? t("fullView") : t("compactView"),
      onClick: () => onToggleCompact?.(),
      active: compactView,
      hidden: !editMode || !playlist.isOwner,
    },
  ];

  // Everything the desktop header offers, including the overflow menu's
  // contents, as one flat list for the phone grid.
  const NEUTRAL = "border border-border bg-surface hover:bg-surface-hover";
  const phoneActions = [
    { id: "return", label: t("return"), onClick: onReturn,
      className: NEUTRAL, style: { color: "var(--text)" } },
    playlist.isOwner && {
      id: "unlikeAll", label: t("unlikeAllShort"), onClick: onUnlikeAll,
      className: "border border-red-500/30 text-red-400 hover:bg-red-500/10" },
    playlist.isOwner && {
      id: "share", label: t("share"), onClick: () => onShare?.(),
      className: NEUTRAL, style: { color: "var(--text)" } },
    playlist.isOwner && {
      id: "public",
      label: playlist.isPublic ? t("setPrivateShort") : t("setPublicShort"),
      onClick: () => onTogglePublic?.(),
      className: NEUTRAL, style: { color: "var(--text)" } },
    playlist.isOwner && {
      id: "edit", label: editMode ? t("done") : t("edit"), onClick: onToggleEditMode,
      className: editMode ? "bg-accent text-black shadow-sm" : NEUTRAL,
      style: editMode ? undefined : { color: "var(--text)" } },
    // …the overflow menu's own items, flattened. Two of them are too long for
    // a phone-width cell, so they get a shorter label here.
    ...overflowItems
      .filter((i) => !i.hidden)
      .map((i) => ({
        id: i.id,
        label: i.id === "autoplay"
          ? (autoPlayEnabled ? t("autoPlayOnShort") : t("autoPlayOffShort"))
          : i.id === "copy" ? t("copyShort") : i.label,
        onClick: i.onClick,
        className: i.active ? "bg-primary text-white shadow-sm" : NEUTRAL,
        style: i.active ? undefined : { color: "var(--text)" },
      })),
    // …and the edit toolbar, which on desktop is a row of its own inside the
    // block phones no longer render.
    ...(editMode && playlist.isOwner
      ? [
          { id: "batch", label: t("batch"), onClick: onToggleBatch,
            className: batchMode ? "bg-purple-600 text-white shadow-sm" : NEUTRAL,
            style: batchMode ? undefined : { color: "var(--text)" } },
          { id: "addClip", label: t("addClip"), onClick: onAddClip,
            className: "bg-primary text-white shadow-sm hover:bg-primary-hover" },
          { id: "delete", label: t("delete"), onClick: onDelete,
            className: "border border-red-500/30 text-red-400 hover:bg-red-500/10" },
        ]
      : []),
  ].filter(Boolean);

  return (
    <div className="mb-4 space-y-1.5">
      {/* Three tracks on desktop: title | selector | actions. The outer two are
          minmax(0,1fr), so they stay equal and the middle track lands on the
          header's true centre however wide the actions or the title get. A flex
          row could not do both at once — centring the selector there meant
          taking it out of the flow, which let the description run underneath
          it. Split over two rows the actions need ~250px, which an equal share
          affords from lg up; below that the tracks size to content and the
          selector sits off-centre rather than squeezing the title. Phones
          stack, as before. */}
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(11rem,1fr)_auto_auto] sm:items-start sm:gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="min-w-0">
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
              <div className="flex items-center gap-2 sm:min-w-0">
                <h1 className="text-xl font-bold sm:truncate sm:text-2xl" style={{ color: "var(--text)" }}>
                  <RichText text={playlist.name} />
                </h1>
                <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs text-muted">
                  {playlist.clips?.length || 0} {t("clips")}
                </span>
                {playlist.ownerName && (
                  <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs text-muted">
                    {playlist.isOwner ? t("you") : `@${playlist.ownerName}`}
                  </span>
                )}
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                  playlist.isPublic
                    ? "bg-green-600 text-white"
                    : "bg-red-600 text-white"
                }`}>
                  {playlist.isPublic ? t("publicLabel") : t("privateLabel")}
                </span>
              </div>
              {playlist.description && (
                <p className="mt-1 text-sm text-muted sm:line-clamp-2" title={playlist.description}>
                  <RichText text={playlist.description} />
                </p>
              )}
            </>
          )}
        </div>

        {/* Column selector — hidden on mobile, the auto-sized middle track. */}
        <div className="hidden flex-col items-center gap-1 sm:flex">
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

        {/* Phones get their own action block. Stacked, the header gives the
            buttons a full-width row of their own, so everything the overflow
            menu holds on desktop is laid out flat here — no menu to open. The
            column count is derived from how many there are so they always fill
            exactly two rows: eleven in edit mode would overflow a fixed four. */}
        <div
          className="grid gap-1.5 sm:hidden"
          style={{ gridTemplateColumns: `repeat(${Math.ceil(phoneActions.length / 2)}, minmax(0, 1fr))` }}
        >
          {phoneActions.map((a) => (
            <button
              key={a.id}
              onClick={a.onClick}
              className={`truncate rounded-lg px-1 py-1.5 text-[11px] font-medium transition-colors ${a.className}`}
              style={a.style}
            >
              {a.label}
            </button>
          ))}
        </div>

        <div className="hidden min-w-0 flex-col items-end gap-1.5 sm:flex">
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

            {/* Out of the overflow menu and into the row: centring the column
                selector freed the space this now sits in. */}
            {playlist.isOwner && (
              <button
                onClick={() => onShare?.()}
                className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium transition-colors hover:bg-surface-hover"
                style={{ color: "var(--text)" }}
              >
                {t("share")}
              </button>
            )}
          </div>

          {/* Second row. Six buttons need about 490px, more than the header can
              spare below the widest screens, so they are split rather than left
              to wrap at a point that depends on the window. */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {playlist.isOwner && (
              <button
                onClick={() => onTogglePublic?.()}
                className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium transition-colors hover:bg-surface-hover"
                style={{ color: "var(--text)" }}
              >
                {playlist.isPublic ? t("setPlaylistPrivate") : t("setPlaylistPublic")}
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

            <OverflowMenu items={overflowItems} />
          </div>

          {editMode && playlist.isOwner && (
            <div className="flex flex-wrap items-center justify-end gap-2">
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
                onClick={onAddClip}
                className="rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-primary-hover"
              >
                {t("addClip")}
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
