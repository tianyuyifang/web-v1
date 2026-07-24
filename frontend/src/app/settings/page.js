"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Settings moved into the Account page (Appearance / Language tabs).
export default function SettingsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/account");
  }, [router]);
  return null;
}
