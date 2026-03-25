"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ConfirmDialog({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel, danger = false }) {
  const { t } = useLanguage();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="mx-4 w-full max-w-sm rounded-xl border border-border p-6 shadow-lg"
        style={{ backgroundColor: "var(--surface)" }}
      >
        <h3 className="text-lg font-semibold text-theme">{title}</h3>
        {message && <p className="mt-2 text-sm text-muted">{message}</p>}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-theme transition-colors hover:bg-surface-hover"
          >
            {cancelLabel || t("cancel") || "Cancel"}
          </button>
          <button
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors ${
              danger
                ? "bg-red-600 hover:bg-red-500"
                : "bg-primary hover:bg-primary-hover"
            }`}
          >
            {confirmLabel || t("confirm") || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
