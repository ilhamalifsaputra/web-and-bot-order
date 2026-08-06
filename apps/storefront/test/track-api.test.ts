// Task 5 (guest checkout): POST /api/v1/track — order code + email session
// recovery for a guest buyer whose cookie is gone or who switched devices.
// Two properties matter most and get their own tests: an order owned by a
// REGISTERED account must never be openable this way (test 6), and every
// rejection is byte-identical so the endpoint can't be used to probe which
// order codes exist (tests 4/5/7 compare against the same body).
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
import { TRACK_LOOKUP_RATE_LIMIT_MAX } from "../src/rateLimit";

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
      payload: { order_code: orderCode, email: "track.happy@example.com" },
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
      payload: { order_code: orderCode, email: "track.works@example.com" },
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

  it("normalizes email (case + surrounding whitespace) and order code (case)", async () => {
    const orderCode = await makeGuestOrder("track.norm@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: orderCode.toLowerCase(), email: "  Track.Norm@Example.COM  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirect).toBe(`/account/orders/${orderCode}`);
  });
});

describe("POST /api/v1/track — rejections are byte-identical (Task 5)", () => {
  it("wrong email 404s with the generic body", async () => {
    const orderCode = await makeGuestOrder("track.wrongemail@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: orderCode, email: "not.the.right.email@example.com" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "web.track_not_found" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("a nonexistent order code produces a byte-identical response to a wrong email", async () => {
    const wrongEmail = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: await makeGuestOrder("track.identbase@example.com"), email: "nope@example.com" },
    });

    const missingOrder = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: "NOSUCHORDERCODE1", email: "nope@example.com" },
    });

    expect(missingOrder.statusCode).toBe(wrongEmail.statusCode);
    expect(missingOrder.statusCode).toBe(404);
    expect(missingOrder.body).toBe(wrongEmail.body);
    expect(missingOrder.headers["set-cookie"]).toBeUndefined();
  });

  it("THE most important test: an order owned by a REGISTERED account is byte-identical-refused and sets no session", async () => {
    const orderCode = await makeAccountOrder("trackacct1", "trackacct1-pw-1", "TRKAC1");

    // Even with the account's own login email, the code+email path must not
    // open it — that would let anyone who learns the order code and the
    // account's email skip the account's password entirely.
    const accountUser = await prisma.user.findFirst({ where: { loginUsername: "trackacct1" } });
    const attempts = [accountUser!.email!, "totally.wrong@example.com", ""];

    let baseline: { statusCode: number; body: string } | null = null;
    for (const email of attempts) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/track",
        headers: { "x-forwarded-for": freshIp() },
        payload: { order_code: orderCode, email },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "web.track_not_found" });
      expect(res.headers["set-cookie"]).toBeUndefined();
      if (baseline) {
        expect(res.body).toBe(baseline.body);
        expect(res.statusCode).toBe(baseline.statusCode);
      } else {
        baseline = { statusCode: res.statusCode, body: res.body };
      }
    }
  });

  it("THE attack: a guest who sets a password can no longer be session-rotated via order code + old guest email", async () => {
    // Reachable end-to-end, no hand-built DB state. /account/settings is a
    // registered route in the SPA (only the account-menu LINK is hidden for
    // guests), and POST /account/settings/credentials skips the
    // current-password re-auth while passwordHash is null — so a guest can
    // walk in and turn their synthetic row into a password-protected
    // account. Before the fix, setLoginCredentials left `isGuest: true` and
    // `guestEmail` in place, so /track still opened that now-protected
    // account from (order code + the old guest address) and rotated the
    // owner's live session out. This test walks exactly that path.
    const guestEmail = "attack.upgrade@example.com";
    const { orderCode, cookie, csrf } = await makeGuestCheckout(guestEmail);

    const upgrade = await app.inject({
      method: "POST",
      url: "/api/v1/account/settings/credentials",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
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
      payload: { order_code: await makeGuestOrder("attack.baseline@example.com"), email: "nope@example.com" },
    });
    expect(baseline.statusCode).toBe(404);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: orderCode, email: guestEmail },
    });

    expect(res.statusCode).toBe(baseline.statusCode);
    expect(res.body).toBe(baseline.body);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("a synthetic isGuest:false-with-guestEmail row is refused — pins the isGuest guard itself", async () => {
    // Defence in depth. setLoginCredentials now nulls `guestEmail` alongside
    // `isGuest` on upgrade, so this exact combination is no longer produced
    // by any code path — but the row shape is still writable (a migration, a
    // future importer, a manual DB fix), and the `isGuest` guard in
    // apiTrack.ts is the only thing that refuses it.
    //
    // This is NOT redundant with "an order owned by a REGISTERED account"
    // above: that helper (makeAccountOrder) never sets guestEmail, so that
    // test's rejection is actually driven by the `!order.user.guestEmail`
    // guard — it would still pass even if the `isGuest` check were deleted
    // from apiTrack.ts. This test constructs a row where guestEmail IS set
    // and the submitted email matches it exactly, so only the isGuest guard
    // stands between this request and a minted session. Do not delete this
    // as "the same thing" as the test above.
    const orderCode = await makeAccountOrder("trackupgraded1", "trackupgraded1-pw-1", "TRKUP1");
    const upgradedEmail = "track.upgraded@example.com";
    await prisma.user.update({
      where: { loginUsername: "trackupgraded1" },
      data: { isGuest: false, guestEmail: upgradedEmail },
    });

    // Baseline captured from another rejection case (wrong email against a
    // fresh guest order), the same generic shape every rejection in this
    // file must match — not a hard-coded literal.
    const baseline = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      payload: { order_code: await makeGuestOrder("track.upgraded.baseline@example.com"), email: "nope@example.com" },
    });
    expect(baseline.statusCode).toBe(404);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": freshIp() },
      // The exact guestEmail left on the row after upgrade — every other
      // guard (order exists, guestEmail present, email matches) is
      // satisfied here, so only isGuest can still reject this.
      payload: { order_code: orderCode, email: upgradedEmail },
    });

    expect(res.statusCode).toBe(baseline.statusCode);
    expect(res.body).toBe(baseline.body);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("empty body / missing fields get the same generic rejection", async () => {
    for (const payload of [{}, { order_code: "" }, { email: "" }, { order_code: "   ", email: "   " }]) {
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
        payload: { order_code: "NOSUCHORDER", email: `guess${i}@example.com` },
      });
      expect(res.statusCode).toBe(404); // still under the cap, and all failed
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": ip },
      payload: { order_code: "NOSUCHORDER", email: "over@example.com" },
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
        payload: { order_code: "NOSUCHORDER", email: `sep${i}@example.com` },
      });
      expect(res.statusCode).toBe(404);
    }
    const cappedTrack = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": ip },
      payload: { order_code: "NOSUCHORDER", email: "sep-over@example.com" },
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
