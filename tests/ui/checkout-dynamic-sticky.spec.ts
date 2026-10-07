import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { CheckoutData, ProductPageData, ShopContext } from "../../apps/storefront/client/src/api/types";

const artifacts = resolve(".audit-data/checkout-dynamic-sticky/screenshots");
const player = { key: "player_id", label: { id: "ID Pemain", en: "Player ID" }, type: "number" as const, required: true, options: [], placeholder: "Enter your Player ID", minLength: 3, helpText: "Find your ID in your game profile." };
const optional = { key: "region", label: { id: "Wilayah", en: "Region" }, type: "select" as const, required: false, options: ["Asia", "Europe"], placeholder: "" };
const product: ProductPageData = {
  product: { slug: "configured-game", name: "Configured Game", description: "Instant delivery to your game account.", what_you_get: "Your selected plan is sent to the account above.", terms: "Check your account details before purchasing.", warranty_note: null, category_name: "Top Up Game", category_slug: "top-up-game", image: null, image_kind: "game", icon_kind: "diamond", rating: null, rating_count: 0, checkout_flow: "instant" },
  denominations: [1, 2, 3].map((id) => ({ id, name: id === 2 ? "A very long denomination name that wraps consistently across narrow mobile screens" : `${id * 18} Game Coins`, duration_label: null, price: id === 1 ? "5078" : "7405", warranty_days: 0, available: 0, in_stock: false, bulk: null, delivery_type: "manual_with_info", additional_fields: [player, optional], input_configuration_valid: true })),
  default_restock_denomination_id: 1, related_products: [], reviews: [], low_threshold: 5,
};
const context: ShopContext = { lang: "en", fx: "16000", shop_name: "Checkout UI Test", shop_tagline: "Digital products", cart_count: 2, customer: { username: "buyer", email: null, telegram_linked: false }, favicon_url: "", logo_url: "", bot_username: "testbot", wa_number: null, tzname: "Asia/Jakarta", currency: "IDR" };
function preview(id = 1): CheckoutData {
  return { items_empty: false, items: [{ denomination_id: id, delivery_type: "manual_with_info", additional_fields: [player, optional], qty: 1 }], subtotal: id === 1 ? "5078" : "7405", total: id === 1 ? "5078" : "7405", bulk_discount: "0", voucher_discount: "0", qris_admin_fee: "136", qris_grand_total: id === 1 ? "5214" : "7541", total_usdt: "0.33", voucher_code: "", error_key: null, binance_enabled: false, bybit_enabled: false, bybit_bsc_enabled: false, idr_enabled: true, paydisini_enabled: false, nowpayments_enabled: false, wallet_idr: "0", wallet_usdt: "0", wallet_idr_enabled: false, wallet_usdt_enabled: false, is_guest: false, below_all_minimums: false };
}
async function mockApi(page: Page, data = product, ctx = context) {
  const unexpected: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path === "/api/v1/pages/context") body = ctx;
    else if (path === `/api/v1/pages/product/${data.product.slug}`) body = data;
    else if (path === "/api/v1/topup/preview") body = preview(route.request().postDataJSON().denomination_id);
    else if (path === "/api/v1/topup/check-account") body = { available: false };
    else { unexpected.push(path); await route.fulfill({ status: 500, json: { error: "unexpected_mock_request" } }); return; }
    await route.fulfill({ json: body });
  });
  return unexpected;
}
async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const width of [320, 360, 375, 390, 412, 430, 768, 1280]) {
  test(`checkout at ${width}px: fields, layout, primary/sticky transitions and footer`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const unexpected = await mockApi(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/p/configured-game");
    const primary = page.locator("#instant-buy-submit");
    const sticky = page.getByRole("region", { name: "Purchase", exact: true });
    await expect(page.getByRole("heading", { name: "Summary", exact: true })).toBeVisible();
    await expect(page.getByLabel("Player ID", { exact: true })).not.toHaveAttribute("aria-invalid", "true");
    await page.getByLabel("Player ID", { exact: true }).fill("4531475056881819915");
    await expect(primary).toBeEnabled();
    await expect(page.locator("#checkout-summary")).toContainText("4531475056881819915");
    await expect(page.locator("#checkout-summary")).not.toContainText("Region");
    await assertNoOverflow(page);
    // Native radio group keyboard selection belongs to the actual form.
    await page.getByRole("radio").first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio").nth(1)).toBeChecked();
    await expect(page.getByLabel("Player ID", { exact: true })).toHaveValue("4531475056881819915");
    await expect(primary).toBeEnabled();
    await expect(primary).toContainText("Rp7,541");
    const layout = await page.locator(".denom-card").evaluateAll((cards) => cards.map((card) => {
      const price = card.lastElementChild! as HTMLElement;
      const name = card.querySelector(".line-clamp-2")! as HTMLElement;
      return { priceInside: price.getBoundingClientRect().right <= card.getBoundingClientRect().right, priceNowrap: getComputedStyle(price).whiteSpace, nameHeight: name.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(name).lineHeight), height: card.getBoundingClientRect().height };
    }));
    for (const row of layout) { expect(row.priceInside).toBe(true); expect(row.priceNowrap).toBe("nowrap"); expect(row.nameHeight).toBeLessThanOrEqual(row.lineHeight * 2 + 1); expect(row.height).toBeGreaterThanOrEqual(44); }
    await primary.scrollIntoViewIfNeeded();
    await expect(sticky).toHaveCount(0);
    await expect(page.getByTestId("purchase-bar-spacer")).toHaveCount(0);
    await assertNoOverflow(page);
    if ([320, 390, 1280].includes(width)) {
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: resolve(artifacts, `checkout-${width}-primary.png`), fullPage: true });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    if (width < 1024) {
      await expect(sticky).toBeVisible();
      await expect(sticky).toContainText("Rp7,541");
      await expect(page.getByTestId("purchase-bar-spacer")).toBeAttached();
      const barHeight = (await sticky.boundingBox())!.height;
      await expect.poll(async () => (await page.getByTestId("purchase-bar-spacer").boundingBox())!.height).toBe(barHeight);
      expect(await sticky.evaluate((el) => (el as HTMLElement).style.paddingBottom)).toContain("safe-area-inset-bottom");
      if ([320, 390].includes(width)) await page.screenshot({ path: resolve(artifacts, `checkout-${width}-sticky.png`) });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const primaryAtFooter = await primary.boundingBox();
      const primaryIntersects = primaryAtFooter!.y < 900 && primaryAtFooter!.y + primaryAtFooter!.height > 0;
      if (primaryIntersects) await expect(sticky).toHaveCount(0);
      else await expect(sticky).toBeVisible();
      const footerLimit = primaryIntersects ? 900 : (await sticky.boundingBox())!.y;
      await expect.poll(async () => (await page.locator("footer").boundingBox())!.y + (await page.locator("footer").boundingBox())!.height).toBeLessThanOrEqual(footerLimit + 1);
      await primary.scrollIntoViewIfNeeded();
      await expect(sticky).toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(sticky).toHaveCount(0);
      await page.setViewportSize({ width, height: 900 });
      await expect(sticky).toBeVisible();
    } else {
      await expect(sticky).toHaveCount(0);
    }
    await assertNoOverflow(page);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("choosing a top-up amount retains account details and submits them with the selected amount", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const unexpected = await mockApi(page);
  await page.goto("/p/configured-game");
  await page.getByLabel("Player ID", { exact: true }).fill("4531475056881819915");
  await page.getByLabel("Region (Optional)", { exact: true }).selectOption("Europe");
  await page.locator('.denom-card[data-denom-id="2"]').click();
  await expect(page.getByLabel("Player ID", { exact: true })).toHaveValue("4531475056881819915");
  await expect(page.getByLabel("Region (Optional)", { exact: true })).toHaveValue("Europe");
  const primary = page.locator("#instant-buy-submit");
  await expect(primary).toContainText("Rp7,541");
  await expect(primary).toBeEnabled();
  const orders: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/topup/order", async (route) => {
    orders.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { error: "web.pay_method_unavailable" } });
  });
  await primary.click();
  await expect.poll(() => orders.length).toBe(1);
  expect(orders[0]).toMatchObject({ denomination_id: 2, customer_data: [{ player_id: "4531475056881819915", region: "Europe" }] });
  expect(unexpected).toEqual([]);
});

test("ID-only metadata, blur constraints, trimmed payload, and synchronous duplicate guard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const data = { ...product, denominations: [{ ...product.denominations[0]!, additional_fields: [player] }] };
  await mockApi(page, data);
  await page.goto("/p/configured-game");
  const input = page.getByLabel("Player ID", { exact: true });
  await expect(input).toBeVisible();
  await expect(page.getByLabel(/Zone|Server|Region/)).toHaveCount(0);
  await input.fill("1");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await input.blur();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await input.fill(" 4531475056881819915 ");
  const primary = page.locator("#instant-buy-submit");
  await expect(primary).toBeEnabled();
  const orders: Array<Record<string, unknown>> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/topup/order", async (route) => { orders.push(route.request().postDataJSON()); await held; await route.fulfill({ status: 400, json: { error: "web.pay_method_unavailable" } }); });
  await primary.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => orders.length).toBe(1);
  expect(orders[0]).toMatchObject({ customer_data: [{ player_id: "4531475056881819915" }], voucher_code: "" });
  await expect(primary).toContainText("Processing");
  await expect(primary).toBeDisabled();
  release();
});
