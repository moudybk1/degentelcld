import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/browser/**"],
    environment: "node",
    testTimeout: 20_000,
    pool: "forks",
  },
});
