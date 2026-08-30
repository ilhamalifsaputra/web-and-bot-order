import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, initDb } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";

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
});

const METRIC_NAMES = [
  "outbox_oldest_unsent_age_seconds",
  "outbox_backlog_size",
  "outbox_dead_letter_count",
  "outbox_failed_count",
];

describe("GET /metrics", () => {
  it("returns 200 with no auth cookie (unauthenticated, same tier as /healthz)", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
  });

  it("returns valid Prometheus exposition text with HELP/TYPE lines for all four gauges", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    const body = res.body;
    for (const name of METRIC_NAMES) {
      expect(body).toContain(`# HELP ${name}`);
      expect(body).toContain(`# TYPE ${name} gauge`);
    }
  });

  it("reports outbox_backlog_size as 0 with an empty outbox", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("outbox_backlog_size 0");
  });

  it("seeding a PENDING row changes outbox_backlog_size's reported value", async () => {
    const before = await app.inject({ method: "GET", url: "/metrics" });
    expect(before.body).toContain("outbox_backlog_size 0");

    await prisma.notificationOutbox.create({
      data: { event: "ORDER_DELIVERED", payloadJson: JSON.stringify({}), status: "PENDING" },
    });

    const after = await app.inject({ method: "GET", url: "/metrics" });
    expect(after.body).toContain("outbox_backlog_size 1");
    expect(after.body).not.toContain("outbox_backlog_size 0");
  });

  it("seeding a DEAD_LETTER row changes outbox_dead_letter_count's reported value", async () => {
    await prisma.notificationOutbox.create({
      data: { event: "ORDER_DELIVERED", payloadJson: JSON.stringify({}), status: "DEAD_LETTER" },
    });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("outbox_dead_letter_count 1");
  });

  it("seeding a FAILED row changes outbox_failed_count's reported value", async () => {
    await prisma.notificationOutbox.create({
      data: { event: "ORDER_DELIVERED", payloadJson: JSON.stringify({}), status: "FAILED" },
    });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("outbox_failed_count 1");
  });

  it("omits a sample line for outbox_oldest_unsent_age_seconds when the outbox has no unsent row", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
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
    const res = await app.inject({ method: "GET", url: "/metrics" });
    const match = res.body.match(/^outbox_oldest_unsent_age_seconds (\d+)$/m);
    expect(match).not.toBeNull();
    const age = Number(match![1]);
    expect(age).toBeGreaterThanOrEqual(60);
    expect(age).toBeLessThanOrEqual(70);
  });
});
