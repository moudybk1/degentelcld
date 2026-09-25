import { ConfigError, loadConfig, loadDotEnv, redactUrl } from "./config.js";
import { Runtime } from "./runtime.js";
import { buildServer, defaultWebDist } from "./api/server.js";
import { log } from "./lib/log.js";

async function main(): Promise<void> {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  log("info", "startup", "Starting PackLens", {
    mode: config.mode,
    database: config.databasePath,
    rpc: redactUrl(config.rpc.wsUrl),
    smartMoneyEnabled: config.smartMoney.enabled,
    budgetCredits: config.nansen.budgetCredits,
    sessionEndAt: config.nansen.sessionEndAtMs ? new Date(config.nansen.sessionEndAtMs).toISOString() : null,
    nansenKeyConfigured: config.nansen.apiKey !== null,
  });
  // Migrations run inside Runtime.create, before the server accepts traffic.
  const runtime = Runtime.create(config);
  runtime.start();
  const app = buildServer(runtime, { webDist: defaultWebDist(config.rootDir) });
  await app.listen({ host: config.host, port: config.port });
  log("info", "startup", `PackLens is listening on http://${config.host}:${config.port}`, { namespace: runtime.primaryNamespace });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "shutdown", "Shutting down", { signal });
    const deadline = setTimeout(() => {
      log("error", "shutdown", "Shutdown deadline exceeded; exiting");
      process.exit(1);
    }, 12_000);
    try {
      await app.close();
      await runtime.stop();
    } finally {
      clearTimeout(deadline);
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  log("error", "startup", "Fatal startup error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
