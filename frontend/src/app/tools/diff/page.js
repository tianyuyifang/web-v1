"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { playlistsAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import PlaylistPicker from "@/components/tools/PlaylistPicker";
import DiffReport from "@/components/tools/DiffReport";

export default function DiffPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();
  const aId = searchParams.get("a");
  const bId = searchParams.get("b");

  const [aPlaylist, setAPlaylist] = useState(null);
  const [bPlaylist, setBPlaylist] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function fetchName(id, setter) {
      if (!id) {
        setter(null);
        return;
      }
      try {
        const res = await playlistsAPI.getById(id);
        if (!cancelled) setter({ id: res.data.id, name: res.data.name });
      } catch {
        if (!cancelled) setter(null);
      }
    }
    fetchName(aId, setAPlaylist);
    fetchName(bId, setBPlaylist);
    return () => {
      cancelled = true;
    };
  }, [aId, bId]);

  useEffect(() => {
    let cancelled = false;
    if (!aId || !bId) {
      setReport(null);
      setError("");
      return;
    }
    if (aId === bId) {
      setReport(null);
      setError(t("diffSameError"));
      return;
    }
    setLoading(true);
    setError("");
    setReport(null);
    playlistsAPI
      .diff(aId, bId)
      .then((res) => {
        if (!cancelled) setReport(res.data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.response?.data?.error?.message || "Failed to load diff");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aId, bId, t]);

  const updateUrl = useCallback(
    (newA, newB) => {
      const params = new URLSearchParams();
      if (newA) params.set("a", newA);
      if (newB) params.set("b", newB);
      const qs = params.toString();
      router.replace(qs ? `/tools/diff?${qs}` : "/tools/diff");
    },
    [router]
  );

  const handleSelectA = (p) => {
    setAPlaylist(p);
    updateUrl(p?.id || null, bId);
  };
  const handleSelectB = (p) => {
    setBPlaylist(p);
    updateUrl(aId, p?.id || null);
  };
  const handleSwap = () => {
    updateUrl(bId, aId);
  };

  if (!isDesktop) {
    return (
      <main className="mx-auto max-w-screen-md p-6">
        <p className="text-center text-muted">{t("toolsDesktopOnly")}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-screen-lg p-6">
      <h1 className="mb-4 text-2xl font-bold" style={{ color: "var(--text)" }}>
        {t("diff")}
      </h1>

      <div className="mb-6 space-y-3 rounded-lg border border-border bg-surface p-4">
        <PlaylistPicker
          label={t("diffBaseline")}
          value={aPlaylist}
          onChange={handleSelectA}
          excludeId={bId || undefined}
        />
        <PlaylistPicker
          label={t("diffCurrent")}
          value={bPlaylist}
          onChange={handleSelectB}
          excludeId={aId || undefined}
        />
        {aId && bId && (
          <div>
            <button
              type="button"
              onClick={handleSwap}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-hover"
              style={{ color: "var(--text)" }}
            >
              {t("diffSwap")}
            </button>
          </div>
        )}
      </div>

      {!aId || !bId ? (
        <p className="text-sm text-muted">{t("diffEmpty")}</p>
      ) : loading ? (
        <p className="text-sm text-muted">{t("loading")}</p>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : report ? (
        <DiffReport report={report} />
      ) : null}
    </main>
  );
}
