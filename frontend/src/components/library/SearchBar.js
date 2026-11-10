"use client";

/**
 * Search box. Controlled: the page holds the text and decides when to search
 * (see useDebouncedValue), so switching what it searches never drops typing.
 */
export default function SearchBar({ value, onChange, placeholder }) {
  return (
    <div className="mb-4">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || "Search..."}
        className="w-full rounded-lg border border-border bg-surface px-4 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
      />
    </div>
  );
}
