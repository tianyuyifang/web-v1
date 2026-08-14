"use client";

import { useState, useEffect, useRef } from "react";
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

  const overflowItems = [
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

  // Every action the header offers, as one flat list. Both layouts render from
  // it, so neither can quietly gain or lose a button relative to the other;
  // they differ only in label length and cell size. `short` is what the phone
  // shows, where a cell is about 50px wide.
  const NEUTRAL = "border border-border bg-surface hover:bg-surface-hover";
  const actionDefs = [
    { id: "return", label: t("return"), onClick: onReturn,
      className: NEUTRAL, style: { color: "var(--text)" } },
    playlist.isOwner && {
      id: "unlikeAll", label: t("unlikeAll"), short: t("unlikeAllShort"),
      phone: t("unlikeAllPhone"),
      onClick: onUnlikeAll,
      className: "border border-red-500/30 text-red-400 hover:bg-red-500/10" },
    playlist.isOwner && {
      id: "share", label: t("share"), onClick: () => onShare?.(),
      className: NEUTRAL, style: { color: "var(--text)" } },
    playlist.isOwner && {
      id: "public",
      label: playlist.isPublic ? t("setPlaylistPrivate") : t("setPlaylistPublic"),
      short: playlist.isPublic ? t("setPrivateShort") : t("setPublicShort"),
      onClick: () => onTogglePublic?.(),
      className: NEUTRAL, style: { color: "var(--text)" } },
    playlist.isOwner && {
      id: "edit", label: editMode ? t("done") : t("edit"), onClick: onToggleEditMode,
      className: editMode ? "bg-accent text-black shadow-sm" : NEUTRAL,
      style: editMode ? undefined : { color: "var(--text)" } },
    // …what used to sit behind the overflow menu…
    ...overflowItems
      .filter((i) => !i.hidden)
      .map((i) => ({
        id: i.id,
        label: i.label,
        short: i.id === "copy" ? t("copyShort") : undefined,
        onClick: i.onClick,
        className: i.active ? "bg-primary text-white shadow-sm" : NEUTRAL,
        style: i.active ? undefined : { color: "var(--text)" },
      })),
    // …and the edit toolbar.
    ...(editMode && playlist.isOwner
      ? [
          { id: "batch", label: t("batch"), onClick: onToggleBatch,
            className: batchMode ? "bg-purple-600 text-white shadow-sm" : NEUTRAL,
            style: batchMode ? undefined : { color: "var(--text)" } },
          { id: "addClip", label: t("addClip"), short: t("addClipShort"),
            onClick: onAddClip,
            className: "bg-primary text-white shadow-sm hover:bg-primary-hover" },
          { id: "delete", label: t("delete"), phone: t("deletePlaylistPhone"),
            onClick: onDelete,
            className: "border border-red-500/30 text-red-400 hover:bg-red-500/10" },
        ]
      : []),
  ].filter(Boolean);

  const actions = actionDefs;

  // Phones order the actions by how often they are reached rather than by the
  // desktop grouping, and put the rarely-used ones back behind a menu so the
  // rest fit without shrinking. Ids not listed here stay in the menu.
  const PHONE_ORDER = editMode
    ? ["unlikeAll", "addClip", "batch", "compact", "delete", "return", "edit"]
    : playlist.isOwner
      ? ["unlikeAll", "edit", "copy", "return"]
      : ["copy", "compare", "return"];

  const byId = Object.fromEntries(actionDefs.map((a) => [a.id, a]));
  const phoneActions = PHONE_ORDER
    .map((id) => byId[id])
    .filter(Boolean)
    // The phone wording wins where given, then the full label — the desktop
    // short forms are for narrow desktop cells, not for here.
    .map((a) => ({ ...a, label: a.phone || a.label }));

  // Whatever the phone did not surface as a button.
  const phoneMenuItems = actionDefs
    .filter((a) => !PHONE_ORDER.includes(a.id))
    .map((a) => ({ id: a.id, label: a.label, onClick: a.onClick }));

  // Cells across, counting the menu trigger as one. Up to five stay on a single
  // row; beyond that they split evenly over two.
  const phoneCellCount = phoneActions.length + (phoneMenuItems.length > 0 ? 1 : 0);
  const phoneCols = phoneCellCount <= 5 ? phoneCellCount : Math.ceil(phoneCellCount / 2);

  const [phoneMenuOpen, setPhoneMenuOpen] = useState(false);
  useEffect(() => {
    if (!phoneMenuOpen) return;
    const close = (e) => {
      if (!e.target.closest?.("[aria-haspopup='menu']") && !e.target.closest?.(".z-40")) {
        setPhoneMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [phoneMenuOpen]);

  // Full labels need roughly 95px of cell. Whether they fit depends on both the
  // header's width and how many buttons are sharing it — edit mode adds three,
  // which alone is enough to squeeze a 1280px header past the limit — so the
  // grid is measured rather than guessed at from a breakpoint.
  const gridRef = useRef(null);
  const [roomyCells, setRoomyCells] = useState(true);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const cols = Math.ceil(actions.length / 2);
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setRoomyCells(w / cols >= 95);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [actions.length]);

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

        {/* Phones get their own action block: their own ordering, and the
            seldom-used actions kept behind a menu so the rest stay legible.
            Four or fewer sit on one row; more wrap onto a second. */}
        <div className="sm:hidden">
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(${phoneCols}, minmax(0, 1fr))` }}
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
            {phoneMenuItems.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setPhoneMenuOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={phoneMenuOpen}
                  className={`w-full rounded-lg px-1 py-1.5 text-[11px] font-medium transition-colors ${
                    phoneMenuOpen ? "bg-primary text-white shadow-sm" : NEUTRAL
                  }`}
                  style={phoneMenuOpen ? undefined : { color: "var(--text)" }}
                >
                  ⋯
                </button>
                {phoneMenuOpen && (
                  <div className="absolute right-0 z-40 mt-1 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
                    {phoneMenuItems.map((i) => (
                      <button
                        key={i.id}
                        onClick={() => { setPhoneMenuOpen(false); i.onClick?.(); }}
                        className="block w-full whitespace-nowrap px-3 py-2 text-left text-xs text-theme hover:bg-surface-hover"
                      >
                        {i.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Desktop: the same flat list, in two rows of equal-width cells. The
            overflow menu is gone here too — every action is its own button, so
            nothing takes two clicks to reach. Full labels need about 95px of
            cell, which the header only affords from xl up; below that the
            short forms are used instead, and the full wording stays available
            as the title. */}
        <div
          ref={gridRef}
          className="hidden gap-1.5 sm:grid"
          style={{ gridTemplateColumns: `repeat(${Math.ceil(actions.length / 2)}, minmax(0, 1fr))` }}
        >
          {actions.map((a) => (
            <button
              key={a.id}
              onClick={a.onClick}
              title={a.label}
              className={`truncate rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${a.className}`}
              style={a.style}
            >
              {a.short && !roomyCells ? a.short : a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
