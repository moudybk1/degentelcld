import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ApiError, Envelope, Mode, OperatorOverview, RadarFilters } from "@packlens/contracts";
import type { Runtime } from "../runtime.js";
import { isSolanaAddress } from "../lib/base58.js";
import { sha256Hex } from "../lib/ids.js";
import { canonicalJson } from "../lib/json.js";
import { parseDecimal } from "../lib/decimal.js";
import { cursorSecret } from "./cursor.js";
import { InvalidInputError, ReadModels } from "./readModels.js";
import { OperatorAuth, SESSION_COOKIE } from "./auth.js";
import { handleSse } from "./sse.js";
import { listManifests } from "../replay/dataset.js";
import { latestOutboxSequence } from "../ingest/outbox.js";
import { DECODER_VERSION } from "../collector/decoder.js";

type ErrorCode = ApiError["error"]["code"];

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const ANALYTICS_EVENTS = ["radar_viewed", "pack_opened", "wallet_opened", "evidence_opened", "smart_money_panel_viewed", "data_state_visible"] as const;

export function buildServer(runtime: Runtime, opts: { webDist?: string | null; logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true, genReqId: () => randomUUID(), bodyLimit: 64 * 1024, trustProxy: false });
  const db = runtime.db;
  const read = new ReadModels(db, runtime.clock, runtime.config, runtime.outbox, cursorSecret(db));
  const auth = new OperatorAuth(runtime.config.adminToken, runtime.clock, runtime.config.secureCookies, runtime.config.allowedOrigins);
  void app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      void reply.status(err.status).send({ error: { code: err.code, message: err.message, retryable: err.retryable, requestId: req.id } } satisfies ApiError);
      return;
    }
    if (err instanceof InvalidInputError) {
      void reply.status(400).send({ error: { code: "INVALID_INPUT", message: err.message, retryable: false, requestId: req.id } } satisfies ApiError);
      return;
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      void reply.status(e.statusCode).send({ error: { code: "INVALID_INPUT", message: "The request could not be processed.", retryable: false, requestId: req.id } } satisfies ApiError);
      return;
    }
    req.log.error(err);
    void reply.status(500).send({ error: { code: "INTERNAL", message: "An internal error occurred.", retryable: true, requestId: req.id } } satisfies ApiError);
  });

  const resolveNamespace = (req: FastifyRequest): { namespace: string; mode: Mode } => {
    const q = (req.query as Record<string, unknown>).namespace;
    const namespace = typeof q === "string" && q.length > 0 ? q : runtime.primaryNamespace;
    if (namespace.length > 200) throw new HttpError(400, "INVALID_INPUT", "Unknown namespace.");
    const mode = read.namespaceMode(namespace);
    if (!mode) throw new HttpError(404, "NOT_FOUND", "Unknown namespace.");
    return { namespace, mode };
  };

  const envelope = <T>(req: FastifyRequest, schemaVersion: string, namespace: string, mode: Mode, data: T): Envelope<T> => ({
    schemaVersion,
    namespace,
    mode,
    data,
    requestId: req.id,
  });

  const requireOperator = (req: FastifyRequest, mutation: boolean): void => {
    if (!auth.configured) throw new HttpError(403, "FORBIDDEN", "Operator access is not configured on this server.");
    const r = auth.authenticate(req);
    if (!r.ok) throw new HttpError(401, "UNAUTHORIZED", "Operator login required.");
    if (mutation && r.via === "cookie" && !auth.originAllowed(req)) throw new HttpError(403, "FORBIDDEN", "Cross-origin operator requests are not allowed.");
  };

  /** Idempotency: same key + same body returns the original response; a different body is a conflict. */
  const idempotent = <T>(req: FastifyRequest, route: string, body: unknown, run: () => T): T => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 128) throw new HttpError(400, "INVALID_INPUT", "An Idempotency-Key header is required.");
    const bodyHash = sha256Hex(canonicalJson(body ?? null));
    const existing = db.prepare("SELECT body_hash, response_json FROM idempotency_keys WHERE actor = 'operator' AND route = ? AND key = ?").get(route, key) as
      | { body_hash: string; response_json: string }
      | undefined;
    if (existing) {
      if (existing.body_hash !== bodyHash) throw new HttpError(409, "CONFLICT", "This Idempotency-Key was already used with a different request.");
      return JSON.parse(existing.response_json) as T;
    }
    const result = run();
    db.prepare("INSERT INTO idempotency_keys (actor, route, key, body_hash, response_json, created_at_ms) VALUES ('operator', ?, ?, ?, ?, ?)").run(
      route, key, bodyHash, JSON.stringify(result), runtime.clock.now(),
    );
    return result;
  };

  /* ---------------------------------------------------------------- */
  /* Public read routes (never spend credits)                         */
  /* ---------------------------------------------------------------- */

  app.get("/api/health", async () => {
    let dbOk = true;
    try {
      db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    return { status: dbOk ? "ok" : "degraded", database: dbOk ? "ok" : "error", mode: runtime.config.mode, time: new Date(runtime.clock.now()).toISOString() };
  });

  app.get("/api/status", async (req) => {
    const { namespace, mode } = resolveNamespace(req);
    return envelope(req, "status.v1", namespace, mode, runtime.status(namespace));
  });

  const ListQuery = z.object({
    namespace: z.string().optional(),
    cursor: z.string().max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    minWallets: z.coerce.number().int().min(3).default(3),
    minUsd: z.string().regex(/^\d+(\.\d+)?$/).default("0"),
    mint: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    confirmedSmartMoneyOnly: z.enum(["true", "false"]).default("false"),
    includeInvalidated: z.enum(["true", "false"]).default("false"),
  });

  app.get("/api/packs", async (req, reply) => {
    const { namespace, mode } = resolveNamespace(req);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, "INVALID_INPUT", `Invalid filter: ${parsed.error.issues[0]?.path.join(".") ?? "query"}.`);
    const q = parsed.data;
    if (q.mint && !isSolanaAddress(q.mint)) throw new HttpError(400, "INVALID_INPUT", "The mint filter must be a Solana token address.");
    for (const [k, v] of [["from", q.from], ["to", q.to]] as const) {
      if (v !== undefined && !Number.isFinite(Date.parse(v))) throw new HttpError(400, "INVALID_INPUT", `The ${k} filter must be an ISO UTC time.`);
    }
    const filters: RadarFilters = {
      minWallets: q.minWallets,
      minUsd: parseDecimal(q.minUsd).toFixed(),
      mint: q.mint ?? null,
      from: q.from ? new Date(Date.parse(q.from)).toISOString() : null,
      to: q.to ? new Date(Date.parse(q.to)).toISOString() : null,
      confirmedSmartMoneyOnly: q.confirmedSmartMoneyOnly === "true",
      includeInvalidated: q.includeInvalidated === "true",
    };
    const seq = latestOutboxSequence(db);
    const data = read.listPacks(namespace, filters, q.cursor ?? null, q.limit);
    void reply.header("X-Outbox-Sequence", String(seq));
    return { ...envelope(req, "pack-list.v1", namespace, mode, data), sequence: seq };
  });

  app.get("/api/packs/after", async (req) => {
    const raw = (req.query as { ids?: string }).ids ?? "";
    const ids = raw.split(",").filter(Boolean);
    if (ids.length === 0 || ids.length > 50 || !ids.every((id) => /^[0-9a-f]{64}$/.test(id))) throw new HttpError(400, "INVALID_INPUT", "Provide 1 to 50 pack IDs.");
    const { namespace, mode } = resolveNamespace(req);
    return envelope(req, "pack-after-summary.v1", namespace, mode, { items: read.afterSummaries(ids), asOf: new Date(runtime.clock.now()).toISOString() });
  });

  app.get("/api/packs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f]{64}$/.test(id)) throw new HttpError(400, "INVALID_INPUT", "Invalid pack ID.");
    const seq = latestOutboxSequence(db);
    const detail = read.packDetail(id);
    if (!detail) throw new HttpError(404, "NOT_FOUND", "Pack not found.");
    const requested = (req.query as Record<string, unknown>).namespace;
    if (typeof requested === "string" && requested !== detail.core.namespace) throw new HttpError(404, "NOT_FOUND", "Pack not found in this namespace.");
    const mode = read.namespaceMode(detail.core.namespace)!;
    void reply.header("X-Outbox-Sequence", String(seq));
    return { ...envelope(req, "pack-detail.v1", detail.core.namespace, mode, detail), sequence: seq };
  });

  app.get("/api/packs/:id/smart-money/evidence", async (req) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f]{64}$/.test(id)) throw new HttpError(400, "INVALID_INPUT", "Invalid pack ID.");
    const data = read.packSmartMoneyEvidence(id);
    if (!data) throw new HttpError(404, "NOT_FOUND", "Pack not found.");
    const p = db.prepare("SELECT namespace FROM packs WHERE id = ?").get(id) as { namespace: string };
    return envelope(req, "pack-smart-money-evidence.v1", p.namespace, read.namespaceMode(p.namespace)!, data);
  });

  app.get("/api/wallets/:chain/:address", async (req) => {
    const { chain, address } = req.params as { chain: string; address: string };
    if (chain !== "solana") throw new HttpError(400, "INVALID_INPUT", "Only Solana is supported.");
    if (!isSolanaAddress(address)) throw new HttpError(400, "INVALID_INPUT", "Invalid Solana wallet address.");
    const { namespace, mode } = resolveNamespace(req);
    return envelope(req, "wallet.v1", namespace, mode, read.walletPage(namespace, address));
  });

  app.get("/api/tokens/:chain/:address", async (req) => {
    const { chain, address } = req.params as { chain: string; address: string };
    if (chain !== "solana") throw new HttpError(400, "INVALID_INPUT", "Only Solana is supported.");
    if (!isSolanaAddress(address)) throw new HttpError(400, "INVALID_INPUT", "Invalid Solana token address.");
    const { namespace, mode } = resolveNamespace(req);
    return envelope(req, "token.v1", namespace, mode, read.tokenPage(namespace, address));
  });

  app.get("/api/smart-money/activity", async (req) => {
    const { namespace, mode } = resolveNamespace(req);
    const q = req.query as { cursor?: string; token?: string };
    if (q.token !== undefined && !isSolanaAddress(q.token)) throw new HttpError(400, "INVALID_INPUT", "Invalid token address.");
    return envelope(req, "smart-money-activity.v1", namespace, mode, read.smartMoneyActivity(namespace, q.cursor ?? null, q.token ?? null));
  });

  app.get("/api/events", async (req, reply) => {
    const { namespace } = resolveNamespace(req);
    handleSse(runtime, req, reply, namespace);
  });

  app.post("/api/analytics", async (req, reply) => {
    const body = z
      .object({ name: z.enum(ANALYTICS_EVENTS), screen: z.string().max(40), packId: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(), namespace: z.string().max(200).optional() })
      .safeParse(req.body);
    if (!body.success) throw new HttpError(400, "INVALID_INPUT", "Invalid analytics event.");
    const mode = read.namespaceMode(body.data.namespace ?? runtime.primaryNamespace) ?? runtime.config.mode;
    db.prepare("INSERT INTO analytics_events (name, mode, screen, pack_id, created_at_ms) VALUES (?, ?, ?, ?, ?)").run(body.data.name, mode, body.data.screen, body.data.packId ?? null, runtime.clock.now());
    void reply.status(204);
    return null;
  });

  /* ---------------------------------------------------------------- */
  /* Operator routes (authenticated)                                  */
  /* ---------------------------------------------------------------- */

  app.post("/api/admin/login", async (req, reply) => {
    if (!auth.configured) throw new HttpError(403, "FORBIDDEN", "Operator access is not configured on this server.");
    if (!auth.originAllowed(req)) throw new HttpError(403, "FORBIDDEN", "Cross-origin login is not allowed.");
    const body = z.object({ token: z.string().min(1).max(512) }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, "INVALID_INPUT", "Enter the operator token.");
    const result = auth.login(body.data.token, req.ip);
    if (result === "rate_limited") throw new HttpError(429, "RATE_LIMITED", "Too many login attempts. Wait a minute and try again.", true);
    if (result === null) throw new HttpError(401, "UNAUTHORIZED", "That operator token is not valid.");
    auth.setCookie(reply, result);
    return { authenticated: true };
  });

  app.post("/api/admin/logout", async (req, reply) => {
    auth.logout((req.cookies as Record<string, string | undefined>)[SESSION_COOKIE]);
    auth.clearCookie(reply);
    return { authenticated: false };
  });

  app.get("/api/admin/me", async (req) => {
    return { configured: auth.configured, authenticated: auth.configured && auth.authenticate(req).ok };
  });

  app.get("/api/admin/usage", async (req) => {
    requireOperator(req, false);
    return envelope(req, "usage.v1", runtime.primaryNamespace, runtime.config.mode, runtime.usage());
  });

  app.get("/api/admin/overview", async (req) => {
    requireOperator(req, false);
    const ns = runtime.primaryNamespace;
    const session = runtime.live?.session.current() ?? null;
    const jobs = (db.prepare("SELECT * FROM jobs ORDER BY enqueued_at_ms DESC LIMIT 30").all() as Record<string, unknown>[]).map((j) => ({
      id: j.id as string,
      lane: j.lane as "PRICE" | "BASE_ENRICHMENT" | "SMART_MONEY",
      type: j.type as string,
      subject: j.subject as string,
      status: j.status as string,
      statusReason: (j.status_reason as string | null) ?? null,
      attempts: j.attempts as number,
      enqueuedAt: new Date(j.enqueued_at_ms as number).toISOString(),
      finishedAt: j.finished_at_ms ? new Date(j.finished_at_ms as number).toISOString() : null,
    }));
    const overview: OperatorOverview = {
      status: runtime.status(ns),
      usage: runtime.usage(),
      jobs: { counts: runtime.queue.countsByStatus(), recent: jobs },
      session: {
        active: session !== null,
        id: session?.id ?? null,
        startedAt: session ? new Date(session.started_at_ms).toISOString() : null,
        endsAt: session ? new Date(session.ends_at_ms).toISOString() : null,
        smartMoneyEndsAt: session ? new Date(session.smart_money_ends_at_ms).toISOString() : null,
        configuredMaxEnd: runtime.config.nansen.sessionEndAtMs ? new Date(runtime.config.nansen.sessionEndAtMs).toISOString() : null,
      },
      datasets: listManifests(runtime.config.rootDir).map((m) => ({ id: m.datasetId, label: m.label, origin: m.origin, mode: m.mode, eventCount: m.eventCount, hash: m.sha256 })),
      replayRuns: (db.prepare("SELECT * FROM replay_runs ORDER BY started_at_ms DESC LIMIT 20").all() as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        datasetId: r.dataset_id as string,
        mode: r.mode as string,
        namespace: r.namespace as string,
        startedAt: new Date(r.started_at_ms as number).toISOString(),
        finishedAt: r.finished_at_ms ? new Date(r.finished_at_ms as number).toISOString() : null,
        resultHash: (r.result_hash as string | null) ?? null,
      })),
      demoPins: (db.prepare("SELECT mint, enabled, updated_at_ms FROM demo_pins WHERE namespace = ? ORDER BY updated_at_ms DESC").all(ns) as { mint: string; enabled: number; updated_at_ms: number }[]).map((p) => ({
        chain: "solana",
        mint: p.mint,
        enabled: p.enabled === 1,
        updatedAt: new Date(p.updated_at_ms).toISOString(),
      })),
      errors: (db.prepare("SELECT at_ms, component, code, message FROM operational_errors ORDER BY id DESC LIMIT 20").all() as { at_ms: number; component: string; code: string; message: string }[]).map((e) => ({
        at: new Date(e.at_ms).toISOString(),
        component: e.component,
        code: e.code,
        message: e.message,
      })),
      analytics: db.prepare("SELECT name, COUNT(*) AS count FROM analytics_events GROUP BY name ORDER BY name").all() as { name: string; count: number }[],
      config: {
        configVersion: runtime.config.detector.version,
        decoderVersion: DECODER_VERSION,
        smartMoneyEnabled: runtime.config.smartMoney.enabled,
        smartMoneyPollSeconds: runtime.config.smartMoney.pollSeconds,
        priceRefreshSeconds: runtime.config.price.refreshSeconds,
        enrichmentAutoPacksPerCycle: runtime.config.enrichment.autoPacksPerCycle,
      },
    };
    return envelope(req, "operator-overview.v1", ns, runtime.config.mode, overview);
  });

  app.post("/api/admin/enrich/:packId", async (req, reply) => {
    requireOperator(req, true);
    const { packId } = req.params as { packId: string };
    if (!/^[0-9a-f]{64}$/.test(packId)) throw new HttpError(400, "INVALID_INPUT", "Invalid pack ID.");
    const live = runtime.live;
    if (!live) throw new HttpError(409, "CONFLICT", "Enrichment requires live mode; fixture and replay never call providers.");
    const pack = db.prepare("SELECT namespace FROM packs WHERE id = ?").get(packId) as { namespace: string } | undefined;
    if (!pack) throw new HttpError(404, "NOT_FOUND", "Pack not found.");
    if (pack.namespace !== runtime.primaryNamespace) throw new HttpError(409, "CONFLICT", "Only packs in the live namespace can be enriched.");
    if (!live.session.current()) throw new HttpError(409, "BUDGET_PAUSED", "No active Nansen session. Start a session first.");
    const result = idempotent(req, `enrich:${packId}`, { packId }, () => ({ jobIds: live.scheduler.schedulePack(packId, "operator").jobIds }));
    void reply.status(202);
    return result;
  });

  app.post("/api/admin/smart-money/session", async (req) => {
    requireOperator(req, true);
    const live = runtime.live;
    if (!live) throw new HttpError(409, "CONFLICT", "Sessions exist only in live mode.");
    const body = z.object({ durationMinutes: z.number().int().min(1).max(24 * 60), smartMoneyDurationMinutes: z.number().int().min(1).max(24 * 60).optional() }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, "INVALID_INPUT", "Duration must be a whole number of minutes.");
    return idempotent(req, "session:start", body.data, () => {
      const now = runtime.clock.now();
      try {
        const s = live.session.start({
          endsAtMs: now + body.data.durationMinutes * 60_000,
          ...(body.data.smartMoneyDurationMinutes ? { smartMoneyEndsAtMs: now + body.data.smartMoneyDurationMinutes * 60_000 } : {}),
          startedBy: "operator",
        });
        return { id: s.id, endsAt: new Date(s.ends_at_ms).toISOString(), smartMoneyEndsAt: new Date(s.smart_money_ends_at_ms).toISOString() };
      } catch (err) {
        throw new HttpError(409, "CONFLICT", err instanceof Error ? err.message : "Session could not start.");
      }
    });
  });

  app.post("/api/admin/session/end", async (req) => {
    requireOperator(req, true);
    if (!runtime.live) throw new HttpError(409, "CONFLICT", "Sessions exist only in live mode.");
    runtime.live.session.end("operator");
    return { ended: true };
  });

  app.post("/api/admin/pause/clear", async (req) => {
    requireOperator(req, true);
    runtime.live?.client.clearPause();
    return { cleared: true };
  });

  app.post("/api/admin/replay", async (req) => {
    requireOperator(req, true);
    const body = z.object({ datasetId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/), mode: z.enum(["recorded-arrival", "historical-event-time"]).default("recorded-arrival") }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, "INVALID_INPUT", "Choose a registered dataset and replay mode.");
    if (!listManifests(runtime.config.rootDir).some((m) => m.datasetId === body.data.datasetId)) throw new HttpError(404, "NOT_FOUND", "Dataset is not registered.");
    return idempotent(req, "replay", body.data, () => runtime.runReplay(body.data.datasetId, body.data.mode));
  });

  app.post("/api/admin/demo-pins", async (req) => {
    requireOperator(req, true);
    const body = z.object({ chain: z.literal("solana"), mint: z.string(), enabled: z.boolean() }).safeParse(req.body);
    if (!body.success || !isSolanaAddress(body.data.mint)) throw new HttpError(400, "INVALID_INPUT", "Provide chain \"solana\", a token address, and enabled.");
    const ns = runtime.primaryNamespace;
    return idempotent(req, "demo-pins", body.data, () => {
      db.prepare(
        "INSERT INTO demo_pins (namespace, chain, mint, enabled, updated_at_ms) VALUES (?, 'solana', ?, ?, ?) ON CONFLICT(namespace, chain, mint) DO UPDATE SET enabled = excluded.enabled, updated_at_ms = excluded.updated_at_ms",
      ).run(ns, body.data.mint, body.data.enabled ? 1 : 0, runtime.clock.now());
      return { mint: body.data.mint, enabled: body.data.enabled };
    });
  });

  app.get("/api/admin/usage/manifest", async (req) => {
    requireOperator(req, false);
    const campaignId = runtime.config.nansen.campaignId;
    const rows = db
      .prepare(
        `SELECT u.campaign_id, u.attempt_id, u.started_at_ms, u.endpoint, u.parameter_hash, u.purpose, u.subject_id, u.http_status, u.normalization_status,
           u.provider_request_id, u.quoted_credits, u.actual_credits, u.reservation_status, u.retry_of_attempt_id, u.snapshot_id
         FROM api_usage u WHERE u.campaign_id = ? ORDER BY u.started_at_ms`,
      )
      .all(campaignId) as Record<string, unknown>[];
    return { campaignId, attempts: rows.map((r) => ({ ...r, started_at: new Date(r.started_at_ms as number).toISOString() })) };
  });

  app.all("/api/*", async () => {
    throw new HttpError(404, "NOT_FOUND", "Route not found.");
  });

  if (opts.webDist && existsSync(opts.webDist)) {
    // Files are resolved per request, so a rebuilt bundle is served without a restart.
    void app.register(fastifyStatic, {
      root: opts.webDist,
      prefix: "/",
      wildcard: true,
      index: false,
      setHeaders: (reply, path) => {
        void reply.header("Cache-Control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    const sendIndex = (reply: FastifyReply) => reply.type("text/html").header("Cache-Control", "no-cache").sendFile("index.html", { maxAge: 0 });
    app.get("/", (_req, reply) => sendIndex(reply));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        void reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found.", retryable: false, requestId: req.id } });
        return;
      }
      void sendIndex(reply);
    });
  }

  return app;
}

export function defaultWebDist(rootDir: string): string {
  return join(rootDir, "apps", "web", "dist");
}

export type { FastifyReply };
