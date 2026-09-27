import type { ApiError as ApiErrorBody, Envelope } from "@packlens/contracts";
import { tokenTextReviver } from "../lib/tokenText";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
  }
}

function currentNamespace(): string | null {
  return new URLSearchParams(window.location.search).get("namespace");
}

export function buildUrl(path: string, params: Record<string, string | number | boolean | null | undefined> = {}, includeNamespace = true): string {
  const url = new URL(path, window.location.origin);
  const ns = currentNamespace();
  if (includeNamespace && ns && !("namespace" in params)) url.searchParams.set("namespace", ns);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.pathname + url.search;
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return null as T;
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text, tokenTextReviver) : null;
  } catch {
    throw new ApiError(res.status, "INVALID_RESPONSE", "The server returned an unreadable response.", null);
  }
  if (!res.ok) {
    const e = (body as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, e?.code ?? "HTTP_ERROR", e?.message ?? `Request failed (${res.status}).`, e?.requestId ?? null);
  }
  return body as T;
}

export async function apiGet<T>(path: string, params: Record<string, string | number | boolean | null | undefined> = {}, signal?: AbortSignal): Promise<Envelope<T> & { sequence?: number }> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, params), { credentials: "same-origin", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "NETWORK", "The Degentellegence server is not reachable.", null);
  }
  return parse(res);
}

export async function apiRaw<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init, headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
  } catch {
    throw new ApiError(0, "NETWORK", "The Degentellegence server is not reachable.", null);
  }
  return parse(res);
}

export function apiPost<T>(path: string, body: unknown, opts: { idempotent?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.idempotent) headers["Idempotency-Key"] = crypto.randomUUID();
  return apiRaw<T>(path, { method: "POST", body: JSON.stringify(body ?? {}), headers });
}

export function track(name: string, screen: string, packId: string | null = null): void {
  const namespace = currentNamespace();
  void fetch("/api/analytics", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, screen, packId, ...(namespace ? { namespace } : {}) }),
    keepalive: true,
  }).catch(() => undefined);
}
