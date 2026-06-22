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
});
