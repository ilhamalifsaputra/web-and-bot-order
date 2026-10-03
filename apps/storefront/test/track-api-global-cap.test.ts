// Backend audit Task C1 — the global failed-guess ceiling on POST
// /api/v1/track. The per-date-prefix cap alone still lets an attacker spread
// guesses across many past dates; this ceiling bounds the total number of
// format-valid misses the endpoint will answer per window, whatever the
// source IPs and target prefixes. Lives in its own file because tripping it
// closes the endpoint for every other test in the same process.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, initDb, setSetting } from "@app/db";
import { buildApp } from "../src/server";
import {
  TRACK_GLOBAL_FAILURE_MAX,
  TRACK_LOOKUP_RATE_LIMIT_MAX,
  TRACK_TARGET_FAILURE_MAX,
} from "../src/rateLimit";

let app: FastifyInstance;

beforeAll(async () => {
  await initDb();
  await setSetting(prisma, "setup_completed", "true");
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("POST /api/v1/track — global failed-guess ceiling (Task C1)", () => {
  it("429s once TRACK_GLOBAL_FAILURE_MAX format-valid misses land, even spread across prefixes and IPs", async () => {
    // Stay under both the per-IP and the per-prefix cap on every request, so
    // only the global ceiling can be what trips.
    const perIp = TRACK_LOOKUP_RATE_LIMIT_MAX - 1;
    const perPrefix = TRACK_TARGET_FAILURE_MAX - 1;
    for (let i = 0; i < TRACK_GLOBAL_FAILURE_MAX; i++) {
      const ip = `2001:db8:${Math.floor(i / perIp).toString(16)}::1`;
      const p = Math.floor(i / perPrefix);
      const day = String(1 + (p % 28)).padStart(2, "0");
      const month = String(1 + (Math.floor(p / 28) % 12)).padStart(2, "0");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/track",
        headers: { "x-forwarded-for": ip },
        payload: { order_code: `ORD-2019${month}${day}-${String(i % 10000).padStart(4, "0")}` },
      });
      expect(res.statusCode).toBe(404);
    }
    const capped = await app.inject({
      method: "POST",
      url: "/api/v1/track",
      headers: { "x-forwarded-for": "2001:db8:ffff::1" },
      payload: { order_code: "ORD-20181231-AAAA" },
    });
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toEqual({ error: "error.rate_limited" });
  });
});
