// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Lint includes the detector/pattern import boundaries (blueprint §2): the
 * pure detector and pattern indicators may not import Smart Money, Nansen,
 * enrichment, storage, API, or network code.
 */
const boundary = {
  patterns: [
    { group: ["**/smart-money/**", "**/smart-money"], message: "Detector and patterns must not read Smart Money context." },
    { group: ["**/adapters/**"], message: "Detector and patterns must not call providers." },
    { group: ["**/enrichment/**", "**/assessment/**", "**/scheduler/**"], message: "Detector and patterns must not depend on enrichment or scheduling." },
    { group: ["**/api/**", "**/db/**", "**/ingest/**", "**/collector/**", "**/runtime*"], message: "Detector and patterns must stay pure (no storage, API, or I/O)." },
  ],
  paths: [
    { name: "ws", message: "No network in the detector." },
    { name: "node:http", message: "No network in the detector." },
    { name: "node:https", message: "No network in the detector." },
    { name: "better-sqlite3", message: "No storage in the detector." },
  ],
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "data/**", "test-results/**", "playwright-report/**", "scripts/.local/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "off",
    },
  },
  {
    files: ["apps/server/src/detector/**/*.ts", "apps/server/src/patterns/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", boundary],
      "no-restricted-globals": ["error", { name: "fetch", message: "No network in the detector." }],
      "no-restricted-properties": ["error", { object: "Date", property: "now", message: "Use the injected clock." }],
    },
  },
  {
    files: ["apps/server/src/smart-money/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/detector/**", "**/patterns/**"], message: "Smart Money must not reach into core detection." }] },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/apps/server/**"], message: "The web app talks to the API only." }] }],
    },
  },
);
