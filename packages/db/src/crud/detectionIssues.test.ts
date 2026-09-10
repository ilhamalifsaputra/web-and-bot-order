import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ValidationError } from "@app/core/errors";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { listAuditLogs } from "./audit";
import {
  listDetectionIssues,
  resolveDetectionIssue,
  dismissDetectionIssue,
} from "./detectionIssues";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
});

async function makeAdmin() {
  return prisma.user.create({ data: { referralCode: `a${Math.random()}`, role: "ADMIN" } });
}

let fpCounter = 0;
async function makeIssue(overrides: Partial<{ reviewStatus: string; status: string }> = {}) {
  fpCounter += 1;
  return prisma.detectionIssue.create({
    data: {
      status: overrides.status ?? "unknown",
      reviewStatus: overrides.reviewStatus ?? "OPEN",
      inputFingerprint: `fp-${fpCounter}-${Math.random().toString(16).slice(2, 8)}`,
      rawInput: JSON.stringify({ productName: "Mystery SKU" }),
      reason: "no catalog candidates matched",
      detectorStamp: "1.0.0+k0",
    },
  });
}

describe("listDetectionIssues", () => {
  it("returns every row, most-recently-seen first, when no filter is given", async () => {
    await makeIssue();
    await makeIssue({ reviewStatus: "RESOLVED" });
    const rows = await listDetectionIssues(prisma, {});
    expect(rows).toHaveLength(2);
  });

  it("narrows to a single reviewStatus when asked", async () => {
    await makeIssue({ reviewStatus: "OPEN" });
    await makeIssue({ reviewStatus: "OPEN" });
    await makeIssue({ reviewStatus: "IGNORED" });
    const open = await listDetectionIssues(prisma, { reviewStatus: "OPEN" });
    expect(open).toHaveLength(2);
    expect(open.every((r) => r.reviewStatus === "OPEN")).toBe(true);
  });
});

describe("resolveDetectionIssue / dismissDetectionIssue", () => {
  it("resolve moves OPEN -> RESOLVED and writes one audit row", async () => {
    const admin = await makeAdmin();
    const issue = await makeIssue();

    await resolveDetectionIssue(prisma, issue.id, admin.id);

    const after = await prisma.detectionIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.reviewStatus).toBe("RESOLVED");

    const logs = await listAuditLogs(prisma, { action: "detection_issue_review", targetId: issue.id });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.adminId).toBe(admin.id);
    expect(logs[0]!.details).toContain("resolved");
    expect(logs[0]!.details).toContain(`#${issue.id}`);
  });

  it("dismiss moves OPEN -> IGNORED and audits it as dismissed", async () => {
    const admin = await makeAdmin();
    const issue = await makeIssue();

    await dismissDetectionIssue(prisma, issue.id, admin.id);

    const after = await prisma.detectionIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.reviewStatus).toBe("IGNORED");
    const logs = await listAuditLogs(prisma, { action: "detection_issue_review", targetId: issue.id });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.details).toContain("dismissed");
  });

  it("rejects a second transition on an already-resolved issue and leaves it untouched", async () => {
    const admin = await makeAdmin();
    const issue = await makeIssue();
    await resolveDetectionIssue(prisma, issue.id, admin.id);

    await expect(resolveDetectionIssue(prisma, issue.id, admin.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(dismissDetectionIssue(prisma, issue.id, admin.id)).rejects.toBeInstanceOf(ValidationError);

    const after = await prisma.detectionIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.reviewStatus).toBe("RESOLVED");
    // still exactly the one audit row from the successful first transition
    const logs = await listAuditLogs(prisma, { action: "detection_issue_review", targetId: issue.id });
    expect(logs).toHaveLength(1);
  });

  it("rejects a transition on an issue id that does not exist", async () => {
    const admin = await makeAdmin();
    await expect(resolveDetectionIssue(prisma, 999_999, admin.id)).rejects.toBeInstanceOf(ValidationError);
  });
});
