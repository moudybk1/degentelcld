import WebSocket from "ws";
import type { Clock } from "../clock.js";
import { PUMP_PROGRAM_ID } from "../config.js";
import type { Db } from "../db/connection.js";
import { newId } from "../lib/ids.js";
import { log } from "../lib/log.js";

export type RawTransaction = {
  signature: string;
  slot: number;
  err: unknown;
  logs: string[];
  receivedAtMs: number;
};

export type CollectorHealthState = "connecting" | "connected" | "disconnected";

/** Consecutive connections that deliver no notification before the next endpoint is tried. */
export const FAILOVER_AFTER_FAILURES = 3;
/** Time on a fallback endpoint before the next reconnect tries the primary again. */
export const RETRY_PRIMARY_AFTER_MS = 30 * 60_000;
/** A connection that has not confirmed its subscription by now is abandoned. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Host only: keyed RPC URLs carry their credential in the query string. */
function endpointLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "[invalid url]";
  }
}

/**
 * pump.fun collector over Solana logsSubscribe (commitment: confirmed).
 * Reconnects with jittered backoff (1s → 30s), records gaps, and treats a
 * silent stream (or a subscription that never confirms) as disconnected.
 *
 * With a fallback endpoint, three connections in a row that deliver no
 * notification (refused, never confirmed, or confirmed and then silent or closed)
 * switch to the next endpoint, so a keyed RPC that runs out of credits does not stop
 * detection; after 30 minutes on a fallback, the next reconnect tries the primary
 * again. The RPC URL is never logged with credentials.
 */
export class PumpCollector {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private openGapId: string | null = null;
  private readonly wsUrls: string[];
  private urlIndex = 0;
  private failuresInRow = 0;
  private onFallbackSinceMs: number | null = null;
  private connectingSinceMs = 0;
  private notificationsThisConnection = 0;
  health: CollectorHealthState = "disconnected";
  lastMessageAtMs: number | null = null;
  connectedSinceMs: number | null = null;
  reconnects = 0;
  notifications = 0;
  failedTransactions = 0;

  constructor(
    wsUrls: string | string[],
    private readonly clock: Clock,
    private readonly db: Db,
    private readonly namespace: string,
    private readonly onTransaction: (tx: RawTransaction) => void,
    private readonly onStatusChange: () => void = () => {},
  ) {
    this.wsUrls = (Array.isArray(wsUrls) ? wsUrls : [wsUrls]).filter((u, i, all) => u && all.indexOf(u) === i);
    if (this.wsUrls.length === 0) throw new Error("PumpCollector needs a WebSocket URL");
  }

  /** "primary" or "fallback": which endpoint the collector is using. */
  get endpoint(): "primary" | "fallback" {
    return this.urlIndex === 0 ? "primary" : "fallback";
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = null;
    this.openGap("collector_stopped");
    this.health = "disconnected";
  }

  private setHealth(h: CollectorHealthState): void {
    if (this.health !== h) {
      this.health = h;
      this.onStatusChange();
    }
  }

  private openGap(reason: string): void {
    if (this.openGapId) return;
    const id = newId("gap");
    const started = this.lastMessageAtMs ?? this.clock.now();
    this.db
      .prepare("INSERT INTO collector_gaps (id, namespace, started_at_ms, reason, recovery_state) VALUES (?, ?, ?, ?, 'open')")
      .run(id, this.namespace, started, reason);
    this.openGapId = id;
  }

  /**
   * Close every open gap in this namespace once the stream is back, including
   * one left open by a previous process (shutdown or crash). Backfill is not
   * performed in P0, so gaps stay labeled as unrecovered.
   */
  private closeGap(): void {
    this.db
      .prepare("UPDATE collector_gaps SET ended_at_ms = ?, recovery_state = 'closed_unrecovered' WHERE namespace = ? AND recovery_state = 'open'")
      .run(this.clock.now(), this.namespace);
    this.openGapId = null;
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.urlIndex !== 0 && this.onFallbackSinceMs !== null && this.clock.now() - this.onFallbackSinceMs >= RETRY_PRIMARY_AFTER_MS) {
      this.useEndpoint(0, "retrying the primary");
    }
    this.setHealth("connecting");
    this.connectingSinceMs = this.clock.now();
    this.notificationsThisConnection = 0;
    const ws = new WebSocket(this.wsUrls[this.urlIndex]!, { handshakeTimeout: 15_000 });
    this.ws = ws;
    ws.on("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: "confirmed" }] }));
    });
    ws.on("message", (data) => this.handleMessage(data.toString()));
    ws.on("error", (err) => {
      log("warn", "collector", "WebSocket error", { error: err.message });
    });
    ws.on("close", (code) => {
      log("warn", "collector", "WebSocket closed", { code });
      this.scheduleReconnect("websocket_closed");
    });
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      const last = this.lastMessageAtMs ?? 0;
      if (this.health === "connected" && this.clock.now() - last > 30_000) {
        log("warn", "collector", "Stream silent for 30 seconds; reconnecting");
        ws.terminate();
      } else if (this.health === "connecting" && this.clock.now() - this.connectingSinceMs > CONNECT_TIMEOUT_MS) {
        log("warn", "collector", "Subscription not confirmed within 30 seconds; reconnecting");
        ws.terminate();
      }
    }, 5000);
    this.watchdog.unref?.();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20_000);
    this.pingTimer.unref?.();
  }

  private useEndpoint(index: number, why: string): void {
    this.urlIndex = index;
    this.failuresInRow = 0;
    this.backoffMs = 1000;
    this.onFallbackSinceMs = index === 0 ? null : this.clock.now();
    log("warn", "collector", `Using the ${index === 0 ? "primary" : "fallback"} RPC endpoint (${why})`, { endpoint: endpointLabel(this.wsUrls[index]!) });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
    // A connection that delivered no notification counts against this endpoint (pump.fun sends many per second).
    if (this.notificationsThisConnection === 0) this.failuresInRow++;
    if (this.wsUrls.length > 1 && this.failuresInRow >= FAILOVER_AFTER_FAILURES) {
      this.useEndpoint((this.urlIndex + 1) % this.wsUrls.length, `${this.failuresInRow} connects in a row failed`);
    }
    this.openGap(reason);
    this.setHealth("disconnected");
    this.connectedSinceMs = null;
    this.reconnects++;
    const delay = Math.floor(Math.random() * this.backoffMs) + 250;
    this.backoffMs = Math.min(30_000, this.backoffMs * 2);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  private handleMessage(text: string): void {
    const receivedAtMs = this.clock.now();
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: { result?: { context?: { slot?: number }; value?: { signature?: string; err?: unknown; logs?: string[] } } } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id === 1) {
      if (msg.error) {
        log("error", "collector", "logsSubscribe rejected", { error: msg.error.message });
        this.ws?.terminate();
        return;
      }
      this.setHealth("connected");
      this.connectedSinceMs = receivedAtMs;
      this.backoffMs = 1000;
      this.closeGap();
      this.lastMessageAtMs = receivedAtMs;
      return;
    }
    if (msg.method !== "logsNotification") return;
    const value = msg.params?.result?.value;
    const slot = msg.params?.result?.context?.slot;
    if (!value || typeof value.signature !== "string" || typeof slot !== "number" || !Array.isArray(value.logs)) return;
    this.lastMessageAtMs = receivedAtMs;
    this.notifications++;
    if (this.notificationsThisConnection++ === 0) this.failuresInRow = 0;
    if (value.err !== null && value.err !== undefined) {
      // Failed transactions never enter the detector (FR-01).
      this.failedTransactions++;
      return;
    }
    this.onTransaction({ signature: value.signature, slot, err: null, logs: value.logs, receivedAtMs });
  }
}
