/**
 * Playwright starter suite — storefront checkout golden path (arch doc §37:
 * E2E validates Browser -> React SPA -> Fastify API -> Application, with
 * providers simulated at the backend boundary, never intercepted in the
 * browser — see tests/e2e/checkout.spec.ts for how the payment side of that
 * boundary is handled).
 *
 * HOW TO RUN
 *   Prerequisites:
 *     1. Postgres reachable at this worktree's .env DATABASE_URL_PRISMA
 *        (the shared dev container: `docker compose -f
 *        docker-compose.postgres.yml up -d` from repo root if it isn't
 *        already running — Docker Desktop itself must be running first).
 *     2. The storefront's client bundle built against CURRENT code:
 *        `pnpm --filter @app/storefront-client build` (or `pnpm -r build`).
 *        See "Why build+start, not dev" below for why this isn't done for
 *        you automatically on every run.
 *     3. Browsers installed once: `pnpm exec playwright install chromium`.
 *   Then:
 *     pnpm exec playwright test        (or `pnpm e2e`)
 *
 *   No manual data seeding needed — the `webServer.command` below seeds a
 *   dedicated, disposable Postgres schema (tests/e2e/seed.ts) before the
 *   storefront process it starts ever binds its port, and
 *   tests/e2e/global-teardown.ts drops that schema again once the run ends.
 *   That schema is never the shared `public` one other dev/manual-testing
 *   sessions use.
 *
 * WHY BUILD+START, NOT `pnpm dev:store`
 *   The storefront's Fastify server (apps/storefront/src/server.ts) has no
 *   Vite dev-server proxy/middleware at all — `dev` (tsx watch) and `start`
 *   (tsx) both just serve apps/storefront/static/shop-app/index.html
 *   (routes/spaShell.ts), a build artifact. Running the suite against `dev`
 *   would silently exercise whatever bundle happens to already be on disk,
 *   not necessarily current code — so this suite requires the bundle be
 *   built ahead of time (prerequisite 2 above) and starts the server with
 *   the non-watching `start` script, a stable target that doesn't restart
 *   mid-run on an unrelated file save.
 *
 * WHY THE WALLET-CREDIT PAYMENT RAIL, NOT A REAL GATEWAY
 *   See tests/e2e/checkout.spec.ts's top comment.
 */
import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { withSchema, E2E_SCHEMA } from "./tests/e2e/schema";

loadEnv();

const STOREFRONT_PORT = Number(process.env.STOREFRONT_PORT ?? 8100);
const BASE_URL = `http://127.0.0.1:${STOREFRONT_PORT}`;

const baseDatabaseUrl = process.env.DATABASE_URL_PRISMA;
if (!baseDatabaseUrl) {
  throw new Error(
    "DATABASE_URL_PRISMA must be set in .env to run the Playwright suite (a Postgres connection string) — see this file's doc comment.",
  );
}
const e2eDatabaseUrl = withSchema(baseDatabaseUrl, E2E_SCHEMA);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // A single worker: every test in this starter suite shares the ONE seeded
  // schema/fixture set (tests/e2e/seed.ts) rather than each test minting its
  // own isolated data — a deliberate "genuinely minimal starter" trade-off
  // (see checkout.spec.ts). Parallel workers would race on shared rows
  // (cart state, the single-unit stock-race product); a single worker keeps
  // that safe without needing per-test data isolation infrastructure this
  // starter suite doesn't otherwise need.
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  globalTeardown: "./tests/e2e/global-teardown.ts",
  webServer: {
    // Seeds the dedicated schema FIRST, then starts the storefront — in that
    // order, in the same shell invocation — so the fresh schema/tables exist
    // before start() queries Settings during boot (resolveAdminIds,
    // resolveWebCookieSecret). Playwright starts webServer before running any
    // globalSetup hook (confirmed against Playwright's own source), so
    // seeding via globalSetup instead would run too late — see seed.ts's doc
    // comment for the full reasoning.
    command: "pnpm exec tsx tests/e2e/seed.ts && pnpm --filter @app/storefront start",
    url: `${BASE_URL}/`,
    // Always fresh: never reuse an already-running server on this port, even
    // locally. Reusing one would skip the command above entirely — meaning
    // the seed step never runs and the suite would exercise whatever's
    // already in whatever schema that other server happens to be pointed at,
    // not this suite's isolated fixture.
    reuseExistingServer: false,
    // Generous: this chains a schema drop+recreate+seed (tests/e2e/seed.ts)
    // in front of the server boot, and both legs pay tsx/pnpm cold-start
    // overhead with no warm cache on a fresh run.
    timeout: 180_000,
    env: {
      DATABASE_URL_PRISMA: e2eDatabaseUrl,
      // Stock item credentials are encrypted at rest (@app/core/credentialCrypto)
      // and this worktree's .env deliberately leaves the key unset (it's
      // commented out in .env.example too — a real deployment must set its
      // own). Scoped to just this webServer process rather than added to
      // .env, so the suite's fixture key never leaks into any other process
      // reading this worktree's real .env. Same fixed placeholder
      // vitest.config.ts uses for the same purpose — not a real secret,
      // never use this value outside tests.
      CREDENTIAL_ENCRYPTION_KEY: "00".repeat(32),
    },
  },
});
