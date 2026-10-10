import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const phase = process.env.AUDIT_PHASE === "before" ? "before" : "after";
const output = resolve(__dirname, "../../docs/audit/ux-screenshots");
mkdirSync(output, { recursive: true });
const publicRoutes = ["/", "/categories", "/products", "/c/audit-apps", "/c/audit-games", "/c/audit-legacy", "/p/audit-subscription", "/p/audit-game", "/p/audit-legacy-app", "/flash", "/cart", "/checkout", "/track", "/help", "/about", "/contact", "/how-to-order", "/terms", "/privacy", "/refund", "/login", "/register", "/forgot", "/reset/audit-invalid", "/audit-not-found"];

test("screenshots mobile and desktop before/after", async ({ page }) => {
  for (const [width, height] of [[360, 800], [390, 844], [430, 932], [1280, 800], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/contact");
    await expect(page.locator("footer")).toContainText("PT Contoh Audit Digital");
    await page.screenshot({ path: resolve(output, `${phase}-contact-${width}.png`), fullPage: true });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.screenshot({ path: resolve(output, `${phase}-home-${width}.png`), fullPage: true });
  }
});

// Login precedes the five reset-link checks: those intentionally share the auth IP throttle.
test("catalog to guest checkout and synthetic authenticated pages", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/search?q=unavailable-audit-product");
  const search = page.getByRole("combobox");
  await expect(search).toBeVisible();
  await expect(page.getByText('No results for "unavailable-audit-product"', { exact: false })).toBeVisible();
  await search.fill("Audit Subscription");
  await expect(page.getByRole("option")).toHaveCount(1);
  await search.press("ArrowDown");
  await search.press("Enter");
  await page.waitForURL(/\/p\/audit-subscription$/);
  await expect(page.getByRole("heading", { name: "Audit Subscription", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add to cart", exact: true }).click();
  await page.waitForURL(/\/cart$/);
  await page.getByRole("button", { name: /continue to payment/i }).click();
  await page.waitForURL(/\/checkout$/);
  await expect(page.getByRole("heading", { name: "Checkout", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /card|Xendit/i })).toHaveCount(0);
  await page.goto("/login");
  await page.getByLabel("Username or email").fill("auditshopper");
  await page.getByLabel("Password", { exact: true }).fill("Audit-local-only-2026!");
  const loginResponse = page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect((await loginResponse).status(), "Synthetic local login").toBe(200);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  for (const route of ["/account", "/account/orders", "/account/support", "/account/settings", "/account/referral", "/account/reviews", "/wallet/topup"]) {
    await page.goto(route);
    await expect(page.locator("h1").first(), route).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route).toBe(true);
  }
  await page.goto("/p/audit-game");
  await expect(page.getByRole("heading", { name: "Audit Game", exact: true })).toBeVisible();
  await expect(page.getByLabel("Player ID")).toBeVisible();
  await page.getByLabel("Player ID").fill("123456789");
  await expect(page.getByLabel(/server|zone/i)).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("Your credentials");
});

test("public route smoke, brand assets, metadata and errors", async ({ page, request }) => {
  const errors: string[] = [];
  const consoleErrors: { text: string; path: string }[] = [];
  const failed: { path: string; status: number }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location().url;
    consoleErrors.push({ text: message.text(), path: url ? new URL(url).pathname : "" });
  });
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (url.origin === "http://127.0.0.1:8240" && r.status() >= 400) failed.push({ path: url.pathname, status: r.status() });
  });
  const rows = [];
  test.setTimeout(180_000);
  for (const [width, height] of [[360, 800], [390, 844], [430, 932], [1280, 800], [1440, 900]] as const) {
  for (const route of publicRoutes) {
    await page.setViewportSize({ width, height });
    const res = await page.goto(route);
    expect(res?.status(), route).toBe(route === "/audit-not-found" ? 404 : 200);
    if (route === "/help") await page.waitForURL(/\/login\?next=/);
    await expect(page.locator("h1").first(), route).toBeVisible();
    await expect(page.locator("body"), route).toContainText("Trustance");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route).toBe(true);
    if (!route.includes("not-found")) expect(await page.title()).toContain("Trustance");
    const favicon = await page.locator('link[rel="icon"]').getAttribute("href");
    expect((await request.get(favicon!)).status()).toBe(200);
    rows.push({ route, finalPath: new URL(page.url()).pathname, status: res!.status(), viewport: width, overflow: false, favicon });
  }
  }
  for (const route of ["/account", "/account/orders", "/account/orders/audit-order", "/account/support", "/account/support/99999", "/account/settings", "/account/referral", "/account/reviews", "/wallet/topup", "/wallet/topup/audit-order/pay", "/checkout/audit-order/pay", "/track", "/login", "/reset/audit-invalid"]) {
    const res = await request.get(route);
    expect(await res.text(), route).toContain('name="robots" content="noindex, nofollow"');
  }
  for (const route of ["/sitemap.xml", "/robots.txt"]) expect((await request.get(route)).status()).toBe(200);
  writeFileSync(resolve(output, "route-results.json"), JSON.stringify({ fixture: "local synthetic only", rows, errors, consoleErrors, failed }, null, 2));
  expect(errors).toEqual([]);
  expect(consoleErrors.filter((r) => !(r.text.startsWith("Failed to load resource:") && (r.path === "/audit-not-found" || r.path.startsWith("/api/v1/account/"))))).toEqual([]);
  // /help deliberately requires authentication; record those 401s, not as asset failures.
  expect(failed.filter((r) => r.path !== "/audit-not-found" && !(r.status === 401 && r.path.startsWith("/api/v1/account/")))).toEqual([]);
});

test("local initial-load performance sample", async ({ page }) => {
  await page.addInitScript(() => {
    const vitals = { lcpMs: null as number | null, cls: 0 };
    (window as Window & { auditVitals?: typeof vitals }).auditVitals = vitals;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) vitals.lcpMs = entry.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as PerformanceEntry & { hadRecentInput: boolean; value: number };
        if (!entry.hadRecentInput) vitals.cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const samples = [];
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator("h1")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // Explicit observation window after fonts/render; this is a lab sample,
    // not a field percentile or a Core Web Vitals pass/fail threshold.
    await page.waitForTimeout(1000);
    const sample = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const vitals = (window as Window & { auditVitals?: { lcpMs: number | null; cls: number } }).auditVitals;
      return { lcpMs: vitals?.lcpMs ?? null, initialCls: vitals?.cls ?? null, ttfbMs: nav.responseStart - nav.requestStart, transferBytes: nav.transferSize };
    });
    expect(sample.lcpMs).not.toBeNull();
    samples.push({ route: "/", viewport: width, ...sample });
  }
  writeFileSync(resolve(output, "performance-results.json"), JSON.stringify({ environment: "localhost Chromium, no CPU/network throttling, reduced motion, synthetic catalog; 1s initial observation; no INP or field measurement", samples }, null, 2));
});

test("footer disclosures, policies, safe area and drawer keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/contact");
  const footer = page.locator("footer");
  for (const name of ["Quick Links", "Contact"]) {
    const trigger = footer.getByRole("button", { name, exact: true });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    const id = await trigger.getAttribute("aria-controls");
    await expect(page.locator(`[id="${id}"]`)).toBeHidden();
    await trigger.focus(); await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`[id="${id}"]`)).toBeVisible();
    await page.keyboard.press("Space");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  }
  for (const href of ["/terms", "/privacy", "/refund"]) await expect(footer.locator(`a[href="${href}"]`).last()).toBeVisible();
  await footer.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const lastLink = footer.locator('a[href="/refund"]').last();
  const box = await lastLink.boundingBox();
  expect(box!.y + box!.height).toBeLessThan(800 - 56);
  await page.evaluate(() => window.scrollTo(0, 0));
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await menu.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(menu).toBeFocused();
});

test("configured official logo fits all target viewports", async ({ page }) => {
  // Asset-only interception: a byte-identical public Trustance upload, not a new logo.
  await page.route("**/audit/reference-logo.png", (route) => route.fulfill({ contentType: "image/png", path: resolve(__dirname, "fixtures/trustance-logo.png") }));
  await page.route("**/api/v1/pages/context", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), logo_url: "/audit/reference-logo.png" } });
  });
  for (const [width, height] of [[360, 800], [390, 844], [430, 932], [1280, 800], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/contact");
    const logo = page.locator("header").getByRole("img", { name: "Trustance" });
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator("footer").getByRole("img", { name: "Trustance" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(output, `after-owner-logo-${width}.png`) });
  }
});
