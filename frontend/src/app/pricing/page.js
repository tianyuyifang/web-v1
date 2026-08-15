"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";
import ContactAdmins from "@/components/account/ContactAdmins";

/**
 * What each tier includes, in the order the table renders. Each cell is
 * either true (a tick), false (a dash), or a string shown as-is when the
 * answer is more than yes or no.
 *
 * A new paid feature is one row with `plus: true` — the tier bundles
 * everything, so nothing about the prices below has to change.
 */
function useRows(t) {
  return [
    { label: t("benefitCreatePlaylist"), guest: true, member: true, plus: true },
    { label: t("benefitSpeedPitch"), guest: true, member: true, plus: true },
    { label: t("benefitTagsNotes"), guest: true, member: true, plus: true },
    { label: t("benefitCompare"), guest: true, member: true, plus: true },
    { label: t("benefitMerge"), guest: true, member: true, plus: true },
    {
      label: t("benefitPlaylistCount"),
      guest: t("benefitPlaylistCountGuest"),
      member: t("benefitPlaylistCountMember"),
      plus: t("benefitPlaylistCountMember"),
    },
    { label: t("benefitGrantShare"), guest: true, member: true, plus: true },
    { label: t("benefitGrantCopy"), guest: false, member: true, plus: true },
    { label: t("benefitMakePublic"), guest: false, member: true, plus: true },
    // Add-on features: only the third column ticks. Add the next one here.
    {
      label: t("benefitCapture"),
      guest: false, member: false, plus: true,
      highlight: true,
    },
  ];
}

function Cell({ value }) {
  if (value === true) return <span className="text-theme">✓</span>;
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
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted">
                {t("pricingBenefit")}
              </th>
              {/* One colour across the table: three tinted columns read as a
                  ranking of their own, competing with the ticks that carry
                  the actual comparison. text-theme, not a literal black, so
                  the dark palette still gets legible text. */}
              <th className="px-4 py-3 text-center font-medium text-theme">
                {t("pricingGuest")}
              </th>
              <th className="px-4 py-3 text-center font-medium text-theme">
                {t("pricingMember")}
              </th>
              <th className="px-4 py-3 text-center font-medium text-theme">
                {t("pricingPlus")}
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
                <td className="px-4 py-3 text-center">
                  <Cell value={r.plus} />
                </td>
              </tr>
            ))}
            {/* Price sits inside the same table so the columns line up with
                the benefits they belong to. */}
            <tr className="border-t border-border bg-background/40">
              <td className="px-4 py-3 font-semibold text-theme">
                {t("pricingPriceRow")}
              </td>
              <td className="px-4 py-3 text-center font-semibold text-theme">
                {t("pricingFree")}
              </td>
              <td className="px-4 py-3 text-center font-semibold text-theme">
                25 {t("pricingPerMonth")}
              </td>
              <td className="px-4 py-3 text-center font-semibold text-theme">
                35 {t("pricingPerMonth")}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-6 rounded-xl border border-primary/20 bg-primary/5 px-5 py-4">
        {/* No separate heading: the line itself says what this box is for. */}
        <p className="text-sm font-semibold text-theme">
          {t("pricingContactBody")}
        </p>
        <ContactAdmins />
      </div>
    </div>
  );
}
