"use client";

import useAuthStore from "@/store/authStore";

export default function useAuth() {
  const { user, loading, login, logout } = useAuthStore();

  return {
    user,
    isAuthenticated: !!user,
    isPending: user?.role === "PENDING",
    isGuest: user?.role === "GUEST",
    isMember: user?.role === "MEMBER",
    isAdmin: user?.role === "ADMIN",
    entitlements: user?.entitlements || [],
    // Mirrors hasAddOn() on the server: admins hold every add-on without it
    // being recorded, so never test the list on its own.
    canCapture:
      user?.role === "ADMIN" ||
      (user?.entitlements || []).includes("capture"),
    // Holding any add-on means holding 加订版 — they are sold as one bundle.
    hasAddOnTier:
      user?.role === "ADMIN" || (user?.entitlements || []).length > 0,
    // May this account decide song mappings? Not an add-on: a hand-granted
    // flag, because one wrong approval changes what plays for everybody.
    // Used to leave those buttons out rather than to protect anything — the
    // server checks again on every write.
    canEditMapping:
      user?.role === "ADMIN" || user?.canEditMapping === true,
    loading,
    login,
    logout,
  };
}
