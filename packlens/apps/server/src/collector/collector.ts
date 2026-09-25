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

/**
 * pump.fun collector over Solana logsSubscribe (commitment: confirmed).
 * Reconnects with jittered backoff (1s → 30s), records gaps, and treats a
 * silent stream as disconnected. The RPC URL is never logged with credentials.
 */
export class PumpCollector {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private openGapId: string | null = null;
  health: CollectorHealthState = "disconnected";
  lastMessageAtMs: number | null = null;
  connectedSinceMs: number | null = null;
  reconnects = 0;
  notifications = 0;
  failedTransactions = 0;

  constructor(
    private readonly wsUrl: string,
    private readonly clock: Clock,
    private readonly db: Db,
    private readonly namespace: string,
    private readonly onTransaction: (tx: RawTransaction) => void,
    private readonly onStatusChange: () => void = () => {},
  ) {}

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
    this.setHealth("connecting");
    const ws = new WebSocket(this.wsUrl, { handshakeTimeout: 15_000 });
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
      }
    }, 5000);
    this.watchdog.unref?.();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20_000);
    this.pingTimer.unref?.();
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
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
    if (value.err !== null && value.err !== undefined) {
      // Failed transactions never enter the detector (FR-01).
      this.failedTransactions++;
      return;
    }
    this.onTransaction({ signature: value.signature, slot, err: null, logs: value.logs, receivedAtMs });
  }
}
