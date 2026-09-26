import type { DetectionRule, SourceStatus, UsageSummary } from "@packlens/contracts";
import { SystemClock, type Clock } from "./clock.js";
import { BASELINE_DETECTOR_CONFIG, detectorConfigForVersion, liveNamespace, PYTH_SOL_USD_ACCOUNT, type AppConfig } from "./config.js";
import { migrate, openDatabase, type Db } from "./db/connection.js";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { OutboxBus } from "./ingest/outbox.js";
import { DetectorEngine } from "./ingest/engine.js";
import { IngestPipeline } from "./ingest/pipeline.js";
import { PriceStore } from "./prices/store.js";
import { PricePoller } from "./prices/poller.js";
import { PythPriceFeed } from "./prices/pyth.js";
import type { QuotePriceFeed } from "./prices/feed.js";
import { PumpCollector, type RawTransaction } from "./collector/collector.js";
import { decodeLogs, DECODER_VERSION } from "./collector/decoder.js";
import { normalizeTrade } from "./normalization/normalize.js";
import { NansenClient, type FetchLike } from "./adapters/nansen/client.js";
import { BudgetLedger } from "./scheduler/budget.js";
import { DispatchGate } from "./scheduler/gate.js";
import { SessionManager } from "./scheduler/session.js";
import { JobQueue } from "./scheduler/queue.js";
import { SmartMoneyService } from "./smart-money/service.js";
import { AssessmentService } from "./assessment/assessment.js";
import { EnrichmentWorker } from "./enrichment/worker.js";
import { EnrichmentScheduler, PACK_ENRICHMENT_CREDITS } from "./enrichment/scheduler.js";
import { loadDataset, listManifests } from "./replay/dataset.js";
import { runDataset, type ReplayMode } from "./replay/runner.js";
import { seedFixtureContext } from "./replay/fixtureContext.js";
import { newId } from "./lib/ids.js";
import { log } from "./lib/log.js";
import { RetentionJob } from "./operations/retention.js";
import { TokenImageResolver } from "./metadata/tokenImages.js";
import { CatchUpGuard } from "./ingest/catchUp.js";

export type DecoderCounters = { decodedEvents: number; buys: number; sells: number; undecodable: number; truncatedLogs: number; creates: number };

type NamespaceCounts = { decoded: number; buys: number; sells: number; eligible: number; late: number; unvalued: number };
type NamespaceCountsRow = { decoded: number; buys: number | null; sells: number | null; eligible: number | null; late: number | null; unvalued: number | null };

const NAMESPACE_COUNTS_SQL = `SELECT COUNT(*) AS decoded, SUM(side = 'buy') AS buys, SUM(side = 'sell') AS sells, SUM(eligibility = 'eligible') AS eligible,
  SUM(admission = 'late') AS late, SUM(valuation_status <> 'valued') AS unvalued FROM trade_events WHERE namespace = ?`;

/** Archived namespaces change only through retention, so their totals are recounted at most every 10 minutes. */
const ARCHIVE_COUNTS_TTL_MS = 10 * 60_000;

/** Worker thread body (CommonJS, run with eval): one read-only connection, one count per message. */
const COUNTS_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.driver);
const db = new Database(workerData.path, { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 5000");
const stmt = db.prepare(workerData.sql);
parentPort.on("message", (m) => {
  try {
    parentPort.postMessage({ namespace: m.namespace, row: stmt.get(m.namespace) });
  } catch (err) {
    parentPort.postMessage({ namespace: m.namespace, error: String((err && err.message) || err) });
  }
});
`;

function namespaceCounts(r: NamespaceCountsRow): NamespaceCounts {
  return { decoded: r.decoded, buys: r.buys ?? 0, sells: r.sells ?? 0, eligible: r.eligible ?? 0, late: r.late ?? 0, unvalued: r.unvalued ?? 0 };
}

export type LiveComponents = {
  pipeline: IngestPipeline;
  engine: DetectorEngine;
  priceStore: PriceStore;
  collector: PumpCollector | null;
  client: NansenClient;
  ledger: BudgetLedger;
  gate: DispatchGate;
  session: SessionManager;
  queue: JobQueue;
  worker: EnrichmentWorker;
  scheduler: EnrichmentScheduler;
  smartMoney: SmartMoneyService;
  assessment: AssessmentService;
  pricePoller: QuotePriceFeed;
  decoder: DecoderCounters;
};

export class Runtime {
  readonly outbox = new OutboxBus();
  primaryNamespace: string;
  live: LiveComponents | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  /** Live transaction handler (collector callback); exposed for integration tests. */
  handleTransaction: (tx: RawTransaction) => void = () => {
    throw new Error("Live runtime is not started");
  };
  private retention: RetentionJob | null = null;
  private tokenImages: TokenImageResolver | null = null;
  /** Live watermark guard (exposed for diagnostics). */
  catchUp: CatchUpGuard | null = null;
  readonly queue: JobQueue;

  private constructor(
    readonly config: AppConfig,
    readonly db: Db,
    readonly clock: Clock,
    private readonly fetchImpl: FetchLike | undefined,
    private readonly startCollector: boolean,
    private readonly rpcFetchImpl: FetchLike | undefined = undefined,
  ) {
    this.primaryNamespace = config.mode === "live" ? liveNamespace(config) : `fixture:${config.fixtureDatasetId}`;
    this.queue = new JobQueue(db, clock);
  }

  /** `startCollector: false` keeps tests off the network; production always collects. */
  /** `rpcFetchImpl` answers Solana RPC reads (the Pyth price) in tests; production uses global fetch. */
  static create(config: AppConfig, opts: { clock?: Clock; fetchImpl?: FetchLike; rpcFetchImpl?: FetchLike; db?: Db; startCollector?: boolean } = {}): Runtime {
    const clock = opts.clock ?? new SystemClock();
    const db = opts.db ?? openDatabase(config.databasePath);
    migrate(db, join(config.rootDir, "migrations"), clock.now());
    return new Runtime(config, db, clock, opts.fetchImpl, opts.startCollector ?? true, opts.rpcFetchImpl);
  }

  /**
   * Seed the fixture namespace from its registered synthetic dataset if empty.
   * When the registered dataset changed since it was seeded, the synthetic
   * namespace is rebuilt; live and replay namespaces are never touched.
   */
  ensureFixture(datasetId: string = this.config.fixtureDatasetId): string {
    const ns = `fixture:${datasetId}`;
    const { dataset, manifest } = loadDataset(this.config.rootDir, datasetId);
    const existing = this.db.prepare("SELECT COUNT(*) AS n FROM trade_events WHERE namespace = ?").get(ns) as { n: number };
    const seeded = this.db.prepare("SELECT dataset_hash FROM namespaces WHERE id = ?").get(ns) as { dataset_hash: string | null } | undefined;
    if (existing.n > 0 && seeded?.dataset_hash === manifest.sha256) return ns;
    if (seeded) {
      this.dropFixtureNamespace(ns);
      log("info", "runtime", "Fixture dataset changed; rebuilt the fixture namespace", { namespace: ns });
    }
    const result = runDataset({
      db: this.db, outbox: this.outbox, config: this.config, dataset, datasetHash: manifest.sha256, namespace: ns, namespaceMode: "fixture",
      replayMode: "recorded-arrival", label: `Fixture: ${manifest.label}`,
    });
    seedFixtureContext(this.db, this.outbox, this.config, ns, dataset);
    log("info", "runtime", "Fixture namespace seeded", { namespace: ns, packs: result.packIds.length, events: result.events });
    return ns;
  }

  private dropFixtureNamespace(ns: string): void {
    if (!ns.startsWith("fixture:")) throw new Error("Only fixture namespaces can be rebuilt");
    const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map((t) => t.name)
      .filter((t) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === "namespace"));
    this.db.transaction(() => {
      this.db.pragma("defer_foreign_keys = ON");
      for (const t of tables) this.db.prepare(`DELETE FROM ${t} WHERE namespace = ?`).run(ns);
      this.db.prepare("DELETE FROM namespaces WHERE id = ?").run(ns);
    })();
  }

  /** Replay a registered dataset into a new, clearly labeled namespace. No provider calls. */
  runReplay(datasetId: string, mode: ReplayMode): { runId: string; namespace: string; digest: string; packCount: number } {
    const { dataset, manifest } = loadDataset(this.config.rootDir, datasetId);
    const runId = newId("run").replace("run_", "");
    const ns = `replay:${runId}`;
    const startedAt = this.clock.now();
    const result = runDataset({
      db: this.db, outbox: this.outbox, config: this.config, dataset, datasetHash: manifest.sha256, namespace: ns, namespaceMode: "replay",
      replayMode: mode, label: `Replay of ${manifest.label} (${mode})`,
    });
    if (dataset.mode === "fixture") seedFixtureContext(this.db, this.outbox, this.config, ns, dataset);
    this.db
      .prepare(
        `INSERT INTO replay_runs (id, namespace, dataset_id, dataset_hash, config_version, mode, clock_json, started_at_ms, finished_at_ms, result_hash, report_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, ns, datasetId, manifest.sha256, dataset.configVersion, mode, JSON.stringify({ kind: "virtual", tickMs: 250 }), startedAt, this.clock.now(), result.digest,
        JSON.stringify({ events: result.events, late: result.late, eligible: result.eligible, packs: result.packIds.length, duplicates: result.duplicates }));
    return { runId, namespace: ns, digest: result.digest, packCount: result.packIds.length };
  }

  start(): void {
    if (this.config.mode === "fixture") {
      this.primaryNamespace = this.ensureFixture();
    } else if (this.config.mode === "replay") {
      const latest = this.db.prepare("SELECT namespace FROM replay_runs ORDER BY started_at_ms DESC LIMIT 1").get() as { namespace: string } | undefined;
      if (latest) this.primaryNamespace = latest.namespace;
      else {
        const first = listManifests(this.config.rootDir)[0];
        if (!first) throw new Error("No registered dataset is available for replay mode");
        this.primaryNamespace = this.runReplay(first.datasetId, "recorded-arrival").namespace;
      }
    } else {
      this.startLive();
    }
    this.retention = new RetentionJob(this.db, this.clock);
    this.retention.start();
  }

  private startLive(): void {
    const cfg = this.config;
    const ns = this.primaryNamespace;
    const db = this.db;
    const clock = this.clock;
    const baseNs = `live:${cfg.nansen.campaignId}`;
    const label = ns === baseNs ? `Live campaign ${cfg.nansen.campaignId}` : `Live campaign ${cfg.nansen.campaignId}, rule ${cfg.detector.version}`;
    const created = db.prepare("INSERT INTO namespaces (id, mode, created_at_ms, label) VALUES (?, 'live', ?, ?) ON CONFLICT(id) DO NOTHING").run(ns, clock.now(), label);
    if (created.changes === 1 && ns !== baseNs) {
      // A new rule starts with no packs, but token identity (name, symbol, launch time) is a chain
      // fact independent of the rule: carry over the last day so recent tokens keep their names.
      const cols = (db.prepare("PRAGMA table_info(tokens)").all() as { name: string }[]).map((c) => c.name).filter((c) => c !== "namespace").join(", ");
      db.prepare(`INSERT OR IGNORE INTO tokens (namespace, ${cols}) SELECT ?, ${cols} FROM tokens WHERE namespace = ? AND first_seen_at_ms >= ?`).run(ns, baseNs, clock.now() - 24 * 60 * 60_000);
    }
    // Pyth prices cost no credits, so nothing is held back for price polling.
    const priceReserve = () => (cfg.price.provider === "nansen" ? cfg.price.reservePolls * cfg.price.quotes.length * 1 : 0);
    const ledger = new BudgetLedger(db, cfg.nansen.campaignId, clock, priceReserve, cfg.nansen.dailyCreditCap);
    ledger.ensureCampaign(cfg.nansen.budgetCredits!, cfg.nansen.sessionEndAtMs);
    const session = new SessionManager(db, clock, cfg, cfg.nansen.campaignId);
    const gate = new DispatchGate(cfg.nansen.maxConcurrency, cfg.nansen.maxRequestsPerMinute, clock);
    const client = new NansenClient({
      db, clock, namespace: ns, ledger, gate, apiKey: cfg.nansen.apiKey!, baseUrl: cfg.nansen.baseUrl, timeoutMs: cfg.nansen.timeoutMs,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}), session,
    });
    const priceStore = new PriceStore(db, ns, clock);
    const assessment = new AssessmentService(db, clock, this.outbox, cfg.holderConcentrationThreshold);
    const smartMoney = new SmartMoneyService(db, ns, clock, this.outbox, client);
    const scheduler = new EnrichmentScheduler(db, clock, cfg, ns, this.queue, session, assessment, ledger);
    const engine = new DetectorEngine(db, ns, cfg.detector, clock, this.outbox, { onPacksCreated: () => scheduler.onPacksCreated() });
    const pipeline = new IngestPipeline(db, ns, clock, engine, cfg.detector.reorderToleranceMs);
    const worker = new EnrichmentWorker(db, clock, this.queue, client, smartMoney, assessment, session, cfg.nansen.maxConcurrency);
    const pricePoller: QuotePriceFeed =
      cfg.price.provider === "pyth" ? new PythPriceFeed(cfg, clock, priceStore, this.rpcFetchImpl) : new PricePoller(cfg, clock, client, priceStore, session);
    const priceSource =
      cfg.price.provider === "pyth"
        ? `pyth:onchain:${PYTH_SOL_USD_ACCOUNT}:${cfg.price.policy.version}`
        : `nansen:tgm/token-ohlcv:${cfg.price.policy.timeframe}:closed_only:${cfg.price.policy.version}`;
    const decoder: DecoderCounters = { decodedEvents: 0, buys: 0, sells: 0, undecodable: 0, truncatedLogs: 0, creates: 0 };
    // Newest on-chain event time read from the stream; tells the catch-up guard when a backlog is drained.
    let newestStreamEventMs: number | null = null;

    const upsertToken = db.prepare(
      `INSERT INTO tokens (namespace, chain, mint, name, symbol, uri, creator, create_signature, created_event_time_ms, first_seen_at_ms, token_total_supply_raw)
       VALUES (?, 'solana', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace, chain, mint) DO UPDATE SET name = COALESCE(tokens.name, excluded.name), symbol = COALESCE(tokens.symbol, excluded.symbol),
         uri = COALESCE(tokens.uri, excluded.uri), creator = COALESCE(tokens.creator, excluded.creator), create_signature = COALESCE(tokens.create_signature, excluded.create_signature),
         created_event_time_ms = COALESCE(tokens.created_event_time_ms, excluded.created_event_time_ms), token_total_supply_raw = COALESCE(tokens.token_total_supply_raw, excluded.token_total_supply_raw)`,
    );
    const completeToken = db.prepare(
      `INSERT INTO tokens (namespace, chain, mint, first_seen_at_ms, completed_at_ms, complete_signature) VALUES (?, 'solana', ?, ?, ?, ?)
       ON CONFLICT(namespace, chain, mint) DO UPDATE SET completed_at_ms = COALESCE(tokens.completed_at_ms, excluded.completed_at_ms),
         complete_signature = COALESCE(tokens.complete_signature, excluded.complete_signature)`,
    );
    const onTransaction = (tx: RawTransaction) => {
      const decoded = decodeLogs(tx.logs);
      decoder.undecodable += decoded.errors;
      if (decoded.truncated) decoder.truncatedLogs++;
      for (const c of decoded.creates) {
        decoder.creates++;
        upsertToken.run(ns, c.mint, c.name.slice(0, 200), c.symbol.slice(0, 40), c.uri.slice(0, 500), c.creator, tx.signature, c.timestampSec === null ? null : c.timestampSec * 1000, tx.receivedAtMs, c.totalSupplyRaw);
      }
      for (const c of decoded.completes) completeToken.run(ns, c.mint, tx.receivedAtMs, c.timestampSec * 1000, tx.signature);
      for (const t of decoded.trades) {
        decoder.decodedEvents++;
        if (newestStreamEventMs === null || t.timestampSec * 1000 > newestStreamEventMs) newestStreamEventMs = t.timestampSec * 1000;
        if (t.isBuy) decoder.buys++;
        else decoder.sells++;
        try {
          const ev = normalizeTrade(t, {
            namespace: ns, sourceMode: "live", signature: tx.signature, slot: tx.slot, receivedAtMs: tx.receivedAtMs, normalizedAtMs: clock.now(),
            quotes: cfg.price.quotes, snapshotsFor: (m) => priceStore.snapshotsFor(m),
            maxPriceAgeMs: { maxCandleAgeMs: cfg.price.policy.maxCandleAgeMs, maxFetchAgeMs: cfg.price.policy.maxFetchAgeMs },
            priceSource,
          });
          pipeline.ingest(ev);
        } catch (err) {
          decoder.undecodable++;
          log("warn", "collector", "Normalization failed", { signature: tx.signature, error: String(err) });
        }
      }
    };
    this.handleTransaction = onTransaction;
    const collector = cfg.rpc.wsUrl && this.startCollector ? new PumpCollector(cfg.rpc.wsUrl, clock, db, ns, onTransaction) : null;
    // Display-only logos for packed tokens; off whenever the collector is (tests stay off the network).
    this.tokenImages = this.startCollector ? new TokenImageResolver(db, clock, ns) : null;

    // Start the live session bounded by NANSEN_SESSION_END_AT. Continuous sessions start
    // on first use; with Pyth prices and neither setting, Nansen stays off.
    if (cfg.nansen.sessionEndAtMs !== null && !session.current()) session.start({ startedBy: "startup" });

    this.live = { pipeline, engine, priceStore, collector, client, ledger, gate, session, queue: this.queue, worker, scheduler, smartMoney, assessment, pricePoller, decoder };
    // The Pyth feed reads the chain, so it follows the collector's network switch (tests stay offline).
    if (cfg.price.provider === "nansen" || this.startCollector || this.rpcFetchImpl) pricePoller.start();
    worker.start();
    scheduler.start();
    collector?.start();
    this.tokenImages?.start();
    const TICK_MS = 250;
    const catchUp = new CatchUpGuard(
      clock,
      { tickMs: TICK_MS, stallMs: 400, currentMs: cfg.detector.reorderToleranceMs, maxHoldMs: 20_000 },
      (info) => log("info", "ingest", "Watermark held while the stream caught up after an event-loop stall", info),
    );
    this.catchUp = catchUp;
    this.tickTimer = setInterval(() => {
      try {
        if (catchUp.mayAdvance(newestStreamEventMs)) pipeline.tick();
      } catch (err) {
        log("error", "ingest", "Watermark tick failed; no update was published", { error: String(err) });
      }
    }, TICK_MS);
    this.tickTimer.unref?.();
    const s = session.current();
    log("info", "runtime", "Live runtime started", {
      namespace: ns,
      price: cfg.price.policy.version,
      nansen: s ? (cfg.nansen.continuous ? "continuous" : "session") : "off",
      sessionEndsAt: s ? new Date(s.ends_at_ms).toISOString() : null,
      dailyCreditCap: cfg.nansen.dailyCreditCap,
    });
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    await this.countsWorker?.terminate();
    this.countsWorker = null;
    this.retention?.stop();
    this.tokenImages?.stop();
    if (this.live) {
      this.live.collector?.stop();
      this.live.pricePoller.stop();
      this.live.scheduler.stop();
      await this.live.worker.stop(10_000);
      this.live.gate.close();
      try {
        this.live.pipeline.tick();
      } catch {
        /* checkpoints already persisted by the last successful tick */
      }
    }
    this.db.close();
  }

  namespaces(): { id: string; mode: "fixture" | "live" | "replay"; createdAt: string }[] {
    return (this.db.prepare("SELECT id, mode, created_at_ms FROM namespaces ORDER BY created_at_ms DESC").all() as { id: string; mode: "fixture" | "live" | "replay"; created_at_ms: number }[]).map((n) => ({
      id: n.id,
      mode: n.mode,
      createdAt: new Date(n.created_at_ms).toISOString(),
    }));
  }

  /** The rule a namespace's packs were detected under: live uses the configured rule, replays their dataset's. */
  detectionRule(namespace: string): DetectionRule {
    let d = this.config.detector;
    if (!(this.live && namespace === this.primaryNamespace)) {
      const row =
        (this.db.prepare("SELECT config_version AS v FROM replay_runs WHERE namespace = ? ORDER BY started_at_ms DESC LIMIT 1").get(namespace) as { v: string } | undefined) ??
        (this.db.prepare("SELECT config_version AS v FROM packs WHERE namespace = ? LIMIT 1").get(namespace) as { v: string } | undefined);
      d = (row && detectorConfigForVersion(row.v)) ?? BASELINE_DETECTOR_CONFIG;
    }
    return {
      version: d.version, minUniqueWallets: d.minUniqueWallets, minTradeUsd: d.minTradeUsd,
      triggerWindowSeconds: d.triggerWindowMs / 1000, expansionSeconds: d.expansionFromStartMs / 1000, isBaseline: d.version === BASELINE_DETECTOR_CONFIG.version,
    };
  }

  private readonly statusMemo = new Map<string, { at: number; value: SourceStatus }>();

  /**
   * Stored-buy totals of archived live namespaces (an earlier rule or campaign). Counting them
   * scans every stored trade of the namespace: about 30 s for a million rows, which on the main
   * thread would freeze the collector and the API. They are counted on a worker thread with its
   * own read-only connection, kept for ARCHIVE_COUNTS_TTL_MS, and persisted across restarts.
   */
  private readonly archiveCounts = new Map<string, { at: number; counts: NamespaceCounts }>();
  private readonly archiveCounting = new Set<string>();
  private countsWorker: Worker | null = null;

  private archivedCounts(namespace: string): NamespaceCounts | null {
    const now = Date.now();
    let hit = this.archiveCounts.get(namespace);
    if (!hit) {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`status_counts:${namespace}`) as { value: string } | undefined;
      if (row) {
        try {
          hit = JSON.parse(row.value) as { at: number; counts: NamespaceCounts };
          this.archiveCounts.set(namespace, hit);
        } catch {
          /* recount below */
        }
      }
    }
    if (!hit || now - hit.at > ARCHIVE_COUNTS_TTL_MS) this.countInBackground(namespace);
    // An in-memory database is counted synchronously, so a fresh entry may exist now.
    return (this.archiveCounts.get(namespace) ?? hit)?.counts ?? null;
  }

  private storeArchivedCounts(namespace: string, counts: NamespaceCounts): void {
    const entry = { at: Date.now(), counts };
    this.archiveCounts.set(namespace, entry);
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`status_counts:${namespace}`, JSON.stringify(entry));
    this.statusMemo.delete(namespace);
  }

  private countInBackground(namespace: string): void {
    if (this.archiveCounting.has(namespace)) return;
    if (this.config.databasePath === ":memory:") {
      // Tests and in-memory databases are small, and a worker cannot open them.
      this.storeArchivedCounts(namespace, namespaceCounts(this.db.prepare(NAMESPACE_COUNTS_SQL).get(namespace) as NamespaceCountsRow));
      return;
    }
    this.archiveCounting.add(namespace);
    if (!this.countsWorker) {
      const worker = new Worker(COUNTS_WORKER_SOURCE, {
        eval: true,
        workerData: { driver: createRequire(import.meta.url).resolve("better-sqlite3"), path: this.config.databasePath, sql: NAMESPACE_COUNTS_SQL },
      });
      worker.unref();
      worker.on("message", (m: { namespace: string; row?: NamespaceCountsRow; error?: string }) => {
        this.archiveCounting.delete(m.namespace);
        if (m.row) this.storeArchivedCounts(m.namespace, namespaceCounts(m.row));
        else log("warn", "runtime", "Counting an archived namespace failed", { namespace: m.namespace, error: m.error });
      });
      worker.on("error", (err) => {
        log("error", "runtime", "Namespace counting worker failed", { error: err.message });
        this.archiveCounting.clear();
        this.countsWorker = null;
      });
      this.countsWorker = worker;
    }
    this.countsWorker.postMessage({ namespace });
  }

  /** status() shared by every live-stream connection for up to `maxAgeMs` of wall-clock time. */
  sharedStatus(namespace: string, maxAgeMs = 4000): SourceStatus {
    const now = Date.now();
    const hit = this.statusMemo.get(namespace);
    if (hit && now - hit.at < maxAgeMs) return hit.value;
    const value = this.status(namespace);
    this.statusMemo.set(namespace, { at: now, value });
    return value;
  }

  status(namespace: string): SourceStatus {
    const nsRow = this.db.prepare("SELECT mode FROM namespaces WHERE id = ?").get(namespace) as { mode: "fixture" | "live" | "replay" } | undefined;
    const mode = nsRow?.mode ?? this.config.mode;
    const packs = this.db.prepare("SELECT COUNT(*) AS n, MAX(trigger_event_time_ms) AS latest FROM packs WHERE namespace = ?").get(namespace) as { n: number; latest: number | null };
    const lastEvent = this.db.prepare("SELECT MAX(event_time_ms) AS t FROM trade_events WHERE namespace = ?").get(namespace) as { t: number | null };
    const gaps = this.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN recovery_state = 'open' THEN 1 ELSE 0 END) AS open FROM collector_gaps WHERE namespace = ?").get(namespace) as { total: number; open: number | null };
    const isLive = this.live !== null && namespace === this.primaryNamespace;
    const c = isLive ? this.live!.pipeline.counters : null;
    // Archived live namespaces are large and counted in the background; fixture and replay data are small.
    const archived = !isLive && mode === "live";
    const dbCounts: NamespaceCounts | null = isLive
      ? null
      : archived
        ? this.archivedCounts(namespace)
        : namespaceCounts(this.db.prepare(NAMESPACE_COUNTS_SQL).get(namespace) as NamespaceCountsRow);
    const session = this.live?.session.current() ?? null;
    const q = this.config.price.quotes[0]!;
    const priceStatus = isLive ? this.live!.pricePoller.status(q) : null;
    const collector = this.live?.collector ?? null;
    return {
      namespace,
      mode,
      source: "pumpfun",
      chain: "solana",
      commitment: "confirmed",
      decoderVersion: DECODER_VERSION,
      collector: {
        health: isLive ? (collector ? collector.health : "not_configured") : mode === "fixture" ? "fixture" : "replay",
        lastMessageAt: collector?.lastMessageAtMs && isLive ? new Date(collector.lastMessageAtMs).toISOString() : null,
        lastEventTimeMs: lastEvent.t,
        connectedSince: collector?.connectedSinceMs && isLive ? new Date(collector.connectedSinceMs).toISOString() : null,
        reconnects: isLive ? collector?.reconnects ?? 0 : 0,
      },
      price: {
        state: priceStatus ? priceStatus.state : "not_applicable",
        latestCandleStart: priceStatus?.latestCandleStartMs ? new Date(priceStatus.latestCandleStartMs).toISOString() : null,
        latestSnapshotAvailableAt: priceStatus?.latestAvailableAtMs ? new Date(priceStatus.latestAvailableAtMs).toISOString() : null,
        quoteMints: this.config.price.quotes.map((x) => x.priceMint),
        provider: this.config.price.policy.provider,
        timeframe: this.config.price.policy.timeframe,
        policyVersion: this.config.price.policy.version,
        isBaseline: this.config.price.policy.isBaseline,
      },
      counters: isLive
        ? {
            notifications: collector?.notifications ?? 0,
            failedTransactions: collector?.failedTransactions ?? 0,
            decodedEvents: this.live!.decoder.decodedEvents,
            buys: this.live!.decoder.buys,
            sells: this.live!.decoder.sells,
            eligible: c!.eligible,
            late: c!.late,
            duplicates: c!.duplicates,
            unvalued: c!.unvalued,
            undecodable: this.live!.decoder.undecodable,
            truncatedLogs: this.live!.decoder.truncatedLogs,
          }
        : {
            notifications: 0,
            failedTransactions: 0,
            decodedEvents: dbCounts?.decoded ?? 0,
            buys: dbCounts?.buys ?? 0,
            sells: dbCounts?.sells ?? 0,
            eligible: dbCounts?.eligible ?? 0,
            late: dbCounts?.late ?? 0,
            duplicates: 0,
            unvalued: dbCounts?.unvalued ?? 0,
            undecodable: 0,
            truncatedLogs: 0,
          },
      ...(!isLive && dbCounts === null ? { countersPending: true } : {}),
      openGaps: gaps.open ?? 0,
      totalGaps: gaps.total,
      latestPackTriggerMs: packs.latest,
      packCount: packs.n,
      session: {
        active: session !== null,
        endsAt: session ? new Date(session.ends_at_ms).toISOString() : null,
        smartMoneyEndsAt: session ? new Date(session.smart_money_ends_at_ms).toISOString() : null,
      },
      smartMoneyEnabled: this.config.smartMoney.enabled && mode === "live",
      analysisPaused: (() => {
        if (!this.live) return { paused: false, reason: null };
        const p = this.live.client.pauseState;
        if (p.reason === "auth") return { paused: true, reason: "Nansen access failed; check the API key." };
        if (p.reason === "payment") return { paused: true, reason: "Nansen reported insufficient credits." };
        const t = this.live.ledger.totals();
        const pyth = this.config.price.provider === "pyth";
        if (pyth && !this.live.session.current()) {
          return { paused: true, reason: "Nansen analysis is off (no session or daily credit cap is configured)." };
        }
        if (t.remaining - t.priceReserve <= 0) return { paused: true, reason: "Configured credit budget reached; analysis paused." };
        if (t.dailyCap !== null && t.dailyCap - t.usedToday < PACK_ENRICHMENT_CREDITS) {
          return { paused: true, reason: `Today's Nansen credit cap is used (${t.usedToday} of ${t.dailyCap}); analysis resumes at 00:00 UTC.` };
        }
        const headroom = this.live.scheduler.automaticHeadroom();
        // Waiting for the daily pace to allow the next pack is normal operation, not a pause.
        if (headroom !== null && headroom < PACK_ENRICHMENT_CREDITS && !this.live.scheduler.isPacing(PACK_ENRICHMENT_CREDITS)) {
          return {
            paused: true,
            reason: pyth
              ? "Automatic analysis paused: not enough credits left in the budget. Operators can still analyze packs manually."
              : "Automatic analysis paused: the remaining credits are reserved for price polling until the session ends. Operators can still analyze packs manually.",
          };
        }
        return { paused: false, reason: null };
      })(),
      namespaces: this.namespaces(),
      detector: this.detectionRule(namespace),
    };
  }

  usage(): UsageSummary {
    const campaignId = this.live?.ledger.campaignId ?? this.config.nansen.campaignId;
    const campaign = this.db.prepare("SELECT configured_budget FROM api_campaigns WHERE id = ?").get(campaignId) as { configured_budget: number } | undefined;
    const t = this.live?.ledger.totals() ?? null;
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(http_outcome = 'success') AS ok, SUM(http_outcome IN ('http_error','network_error','timeout')) AS failed,
           SUM(normalization_status = 'ok') AS valid, SUM(normalization_status = 'schema_error') AS invalid, SUM(reservation_status = 'unresolved') AS unresolved
         FROM api_usage WHERE campaign_id = ?`,
      )
      .get(campaignId) as { total: number; ok: number | null; failed: number | null; valid: number | null; invalid: number | null; unresolved: number | null };
    const byEndpoint = this.db
      .prepare(
        `SELECT endpoint, COUNT(*) AS attempts, SUM(http_outcome = 'success') AS ok, SUM(normalization_status = 'ok') AS valid, COALESCE(SUM(actual_credits), 0) AS credits
         FROM api_usage WHERE campaign_id = ? GROUP BY endpoint ORDER BY attempts DESC`,
      )
      .all(campaignId) as { endpoint: string; attempts: number; ok: number | null; valid: number | null; credits: number }[];
    const recent = this.db
      .prepare("SELECT * FROM api_usage WHERE campaign_id = ? ORDER BY started_at_ms DESC LIMIT 40")
      .all(campaignId) as Record<string, unknown>[];
    return {
      campaignId: campaign ? campaignId : null,
      configuredBudget: campaign?.configured_budget ?? null,
      credits: {
        settled: t?.settled ?? 0,
        reserved: t?.reserved ?? 0,
        unresolved: t?.unresolved ?? 0,
        available: t ? Math.max(0, t.remaining) : null,
        priceReserve: t?.priceReserve ?? 0,
        dailyCap: t?.dailyCap ?? null,
        usedToday: t?.usedToday ?? 0,
        lastReportedRemaining: this.live?.client.lastReportedRemaining ?? null,
      },
      attempts: {
        total: agg.total,
        httpSuccess: agg.ok ?? 0,
        httpFailed: agg.failed ?? 0,
        schemaValid: agg.valid ?? 0,
        schemaInvalid: agg.invalid ?? 0,
        unresolved: agg.unresolved ?? 0,
        cacheHits: this.live?.client.cacheHits ?? 0,
      },
      minimumTarget: this.config.nansen.minSuccessfulCalls,
      relevantSuccessful: agg.valid ?? 0,
      byEndpoint: byEndpoint.map((b) => ({ endpoint: b.endpoint, attempts: b.attempts, httpSuccess: b.ok ?? 0, schemaValid: b.valid ?? 0, actualCredits: b.credits })),
      recent: recent.map((r) => ({
        attemptId: r.attempt_id as string,
        startedAt: new Date(r.started_at_ms as number).toISOString(),
        endpoint: r.endpoint as string,
        purpose: r.purpose as string,
        subjectId: (r.subject_id as string | null) ?? null,
        httpStatus: (r.http_status as number | null) ?? null,
        normalizationStatus: r.normalization_status as string,
        actualCredits: (r.actual_credits as number | null) ?? null,
        quotedCredits: (r.quoted_credits as number | null) ?? null,
        reservationStatus: r.reservation_status as string,
        retryOfAttemptId: (r.retry_of_attempt_id as string | null) ?? null,
      })),
    };
  }
}
