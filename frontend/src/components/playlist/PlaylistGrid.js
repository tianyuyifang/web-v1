"use client";

import { useState, useMemo, useCallback, useEffect, useRef, Fragment } from "react";
import { createPortal } from "react-dom";

import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { playlistsAPI } from "@/lib/api";
import { clipMatchesFilters } from "@/lib/utils";
import PlayerBox from "@/components/player/PlayerBox";
import SpeedControl from "@/components/player/SpeedControl";
import PitchControl from "@/components/player/PitchControl";
import ColorTag from "@/components/player/ColorTag";
import LikeButton from "@/components/player/LikeButton";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { useLanguage } from "@/components/layout/LanguageProvider";
import usePlayerStore from "@/store/playerStore";

/**
 * How long a finger must rest on the handle before a drag begins, and how far
 * it may stray in that time.
 *
 * Not a platform standard — iOS reserves ~500ms for its long-press menu and
 * Android 400-500ms, but those confirm an ambiguous gesture. Here the handle
 * has already declared the intent, so waiting that long only feels slow.
 * dnd-kit's own examples use 200ms; 250 sits just above that because a
 * too-eager drag steals the scroll, which is the more common gesture on a
 * list this long.
 *
 * The tolerance does most of the work: move more than this while waiting and
 * it is a scroll, not a drag. That separates the two by what the finger does
 * rather than by how patient the user is.
 */
const DRAG_DELAY_MS = 250;
const DRAG_TOLERANCE_PX = 8;

/**
 * A sensor that never activates and sets nothing up.
 *
 * dnd-kit's TouchSensor, merely by being passed to a mounted DndContext, adds
 * a non-passive `touchmove` listener on window (so preventDefault works on
 * iOS). A non-passive touchmove listener makes every touch scroll wait on the
 * main thread. The DndContext now stays mounted in view mode, where nothing
 * can be dragged, so view mode swaps TouchSensor for this.
 */
class InertSensor {
  static activators = [];
}

/**
 * One draggable clip on a phone.
 *
 * The handle is a separate grip rather than the whole row: a card carries a
 * play button and a heart, and a drag that starts anywhere would fire them by
 * accident. Listeners go on the grip alone, so the rest of the row keeps
 * behaving exactly as it did.
 *
 * `disabled` covers the filtered case. Positions are computed against the full
 * list, so while a search or colour filter is on, the row above a clip on
 * screen is not the row above it in the playlist, and a drop would land
 * somewhere the user did not point at.
 *
 * Every card sits in one of these in view mode too, with no handle
 * (`showHandle` off). A card whose parent changes is a new card to React —
 * torn down and rebuilt, playback and all — so the wrapper stays put and only
 * the handle comes and goes with edit mode.
 */
function SortableClip({ id, disabled, showHandle, className = "", children }) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef,
    transform, transition, isDragging,
  } = useSortable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // pl-7 on phones only, matching the handle's width: the handle is
      // absolutely positioned and so invisible to the row's own layout, and
      // without the indent it sat exactly on top of the position number —
      // which is the number the position box is typed against, so covering it
      // made the other way of moving a clip harder to use.
      className={`relative ${showHandle ? "pl-7 sm:pl-0" : ""} ${isDragging ? "z-10 opacity-40" : ""} ${className}`}
    >
      {/* Hidden on sm+: dragging is a phone affordance, and the desktop keeps
          the numeric position box, which beats dragging across a playlist
          whose median length is 152. */}
      {showHandle && (
        <button
          ref={setActivatorNodeRef}
          type="button"
          disabled={disabled}
          aria-label="拖动排序"
          title={disabled ? "清除筛选后可拖动排序" : "按住拖动"}
          className={`absolute left-0 top-0 z-20 flex h-9 w-7 touch-none items-center justify-center text-sm leading-none sm:hidden ${
            disabled ? "cursor-not-allowed text-muted/30" : "cursor-grab text-muted active:cursor-grabbing"
          }`}
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
      )}
      {children}
    </div>
  );
}

/**
 * Heading above a section. Declared at module level: defined inside the grid
 * it was a new component type on every render, so React rebuilt every heading
 * each time the grid rendered.
 *
 * The edit input is uncontrolled, so it is keyed by its label — a label that
 * changes underneath it (rename, clear) must replace what the box shows.
 */
function SectionDivider({ label, clipId, editMode, onClipUpdated }) {
  return (
    <div
      id={`section-${clipId}`}
      className="flex items-center gap-3 py-2"
      style={{ scrollMarginTop: "12rem" }}
    >
      <div className="h-px flex-1 bg-border" />
      {editMode ? (
        <input
          key={label}
          type="text"
          defaultValue={label}
          onBlur={(e) => {
            const val = e.target.value.trim();
            if (val !== label) onClipUpdated(clipId, { sectionLabel: val || null });
          }}
          className="rounded border border-border bg-background px-2 py-0.5 text-center text-sm font-semibold text-theme focus:border-primary focus:outline-none"
        />
      ) : (
        <span className="shrink-0 text-sm font-semibold text-theme">{label}</span>
      )}
      <div className="h-px flex-1 bg-border" />
      {editMode && (
        <button
          onClick={() => onClipUpdated(clipId, { sectionLabel: null })}
          className="shrink-0 text-xs text-muted hover:text-red-400"
        >
          ✕
        </button>
      )}
    </div>
  );
}

export default function PlaylistGrid({
  playlist,
  columns,
  editMode,
  batchMode,
  selectedClips,
  onSelectedChange,
  onBatchDone,
  searchQuery,
  colorFilter,
  highlightedClipId,
  onClipRemoved,
  onClipUpdated,
  onClipSwapped,
  onReorder,
  newlyAddedClipId,
}) {
  const { t } = useLanguage();
  const [sectionPromptClipId, setSectionPromptClipId] = useState(null);
  const [expandedClipIds, setExpandedClipIds] = useState(new Set());

  // The clips array behind a stable getter. Editing any clip rebuilds the
  // array, and handing the new reference to every PlayerBox defeated their
  // memo() all at once — one colour change re-rendered the whole grid. The
  // two readers (neighbourhood preload, reorder-by-position) only consult the
  // list inside an event or effect, where the ref is already current.
  const clipsRef = useRef(playlist.clips);
  clipsRef.current = playlist.clips;
  const getAllClips = useCallback(() => clipsRef.current, []);

  // Derive playing clipId from the active player (format: "playlistId-clipId")
  const activePlayerId = usePlayerStore((s) => s.activePlayerId);
  const playingClipId = useMemo(() => {
    if (!activePlayerId) return null;
    const prefix = `${playlist.id}-`;
    return activePlayerId.startsWith(prefix) ? activePlayerId.slice(prefix.length) : null;
  }, [activePlayerId, playlist.id]);

  const handleToggleExpand = useCallback((clipId) => {
    setExpandedClipIds((prev) => {
      const next = new Set(prev);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return next;
    });
  }, []);

  // Swapping a clip replaces its clipId with a new server-assigned one. Since
  // expanded/collapsed state is keyed by clipId, carry it across so a card that
  // was open stays open after the swap (instead of collapsing automatically).
  const handleSwapCarryingExpand = useCallback(async (oldClipId, newClipId) => {
    const resultClipId = await onClipSwapped(oldClipId, newClipId);
    if (!resultClipId || resultClipId === oldClipId) return;
    setExpandedClipIds((prev) => {
      if (!prev.has(oldClipId)) return prev; // was collapsed — keep it collapsed
      const next = new Set(prev);
      next.delete(oldClipId);
      next.add(resultClipId);
      return next;
    });
  }, [onClipSwapped]);

  // Auto-expand when a clip starts playing
  useEffect(() => {
    if (playingClipId) setExpandedClipIds((prev) => {
      if (prev.has(playingClipId)) return prev;
      return new Set(prev).add(playingClipId);
    });
  }, [playingClipId]);

  // Auto-expand a freshly-added clip so its card opens (not collapsed).
  useEffect(() => {
    if (!newlyAddedClipId) return;
    setExpandedClipIds((prev) => {
      if (prev.has(newlyAddedClipId)) return prev;
      return new Set(prev).add(newlyAddedClipId);
    });
  }, [newlyAddedClipId]);

  const filteredClips = useMemo(() => {
    if (!searchQuery && !colorFilter) return playlist.clips;
    return playlist.clips.filter((pc) => clipMatchesFilters(pc, searchQuery, colorFilter));
  }, [playlist.clips, searchQuery, colorFilter]);

  const [removeConfirmClipId, setRemoveConfirmClipId] = useState(null);

  const handleRemove = useCallback(async (clipId) => {
    try {
      await playlistsAPI.removeClip(playlist.id, { clipId });
      onClipRemoved(clipId);
    } catch {
      // silent
    }
    setRemoveConfirmClipId(null);
  }, [playlist.id, onClipRemoved]);

  const handleMove = useCallback(async (clipId, fromIndex, toIndex) => {
    const clips = [...clipsRef.current];
    const clampedTo = Math.max(0, Math.min(clips.length - 1, toIndex));
    if (fromIndex === clampedTo) return;

    const [moved] = clips.splice(fromIndex, 1);
    clips.splice(clampedTo, 0, moved);

    // Only clips whose position changed get a new object; the rest keep theirs,
    // so their memoized cards skip re-rendering (moving #20 to #19 used to
    // re-render all 243).
    const reordered = clips.map((c, i) => (c.position === i ? c : { ...c, position: i }));
    onReorder(reordered);

    try {
      await playlistsAPI.reorderClips(playlist.id, { clipIds: reordered.map((c) => c.clipId) });
    } catch {
      // silent
    }
    // playlist.id, not playlist: the object is rebuilt on every clip edit, and
    // a new onMove per render re-rendered every card in edit mode.
  }, [playlist.id, onReorder]);

  // Dragging is disabled while a filter narrows the list: handleMove works in
  // full-list indices, so a drop between two visible rows would move the clip
  // to a position the user never saw.
  const dragDisabled = Boolean(searchQuery || colorFilter);

  // Mouse/pen: only relevant because the same tree renders on desktop. The
  // handle is hidden there, so this effectively never activates.
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 8 } });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: { delay: DRAG_DELAY_MS, tolerance: DRAG_TOLERANCE_PX },
  });
  const inertSensor = useSensor(InertSensor);
  // Outside edit mode nothing can be dragged, and TouchSensor would still add
  // its non-passive window touchmove listener (see InertSensor), so view mode
  // gets the inert one. Same length either way: dnd-kit keys its setup effect
  // on the sensor list, and React compares a changed-length list only up to
  // the shorter length — a shorter list would never tear the listener down.
  const editSensors = useSensors(pointerSensor, touchSensor);
  const viewSensors = useSensors(pointerSensor, inertSensor);

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // Indices come from the playlist, not from what is on screen — the same
    // basis handleMove uses, so dropping and typing a number agree.
    const from = playlist.clips.findIndex((c) => c.clipId === active.id);
    const to = playlist.clips.findIndex((c) => c.clipId === over.id);
    if (from === -1 || to === -1) return;

    // Reuses the existing move: the section label stays attached to its clip,
    // exactly as it does when the position box is used. Two ways to move that
    // disagreed about sections would be worse than either rule alone.
    handleMove(active.id, from, to);
  }, [playlist.clips, handleMove]);

  const gridClass = "grid gap-4 grid-cols-1 sm:grid-cols-[repeat(var(--cols),minmax(0,1fr))]";
  const gridStyle = { "--cols": columns };

  // Batch mode state — only fields in batchDirty are applied
  const [batchSpeed, setBatchSpeed] = useState(1.0);
  const [batchPitch, setBatchPitch] = useState(0);
  const [batchColorTag, setBatchColorTag] = useState(undefined);
  const [batchComment, setBatchComment] = useState("");
  const [batchDirty, setBatchDirty] = useState(new Set());

  // Reset batch state when entering/leaving batch mode
  useEffect(() => {
    setBatchSpeed(1.0);
    setBatchPitch(0);
    setBatchColorTag(undefined);
    setBatchComment("");
    setBatchDirty(new Set());
  }, [batchMode]);

  const lastClickedRef = useRef(null);

  const toggleSelect = useCallback((clipId, e) => {
    const next = new Set(selectedClips);

    // Shift+click: select range between last clicked and current
    if (e?.shiftKey && lastClickedRef.current && lastClickedRef.current !== clipId) {
      const ids = filteredClips.map((c) => c.clipId);
      const lastIdx = ids.indexOf(lastClickedRef.current);
      const curIdx = ids.indexOf(clipId);
      if (lastIdx !== -1 && curIdx !== -1) {
        const [from, to] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
        for (let i = from; i <= to; i++) next.add(ids[i]);
        onSelectedChange(next);
        return;
      }
    }

    if (next.has(clipId)) next.delete(clipId);
    else next.add(clipId);
    lastClickedRef.current = clipId;
    onSelectedChange(next);
  }, [selectedClips, onSelectedChange, filteredClips]);

  const [showBatchConfirm, setShowBatchConfirm] = useState(false);

  const batchSummary = useMemo(() => {
    const parts = [];
    if (batchDirty.has("speed")) parts.push(`${t("speed")}: ${batchSpeed}x`);
    if (batchDirty.has("pitch")) parts.push(`${t("pitch")}: ${batchPitch > 0 ? "+" : ""}${batchPitch}`);
    if (batchDirty.has("colorTag")) parts.push(`${t("clear")}: ${batchColorTag || "—"}`);
    if (batchDirty.has("comment")) parts.push(`${t("addComment")}: ${batchComment || "—"}`);
    return parts.join("\n");
  }, [batchDirty, batchSpeed, batchPitch, batchColorTag, batchComment, t]);

  const applyBatch = useCallback(() => {
    if (!selectedClips?.size || !batchDirty.size) return;
    for (const clipId of selectedClips) {
      const updates = {};
      if (batchDirty.has("speed")) updates.speed = batchSpeed;
      if (batchDirty.has("pitch")) updates.pitch = batchPitch;
      if (batchDirty.has("colorTag")) updates.colorTag = batchColorTag;
      if (batchDirty.has("comment")) updates.comment = batchComment;
      if (Object.keys(updates).length > 0) onClipUpdated(clipId, updates);
    }
    setShowBatchConfirm(false);
    onBatchDone?.();
  }, [selectedClips, batchDirty, batchSpeed, batchPitch, batchColorTag, batchComment, onClipUpdated, onBatchDone]);

  // Shuffling only permutes the selected clips among the positions they
  // already occupy, so an unselected clip never moves. Returns the reordered
  // list plus which section labels changed hands, or null if there is nothing
  // to do.
  //
  // Section labels stay with the POSITION, not the clip. A label marks "a
  // section starts here", so carrying it along with a shuffled clip would drag
  // the section heading to a random place in the list.
  const planShuffle = useCallback(() => {
    const selected = selectedClips;
    if (!selected || selected.size < 2) return null;

    const clips = playlist.clips;
    const slots = [];
    for (let i = 0; i < clips.length; i++) {
      if (selected.has(clips[i].clipId)) slots.push(i);
    }
    if (slots.length < 2) return null;

    // Fisher-Yates over the selected clips.
    const picked = slots.map((i) => clips[i]);
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [picked[i], picked[j]] = [picked[j], picked[i]];
    }

    const next = [...clips];
    const labelMoves = [];
    slots.forEach((slotIndex, n) => {
      const landing = picked[n];
      const slotLabel = clips[slotIndex].sectionLabel ?? null;
      // Restate every touched slot's label rather than only the ones that
      // changed. A diff is only as good as the local copy it is diffed
      // against, and that copy can lag the server — one stale row and a
      // clearing update goes unsent, leaving the same heading in two places.
      // Sending the full picture makes the result depend on the shuffle
      // alone, not on how fresh the client happens to be.
      labelMoves.push({ clipId: landing.clipId, sectionLabel: slotLabel });
      next[slotIndex] = { ...landing, sectionLabel: slotLabel };
    });

    return { next, labelMoves };
  }, [selectedClips, playlist.clips]);

  // How many selected clips would end up under a different section heading —
  // the warning the confirm dialog shows before anything is written.
  const shuffleCrossings = useMemo(() => {
    const selected = selectedClips;
    if (!selected || selected.size < 2) return 0;
    // Which section does each position sit in? Labels mark section starts.
    let label = null;
    const sectionAt = new Map();
    for (const pc of playlist.clips) {
      if (pc.sectionLabel) label = pc.sectionLabel;
      sectionAt.set(pc.clipId, label);
    }
    const sections = new Set(
      [...selected].map((id) => sectionAt.get(id)).filter((s) => s !== undefined)
    );
    if (sections.size < 2) return 0;
    return selected.size;
  }, [selectedClips, playlist.clips]);

  const [showShuffleConfirm, setShowShuffleConfirm] = useState(false);

  const applyShuffle = useCallback(async () => {
    const plan = planShuffle();
    setShowShuffleConfirm(false);
    if (!plan) return;

    // plan.next already carries each slot's own label, so the local list is
    // correct the moment it lands — no waiting on the round trip.
    const reordered = plan.next.map((c, i) => ({ ...c, position: i }));
    onReorder(reordered);

    try {
      await playlistsAPI.reorderClips(playlist.id, {
        clipIds: reordered.map((c) => c.clipId),
      });
      // Section headings stay put: restate the label of every touched slot,
      // in ONE request. One call per label raced — each write carried its own
      // copy of the row set, so a later response could resurrect a heading an
      // earlier one had just cleared.
      if (plan.labelMoves.length > 0) {
        await playlistsAPI.batchUpdateClips(playlist.id, plan.labelMoves);
      }
    } catch {
      // silent
    }
    // Deliberately no onBatchDone(): applying and removing are terminal, but
    // a shuffle rarely is — you look at the result and often want another go.
    // Staying in batch mode keeps the selection, so the next shuffle, or an
    // 应用并保存 on top of it, is one click away.
  }, [planShuffle, playlist.id, onReorder]);

  const [showBatchRemoveConfirm, setShowBatchRemoveConfirm] = useState(false);

  const batchRemove = useCallback(async () => {
    if (!selectedClips?.size) return;
    try {
      await playlistsAPI.batchRemoveClips(playlist.id, [...selectedClips]);
      for (const clipId of selectedClips) onClipRemoved(clipId);
    } catch {
      // silent
    }
    setShowBatchRemoveConfirm(false);
    onBatchDone?.();
  }, [selectedClips, playlist.id, onClipRemoved, onBatchDone]);

  // Group clips into sections.
  //
  // The boundaries come from the full list, not the filtered one. A section is
  // marked on a clip, so deriving the groups from what survives a filter loses
  // the label whenever that particular clip is filtered out — and most marker
  // clips carry no colour of their own, so nearly every colour filter used to
  // dissolve the sections and leave one unlabelled heap. Filtering the contents
  // of each group instead keeps the headings put; the clips shown are exactly
  // the same either way.
  const visibleClipIds = useMemo(
    () => new Set(filteredClips.map((pc) => pc.clipId)),
    [filteredClips]
  );

  const sectionGroups = useMemo(() => {
    const groups = [];
    let current = { label: null, clipId: null, clips: [] };
    for (const pc of playlist.clips) {
      if (pc.sectionLabel) {
        if (current.clips.length > 0 || current.label) groups.push(current);
        current = { label: pc.sectionLabel, clipId: pc.clipId, clips: [] };
      }
      if (visibleClipIds.has(pc.clipId)) current.clips.push(pc);
    }
    if (current.clips.length > 0 || current.label) groups.push(current);
    // A section whose every clip was filtered out would render as a bare
    // heading over nothing, so drop it.
    return groups.filter((g) => g.clips.length > 0);
  }, [playlist.clips, visibleClipIds]);

  const colCount = columns || 3;

  // Above the early returns below, not beside the JSX that uses it: this is a
  // hook, and a hook skipped on some renders and not others changes the hook
  // count between renders, which React rejects outright. Sitting down there it
  // crashed the whole page whenever a filter matched nothing or batch mode
  // opened — both of which return before reaching it.
  // One SortableContext over every clip in the playlist, not one per section:
  // the sections are a visual grouping, and a drag has to be able to cross them
  // — which is what makes a clip change section at all.
  //
  // Keyed by the id list itself, not the clips array: every colour, speed or
  // comment edit rebuilds that array, and a new `items` re-rendered every
  // sortable card although the order had not changed.
  const sortableIdsKey = playlist.clips.map((c) => c.clipId).join(",");
  const sortableIds = useMemo(() => (sortableIdsKey ? sortableIdsKey.split(",") : []), [sortableIdsKey]);

  if (filteredClips.length === 0) {
    return <p className="py-12 text-center text-sm text-muted">{t("noClipsFound")}</p>;
  }

  // Batch controls portal — rendered into sticky header
  const batchControlsPortal = editMode && batchMode && typeof document !== "undefined" && document.getElementById("batch-controls-portal")
    ? createPortal(
        <div className="mt-3 rounded-xl border border-border bg-surface p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <button
              onClick={() => onSelectedChange(new Set(filteredClips.map((c) => c.clipId)))}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-theme hover:bg-surface-hover"
            >
              {t("selectAll")}
            </button>
            <button
              onClick={() => onSelectedChange(new Set())}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-theme hover:bg-surface-hover"
            >
              {t("unselectAll")}
            </button>
            <span className="text-xs text-muted">
              {t("selectedCount").replace("{count}", selectedClips?.size || 0)}
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="mb-1 block text-xs text-muted">{t("speed")}</label>
              <SpeedControl speed={batchSpeed} onChange={(v) => { setBatchSpeed(v); setBatchDirty(d => new Set(d).add("speed")); }} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">{t("pitch")}</label>
              <PitchControl pitch={batchPitch} onChange={(v) => { setBatchPitch(v); setBatchDirty(d => new Set(d).add("pitch")); }} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">{t("addComment")}</label>
              <input
                type="text"
                value={batchComment}
                onChange={(e) => { setBatchComment(e.target.value); setBatchDirty(d => new Set(d).add("comment")); }}
                className="w-40 rounded-lg border border-border bg-background px-2 py-1 text-xs text-theme focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">{t("clear")}</label>
              <ColorTag color={batchColorTag} editable onChange={(v) => { setBatchColorTag(v); setBatchDirty(d => new Set(d).add("colorTag")); }} />
            </div>
            <button
              onClick={() => setShowBatchConfirm(true)}
              disabled={!selectedClips?.size || !batchDirty.size}
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-primary-hover disabled:opacity-50"
            >
              {t("applyAndSave")}{batchDirty.size > 0 && ` (${batchDirty.size})`}
            </button>
            {batchDirty.size > 0 && (
              <button
                onClick={() => { setBatchSpeed(1.0); setBatchPitch(0); setBatchColorTag(undefined); setBatchComment(""); setBatchDirty(new Set()); }}
                className="rounded-lg border border-border px-4 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover"
              >
                {t("reset")}
              </button>
            )}
            <button
              onClick={() => setShowShuffleConfirm(true)}
              disabled={!selectedClips || selectedClips.size < 2}
              title={
                selectedClips && selectedClips.size < 2
                  ? t("shuffleNeedTwo")
                  : undefined
              }
              className="rounded-lg border border-border bg-background px-4 py-1.5 text-sm font-medium text-theme transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              🔀 {t("shuffleSelected")}
            </button>
            <button
              onClick={() => setShowBatchRemoveConfirm(true)}
              disabled={!selectedClips?.size}
              className="rounded-lg border border-red-500/30 px-4 py-1.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            >
              {t("remove")} ({selectedClips?.size || 0})
            </button>
          </div>
        </div>,
        document.getElementById("batch-controls-portal")
      )
    : null;

  // Batch mode
  if (editMode && batchMode) {
    return (
      <div>
        {batchControlsPortal}
        <div className="rounded-xl border border-border bg-surface">
          {filteredClips.map((pc) => (
            <div
              key={pc.clipId}
              onClick={(e) => toggleSelect(pc.clipId, e)}
              className={`flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2.5 last:border-0 transition-colors ${
                selectedClips?.has(pc.clipId) ? "bg-primary/10" : "hover:bg-surface-hover"
              }`}
            >
              <input
                type="checkbox"
                checked={selectedClips?.has(pc.clipId) || false}
                onChange={(e) => toggleSelect(pc.clipId, e)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <span className="w-6 shrink-0 text-right text-xs text-muted">{pc.position + 1}.</span>
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-theme">{pc.clip.song.title}</span>
                <span className="ml-2 text-xs text-muted">{pc.clip.song.artist.replace(/_/g, "/")}</span>
              </div>
              {pc.colorTag && (
                <div className="flex gap-1">
                  {pc.colorTag.split("|").filter(Boolean).map((c) => (
                    <div key={c} className="h-3 w-3 rounded-full" style={{ backgroundColor: c }} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {showBatchConfirm && (
          <ConfirmDialog
            title={t("applyAndSave")}
            message={`${t("selectedCount").replace("{count}", selectedClips?.size || 0)}\n\n${batchSummary}`}
            confirmLabel={t("confirm")}
            cancelLabel={t("cancel")}
            onConfirm={applyBatch}
            onCancel={() => setShowBatchConfirm(false)}
          />
        )}
        {showShuffleConfirm && (
          <ConfirmDialog
            title={t("shuffleConfirmTitle")}
            message={
              t("shuffleConfirmBody").replace("{count}", selectedClips?.size || 0) +
              (shuffleCrossings > 0 ? `\n\n${t("shuffleCrossSectionWarning")}` : "")
            }
            confirmLabel={t("confirm")}
            cancelLabel={t("cancel")}
            onConfirm={applyShuffle}
            onCancel={() => setShowShuffleConfirm(false)}
          />
        )}
        {showBatchRemoveConfirm && (
          <ConfirmDialog
            title={t("remove")}
            message={t("batchRemoveConfirm")?.replace("{count}", selectedClips?.size || 0) || `Remove ${selectedClips?.size || 0} clips?`}
            confirmLabel={t("remove")}
            cancelLabel={t("cancel")}
            danger
            onConfirm={batchRemove}
            onCancel={() => setShowBatchRemoveConfirm(false)}
          />
        )}
      </div>
    );
  }

  // One grid per section in both modes, every card under the same parent.
  //
  // Edit mode used to cut each section into one grid per row, to fit an "add
  // section" button between rows. But React only matches cards among siblings
  // of the same parent, so any card that changed rows — entering or leaving
  // edit mode, each keystroke in the filter, every remove or move above it —
  // was torn down and rebuilt: seconds per keystroke on a phone, and playback
  // on that card stopped. The button is now a full-width item of the same
  // grid, so the cards never change parent.
  //
  // Spacing matches the old per-row grids exactly: no vertical gap between
  // rows (the button row separates them), and on phones, where a row is a
  // one-column stack, the cards within it keep their 16px apart.
  const editGridClass = "grid gap-x-4 gap-y-0 grid-cols-1 sm:grid-cols-[repeat(var(--cols),minmax(0,1fr))]";

  const renderSectionClips = (clips) => (
    <div className={editMode ? editGridClass : gridClass} style={gridStyle}>
      {clips.map((pc, i) => (
        <Fragment key={pc.clipId}>
          {editMode && i % colCount === 0 && (
            <div className="col-span-full flex justify-center py-1 opacity-0 transition-opacity hover:opacity-100">
              <button
                onClick={() => setSectionPromptClipId(pc.clipId)}
                className="rounded border border-border bg-surface px-2 py-0.5 text-xs text-muted transition-colors hover:border-primary hover:text-theme"
              >
                + {t("addSection")}
              </button>
            </div>
          )}
          <SortableClip
            id={pc.clipId}
            disabled={!editMode || dragDisabled}
            showHandle={editMode}
            className={editMode && i % colCount !== 0 ? "max-sm:mt-4" : ""}
          >
            <PlayerBox
              playlistClip={pc}
              playlistId={playlist.id}
              editMode={editMode}
              highlighted={highlightedClipId === pc.clipId}
              onUpdate={onClipUpdated}
              onRemove={editMode ? setRemoveConfirmClipId : undefined}
              onSwap={editMode ? handleSwapCarryingExpand : undefined}
              position={pc.position + 1}
              totalClips={editMode ? playlist.clips.length : undefined}
              onMove={editMode ? handleMove : undefined}
              getAllClips={getAllClips}
              clipIndex={pc.position}
              collapsed={!expandedClipIds.has(pc.clipId)}
              onToggleExpand={handleToggleExpand}
              isOwner={playlist.isOwner}
            />
          </SortableClip>
        </Fragment>
      ))}
    </div>
  );

  // Full card grid view with sections
  const sections = (
    <>
      {sectionGroups.map((section, si) => (
        <Fragment key={section.clipId || `section-${si}`}>
          {section.label && (
            <SectionDivider
              label={section.label}
              clipId={section.clipId}
              editMode={editMode}
              onClipUpdated={onClipUpdated}
            />
          )}
          {renderSectionClips(section.clips)}
        </Fragment>
      ))}
    </>
  );

  // DndContext is mounted in view mode too (every item disabled, no handles):
  // swapping it in and out with edit mode would change every card's parent,
  // which is the rebuild the single grid above exists to avoid.
  const gridContent = (
    <div>
      <DndContext
        sensors={editMode ? editSensors : viewSensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {sections}
        </SortableContext>
      </DndContext>

      {sectionPromptClipId && (
        <ConfirmDialog
          title={t("addSection")}
          message={t("sectionLabelPrompt")}
          confirmLabel={t("confirm")}
          cancelLabel={t("cancel")}
          input
          inputPlaceholder={t("sectionLabelPlaceholder")}
          onConfirm={(label) => {
            if (label) onClipUpdated(sectionPromptClipId, { sectionLabel: label });
            setSectionPromptClipId(null);
          }}
          onCancel={() => setSectionPromptClipId(null)}
        />
      )}
      {removeConfirmClipId && (
        <ConfirmDialog
          title={t("remove")}
          message={t("removeClipConfirm")}
          confirmLabel={t("remove")}
          cancelLabel={t("cancel")}
          danger
          onConfirm={() => handleRemove(removeConfirmClipId)}
          onCancel={() => setRemoveConfirmClipId(null)}
        />
      )}
    </div>
  );

  return gridContent;
}
