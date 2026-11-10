"use client";

import { useState, useEffect } from "react";

/** `value` once it has stopped changing for `ms` (typing → when to search). */
export default function useDebouncedValue(value, ms = 300) {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return settled;
}
