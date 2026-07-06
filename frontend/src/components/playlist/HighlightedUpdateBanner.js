"use client";

import { useState, useEffect } from "react";
import { updatesAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";

const CATEGORY_STYLES = {
  FEATURE: "bg-green-500/15 text-green-400",
  FIX: "bg-blue-500/15 text-blue-400",
  ANNOUNCEMENT: "bg-yellow-500/15 text-yellow-400",
  SONG_UPDATE: "bg-purple-500/15 text-purple-400",
};

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
    <div className="mb-6 rounded-xl border border-primary/40 bg-primary/5 p-5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-primary">★</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${CATEGORY_STYLES[update.category] || CATEGORY_STYLES.ANNOUNCEMENT}`}>
          {categoryLabel(t, update.category)}
        </span>
        <span className="text-xs text-muted">{new Date(update.createdAt).toLocaleDateString()}</span>
      </div>
      <h2 className="mb-1 text-base font-semibold text-theme">{update.title}</h2>
      <div className="whitespace-pre-line text-sm text-muted">
        <RichText text={update.body} />
      </div>
    </div>
  );
}
