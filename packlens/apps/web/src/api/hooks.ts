import { useCallback, useEffect, useRef, useState } from "react";
import type { Envelope, Mode } from "@packlens/contracts";
import { apiGet, ApiError } from "./client";

export type Loaded<T> = {
  data: T | null;
  meta: { namespace: string; mode: Mode; sequence: number | null } | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
};

/**
 * Snapshot query. Keeps the previous data while refreshing so updates never
 * blank the screen or move what the reader is looking at.
 */
export function useApi<T>(path: string | null, params: Record<string, string | number | boolean | null | undefined> = {}): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [meta, setMeta] = useState<Loaded<T>["meta"]>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [tick, setTick] = useState(0);
  const key = path === null ? null : `${path}?${JSON.stringify(params)}`;
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (path === null) return;
    const ctrl = new AbortController();
    if (lastKey.current !== key) {
      setData(null);
      setMeta(null);
    }
    lastKey.current = key;
    setLoading(true);
    apiGet<T>(path, params, ctrl.signal)
      .then((res: Envelope<T> & { sequence?: number }) => {
        setData(res.data);
        setMeta({ namespace: res.namespace, mode: res.mode, sequence: res.sequence ?? null });
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Something went wrong.", null));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, meta, error, loading, reload };
}

/** Whether a CSS media query currently matches; follows changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Re-render periodically so relative times stay honest without refetching. */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const DEFAULT_TITLE = "Degentellegence · Pack Radar";

/** The browser tab title for this page; restores the site title when the page closes. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title) document.title = title;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [title]);
}
