"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { captureAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ToolsPage() {
  const { t } = useLanguage();

  // Read the version from the server rather than hardcoding it here: the same
  // value gates the client's upgrade prompt, so the page cannot advertise a
  // build the server does not actually serve.
  const [apk, setApk] = useState(null);
  useEffect(() => {
    let alive = true;
    captureAPI
      .version()
      .then((res) => alive && setApk(res.data))
      .catch(() => {}); // the card is still useful without it
    return () => {
      alive = false;
    };
  }, []);

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
      // Downloading is free; running it is the paid part. Said here so the
      // cost is known before the install, not after.
      description: `${t("toolsCaptureApkDescription")}（${t("addOnNeedsSetup")}）`,
      // A file download, not a route — Link would try to client-navigate to it.
      download: true,
      meta: apk && (apk.latestName || apk.latest)
        ? `v${apk.latestName || apk.latest}${apk.releasedAt ? ` · ${apk.releasedAt}` : ""}`
        : null,
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
              <div className="flex items-baseline gap-2">
                <span className="text-base font-semibold" style={{ color: "var(--text)" }}>
                  {tool.title}
                </span>
                {tool.meta && (
                  <span className="shrink-0 text-[11px] text-muted">{tool.meta}</span>
                )}
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
