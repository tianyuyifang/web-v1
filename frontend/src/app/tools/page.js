"use client";

import Link from "next/link";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ToolsPage() {
  const { t } = useLanguage();

  const tools = [
    {
      id: "diff",
      href: "/tools/diff",
      title: t("diff"),
      description: t("toolsDiffDescription"),
    },
    {
      id: "merge",
      href: "/tools/merge",
      title: t("merge"),
      description: t("toolsMergeDescription"),
    },
    {
      id: "capture-apk",
      href: "/qni-capture.apk",
      title: t("toolsCaptureApk"),
      description: t("toolsCaptureApkDescription"),
      // A file download, not a route — Link would try to client-navigate to it.
      download: true,
    },
  ];

  return (
    <main className="mx-auto max-w-screen-lg p-6">
      <h1 className="mb-4 text-2xl font-bold" style={{ color: "var(--text)" }}>
        {t("tools")}
      </h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map((tool) => {
          const body = (
            <>
              <div className="text-base font-semibold" style={{ color: "var(--text)" }}>
                {tool.title}
              </div>
              <p className="mt-1 text-sm text-muted">{tool.description}</p>
            </>
          );
          const cls =
            "block rounded-lg border border-border bg-surface p-4 transition-colors hover:bg-surface-hover";

          return tool.download ? (
            <a key={tool.id} href={tool.href} download className={cls}>
              {body}
            </a>
          ) : (
            <Link key={tool.id} href={tool.href} className={cls}>
              {body}
            </Link>
          );
        })}
      </div>
    </main>
  );
}
