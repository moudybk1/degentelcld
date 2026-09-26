import type { FastifyReply, FastifyRequest } from "fastify";
import type { Runtime } from "../runtime.js";
import { latestOutboxSequence, oldestOutboxSequence, readOutboxAfter } from "../ingest/outbox.js";

/**
 * SSE stream (blueprint §11.4). Delivery is at-least-once: clients ignore
 * older aggregate versions. Reconnects replay retained outbox rows after
 * Last-Event-ID, or receive resync_required when the cursor expired.
 */
export function handleSse(runtime: Runtime, req: FastifyRequest, reply: FastifyReply, namespace: string): void {
  const db = runtime.db;
  const raw = reply.raw;
  reply.hijack();
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (chunk: string) => {
    if (!raw.writableEnded) raw.write(chunk);
  };
  const send = (sequence: number | null, type: string, data: unknown) => {
    write(`${sequence !== null ? `id: ${sequence}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  write("retry: 3000\n\n");

  const headerId = req.headers["last-event-id"];
  const queryId = (req.query as Record<string, string | undefined>).lastEventId;
  const requested = typeof headerId === "string" ? headerId : queryId;
  let cursor: number;
  if (requested !== undefined && /^\d+$/.test(requested)) {
    cursor = Number(requested);
    const oldest = oldestOutboxSequence(db, namespace);
    const latest = latestOutboxSequence(db);
    if (cursor > latest || (oldest !== null && cursor < oldest - 1)) {
      send(null, "resync_required", { namespace, reason: cursor > latest ? "cursor_ahead" : "cursor_expired", sequence: latest });
      cursor = latest;
    }
  } else {
    cursor = latestOutboxSequence(db);
  }

  const flush = () => {
    for (;;) {
      const rows = readOutboxAfter(db, namespace, cursor, 500);
      for (const r of rows) {
        cursor = r.sequence;
        send(r.sequence, r.event_type, {
          sequence: r.sequence,
          type: r.event_type,
          namespace: r.namespace,
          aggregateId: r.aggregate_id,
          version: r.aggregate_version,
          payload: JSON.parse(r.payload_json) as Record<string, unknown>,
        });
      }
      if (rows.length < 500) break;
    }
  };
  flush();
  const unsubscribe = runtime.outbox.onCommitted((ns) => {
    if (ns === namespace) flush();
  });
  const heartbeat = setInterval(() => write(": heartbeat\n\n"), 15_000);
  const status = setInterval(() => {
    // One status computation per interval, however many viewers are connected.
    const s = runtime.sharedStatus(namespace);
    send(null, "source.status", {
      health: s.collector.health,
      lastMessageAt: s.collector.lastMessageAt,
      lastEventTimeMs: s.collector.lastEventTimeMs,
      price: s.price.state,
      packCount: s.packCount,
      session: s.session.active,
    });
  }, 5000);
  const cleanup = () => {
    clearInterval(heartbeat);
    clearInterval(status);
    unsubscribe();
  };
  raw.on("close", cleanup);
  raw.on("error", cleanup);
}
