"use client";

import { useEffect, useState } from "react";
import { RATE_LIMITED_EVENT } from "@/lib/rateNotice";
import { useLanguage } from "@/components/layout/LanguageProvider";

const SHOW_MS = 6000;

/** One line at the bottom of the screen while requests are being refused. */
export default function RateLimitNotice() {
  const { t } = useLanguage();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let timer = null;
    const onLimited = () => {
      setShown(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShown(false), SHOW_MS);
    };
    window.addEventListener(RATE_LIMITED_EVENT, onLimited);
    return () => {
      window.removeEventListener(RATE_LIMITED_EVENT, onLimited);
      clearTimeout(timer);
    };
  }, []);

  if (!shown) return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed bottom-4 left-1/2 z-[80] -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-surface px-4 py-2 text-sm shadow-lg"
    >
      {t("rateLimited")}
    </div>
  );
}
