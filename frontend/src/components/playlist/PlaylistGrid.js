"use client";

import { useState, useMemo, useCallback, useEffect, useRef, Fragment } from "react";
import { createPortal } from "react-dom";

import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { playlistsAPI } from "@/lib/api";
import { matchesSearch } from "@/lib/utils";
import PlayerBox from "@/components/player/PlayerBox";
import SpeedControl from "@/components/player/SpeedControl";
import PitchControl from "@/components/player/PitchControl";
import ColorTag from "@/components/player/ColorTag";
import LikeButton from "@/components/player/LikeButton";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { useLanguage } from "@/components/layout/LanguageProvider";
import usePlayerStore from "@/store/playerStore";

function SortableCompactRow({ playlistClip, playlistId, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: playlistClip.clipId });

  const { clip } = playlistClip;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      {...attributes}
      {...listeners}
      className="flex items-center gap-3 border-b border-border/50 px-3 py-2 hover:bg-surface-hover"
    >
      <span className="cursor-grab text-muted">⠿</span>
      <span className="w-6 shrink-0 text-right text-xs text-muted">{playlistClip.position + 1}.</span>
      {playlistClip.colorTag && (
        <div className="flex shrink-0 gap-0.5 self-stretch">
          {playlistClip.colorTag.split("|").filter(Boolean).map((c) => (
            <div key={c} className="w-[3px] rounded-full" style={{ background: c }} />
          ))}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium text-theme">{clip.song.title}</span>
        <span className="ml-2 text-xs text-muted">{clip.song.artist.replace(/_/g, "/")}</span>
      </div>
      <LikeButton playlistId={playlistId} clipId={playlistClip.clipId} />
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(playlistClip.clipId); }}
          className="text-xs font-medium text-red-400 hover:text-red-300"
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
  compactView,
  batchMode,
  selectedClips,
  onSelectedChange,
  onBatchDone,
  searchQuery,
  highlightedClipId,
  onClipRemoved,
  onClipUpdated,
  onClipSwapped,
  onReorder,
}) {
  const { t } = useLanguage();
  const [sectionPromptClipId, setSectionPromptClipId] = useState(null);
  const [expandedClipId, setExpandedClipId] = useState(null);
  const [activelyPlayingClipId, setActivelyPlayingClipId] = useState(null);

  // Derive playing clipId from the active player (format: "playlistId-clipId")
  const activePlayerId = usePlayerStore((s) => s.activePlayerId);
  const playingClipId = useMemo(() => {
    if (!activePlayerId) return null;
    const prefix = `${playlist.id}-`;
    return activePlayerId.startsWith(prefix) ? activePlayerId.slice(prefix.length) : null;
  }, [activePlayerId, playlist.id]);

  const handlePlayStateChange = useCallback((clipId, isPlaying) => {
    setActivelyPlayingClipId(isPlaying ? clipId : null);
  }, []);

  const handleToggleExpand = useCallback((clipId) => {
    setExpandedClipId((prev) => {
      if (prev === clipId) return null; // collapse current
      if (activelyPlayingClipId && prev === activelyPlayingClipId) return prev; // block — playing clip is expanded
      return clipId; // expand new
    });
  }, [activelyPlayingClipId]);

  // Auto-expand when a clip starts playing
  useEffect(() => {
    if (playingClipId) setExpandedClipId(playingClipId);
  }, [playingClipId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const filteredClips = useMemo(() => {
    if (!searchQuery) return playlist.clips;
    return playlist.clips.filter((pc) =>
      matchesSearch(
        searchQuery,
        pc.clip.song.title,
        pc.clip.song.artist,
        pc.comment,
        pc.clip.song.titlePinyin,
        pc.clip.song.titlePinyinInitials,
        pc.clip.song.titlePinyinConcat,
        pc.clip.song.artistPinyinConcat
      )
    );
  }, [playlist.clips, searchQuery]);

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

  const handleDragEnd = useCallback(async (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const clips = [...playlist.clips];
    const oldIndex = clips.findIndex((c) => c.clipId === active.id);
    const newIndex = clips.findIndex((c) => c.clipId === over.id);
    const [moved] = clips.splice(oldIndex, 1);
    clips.splice(newIndex, 0, moved);

    const reordered = clips.map((c, i) => ({ ...c, position: i }));
    onReorder(reordered);

    try {
      await playlistsAPI.reorderClips(playlist.id, { clipIds: reordered.map((c) => c.clipId) });
    } catch {
      // silent
    }
  }, [playlist, onReorder]);

  const handleMove = useCallback(async (clipId, fromIndex, toIndex) => {
    const clips = [...playlist.clips];
    const clampedTo = Math.max(0, Math.min(clips.length - 1, toIndex));
    if (fromIndex === clampedTo) return;

    const [moved] = clips.splice(fromIndex, 1);
    clips.splice(clampedTo, 0, moved);

    const reordered = clips.map((c, i) => ({ ...c, position: i }));
    onReorder(reordered);

    try {
      await playlistsAPI.reorderClips(playlist.id, { clipIds: reordered.map((c) => c.clipId) });
    } catch {
      // silent
    }
  }, [playlist, onReorder]);

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
    if (batchDirty.has("speed")) parts.push(`${t("speed") || "Speed"}: ${batchSpeed}x`);
    if (batchDirty.has("pitch")) parts.push(`${t("pitch") || "Pitch"}: ${batchPitch > 0 ? "+" : ""}${batchPitch}`);
    if (batchDirty.has("colorTag")) parts.push(`${t("clear") || "Color"}: ${batchColorTag || "—"}`);
    if (batchDirty.has("comment")) parts.push(`${t("addComment") || "Comment"}: ${batchComment || "—"}`);
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

  const [showBatchRemoveConfirm, setShowBatchRemoveConfirm] = useState(false);

  const batchRemove = useCallback(() => {
    if (!selectedClips?.size) return;
    for (const clipId of selectedClips) handleRemove(clipId);
    setShowBatchRemoveConfirm(false);
    onBatchDone?.();
  }, [selectedClips, handleRemove, onBatchDone]);

  // Group clips into sections
  const sectionGroups = useMemo(() => {
    const groups = [];
    let current = { label: null, clipId: null, clips: [] };
    for (const pc of filteredClips) {
      if (pc.sectionLabel) {
        if (current.clips.length > 0 || current.label) groups.push(current);
        current = { label: pc.sectionLabel, clipId: pc.clipId, clips: [pc] };
      } else {
        current.clips.push(pc);
      }
    }
    if (current.clips.length > 0 || current.label) groups.push(current);
    return groups;
  }, [filteredClips]);

  const colCount = columns || 3;

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
              <label className="mb-1 block text-xs text-muted">{t("speed") || "Speed"}</label>
              <SpeedControl speed={batchSpeed} onChange={(v) => { setBatchSpeed(v); setBatchDirty(d => new Set(d).add("speed")); }} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">{t("pitch") || "Pitch"}</label>
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
              <label className="mb-1 block text-xs text-muted">{t("clear") || "Color"}</label>
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
                {t("reset") || "Reset"}
              </button>
            )}
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
              className={`flex cursor-pointer items-center gap-3 border-b border-border/50 px-3 py-2.5 last:border-0 transition-colors ${
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

  // Compact list view
  if (editMode && compactView) {
    return (
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={filteredClips.map((c) => c.clipId)} strategy={verticalListSortingStrategy}>
          <div className="rounded-xl border border-border bg-surface">
            {filteredClips.map((pc) => (
              <SortableCompactRow key={pc.clipId} playlistClip={pc} playlistId={playlist.id} onRemove={setRemoveConfirmClipId} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    );
  }

  // Section divider component
  const SectionDivider = ({ label, clipId }) => (
    <div
      id={`section-${clipId}`}
      className="flex items-center gap-3 py-2"
      style={{ scrollMarginTop: "12rem" }}
    >
      <div className="h-px flex-1 bg-border" />
      {editMode ? (
        <input
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

  // Render clips in a grid, with optional "add section" buttons between rows in edit mode
  const renderSectionClips = (clips) => {
    if (!editMode) {
      return (
        <div className={gridClass} style={gridStyle}>
          {clips.map((pc) => (
            <PlayerBox
              key={pc.clipId}
              playlistClip={pc}
              playlistId={playlist.id}
              editMode={false}
              highlighted={highlightedClipId === pc.clipId}
              onUpdate={onClipUpdated}
              position={pc.position + 1}
              allClips={playlist.clips}
              clipIndex={pc.position}
              collapsed={pc.clipId !== expandedClipId}
              onToggleExpand={handleToggleExpand}
              onPlayStateChange={handlePlayStateChange}
            />
          ))}
        </div>
      );
    }

    // Split into rows for "add section" buttons between them
    const rows = [];
    for (let i = 0; i < clips.length; i += colCount) {
      rows.push(clips.slice(i, i + colCount));
    }

    return rows.map((row, ri) => (
      <Fragment key={row[0].clipId}>
        <div className="flex justify-center py-1 opacity-0 transition-opacity hover:opacity-100">
          <button
            onClick={() => setSectionPromptClipId(row[0].clipId)}
            className="rounded border border-border bg-surface px-2 py-0.5 text-xs text-muted transition-colors hover:border-primary hover:text-theme"
          >
            + {t("addSection")}
          </button>
        </div>
        <div className={gridClass} style={gridStyle}>
          {row.map((pc) => (
            <PlayerBox
              key={pc.clipId}
              playlistClip={pc}
              playlistId={playlist.id}
              editMode
              highlighted={highlightedClipId === pc.clipId}
              onUpdate={onClipUpdated}
              onRemove={setRemoveConfirmClipId}
              onSwap={onClipSwapped}
              position={pc.position + 1}
              totalClips={playlist.clips.length}
              onMove={handleMove}
              allClips={playlist.clips}
              clipIndex={pc.position}
              collapsed={pc.clipId !== expandedClipId}
              onToggleExpand={handleToggleExpand}
              onPlayStateChange={handlePlayStateChange}
            />
          ))}
        </div>
      </Fragment>
    ));
  };

  // Full card grid view with sections
  const gridContent = (
    <div>
      {sectionGroups.map((section, si) => (
        <Fragment key={section.clipId || `section-${si}`}>
          {section.label && <SectionDivider label={section.label} clipId={section.clipId} />}
          {renderSectionClips(section.clips)}
        </Fragment>
      ))}

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
          message={t("removeClipConfirm") || "Remove this clip?"}
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
