import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, DETECTION_RUN_STATUS_KEY } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;

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
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

function getJson(url: string, withCookie = true) {
  return app.inject({
    method: "GET",
    url,
    ...(withCookie ? { cookies: { [COOKIE]: cookie } } : {}),
  });
}
function postJson(url: string, token: string | null = csrf) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(token ? { "x-csrf-token": token } : {}) },
    cookies: { [COOKIE]: cookie },
    payload: "{}",
  });
}

async function seedIssue(reviewStatus = "OPEN") {
  return prisma.detectionIssue.create({
    data: {
      status: "unknown",
      reviewStatus,
      inputFingerprint: `fp-${Math.random().toString(16).slice(2, 10)}`,
      rawInput: JSON.stringify({ productName: "Mystery SKU" }),
      reason: "no catalog candidates matched",
      detectorStamp: "1.0.0+k0",
    },
  });
}

describe("GET /api/catalog/detection/metrics", () => {
  it("returns null when no detection run has ever completed", async () => {
    const res = await getJson("/api/catalog/detection/metrics");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ metrics: null });
  });

  it("returns the stored run summary once one exists", async () => {
    const summary = {
      detectorStamp: "1.0.0+k3",
      totalRecords: 12,
      resolved: 10,
      ambiguous: 1,
      unknown: 1,
      confidenceBuckets: { "0.90-1.00": 8, "0.75-0.90": 2, "0.50-0.75": 0, "0.00-0.50": 0 },
      overrideHits: 0,
      finishedAt: "2026-09-10T00:00:00.000Z",
    };
    await setSetting(prisma, DETECTION_RUN_STATUS_KEY, JSON.stringify(summary));
    const res = await getJson("/api/catalog/detection/metrics");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ metrics: summary });
  });

  it("rejects an unauthenticated request (401)", async () => {
    const res = await getJson("/api/catalog/detection/metrics", false);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });
});

describe("GET /api/catalog/detection/issues", () => {
  it("lists every issue, and narrows to a reviewStatus when asked", async () => {
    await seedIssue("OPEN");
    await seedIssue("OPEN");
    await seedIssue("RESOLVED");

    const all = await getJson("/api/catalog/detection/issues");
    expect(all.statusCode).toBe(200);
    expect(all.json().issues).toHaveLength(3);

    const open = await getJson("/api/catalog/detection/issues?reviewStatus=OPEN");
    expect(open.json().issues).toHaveLength(2);
    expect(open.json().issues.every((i: { reviewStatus: string }) => i.reviewStatus === "OPEN")).toBe(true);
  });

  it("ignores an unrecognized reviewStatus filter and returns everything", async () => {
    await seedIssue("OPEN");
    const res = await getJson("/api/catalog/detection/issues?reviewStatus=BOGUS");
    expect(res.json().issues).toHaveLength(1);
  });
});

describe("POST /api/catalog/detection/issues/:id/resolve", () => {
  it("resolves an OPEN issue, records an audit row, and returns ok", async () => {
    const issue = await seedIssue();
    const res = await postJson(`/api/catalog/detection/issues/${issue.id}/resolve`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const after = await prisma.detectionIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.reviewStatus).toBe("RESOLVED");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "detection_issue_review", targetId: issue.id },
    });
    expect(audit?.details).toContain("resolved");
  });

  it("rejects a request without a valid CSRF token", async () => {
    const issue = await seedIssue();
    const res = await postJson(`/api/catalog/detection/issues/${issue.id}/resolve`, "bad");
    expect(res.statusCode).toBe(403);
    const after = await prisma.detectionIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.reviewStatus).toBe("OPEN");
  });

  it("rejects an unauthenticated request (401)", async () => {
    const issue = await seedIssue();
    const res = await app.inject({
      method: "POST",
      url: `/api/catalog/detection/issues/${issue.id}/resolve`,
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("returns 422 on a second resolve of an already-resolved issue", async () => {
    const issue = await seedIssue();
    await postJson(`/api/catalog/detection/issues/${issue.id}/resolve`);
    const res = await postJson(`/api/catalog/detection/issues/${issue.id}/resolve`);
    expect(res.statusCode).toBe(422);
  });

  it("returns 400 for a non-numeric issue id", async () => {
    const res = await postJson("/api/catalog/detection/issues/not-a-number/resolve");
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/catalog/detection/issues/:id/dismiss", () => {
  it("dismisses an OPEN issue and audits it", async () => {
    const issue = await seedIssue();
    const res = await postJson(`/api/catalog/detection/issues/${issue.id}/dismiss`);
    expect(res.statusCode).toBe(200);
    const after = await prisma.detectionIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.reviewStatus).toBe("IGNORED");
    const audit = await prisma.auditLog.findFirst({
      where: { action: "detection_issue_review", targetId: issue.id },
    });
    expect(audit?.details).toContain("dismissed");
  });

  it("returns 422 when the issue is no longer OPEN", async () => {
    const issue = await seedIssue("RESOLVED");
    const res = await postJson(`/api/catalog/detection/issues/${issue.id}/dismiss`);
    expect(res.statusCode).toBe(422);
  });
});
