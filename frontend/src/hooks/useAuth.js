"use client";

import useAuthStore from "@/store/authStore";

export default function useAuth() {
  const { user, loading, login, logout } = useAuthStore();

  return {
    user,
    isAuthenticated: !!user,
    isPending: user?.role === "PENDING",
    isMember: user?.role === "MEMBER",
    isAdmin: user?.role === "ADMIN",
    loading,
    login,
    logout,
  };
}
