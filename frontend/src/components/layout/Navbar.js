"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import useAuth from "@/hooks/useAuth";
import useAuthStore from "@/store/authStore";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { useTheme } from "@/components/layout/ThemeProvider";
import CaptureIndicator from "@/components/layout/CaptureIndicator";

export default function Navbar() {
  const { user, isAuthenticated, isAdmin, canCapture } = useAuth();
  const { theme } = useTheme();
  const init = useAuthStore((s) => s.init);
  const pathname = usePathname();
  const { t } = useLanguage();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    init();
  }, [init]);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const navLink = (href, label) => {
    const isActive = pathname?.startsWith(href);
    return (
      <Link
        href={href}
        className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          isActive
            ? "bg-primary/10 text-primary"
            : "text-muted hover:bg-surface-hover hover:text-theme"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <nav className="sticky top-0 z-40 border-b border-border" style={{ backgroundColor: "var(--surface)" }}>
      <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-5">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-lg font-bold tracking-tight"
            style={{ color: "var(--text)" }}
          >
            <img src={theme === "dark" ? "/brand_icon_dark.png" : "/brand_icon_light.png"} alt="logo" className="h-7 w-7 rounded-lg object-cover" />
            <img src={theme === "dark" ? "/qni_yixia_dark.png" : "/qni_yixia_light.png"} alt="Q你一下" className="h-5 object-contain" />
          </Link>
          {isAuthenticated && (
            <span className="hidden text-sm text-muted sm:inline">
              {t("welcome")} <span className="font-medium" style={{ color: "var(--text)" }}>{user?.username}</span>
            </span>
          )}
        </div>

        {isAuthenticated && (
          <>
            {/* Desktop nav */}
            <div className="hidden items-center gap-1 md:flex">
              {/* Only for accounts that can capture at all — to everyone else
                  it is a status light for a machine they do not have. */}
              {canCapture && <CaptureIndicator />}
              {navLink("/playlists", t("navPlaylists"))}
              {/* Admins only while 唱卡 is being proven out. The add-on that
                  gates it was sold for auto-tagging, and its holders cannot
                  use this yet -- their client does not read the 唱卡 screens,
                  so the page would sit on "waiting to connect" forever.
                  Widen this once the client ships. */}
              {isAdmin && navLink("/live", t("navLive"))}
              {navLink("/tools", t("navTools"))}
              {/* No /pricing here on purpose — it is reached from the account
                  page (套餐与续费) and the register-success screen, so it is
                  something you find when you go looking at your own account
                  rather than a permanent ad in the nav. */}
              {navLink("/updates", t("navUpdates"))}
              {navLink("/help", t("navHelp"))}
              {isAdmin && navLink("/admin", t("navAdmin"))}
              {navLink("/account", t("navAccount"))}
            </div>

            {/* Mobile hamburger */}
            <button
              onClick={() => setMobileOpen((o) => !o)}
              className="rounded-md p-2 text-muted hover:bg-surface-hover hover:text-theme md:hidden"
              aria-label="Menu"
            >
              {mobileOpen ? "✕" : "☰"}
            </button>
          </>
        )}
      </div>

      {/* Mobile dropdown */}
      {isAuthenticated && mobileOpen && (
        <div className="border-t border-border bg-surface px-4 pb-3 pt-2 md:hidden">
          <div className="mb-2 text-sm text-muted">
            {t("welcome")} <span className="font-medium" style={{ color: "var(--text)" }}>{user?.username}</span>
          </div>
          {canCapture && (
            <div className="mb-1">
              <CaptureIndicator />
            </div>
          )}
          <div className="flex flex-col gap-1">
            {navLink("/playlists", t("navPlaylists"))}
            {isAdmin && navLink("/live", t("navLive"))}
            {navLink("/tools", t("navTools"))}
            {navLink("/updates", t("navUpdates"))}
            {navLink("/help", t("navHelp"))}
            {isAdmin && navLink("/admin", t("navAdmin"))}
            {navLink("/account", t("navAccount"))}
          </div>
        </div>
      )}
    </nav>
  );
}
