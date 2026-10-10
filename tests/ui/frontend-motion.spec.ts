import { test, expect, type Page } from "@playwright/test";
import type { ProductPageData, CheckoutData, ShopContext } from "../../apps/storefront/client/src/api/types";
import type { ProductCardData } from "../../apps/storefront/client/src/components/shop/ProductCard";

const store = "http://127.0.0.1:8350";
const context: ShopContext = {
  lang: "en", fx: "16000", shop_name: "Trustance", shop_tagline: "Digital products",
  cart_count: 0, customer: { username: "buyer", email: null, telegram_linked: false },
  favicon_url: "", logo_url: "", bot_username: "testbot", support_telegram_url: null,
  wa_number: null, tzname: "Asia/Jakarta", currency: "IDR",
};
const products: ProductCardData[] = Array.from({ length: 48 }, (_, index) => ({
  slug: index === 0 ? "premium" : `product-${index}`, name: `Digital Product ${index + 1}`,
  category_name: "Digital Apps", from_price: "79000", variant_count: 1, image: null,
  available: 10, rating: null, rating_count: 0, bulk_discount: null, bulk_min_qty: null,
  all_non_auto: false, all_local_inventory: true,
}));
const premium: ProductPageData = {
  product: {
    slug: "premium", name: "Premium App", description: "Account plan for your app.",
    what_you_get: "Your selected account plan.", terms: "Read the plan before purchasing.", warranty_note: null,
    category_name: "Digital Apps", category_slug: "apps", image: null, image_kind: "generic",
    rating: null, rating_count: 0, checkout_flow: "catalog", template: "catalog",
  },
  denominations: [{ id: 1, name: "One Month", duration_label: "1 Month", price: "79000", warranty_days: 7,
    available: 10, in_stock: true, uses_local_inventory: true, purchasable: true, bulk: null,
    delivery_type: "auto", additional_fields: [] }],
  default_restock_denomination_id: 1, related_products: [], reviews: [], low_threshold: 5,
};
const game: ProductPageData = {
  ...premium,
  product: { ...premium.product, slug: "game", name: "Game Top Up", description: "Game credits for your player.",
    what_you_get: "Credits for the selected player.", category_name: "Games", category_slug: "games",
    checkout_flow: "instant", template: "game", image_kind: "game" },
  denominations: [1, 2].map(id => ({ id, name: `${id * 100} Coins`, duration_label: null, price: "5078", warranty_days: 0,
    available: 0, in_stock: false, uses_local_inventory: false, purchasable: true, bulk: null,
    delivery_type: "manual_with_info", input_configuration_valid: true,
    additional_fields: [{ key: "player_id", label: { en: "Player ID", id: "ID Pemain" }, type: "number", required: true, options: [], placeholder: "Player ID", minLength: 3 }] })),
};
const preview: CheckoutData = {
  items_empty: false, items: [{ denomination_id: 1, delivery_type: "manual_with_info", additional_fields: game.denominations[0]!.additional_fields, qty: 1 }],
  subtotal: "5078", total: "5078", bulk_discount: "0", voucher_discount: "0", qris_admin_fee: "136", qris_grand_total: "5214",
  total_usdt: "0.33", voucher_code: "", error_key: null, binance_enabled: false, bybit_enabled: false,
  bybit_bsc_enabled: false, idr_enabled: true, paydisini_enabled: false, nowpayments_enabled: false,
  wallet_idr: "0", wallet_usdt: "0", wallet_idr_enabled: false, wallet_usdt_enabled: false,
  is_guest: false, below_all_minimums: false,
};
const categories = [
  { id: 1, name: "Games", group: "GAME_TOPUP", slug: "games", isActive: true },
  { id: 2, name: "Digital Apps", group: "PREMIUM_APPS", slug: "apps", isActive: true },
  { id: 3, name: "Legacy", group: null, slug: "legacy", isActive: true },
];

async function mockApi(page: Page) {
  const unexpected: string[] = [];
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown;
    if (path === "/api/catalog") body = { categories, products: categories.map((category, i) => ({ id: i + 1, name: category.name, category, isActive: true, isArchived: false, webImageUrl: null, createdAt: "2026-01-01T00:00:00Z", _count: { denominations: 1 }, gameVariant: null, gameRegion: null, gameVariantEmoji: null })) };
    else if (path === "/api/settings") body = { fields: [{ key: "shop_name", value: "Trustance" }] };
    else if (path === "/api/dashboard/inventory") body = [];
    else if (path === "/api/dashboard/operations") body = { pendingPayments: 0, manualReviews: 0 };
    else if (path === "/api/search") body = { q: url.searchParams.get("q"), exactOrderId: null, products: [{ id: 1, name: "Premium App" }], users: [] };
    else if (path === "/api/v1/pages/context") body = context;
    else if (path === "/api/v1/pages/products") body = { products, low_threshold: 5 };
    else if (path === "/api/v1/pages/home") body = { products: products.slice(0, 3), categories: [], hero_image: null, testimonials: [], low_threshold: 5, bot_username: "testbot", support_telegram_url: null, wa_number: "" };
    else if (path === "/api/v1/pages/product/premium") body = premium;
    else if (path === "/api/v1/pages/product/game") body = game;
    else if (path === "/api/v1/topup/preview") body = { ...preview, items: [{ ...preview.items[0], denomination_id: route.request().postDataJSON().denomination_id }] };
    else if (path === "/api/v1/pages/search") body = { q: url.searchParams.get("q"), products: products.slice(0, 1), low_threshold: 5 };
    else if (path === "/api/v1/topup/check-account") body = { available: false };
    else { unexpected.push(path); await route.fulfill({ status: 500, json: { error: "Unexpected mock request" } }); return; }
    await route.fulfill({ json: body });
  });
  return unexpected;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (await page.locator("main").count()) {
    expect(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
}

for (const width of [360, 375, 390, 430, 768, 1280, 1440]) {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test.describe(`${width}px / ${reducedMotion}`, () => {
      test.use({ viewport: { width, height: 900 }, contextOptions: { reducedMotion } });

      test("admin keyboard overlays, family filters and nested surfaces", async ({ page }, info) => {
        const unexpected = await mockApi(page);
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto("/catalog");
        expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(reducedMotion === "reduce");
        await expect(page.getByRole("tab", { name: "All Products (3)" })).toBeVisible();
        await page.getByRole("tab", { name: "Game Top-Up (1)" }).click();
        await expect(page.getByRole("tab", { name: "Game Top-Up (1)" })).toHaveAttribute("data-state", "active");
        await page.getByRole("tab", { name: "Digital Apps (2)" }).click();
        await expect(page.getByText("Legacy", { exact: true }).first()).toBeVisible();
        await noOverflow(page);
        if (width < 768) {
          const inset = page.locator("main .border-transparent.bg-sand").first();
          await expect(inset).toBeVisible();
        }
        if (width < 1024) {
          const trigger = page.getByRole("button", { name: "Open navigation" });
          await trigger.click();
          const drawer = page.getByRole("dialog", { name: "Navigation" });
          await expect(drawer).toBeVisible();
          await page.keyboard.press("Shift+Tab");
          expect(await drawer.evaluate(el => el.contains(document.activeElement))).toBe(true);
          await page.keyboard.press("Escape");
          await expect(drawer).toHaveCount(0);
          await expect(trigger).toBeFocused();
          await trigger.click();
          await page.getByRole("button", { name: "Close navigation" }).last().click();
          await expect(drawer).toHaveCount(0);
        }
        const quick = page.getByRole("button", { name: "Quick actions" });
        await quick.focus();
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("menuitem", { name: "Add Product" })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(quick).toBeFocused();
        await expect(quick).toHaveAttribute("aria-expanded", "false");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        const search = page.getByRole("dialog", { name: "Search", exact: true });
        const input = search.getByRole("textbox");
        await expect(input).toBeFocused();
        await input.pressSequentially("premium");
        await expect(input).toHaveValue("premium");
        await expect(search.getByRole("button", { name: "Premium App" })).toBeVisible();
        await expect(input).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        expect(await search.evaluate(el => el.contains(document.activeElement))).toBe(true);
        await page.keyboard.press("Escape");
        await expect(search).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Search", exact: true })).toBeFocused();
        if ([390, 1440].includes(width) && reducedMotion === "no-preference") await page.screenshot({ path: info.outputPath("admin-after.png"), fullPage: true });
        expect(unexpected).toEqual([]);
        expect(errors).toEqual([]);
      });

      test("storefront visible catalog, truthful family controls and selected feedback", async ({ page }, info) => {
        const unexpected = await mockApi(page);
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${store}/products`);
        expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(reducedMotion === "reduce");
        await expect(page.getByRole("heading", { name: "Digital Product 48", exact: true })).toBeAttached();
        const lastCard = page.locator('a[href="/p/product-47"]').first();
        expect(await lastCard.evaluate(el => {
          for (let node: Element | null = el; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) === 0) return false;
          return true;
        })).toBe(true);
        await noOverflow(page);
        await page.locator('a[href="/p/premium"]').first().click();
        await expect(page.getByRole("heading", { name: "Premium App", exact: true })).toBeVisible();
        await expect(page.getByLabel("Player ID", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("radio").first()).toBeChecked();
        await noOverflow(page);
        await page.goBack();
        await expect(page.getByRole("heading", { name: "Digital Product 48", exact: true })).toBeAttached();
        await page.goForward();
        await expect(page.getByRole("heading", { name: "Premium App", exact: true })).toBeVisible();
        await page.goto(`${store}/p/game`);
        await page.getByLabel("Player ID", { exact: true }).fill("4531475056881819915");
        await expect(page.locator("#checkout-summary .card-inset")).toContainText("4531475056881819915");
        const selected = page.locator(".denom-card").filter({ has: page.getByRole("radio", { checked: true }) });
        expect(await selected.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(230, 239, 254)");
        await page.getByRole("radio").first().focus();
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("radio").nth(1)).toBeChecked();
        await expect(page.locator("#checkout-summary")).toContainText("4531475056881819915");
        await expect(page.locator("#instant-buy-submit")).toContainText("Rp5,214");
        await noOverflow(page);
        if ([390, 1440].includes(width) && reducedMotion === "no-preference") {
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          await page.screenshot({ path: info.outputPath("game-summary-after.png"), fullPage: true });
        }
        await page.goto(store);
        await expect(page.locator("#products")).toBeAttached();
        expect(await page.locator(".reveal").count()).toBe(0);
        await noOverflow(page);
        expect(unexpected).toEqual([]);
        expect(errors).toEqual([]);
      });
    });
  }
}

test("drawer releases modal state when resized to desktop", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/catalog");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => page.locator("body").evaluate(el => getComputedStyle(el).pointerEvents)).toBe("auto");
});

test("search can reopen before its exit finishes without losing focus or trapping the page", async ({ page }) => {
  await mockApi(page);
  await page.goto("/catalog");
  const trigger = page.getByRole("button", { name: "Search", exact: true });
  await trigger.click();
  const input = page.getByRole("dialog", { name: "Search", exact: true }).getByRole("textbox");
  await expect(input).toBeFocused();
  // Consecutive shortcut events occur within the 150ms exit transition.
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.keyboard.press("Control+k");
    await page.keyboard.press("Control+k");
    await expect(input).toBeFocused();
  }
  await input.fill("premium");
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.locator("body").evaluate(el => getComputedStyle(el).pointerEvents)).toBe("auto");
});

test.describe("touch navigation", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("storefront drawer, search typing and desktop resize release", async ({ page }) => {
    const unexpected = await mockApi(page);
    await page.goto(`${store}/products`);
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    expect((await menu.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    await menu.tap();
    const drawer = page.getByRole("dialog", { name: "Menu", exact: true });
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    expect(await drawer.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await drawer.getByRole("button", { name: "Close menu" }).tap();
    await expect(drawer).toHaveCount(0);
    await expect(menu).toBeFocused();
    const search = page.getByRole("button", { name: "Search", exact: true });
    await search.tap();
    const input = page.getByRole("dialog").getByRole("combobox");
    await expect(input).toBeFocused();
    await input.pressSequentially("digital");
    await expect(page.getByRole("dialog").getByRole("option").first()).toContainText("Digital Product 1");
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(search).toBeFocused();
    await menu.tap();
    await expect(drawer).toBeVisible();
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => page.locator("body").evaluate(el => el.style.overflow)).toBe("");
    expect(unexpected).toEqual([]);
  });

  test("admin touch controls and menu dismissal", async ({ page }) => {
    await mockApi(page);
    await page.goto("/catalog");
    const add = page.getByRole("button", { name: "Add Product", exact: true });
    expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Quick actions" }).tap();
    const item = page.getByRole("menuitem", { name: "Add Product" });
    await expect.poll(async () => (await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await noOverflow(page);
  });
});
