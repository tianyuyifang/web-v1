"use client";

import { useRouter } from "next/navigation";
import useAuth from "@/hooks/useAuth";
import { useLanguage } from "@/components/layout/LanguageProvider";
import InstructionPanel from "@/components/help/InstructionPanel";
import FeedbackPanel from "@/components/help/FeedbackPanel";
import MyFeedback from "@/components/help/MyFeedback";
import { markSeen } from "@/lib/feedbackSeen";

export default function HelpPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  if (authLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!user) {
    router.push("/login");
    return null;
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="mb-4 text-2xl font-bold" style={{ color: "var(--text)" }}>
        {t("helpTitle")}
      </h1>

      {/* Stacked rather than tabbed. Feedback behind a tab was a page nobody
          opened: reaching it meant knowing to look, and the one thing this
          page exists to collect was the thing hidden. Both fit on a screen —
          the guide is a single card — so nothing is gained by hiding one.

          Both sections are titled the same way, at the same level: the guide's
          heading used to live inside its card, which left the two halves of
          the page looking unlike each other. */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-theme">
          {t("helpInstructionCardTitle")}
        </h2>
        <InstructionPanel />
      </section>

      <section className="mt-10 border-t border-border pt-8">
        {/* Same size as 使用指南 above — a pair, not a hierarchy. Both sit
            below the 2xl page title, so the levels stay distinct. */}
        <h2 className="mb-4 text-lg font-semibold text-theme">
          {t("helpTabFeedback")}
        </h2>
        {/* Opening this page is what counts as reading a reply — the replies
            are right here, so anything subtler would only risk the dot
            outliving the thing it points at. */}
        <MyFeedback onSeen={markSeen} />
        <FeedbackPanel />
      </section>
    </div>
  );
}
