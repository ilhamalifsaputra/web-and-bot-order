import { defineConfig } from "@playwright/test";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(__dirname, "../../.env"), quiet: true });
const dbUrl = new URL(process.env.DATABASE_URL_PRISMA!);
if (!["127.0.0.1", "localhost"].includes(dbUrl.hostname) || dbUrl.pathname !== "/trustance_readiness_20261010") {
  throw new Error("Readiness audit requires its dedicated local database.");
}
dbUrl.searchParams.set("schema", "readiness_audit");

export default defineConfig({
  testDir: ".",
  testMatch: "readiness.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: "list",
  outputDir: "../../.audit-data/readiness/playwright",
  use: { baseURL: "http://127.0.0.1:8240", browserName: "chromium", reducedMotion: "reduce", trace: "off" },
  webServer: {
    cwd: resolve(__dirname, "../.."),
    command: "pnpm exec tsx tests/audit/seed.ts && pnpm --filter @app/storefront start",
    url: "http://127.0.0.1:8240",
    reuseExistingServer: false,
    timeout: 180_000,
    env: { DATABASE_URL_PRISMA: dbUrl.toString(), STOREFRONT_HOST: "127.0.0.1", STOREFRONT_PORT: "8240", CREDENTIAL_ENCRYPTION_KEY: "00".repeat(32), NODE_ENV: "test" },
  },
});
