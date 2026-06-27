// Brute-force / rate-limit protection for the storefront's public auth
// endpoints (Task 4 / H-1) — mirrors apps/web-admin/test/web.test.ts's
// account-lockout unit test plus adds route-level 429 coverage for
// POST /login and POST /forgot. Own file (own app instance + own IPs via
// x-forwarded-for) so these tests never share a rate-limit bucket with the
// password-login tests in storefront.test.ts.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { cleanupTestDb } from "./setup-env";
import { prisma, initDb, setSetting } from "@app/db";
import { buildApp } from "../src/server";
import {
  loginRateLimited,
  resetLoginAttempts,
  accountLockedOut,
  recordAccountFailure,
  resetAccountFailures,
  webhookRateLimited,
  WEBHOOK_RATE_LIMIT_MAX,
} from "../src/rateLimit";

let app: FastifyInstance;
let ipCounter = 0;
/** Fresh per-test IP so tests never share an IP-bucket with each other or
 * with storefront.test.ts's default-IP requests. */
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await setSetting(prisma, "setup_completed", "true");

  const { hashPassword } = await import("@app/core/password");
  await prisma.user.create({
    data: {
      telegramId: null,
      loginUsername: "ratebuyer",
      email: "rate@buyer.test",
      passwordHash: hashPassword("hunter2-ok"),
      referralCode: "RATEB01",
    },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

beforeEach(() => {
  // Belt-and-suspenders: clear any leftover state between tests even though
  // each test also uses its own IP/identifier.
  resetAccountFailures("ratebuyer");
  resetAccountFailures("ghostuser");
});

describe("rateLimit module (unit)", () => {
  it("loginRateLimited opens after WEB_LOGIN_RATE_LIMIT_MAX hits within the window, and resets", () => {
    const ip = freshIp();
    const max = config.WEB_LOGIN_RATE_LIMIT_MAX;
    for (let i = 0; i < max; i++) {
      expect(loginRateLimited(ip)).toBe(false);
    }
    expect(loginRateLimited(ip)).toBe(true);
    resetLoginAttempts(ip);
    expect(loginRateLimited(ip)).toBe(false);
  });

  it("accountLockedOut locks an identifier after the failure cap and clears on reset", () => {
    const id = "lockout-test-user";
    const max = config.WEB_LOGIN_RATE_LIMIT_MAX;
    resetAccountFailures(id);
    for (let i = 0; i < max - 1; i++) recordAccountFailure(id);
    expect(accountLockedOut(id)).toBe(false);
    recordAccountFailure(id); // now at the cap
    expect(accountLockedOut(id)).toBe(true);
    resetAccountFailures(id);
    expect(accountLockedOut(id)).toBe(false);
  });

  // Payment-3 (security audit, 2026-06-23): the payment webhooks rely on this
  // same module for per-IP throttling.
  it("webhookRateLimited opens after WEBHOOK_RATE_LIMIT_MAX hits to one route from one IP, and routes have separate buckets", () => {
    const ip = freshIp();
    for (let i = 0; i < WEBHOOK_RATE_LIMIT_MAX; i++) {
      expect(webhookRateLimited("tokopay", ip)).toBe(false);
    }
    expect(webhookRateLimited("tokopay", ip)).toBe(true);
    // A different route from the SAME ip has its own, unexhausted bucket.
    expect(webhookRateLimited("paydisini", ip)).toBe(false);
  });
});

describe("POST /login rate limiting", () => {
  it("returns 429 with the rate-limited message after WEB_LOGIN_RATE_LIMIT_MAX failed attempts from one IP", async () => {
    const ip = freshIp();
    const max = config.WEB_LOGIN_RATE_LIMIT_MAX;
    let last;
    for (let i = 0; i < max; i++) {
      last = await app.inject({
        method: "POST",
        url: "/login",
        headers: { "x-forwarded-for": ip },
        payload: { identifier: "ghostuser", password: "nope" },
      });
      expect(last.statusCode).toBe(403); // generic enumeration-safe failure, still under the cap
    }
    const limited = await app.inject({
      method: "POST",
      url: "/login",
      headers: { "x-forwarded-for": ip },
      payload: { identifier: "ghostuser", password: "nope" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toContain("Too many requests");
  });

  it("a correct login still succeeds when under the limit, and resets the IP + account counters", async () => {
    const ip = freshIp();
    // A couple of failed attempts (under the cap) shouldn't block a follow-up
    // correct login.
    await app.inject({
      method: "POST",
      url: "/login",
      headers: { "x-forwarded-for": ip },
      payload: { identifier: "ratebuyer", password: "wrong-once" },
    });
    const ok = await app.inject({
      method: "POST",
      url: "/login",
      headers: { "x-forwarded-for": ip },
      payload: { identifier: "ratebuyer", password: "hunter2-ok", next: "/account" },
    });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe("/account");

    // After a successful login, the account-failure counter is cleared: the
    // identifier should not be locked out even though we just clocked one
    // failure against it (recordAccountFailure was called once above).
    expect(accountLockedOut("ratebuyer")).toBe(false);
  });

  it("locks the account after repeated failures even if the attacker rotates IPs", async () => {
    const identifier = "rotate-victim";
    await prisma.user.create({
      data: {
        telegramId: null,
        loginUsername: identifier,
        email: "rotate@buyer.test",
        passwordHash: (await import("@app/core/password")).hashPassword("correct-pw-123"),
        referralCode: "ROTATE1",
      },
    });
    const max = config.WEB_LOGIN_RATE_LIMIT_MAX;
    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/login",
        headers: { "x-forwarded-for": freshIp() }, // new IP every time
        payload: { identifier, password: "wrong" },
      });
      expect(res.statusCode).toBe(403);
    }
    // The account is now locked even from a brand-new IP with the CORRECT password.
    const lockedOut = await app.inject({
      method: "POST",
      url: "/login",
      headers: { "x-forwarded-for": freshIp() },
      payload: { identifier, password: "correct-pw-123" },
    });
    expect(lockedOut.statusCode).toBe(429);
    expect(lockedOut.body).toContain("Too many requests");
  });
});

describe("POST /forgot rate limiting", () => {
  it("rate-limits repeated /forgot submissions from one IP without leaking account existence", async () => {
    const ip = freshIp();
    const max = config.WEB_LOGIN_RATE_LIMIT_MAX;
    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/forgot",
        headers: { "x-forwarded-for": ip },
        payload: { email: "nobody@nowhere.test" },
      });
      expect(res.statusCode).toBe(200); // existing enumeration-safe "sent" response
    }
    const limited = await app.inject({
      method: "POST",
      url: "/forgot",
      headers: { "x-forwarded-for": ip },
      payload: { email: "rate@buyer.test" }, // even a REAL account is still capped
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toContain("Too many requests");
  });

  // Storefront-4 (security audit, 2026-06-23): an attacker rotating IPs must
  // not be able to email-bomb ONE victim address past the per-email cap, even
  // though each individual IP is well under its own per-IP cap.
  it("rate-limits repeated /forgot submissions to ONE email even when the attacker rotates IPs", async () => {
    const victimEmail = "rotate-victim@buyer.test";
    const max = config.WEB_LOGIN_RATE_LIMIT_MAX;
    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/forgot",
        headers: { "x-forwarded-for": freshIp() }, // new IP every time
        payload: { email: victimEmail },
      });
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/forgot",
      headers: { "x-forwarded-for": freshIp() },
      payload: { email: victimEmail },
    });
    expect(limited.statusCode).toBe(429);
  });

  it("a DIFFERENT email from the same rotating-IP pattern is unaffected (throttle is per-email)", async () => {
    const otherEmail = "unrelated-bystander@buyer.test";
    const res = await app.inject({
      method: "POST",
      url: "/forgot",
      headers: { "x-forwarded-for": freshIp() },
      payload: { email: otherEmail },
    });
    expect(res.statusCode).toBe(200);
  });
});

// Storefront-4 (security audit, 2026-06-23): clientIp() must only honor
// X-Forwarded-For when the DIRECT connection comes from a trusted proxy
// (TRUST_PROXY="127.0.0.1,::1" in apps/storefront/test/setup-env.ts) —
// otherwise any directly-reachable caller could forge the header.
describe("trustProxy gates X-Forwarded-For", () => {
  it("an UNTRUSTED direct connection's forged X-Forwarded-For is ignored — real IP throttling still applies", async () => {
    const realAttackerIp = "198.51.100.77"; // not in TRUST_PROXY's allowlist
    const max = config.WEB_LOGIN_RATE_LIMIT_MAX;
    let last;
    for (let i = 0; i < max; i++) {
      last = await app.inject({
        method: "POST",
        url: "/login",
        remoteAddress: realAttackerIp,
        // A forged, ever-changing XFF must NOT let the attacker dodge the
        // per-IP cap, since the real connection isn't from a trusted proxy.
        headers: { "x-forwarded-for": freshIp() },
        payload: { identifier: "ghostuser", password: "nope" },
      });
      expect(last.statusCode).toBe(403);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/login",
      remoteAddress: realAttackerIp,
      headers: { "x-forwarded-for": freshIp() },
      payload: { identifier: "ghostuser", password: "nope" },
    });
    expect(limited.statusCode).toBe(429);
  });
});

// Payment-3 (security audit, 2026-06-23): the public, unauthenticated payment
// webhooks need their own per-IP cap — unlike /login they have no account to
// lock out, so the IP throttle is the only defense against a flood of forged
// callback bodies.
describe("payment webhook rate limiting", () => {
  it("returns 429 after WEBHOOK_RATE_LIMIT_MAX hits to one webhook route from one IP", async () => {
    const ip = freshIp();
    const badPayload = { ref_id: "ORD-NOPE", trx_id: "x", nominal: "1", status: "success", signature: "bad" };
    for (let i = 0; i < WEBHOOK_RATE_LIMIT_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/pay/tokopay/callback",
        headers: { "x-forwarded-for": ip },
        payload: badPayload,
      });
      expect(res.statusCode).not.toBe(429); // still under the cap (gets 403 bad signature)
    }
    const limited = await app.inject({
      method: "POST",
      url: "/pay/tokopay/callback",
      headers: { "x-forwarded-for": ip },
      payload: badPayload,
    });
    expect(limited.statusCode).toBe(429);
  });

  it("each webhook route has its own bucket — exhausting tokopay's doesn't 429 paydisini from the same IP", async () => {
    const ip = freshIp();
    for (let i = 0; i < WEBHOOK_RATE_LIMIT_MAX; i++) {
      await app.inject({
        method: "POST",
        url: "/pay/tokopay/callback",
        headers: { "x-forwarded-for": ip },
        payload: {},
      });
    }
    const tokopayLimited = await app.inject({
      method: "POST",
      url: "/pay/tokopay/callback",
      headers: { "x-forwarded-for": ip },
      payload: {},
    });
    expect(tokopayLimited.statusCode).toBe(429);

    const paydisiniStillOk = await app.inject({
      method: "POST",
      url: "/pay/paydisini/callback",
      headers: { "x-forwarded-for": ip },
      payload: {},
    });
    expect(paydisiniStillOk.statusCode).not.toBe(429);
  });
});
