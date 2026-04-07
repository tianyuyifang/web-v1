"use client";

import { useState, useEffect, useCallback, useMemo, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import { playlistsAPI, likesAPI } from "@/lib/api";
import usePlayerStore from "@/store/playerStore";
import usePlaylistLikes from "@/hooks/usePlaylistLikes";
import { getColumnCount, setColumnCount as saveColumnCount } from "@/lib/utils";
import PlaylistHeader from "@/components/playlist/PlaylistHeader";
import PlaylistGrid from "@/components/playlist/PlaylistGrid";
import ClipSidebar from "@/components/playlist/ClipSidebar";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { preloadClips } from "@/lib/audioCache";

// Lazy-load modals — only downloaded when opened
const AddClipModal = dynamic(() => import("@/components/playlist/AddClipModal"), { ssr: false });
const SharePlaylistModal = dynamic(() => import("@/components/playlist/SharePlaylistModal"), { ssr: false });
const ComparePlaylistModal = dynamic(() => import("@/components/playlist/ComparePlaylistModal"), { ssr: false });
const ConfirmDialog = dynamic(() => import("@/components/ui/ConfirmDialog"), { ssr: false });

export default function PlaylistPage() {
  const { id } = useParams();
  const router = useRouter();
  const { t } = useLanguage();

  const [playlist, setPlaylist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [compactView, setCompactView] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedClips, setSelectedClips] = useState(new Set());
  const [columns, setColumns] = useState(3);
  const [gridSearch, setGridSearch] = useState("");
  const [showAddClip, setShowAddClip] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showPublicConfirm, setShowPublicConfirm] = useState(false);
  const [showUnlikeAllConfirm, setShowUnlikeAllConfirm] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [highlightedClipId, setHighlightedClipId] = useState(null);

  const setLikedClips = usePlayerStore((s) => s.setLikedClips);
  const triggerPlayFromStart = usePlayerStore((s) => s.triggerPlayFromStart);

  // SSE: real-time like updates from other users
  usePlaylistLikes(id);

  useEffect(() => { setColumns(getColumnCount()); }, []);

  useEffect(() => {
    if (!playlist?.clips?.length) return;
    preloadClips(playlist.clips.map((pc) => ({ clipId: pc.clipId, version: pc.clip.version })), 8);
  }, [playlist?.clips]);

  useEffect(() => {
    setLoading(true);
    Promise.all([playlistsAPI.getById(id), likesAPI.getAll(id)])
      .then(([playlistRes, likesRes]) => {
        setPlaylist(playlistRes.data);
        setLikedClips(likesRes.data.likes);
      })
      .catch((err) => {
        const status = err.response?.status;
        if (status === 404 || status === 403) router.push("/playlists");
      })
      .finally(() => setLoading(false));
  }, [id, router, setLikedClips]);

  const handleColumnChange = useCallback((count) => {
    setColumns(count);
    saveColumnCount(count);
  }, []);

  const handleClipAdded = useCallback((newClip) => {
    setPlaylist((prev) => ({ ...prev, clips: [...prev.clips, newClip] }));
    setShowAddClip(false);
  }, []);

  const handleClipRemoved = useCallback((clipId) => {
    setPlaylist((prev) => ({
      ...prev,
      clips: prev.clips
        .filter((c) => c.clipId !== clipId)
        .map((c, i) => ({ ...c, position: i })),
    }));
  }, []);

  const handleReorder = useCallback((reorderedClips) => {
    setPlaylist((prev) => ({ ...prev, clips: reorderedClips }));
  }, []);

  const handleClipUpdated = useCallback(async (clipId, updates) => {
    setPlaylist((prev) => ({
      ...prev,
      clips: prev.clips.map((c) => c.clipId === clipId ? { ...c, ...updates } : c),
    }));
    try {
      await playlistsAPI.batchUpdateClips(id, [{ clipId, ...updates }]);
    } catch {
      // silent
    }
  }, [id]);

  const handleClipSwapped = useCallback(async (oldClipId, newClipId) => {
    try {
      const res = await playlistsAPI.swapClip(id, oldClipId, newClipId);
      setPlaylist((prev) => ({
        ...prev,
        clips: prev.clips.map((c) =>
          c.clipId === oldClipId
            ? {
                ...c,
                clipId: res.data.clip.id,
                clip: {
                  id: res.data.clip.id,
                  start: res.data.clip.start,
                  length: res.data.clip.length,
                  version: res.data.clip.version,
                  song: res.data.clip.song,
                },
              }
            : c
        ),
      }));
    } catch {
      // silent
    }
  }, [id]);

  const handleDeleteConfirm = useCallback(async () => {
    await playlistsAPI.delete(id);
    router.push("/dashboard");
  }, [id, router]);

  const handleUnlikeAll = useCallback(async () => {
    await likesAPI.unlikeAll(id);
    const store = usePlayerStore.getState();
    const newLiked = new Set([...store.likedClips].filter((k) => !k.startsWith(`${id}:`)));
    usePlayerStore.setState({ likedClips: newLiked });
  }, [id]);

  const handlePublicConfirm = useCallback(async () => {
    const newValue = !playlist.isPublic;
    await playlistsAPI.update(id, { isPublic: newValue });
    setPlaylist((prev) => ({ ...prev, isPublic: newValue }));
    setShowPublicConfirm(false);
  }, [id, playlist?.isPublic]);

  const handleUpdatePlaylist = useCallback(async (updates) => {
    await playlistsAPI.update(id, updates);
    setPlaylist((prev) => ({ ...prev, ...updates }));
  }, [id]);

  const handleCopy = useCallback(async () => {
    const res = await playlistsAPI.copy(id);
    router.push(`/playlists/${res.data.id}`);
  }, [id, router]);

  const handleSidebarClipClick = useCallback((clipId) => {
    setHighlightedClipId(clipId);
    document.getElementById(`playerbox-${clipId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    triggerPlayFromStart(clipId);
    setTimeout(() => setHighlightedClipId(null), 3000);
  }, [triggerPlayFromStart]);

  const scrollAnchorRef = useRef(null);

  const toggleEditMode = useCallback(() => {
    // Find the first visible PlayerBox and record its viewport position
    const boxes = document.querySelectorAll('[id^="playerbox-"]');
    for (const box of boxes) {
      const rect = box.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) {
        scrollAnchorRef.current = { id: box.id, top: rect.top };
        break;
      }
    }
    setEditMode((prev) => !prev);
  }, []);

  // After editMode changes and DOM is updated, restore scroll position
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (!anchor) return;
    scrollAnchorRef.current = null;
    const el = document.getElementById(anchor.id);
    if (!el) return;
    const newTop = el.getBoundingClientRect().top;
    window.scrollBy(0, newTop - anchor.top);
  }, [editMode]);

  const sections = useMemo(() => {
    if (!playlist?.clips) return [];
    return playlist.clips
      .filter((pc) => pc.sectionLabel)
      .map((pc) => ({ clipId: pc.clipId, label: pc.sectionLabel }));
  }, [playlist?.clips]);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!playlist) return null;

  return (
    <div className="flex gap-4">
      <ClipSidebar
        clips={playlist.clips}
        playlistId={playlist.id}
        onClipClick={handleSidebarClipClick}
      />

      <div className="min-w-0 flex-1">
        <div data-sticky-header className="sticky top-0 z-30 border-b border-border pb-3 pt-16" style={{ backgroundColor: "var(--background)" }}>
          <PlaylistHeader
            playlist={playlist}
            editMode={editMode}
            onReturn={() => router.push("/playlists")}
            onToggleEditMode={toggleEditMode}
            columns={columns}
            onColumnChange={handleColumnChange}
            onCopy={handleCopy}
            onUpdatePlaylist={handleUpdatePlaylist}
            onUnlikeAll={() => setShowUnlikeAllConfirm(true)}
            onToggleCompact={() => setCompactView((v) => !v)}
            onToggleBatch={() => {
              setBatchMode((v) => !v);
              setSelectedClips(new Set());
              if (!batchMode) setCompactView(false);
            }}
            onTogglePublic={() => setShowPublicConfirm(true)}
            onAddClip={() => setShowAddClip(true)}
            onShare={() => setShowShare(true)}
            onDelete={() => setShowDeleteConfirm(true)}
            onCompare={() => setShowCompare(true)}
            compactView={compactView}
            batchMode={batchMode}
          />

          <input
            type="text"
            value={gridSearch}
            onChange={(e) => setGridSearch(e.target.value)}
            placeholder={t("filterClips")}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
          />

          <div id="batch-controls-portal" />

          {sections.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {sections.map((s) => (
                <button
                  key={s.clipId}
                  onClick={() => document.getElementById(`section-${s.clipId}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-theme transition-colors hover:bg-surface-hover"
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="pt-4">
          <PlaylistGrid
            playlist={playlist}
            columns={columns}
            editMode={editMode}
            compactView={compactView}
            batchMode={batchMode}
            selectedClips={selectedClips}
            onSelectedChange={setSelectedClips}
            onBatchDone={() => { setBatchMode(false); setSelectedClips(new Set()); }}
            searchQuery={gridSearch}
            highlightedClipId={highlightedClipId}
            onClipRemoved={handleClipRemoved}
            onClipUpdated={handleClipUpdated}
            onClipSwapped={handleClipSwapped}
            onReorder={handleReorder}
          />
        </div>
      </div>

      {showAddClip && (
        <AddClipModal
          playlistId={playlist.id}
          onClose={() => setShowAddClip(false)}
          onClipAdded={handleClipAdded}
        />
      )}

      {showShare && (
        <SharePlaylistModal
          playlist={playlist}
          onClose={() => setShowShare(false)}
        />
      )}

      {showDeleteConfirm && (
        <ConfirmDialog
          title={t("deletePlaylistTitle")}
          message={t("deletePlaylistConfirm")}
          confirmLabel={t("delete")}
          cancelLabel={t("cancel")}
          danger
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {showUnlikeAllConfirm && (
        <ConfirmDialog
          title={t("unlikeAllTitle")}
          message={t("unlikeAllConfirm")}
          confirmLabel={t("confirm")}
          cancelLabel={t("cancel")}
          danger
          onConfirm={() => { handleUnlikeAll(); setShowUnlikeAllConfirm(false); }}
          onCancel={() => setShowUnlikeAllConfirm(false)}
        />
      )}

      {showPublicConfirm && (
        <ConfirmDialog
          title={playlist.isPublic ? t("makePrivateTitle") : t("makePublicTitle")}
          message={playlist.isPublic ? t("makePrivateMessage") : t("makePublicMessage")}
          confirmLabel={t("confirm")}
          cancelLabel={t("cancel")}
          onConfirm={handlePublicConfirm}
          onCancel={() => setShowPublicConfirm(false)}
        />
      )}

      {showCompare && (
        <ComparePlaylistModal
          playlistId={playlist.id}
          onClose={() => setShowCompare(false)}
        />
      )}
    </div>
  );
}
