"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

/**
 * How to reach an admin, shown wherever a user is asked to get in touch —
 * the pricing page, the account page's upgrade prompt, and the add-on
 * notice. Kept in one place so the details are edited once, in zh.js.
 */
export default function ContactAdmins() {
  const { t } = useLanguage();
  return (
    <div className="mt-2 space-y-1 text-sm text-theme">
      <div className="flex gap-2">
        <span className="shrink-0 font-medium">{t("contactWechatLabel")}：</span>
        {/* The two handles stack under one label rather than repeating it. */}
        <span className="flex flex-col font-medium">
          <span>{t("contactWechat1")}</span>
          <span>{t("contactWechat2")}</span>
        </span>
      </div>
      <p className="font-medium">{t("contactQni")}</p>
    </div>
  );
}
