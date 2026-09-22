"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

/**
 * How to reach an admin, shown wherever a user is asked to get in touch —
 * the pricing page, the login page, and the add-on notice. Kept in one place
 * so the details are edited once, in zh.js.
 *
 * WeChat only since 2026-09: the Qni channel was retired site-wide. The icon
 * is the real app icon (pulled from the APK) and is decorative — the row says
 * 微信 in text, so alt stays empty.
 */
export default function ContactAdmins() {
  const { t } = useLanguage();
  return (
    <div className="mt-2 space-y-1.5 text-sm text-theme">
      <div className="flex gap-2">
        <span className="flex w-20 shrink-0 items-center gap-1.5 font-medium">
          <img src="/icon-wechat.png" alt="" className="h-4 w-4 rounded-[4px]" />
          {t("contactWechatLabel")}：
        </span>
        {/* The two handles stack under one label rather than repeating it. */}
        <span className="flex flex-col font-medium">
          <span>{t("contactWechat1")}</span>
          <span>{t("contactWechat2")}</span>
        </span>
      </div>
    </div>
  );
}
