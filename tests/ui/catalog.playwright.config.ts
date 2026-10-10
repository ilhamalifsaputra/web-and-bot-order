import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

// Mocked API payloads only: no database, provider, or Telegram calls.
export default defineConfig({
  testDir: ".",
  testMatch: "catalog-availability.spec.ts",
  workers: 1,
  reporter: "list",
  outputDir: "../../.audit-data/catalog-availability/playwright",
  use: { baseURL: "http://127.0.0.1:8221", trace: "retain-on-failure" },
  webServer: {
    command: "node tests/ui/serve-admin.mjs", cwd: resolve(__dirname, "../.."),
    url: "http://127.0.0.1:8221", reuseExistingServer: false, timeout: 30000,
  },
});
