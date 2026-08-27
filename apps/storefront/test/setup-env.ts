/**
 * Test environment bootstrap — MUST be the first import in every storefront
 * test file. Sets the env that `@app/core/config` + the `@app/db` Prisma
 * singleton read at import time, then creates the schema in an isolated
 * Postgres schema (inside the shared dev container) via `prisma db push`.
 * Mirror of apps/web-admin/test/setup-env.ts. The provisioned schema is
 * dropped automatically in a self-registered `afterAll`; the exported
 * `cleanupTestDb()` some test files still call explicitly is now just an
 * idempotent alias for the same cleanup (safe to call twice).
 */
import { afterAll } from "vitest";
import { provisionPgTestSchema } from "../../../tests/helpers/pgTestSchema";

process.env.WEB_COOKIE_SECRET = "test-secret-key-at-least-32-chars-long-xx";
process.env.ADMIN_IDS = "999,1000";
process.env.BOT_TOKEN = "123:ABCDEFGHIJKLMNOPQRSTUVWXYZ-test";
process.env.BOT_USERNAME = "TestBot";
process.env.BINANCE_PAY_ID = "111222333";
process.env.USE_UNIQUE_CENTS = "0";
process.env.DEFAULT_LANGUAGE = "en";
process.env.SMTP_HOST = "smtp.test.invalid";
process.env.SMTP_FROM = "Shop <no-reply@test.invalid>";
// app.inject()'s simulated connection comes from loopback — trust it as the
// reverse-proxy hop so tests can keep simulating distinct client IPs via
// X-Forwarded-For (Storefront-4 fix, security audit 2026-06-23; see
// rateLimit.ts's clientIp for why TRUST_PROXY now gates X-Forwarded-For at all).
process.env.TRUST_PROXY = "127.0.0.1,::1";
// Shadow any real Bybit creds from the monorepo-root .env so payment-method
// gating is driven purely by Settings in tests (dotenv never overrides these).
process.env.BYBIT_DEPOSIT_ADDRESS = "";
process.env.BYBIT_API_KEY = "";
process.env.BYBIT_API_SECRET = "";
// NOWPayments' createInvoice needs a public IPN callback URL — without this,
// the storefront pay page treats NOWPayments as unconfigured (gatewayError)
// even with creds set, since it has nowhere to send the callback to.
process.env.SHOP_PUBLIC_URL = "https://shop.test.invalid";

const schemaEnv = provisionPgTestSchema("storefront");
export const DB_URL = schemaEnv.url;
process.env.DATABASE_URL_PRISMA = DB_URL;

afterAll(schemaEnv.cleanup);

export function cleanupTestDb(): Promise<void> {
  return schemaEnv.cleanup();
}
