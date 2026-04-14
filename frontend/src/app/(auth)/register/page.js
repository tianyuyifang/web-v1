"use client";

import RegisterForm from "@/components/auth/RegisterForm";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { useTheme } from "@/components/layout/ThemeProvider";

export default function RegisterPage() {
  const { t } = useLanguage();
  const { theme } = useTheme();

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <img
            src={theme === "dark" ? "/brand_icon_dark.png" : "/brand_icon_light.png"}
            alt="logo"
            className="mb-4 h-14 w-14 rounded-2xl object-cover"
          />
          <img src="/qni_yixia.png" alt="Q你一下" className="h-7 object-contain" />
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-lg shadow-black/5">
          <RegisterForm />
        </div>
      </div>
    </div>
  );
}
