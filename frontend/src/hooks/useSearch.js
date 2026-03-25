"use client";

import { useState, useEffect, useRef } from "react";
import api from "@/lib/api";

export default function useSearch({ endpoint, debounceMs = 300 }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);

    timerRef.current = setTimeout(async () => {
      try {
        const res = await api.get(endpoint, { params: { q: query } });
        setResults(res.data.songs ?? res.data);
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, endpoint, debounceMs]);

  return { query, setQuery, results, isSearching };
}
