import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

// Production bundles with mocked APIs only; no database, provider or bot calls.
export default defineConfig({
  testDir: ".",
  testMatch: "frontend-motion.spec.ts",
  workers: 1,
  reporter: "list",
  outputDir: "../../.audit-data/motion/playwright",
  use: { baseURL: "http://127.0.0.1:8349", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "node tests/ui/serve-frontend-motion.mjs",
    cwd: resolve(__dirname, "../.."),
    url: "http://127.0.0.1:8349", reuseExistingServer: false, timeout: 30_000,
  },
});
