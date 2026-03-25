"use client";

import { useRef, useEffect } from "react";

export default function SearchBar({ value, onChange, placeholder }) {
  const inputRef = useRef(null);
  const timerRef = useRef(null);

  const handleChange = (e) => {
    const val = e.target.value;

    // Debounce 300ms
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onChange(val);
    }, 300);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="mb-4">
      <input
        ref={inputRef}
        type="text"
        defaultValue={value}
        onChange={handleChange}
        placeholder={placeholder || "Search..."}
        className="w-full rounded-lg border border-border bg-surface px-4 py-2 text-sm text-theme placeholder-muted focus:border-primary focus:outline-none"
      />
    </div>
  );
}
