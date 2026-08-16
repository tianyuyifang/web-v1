"use client";

import { useSearchParams } from "next/navigation";
import LoginForm from "@/components/auth/LoginForm";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { useTheme } from "@/components/layout/ThemeProvider";

export default function LoginPage() {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const searchParams = useSearchParams();
  const reason = searchParams.get("reason");

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <img
            src={theme === "dark" ? "/brand_icon_dark.png" : "/brand_icon_light.png"}
            alt="logo"
            className="mb-4 h-14 w-14 rounded-2xl object-cover"
          />
          <img src={theme === "dark" ? "/qni_yixia_dark.png" : "/qni_yixia_light.png"} alt="Q你一下" className="h-7 object-contain" />
        </div>

        {reason === "session_replaced" && (
          <div className="mb-4 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-center text-sm text-theme">
            {t("sessionReplacedMessage")}
          </div>
        )}

        <div className="rounded-xl border border-border bg-surface p-6 shadow-lg shadow-black/5">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
