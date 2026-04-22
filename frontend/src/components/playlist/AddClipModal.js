"use client";

import { useState, useRef, useEffect } from "react";
import { playlistsAPI } from "@/lib/api";
import useSearch from "@/hooks/useSearch";
import ClipCreator from "@/components/library/ClipCreator";
import { formatDuration } from "@/lib/utils";
import { useLanguage } from "@/components/layout/LanguageProvider";

function artistDisplay(a) {
  return a ? a.replace(/_/g, " / ") : "";
}

export default function AddClipModal({ playlistId, onClose, onClipAdded, onBulkImported, onClipSelected, initialSong }) {
  const { t } = useLanguage();
  const showImportTab = !onClipSelected;
  const [tab, setTab] = useState("search"); // "search" | "import"
  const [clipSong, setClipSong] = useState(initialSong || null);

  // --- Search ---
  const { query, setQuery, results, isSearching } = useSearch({
    endpoint: "/songs",
    extraParams: { strict: 1 },
  });

  const handleSelectClip = async (clipId) => {
    if (onClipSelected) {
      onClipSelected(clipId);
      return;
    }
    try {
      const res = await playlistsAPI.addClip(playlistId, { clipId });
      onClipAdded(res.data);
    } catch {
      // silent
    }
  };

  const handleClipCreated = async (clip) => {
    setClipSong(null);
    await handleSelectClip(clip.id);
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center">
        <div className="max-h-[90vh] w-full overflow-y-auto rounded-t-xl border border-border bg-surface p-4 sm:max-w-2xl sm:rounded-xl sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold">{t("addClipToPlaylist")}</h2>
            <button onClick={onClose} className="text-muted hover:text-theme">
              ✕
            </button>
          </div>

          {/* Tab switcher */}
          {showImportTab && (
            <div className="mb-4 flex gap-1 rounded-lg border border-border bg-background p-1">
              <button
                onClick={() => setTab("search")}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  tab === "search"
                    ? "bg-primary text-white shadow-sm"
                    : "text-muted hover:text-theme"
                }`}
              >
                {t("searchSingle")}
              </button>
              <button
                onClick={() => setTab("import")}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  tab === "import"
                    ? "bg-primary text-white shadow-sm"
                    : "text-muted hover:text-theme"
                }`}
              >
                {t("importClips")}
              </button>
            </div>
          )}

          {tab === "search" && (
            <>
              {clipSong ? (
                <ClipCreator
                  song={clipSong}
                  onClose={() => setClipSong(null)}
                  onClipCreated={handleClipCreated}
                />
              ) : (
                <>
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("searchSongs")}
                    className="mb-4 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
                    autoFocus
                  />

                  <div className="max-h-80 overflow-y-auto">
                    {isSearching && (
                      <p className="py-4 text-center text-sm text-muted">
                        {t("searching")}
                      </p>
                    )}

                    {!isSearching && results.length === 0 && query && (
                      <p className="py-4 text-center text-sm text-muted">
                        {t("noSongsFound")}
                      </p>
                    )}

                    {results.map((song) => (
                      <div
                        key={song.id}
                        className="border-b border-border py-3 last:border-0"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-theme">
                              {song.title}
                            </p>
                            <p className="text-xs text-muted">
                              {song.artist.replace(/_/g, "/")} · {formatDuration(song.duration)}
                            </p>
                          </div>
                          {(!song.clips || song.clips.length === 0) && (
                            <button
                              onClick={() => setClipSong(song)}
                              className="rounded bg-primary px-2 py-1 text-xs text-white hover:bg-primary-hover"
                            >
                              {t("createClip")}
                            </button>
                          )}
                        </div>

                        {song.clips && song.clips.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {song.clips.map((clip) => (
                              <button
                                key={clip.id}
                                onClick={() => handleSelectClip(clip.id)}
                                className="rounded border border-border bg-background px-2 py-0.5 text-xs text-muted hover:border-primary hover:text-theme"
                              >
                                {formatDuration(clip.start)}
                              </button>
                            ))}
                            <button
                              onClick={() => setClipSong(song)}
                              className="rounded border border-border bg-background px-2 py-0.5 text-xs text-muted hover:border-primary hover:text-theme"
                            >
                              {t("newClipButton")}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {tab === "import" && showImportTab && (
            <ImportTab playlistId={playlistId} onImported={onBulkImported} />
          )}
        </div>
      </div>
    </>
  );
}

// ========================= Import Tab =========================

function ImportTab({ playlistId, onImported }) {
  const { t } = useLanguage();
  const fileInputRef = useRef(null);
  const [qqId, setQqId] = useState("");
  const [neteaseId, setNeteaseId] = useState("");
  const [kugouId, setKugouId] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState("");

  // Internal playlist search
  const [internalQuery, setInternalQuery] = useState("");
  const [internalResults, setInternalResults] = useState([]);
  const [internalSearching, setInternalSearching] = useState(false);
  const internalTimerRef = useRef(null);

  useEffect(() => {
    if (internalTimerRef.current) clearTimeout(internalTimerRef.current);
    if (!internalQuery.trim()) {
      setInternalResults([]);
      setInternalSearching(false);
      return;
    }
    setInternalSearching(true);
    internalTimerRef.current = setTimeout(async () => {
      try {
        const res = await playlistsAPI.list({ q: internalQuery });
        const data = res.data;
        const list = Array.isArray(data) ? data : data.playlists || [];
        setInternalResults(list.filter((p) => p.id !== playlistId));
      } catch {
        setInternalResults([]);
      } finally {
        setInternalSearching(false);
      }
    }, 300);
    return () => { if (internalTimerRef.current) clearTimeout(internalTimerRef.current); };
  }, [internalQuery, playlistId]);

  const doImport = async (fn) => {
    setImporting(true);
    setImportError("");
    setImportResult(null);
    try {
      const res = await fn();
      setImportResult(res.data);
      onImported?.();
    } catch (err) {
      setImportError(err.response?.data?.error?.message || t("importFailed"));
    } finally {
      setImporting(false);
    }
  };

  const handleQQ = () => {
    if (!qqId.trim()) return;
    doImport(() => playlistsAPI.importClipsByQQ(playlistId, qqId.trim()));
  };

  const handleNetease = () => {
    if (!neteaseId.trim()) return;
    doImport(() => playlistsAPI.importClipsByNetease(playlistId, neteaseId.trim()));
  };

  const handleKugou = () => {
    if (!kugouId.trim()) return;
    doImport(() => playlistsAPI.importClipsByKugou(playlistId, kugouId.trim()));
  };

  const handleInternal = (targetId) => {
    setInternalQuery("");
    setInternalResults([]);
    doImport(() => playlistsAPI.importClipsByInternal(playlistId, targetId));
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    doImport(() => playlistsAPI.importClipsByFile(playlistId, file));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const clearResult = () => {
    setImportResult(null);
    setImportError("");
  };

  // Show report if we have a result
  if (importResult) {
    return <ImportReport result={importResult} onBack={clearResult} />;
  }

  return (
    <div className="space-y-5">
      {/* QQ Music */}
      <div>
        <h3 className="mb-1 text-sm font-semibold text-theme">{t("importByQQ")}</h3>
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
            onClick={handleQQ}
            disabled={importing || !qqId.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {importing ? t("importingClips") : t("importButton")}
          </button>
        </div>
      </div>

      {/* NetEase */}
      <div>
        <h3 className="mb-1 text-sm font-semibold text-theme">{t("importByNetease")}</h3>
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
            onClick={handleNetease}
            disabled={importing || !neteaseId.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {importing ? t("importingClips") : t("importButton")}
          </button>
        </div>
      </div>

      {/* KuGou */}
      <div>
        <h3 className="mb-1 text-sm font-semibold text-theme">{t("importByKugou")}</h3>
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
            onClick={handleKugou}
            disabled={importing || !kugouId.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {importing ? t("importingClips") : t("importButton")}
          </button>
        </div>
      </div>

      {/* Internal playlist */}
      <div>
        <h3 className="mb-1 text-sm font-semibold text-theme">{t("importByInternal")}</h3>
        <p className="mb-2 text-xs text-muted">{t("importByInternalDesc")}</p>
        <div className="relative">
          <input
            type="text"
            value={internalQuery}
            onChange={(e) => setInternalQuery(e.target.value)}
            placeholder={t("searchPlaylists")}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
          />
          {internalSearching && (
            <p className="mt-1 text-xs text-muted">{t("searching")}</p>
          )}
          {internalQuery && internalResults.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
              {internalResults.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleInternal(p.id)}
                  disabled={importing}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-hover disabled:opacity-50"
                >
                  <span className="truncate text-theme">{p.name}</span>
                  <span className="ml-2 shrink-0 text-xs text-muted">
                    {p.clipCount} clips{p.ownerName ? ` · ${p.ownerName}` : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* File */}
      <div>
        <h3 className="mb-1 text-sm font-semibold text-theme">{t("importByFile")}</h3>
        <p className="mb-2 text-xs text-muted">XLSX: title + artist</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFile}
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

      {/* Error */}
      {importError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {importError}
        </div>
      )}

      {importing && (
        <div className="py-4 text-center text-sm text-muted">{t("importingClips")}</div>
      )}
    </div>
  );
}

// ========================= Import Report =========================

function ImportReport({ result, onBack }) {
  const { t } = useLanguage();
  const { added, skipped, notFound = [], titleConflict = [] } = result;

  // Parse notFound strings into { title, artist }
  const notFoundParsed = notFound.map((s) => {
    const idx = s.lastIndexOf(" - ");
    return idx > 0
      ? { title: s.slice(0, idx), artist: s.slice(idx + 3) }
      : { title: s, artist: "" };
  });

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="rounded-lg border border-border bg-background px-4 py-3">
        <div className="flex flex-wrap gap-4 text-sm">
          <span className="text-green-400">
            {t("importReportAdded")}: {added}
          </span>
          <span className="text-muted">
            {t("importReportSkipped")}: {skipped}
          </span>
          {titleConflict.length > 0 && (
            <span className="text-yellow-400">
              {t("importTitleConflict")}: {titleConflict.length}
            </span>
          )}
          {notFoundParsed.length > 0 && (
            <span className="text-red-400">
              {t("compareMissing")}: {notFoundParsed.length}
            </span>
          )}
        </div>
      </div>

      {/* Not found table */}
      {notFoundParsed.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-red-400">
            {t("compareMissingTitle")} ({notFoundParsed.length})
          </h3>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-background">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-3 py-1.5 font-medium">#</th>
                  <th className="px-3 py-1.5 font-medium">{t("title")}</th>
                  <th className="px-3 py-1.5 font-medium">{t("artist")}</th>
                </tr>
              </thead>
              <tbody>
                {notFoundParsed.map((s, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 text-muted">{i + 1}</td>
                    <td className="px-3 py-1.5 text-theme">{s.title}</td>
                    <td className="px-3 py-1.5 text-muted">{artistDisplay(s.artist)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Title conflict table */}
      {titleConflict.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-yellow-400">
            {t("importTitleConflict")} ({titleConflict.length})
          </h3>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-background">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-3 py-1.5 font-medium">#</th>
                  <th className="px-3 py-1.5 font-medium">{t("title")}</th>
                  <th className="px-3 py-1.5 font-medium">{t("importReportExtArtist")}</th>
                  <th className="px-3 py-1.5 font-medium">{t("importReportLocalArtist")}</th>
                </tr>
              </thead>
              <tbody>
                {titleConflict.map((s, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 text-muted">{i + 1}</td>
                    <td className="px-3 py-1.5 text-theme">{s.title}</td>
                    <td className="px-3 py-1.5 text-muted">{artistDisplay(s.externalArtist)}</td>
                    <td className="px-3 py-1.5 text-muted">{artistDisplay(s.localArtist)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Back button */}
      <button
        onClick={onBack}
        className="w-full rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-theme transition-colors hover:bg-surface-hover"
      >
        {t("importAgain")}
      </button>
    </div>
  );
}
