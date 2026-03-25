"use client";

import LoginForm from "@/components/auth/LoginForm";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function LoginPage() {
  const { t } = useLanguage();

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-lg font-bold text-white">
            M
          </div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--text)" }}>{t("loginTitle")}</h1>
          <p className="mt-1 text-sm text-muted">{t("loginSubtitle")}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-lg shadow-black/5">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
