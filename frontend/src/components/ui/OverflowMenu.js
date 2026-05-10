"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Dropdown overflow menu with a "⋯" trigger.
 *
 * Props:
 *  - items: Array<{ id: string, label: string, onClick: () => void, active?: boolean, destructive?: boolean, hidden?: boolean }>
 *  - align: "left" | "right"  (default "right") — which edge of the trigger the panel aligns to
 */
export default function OverflowMenu({ items, align = "right" }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (e) => {
      if (
        triggerRef.current?.contains(e.target) ||
        panelRef.current?.contains(e.target)
      ) {
        return;
      }
      setOpen(false);
    };

    const handleKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const visibleItems = items.filter((it) => !it.hidden);
  if (visibleItems.length === 0) return null;

  const alignClass = align === "left" ? "left-0" : "right-0";

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-label="More actions"
        aria-expanded={open}
        className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-hover"
        style={{ color: "var(--text)" }}
      >
        ⋯
      </button>

      {open && (
        <div
          ref={panelRef}
          className={`absolute ${alignClass} z-50 mt-1 min-w-[10rem] rounded-lg border border-border bg-surface p-1 shadow-lg`}
        >
          {visibleItems.map((it) => {
            const base =
              "w-full rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors";
            let stateClass;
            if (it.active) {
              stateClass = "bg-primary text-white shadow-sm hover:bg-primary-hover";
            } else if (it.destructive) {
              stateClass = "text-red-400 hover:bg-red-500/10";
            } else {
              stateClass = "hover:bg-surface-hover";
            }
            const style = it.active || it.destructive ? undefined : { color: "var(--text)" };

            return (
              <button
                key={it.id}
                onClick={() => {
                  it.onClick();
                  setOpen(false);
                }}
                className={`${base} ${stateClass}`}
                style={style}
              >
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
