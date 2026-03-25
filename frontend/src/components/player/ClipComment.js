"use client";

import { useState, useRef, useEffect } from "react";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ClipComment({ comment, editable, onChange }) {
  const { t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment || "");
  const textareaRef = useRef(null);

  // Auto-resize textarea to fit content
  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [editing, draft]);

  const save = () => {
    onChange(draft.trim() || null);
    setEditing(false);
  };

  if (!editable) {
    if (!comment) return null;
    return (
      <p className="mt-2 whitespace-pre-wrap text-xs" style={{ color: "var(--text)" }}>
        {comment}
      </p>
    );
  }

  if (editing) {
    return (
      <div className="mt-2">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
          }}
          rows={1}
          className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs leading-relaxed text-theme focus:border-primary focus:outline-none"
          placeholder={t("addComment")}
          autoFocus
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => { setDraft(comment || ""); setEditing(true); }}
      className={`mt-2 block text-left ${
        comment
          ? "text-xs hover:opacity-100"
          : "text-[10px] text-muted opacity-25 hover:opacity-50"
      }`}
      style={comment ? { color: "var(--text)" } : undefined}
    >
      {comment ? (
        <span className="whitespace-pre-wrap">{comment}</span>
      ) : (
        t("addComment")
      )}
    </button>
  );
}
