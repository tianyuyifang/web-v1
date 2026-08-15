"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

/**
 * The two admin contacts, shown wherever a user is asked to get in touch —
 * the account page's upgrade prompt and the disabled-account page. Kept in
 * one place so the details are edited once, in the translation files.
 */
export default function ContactAdmins() {
  const { t } = useLanguage();
  return (
    <div className="mt-2 space-y-1">
      <p className="text-sm font-medium text-theme">{t("contactAdmin1")}</p>
      <p className="text-sm font-medium text-theme">{t("contactAdmin2")}</p>
    </div>
  );
}
