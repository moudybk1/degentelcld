import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { SseMessage } from "@packlens/contracts";
import { buildUrl } from "./client";

export type SourcePulse = {
  health: string;
  lastMessageAt: string | null;
  lastEventTimeMs: number | null;
  price: string;
  packCount: number;
  session: boolean;
};

type Listener = (msg: SseMessage | { type: "resync_required" }) => void;

type EventsCtx = {
  subscribe: (fn: Listener) => () => void;
  connected: boolean;
  pulse: SourcePulse | null;
};

const Ctx = createContext<EventsCtx>({ subscribe: () => () => undefined, connected: false, pulse: null });

/**
 * One SSE connection per namespace. The browser resends Last-Event-ID on
 * reconnect; the server replays retained outbox rows or asks for a resync.
 * Consumers refetch snapshots and ignore older aggregate versions.
 */
export function EventsProvider({ namespace, children }: { namespace: string | null; children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);
  const [pulse, setPulse] = useState<SourcePulse | null>(null);

  useEffect(() => {
    const url = buildUrl("/api/events", namespace ? { namespace } : {}, false);
    const es = new EventSource(url);
    const emit = (m: SseMessage | { type: "resync_required" }) => {
      for (const fn of listeners.current) fn(m);
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    for (const type of ["pack.created", "pack.updated", "analysis.updated", "smart_money.updated"]) {
      es.addEventListener(type, (ev) => {
        try {
          emit(JSON.parse((ev as MessageEvent<string>).data) as SseMessage);
        } catch {
          /* ignore malformed frames */
        }
      });
    }
    es.addEventListener("resync_required", () => emit({ type: "resync_required" }));
    es.addEventListener("source.status", (ev) => {
      try {
        setPulse(JSON.parse((ev as MessageEvent<string>).data) as SourcePulse);
      } catch {
        /* ignore */
      }
    });
    return () => {
      es.close();
      setConnected(false);
    };
  }, [namespace]);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  return <Ctx.Provider value={{ subscribe, connected, pulse }}>{children}</Ctx.Provider>;
}

export function useEvents(): EventsCtx {
  return useContext(Ctx);
}

/** Subscribe to event types with a stable handler. */
export function useEventListener(handler: Listener, deps: unknown[]): void {
  const { subscribe } = useEvents();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((m) => ref.current(m)), [subscribe, ...deps]);
}
