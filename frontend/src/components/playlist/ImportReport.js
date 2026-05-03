"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

function artistDisplay(a) {
  return a ? a.replace(/_/g, " / ") : "";
}

export default function ImportReport({ result, onBack }) {
  const { t } = useLanguage();
  const { added, skipped, notFound = [], titleConflict = [] } = result;

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
