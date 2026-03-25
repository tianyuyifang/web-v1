"use client";

import { useState, useEffect } from "react";
import { playlistsAPI } from "@/lib/api";
import useSearch from "@/hooks/useSearch";
import { useLanguage } from "@/components/layout/LanguageProvider";

function UserList({ title, users, onRemove }) {
  const { t } = useLanguage();
  if (users.length === 0) {
    return (
      <p className="py-2 text-xs text-muted">{t("noUsersInList")}</p>
    );
  }

  return (
    <div className="space-y-1">
      {users.map((u) => (
        <div
          key={u.id}
          className="flex items-center justify-between rounded bg-background px-2 py-1"
        >
          <div>
            <span className="text-sm text-theme">{u.username}</span>
          </div>
          <button
            onClick={() => onRemove(u.id)}
            className="text-xs text-red-400 hover:text-red-300"
          >
            {t("remove")}
          </button>
        </div>
      ))}
    </div>
  );
}

function UserSearchAdd({ placeholder, onAdd }) {
  const { t } = useLanguage();
  const { query, setQuery, results, isSearching } = useSearch({
    endpoint: "/users/search",
  });

  const handleSelect = (user) => {
    onAdd(user);
    setQuery("");
  };

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
      />
      {query && results.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded border border-border bg-surface shadow-lg">
          {results.map((u) => (
            <button
              key={u.id}
              onClick={() => handleSelect(u)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-surface-hover"
            >
              <span className="text-theme">{u.username}</span>
              <span className="text-xs text-muted">{u.email}</span>
            </button>
          ))}
        </div>
      )}
      {isSearching && (
        <p className="mt-1 text-xs text-muted">{t("searching")}</p>
      )}
    </div>
  );
}

export default function SharePlaylistModal({ playlist, onClose }) {
  const { t } = useLanguage();
  const [shares, setShares] = useState([]);
  const [copyPerms, setCopyPerms] = useState([]);

  useEffect(() => {
    playlistsAPI.getShares(playlist.id).then((r) => setShares(r.data.shares || []));
    playlistsAPI
      .getCopyPermissions(playlist.id)
      .then((r) => setCopyPerms(r.data.copyPermissions || []));
  }, [playlist.id]);

  // Share management
  const addShare = async (user) => {
    try {
      await playlistsAPI.addShare(playlist.id, { userId: user.id });
      setShares((prev) => [...prev, user]);
    } catch {
      // silent (e.g., already shared)
    }
  };

  const removeShare = async (userId) => {
    try {
      await playlistsAPI.removeShare(playlist.id, userId);
      setShares((prev) => prev.filter((u) => u.id !== userId));
    } catch {
      // silent
    }
  };

  // Copy permission management
  const addCopyPerm = async (user) => {
    try {
      await playlistsAPI.addCopyPermission(playlist.id, { userId: user.id });
      setCopyPerms((prev) => [...prev, user]);
    } catch {
      // silent
    }
  };

  const removeCopyPerm = async (userId) => {
    try {
      await playlistsAPI.removeCopyPermission(playlist.id, userId);
      setCopyPerms((prev) => prev.filter((u) => u.id !== userId));
    } catch {
      // silent
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{t("sharePlaylist")}</h2>
          <button onClick={onClose} className="text-muted hover:text-theme">
            ✕
          </button>
        </div>

        {/* Share list */}
        <div className="mb-6">
          <h3 className="mb-2 text-sm font-semibold text-theme">
            {t("viewAccess")}
          </h3>
          <UserSearchAdd
            placeholder={t("searchUserShare")}
            onAdd={addShare}
          />
          <div className="mt-2">
            <UserList title="Shared with" users={shares} onRemove={removeShare} />
          </div>
        </div>

        {/* Copy permissions list */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-theme">
            {t("copyPermission")}
          </h3>
          <UserSearchAdd
            placeholder={t("searchUserCopy")}
            onAdd={addCopyPerm}
          />
          <div className="mt-2">
            <UserList
              title="Can copy"
              users={copyPerms}
              onRemove={removeCopyPerm}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
