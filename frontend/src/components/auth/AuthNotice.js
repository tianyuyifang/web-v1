"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

// Render a string with 「...」 segments highlighted in brand color.
function highlightQuoted(text) {
  const parts = [];
  const regex = /「([^」]*)」/g;
  let lastIndex = 0;
  let match;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={i++} className="font-medium text-primary">
        「{match[1]}」
      </span>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length === 0 ? text : parts;
}

export default function AuthNotice() {
  const { t } = useLanguage();

  const Section = ({ labelKey, bodyKey }) => (
    <p>
      <span className="font-semibold text-primary">{t(labelKey)}</span>
      {highlightQuoted(t(bodyKey))}
    </p>
  );

  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-4 text-sm text-muted">
      <p className="mb-3 flex items-center gap-2 text-base font-semibold text-theme">
        <span aria-hidden="true">📢</span>
        {t("authNoticeTitle")}
      </p>
      <div className="space-y-2.5 leading-relaxed">
        <p>{highlightQuoted(t("authNoticeIntro"))}</p>
        <Section labelKey="authNoticeReviewLabel" bodyKey="authNoticeReviewBody" />
        <Section labelKey="authNoticePlaylistLabel" bodyKey="authNoticePlaylistBody" />
        <Section labelKey="authNoticePrivacyLabel" bodyKey="authNoticePrivacyBody" />
        <Section labelKey="authNoticeFeeLabel" bodyKey="authNoticeFeeBody" />
        <Section labelKey="authNoticeDisclaimerLabel" bodyKey="authNoticeDisclaimerBody" />
        <p>{t("authNoticeOutro")}</p>
      </div>
    </div>
  );
}
