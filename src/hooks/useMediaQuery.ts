"use client";

import { useEffect, useState } from "react";

/** Whether `query` matches; null until hydrated (the server cannot know). */
export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);

  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return setMatches(false);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
