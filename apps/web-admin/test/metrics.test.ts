import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, initDb, setSetting, deleteSetting, upsertUser } from "@app/db";
import { config } from "@app/core/config";
import { resetDb } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import { makeSession, newJti, sessionJtiKey, webRoleKey } from "../src/auth";

const TOKEN = "metrics-scrape-token-for-tests";

/** A scrape the way a configured Prometheus job sends it. */
function scrape() {
  return app.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${TOKEN}` } });
}

/** A web-admin session cookie for Telegram id 999 (in ADMIN_IDS) with `role`. */
async function adminCookie(role: "super" | "support"): Promise<string> {
  const admin = await upsertUser(prisma, { telegramId: 999, username: "admin", fullName: "Admin" });
  await setSetting(prisma, webRoleKey(999), role);
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(999), jti);
  return makeSession(admin.id, 999, jti).raw;
}

let app: FastifyInstance;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await setSetting(prisma, "metrics_token", TOKEN);
});

describe("GET /metrics — access control (Task C3)", () => {
  it("is closed (403) when no token is configured and the caller has no owner session", async () => {
    await deleteSetting(prisma, "metrics_token");
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("outbox_backlog_size");
  });

  it("401s a missing or wrong bearer token when one is configured", async () => {
    const none = await app.inject({ method: "GET", url: "/metrics" });
    expect(none.statusCode).toBe(401);
    const wrong = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).not.toContain("outbox_backlog_size");
  });

  it("accepts the METRICS_TOKEN env fallback when no setting is stored", async () => {
    await deleteSetting(prisma, "metrics_token");
    const cfg = config as { METRICS_TOKEN?: string };
    const before = cfg.METRICS_TOKEN;
    cfg.METRICS_TOKEN = "env-token-xyz";
    try {
      const res = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer env-token-xyz" } });
      expect(res.statusCode).toBe(200);
    } finally {
      cfg.METRICS_TOKEN = before;
    }
  });

  it("lets an owner (super) session read it without a token, but not a support admin", async () => {
    await deleteSetting(prisma, "metrics_token");
    const owner = await adminCookie("super");
    const ok = await app.inject({ method: "GET", url: "/metrics", cookies: { [config.WEB_COOKIE_NAME]: owner } });
    expect(ok.statusCode).toBe(200);
    const support = await adminCookie("support");
    const no = await app.inject({ method: "GET", url: "/metrics", cookies: { [config.WEB_COOKIE_NAME]: support } });
    expect(no.statusCode).toBe(403);
  });
});

const METRIC_NAMES = [
  "outbox_oldest_unsent_age_seconds",
  "outbox_backlog_size",
  "outbox_dead_letter_count",
  "outbox_failed_count",
];

describe("GET /metrics", () => {
  it("returns 200 to a scraper presenting the configured bearer token", async () => {
    const res = await scrape();
    expect(res.statusCode).toBe(200);
  });

  it("returns valid Prometheus exposition text with HELP/TYPE lines for all four gauges", async () => {
    const res = await scrape();
    const body = res.body;
    for (const name of METRIC_NAMES) {
      expect(body).toContain(`# HELP ${name}`);
      expect(body).toContain(`# TYPE ${name} gauge`);
    }
  });

  it("reports outbox_backlog_size as 0 with an empty outbox", async () => {
    const res = await scrape();
    expect(res.body).toContain("outbox_backlog_size 0");
  });

  it("seeding a PENDING row changes outbox_backlog_size's reported value", async () => {
    const before = await scrape();
    expect(before.body).toContain("outbox_backlog_size 0");

    await prisma.notificationOutbox.create({
      data: { event: "ORDER_DELIVERED", payloadJson: JSON.stringify({}), status: "PENDING" },
    });

    const after = await scrape();
    expect(after.body).toContain("outbox_backlog_size 1");
    expect(after.body).not.toContain("outbox_backlog_size 0");
  });

  it("seeding a DEAD_LETTER row changes outbox_dead_letter_count's reported value", async () => {
    await prisma.notificationOutbox.create({
      data: { event: "ORDER_DELIVERED", payloadJson: JSON.stringify({}), status: "DEAD_LETTER" },
    });
    const res = await scrape();
    expect(res.body).toContain("outbox_dead_letter_count 1");
  });

  it("seeding a FAILED row changes outbox_failed_count's reported value", async () => {
    await prisma.notificationOutbox.create({
      data: { event: "ORDER_DELIVERED", payloadJson: JSON.stringify({}), status: "FAILED" },
    });
    const res = await scrape();
    expect(res.body).toContain("outbox_failed_count 1");
  });

  it("omits a sample line for outbox_oldest_unsent_age_seconds when the outbox has no unsent row", async () => {
    const res = await scrape();
    // The metric must still be declared (HELP/TYPE), but with no value line —
    // proves the gauge's default constructor-time 0 sample was explicitly
    // cleared via .remove(), not left in place misleadingly reporting "0".
    expect(res.body).toContain("# TYPE outbox_oldest_unsent_age_seconds gauge");
    expect(res.body).not.toMatch(/^outbox_oldest_unsent_age_seconds \d/m);
  });

  it("reports outbox_oldest_unsent_age_seconds once a PENDING row exists", async () => {
    await prisma.notificationOutbox.create({
      data: {
        event: "ORDER_DELIVERED",
        payloadJson: JSON.stringify({}),
        status: "PENDING",
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const res = await scrape();
    const match = res.body.match(/^outbox_oldest_unsent_age_seconds (\d+)$/m);
    expect(match).not.toBeNull();
    const age = Number(match![1]);
    expect(age).toBeGreaterThanOrEqual(60);
    expect(age).toBeLessThanOrEqual(70);
  });
});
