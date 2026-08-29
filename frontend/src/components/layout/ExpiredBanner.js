"use client";

import { useState } from "react";
import useAuth from "@/hooks/useAuth";
import { useLanguage } from "@/components/layout/LanguageProvider";

/**
 * Says when a subscription is about to lapse, and when it already has.
 *
 * The warning half exists because expiry arrived with no notice at all: there
 * is no email address on an account, nothing on screen counted down, and the
 * date was only visible to someone who went looking for it on the account
 * page. The first a singer knew of it was the red banner, by which point the
 * renewal was already late.
 *
 * Three days is short enough to still read as urgent and long enough to act on
 * over a weekend.
 *
 * Neither state restricts anything — nothing downgrades an expired account and
 * no route checks the date — so both are dismissible. This is a reminder, not
 * a gate.
 */

/** Warn this many days out. */
const WARN_DAYS = 3;

export default function ExpiredBanner() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !user) return null;

  const expired = user.status === "expired";

  // Rounded up, so the last partial day reads as "1 天" rather than "0 天".
  // Only meaningful when a date is set: an account without one never expires.
  const daysLeft = user.expiresAt
    ? Math.ceil((new Date(user.expiresAt).getTime() - Date.now()) / 86400000)
    : null;
  const expiringSoon = !expired && daysLeft !== null
    && daysLeft > 0 && daysLeft <= WARN_DAYS;

  if (!expired && !expiringSoon) return null;

  // Amber for a deadline ahead, red for one passed — that difference is what
  // makes the warning worth showing separately at all.
  const bar = expired
    ? "bg-red-500/15 text-red-400"
    : "bg-amber-500/15 text-amber-400";
  const close = expired ? "hover:bg-red-500/20" : "hover:bg-amber-500/20";

  const message = expired
    ? t("expiredBanner")
    : t("expiringBanner").replace("{days}", String(daysLeft));

  return (
    <div className={`flex items-center justify-between gap-3 px-4 py-2 text-sm ${bar}`}>
      <span>{message}</span>
      <button
        onClick={() => setDismissed(true)}
        className={`shrink-0 rounded px-2 py-0.5 text-xs ${close}`}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
