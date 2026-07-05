"use client";

import { useState } from "react";
import useAuth from "@/hooks/useAuth";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ExpiredBanner() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || user?.status !== "expired") return null;

  return (
    <div className="flex items-center justify-between gap-3 bg-red-500/15 px-4 py-2 text-sm text-red-400">
      <span>{t("expiredBanner")}</span>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded px-2 py-0.5 text-xs hover:bg-red-500/20"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
