"use client";

import { useState, useEffect } from "react";
import { playlistsAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ComparePlaylistModal({ playlistId, onClose }) {
  const { t } = useLanguage();
  const [source, setSource] = useState(null); // "qq" | "netease" | "internal"
  const [inputId, setInputId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState(null);

  // Internal playlist search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (source !== "internal" || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await playlistsAPI.list({ q: searchQuery.trim() });
        const data = Array.isArray(res.data) ? res.data : res.data.playlists || [];
        // Exclude the current playlist
        setSearchResults(data.filter((p) => p.id !== playlistId));
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, source, playlistId]);

  const handleCompare = async (targetId) => {
    const trimmed = targetId || inputId.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    setReport(null);
    try {
      let res;
      if (source === "qq") {
        res = await playlistsAPI.compareWithQQ(playlistId, trimmed);
      } else if (source === "netease") {
        res = await playlistsAPI.compareWithNetease(playlistId, trimmed);
      } else {
        res = await playlistsAPI.compareWithInternal(playlistId, trimmed);
      }
      setReport(res.data);
    } catch (err) {
      setError(err.response?.data?.error?.message || t("compareFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    setSource(null);
    setInputId("");
    setSearchQuery("");
    setSearchResults([]);
    setError("");
    setReport(null);
  };

  const artistDisplay = (artist) =>
    artist ? artist.replace(/_/g, " / ") : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative mx-4 flex max-h-[80vh] w-full max-w-xl flex-col rounded-xl border border-border bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-bold text-theme">
            {report ? t("compareReport") : t("comparePlaylist")}
          </h2>
          <button
            onClick={onClose}
            className="text-xl text-muted transition-colors hover:text-theme"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!source && !report && (
            <div className="space-y-3">
              <p className="text-sm text-muted">{t("compareDesc")}</p>
              <button
                onClick={() => setSource("qq")}
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-left transition-colors hover:border-primary"
              >
                <div className="font-medium text-theme">{t("compareQQ")}</div>
                <div className="mt-0.5 text-xs text-muted">{t("compareQQDesc")}</div>
              </button>
              <button
                onClick={() => setSource("netease")}
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-left transition-colors hover:border-primary"
              >
                <div className="font-medium text-theme">{t("compareNetease")}</div>
                <div className="mt-0.5 text-xs text-muted">{t("compareNeteaseDesc")}</div>
              </button>
              <button
                onClick={() => setSource("internal")}
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-left transition-colors hover:border-primary"
              >
                <div className="font-medium text-theme">{t("compareInternal")}</div>
                <div className="mt-0.5 text-xs text-muted">{t("compareInternalDesc")}</div>
              </button>
            </div>
          )}

          {source && source !== "internal" && !report && (
            <div className="space-y-3">
              <button onClick={handleBack} className="text-sm text-primary hover:underline">
                {t("returnButton")}
              </button>
              <label className="block text-sm font-medium text-theme">
                {source === "qq" ? t("compareQQ") : t("compareNetease")}
              </label>
              <input
                type="text"
                value={inputId}
                onChange={(e) => setInputId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCompare()}
                placeholder={
                  source === "qq"
                    ? t("qqPlaylistIdPlaceholder")
                    : t("neteasePlaylistIdPlaceholder")
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
                autoFocus
              />
              {error && <p className="text-sm text-red-400">{error}</p>}
              <button
                onClick={() => handleCompare()}
                disabled={loading || !inputId.trim()}
                className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
              >
                {loading ? t("comparing") : t("compareButton")}
              </button>
            </div>
          )}

          {source === "internal" && !report && (
            <div className="space-y-3">
              <button onClick={handleBack} className="text-sm text-primary hover:underline">
                {t("returnButton")}
              </button>
              <label className="block text-sm font-medium text-theme">
                {t("compareInternal")}
              </label>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("searchPlaylistPlaceholder")}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
                autoFocus
              />
              {error && <p className="text-sm text-red-400">{error}</p>}
              {searching && <p className="text-xs text-muted">{t("searching")}</p>}
              {searchResults.length > 0 && (
                <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-background">
                  {searchResults.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleCompare(p.id)}
                      disabled={loading}
                      className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm transition-colors last:border-0 hover:bg-surface-hover disabled:opacity-50"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-theme">{p.name}</span>
                      <span className="shrink-0 text-xs text-muted">{p.clipCount} {t("clips")}</span>
                      {p.ownerName && <span className="shrink-0 text-xs text-primary">@{p.ownerName}</span>}
                    </button>
                  ))}
                </div>
              )}
              {searchQuery.trim() && !searching && searchResults.length === 0 && (
                <p className="text-xs text-muted">{t("noPlaylistsMatch")}</p>
              )}
              {loading && <p className="text-sm text-muted">{t("comparing")}</p>}
            </div>
          )}

          {report && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="rounded-lg border border-border bg-background px-4 py-3">
                <div className="text-sm text-muted">
                  {t("compareTarget")}: {report.externalTotal} {t("compareSongs")} &middot; {t("compareCurrent")}: {report.localTotal} {t("compareSongs")}
                </div>
                <div className="mt-2 flex gap-4 text-sm">
                  <span className="text-green-400">
                    {t("compareMatched")}: {report.titleMatch.length}
                  </span>
                  <span className="text-yellow-400">
                    {t("compareArtistMismatch")}: {report.artistMismatch.length}
                  </span>
                  <span className="text-red-400">
                    {t("compareMissing")}: {report.missing.length}
                  </span>
                  <span className="text-blue-400">
                    {t("compareLocalOnly")}: {report.localOnly.length}
                  </span>
                </div>
              </div>

              {/* Missing songs */}
              {report.missing.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-red-400">
                    {t("compareMissingTitle")} ({report.missing.length})
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
                        {report.missing.map((s, i) => (
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

              {/* Artist mismatch */}
              {report.artistMismatch.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-yellow-400">
                    {t("compareArtistMismatchTitle")} ({report.artistMismatch.length})
                  </h3>
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-background">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-background">
                        <tr className="border-b border-border text-left text-xs text-muted">
                          <th className="px-3 py-1.5 font-medium">#</th>
                          <th className="px-3 py-1.5 font-medium">{t("title")}</th>
                          <th className="px-3 py-1.5 font-medium">{t("compareTarget")}</th>
                          <th className="px-3 py-1.5 font-medium">{t("compareCurrent")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.artistMismatch.map((s, i) => (
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

              {/* Local only */}
              {report.localOnly.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-blue-400">
                    {t("compareLocalOnlyTitle")} ({report.localOnly.length})
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
                        {report.localOnly.map((s, i) => (
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

              {/* Compare again button */}
              <button
                onClick={handleBack}
                className="w-full rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-theme transition-colors hover:bg-surface-hover"
              >
                {t("compareAgain")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
