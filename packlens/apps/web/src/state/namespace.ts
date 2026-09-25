import { useCallback } from "react";
import { useSearchParams } from "react-router";

/** The namespace in the URL, if any. Internal links preserve it (§17.14). */
export function useNamespace(): string | null {
  const [params] = useSearchParams();
  return params.get("namespace");
}

export function useNsHref(): (path: string) => string {
  const ns = useNamespace();
  return useCallback((path: string) => {
    if (!ns) return path;
    const sep = path.includes("?") ? "&" : "?";
    return `${path}${sep}namespace=${encodeURIComponent(ns)}`;
  }, [ns]);
}
