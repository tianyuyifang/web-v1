"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

export default function AuthNotice() {
  const { t } = useLanguage();

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface px-4 py-3 text-xs text-muted">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-theme">
        <span aria-hidden="true">ℹ</span>
        {t("authNoticeTitle")}
      </p>
      <ul className="space-y-1 leading-relaxed">
        <li>· {t("authNoticeLine1")}</li>
        <li>· {t("authNoticeLine2")}</li>
        <li>· {t("authNoticeLine3")}</li>
        <li>· {t("authNoticeLine4")}</li>
      </ul>
    </div>
  );
}
