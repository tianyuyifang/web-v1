"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

export default function AuthNotice() {
  const { t } = useLanguage();

  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3 text-xs text-muted">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-theme">
        <span aria-hidden="true">📢</span>
        {t("authNoticeTitle")}
      </p>
      <div className="space-y-2 leading-relaxed">
        <p>{t("authNoticeIntro")}</p>
        <p>{t("authNoticeFee")}</p>
        <p>{t("authNoticePrivacy")}</p>
        <p>{t("authNoticeDisclaimer")}</p>
        <p>{t("authNoticeOutro")}</p>
      </div>
    </div>
  );
}
