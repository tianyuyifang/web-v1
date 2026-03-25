"use client";

import { useState, useEffect, useRef } from "react";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ConfirmDialog({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel, danger = false, input = false, inputPlaceholder = "" }) {
  const { t } = useLanguage();
  const [inputValue, setInputValue] = useState("");
  const dialogRef = useRef(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  // Focus trap — auto-focus first interactive element
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const focusable = el.querySelector("input, button");
    focusable?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
      <div
        ref={dialogRef}
        className="mx-4 w-full max-w-sm rounded-xl border border-border p-6 shadow-lg"
        style={{ backgroundColor: "var(--surface)" }}
      >
        <h3 id="confirm-dialog-title" className="text-lg font-semibold text-theme">{title}</h3>
        {message && <p className="mt-2 text-sm text-muted">{message}</p>}

        {input && (
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={inputPlaceholder}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter" && inputValue.trim()) onConfirm(inputValue.trim()); }}
            className="mt-3 w-full rounded-lg border border-border bg-input-bg px-3 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
          />
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-theme transition-colors hover:bg-surface-hover"
          >
            {cancelLabel || t("cancel") || "Cancel"}
          </button>
          <button
            onClick={() => input ? onConfirm(inputValue.trim()) : onConfirm()}
            disabled={input && !inputValue.trim()}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors disabled:opacity-50 ${
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
