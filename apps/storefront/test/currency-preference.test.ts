// Multi-currency Task 4: the storefront's DISPLAY-currency preference —
// POST /api/v1/preferences/currency (cookie + DB for signed-in accounts),
// the `currency` field on GET /api/v1/pages/context, and one-time adoption of
// the cookie into User.preferredCurrency at sign-in. Display only: nothing
// here converts or charges money. Pattern: spa-api.test.ts (app.inject,
// setup-env, happy/auth-fail/bad-csrf per mutating endpoint).
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, initDb, setSetting, getUser, getUsdIdrRate } from "@app/db";
import { hashPassword } from "@app/core/password";
import { makeCustomerSession, newJti, shopSessionJtiKey, SHOP_COOKIE_NAME } from "../src/auth";
import { buildApp } from "../src/server";

let app: FastifyInstance;
const URL_PREF = "/api/v1/preferences/currency";

async function makeUser(username: string, password: string, preferredCurrency: string | null = null): Promise<number> {
  const u = await prisma.user.create({
    data: {
      loginUsername: username,
      email: `${username}@u.test`,
      passwordHash: hashPassword(password),
      referralCode: `CUR${Math.random().toString(36).slice(2, 10)}`,
      preferredCurrency,
    },
  });
  return u.id;
}

/** Sign in via the JSON endpoint, then scrape the CSRF meta from the shell. */
async function loginAs(
  identifier: string,
  password: string,
  extraCookie = "",
): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier, password },
    ...(extraCookie ? { headers: { cookie: extraCookie } } : {}),
  });
  expect(res.statusCode).toBe(200);
  const cookie = sessionCookieFrom(res.headers["set-cookie"]);
  const shell = await app.inject({ method: "GET", url: "/spa-shell-probe", headers: { cookie } });
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(shell.body)![1]!;
  return { cookie, csrf };
}

/** Only the `shop_session=...` pair out of a Set-Cookie header. */
function sessionCookieFrom(h: string | string[] | undefined): string {
  const all = Array.isArray(h) ? h : [String(h)];
  const line = all.find((c) => c.startsWith(`${SHOP_COOKIE_NAME}=`))!;
  return line.split(";")[0]!;
}

/** The `shop_currency` Set-Cookie line, or undefined when none was set. */
function currencySetCookie(h: string | string[] | undefined): string | undefined {
  const all = h === undefined ? [] : Array.isArray(h) ? h : [h];
  return all.find((c) => c.startsWith("shop_currency="));
}

/** A guest (isGuest) row with a live session — what guest checkout mints. */
async function guestSession(): Promise<{ userId: number; cookie: string; csrf: string; guestEmail: string }> {
  const guestEmail = `guest${Math.random().toString(36).slice(2, 8)}@g.test`;
  const u = await prisma.user.create({
    data: {
      isGuest: true,
      guestEmail,
      referralCode: `GCU${Math.random().toString(36).slice(2, 10)}`,
    },
  });
  const jti = newJti();
  await setSetting(prisma, shopSessionJtiKey(u.id), jti);
  const { raw, data } = makeCustomerSession(u.id, null, jti);
  return { userId: u.id, cookie: `${SHOP_COOKIE_NAME}=${encodeURIComponent(raw)}`, csrf: data.csrf, guestEmail };
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await setSetting(prisma, "setup_completed", "true");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

// ------------------------------------------- POST /api/v1/preferences/currency
describe("POST /api/v1/preferences/currency", () => {
  it("anonymous visitor: sets the shop_currency cookie with shop_lang's flags and echoes the value", async () => {
    const res = await app.inject({ method: "POST", url: URL_PREF, payload: { currency: "USD" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ currency: "USD" });
    const sc = currencySetCookie(res.headers["set-cookie"])!;
    expect(sc).toBeDefined();
    expect(sc).toMatch(/^shop_currency=USD;/);
    expect(sc).toContain("Path=/");
    expect(sc).toContain("HttpOnly");
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toContain(`Max-Age=${60 * 60 * 24 * 365}`);
  });

  it("guest session: cookie only — the guest row's preferredCurrency stays NULL", async () => {
    const g = await guestSession();
    const res = await app.inject({
      method: "POST",
      url: URL_PREF,
      payload: { currency: "USD" },
      headers: { cookie: g.cookie, "x-csrf-token": g.csrf },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ currency: "USD" });
    expect(currencySetCookie(res.headers["set-cookie"])).toMatch(/^shop_currency=USD;/);
    expect((await getUser(prisma, g.userId))!.preferredCurrency).toBeNull();
  });

  it("guest session without a CSRF token is rejected (403), no cookie", async () => {
    const g = await guestSession();
    const res = await app.inject({
      method: "POST",
      url: URL_PREF,
      payload: { currency: "USD" },
      headers: { cookie: g.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(currencySetCookie(res.headers["set-cookie"])).toBeUndefined();
  });

  it("signed-in user: sets the cookie AND stores User.preferredCurrency (shared with the bot)", async () => {
    const uid = await makeUser("curhappy", "curhappy-pw-1");
    const { cookie, csrf } = await loginAs("curhappy", "curhappy-pw-1");
    const res = await app.inject({
      method: "POST",
      url: URL_PREF,
      payload: { currency: "USD" },
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ currency: "USD" });
    expect(currencySetCookie(res.headers["set-cookie"])).toMatch(/^shop_currency=USD;/);
    expect((await getUser(prisma, uid))!.preferredCurrency).toBe("USD");

    // Switching back works the same way.
    const back = await app.inject({
      method: "POST",
      url: URL_PREF,
      payload: { currency: "IDR" },
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(back.json()).toEqual({ currency: "IDR" });
    expect((await getUser(prisma, uid))!.preferredCurrency).toBe("IDR");
  });

  it("is idempotent — posting the same value twice ends in the same state", async () => {
    const uid = await makeUser("curtwice", "curtwice-pw-1");
    const { cookie, csrf } = await loginAs("curtwice", "curtwice-pw-1");
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: URL_PREF,
        payload: { currency: "USD" },
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ currency: "USD" });
    }
    expect((await getUser(prisma, uid))!.preferredCurrency).toBe("USD");
  });

  it("signed-in user with a missing or wrong CSRF token is rejected (403) — no cookie, no DB write", async () => {
    const uid = await makeUser("curcsrf", "curcsrf-pw-1");
    const { cookie } = await loginAs("curcsrf", "curcsrf-pw-1");
    for (const headers of [{ cookie }, { cookie, "x-csrf-token": "not-the-token" }]) {
      const res = await app.inject({ method: "POST", url: URL_PREF, payload: { currency: "USD" }, headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "csrf_failed" });
      expect(currencySetCookie(res.headers["set-cookie"])).toBeUndefined();
    }
    expect((await getUser(prisma, uid))!.preferredCurrency).toBeNull();
  });

  it("rejects a foreign Origin even with a valid token (defense-in-depth, same as the cart)", async () => {
    const uid = await makeUser("curorigin", "curorigin-pw-1");
    const { cookie, csrf } = await loginAs("curorigin", "curorigin-pw-1");
    const res = await app.inject({
      method: "POST",
      url: URL_PREF,
      payload: { currency: "USD" },
      headers: { cookie, "x-csrf-token": csrf, origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect((await getUser(prisma, uid))!.preferredCurrency).toBeNull();
  });

  it("400s unsupported / wrong-case / empty / missing currency — no cookie, no DB write", async () => {
    const uid = await makeUser("curbad", "curbad-pw-1", "IDR");
    const { cookie, csrf } = await loginAs("curbad", "curbad-pw-1");
    const payloads: Array<Record<string, unknown> | undefined> = [
      { currency: "EUR" },
      { currency: "usd" },
      { currency: "$" },
      { currency: "" },
      { currency: 1 },
      {},
      undefined,
    ];
    for (const payload of payloads) {
      const res = await app.inject({
        method: "POST",
        url: URL_PREF,
        ...(payload === undefined ? {} : { payload }),
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "currency_invalid" });
      expect(currencySetCookie(res.headers["set-cookie"])).toBeUndefined();
    }
    expect((await getUser(prisma, uid))!.preferredCurrency).toBe("IDR");

    // Anonymous visitors get the same 400.
    const anon = await app.inject({ method: "POST", url: URL_PREF, payload: { currency: "EUR" } });
    expect(anon.statusCode).toBe(400);
    expect(currencySetCookie(anon.headers["set-cookie"])).toBeUndefined();
  });
});

// --------------------------------------------- GET /api/v1/pages/context
describe("GET /api/v1/pages/context — currency", () => {
  it("nobody has chosen anything → currency null, fx still present", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/pages/context" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currency).toBeNull();
    expect(body).toHaveProperty("fx");
  });

  it("fx is unaffected by the currency choice — same value as the shared rate reader", async () => {
    const expected = (await getUsdIdrRate(prisma))?.toString() ?? null;
    for (const cookie of ["shop_currency=USD", "shop_currency=IDR"]) {
      const body = (await app.inject({ method: "GET", url: "/api/v1/pages/context", headers: { cookie } })).json();
      expect(body.fx).toBe(expected);
    }
  });

  it("anonymous visitor with cookie IDR → IDR; an invalid cookie → null", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/v1/pages/context", headers: { cookie: "shop_currency=IDR" } });
    expect(ok.json().currency).toBe("IDR");
    for (const bad of ["usd", "EUR", ""]) {
      const res = await app.inject({ method: "GET", url: "/api/v1/pages/context", headers: { cookie: `shop_currency=${bad}` } });
      expect(res.json().currency).toBeNull();
    }
  });

  it("guest session uses the cookie (the guest row is never consulted)", async () => {
    const g = await guestSession();
    await prisma.user.update({ where: { id: g.userId }, data: { preferredCurrency: "USD" } });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/pages/context",
      headers: { cookie: `${g.cookie}; shop_currency=IDR` },
    });
    expect(res.json().currency).toBe("IDR");
  });

  it("signed-in user with DB preference USD beats a stale IDR cookie, and wins with no cookie at all", async () => {
    await makeUser("curctxdb", "curctxdb-pw-1", "USD");
    const { cookie } = await loginAs("curctxdb", "curctxdb-pw-1");
    const withStale = await app.inject({
      method: "GET",
      url: "/api/v1/pages/context",
      headers: { cookie: `${cookie}; shop_currency=IDR` },
    });
    expect(withStale.json().currency).toBe("USD");
    const noCookie = await app.inject({ method: "GET", url: "/api/v1/pages/context", headers: { cookie } });
    expect(noCookie.json().currency).toBe("USD");
  });

  it("signed-in user with no DB preference falls back to the cookie", async () => {
    await makeUser("curctxfb", "curctxfb-pw-1");
    const { cookie } = await loginAs("curctxfb", "curctxfb-pw-1");
    // Login adoption would copy a cookie present AT login; this one arrives later.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/pages/context",
      headers: { cookie: `${cookie}; shop_currency=IDR` },
    });
    expect(res.json().currency).toBe("IDR");
  });
});

// ------------------------------------------------ login cookie adoption
describe("sign-in adopts the shop_currency cookie once", () => {
  it("login with cookie USD and a NULL preference → preferredCurrency becomes USD", async () => {
    const uid = await makeUser("curadopt", "curadopt-pw-1");
    await loginAs("curadopt", "curadopt-pw-1", "shop_currency=USD");
    expect((await getUser(prisma, uid))!.preferredCurrency).toBe("USD");
  });

  it("login with cookie USD never overwrites an existing IDR preference", async () => {
    const uid = await makeUser("curkeep", "curkeep-pw-1", "IDR");
    await loginAs("curkeep", "curkeep-pw-1", "shop_currency=USD");
    expect((await getUser(prisma, uid))!.preferredCurrency).toBe("IDR");
  });

  it("login with an invalid cookie adopts nothing", async () => {
    const uid = await makeUser("curjunk", "curjunk-pw-1");
    await loginAs("curjunk", "curjunk-pw-1", "shop_currency=usd");
    expect((await getUser(prisma, uid))!.preferredCurrency).toBeNull();
  });

  it("registration with cookie USD adopts it on the new account", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "curnewreg",
        email: "curnewreg@u.test",
        password: "curnewreg-pw-1",
        password2: "curnewreg-pw-1",
        fullName: "Cur New",
      },
      headers: { cookie: "shop_currency=USD", "x-forwarded-for": "10.9.8.7" },
    });
    expect(res.statusCode).toBe(200);
    const u = await prisma.user.findFirst({ where: { loginUsername: "curnewreg" } });
    expect(u!.preferredCurrency).toBe("USD");
  });

  it("a guest who converts (sets a password) adopts the cookie on that account", async () => {
    const g = await guestSession();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/settings/credentials",
      payload: {
        guest_email: g.guestEmail,
        username: "curconvert",
        email: "curconvert@u.test",
        new_password: "curconvert-pw-1",
      },
      headers: { cookie: `${g.cookie}; shop_currency=USD`, "x-csrf-token": g.csrf },
    });
    expect(res.statusCode).toBe(200);
    const u = await prisma.user.findUnique({ where: { id: g.userId } });
    expect(u!.isGuest).toBe(false);
    expect(u!.preferredCurrency).toBe("USD");
  });
});
