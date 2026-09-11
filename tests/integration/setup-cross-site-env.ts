/**
 * Bootstrap for tests/integration/nickname-gate-cross-site.test.ts — MUST be
 * that file's FIRST import, same discipline as every app's own
 * test/setup-env.ts (apps/order-bot/test/setup-db.ts,
 * apps/storefront/test/setup-env.ts): sets env + provisions an isolated
 * Postgres schema (inside the shared dev container) via `prisma db push`
 * BEFORE any `@app/*` module loads, so the `@app/db` Prisma singleton (which
 * binds DATABASE_URL_PRISMA at construction) points at it.
 *
 * This is a NEW bootstrap file, not a reuse of either app's own
 * setup-*.ts, because the cross-site test genuinely needs BOTH apps'
 * modules (apps/storefront/src/routes/apiTopup.ts AND
 * apps/order-bot/src/handlers/checkout.ts +
 * apps/order-bot/src/conversations/nicknameCheck.ts) loaded into the SAME
 * module registry, sharing the SAME `@app/db` Prisma singleton, so a fixture
 * written once via `@app/db` crud helpers is visible to all three real call
 * sites in one test. Env is the union of both apps' own setup files;
 * everything not set here has a safe default in @app/core/config's zod
 * schema (verified: WEB_COOKIE_SECRET, SMTP_HOST, TRUST_PROXY,
 * SHOP_PUBLIC_URL are all `.optional()` there, and this test never exercises
 * auth/SMTP/proxy-IP paths).
 *
 * No `@app/*` imports here, so ESM evaluates these side effects first.
 */
import { afterAll } from "vitest";
import { provisionPgTestSchema } from "../helpers/pgTestSchema";

process.env.BOT_TOKEN = "123:ABCDEFGHIJKLMNOPQRSTUVWXYZ-test";
process.env.BOT_USERNAME = "TestBot";
process.env.BINANCE_PAY_ID = "111222333";
process.env.ADMIN_IDS = "999,1000";
process.env.CURRENCY = "USDT";
process.env.USE_UNIQUE_CENTS = "0";
process.env.DEFAULT_LANGUAGE = "en";
process.env.LOW_STOCK_THRESHOLD = "3";
process.env.PAYMENT_WINDOW_MINUTES = "30";
// Neutralize payment creds so a developer's real root .env can't leak live
// keys into the test process (same rationale as both apps' own setup files).
process.env.BYBIT_DEPOSIT_ADDRESS = "";
process.env.BYBIT_API_KEY = "";
process.env.BYBIT_API_SECRET = "";

const schemaEnv = await provisionPgTestSchema("crosssite");
export const DB_URL = schemaEnv.url;
process.env.DATABASE_URL_PRISMA = DB_URL;

afterAll(schemaEnv.cleanup);
