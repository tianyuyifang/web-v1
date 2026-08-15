"use client";

import { useState, useEffect, useRef } from "react";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";

const COLUMN_OPTIONS = [1, 2, 3, 4, 5];

// Roughly how wide a label renders, in units of one Latin character. CJK,
// fullwidth forms and CJK punctuation occupy about two of those, so counting
// raw string length would make 返回 and 批量 look the same width as two
// letters. Used to share a phone row out in proportion to the wording.
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
function labelWidth(label) {
  let w = 0;
  for (const ch of String(label)) w += WIDE_CHAR.test(ch) ? 2 : 1;
  return w;
}

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
  onToggleBatch,
  onTogglePublic,
  onAddClip,
  onShare,
  onDelete,
  onCompare,
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

  // Every action the header offers, as one flat list. Both layouts render from
  // it, so neither can quietly gain or lose a button relative to the other;
  // they differ only in wording and cell size. `phone` overrides the label on
  // phones, where the row is tight; desktop always shows the full `label`.
  const NEUTRAL = "border border-border bg-surface hover:bg-surface-hover";
  const actionDefs = [
    { id: "return", label: t("return"), onClick: onReturn,
      className: NEUTRAL, style: { color: "var(--text)" } },
    playlist.isOwner && {
      id: "unlikeAll", label: t("unlikeAll"),
      phone: t("unlikeAllPhone"),
      onClick: onUnlikeAll,
      className: "border border-red-500/30 text-red-400 hover:bg-red-500/10" },
    playlist.isOwner && {
      id: "share", label: t("share"), onClick: () => onShare?.(),
      className: NEUTRAL, style: { color: "var(--text)" } },
    playlist.isOwner && {
      id: "public",
      label: playlist.isPublic ? t("setPlaylistPrivate") : t("setPlaylistPublic"),
      onClick: () => onTogglePublic?.(),
      className: NEUTRAL, style: { color: "var(--text)" } },
    playlist.isOwner && {
      // 编辑 carries the same filled treatment as 添加片段 — it is the way into
      // the mode, so it should read as the primary action rather than as one
      // more neutral button. 完成, its edit-mode face, keeps the accent that
      // marks the mode as active.
      id: "edit", label: editMode ? t("done") : t("edit"), onClick: onToggleEditMode,
      className: editMode
        ? "bg-accent text-black shadow-sm"
        : "bg-primary text-white shadow-sm hover:bg-primary-hover" },
    !editMode && {
      id: "compare", label: t("comparePlaylist"), onClick: () => onCompare?.(),
      className: NEUTRAL, style: { color: "var(--text)" } },
    (playlist.isOwner || playlist.canCopy) && {
      id: "copy", label: t("copyShort"), onClick: () => onCopy?.(),
      className: NEUTRAL, style: { color: "var(--text)" } },
    // …and the edit toolbar.
    ...(editMode && playlist.isOwner
      ? [
          { id: "batch", label: t("batch"), onClick: onToggleBatch,
            className: batchMode ? "bg-purple-600 text-white shadow-sm" : NEUTRAL,
            style: batchMode ? undefined : { color: "var(--text)" } },
          { id: "addClip", label: t("addClip"),
            onClick: onAddClip,
            className: "bg-primary text-white shadow-sm hover:bg-primary-hover" },
          { id: "delete", label: t("delete"),
            onClick: onDelete,
            className: "border border-red-500/30 text-red-400 hover:bg-red-500/10" },
        ]
      : []),
  ].filter(Boolean);

  // Phones lead with 返回 — the way back out is the one action that should sit
  // in the same place every time — then order the rest by how often they are
  // reached. Ids not listed here stay in the menu. In edit mode there is no
  // menu: everything it would hold is a button in normal mode, one 完成 away.
  const PHONE_ORDER = editMode
    ? ["return", "unlikeAll", "addClip", "batch", "delete", "edit"]
    : playlist.isOwner
      ? ["return", "unlikeAll", "edit", "copy"]
      : ["return", "copy", "compare"];

  const byId = Object.fromEntries(actionDefs.map((a) => [a.id, a]));
  const phoneActions = PHONE_ORDER
    .map((id) => byId[id])
    .filter(Boolean)
    // The phone wording wins where given, otherwise the full label.
    .map((a) => {
      const label = a.phone || a.label;
      return { ...a, label, weight: labelWidth(label) };
    });

  // Whatever the phone did not surface as a button — normal mode only.
  const phoneMenuItems = editMode
    ? []
    : actionDefs
        .filter((a) => !PHONE_ORDER.includes(a.id))
        .map((a) => ({ id: a.id, label: a.label, onClick: a.onClick }));

  // Desktop keeps the frequently-reached actions as buttons, in this order,
  // and files the rest behind ⋯. Edit mode shows only what editing needs:
  // 分享, 设为公开歌单 and 复制 all sit one 完成 away in normal mode, so
  // repeating them here just crowds the row. Ids absent from both lists — the
  // edit-only actions in normal mode, and vice versa — simply do not render.
  const DESKTOP_ORDER = editMode
    ? ["return", "unlikeAll", "batch", "addClip", "edit", "delete"]
    : ["return", "unlikeAll", "share", "edit", "copy"];
  const DESKTOP_MENU = editMode ? [] : ["public", "compare"];

  const desktopActions = DESKTOP_ORDER
    .map((id) => byId[id])
    .filter(Boolean);
  const desktopMenuItems = DESKTOP_MENU
    .map((id) => byId[id])
    .filter(Boolean)
    .map((a) => ({ id: a.id, label: a.label, onClick: a.onClick }));

  // Buttons are as wide as their wording, so a row holds as much text as it
  // holds — not a fixed number of cells. Rows are packed against the block's
  // measured width rather than a constant: a budget tuned for a 390px phone
  // overshoots a 360px one by exactly the width that pushed 返回 off the left
  // edge once the rows were right-aligned.
  const phoneRef = useRef(null);
  const [phoneWidth, setPhoneWidth] = useState(0);
  useEffect(() => {
    const el = phoneRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setPhoneWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A glyph unit is ~5.5px at text-[11px]; each button also costs 20px of
  // padding and 6px of gap. Before the first measurement lands, assume a roomy
  // row so the buttons render unwrapped rather than one-per-line.
  const GLYPH_PX = 5.5;
  const BUTTON_PX = 26;
  // The ⋯ trigger rides along at the end of the last row, so the row it lands
  // on has that much less to give.
  const MENU_PX = phoneMenuItems.length > 0 ? 36 : 0;
  const phoneRows = [];
  for (const [i, a] of phoneActions.entries()) {
    const isLastAction = i === phoneActions.length - 1;
    const cost = a.weight * GLYPH_PX + BUTTON_PX + (isLastAction ? MENU_PX : 0);
    const row = phoneRows[phoneRows.length - 1];
    const used = row?.reduce((n, x) => n + x.weight * GLYPH_PX + BUTTON_PX, 0) ?? 0;
    if (row && (!phoneWidth || used + cost <= phoneWidth)) row.push(a);
    else phoneRows.push([a]);
  }

  const [phoneMenuOpen, setPhoneMenuOpen] = useState(false);
  const [desktopMenuOpen, setDesktopMenuOpen] = useState(false);
  // Both ⋯ menus dismiss on a click that lands outside a trigger or a panel.
  useEffect(() => {
    if (!phoneMenuOpen && !desktopMenuOpen) return;
    const close = (e) => {
      if (!e.target.closest?.("[aria-haspopup='menu']") && !e.target.closest?.(".z-40")) {
        setPhoneMenuOpen(false);
        setDesktopMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [phoneMenuOpen, desktopMenuOpen]);

  return (
    <div className="mb-4 space-y-1.5">
      {/* Three tracks on desktop: title | selector | actions. The outer two are
          minmax(max-content,1fr), so they stay equal where there is room and
          the middle track lands on the header's true centre — but never at the
          cost of wrapping the actions, which is what an unqualified 1fr did:
          an equal third is about 400px at 1280px, and the single row of
          buttons needs ~420px, so the ⋯ alone dropped to a second line. A flex
          row could not do this at all — centring the selector there meant
          taking it out of the flow, which let the description run underneath
          it. Below lg the tracks size to content and the selector sits
          off-centre rather than squeezing the title. Phones stack, as before.

          The tracks centre against each other vertically: the title block is
          the tall one once a description is present, and top-aligning the
          actions against it left them visibly riding high. */}
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(11rem,1fr)_auto_auto] sm:items-center sm:gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)]">
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

        {/* Phones get their own action block: 返回 first, then the rest by how
            often they are reached, each button sized to its wording. Rows pack
            up to a legible width, wrap, and sit flush right like the desktop
            row. In normal mode the seldom-used actions stay behind a menu at
            the end of the last row. */}
        <div ref={phoneRef} className="sm:hidden space-y-1.5">
          {phoneRows.map((row, rowIndex) => {
            const isLast = rowIndex === phoneRows.length - 1;
            return (
              <div key={rowIndex} className="flex justify-end gap-1.5">
                {row.map((a) => (
                  <button
                    key={a.id}
                    onClick={a.onClick}
                    // Sized to the wording itself: no growing to fill the row,
                    // so each button is its text plus padding and nothing more.
                    style={a.style}
                    className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors ${a.className}`}
                  >
                    {a.label}
                  </button>
                ))}
                {isLast && phoneMenuItems.length > 0 && (
                  <div className="relative shrink-0">
                    <button
                      onClick={() => setPhoneMenuOpen((v) => !v)}
                      aria-haspopup="menu"
                      aria-expanded={phoneMenuOpen}
                      className={`h-full rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors ${
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
            );
          })}
        </div>

        {/* Desktop: buttons sized to their wording, wrapping as needed and
            kept flush right whether they land on one row or two. Equal-width
            cells were what forced the old abbreviations — a cell narrower than
            its label had to shorten it — so sizing to content lets every width
            show the same full wording. The seldom-used actions sit behind ⋯. */}
        <div className="hidden flex-wrap items-start justify-end gap-1.5 sm:flex">
          {desktopActions.map((a) => (
            <button
              key={a.id}
              onClick={a.onClick}
              className={`shrink-0 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${a.className}`}
              style={a.style}
            >
              {a.label}
            </button>
          ))}
          {desktopMenuItems.length > 0 && (
            <div className="relative shrink-0">
              <button
                onClick={() => setDesktopMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={desktopMenuOpen}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  desktopMenuOpen ? "bg-primary text-white shadow-sm" : NEUTRAL
                }`}
                style={desktopMenuOpen ? undefined : { color: "var(--text)" }}
              >
                ⋯
              </button>
              {desktopMenuOpen && (
                <div className="absolute right-0 z-40 mt-1 min-w-[9rem] overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
                  {desktopMenuItems.map((i) => (
                    <button
                      key={i.id}
                      onClick={() => { setDesktopMenuOpen(false); i.onClick?.(); }}
                      className="block w-full whitespace-nowrap px-3 py-2 text-left text-sm text-theme hover:bg-surface-hover"
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
    </div>
  );
}
