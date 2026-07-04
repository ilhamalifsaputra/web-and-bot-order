// React-SPA JSON layer tests (/api/v1/pages, /api/v1/auth, cart/checkout/
// account twins) + the SPA shell wildcard. Pattern: api.test.ts — app.inject()
// against an isolated temp DB; the happy/auth-fail/bad-csrf trio per mutating
// endpoint (CLAUDE.md).
//
// NOTE: the shell tests read apps/storefront/static/shop-app/index.html — run
// `pnpm --filter @app/storefront-client build` first (same contract as the
// web-admin dashboard SPA).
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  createCatalogProduct,
  createDenomination,
  addToCart,
} from "@app/db";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let categorySlug: string;
let productSlug: string;
let denomId: number;

/** Sign in via the JSON endpoint, then scrape the CSRF token from the SPA
 * shell's <meta name="csrf-token"> — the exact wiring the React client uses. */
async function loginAs(identifier: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  expect(res.statusCode).toBe(200);
  const c = res.headers["set-cookie"];
  const cookie = Array.isArray(c) ? c.join("; ") : String(c);
  const shell = await app.inject({ method: "GET", url: "/spa-shell-probe", headers: { cookie } });
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(shell.body)![1]!;
  expect(csrf).not.toBe("");
  return { cookie, csrf };
}

async function makeUser(username: string, password: string, refCode: string): Promise<number> {
  const u = await prisma.user.create({
    data: {
      loginUsername: username,
      email: `${username}@u.test`,
      passwordHash: hashPassword(password),
      referralCode: refCode,
    },
  });
  return u.id;
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Streaming", slug: "streaming", emoji: "🎬", sortOrder: 1 },
  });
  categorySlug = cat.slug;
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Netflix Premium" });
  productSlug = product.slug;
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "1 Month",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "40000",
  });
  denomId = denom.id;
  await prisma.stockItem.createMany({
    data: Array.from({ length: 5 }, () => ({
      productId: denomId,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "SPA Test Shop");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

// ---------------------------------------------------------------- SPA shell
describe("SPA shell wildcard", () => {
  it("serves the shell with an empty CSRF meta and the request language for anonymous visitors", async () => {
    const res = await app.inject({ method: "GET", url: "/spa-shell-probe" });
    expect(res.statusCode).toBe(404); // unknown path → real 404 status, SPA error visuals
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('name="csrf-token" content=""');
    expect(res.body).toContain('<html lang="en">');
    expect(res.body).toContain("<title>404 — SPA Test Shop</title>");
  });

  it("respects the shop_lang cookie in the <html lang> substitution", async () => {
    const res = await app.inject({ method: "GET", url: "/spa-shell-probe", headers: { cookie: "shop_lang=id" } });
    expect(res.body).toContain('<html lang="id">');
  });

  it("injects the session CSRF token for signed-in visitors", async () => {
    await makeUser("shelluser", "shell-pw-123", "SHELLREF");
    const { csrf } = await loginAs("shelluser", "shell-pw-123");
    expect(csrf.length).toBeGreaterThan(10);
  });

  it("404s /api/* misses as JSON, not the HTML shell", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/no-such-endpoint" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});

// ------------------------------------------------------------- /pages reads
describe("GET /api/v1/pages/context", () => {
  it("returns the anonymous chrome context with the guest cart count", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/context" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shop_name).toBe("SPA Test Shop");
    expect(body.customer).toBeNull();
    expect(body.cart_count).toBe(0);
    expect(body.lang).toBe("en");
    expect(typeof body.tzname).toBe("string");
  });

  it("returns customer display fields when signed in — and never the CSRF token", async () => {
    await makeUser("ctxuser", "ctx-pw-12345", "CTXREF");
    const { cookie } = await loginAs("ctxuser", "ctx-pw-12345");
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/context", headers: { cookie } });
    const body = res.json();
    expect(body.customer).toMatchObject({ username: "ctxuser", telegram_linked: false });
    expect(JSON.stringify(body)).not.toContain("csrf");
  });
});

describe("GET /api/v1/pages/*", () => {
  it("home returns cards + stats + categories", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/home" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.products.some((p: { slug: string }) => p.slug === productSlug)).toBe(true);
    expect(body.categories.some((c: { slug: string }) => c.slug === categorySlug)).toBe(true);
    expect(body.stats).toHaveProperty("has_data");
    expect(typeof body.low_threshold).toBe("number");
  });

  it("category returns cards; unknown slug 404s", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/v1/pages/category/${categorySlug}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().category.slug).toBe(categorySlug);
    const miss = await app.inject({ method: "GET", url: "/api/v1/pages/category/nope" });
    expect(miss.statusCode).toBe(404);
  });

  it("product returns denominations + restock default; unknown slug 404s", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/v1/pages/product/${productSlug}` });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.product.slug).toBe(productSlug);
    expect(body.denominations[0]).toMatchObject({ id: denomId, price: "40000", in_stock: true });
    expect(body.default_restock_denomination_id).toBe(denomId);
    const miss = await app.inject({ method: "GET", url: "/api/v1/pages/product/nope" });
    expect(miss.statusCode).toBe(404);
  });

  it("search returns matches for q", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/search?q=netflix" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.q).toBe("netflix");
    expect(body.products.some((p: { slug: string }) => p.slug === productSlug)).toBe(true);
  });
});

// ------------------------------------------------------------------- /auth
describe("/api/v1/auth", () => {
  it("login: wrong credentials get the generic 403 key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier: "nobody", password: "wrong-password" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "web.login_failed" });
  });

  it("login: success sets the session cookie and returns a safe redirect", async () => {
    await makeUser("loginuser", "login-pw-1234", "LOGREF");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier: "loginuser", password: "login-pw-1234", next: "https://evil.example/x" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirect).toBe("/"); // open-redirect guard
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("login merges the guest cart into the account", async () => {
    await makeUser("mergeuser", "merge-pw-1234", "MRGREF");
    const add = await app.inject({
      method: "POST",
      url: "/api/v1/cart",
      payload: { denomination_id: denomId, qty: 2 },
    });
    const guestCookie = (Array.isArray(add.headers["set-cookie"]) ? add.headers["set-cookie"] : [String(add.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { cookie: guestCookie },
      payload: { identifier: "mergeuser", password: "merge-pw-1234" },
    });
    expect(login.statusCode).toBe(200);
    const sessionCookie = (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"] : [String(login.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");
    const cart = await app.inject({ method: "GET", url: "/api/v1/cart", headers: { cookie: sessionCookie } });
    expect(cart.json().items[0]).toMatchObject({ denomination_id: denomId, qty: 2 });
  });

  it("register: validation errors return i18n keys; success signs in", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "x", email: "not-an-email", password: "12345678", password2: "12345678" },
    });
    expect(bad.statusCode).toBe(400);
    expect(String(bad.json().error)).toMatch(/^web\./);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "reguser1", email: "reguser1@u.test", password: "register-pw-1", password2: "register-pw-1" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["set-cookie"]).toBeDefined();
  });

  it("logout rotates the jti so the old cookie stops working", async () => {
    await makeUser("logoutuser", "logout-pw-123", "OUTREF");
    const { cookie } = await loginAs("logoutuser", "logout-pw-123");
    const out = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ redirect: "/" });
    // The OLD cookie is dead server-side (jti rotated), not just cleared client-side.
    const after = await app.inject({ method: "GET", url: "/api/v1/account", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("reset: an invalid token gets web.reset_invalid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset/not-a-real-token",
      payload: { password: "new-password-1", password2: "new-password-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "web.reset_invalid" });
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("telegram-widget returns bot_username + a safe auth_url", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/telegram-widget?next=//evil&ref=ABC" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.auth_url).toContain("next=%2F"); // safeNext collapsed //evil → /
    expect(body.auth_url).toContain("ref=ABC");
  });
});

// -------------------------------------------------------------------- /cart
describe("/api/v1/cart twins", () => {
  it("guest: GET/update/remove work with no CSRF (SameSite=Lax is the guard)", async () => {
    const add = await app.inject({ method: "POST", url: "/api/v1/cart", payload: { denomination_id: denomId, qty: 2 } });
    const cookie = (Array.isArray(add.headers["set-cookie"]) ? add.headers["set-cookie"] : [String(add.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");

    const upd = await app.inject({
      method: "POST",
      url: "/api/v1/cart/update",
      headers: { cookie },
      payload: { key: denomId, qty: 5 },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().items[0]).toMatchObject({ qty: 5 });
    expect(upd.json().subtotal).toBe("200000");

    const updCookie = (Array.isArray(upd.headers["set-cookie"]) ? upd.headers["set-cookie"] : [String(upd.headers["set-cookie"])])
      .map((c) => c.split(";")[0])
      .join("; ");
    const rm = await app.inject({
      method: "POST",
      url: "/api/v1/cart/remove",
      headers: { cookie: updCookie },
      payload: { key: denomId },
    });
    expect(rm.statusCode).toBe(200);
    expect(rm.json().items).toHaveLength(0);
  });

  it("signed-in: update needs the x-csrf-token header (trio)", async () => {
    const uid = await makeUser("cartspauser", "cartspa-pw-12", "CSPREF");
    const { cookie, csrf } = await loginAs("cartspauser", "cartspa-pw-12");
    await addToCart(prisma, uid, denomId, 1);
    const rows = await prisma.cartItem.findMany({ where: { userId: uid } });
    const key = rows[0]!.id;

    const noToken = await app.inject({
      method: "POST",
      url: "/api/v1/cart/update",
      headers: { cookie },
      payload: { key, qty: 3 },
    });
    expect(noToken.statusCode).toBe(403);

    const badToken = await app.inject({
      method: "POST",
      url: "/api/v1/cart/update",
      headers: { cookie, "x-csrf-token": "bad" },
      payload: { key, qty: 3 },
    });
    expect(badToken.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/cart/update",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { key, qty: 3 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items[0]).toMatchObject({ qty: 3 });
  });
});

// ---------------------------------------------------------------- /checkout
describe("/api/v1/checkout + orders", () => {
  it("GET /checkout 401s anonymously (JSON, not a redirect)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/checkout" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  describe("signed-in buyer", () => {
    let cookie: string;
    let csrf: string;
    let orderCode: string;

    beforeAll(async () => {
      const uid = await makeUser("spabuyer", "spabuyer-pw-1", "SPABUY");
      const session = await loginAs("spabuyer", "spabuyer-pw-1");
      cookie = session.cookie;
      csrf = session.csrf;
      await addToCart(prisma, uid, denomId, 1);
      await setSetting(prisma, "bybit_uid", "123456789");
      await setSetting(prisma, "bybit_api_key", "k");
      await setSetting(prisma, "bybit_api_secret", "s");
      await setSetting(prisma, "usd_idr_rate", "16000");
    });

    it("GET /checkout returns totals + method flags + wallet balances", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items_empty).toBe(false);
      expect(body.subtotal).toBe("40000");
      expect(body.bybit_enabled).toBe(true);
      expect(body).toHaveProperty("wallet_idr");
      expect(body).toHaveProperty("wallet_usdt");
    });

    it("voucher preview: trio + unknown voucher key in error_key", async () => {
      const anon = await app.inject({ method: "POST", url: "/api/v1/checkout/voucher/preview", payload: { voucher_code: "X" } });
      expect(anon.statusCode).toBe(401);
      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/checkout/voucher/preview",
        headers: { cookie, "x-csrf-token": "bad" },
        payload: { voucher_code: "X" },
      });
      expect(bad.statusCode).toBe(403);
      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/checkout/voucher/preview",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { voucher_code: "NOPE" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().error_key).toBe("error.voucher_not_found");
    });

    it("POST /api/v1/checkout (existing endpoint) creates the order", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/checkout",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { method: "bybit" },
      });
      expect(res.statusCode).toBe(201);
      orderCode = res.json().order_code;
    });

    it("GET /orders/:code/pay returns pay data for the owner; 404 for others", async () => {
      const res = await app.inject({ method: "GET", url: `/api/v1/orders/${orderCode}/pay`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.order.code).toBe(orderCode);
      expect(body.state).toBe("waiting");
      expect(body.is_bybit).toBe(true);
      expect(body.bybit_uid).toBe("123456789");

      await makeUser("otherbuyer", "otherbuyer-pw", "OTHBUY");
      const other = await loginAs("otherbuyer", "otherbuyer-pw");
      const probe = await app.inject({ method: "GET", url: `/api/v1/orders/${orderCode}/pay`, headers: { cookie: other.cookie } });
      expect(probe.statusCode).toBe(404); // ownership → 404, never 403
    });

    it("GET /orders/:code/status returns {state, redirect}", async () => {
      const res = await app.inject({ method: "GET", url: `/api/v1/orders/${orderCode}/status`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ state: "waiting", redirect: null });
    });

    it("POST /orders/:code/cancel: trio, then the order is closed", async () => {
      const anon = await app.inject({ method: "POST", url: `/api/v1/orders/${orderCode}/cancel` });
      expect(anon.statusCode).toBe(401);
      const bad = await app.inject({
        method: "POST",
        url: `/api/v1/orders/${orderCode}/cancel`,
        headers: { cookie, "x-csrf-token": "bad" },
      });
      expect(bad.statusCode).toBe(403);
      const ok = await app.inject({
        method: "POST",
        url: `/api/v1/orders/${orderCode}/cancel`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(ok.statusCode).toBe(200);
      const status = await app.inject({ method: "GET", url: `/api/v1/orders/${orderCode}/status`, headers: { cookie } });
      expect(status.json().state).toBe("closed");
    });
  });
});

// ----------------------------------------------------------------- /account
describe("/api/v1/account twins", () => {
  it("reads 401 anonymously", async () => {
    for (const url of ["/api/v1/account", "/api/v1/account/orders", "/api/v1/account/settings"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
  });

  describe("signed in", () => {
    let cookie: string;
    let csrf: string;

    beforeAll(async () => {
      await makeUser("accspauser", "accspa-pw-123", "ACCSPA");
      const session = await loginAs("accspauser", "accspa-pw-123");
      cookie = session.cookie;
      csrf = session.csrf;
    });

    it("GET /account returns the overview", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/account", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.referral_code).toBe("ACCSPA");
      expect(body.order_count).toBe(0);
    });

    it("support ticket: create (trio) → list → detail → reply", async () => {
      const anon = await app.inject({ method: "POST", url: "/api/v1/account/support", payload: { message: "help" } });
      expect(anon.statusCode).toBe(401);
      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": "bad" },
        payload: { message: "help" },
      });
      expect(bad.statusCode).toBe(403);
      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "help me please" },
      });
      expect(ok.statusCode).toBe(200);

      const list = await app.inject({ method: "GET", url: "/api/v1/account/support", headers: { cookie } });
      const ticket = list.json().tickets[0];
      expect(ticket.message).toBe("help me please");
      expect(typeof ticket.created_at_display).toBe("string");

      const detail = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticket.id}`, headers: { cookie } });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().ticket.id).toBe(ticket.id);

      const reply = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticket.id}/reply`,
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "more details" },
      });
      expect(reply.statusCode).toBe(200);
      const detail2 = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticket.id}`, headers: { cookie } });
      expect(detail2.json().messages.some((m: { content: string }) => m.content === "more details")).toBe(true);
    });

    it("another user's ticket 404s (never 403)", async () => {
      const list = await app.inject({ method: "GET", url: "/api/v1/account/support", headers: { cookie } });
      const ticketId = list.json().tickets[0].id;
      await makeUser("noseyuser", "nosey-pw-1234", "NOSEY1");
      const other = await loginAs("noseyuser", "nosey-pw-1234");
      const probe = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie: other.cookie } });
      expect(probe.statusCode).toBe(404);
    });

    it("restock subscribe returns the product redirect (trio-lite)", async () => {
      const anon = await app.inject({ method: "POST", url: `/api/v1/restock/${denomId}` });
      expect(anon.statusCode).toBe(401);
      const ok = await app.inject({
        method: "POST",
        url: `/api/v1/restock/${denomId}`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().redirect).toBe(`/p/${productSlug}`);
    });

    it("settings credentials: wrong current_password 400s; correct one saves and reports password_changed", async () => {
      const wrong = await app.inject({
        method: "POST",
        url: "/api/v1/account/settings/credentials",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { new_password: "brand-new-pw-1", current_password: "not-my-password" },
      });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json()).toEqual({ error: "web.settings_wrong_password" });

      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/account/settings/credentials",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { new_password: "brand-new-pw-1", current_password: "accspa-pw-123" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true, password_changed: true });
      // The response refreshed OUR cookie (rotated jti) — the old cookie string
      // is stale now; other sessions are invalidated.
      expect(ok.headers["set-cookie"]).toBeDefined();
    });
  });
});
