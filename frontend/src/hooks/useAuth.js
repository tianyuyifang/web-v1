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
    // Mirrors hasAddOn() on the server: admins and guests get every add-on
    // without holding it, so never test the list on its own.
    canCapture:
      user?.role === "ADMIN" ||
      user?.role === "GUEST" ||
      (user?.entitlements || []).includes("capture"),
    loading,
    login,
    logout,
  };
}
