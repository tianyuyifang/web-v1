"use client";

import { useState } from "react";
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
  const [open, setOpen] = useState(false);

  const Section = ({ labelKey, bodyKey }) => (
    <p>
      <span className="font-semibold text-primary">{t(labelKey)}</span>
      {highlightQuoted(t(bodyKey))}
    </p>
  );

  return (
    <div className="relative">
      <div className={`rounded-xl border border-border bg-surface text-xs text-muted ${open ? "rounded-b-none" : ""}`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        >
          <span className="flex items-center gap-1.5 text-sm font-semibold text-theme">
            <span aria-hidden="true">📢</span>
            {t("authNoticeTitle")}
          </span>
          <span aria-hidden="true" className="text-xs text-muted">
            {open ? "▲" : "▼"}
          </span>
        </button>
      </div>
      {open && (
        <div className="absolute left-0 right-0 top-full z-10 max-h-72 overflow-y-auto rounded-b-xl border border-t-0 border-border bg-surface px-4 py-3 text-xs leading-relaxed text-muted shadow-lg shadow-black/10">
          <div className="space-y-2">
            <p>{highlightQuoted(t("authNoticeIntro"))}</p>
            <Section labelKey="authNoticeReviewLabel" bodyKey="authNoticeReviewBody" />
            <Section labelKey="authNoticePlaylistLabel" bodyKey="authNoticePlaylistBody" />
            <Section labelKey="authNoticePrivacyLabel" bodyKey="authNoticePrivacyBody" />
            <Section labelKey="authNoticeFeeLabel" bodyKey="authNoticeFeeBody" />
            <Section labelKey="authNoticeDisclaimerLabel" bodyKey="authNoticeDisclaimerBody" />
            <p>{t("authNoticeOutro")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
