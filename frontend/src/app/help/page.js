"use client";

import { useRouter } from "next/navigation";
import useAuth from "@/hooks/useAuth";
import { useLanguage } from "@/components/layout/LanguageProvider";
import InstructionPanel from "@/components/help/InstructionPanel";
import FeedbackPanel from "@/components/help/FeedbackPanel";

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
          the guide is a single card — so nothing is gained by hiding one. */}
      <InstructionPanel />

      <section className="mt-10 border-t border-border pt-8">
        {/* Matches 使用指南 inside the card above: these are the page's two
            sections and should look like a pair. They were 18px and 16px,
            which reads as a hierarchy that is not there. Both sit below
            the 2xl page title, so the levels stay distinct. */}
        <h2 className="mb-4 text-lg font-semibold text-theme">
          {t("helpTabFeedback")}
        </h2>
        <FeedbackPanel />
      </section>
    </div>
  );
}
