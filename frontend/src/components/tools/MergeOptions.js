"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

export const DEFAULT_MERGE_OPTIONS = {
  speed: "B",
  pitch: "A",
  comment: "A",
  colorTag: "combine",
  sectionLabel: "B",
  clipCut: "A",
  order: "B",
};

// field key -> whether it supports "combine"
const FIELDS = [
  { key: "speed", combine: false },
  { key: "pitch", combine: false },
  { key: "comment", combine: true },
  { key: "colorTag", combine: true },
  { key: "sectionLabel", combine: false },
  { key: "clipCut", combine: false },
  { key: "order", combine: false },
];

export default function MergeOptions({ value, onChange, aName, bName }) {
  const { t } = useLanguage();
  const opts = { ...DEFAULT_MERGE_OPTIONS, ...(value || {}) };

  const set = (key, v) => onChange({ ...opts, [key]: v });

  const aLabel = `A${aName ? ` (${aName})` : ""}`;
  const bLabel = `B${bName ? ` (${bName})` : ""}`;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-3">
      <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>
        {t("mergeOptionsTitle")}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FIELDS.map(({ key, combine }) => (
          <label key={key} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted">{t(`mergeOpt_${key}`)}</span>
            <select
              value={opts[key]}
              onChange={(e) => set(key, e.target.value)}
              className="rounded border border-border bg-surface px-2 py-1 text-sm"
              style={{ color: "var(--text)" }}
            >
              <option value="A">{aLabel}</option>
              <option value="B">{bLabel}</option>
              {combine && <option value="combine">{t("mergeOpt_combine")}</option>}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}
