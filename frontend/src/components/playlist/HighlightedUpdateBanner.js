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

export default function HighlightedUpdateBanner() {
  const { t } = useLanguage();
  const [update, setUpdate] = useState(null);

  useEffect(() => {
    let active = true;
    updatesAPI
      .getHighlighted()
      .then((res) => {
        if (active) setUpdate(res.data.update || null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!update) return null;

  return (
    <div className="mb-6 flex items-start gap-4 rounded-2xl bg-gradient-to-br from-primary to-primary-hover p-5 shadow-lg shadow-primary/30 ring-1 ring-white/10">
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
    </div>
  );
}
