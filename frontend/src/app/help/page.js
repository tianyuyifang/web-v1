"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import useAuth from "@/hooks/useAuth";
import { useLanguage } from "@/components/layout/LanguageProvider";
import InstructionPanel from "@/components/help/InstructionPanel";
import FeedbackPanel from "@/components/help/FeedbackPanel";

export default function HelpPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [activeTab, setActiveTab] = useState("instruction"); // instruction | feedback

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

  const tabs = [
    { key: "instruction", label: t("helpTabInstruction") },
    { key: "feedback", label: t("helpTabFeedback") },
  ];

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="mb-4 text-2xl font-bold" style={{ color: "var(--text)" }}>
        {t("helpTitle")}
      </h1>

      {/* Underline tab bar */}
      <div className="mb-6 flex flex-wrap gap-x-5 gap-y-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            aria-pressed={activeTab === tab.key}
            className={`-mb-px border-b-2 px-1 py-2.5 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "border-primary text-primary"
                : "border-transparent text-muted hover:text-theme"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "instruction" && <InstructionPanel />}
      {activeTab === "feedback" && <FeedbackPanel />}
    </div>
  );
}
