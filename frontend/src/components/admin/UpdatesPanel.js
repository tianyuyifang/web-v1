"use client";

import { useState, useEffect, useCallback } from "react";
import { updatesAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import ConfirmDialog from "@/components/ui/ConfirmDialog";

const CATEGORY_STYLES = {
  FEATURE: "bg-green-500/15 text-green-400",
  FIX: "bg-blue-500/15 text-blue-400",
  ANNOUNCEMENT: "bg-yellow-500/15 text-yellow-400",
};

function categoryLabel(t, category) {
  if (category === "FEATURE") return t("updateCategoryFeature");
  if (category === "FIX") return t("updateCategoryFix");
  return t("updateCategoryAnnouncement");
}

const EMPTY_FORM = { title: "", body: "", category: "ANNOUNCEMENT" };

export default function UpdatesPanel() {
  const { t } = useLanguage();
  const [updates, setUpdates] = useState([]);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null); // null = create mode
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchUpdates = useCallback(async () => {
    setFetching(true);
    setError("");
    try {
      const res = await updatesAPI.list();
      setUpdates(res.data.updates);
    } catch (err) {
      setError(err.response?.data?.error?.message || t("actionFailed"));
    } finally {
      setFetching(false);
    }
  }, [t]);

  useEffect(() => {
    fetchUpdates();
  }, [fetchUpdates]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
  }

  function startEdit(u) {
    setForm({ title: u.title, body: u.body, category: u.category });
    setEditingId(u.id);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.body.trim()) return;
    setSaving(true);
    setError("");
    try {
      if (editingId) {
        await updatesAPI.edit(editingId, form);
      } else {
        await updatesAPI.create(form);
      }
      resetForm();
      await fetchUpdates();
    } catch (err) {
      setError(err.response?.data?.error?.message || t("actionFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    try {
      await updatesAPI.remove(id);
      if (editingId === id) resetForm();
      await fetchUpdates();
    } catch (err) {
      setError(err.response?.data?.error?.message || t("actionFailed"));
    }
  }

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Create / edit form */}
      <form onSubmit={handleSubmit} className="mb-6 flex flex-col gap-3 rounded-lg border border-border bg-background/60 p-4">
        <div>
          <label className="mb-1 block text-xs text-muted">{t("updateFormTitle")}</label>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-theme focus:outline-none focus:ring-2 focus:ring-primary"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted">{t("updateFormBody")}</label>
          <textarea
            value={form.body}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            rows={4}
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-theme focus:outline-none focus:ring-2 focus:ring-primary"
            required
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted">{t("updateFormCategory")}</label>
            <select
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              className="rounded border border-border bg-background px-3 py-2 text-sm text-theme"
            >
              <option value="FEATURE">{t("updateCategoryFeature")}</option>
              <option value="FIX">{t("updateCategoryFix")}</option>
              <option value="ANNOUNCEMENT">{t("updateCategoryAnnouncement")}</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {editingId ? t("updateFormSaveEdit") : t("updateFormSave")}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-surface-hover"
            >
              {t("updateFormCancel")}
            </button>
          )}
        </div>
      </form>

      {/* Existing updates */}
      {fetching ? (
        <p className="py-3 text-center text-sm text-muted">…</p>
      ) : updates.length === 0 ? (
        <p className="py-3 text-center text-sm text-muted">{t("updatesEmpty")}</p>
      ) : (
        <div className="space-y-2">
          {updates.map((u) => (
            <div key={u.id} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_STYLES[u.category] || CATEGORY_STYLES.ANNOUNCEMENT}`}>
                    {categoryLabel(t, u.category)}
                  </span>
                  <span className="text-xs text-muted">{new Date(u.createdAt).toLocaleDateString()}</span>
                </div>
                <div className="text-sm font-medium text-theme">{u.title}</div>
                <p className="mt-1 whitespace-pre-line text-sm text-muted">{u.body}</p>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <button
                  onClick={() => startEdit(u)}
                  className="rounded-md border border-border px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                >
                  {t("updateEditButton")}
                </button>
                <button
                  onClick={() => setDeleteTarget(u)}
                  className="rounded-md border border-red-500/30 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10"
                >
                  {t("delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={t("updateDeleteTitle")}
          message={`${t("updateDeleteConfirm")} "${deleteTarget.title}"?`}
          confirmLabel={t("delete")}
          cancelLabel={t("updateFormCancel")}
          danger
          onConfirm={() => {
            handleDelete(deleteTarget.id);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
