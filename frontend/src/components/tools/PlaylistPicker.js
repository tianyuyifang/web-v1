"use client";

import { useEffect, useRef, useState } from "react";
import { playlistsAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";

/**
 * Autocomplete playlist selector.
 *
 * Props:
 *  - label: string — visible label rendered above the input
 *  - value: { id, name } | null — currently selected playlist (or null)
 *  - onChange: (playlist | null) => void — fires with selection or with null when cleared
 *  - excludeId?: string — playlist id to omit from search results (the other side's selection)
 *  - placeholder?: string — override placeholder text
 */
export default function PlaylistPicker({ label, value, onChange, excludeId, placeholder }) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open || !query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await playlistsAPI.list({ q: query.trim() });
        const list = Array.isArray(res.data) ? res.data : res.data.playlists || [];
        setResults(list.filter((p) => p.id !== excludeId));
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, open, excludeId]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  if (value && !open) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">{label}</span>
        <span
          className="rounded-md bg-surface px-2 py-1 text-sm font-medium"
          style={{ color: "var(--text)" }}
        >
          {value.name}
        </span>
        <button
          type="button"
          onClick={() => {
            setQuery("");
            setOpen(true);
          }}
          className="text-xs text-primary hover:underline"
        >
          {t("diffChange")}
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <label className="mb-1 block text-sm text-muted">{label}</label>
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder || t("diffSelectPlaylist")}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
        style={{ color: "var(--text)" }}
      />
      {open && results.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-surface shadow-lg">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  onChange({ id: p.id, name: p.name });
                  setQuery("");
                  setOpen(false);
                }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-surface-hover"
                style={{ color: "var(--text)" }}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
