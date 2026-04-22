"use client";

import { useState, useRef } from "react";
import { playlistsAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ImportClipsModal({ playlistId, onClose, onImported }) {
  const { t } = useLanguage();
  const fileInputRef = useRef(null);
  const [qqId, setQqId] = useState("");
  const [neteaseId, setNeteaseId] = useState("");
  const [kugouId, setKugouId] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState("");

  const handleImportByQQ = async () => {
    if (!qqId.trim()) return;
    setImporting(true);
    setImportError("");
    setImportResult(null);
    try {
      const res = await playlistsAPI.importClipsByQQ(playlistId, qqId.trim());
      setImportResult(res.data);
      onImported?.(res.data);
    } catch (err) {
      setImportError(err.response?.data?.error?.message || t("importFailed"));
    } finally {
      setImporting(false);
    }
  };

  const handleImportByNetease = async () => {
    if (!neteaseId.trim()) return;
    setImporting(true);
    setImportError("");
    setImportResult(null);
    try {
      const res = await playlistsAPI.importClipsByNetease(playlistId, neteaseId.trim());
      setImportResult(res.data);
      onImported?.(res.data);
    } catch (err) {
      setImportError(err.response?.data?.error?.message || t("importFailed"));
    } finally {
      setImporting(false);
    }
  };

  const handleImportByKugou = async () => {
    if (!kugouId.trim()) return;
    setImporting(true);
    setImportError("");
    setImportResult(null);
    try {
      const res = await playlistsAPI.importClipsByKugou(playlistId, kugouId.trim());
      setImportResult(res.data);
      onImported?.(res.data);
    } catch (err) {
      setImportError(err.response?.data?.error?.message || t("importFailed"));
    } finally {
      setImporting(false);
    }
  };

  const handleImportByFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportError("");
    setImportResult(null);
    try {
      const res = await playlistsAPI.importClipsByFile(playlistId, file);
      setImportResult(res.data);
      onImported?.(res.data);
    } catch (err) {
      setImportError(err.response?.data?.error?.message || t("importFailed"));
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-xl border border-border p-6 shadow-lg" style={{ backgroundColor: "var(--surface)" }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-theme">{t("importClips")}</h2>
          <button onClick={onClose} className="text-muted hover:text-theme">
            ✕
          </button>
        </div>

        <div className="space-y-6">
          {/* Import from QQ Music */}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-theme">{t("importByQQ")}</h3>
            <p className="mb-2 text-xs text-muted">{t("importByQQDesc")}</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={qqId}
                onChange={(e) => setQqId(e.target.value)}
                placeholder={t("qqPlaylistIdPlaceholder")}
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
              />
              <button
                onClick={handleImportByQQ}
                disabled={importing || !qqId.trim()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {importing ? t("importingClips") : t("importButton")}
              </button>
            </div>
          </div>

          {/* Import from NetEase Cloud Music */}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-theme">{t("importByNetease")}</h3>
            <p className="mb-2 text-xs text-muted">{t("importByNeteaseDesc")}</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={neteaseId}
                onChange={(e) => setNeteaseId(e.target.value)}
                placeholder={t("neteasePlaylistIdPlaceholder")}
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
              />
              <button
                onClick={handleImportByNetease}
                disabled={importing || !neteaseId.trim()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {importing ? t("importingClips") : t("importButton")}
              </button>
            </div>
          </div>

          {/* Import from KuGou */}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-theme">{t("importByKugou")}</h3>
            <p className="mb-2 text-xs text-muted">{t("importByKugouDesc")}</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={kugouId}
                onChange={(e) => setKugouId(e.target.value)}
                placeholder={t("kugouPlaylistIdPlaceholder")}
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
              />
              <button
                onClick={handleImportByKugou}
                disabled={importing || !kugouId.trim()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {importing ? t("importingClips") : t("importButton")}
              </button>
            </div>
          </div>

          {/* Import by xlsx file */}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-theme">{t("importByFile")}</h3>
            <p className="mb-2 text-xs text-muted">
              XLSX: title + artist
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleImportByFile}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-theme hover:bg-surface-hover disabled:opacity-50"
            >
              {importing ? t("importingClips") : t("uploadXlsx")}
            </button>
          </div>

          {/* Import result */}
          {importResult && (
            <div className="rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-3 text-sm">
              <p className="text-green-400">
                {t("importSuccess")
                  .replace("{added}", importResult.added)
                  .replace("{skipped}", importResult.skipped)}
              </p>
              {importResult.notFound?.length > 0 && (
                <div className="mt-2 max-h-40 overflow-y-auto">
                  <p className="text-xs text-muted">{t("importNotFound")} ({importResult.notFound.length})</p>
                  {importResult.notFound.map((s, i) => (
                    <p key={i} className="text-xs text-muted">  {s}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {importError && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {importError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
