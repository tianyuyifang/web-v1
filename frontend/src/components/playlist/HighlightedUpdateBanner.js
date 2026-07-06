"use client";

import { useState, useEffect } from "react";
import { updatesAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";

function categoryLabel(t, category) {
  if (category === "FEATURE") return t("updateCategoryFeature");
  if (category === "FIX") return t("updateCategoryFix");
  if (category === "SONG_UPDATE") return t("updateCategorySongUpdate");
  return t("updateCategoryAnnouncement");
}

const DISMISS_KEY = "highlightedUpdateDismiss";
const DISMISS_TTL_MS = 60 * 60 * 1000; // reappears after 1 hour

// Returns true if this update id was dismissed less than an hour ago.
function isDismissed(updateId) {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const { id, at } = JSON.parse(raw);
    return id === updateId && Date.now() - at < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

export default function HighlightedUpdateBanner() {
  const { t } = useLanguage();
  const [update, setUpdate] = useState(null);

  useEffect(() => {
    let active = true;
    updatesAPI
      .getHighlighted()
      .then((res) => {
        if (!active) return;
        const u = res.data.update || null;
        // Hide only if THIS update was dismissed within the last hour.
        // A different (newly-highlighted) update always shows.
        setUpdate(u && !isDismissed(u.id) ? u : null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify({ id: update.id, at: Date.now() }));
    } catch {
      // ignore storage errors — just hide for this view
    }
    setUpdate(null);
  }

  if (!update) return null;

  return (
    <div className="relative mb-6 flex items-start gap-4 rounded-2xl bg-gradient-to-br from-primary to-primary-hover p-5 pr-10 shadow-lg shadow-primary/30 ring-1 ring-white/10">
      {/* Announcement icon */}
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/20 text-xl">
        📢
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-white/25 px-2.5 py-0.5 text-xs font-semibold text-white">
            {categoryLabel(t, update.category)}
          </span>
          <span className="text-xs text-white/70">{new Date(update.createdAt).toLocaleDateString()}</span>
        </div>
        <h2 className="mb-1 text-lg font-bold text-white">{update.title}</h2>
        <div className="whitespace-pre-line text-sm text-white/90">
          <RichText text={update.body} />
        </div>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute right-2.5 top-2.5 flex h-6 w-6 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/20 hover:text-white"
      >
        ✕
      </button>
    </div>
  );
}
