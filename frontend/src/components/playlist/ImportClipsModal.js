"use client";

import { useState, useRef, useEffect } from "react";
import { playlistsAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import ImportReport from "@/components/playlist/ImportReport";

const POLL_MS = 1500;

export default function ImportClipsModal({ playlistId, onClose, onImported }) {
  const { t } = useLanguage();
  const fileInputRef = useRef(null);
  const pollRef = useRef(null);
  const [qqId, setQqId] = useState("");
  const [neteaseId, setNeteaseId] = useState("");
  const [kugouId, setKugouId] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(null); // { state, processed, total, added, skipped }
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState("");

  // Stop polling if the modal unmounts (the job keeps running server-side).
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  // Start an import: POST returns { jobId }, then poll the job for progress.
  const doImport = async (startFn) => {
    stopPolling();
    setImporting(true);
    setImportError("");
    setImportResult(null);
    setProgress(null);
    try {
      const res = await startFn();
      const { jobId } = res.data;
      pollRef.current = setInterval(async () => {
        try {
          const s = await playlistsAPI.getImportJob(playlistId, jobId);
          const j = s.data;
          setProgress({ state: j.state, ...j.progress });
          if (j.state === "done") {
            stopPolling();
            setImporting(false);
            setProgress(null);
            setImportResult(j.result);
            onImported?.(j.result);
          } else if (j.state === "error") {
            stopPolling();
            setImporting(false);
            setProgress(null);
            setImportError(j.error || t("importFailed"));
          }
        } catch (err) {
          if (err.response?.status === 404) {
            // Job vanished (e.g. backend restarted). Import is idempotent — re-run finishes it.
            stopPolling();
            setImporting(false);
            setProgress(null);
            setImportError(t("importInterrupted"));
          }
          // other transient errors: keep polling
        }
      }, POLL_MS);
    } catch (err) {
      setImporting(false);
      if (err.response?.status === 409) {
        setImportError(t("importAlreadyRunning"));
      } else {
        setImportError(err.response?.data?.error?.message || t("importFailed"));
      }
    }
  };

  const handleImportByQQ = () => {
    if (!qqId.trim()) return;
    doImport(() => playlistsAPI.importClipsByQQ(playlistId, qqId.trim()));
  };

  const handleImportByNetease = () => {
    if (!neteaseId.trim()) return;
    doImport(() => playlistsAPI.importClipsByNetease(playlistId, neteaseId.trim()));
  };

  const handleImportByKugou = () => {
    if (!kugouId.trim()) return;
    doImport(() => playlistsAPI.importClipsByKugou(playlistId, kugouId.trim()));
  };

  const handleImportByFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    doImport(() => playlistsAPI.importClipsByFile(playlistId, file));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const clearResult = () => {
    setImportResult(null);
    setImportError("");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-border p-6 shadow-lg" style={{ backgroundColor: "var(--surface)" }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-theme">{t("importClips")}</h2>
          <button onClick={onClose} className="text-muted hover:text-theme">
            ✕
          </button>
        </div>

        {importResult ? (
          <ImportReport result={importResult} onBack={clearResult} />
        ) : (
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

            {importError && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {importError}
              </div>
            )}

            {importing && (
              <div className="py-4 text-center text-sm text-muted">
                {progress?.state === "importing" && progress.total
                  ? t("importProgress")
                      .replace("{n}", progress.processed)
                      .replace("{total}", progress.total)
                  : t("importFetching")}
                {progress?.state === "importing" && progress.total > 0 && (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-border">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${Math.round((progress.processed / progress.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
