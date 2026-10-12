import "./dispatcher.test-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@app/core/mailer", async (original) => ({
  ...await original<typeof import("@app/core/mailer")>(),
  sendMail: vi.fn(),
}));
import { sendMail } from "@app/core/mailer";
import { EMAIL_EVENT_REGISTRY } from "@app/core/email";
import { prisma, enqueueEmailEvent, emailPolicyKey, setSetting, SMTP_HOST_KEY, SMTP_FROM_KEY } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { drainBatch } from "./dispatcher";
const acceptance = { messageId: "<accepted@test.invalid>", acceptedAt: "2026-10-12T00:00:00.000Z" };
beforeEach(async () => {
  await resetDb(prisma);
  vi.mocked(sendMail).mockReset().mockResolvedValue(acceptance);
  await setSetting(prisma, SMTP_HOST_KEY, "smtp.test.invalid");
  await setSetting(prisma, SMTP_FROM_KEY, "Shop <noreply@example.com>");
});

describe.each(EMAIL_EVENT_REGISTRY)("$key worker integration", (event) => {
  const args = (id: string, to: string | null = "test@example.com") => ({ key: event.key, aggregateId: id, to,
    payload: event.key === "account.password_reset.requested" ? { reset_url: "https://shop.example/reset/one-use-test-token" } : { order_code: "TEST-ORDER" },
  });
  it("sends once through transport and atomically records acceptance, never inbox delivery", async () => {
    await setSetting(prisma, emailPolicyKey(event.key), "true");
    expect(await enqueueEmailEvent(prisma, args("valid"))).toBe(true);
    expect(await enqueueEmailEvent(prisma, args("valid"))).toBe(false);
    await drainBatch(null); await drainBatch(null);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMail).mock.calls[0]![1]).toEqual(expect.objectContaining({ to: "test@example.com", html: expect.any(String), text: expect.any(String) }));
    const row = await prisma.notificationOutbox.findFirstOrThrow();
    expect(row.status).toBe("SENT");
    expect(JSON.parse(row.payloadJson).delivery).toEqual(acceptance);
    expect(row.payloadJson).not.toContain("one-use-test-token");
  });
  it("rechecks disabled preferences at dispatch and skips missing recipients without sending", async () => {
    await setSetting(prisma, emailPolicyKey(event.key), "true");
    await enqueueEmailEvent(prisma, args("pending"));
    await setSetting(prisma, emailPolicyKey(event.key), "false");
    await drainBatch(null);
    const pending = await prisma.notificationOutbox.findFirstOrThrow();
    expect(pending.status).toBe(event.mandatory ? "SENT" : "FAILED");
    if (!event.mandatory) expect(pending.lastError).toBe("SKIPPED_DISABLED");
    expect(sendMail).toHaveBeenCalledTimes(event.mandatory ? 1 : 0);
    await setSetting(prisma, emailPolicyKey(event.key), "true");
    await enqueueEmailEvent(prisma, args("missing", null)); await drainBatch(null);
    expect(sendMail).toHaveBeenCalledTimes(event.mandatory ? 1 : 0);
    expect(await prisma.notificationOutbox.findFirst({ where: { lastError: "SKIPPED_NO_RECIPIENT", status: "FAILED" } })).not.toBeNull();
  });
  it("retries transient SMTP failures and records permanent rejection without fake SENT", async () => {
    await setSetting(prisma, emailPolicyKey(event.key), "true");
    await enqueueEmailEvent(prisma, args("retry"));
    vi.mocked(sendMail).mockRejectedValueOnce(Object.assign(new Error("fixture"), { responseCode: 451 }));
    await drainBatch(null);
    const retry = await prisma.notificationOutbox.findFirstOrThrow();
    expect(retry.status).toBe("PENDING"); expect(retry.attempts).toBe(1); expect(retry.sentAt).toBeNull();
    expect(retry.lastError).toBe("SMTP_TEMPORARY");
    await prisma.notificationOutbox.update({ where: { id: retry.id }, data: { nextRetryAt: new Date(0) } });
    await drainBatch(null); await drainBatch(null);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect((await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: retry.id } })).status).toBe("SENT");
    await enqueueEmailEvent(prisma, args("permanent"));
    vi.mocked(sendMail).mockRejectedValueOnce(Object.assign(new Error("fixture"), { responseCode: 550 }));
    await drainBatch(null); await drainBatch(null);
    expect(sendMail).toHaveBeenCalledTimes(3);
    const failed = await prisma.notificationOutbox.findFirstOrThrow({ where: { lastError: "SMTP_REJECTED" } });
    expect(failed.status).toBe("FAILED"); expect(failed.sentAt).toBeNull(); expect(failed.attempts).toBe(1);
  });
});
