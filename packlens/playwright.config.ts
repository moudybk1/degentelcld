import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8799;
const DB = join(tmpdir(), `packlens-e2e-${process.pid}.sqlite`);
// The teardown deletes this run's database so temporary files never pile up.
process.env.PACKLENS_E2E_DB = DB;

/**
 * Fixture-mode browser tests against the built app on a temporary database.
 * No keys, no provider calls.
 */
export default defineConfig({
  testDir: "tests/browser",
  globalTeardown: "./tests/browser/teardown.ts",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node apps/server/dist/index.js`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      APP_MODE: "fixture",
      PACKLENS_SKIP_DOTENV: "1",
      PORT: String(PORT),
      DATABASE_PATH: DB,
      ADMIN_TOKEN: "e2e-operator-token-0123456789abcdef",
      NANSEN_API_KEY: "",
      LOG_LEVEL: "warn",
    },
  },
});
