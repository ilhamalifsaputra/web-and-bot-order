/**
 * Playwright E2E fixture seed for the storefront checkout suite
 * (tests/e2e/checkout.spec.ts).
 *
 * This is NOT run by hand — playwright.config.ts's `webServer.command`
 * chains it in front of `pnpm --filter @app/storefront start`, so it always
 * runs (and always finishes) before the storefront process the tests talk to
 * ever binds its port. That ordering is load-bearing: the storefront's own
 * `start()` queries Settings during boot (resolveAdminIds,
 * resolveWebCookieSecret), so the schema and its tables must already exist
 * before the server process is even spawned — by the time Playwright's own
 * `globalSetup` hook would run, the webServer has already been launched
 * (confirmed against Playwright's own task-ordering source), so seeding
 * there would be too late.
 *
 * Isolation approach — reuses, doesn't reinvent:
 *  - Same schema-per-run technique as tests/helpers/testdb.ts (a dedicated
 *    Postgres schema created via `prisma db push`, never the shared `public`
 *    schema every worktree's manual dev testing/other sessions also use).
 *    The one difference: testdb.ts mints a random schema name per Vitest
 *    test (each test tears its own down immediately after). This suite's
 *    schema instead has one FIXED name (tests/e2e/schema.ts's E2E_SCHEMA),
 *    because playwright.config.ts must know the schema-scoped
 *    DATABASE_URL_PRISMA up front to hand it to the webServer process as an
 *    env var — there is no async handshake between this script and the
 *    config once the server has already been asked to start. Dropped +
 *    recreated at the top of every run (see below) so a fixed name never
 *    accumulates stale data across runs.
 *  - Same crud helpers tests/helpers/sample.ts uses to build fixture rows
 *    (createCategory / createCatalogProduct / createDenomination /
 *    bulkAddStock) — nothing here is a new fixture-building mechanism, just
 *    those same helpers pointed at a schema a live dev server can also see.
 *
 * Fixture shape (see checkout.spec.ts for how each row is used):
 *  - One category, two AUTO-delivery products:
 *      - "E2E Golden Path Product" — 3 units of stock. The golden-path test
 *        buys 1.
 *      - "E2E Stock Race Product" — exactly 1 unit of stock. The
 *        recoverable-rejection test deletes that one unit (via
 *        `markStockDead`, the same admin operation a real "pull this bad
 *        stock" action performs) between the buyer adding it to their cart
 *        and submitting checkout, to force a deterministic
 *        `error.out_of_stock` rejection.
 *  - One registered (non-guest) web user, "e2eshopper", with enough IDR
 *    wallet credit to pay for both products outright. Checkout's
 *    "Wallet Credit (IDR)" rail (performWalletCheckout) settles synchronously
 *    with NO external payment gateway involved — chosen deliberately over a
 *    QRIS/TokoPay-style method specifically so this suite never depends on
 *    real gateway credentials or outbound network access to a third-party
 *    API, and so the golden path can reach an actual delivered/paid order
 *    rather than stopping at "pending payment" (see checkout.spec.ts's
 *    doc-comment for the full reasoning).
 */
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  createCategory,
  createCatalogProduct,
  createDenomination,
  bulkAddStock,
  createWebUser,
  markSetupComplete,
} from "@app/db";
import { ProductType } from "@app/core/enums";
import { hashPassword } from "@app/core/password";
import { E2E_SCHEMA } from "./schema";
import {
  E2E_SHOPPER_USERNAME,
  E2E_SHOPPER_PASSWORD,
  E2E_GOLDEN_PRODUCT_NAME,
  E2E_RACE_PRODUCT_NAME,
  E2E_PRODUCT_PRICE,
} from "./fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_PRISMA;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL_PRISMA must be set (schema-scoped) before running the e2e seed.");
  }
  const schema = new URL(databaseUrl).searchParams.get("schema");
  if (schema !== E2E_SCHEMA) {
    // Guards against ever accidentally seeding into the shared `public`
    // schema (or someone else's) if this script is ever invoked directly
    // with the wrong env — the drop-and-recreate below is destructive.
    throw new Error(
      `Refusing to seed: DATABASE_URL_PRISMA's ?schema= is "${schema ?? "(none)"}", expected "${E2E_SCHEMA}". ` +
        "This script only ever seeds the dedicated e2e schema — see tests/e2e/schema.ts.",
    );
  }

  // 1. Fresh schema. DROP...CASCADE is a no-op if it doesn't exist yet (first
  //    run) and wipes any leftovers from an interrupted prior run otherwise —
  //    every run starts from a clean slate.
  const dropClient = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await dropClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await dropClient.$disconnect();
  }

  // `prisma db push` issues the CREATE SCHEMA + every CREATE TABLE in
  // FK-correct order — same mechanism tests/helpers/testdb.ts relies on.
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL_PRISMA: databaseUrl },
    stdio: "inherit",
  });

  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    // Skip the first-run setup wizard gate (packages/db/src/crud/setup.ts) —
    // a brand-new schema with no admin password set makes every storefront
    // request 503 ("shop not active yet", apps/storefront/src/plugins/
    // setupGate.ts) until this is done, which otherwise stalls
    // playwright.config.ts's webServer readiness check forever (it only
    // accepts a 2xx from the server, never a 503).
    await markSetupComplete(db);

    const category = await createCategory(db, "E2E Category", "\u{1F9EA}");

    const goldenProduct = await createCatalogProduct(db, {
      categoryId: category.id,
      name: E2E_GOLDEN_PRODUCT_NAME,
      description: "Seeded by tests/e2e/seed.ts for the Playwright golden-path test.",
    });
    const goldenDenom = await createDenomination(db, {
      productId: goldenProduct.id,
      name: E2E_GOLDEN_PRODUCT_NAME,
      type: ProductType.SHARED,
      durationLabel: "1x",
      price: E2E_PRODUCT_PRICE,
      warrantyDays: 30,
    });
    await bulkAddStock(db, goldenDenom.id, ["golden-cred-1", "golden-cred-2", "golden-cred-3"]);

    const raceProduct = await createCatalogProduct(db, {
      categoryId: category.id,
      name: E2E_RACE_PRODUCT_NAME,
      description: "Seeded by tests/e2e/seed.ts for the Playwright recoverable-rejection test.",
    });
    const raceDenom = await createDenomination(db, {
      productId: raceProduct.id,
      name: E2E_RACE_PRODUCT_NAME,
      type: ProductType.SHARED,
      durationLabel: "1x",
      price: E2E_PRODUCT_PRICE,
      warrantyDays: 30,
    });
    // Exactly one unit — deleted by checkout.spec.ts between "add to cart"
    // and "submit checkout" to force a deterministic error.out_of_stock.
    await bulkAddStock(db, raceDenom.id, ["race-cred-1"]);

    const user = await createWebUser(db, {
      loginUsername: E2E_SHOPPER_USERNAME,
      email: "e2eshopper@example.invalid",
      passwordHash: hashPassword(E2E_SHOPPER_PASSWORD),
      fullName: "E2E Shopper",
    });
    // Enough IDR wallet credit to cover both seeded products with room to
    // spare — set via a direct write (no crud helper exists for "grant a
    // brand-new test account starting credit"; a real wallet top-up always
    // goes through a payment rail, which is exactly what this fixture is
    // trying to avoid needing).
    await db.user.update({ where: { id: user.id }, data: { walletBalance: "1000000" } });

    console.log(
      `[e2e seed] ready — schema "${schema}", category #${category.id}, products #${goldenProduct.id}/#${raceProduct.id}, user #${user.id}`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("[e2e seed] failed:", err);
  process.exit(1);
});
