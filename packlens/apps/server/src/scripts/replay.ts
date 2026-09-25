/**
 * npm run replay -- --dataset <id> --mode recorded-arrival|historical-event-time
 * Replays a registered dataset into a new replay namespace on the configured
 * database and prints a run report. Never calls providers.
 */
import { parseArgs } from "node:util";
import { ConfigError, loadConfig, loadDotEnv } from "../config.js";
import { Runtime } from "../runtime.js";
import { listManifests } from "../replay/dataset.js";
import { setLogSink } from "../lib/log.js";

loadDotEnv();
const { values } = parseArgs({ options: { dataset: { type: "string" }, mode: { type: "string", default: "recorded-arrival" }, list: { type: "boolean", default: false } } });
setLogSink(() => undefined, "error");
try {
  const config = loadConfig({ ...process.env, APP_MODE: "replay" });
  if (values.list || !values.dataset) {
    process.stdout.write("Registered datasets:\n");
    for (const m of listManifests(config.rootDir)) process.stdout.write(`  ${m.datasetId}  (${m.origin}, ${m.eventCount} events)  ${m.label}\n`);
    if (!values.dataset) process.stdout.write("\nUsage: npm run replay -- --dataset <id> --mode recorded-arrival|historical-event-time\n");
    process.exit(values.dataset ? 0 : 1);
  }
  if (values.mode !== "recorded-arrival" && values.mode !== "historical-event-time") throw new Error("--mode must be recorded-arrival or historical-event-time");
  const rt = Runtime.create(config);
  const r = rt.runReplay(values.dataset, values.mode);
  const report = rt.db.prepare("SELECT report_json FROM replay_runs WHERE id = ?").get(r.runId) as { report_json: string };
  process.stdout.write(
    `${JSON.stringify({ runId: r.runId, namespace: r.namespace, datasetId: values.dataset, mode: values.mode, packCount: r.packCount, digest: r.digest, report: JSON.parse(report.report_json) }, null, 2)}\n` +
      `Open it with: http://${config.host}:${config.port}/?namespace=${encodeURIComponent(r.namespace)}\n`,
  );
  rt.db.close();
} catch (err) {
  process.stderr.write(`${err instanceof ConfigError ? err.message : err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
