"use client";

import { useEffect, useState } from "react";
import { feedbackAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";

/**
 * What became of the feedback you sent.
 *
 * Shown above the form, in the place the feedback was written: a reply is only
 * worth writing if it is read, and the page someone already associates with
 * feedback is where they will look for an answer to it.
 *
 * Nothing renders for someone who has never sent any — an empty panel headed
 * 我的反馈 would be a permanent reminder of a feature they have not used.
 */
export default function MyFeedback({ onSeen }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let alive = true;
    feedbackAPI
      .mine()
      .then((res) => {
        if (!alive) return;
        const list = res.data?.feedback || [];
        setRows(list);
        // Tell the parent the newest reply has now been seen, so the nav dot
        // can clear. Passed up rather than written here: the dot belongs to the
        // whole site, and two places writing the same key would drift.
        onSeen?.(list);
      })
      .catch(() => {
        // The form below still works; a failed history is not worth an error.
      });
    return () => { alive = false; };
  }, [onSeen]);

  if (rows.length === 0) return null;

  return (
    <div className="mb-6">
      <h3 className="mb-2 text-sm font-medium text-muted">{t("myFeedback")}</h3>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {rows.map((f) => (
          <li key={f.id} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm text-theme">
                {f.title
                  ? `${f.title}${f.artist ? ` - ${f.artist}` : ""}`
                  : f.message}
              </span>
              <span className="shrink-0 text-xs text-muted">
                {new Date(f.createdAt).toLocaleDateString()}
              </span>
            </div>
            {f.reply ? (
              <p className="mt-1 text-sm text-green-400">✅ {f.reply}</p>
            ) : (
              // Said rather than left blank: an item with nothing under it
              // reads as a submission that failed to send.
              <p className="mt-1 text-xs text-muted">{t("feedbackPending")}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
