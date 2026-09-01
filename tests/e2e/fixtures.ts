/**
 * Plain constants shared between tests/e2e/seed.ts (executed standalone via
 * `tsx`, ahead of the storefront server — see playwright.config.ts's
 * webServer.command) and tests/e2e/checkout.spec.ts (loaded by Playwright's
 * OWN test transform, which runs under the repo root's default CommonJS
 * module type).
 *
 * Deliberately zero imports from `@app/core`/`@app/db`: those packages are
 * `"type": "module"` (packages/core/package.json, packages/db/package.json)
 * and pulling either of them into a file Playwright's loader processes
 * crashes with "Cannot use 'import.meta' outside a module" — Playwright
 * transforms test-file imports under the ROOT package.json's module type
 * (CommonJS here), and a nested ESM-only package loaded through that path
 * fails to `require()`. tsx (seed.ts's own runtime) has no such problem, so
 * seed.ts itself still imports the real crud helpers freely — only this
 * shared-constants file, and checkout.spec.ts's own direct Prisma access,
 * need to stay dependency-free of `@app/*`.
 */
export const E2E_SHOPPER_USERNAME = "e2eshopper";
export const E2E_SHOPPER_PASSWORD = "E2ePlaywright-1";
export const E2E_GOLDEN_PRODUCT_NAME = "E2E Golden Path Product";
export const E2E_RACE_PRODUCT_NAME = "E2E Stock Race Product";
export const E2E_PRODUCT_PRICE = "5000";

/**
 * `E2E_PRODUCT_PRICE` as the storefront actually renders it ("Rp5.000"), so a
 * spec can assert on the on-screen total without hardcoding a string that
 * silently stops matching the moment the seeded price above changes.
 *
 * The grouping is re-derived here rather than imported from the real formatter
 * (`formatIdr`, apps/storefront/client/src/lib/format.ts) for the same reason
 * this file imports nothing from `@app/*`: `apps/storefront/client/package.json`
 * is `"type": "module"` too, so pulling that file through Playwright's
 * CommonJS test transform would fail exactly like an `@app/core` import does.
 * `formatIdr` remains the source of truth for the FORMAT; this mirrors it for
 * the one shape that matters here (a positive whole-rupiah amount).
 */
export const E2E_PRODUCT_PRICE_DISPLAY = `Rp${Number(E2E_PRODUCT_PRICE)
  .toFixed(0)
  .replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
