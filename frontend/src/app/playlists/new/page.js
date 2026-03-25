"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { playlistsAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import ImportClipsModal from "@/components/playlist/ImportClipsModal";

export default function NewPlaylistPage() {
  const router = useRouter();
  const { t } = useLanguage();

  // --- Create form state ---
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);

  // --- Import state ---
  const [createdPlaylistId, setCreatedPlaylistId] = useState(null);
  const [showImport, setShowImport] = useState(false);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setCreateError(t("playlistNameRequired")); return; }
    setCreating(true);
    setCreateError("");
    try {
      const res = await playlistsAPI.create({
        name: name.trim(),
        description: description.trim() || null,
        isPublic,
      });
      router.push(`/playlists/${res.data.id}`);
    } catch (err) {
      setCreateError(err.response?.data?.error?.message || t("createPlaylistFailed"));
    } finally {
      setCreating(false);
    }
  };

  const handleImportClick = async () => {
    if (!name.trim()) { setCreateError(t("playlistNameRequired")); return; }
    setCreating(true);
    setCreateError("");
    try {
      const res = await playlistsAPI.create({
        name: name.trim(),
        description: description.trim() || null,
        isPublic,
      });
      setCreatedPlaylistId(res.data.id);
      setShowImport(true);
    } catch (err) {
      setCreateError(err.response?.data?.error?.message || t("createPlaylistFailed"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-theme">{t("newPlaylistTitle")}</h1>
        <button
          onClick={() => router.push("/playlists")}
          className="text-sm text-muted hover:text-theme transition-colors"
        >
          ← {t("playlists")}
        </button>
      </div>

      <form onSubmit={handleCreate} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-muted">{t("name")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-theme focus:border-primary focus:outline-none"
            placeholder={t("namePlaceholder")}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted">{t("descriptionOptional")}</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-theme focus:border-primary focus:outline-none"
            placeholder={t("descriptionPlaceholder")}
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-theme">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="rounded border-border"
          />
          {t("makePublic")}
        </label>

        {createError && <p className="text-sm text-red-400">{createError}</p>}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={creating}
            className="flex-1 rounded-lg bg-primary px-4 py-2 font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {creating ? t("creating") : t("createPlaylist")}
          </button>
          <button
            type="button"
            onClick={handleImportClick}
            disabled={creating}
            className="rounded-lg border border-border bg-surface px-4 py-2 font-medium text-theme hover:bg-surface-hover disabled:opacity-50"
          >
            {t("importClips")}
          </button>
        </div>
      </form>

      {showImport && createdPlaylistId && (
        <ImportClipsModal
          playlistId={createdPlaylistId}
          onClose={() => router.push(`/playlists/${createdPlaylistId}`)}
          onImported={() => router.push(`/playlists/${createdPlaylistId}`)}
        />
      )}
    </div>
  );
}
