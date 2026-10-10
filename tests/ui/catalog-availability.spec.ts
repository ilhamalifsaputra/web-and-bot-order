import { test, expect } from "@playwright/test";

const categories = [
  { id: 1, name: "Mobile Games", group: "GAME_TOPUP", slug: "games", isActive: true },
  { id: 2, name: "Creative", group: "PREMIUM_APPS", slug: "apps", isActive: true },
  { id: 3, name: "Legacy", group: null, slug: "legacy", isActive: true },
];
const products = categories.map((category, index) => ({
  id: index + 1, name: ["Mobile Legends", "CapCut Pro", "Legacy App"][index], category,
  isActive: true, isArchived: false, webImageUrl: null, createdAt: "2026-01-01T00:00:00Z",
  _count: { denominations: 1 }, gameVariant: null, gameRegion: null, gameVariantEmoji: null,
}));

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === "/api/catalog") body = { products, categories };
    if (path === "/api/settings") body = { fields: [{ key: "shop_name", value: "Trustance" }] };
    if (path === "/api/dashboard/inventory") body = [];
    if (path === "/api/dashboard/operations") body = { pendingPayments: 0, manualReviews: 0 };
    if (path === "/api/stock/10") body = {
      product: { id: 10, name: "Provider Plan", isActive: true, usesLocalInventory: false, product: products[0] },
      items: [], total: 0, waiting: 0, statusCounts: { available: 0, reserved: 0, sold: 0, dead: 0 },
    };
    await route.fulfill({ json: body });
  });
});

for (const width of [360, 1440]) {
  test(`catalog filters, legacy family and navigation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/catalog");
    await expect(page.getByRole("tab", { name: "All Products (3)" })).toBeVisible();
    await page.getByRole("tab", { name: "Game Top-Up (1)" }).click();
    await expect(page.getByText("Mobile Legends", { exact: true })).toBeVisible();
    await expect(page.getByText("CapCut Pro", { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/tab=game/);
    await expect.poll(() => page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("catalog-game.png"), fullPage: true });
    await page.getByRole("tab", { name: "Digital Apps (2)" }).click();
    await expect(page.getByText("Legacy App", { exact: true })).toBeVisible();
    await expect(page.getByText("Mobile Legends", { exact: true })).toHaveCount(0);
    await page.getByPlaceholder("Filter by product or category…").fill("CapCut");
    await expect(page.getByText("CapCut Pro", { exact: true })).toBeVisible();
    await expect(page.getByText("Legacy App", { exact: true })).toHaveCount(0);
    if (width < 1024) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
      await page.getByRole("button", { name: "Close navigation" }).click();
      await expect(page.getByRole("button", { name: "Close navigation" })).not.toBeInViewport();
    }
  });

  test(`direct provider stock link offers no inventory controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/stock/10");
    await expect(page.getByText(/does not use local inventory/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Stock", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /download credentials/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "View product" })).toHaveAttribute("href", "/catalog/1");
    await expect.poll(() => page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}
