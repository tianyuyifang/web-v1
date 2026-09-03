"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

const GUIDE_URL = "https://323c0378a152499fad09a48ccb2dbdda.app.workbuddy.link/";

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
        {/* No heading of its own: the page names this section above the card,
            the way it names 反馈. Kept here it made two headings for one thing
            and left the other section looking unlabelled by comparison. */}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">{t("helpInstructionCardDesc")}</p>
        </div>
        <span className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors group-hover:bg-primary-hover">
          {t("helpInstructionCardButton")}
        </span>
      </div>
    </a>
  );
}
