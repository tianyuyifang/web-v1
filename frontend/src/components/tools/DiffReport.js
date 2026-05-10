"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

function formatValue(v) {
  if (v === null || v === undefined || v === "") return "(empty)";
  return String(v);
}

function MetadataLine({ speed, colorTag, comment, sectionLabel }) {
  return (
    <div className="text-xs text-muted">
      speed {speed}
      {colorTag ? ` · tag ${colorTag}` : ""}
      {comment ? ` · 💬` : ""}
      {sectionLabel ? ` · §${sectionLabel}` : ""}
    </div>
  );
}

function Section({ titleKey, emptyKey, count, children }) {
  const { t } = useLanguage();
  return (
    <section className="mb-6 rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-3 text-base font-semibold" style={{ color: "var(--text)" }}>
        {t(titleKey)} <span className="text-muted">({count})</span>
      </h2>
      {count === 0 ? (
        <div className="text-sm text-muted">{t(emptyKey)}</div>
      ) : (
        <div className="space-y-2">{children}</div>
      )}
    </section>
  );
}

export default function DiffReport({ report }) {
  const { t } = useLanguage();

  const summary = t("diffSummary")
    .replace("{n}", report.newInB.length)
    .replace("{m}", report.modifiedInB.length)
    .replace("{k}", report.removedFromB.length);

  const fieldLabel = {
    speed: "speed",
    colorTag: "tag",
    comment: "comment",
    sectionLabel: "section",
  };

  return (
    <div>
      <p className="mb-4 text-sm text-muted">{summary}</p>

      <Section titleKey="diffNewInB" emptyKey="diffNoNew" count={report.newInB.length}>
        {report.newInB.map((row) => (
          <div key={row.clipId} className="rounded-md bg-background p-2">
            <div className="text-sm font-medium" style={{ color: "var(--text)" }}>
              {row.song.title} — <span className="text-muted">{row.song.artist}</span>
            </div>
            <MetadataLine
              speed={row.speed}
              colorTag={row.colorTag}
              comment={row.comment}
              sectionLabel={row.sectionLabel}
            />
          </div>
        ))}
      </Section>

      <Section titleKey="diffModifiedInB" emptyKey="diffNoModified" count={report.modifiedInB.length}>
        {report.modifiedInB.map((row) => (
          <div key={row.clipId} className="rounded-md bg-background p-2">
            <div className="text-sm font-medium" style={{ color: "var(--text)" }}>
              {row.song.title} — <span className="text-muted">{row.song.artist}</span>
            </div>
            <ul className="mt-1 space-y-0.5 text-xs">
              {row.diffs.map((field) => (
                <li key={field} className="text-muted">
                  <span className="font-medium" style={{ color: "var(--text)" }}>
                    {fieldLabel[field] || field}:
                  </span>{" "}
                  {formatValue(row.a[field])} → {formatValue(row.b[field])}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Section>

      <Section titleKey="diffRemovedFromB" emptyKey="diffNoRemoved" count={report.removedFromB.length}>
        {report.removedFromB.map((row) => (
          <div key={row.clipId} className="rounded-md bg-background p-2">
            <div className="text-sm font-medium" style={{ color: "var(--text)" }}>
              {row.song.title} — <span className="text-muted">{row.song.artist}</span>
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}
