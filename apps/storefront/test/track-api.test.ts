// Task 5 (guest checkout) / Task 1 (order-code-only recovery): POST
// /api/v1/track — a bare order code establishes a session for a guest buyer
// whose cookie is gone or who switched devices. The order code is now a
// bearer credential with no second factor, by product decision. Two
// properties matter most and get their own tests: an order owned by a
// REGISTERED account must never be openable this way, and every rejection
// is byte-identical so the endpoint can't be used to probe which order
// codes exist.
//
// Pattern: guest-checkout-api.test.ts — app.inject() against an isolated
// temp DB, reusing its guest-checkout-via-POST-/api/v1/checkout helper shape.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import { prisma, initDb, setSetting, createCatalogProduct, createDenomination, addToCart } from "@app/db";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";
import { CART_COOKIE, CART_COOKIE_VERSION } from "../src/shop";
import { SHOP_COOKIE_NAME } from "../src/auth";
import { TRACK_LOOKUP_RATE_LIMIT_MAX, TRACK_TARGET_FAILURE_MAX } from "../src/rateLimit";

let app: FastifyInstance;
let denomId: number;

/** The versioned guest-cart cookie, encoded exactly as writeGuestCart writes it. */
function cartCookie(items: Array<{ p: number; q: number }>): string {
  return `${CART_COOKIE}=` + encodeURIComponent(JSON.stringify({ v: CART_COOKIE_VERSION, items }));
}

/** A distinct simulated client IP per test, so one test's quota can never
 * spill into another's (the limiter is process-wide). */
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

async function loginAs(identifier: string, password: string): Promise<{ cookie: string }> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  expect(res.statusCode).toBe(200);
  const c = res.headers["set-cookie"];
  const cookie = Array.isArray(c) ? c.join("; ") : String(c);
  return { cookie };
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

/**
 * Creates a guest order via POST /api/v1/checkout. Returns the order code
 * plus the session the checkout minted mid-request (cookie + the `csrf_token`
 * the 201 hands back), which is what a real guest browser walks away with.
 */
async function makeGuestCheckout(email: string): Promise<{ orderCode: string; cookie: string; csrf: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { cookie: cartCookie([{ p: denomId, q: 1 }]), "x-forwarded-for": freshIp() },
    payload: { method: "bybit", guest_email: email },
  });
  expect(res.statusCode).toBe(201);
  const setCookies = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
  const cookie = cookies.find((c) => c.startsWith(`${SHOP_COOKIE_NAME}=`))!.split(";")[0]!;
  return { orderCode: res.json().order_code, cookie, csrf: res.json().csrf_token };
}

/** Creates a guest order via POST /api/v1/checkout and returns its code. */
async function makeGuestOrder(email: string): Promise<string> {
  return (await makeGuestCheckout(email)).orderCode;
}

/** Creates an order owned by a REGISTERED (non-guest) account and returns its code. */
async function makeAccountOrder(username: string, password: string, refCode: string): Promise<string> {
  const uid = await makeUser(username, password, refCode);
  const { cookie } = await loginAs(username, password);
  await addToCart(prisma, uid, denomId, 1);
  const shell = await app.inject({ method: "GET", url: "/spa-shell-probe", headers: { cookie } });
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(shell.body)![1]!;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { cookie, "x-csrf-token": csrf },
    payload: { method: "bybit" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().order_code;
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Track API Cat", slug: "track-api-cat", emoji: "🔎", sortOrder: 1 },
  });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Track API Product" });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "1 Month",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "40000",
  });
  denomId = denom.id;
  await prisma.stockItem.createMany({
    data: Array.from({ length: 40 }, () => ({
      productId: denomId,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });
  await setSetting(prisma, "bybit_uid", "123456789");
  await setSetting(prisma, "bybit_api_key", "k");
  await setSetting(prisma, "bybit_api_secret", "s");
  await setSetting(prisma, "usd_idr_rate", "16000");
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "Track API Test Shop");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

describe("POST /api/v1/track — happy path (Task 5)", () => {
  it("200s with a redirect + csrf_token, and sets a working session cookie", async () => {
    const orderCode = await makeGuestOrder("track.happy@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: orderCode },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.redirect).toBe(`/account/orders/${orderCode}`);
    expect(typeof body.csrf_token).toBe("string");
    expect(body.csrf_token.length).toBeGreaterThan(0);

    const setCookies = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
    expect(cookies.some((c) => c.startsWith(`${SHOP_COOKIE_NAME}=`))).toBe(true);
  });

  it("the session it establishes actually works for a follow-up authenticated call", async () => {
    const orderCode = await makeGuestOrder("track.works@example.com");

    const track = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: orderCode },
    });
    expect(track.statusCode).toBe(200);

    const setCookies = track.headers["set-cookie"];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
    const sessionCookie = cookies.find((c) => c.startsWith(`${SHOP_COOKIE_NAME}=`))!.split(";")[0]!;

    const status = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${orderCode}/status`,
      headers: { cookie: sessionCookie },
    });
    expect(status.statusCode).toBe(200);
  });

  it("normalizes order code (case + surrounding whitespace)", async () => {
    const orderCode = await makeGuestOrder("track.norm@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: "  " + orderCode.toLowerCase() + "  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirect).toBe(`/account/orders/${orderCode}`);
  });
});

describe("POST /api/v1/track — rejections are byte-identical (Task 5)", () => {
  it("an extra email field in the body is ignored — the order code alone is enough", async () => {
    const orderCode = await makeGuestOrder("track.emailignored@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: orderCode, email: "not.the.right.email@example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirect).toBe(`/account/orders/${orderCode}`);
  });

  it("a nonexistent order code produces a byte-identical response to a registered-account order code", async () => {
    const acctOrderCode = await makeAccountOrder("trackident1", "trackident1-pw-1", "TRKID1");

    const missingOrder = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: "NOSUCHORDERCODE1" },
    });

    const acctOrder = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: acctOrderCode },
    });

    expect(missingOrder.statusCode).toBe(acctOrder.statusCode);
    expect(missingOrder.statusCode).toBe(404);
    expect(missingOrder.body).toBe(acctOrder.body);
    expect(missingOrder.headers["set-cookie"]).toBeUndefined();
    expect(acctOrder.headers["set-cookie"]).toBeUndefined();
  });

  it("THE most important test: an order owned by a REGISTERED account is byte-identical-refused and sets no session", async () => {
    const orderCode = await makeAccountOrder("trackacct1", "trackacct1-pw-1", "TRKAC1");

    // The order code alone must not open this order — that would let anyone
    // who learns the order code skip the account's password entirely.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: orderCode },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "web.track_not_found" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("THE attack: a guest who sets a password can no longer be session-rotated via their old order code", async () => {
    // Reachable end-to-end, no hand-built DB state. /account/settings is a
    // registered route in the SPA (only the account-menu LINK is hidden for
    // guests), and POST /account/settings/credentials skips the
    // current-password re-auth while passwordHash is null — so a guest can
    // walk in and turn their synthetic row into a password-protected
    // account. setLoginCredentials clears `isGuest` on upgrade, so the
    // `isGuest` gate in apiTrack.ts — now the endpoint's only defense besides
    // the order code itself — must refuse the same order code that worked
    // before the upgrade. This test walks exactly that path.
    const guestEmail = "attack.upgrade@example.com";
    const { orderCode, cookie, csrf } = await makeGuestCheckout(guestEmail);

    const upgrade = await app.inject({
      method: "POST",
      url: "/api/v1/account/settings/credentials",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        // The guest proves they own the row with the contact email they typed
        // at checkout — required for any credential change on a guest row.
        guest_email: guestEmail,
        username: "attackupgrade",
        email: "attack.upgrade.real@example.com",
        new_password: "a-real-password-1",
      },
    });
    expect(upgrade.statusCode).toBe(200);
    expect(upgrade.json().password_changed).toBe(true);

    // Sanity: the account really is password-protected now.
    const upgraded = (await prisma.user.findFirst({ where: { loginUsername: "attackupgrade" } }))!;
    expect(upgraded.passwordHash).not.toBeNull();

    const baseline = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: "NOSUCHORDERCODE1" },
    });
    expect(baseline.statusCode).toBe(404);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: orderCode },
    });

    expect(res.statusCode).toBe(baseline.statusCode);
    expect(res.body).toBe(baseline.body);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("a synthetic isGuest:false-with-guestEmail row is refused — pins the isGuest guard itself", async () => {
    // Defence in depth. setLoginCredentials nulls `guestEmail` alongside
    // `isGuest` on upgrade, so this exact combination is no longer produced
    // by any code path — but the row shape is still writable (a migration, a
    // future importer, a manual DB fix), and now that the order code is the
    // endpoint's only input, the `isGuest` guard in apiTrack.ts is the only
    // thing left standing between a request like this and a minted session.
    //
    // This is NOT redundant with "an order owned by a REGISTERED account"
    // above: that helper (makeAccountOrder) never sets guestEmail, so it
    // only pins the guard against the row shape a normal registered signup
    // produces. This test pins it against a row that still carries a
    // guest-shaped marker (`guestEmail` set) alongside `isGuest: false` — the
    // shape a migration or manual fix could produce — so nobody deletes this
    // test as "the same thing" as the one above.
    const orderCode = await makeAccountOrder("trackupgraded1", "trackupgraded1-pw-1", "TRKUP1");
    const upgradedEmail = "track.upgraded@example.com";
    await prisma.user.update({
      where: { loginUsername: "trackupgraded1" },
      data: { isGuest: false, guestEmail: upgradedEmail },
    });

    // Baseline captured from another rejection case (a nonexistent order
    // code), the same generic shape every rejection in this file must
    // match — not a hard-coded literal.
    const baseline = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: "NOSUCHORDERCODE1" },
    });
    expect(baseline.statusCode).toBe(404);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: orderCode },
    });

    expect(res.statusCode).toBe(baseline.statusCode);
    expect(res.body).toBe(baseline.body);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("empty body / missing fields / non-string order_code get the same generic rejection", async () => {
    const payloads: Array<Record<string, unknown>> = [
      {},
      { order_code: "" },
      { order_code: "   " },
      { order_code: null },
      // A non-string order_code (fastify doesn't schema-validate the body)
      // must not throw past the .trim() call and turn into a 500 — it's
      // still just "not a usable order code", so it gets the same generic
      // 404 as an empty one.
      { order_code: 123 },
      { order_code: ["X"] },
    ];
    for (const payload of payloads) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/track",
        headers: { "x-forwarded-for": freshIp() },
        payload,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "web.track_not_found" });
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });
});

describe("POST /api/v1/track — rate limiting (Task 5)", () => {
  it("429s after TRACK_LOOKUP_RATE_LIMIT_MAX requests from one IP, even when all of them failed", async () => {
    const ip = freshIp();
    for (let i = 0; i < TRACK_LOOKUP_RATE_LIMIT_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/track",
        headers: { "x-forwarded-for": ip },
        payload: { order_code: "NOSUCHORDER" },
      });
      expect(res.statusCode).toBe(404); // still under the cap, and all failed
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": ip },
      payload: { order_code: "NOSUCHORDER" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "error.rate_limited" });
  });

  it("shares no quota with guest checkout — exhausting the track quota doesn't 429 a guest checkout", async () => {
    const ip = freshIp();
    for (let i = 0; i < TRACK_LOOKUP_RATE_LIMIT_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/track",
        headers: { "x-forwarded-for": ip },
        payload: { order_code: "NOSUCHORDER" },
      });
      expect(res.statusCode).toBe(404);
    }
    const cappedTrack = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": ip },
      payload: { order_code: "NOSUCHORDER" },
    });
    expect(cappedTrack.statusCode).toBe(429);

    const checkout = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie: cartCookie([{ p: denomId, q: 1 }]), "x-forwarded-for": ip },
      payload: { method: "bybit", guest_email: "sep-checkout@example.com" },
    });
    expect(checkout.statusCode).toBe(201); // guest-checkout quota is untouched
  });
});

// ---------------------------------------------------------------------------
// Backend audit Task C1 — guest order takeover. The order code is a short
// (~1.7M per day) bearer credential, so the endpoint now (a) also caps
// FAILED guesses per target (the order code's date prefix), not just per IP,
// and treats a whole IPv6 /64 as one client; (b) refuses cross-site requests
// that would mint a session; and (c) a guest row can only have its login
// credentials set by someone who also knows the order's contact email.
// ---------------------------------------------------------------------------

describe("POST /api/v1/track — IPv6 clients are limited per /64 (Task C1)", () => {
  it("rotating addresses inside one /64 shares one quota; a different /64 does not", async () => {
    for (let i = 1; i <= TRACK_LOOKUP_RATE_LIMIT_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/track",
        headers: { "x-forwarded-for": `2001:db8:aaaa:1::${i.toString(16)}` },
        payload: { order_code: "NOSUCHORDER" },
      });
      expect(res.statusCode).toBe(404);
    }
    const rotated = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": "2001:db8:aaaa:1:ffff:ffff:ffff:ffff" },
      payload: { order_code: "NOSUCHORDER" },
    });
    expect(rotated.statusCode).toBe(429);

    const otherNet = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": "2001:db8:aaaa:2::1" },
      payload: { order_code: "NOSUCHORDER" },
    });
    expect(otherNet.statusCode).toBe(404);
  });
});

describe("POST /api/v1/track — failed guesses are capped per target, across IPs (Task C1)", () => {
  it("after TRACK_TARGET_FAILURE_MAX misses on one date prefix, even a fresh IP gets 429 for that prefix only", async () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for (let i = 0; i < TRACK_TARGET_FAILURE_MAX; i++) {
      const suffix = `Z${alphabet[i % 36]}${alphabet[Math.floor(i / 36) % 36]}Q`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/track",
        headers: { "x-forwarded-for": freshIp() },
        payload: { order_code: `ORD-20200101-${suffix}` },
      });
      expect(res.statusCode).toBe(404);
    }
    const capped = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: "ORD-20200101-ABCD" },
    });
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toEqual({ error: "error.rate_limited" });
    expect(capped.headers["set-cookie"]).toBeUndefined();

    const otherDay = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: "ORD-20200102-ABCD" },
    });
    expect(otherDay.statusCode).toBe(404);
  });
});

describe("POST /api/v1/track — cross-site requests cannot mint a session (Task C1)", () => {
  it("403s a mismatched Origin and sets no cookie", async () => {
    const orderCode = await makeGuestOrder("track.xorigin@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp(), origin: "https://evil.example" },
      payload: { order_code: orderCode },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_failed" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("403s Sec-Fetch-Site: cross-site even without an Origin header", async () => {
    const orderCode = await makeGuestOrder("track.xsite@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp(), "sec-fetch-site": "cross-site" },
      payload: { order_code: orderCode },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("still 200s for the storefront's own same-origin request", async () => {
    const orderCode = await makeGuestOrder("track.sameorigin@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: {
        "x-forwarded-for": freshIp(),
        origin: "https://shop.test.invalid",
        "sec-fetch-site": "same-origin",
      },
      payload: { order_code: orderCode },
    });
    expect(res.statusCode).toBe(200);
  });

  it("login refuses a cross-site request before checking credentials", async () => {
    await makeUser("trackxlogin", "trackxlogin-pw-1", "TRKXL1");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-forwarded-for": freshIp(), "sec-fetch-site": "cross-site" },
      payload: { identifier: "trackxlogin", password: "trackxlogin-pw-1" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_failed" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

describe("guest account claim needs the order's contact email (Task C1)", () => {
  /** A session obtained the way an attacker would: the order code alone, via /track. */
  async function trackedSession(email: string): Promise<{ userId: number; cookie: string; csrf: string }> {
    const orderCode = await makeGuestOrder(email);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: orderCode },
    });
    expect(res.statusCode).toBe(200);
    const setCookies = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
    const cookie = cookies.find((c) => c.startsWith(`${SHOP_COOKIE_NAME}=`))!.split(";")[0]!;
    const order = (await prisma.order.findFirst({ where: { orderCode } }))!;
    return { userId: order.userId, cookie, csrf: res.json().csrf_token };
  }

  it("GET /account/settings tells the client the row is a guest", async () => {
    const s = await trackedSession("claim.flag@example.com");
    const res = await app.inject({ method: "GET", url: "/api/v1/account/settings", headers: { cookie: s.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().is_guest).toBe(true);
  });

  it("refuses to set a password without the guest email, and changes nothing", async () => {
    const s = await trackedSession("claim.nopw@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/settings/credentials",
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      payload: { username: "claimthief1", new_password: "thief-password-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "web.settings_guest_email_mismatch" });
    const u = (await prisma.user.findUnique({ where: { id: s.userId } }))!;
    expect(u.passwordHash).toBeNull();
    expect(u.loginUsername).toBeNull();
    expect(u.isGuest).toBe(true);
  });

  it("refuses an email-only change too (it would let forgot-password take the row over)", async () => {
    const s = await trackedSession("claim.emailonly@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/settings/credentials",
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      payload: { email: "attacker@evil.test", guest_email: "wrong@example.com" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "web.settings_guest_email_mismatch" });
    const u = (await prisma.user.findUnique({ where: { id: s.userId } }))!;
    expect(u.email).toBeNull();
  });

  // Fix round: Telegram linking was a second, unguarded way to keep a guest
  // row — link the attacker's Telegram, then sign in via /auth/telegram.
  it("refuses to start a Telegram link on a guest row", async () => {
    const s = await trackedSession("claim.tgstart@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/settings/link-telegram/start",
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "web.settings_tg_guest" });
  });

  it("refuses the Telegram link callback on a guest row; telegramId stays null", async () => {
    const s = await trackedSession("claim.tglink@example.com");
    const { createHash, createHmac } = await import("node:crypto");
    const fields: Record<string, string> = { id: "818181", auth_date: String(Math.floor(Date.now() / 1000)) };
    const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const secretKey = createHash("sha256").update(process.env.BOT_TOKEN!).digest();
    const hash = createHmac("sha256", secretKey).update(checkString).digest("hex");
    const res = await app.inject({
      method: "GET",
      url: `/account/settings/link-telegram?${new URLSearchParams({ ...fields, hash })}`,
      headers: { cookie: s.cookie },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/account/settings?err=tg_guest");
    const u = (await prisma.user.findUnique({ where: { id: s.userId } }))!;
    expect(u.telegramId).toBeNull();
    expect(u.isGuest).toBe(true);
  });

  it("accepts the right guest email (case/whitespace-insensitive) and upgrades the row", async () => {
    const s = await trackedSession("claim.ok@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/settings/credentials",
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      payload: { guest_email: "  Claim.OK@Example.com ", username: "claimowner1", new_password: "owner-password-1" },
    });
    expect(res.statusCode).toBe(200);
    const u = (await prisma.user.findUnique({ where: { id: s.userId } }))!;
    expect(u.isGuest).toBe(false);
    expect(u.loginUsername).toBe("claimowner1");
  });
});
