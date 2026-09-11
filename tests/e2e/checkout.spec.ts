/**
 * Storefront checkout starter suite (arch doc §37: E2E validates
 * Browser -> React SPA -> Fastify API -> Application, with providers
 * simulated at the backend boundary, never intercepted in the browser).
 * Nothing here mocks a fetch or stubs a route inside the browser — every
 * request is a real HTTP call from Chromium to the real storefront Fastify
 * process (started by playwright.config.ts's webServer) against the real
 * seeded Postgres schema (tests/e2e/seed.ts).
 *
 * WHY THE WALLET-CREDIT PAYMENT RAIL, NOT A REAL GATEWAY
 *   "Payment-success" for a real shop ultimately means a real payment
 *   gateway (QRIS/TokoPay, Binance, etc.) confirming payment, which for
 *   auto-confirm rails happens via a webhook this suite can't cleanly send
 *   (no real merchant credentials, no reachable callback URL) and for
 *   TokoPay/PayDisini specifically would mean the pay page making a REAL
 *   outbound API call the moment it's opened (apps/storefront/src/routes/
 *   checkout.ts's payView) even just to show a QR code — a live network
 *   dependency this starter suite deliberately avoids.
 *
 *   The storefront's wallet-credit rail (performWalletCheckout ->
 *   completeCartOrderWithWalletCredit) sidesteps that cleanly: it is a real,
 *   first-class checkout path (not a test-only backdoor), it settles and
 *   delivers an AUTO-SKU order SYNCHRONOUSLY with zero external gateway
 *   involved, and it's only offered once the checkout API has already
 *   verified the signed-in buyer's wallet balance covers the order — so
 *   reaching it here still exercises the real price/stock re-validation,
 *   the real order-creation transaction, and the real delivery path. That
 *   lets the golden path below reach an ACTUAL delivered/paid order (proven
 *   by the credentials the storefront shows), which is a strictly stronger
 *   assertion than stopping at "pending payment" — so this suite does not
 *   need to fall back to that weaker stopping point the task brief allows
 *   for.
 *
 * SHARED FIXTURE / WHY workers: 1
 *   Both tests reuse the ONE schema seed.ts seeds once per `playwright test`
 *   run (see playwright.config.ts's workers: 1 comment) rather than each
 *   minting its own isolated data — a deliberate minimal-starter trade-off.
 *   The two tests still don't step on each other: the golden path spends
 *   the golden-path product's stock, the rejection test spends the
 *   DIFFERENT stock-race product's single unit, and running serially (one
 *   worker) means there's never a second in-flight request against either.
 */
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { withSchema, E2E_SCHEMA } from "./schema";
import {
  E2E_SHOPPER_USERNAME,
  E2E_SHOPPER_PASSWORD,
  E2E_GOLDEN_PRODUCT_NAME,
  E2E_RACE_PRODUCT_NAME,
  E2E_PRODUCT_PRICE_DISPLAY,
} from "./fixtures";

// Deliberately just `@prisma/client` (no `@app/db`) — see fixtures.ts's doc
// comment on why this file can never import an `@app/*` (ESM-only) package.
// This inlines the same guarded update `markStockDead`
// (packages/db/src/crud/stock.ts) performs, using StockItem.status's raw
// string values (AVAILABLE/RESERVED/DEAD — a plain String column, not a
// generated Prisma enum, see prisma/schema.prisma).

async function login(page: import("@playwright/test").Page): Promise<void> {
  // Exact text, not a substring: the header nav also carries its own plain
  // "Sign in" link, and a substring match on /sign in/i matches both.
  await page.getByRole("link", { name: "Already have an account? Sign in" }).click();
  await page.waitForURL(/\/login/);
  await page.getByLabel("Username or email").fill(E2E_SHOPPER_USERNAME);
  await page.getByLabel("Password", { exact: true }).fill(E2E_SHOPPER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("storefront checkout", () => {
  test("golden path: catalog -> product -> checkout -> paid & delivered", async ({ page }) => {
    // ---- Catalog -> product detail ----
    await page.goto("/");
    await page.getByRole("link", { name: E2E_GOLDEN_PRODUCT_NAME }).first().click();
    await expect(page.getByRole("heading", { name: E2E_GOLDEN_PRODUCT_NAME })).toBeVisible();

    // ---- Add to cart (navigates to /cart on success) ----
    await page.getByRole("button", { name: "Add to cart" }).click();
    await page.waitForURL(/\/cart$/);
    // A heading wait, not a bare product-name text match: right after the
    // SPA navigation, the outgoing ProductPage's own heading/breadcrumb can
    // still be mid-unmount at the same instant the product's name also
    // appears in the (already-mounted) cart line — a real strict-mode
    // ambiguity Playwright caught, not a flaky test. Waiting for the Cart
    // page's own heading (with the right item count) sidesteps it and is a
    // stronger assertion anyway.
    await expect(page.getByRole("heading", { name: /Cart \(1\)/ })).toBeVisible();

    // ---- Cart -> checkout ----
    await page.getByRole("link", { name: /continue to payment/i }).click();
    await page.waitForURL(/\/checkout$/);
    await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();

    // Anonymous at this point (the cart above was built as a guest visitor) —
    // sign in from the checkout page itself, exactly like a real returning
    // shopper would. establishSession (routes/auth.ts) merges the guest
    // cookie cart into the account's cart as part of login, so the same item
    // survives the sign-in redirect back to /checkout.
    await login(page);
    await page.waitForURL(/\/checkout$/);
    await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
    // CheckoutPage's summary card shows the price total, not an itemized
    // product name — this is the seeded product's exact price, so a matching
    // total is the checkout page's own evidence that the guest cart's item
    // survived the sign-in merge (establishSession, routes/auth.ts) rather
    // than the buyer landing on an empty cart. Derived from
    // E2E_PRODUCT_PRICE, so re-seeding at a different price re-points this
    // assertion instead of silently failing against a stale literal.
    await expect(page.getByText(E2E_PRODUCT_PRICE_DISPLAY).first()).toBeVisible();

    // Wallet Credit (IDR) is pre-selected: no gateway is configured in the
    // seeded fixture, and defaultMethod() only offers wallet credit once no
    // gateway is enabled AND the balance covers the total (both true here).
    await expect(page.getByRole("radio", { name: /Wallet Credit \(IDR\)/i })).toBeChecked();

    // ---- Place order & pay ----
    await page.getByRole("button", { name: "Place order & pay" }).click();

    // Wallet checkout settles + delivers an AUTO-SKU order synchronously, so
    // the buyer lands directly on their order detail page rather than a
    // pending-payment screen.
    await page.waitForURL(/\/account\/orders\/[^/]+$/);
    await expect(page.getByRole("heading", { name: "Your credentials" })).toBeVisible();
    // A real stock credential the seed script planted — proof this order was
    // actually fulfilled from real inventory, not just marked paid.
    await expect(page.getByText(/golden-cred-/)).toBeVisible();
  });

  test("recoverable rejection: stock changes mid-checkout requires an explicit retry", async ({ page }) => {
    // ---- Sign in up front (this test isn't re-proving catalog browsing) ----
    await page.goto("/login");
    await page.getByLabel("Username or email").fill(E2E_SHOPPER_USERNAME);
    await page.getByLabel("Password", { exact: true }).fill(E2E_SHOPPER_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));

    // ---- Catalog -> product -> cart ----
    await page.goto("/");
    await page.getByRole("link", { name: E2E_RACE_PRODUCT_NAME }).first().click();
    await expect(page.getByRole("heading", { name: E2E_RACE_PRODUCT_NAME })).toBeVisible();
    await page.getByRole("button", { name: "Add to cart" }).click();
    await page.waitForURL(/\/cart$/);

    await page.getByRole("link", { name: /continue to payment/i }).click();
    await page.waitForURL(/\/checkout$/);
    await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Wallet Credit \(IDR\)/i })).toBeChecked();

    // ---- Simulate stock changing out from under the buyer ----
    // Between the buyer reaching checkout and submitting it, the shop's last
    // unit of this product is pulled (an admin marking bad stock dead — same
    // operation markStockDead performs, see the import comment above) — a
    // direct DB write standing in for "another buyer bought the last unit"
    // or "an admin removed it", either of which is a genuine, deterministic
    // way to force error.out_of_stock without relying on a timing race.
    const baseUrl = process.env.DATABASE_URL_PRISMA;
    if (!baseUrl) throw new Error("DATABASE_URL_PRISMA must be set to run this test.");
    const db = new PrismaClient({ datasourceUrl: withSchema(baseUrl, E2E_SCHEMA) });
    try {
      const stockItem = await db.stockItem.findFirstOrThrow({
        where: { product: { name: E2E_RACE_PRODUCT_NAME } },
      });
      const { count: killed } = await db.stockItem.updateMany({
        where: { id: stockItem.id, status: { in: ["AVAILABLE", "RESERVED"] } },
        data: { status: "DEAD", note: "e2e: simulated stock changed mid-checkout" },
      });
      expect(killed).toBe(1);
    } finally {
      await db.$disconnect();
    }

    // ---- Submit checkout: the server must reject, not silently proceed ----
    await page.getByRole("button", { name: "Place order & pay" }).click();

    // The rejection is shown in words the buyer can act on ("is out of
    // stock") — see CheckoutPage.tsx's humanError()/placeOrderErrorKey — and
    // the buyer is kept on /checkout rather than being bounced anywhere.
    await expect(page.getByText(/out of stock/i)).toBeVisible();
    await expect(page).toHaveURL(/\/checkout$/);

    // No silent auto-retry: the SAME "Place order & pay" control is still
    // there, enabled, waiting for the buyer to explicitly press it again —
    // the mutation never re-fires on its own (React Query mutations don't
    // retry by default, and useIdempotentPost mints a FRESH key once a 4xx
    // makes the prior attempt's outcome known, so a deliberate next click is
    // a new, valid request rather than a blocked replay of the failure).
    const retryButton = page.getByRole("button", { name: "Place order & pay" });
    await expect(retryButton).toBeVisible();
    await expect(retryButton).toBeEnabled();
  });
});
