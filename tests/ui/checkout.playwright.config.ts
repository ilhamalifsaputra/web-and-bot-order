import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// Explicitly mocked UI coverage; no database, provider or payment calls.
export default defineConfig({
  testDir: ".",
  testMatch: "checkout-dynamic-sticky.spec.ts",
  workers: 1,
  reporter: "list",
  outputDir: "../../.audit-data/checkout-dynamic-sticky/playwright",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:8187", trace: "retain-on-failure" },
  webServer: { command: "node tests/ui/serve-checkout.mjs", cwd: resolve(__dirname, "../.."), url: "http://127.0.0.1:8187", reuseExistingServer: false, timeout: 30000 },
});
