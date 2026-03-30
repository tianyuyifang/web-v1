"use client";

import { useState, useEffect, useRef } from "react";
import { songsAPI, clipsAPI } from "@/lib/api";
import { formatDuration } from "@/lib/utils";
import { useLanguage } from "@/components/layout/LanguageProvider";
import useAuth from "@/hooks/useAuth";
import ConfirmDialog from "@/components/ui/ConfirmDialog";

export default function ClipSwitcher({ songId, currentClipId, onSwap, onNewClip }) {
  const { t } = useLanguage();
  const { isAdmin } = useAuth();
  const [clips, setClips] = useState(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deleteConfirmClipId, setDeleteConfirmClipId] = useState(null);
  const ref = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open || deleteConfirmClipId) return;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, deleteConfirmClipId]);

  const handleOpen = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (!clips) {
      setLoading(true);
      try {
        const res = await songsAPI.getClips(songId);
        setClips(res.data.clips);
      } catch {
        setClips([]);
      } finally {
        setLoading(false);
      }
    }
  };

  const handleSelect = (clipId) => {
    if (clipId === currentClipId) return;
    onSwap(clipId);
    setOpen(false);
  };

  const handleToggleGlobal = async (e, clipId) => {
    e.stopPropagation();
    try {
      const res = await clipsAPI.toggleGlobal(clipId);
      setClips((prev) =>
        prev.map((c) => (c.id === clipId ? { ...c, isGlobal: res.data.isGlobal } : c))
      );
    } catch {
      // silent
    }
  };

  const handleDeleteClip = async (clipId) => {
    try {
      const res = await clipsAPI.delete(clipId);
      setClips((prev) => prev.filter((c) => c.id !== clipId));
      if (clipId === currentClipId && res.data.replacedBy) {
        onSwap(res.data.replacedBy);
      }
    } catch {
      // silent
    }
    setDeleteConfirmClipId(null);
  };

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={handleOpen}
        className="rounded border border-border bg-background px-2 py-0.5 text-xs text-muted hover:border-primary hover:text-theme transition-colors"
        title={t("switchClip")}
      >
        {t("switchClip")} ▾
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-surface shadow-lg">
          {loading && (
            <p className="px-3 py-2 text-xs text-muted">{t("loading")}</p>
          )}
          {clips && clips.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted">{t("noOtherClips")}</p>
          )}
          {clips && clips.length > 0 && (
            <div className="max-h-48 overflow-y-auto py-1">
              {clips.map((clip) => (
                <div
                  key={clip.id}
                  className={`flex items-center px-3 py-2 text-xs transition-colors hover:bg-surface-hover ${
                    clip.id === currentClipId ? "text-primary font-medium" : "text-theme"
                  }`}
                >
                  <button
                    onClick={() => handleSelect(clip.id)}
                    className="flex-1 text-left"
                  >
                    <span className="font-mono">{formatDuration(clip.start)}</span>
                    {clip.isOwn && !clip.isGlobal && (
                      <span className="ml-1 text-xs text-accent">★</span>
                    )}
                    {clip.preview && (
                      <span className="ml-2 text-muted">— {clip.preview}</span>
                    )}
                    {clip.id === currentClipId && (
                      <span className="ml-1 text-primary">✓</span>
                    )}
                  </button>
                  {isAdmin && (
                    <div className="ml-2 flex shrink-0 gap-1">
                      <button
                        onClick={(e) => handleToggleGlobal(e, clip.id)}
                        className="text-xs transition-colors hover:text-primary"
                        title={clip.isGlobal ? t("setPrivate") : t("setGlobal")}
                      >
                        {clip.isGlobal ? "🌐" : "🔒"}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirmClipId(clip.id); }}
                        className="text-xs text-red-400 transition-colors hover:text-red-300"
                        title={t("remove")}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {clips && (
            <button
              onClick={() => { onNewClip?.(); setOpen(false); }}
              className="w-full border-t border-border px-3 py-2 text-left text-xs text-primary transition-colors hover:bg-surface-hover"
            >
              + {t("newClipButton")}
            </button>
          )}
        </div>
      )}
      {deleteConfirmClipId && (
        <ConfirmDialog
          title={t("deleteClipTitle") || "Delete Clip"}
          message={t("deleteClipConfirm") || "Permanently delete this clip from the database?"}
          confirmLabel={t("delete") || "Delete"}
          cancelLabel={t("cancel")}
          danger
          onConfirm={() => handleDeleteClip(deleteConfirmClipId)}
          onCancel={() => setDeleteConfirmClipId(null)}
        />
      )}
    </div>
  );
}
