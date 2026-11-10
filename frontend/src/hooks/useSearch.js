"use client";

import { useState, useEffect, useRef } from "react";
import api from "@/lib/api";

export default function useSearch({ endpoint, debounceMs = 300, extraParams = {} }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [failed, setFailed] = useState(false); // the last request got no answer (not "nothing found")
  const timerRef = useRef(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setFailed(false);

    if (!query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    let superseded = false; // the box has changed since: this answer is for older text

    timerRef.current = setTimeout(async () => {
      try {
        const res = await api.get(endpoint, { params: { q: query, ...extraParams } });
        if (!superseded) setResults(res.data.songs ?? res.data);
      } catch {
        if (superseded) return;
        setResults([]);
        setFailed(true);
      } finally {
        if (!superseded) setIsSearching(false);
      }
    }, debounceMs);

    return () => {
      superseded = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, endpoint, debounceMs]);

  return { query, setQuery, results, isSearching, failed };
}
