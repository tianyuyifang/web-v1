"use client";

import { useState, useEffect, useCallback } from "react";
import { playlistsAPI } from "@/lib/api";
import useSearch from "@/hooks/useSearch";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function BatchShareModal({ onClose }) {
  const { t } = useLanguage();
  const [targetUser, setTargetUser] = useState(null);
  const [playlists, setPlaylists] = useState([]); // { id, name, isShared, canCopy }
  const [shareSet, setShareSet] = useState(new Set());
  const [copySet, setCopySet] = useState(new Set());
  const [origShareSet, setOrigShareSet] = useState(new Set());
  const [origCopySet, setOrigCopySet] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const { query, setQuery, results, isSearching } = useSearch({
    endpoint: "/users/search",
  });

  const loadStatus = useCallback(async (userId) => {
    setLoading(true);
    try {
      const res = await playlistsAPI.getBatchShareStatus(userId);
      const list = res.data.playlists || [];
      setPlaylists(list);
      const shared = new Set(list.filter((p) => p.isShared).map((p) => p.id));
      const copy = new Set(list.filter((p) => p.canCopy).map((p) => p.id));
      setShareSet(new Set(shared));
      setCopySet(new Set(copy));
      setOrigShareSet(shared);
      setOrigCopySet(copy);
    } catch {
      setPlaylists([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectUser = (user) => {
    setTargetUser(user);
    setQuery("");
    setMessage("");
    loadStatus(user.id);
  };

  const clearUser = () => {
    setTargetUser(null);
    setPlaylists([]);
    setShareSet(new Set());
    setCopySet(new Set());
    setOrigShareSet(new Set());
    setOrigCopySet(new Set());
    setMessage("");
  };

  const toggleShare = (id) => {
    setShareSet((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleCopy = (id) => {
    setCopySet((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAllShare = () => setShareSet(new Set(playlists.map((p) => p.id)));
  const deselectAllShare = () => setShareSet(new Set());
  const selectAllCopy = () => setCopySet(new Set(playlists.map((p) => p.id)));
  const deselectAllCopy = () => setCopySet(new Set());

  const handleApply = async () => {
    const sharePlaylistIds = [...shareSet].filter((id) => !origShareSet.has(id));
    const unsharePlaylistIds = [...origShareSet].filter((id) => !shareSet.has(id));
    const copyPlaylistIds = [...copySet].filter((id) => !origCopySet.has(id));
    const uncopyPlaylistIds = [...origCopySet].filter((id) => !copySet.has(id));

    if (!sharePlaylistIds.length && !unsharePlaylistIds.length && !copyPlaylistIds.length && !uncopyPlaylistIds.length) {
      setMessage(t("batchShareNoChange"));
      return;
    }

    setSaving(true);
    try {
      await playlistsAPI.batchShare({
        userId: targetUser.id,
        sharePlaylistIds,
        unsharePlaylistIds,
        copyPlaylistIds,
        uncopyPlaylistIds,
      });
      setMessage(t("batchShareSuccess"));
      // Update orig sets to reflect new state
      setOrigShareSet(new Set(shareSet));
      setOrigCopySet(new Set(copySet));
    } catch {
      setMessage("Error updating shares.");
    } finally {
      setSaving(false);
    }
  };

  const allShareChecked = playlists.length > 0 && shareSet.size === playlists.length;
  const allCopyChecked = playlists.length > 0 && copySet.size === playlists.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex w-full max-w-lg flex-col rounded-lg border border-border bg-surface p-6" style={{ maxHeight: "80vh" }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{t("batchShare")}</h2>
          <button onClick={onClose} className="text-muted hover:text-theme">
            ✕
          </button>
        </div>

        <p className="mb-4 text-sm text-muted">{t("batchShareDesc")}</p>

        {/* User search / selected user */}
        {!targetUser ? (
          <div className="relative mb-4">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchUserBatchShare")}
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
            />
            {query && results.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded border border-border bg-surface shadow-lg">
                {results.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => selectUser(u)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-hover"
                  >
                    <span className="text-theme">{u.username}</span>
                  </button>
                ))}
              </div>
            )}
            {isSearching && (
              <p className="mt-1 text-xs text-muted">{t("searching")}</p>
            )}
          </div>
        ) : (
          <div className="mb-4 flex items-center gap-2">
            <span className="text-sm text-theme">{targetUser.username}</span>
            <button
              onClick={clearUser}
              className="text-xs text-muted hover:text-theme"
            >
              ✕
            </button>
          </div>
        )}

        {/* Playlist list with checkboxes */}
        {targetUser && !loading && playlists.length > 0 && (
          <>
            {/* Header row with select all */}
            <div className="mb-2 flex items-center gap-4 border-b border-border pb-2 text-xs font-semibold text-muted">
              <span className="flex-1">{t("playlist")}</span>
              <div className="flex w-20 flex-col items-center gap-0.5">
                <span>{t("viewAccess")}</span>
                <button
                  onClick={allShareChecked ? deselectAllShare : selectAllShare}
                  className="text-[10px] text-primary hover:underline"
                >
                  {allShareChecked ? t("deselectAll") : t("selectAll")}
                </button>
              </div>
              <div className="flex w-20 flex-col items-center gap-0.5">
                <span>{t("copyPermission")}</span>
                <button
                  onClick={allCopyChecked ? deselectAllCopy : selectAllCopy}
                  className="text-[10px] text-primary hover:underline"
                >
                  {allCopyChecked ? t("deselectAll") : t("selectAll")}
                </button>
              </div>
            </div>

            {/* Scrollable playlist list */}
            <div className="flex-1 space-y-1 overflow-y-auto" style={{ minHeight: 0 }}>
              {playlists.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-4 rounded px-2 py-1.5 hover:bg-surface-hover"
                >
                  <span className="flex-1 truncate text-sm text-theme">{p.name}</span>
                  <div className="flex w-20 justify-center">
                    <input
                      type="checkbox"
                      checked={shareSet.has(p.id)}
                      onChange={() => toggleShare(p.id)}
                      className="h-4 w-4 accent-primary"
                    />
                  </div>
                  <div className="flex w-20 justify-center">
                    <input
                      type="checkbox"
                      checked={copySet.has(p.id)}
                      onChange={() => toggleCopy(p.id)}
                      className="h-4 w-4 accent-primary"
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {targetUser && loading && (
          <div className="py-8 text-center text-sm text-muted">Loading...</div>
        )}

        {targetUser && !loading && playlists.length === 0 && (
          <div className="py-8 text-center text-sm text-muted">No playlists found.</div>
        )}

        {/* Footer */}
        {targetUser && playlists.length > 0 && (
          <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
            {message ? (
              <span className="text-xs text-muted">{message}</span>
            ) : (
              <span />
            )}
            <button
              onClick={handleApply}
              disabled={saving}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary-hover disabled:opacity-50"
            >
              {saving ? "..." : t("applyBatchShare")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
