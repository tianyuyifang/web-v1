"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useAuth from "@/hooks/useAuth";
import useAuthStore from "@/store/authStore";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { useTheme } from "@/components/layout/ThemeProvider";

export default function Navbar() {
  const { user, isAuthenticated, isAdmin, logout } = useAuth();
  const { theme } = useTheme();
  const init = useAuthStore((s) => s.init);
  const router = useRouter();
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

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

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
            <img src="/qni.png" alt="Q你一下" className="h-5 object-contain" />
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
              {navLink("/playlists", t("navPlaylists"))}
              {navLink("/guide", t("navGuide"))}
              {navLink("/feedback", t("navFeedback"))}
              {isAdmin && navLink("/admin", t("navAdmin"))}
              {navLink("/settings", t("navSettings"))}
              <button
                onClick={handleLogout}
                className="ml-2 rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
              >
                {t("navLogout")}
              </button>
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
          <div className="flex flex-col gap-1">
            {navLink("/playlists", t("navPlaylists"))}
            {navLink("/guide", t("navGuide"))}
            {navLink("/feedback", t("navFeedback"))}
            {isAdmin && navLink("/admin", t("navAdmin"))}
            {navLink("/settings", t("navSettings"))}
            <button
              onClick={handleLogout}
              className="rounded-md px-3 py-1.5 text-left text-sm font-medium text-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
            >
              {t("navLogout")}
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
