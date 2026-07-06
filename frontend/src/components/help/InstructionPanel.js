"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

const GUIDE_URL = "https://my.feishu.cn/wiki/Z4e8wHIPLi4aIOkwcyucRb0wnMd?from=from_copylink";

export default function InstructionPanel() {
  const { t } = useLanguage();

  return (
    <a
      href={GUIDE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="group block overflow-hidden rounded-2xl border border-border bg-surface transition-colors hover:border-primary"
    >
      <div className="relative flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center">
        {/* Icon badge */}
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-2xl">
          📖
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-theme">{t("helpInstructionCardTitle")}</h2>
          <p className="mt-1 text-sm text-muted">{t("helpInstructionCardDesc")}</p>
        </div>
        <span className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors group-hover:bg-primary-hover">
          {t("helpInstructionCardButton")}
        </span>
      </div>
    </a>
  );
}
