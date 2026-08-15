"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";
import ContactAdmins from "@/components/account/ContactAdmins";

/**
 * What each tier includes, in the order the table renders. `guest` and
 * `member` are either true (a tick), false (a dash), or a string shown as-is
 * when the answer is more than yes or no.
 */
function useRows(t) {
  return [
    { label: t("benefitCreatePlaylist"), guest: true, member: true },
    { label: t("benefitSpeedPitch"), guest: true, member: true },
    { label: t("benefitTagsNotes"), guest: true, member: true },
    { label: t("benefitCompare"), guest: true, member: true },
    { label: t("benefitMerge"), guest: true, member: true },
    {
      label: t("benefitPlaylistCount"),
      guest: t("benefitPlaylistCountGuest"),
      member: t("benefitPlaylistCountMember"),
    },
    { label: t("benefitGrantShare"), guest: true, member: true },
    { label: t("benefitGrantCopy"), guest: false, member: true },
    { label: t("benefitMakePublic"), guest: false, member: true },
    {
      label: t("benefitCapture"),
      guest: t("benefitCaptureGuest"),
      member: t("benefitCaptureMember"),
      highlight: true,
    },
  ];
}

function Cell({ value }) {
  if (value === true) return <span className="text-green-400">✓</span>;
  if (value === false) return <span className="text-muted">—</span>;
  return <span className="text-sm text-theme">{value}</span>;
}

export default function PricingPage() {
  const { t } = useLanguage();
  const rows = useRows(t);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-theme">{t("pricingTitle")}</h1>
        <p className="mt-1 text-sm text-muted">{t("pricingSubtitle")}</p>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted">
                {t("pricingBenefit")}
              </th>
              <th className="px-4 py-3 text-center font-medium text-sky-400">
                {t("pricingGuest")}
              </th>
              <th className="px-4 py-3 text-center font-medium text-green-400">
                {t("pricingMember")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.label}
                className={`border-b border-border/50 last:border-0 ${
                  r.highlight ? "bg-primary/5" : ""
                }`}
              >
                <td className="px-4 py-3 text-theme">{r.label}</td>
                <td className="px-4 py-3 text-center">
                  <Cell value={r.guest} />
                </td>
                <td className="px-4 py-3 text-center">
                  <Cell value={r.member} />
                </td>
              </tr>
            ))}
            {/* Price sits inside the same table so the columns line up with
                the benefits they belong to. */}
            <tr className="border-t border-border bg-background/40">
              <td className="px-4 py-3 font-semibold text-theme">
                {t("pricingPriceRow")}
              </td>
              <td className="px-4 py-3 text-center font-semibold text-sky-400">
                {t("pricingFree")}
              </td>
              <td className="px-4 py-3 text-center font-semibold text-green-400">
                25 {t("pricingPerMonth")}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-6 rounded-xl border border-primary/20 bg-primary/5 px-5 py-4">
        <p className="text-sm font-semibold text-theme">
          {t("pricingContactTitle")}
        </p>
        <p className="mt-1 text-xs text-muted">{t("pricingContactBody")}</p>
        <ContactAdmins />
      </div>
    </div>
  );
}
