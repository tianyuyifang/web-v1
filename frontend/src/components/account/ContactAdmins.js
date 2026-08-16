"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

/**
 * How to reach an admin, shown wherever a user is asked to get in touch —
 * the pricing page, the login page, and the add-on notice. Kept in one place
 * so the details are edited once, in zh.js.
 *
 * The icons are the real app icons, pulled from each APK on the emulator, so
 * a user recognises which app to open before reading anything. They are
 * decorative: the row still says 微信 / Qni in text, so alt is empty and a
 * screen reader is not made to announce them twice.
 */
export default function ContactAdmins() {
  const { t } = useLanguage();
  return (
    <div className="mt-2 space-y-1.5 text-sm text-theme">
      {/* w-20 on both labels so the handles line up in one column — 微信 and
          Qni are different widths and left the values ragged. */}
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
      <div className="flex gap-2">
        <span className="flex w-20 shrink-0 items-center gap-1.5 font-medium">
          <img src="/icon-qni.svg" alt="" className="h-4 w-4 rounded-[4px]" />
          Qni：
        </span>
        <span className="font-medium">{t("contactQni")}</span>
      </div>
    </div>
  );
}
