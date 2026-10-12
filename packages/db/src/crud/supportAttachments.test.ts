import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createSupportUpload, finalizeSupportUpload, cleanupSupportMedia } from "./supportAttachments";
import { createTicket, addTicketMessage, listTicketMessages, setSupportLegalHold, reopenTicketAdmin } from "./support";
import { SenderType } from "@app/core/enums";
import { randomUUID } from "node:crypto";

let db: TestDb;
let ownerId: number;
let otherId: number;
let adminId: number;
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const objects = new Map<string, { bytes: Buffer; type: string; etag: string }>();
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => {
  vi.stubEnv("SUPPORT_R2_ACCOUNT_ID", "a".repeat(32)); vi.stubEnv("SUPPORT_R2_BUCKET", "any-private-bucket");
  vi.stubEnv("SUPPORT_R2_ACCESS_KEY_ID", "test-key"); vi.stubEnv("SUPPORT_R2_SECRET_ACCESS_KEY", "test-secret");
  const owner = await db.prisma.user.create({ data: { referralCode: randomUUID() } }); ownerId = owner.id;
  const other = await db.prisma.user.create({ data: { referralCode: randomUUID() } }); otherId = other.id;
  const admin = await db.prisma.user.create({ data: { referralCode: randomUUID(), role: "ADMIN" } }); adminId = admin.id;
  objects.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = decodeURIComponent(url.pathname); const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(init?.headers);
    if (method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    if (method === "PUT") {
      const source = headers.get("x-amz-copy-source"); const original = source ? objects.get(source) : undefined;
      if (!original || original.etag !== headers.get("x-amz-copy-source-if-match")) return new Response(null, { status: 412 });
      objects.set(key, { ...original }); return new Response("<CopyObjectResult/>");
    }
    const object = objects.get(key); if (!object) return new Response(null, { status: 404 });
    if (headers.get("If-Match") && headers.get("If-Match") !== object.etag) return new Response(null, { status: 412 });
    return new Response(method === "HEAD" ? null : object.bytes, { status: method === "HEAD" ? 200 : 206, headers: { "Content-Length": String(object.bytes.length), "Content-Type": object.type, ETag: object.etag } });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function ready(owner = ownerId, draftId = randomUUID(), ticketId?: number) {
  const intent = await createSupportUpload(db.prisma, { ownerId: owner, draftId, ticketId, filename: "proof.png", mime: "image/png", bytes: png.length });
  objects.set(new URL(intent.url).pathname, { bytes: png, type: "image/png", etag: '"verified-bytes"' });
  await finalizeSupportUpload(db.prisma, intent.id, owner);
  return intent.id;
}
describe("verified support attachment lifecycle", () => {
  it("finalizes idempotently, freezes a different key and pins the selected bucket", async () => {
    const id = await ready();
    const row = await db.prisma.supportAttachment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("READY"); expect(row.storageKey).toMatch(/^support-ready\//); expect(row.bucket).toBe("any-private-bucket");
    vi.mocked(fetch).mockClear();
    expect(await finalizeSupportUpload(db.prisma, id, ownerId)).toEqual({ id, status: "READY" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(finalizeSupportUpload(db.prisma, id, otherId)).rejects.toMatchObject({ key: "helpdesk.invalid_request" });
  });
  it("refuses MIME spoofing, mismatched size, unverified attachments and foreign ownership", async () => {
    const intent = await createSupportUpload(db.prisma, { ownerId, draftId: randomUUID(), filename: "fake.png", mime: "image/png", bytes: png.length });
    objects.set(new URL(intent.url).pathname, { bytes: Buffer.alloc(png.length), type: "image/png", etag: "bad" });
    await expect(finalizeSupportUpload(db.prisma, intent.id, ownerId)).rejects.toMatchObject({ key: "helpdesk.media_verification_failed" });
    await expect(createTicket(db.prisma, ownerId, "A real issue description", null, null, null, { attachmentIds: [intent.id] })).rejects.toMatchObject({ key: "helpdesk.media_verification_failed" });
    const id = await ready(otherId);
    await expect(createTicket(db.prisma, ownerId, "A real issue description", null, null, null, { attachmentIds: [id] })).rejects.toMatchObject({ key: "helpdesk.media_verification_failed" });
  });
  it("atomically binds one draft, refuses reuse and makes repeated submissions idempotent", async () => {
    const id = await ready(); const requestKey = randomUUID();
    const first = await createTicket(db.prisma, ownerId, "Payment confirmation is delayed", null, null, null, { requestKey, attachmentIds: [id] });
    const second = await createTicket(db.prisma, ownerId, "Payment confirmation is delayed", null, null, null, { requestKey, attachmentIds: [id] });
    expect(second.id).toBe(first.id);
    await expect(createTicket(db.prisma, ownerId, "Another support request", null, null, null, { attachmentIds: [id] })).rejects.toMatchObject({ key: "helpdesk.media_verification_failed" });
    const replyKey = randomUUID();
    const replies = await Promise.all(Array.from({ length: 3 }, () => addTicketMessage(db.prisma, { ticketId: first.id, senderId: ownerId, senderType: SenderType.USER, content: "A follow-up message", requestKey: replyKey })));
    expect(new Set(replies.map((message) => message.id)).size).toBe(1);
  });
  it("keeps note text and attachments outside the default customer conversation", async () => {
    const ticket = await createTicket(db.prisma, ownerId, "The order is delayed");
    const id = await ready(adminId, randomUUID(), ticket.id);
    const note = await addTicketMessage(db.prisma, { ticketId: ticket.id, senderId: adminId, senderType: SenderType.ADMIN, content: "Private staff investigation", internal: true, attachmentIds: [id] });
    expect(await listTicketMessages(db.prisma, ticket.id)).toEqual([]);
    expect(await db.prisma.supportAttachment.findUnique({ where: { id } })).toMatchObject({ messageId: note.id });
    expect(await db.prisma.notificationOutbox.count({ where: { event: "TICKET_REPLY_DM", payloadJson: { contains: `"message_id":${note.id}` } } })).toBe(0);
  });
  it("cleans expired drafts bound to open tickets and preserves held, active and resolved evidence", async () => {
    const now = new Date(); const old = new Date(now.getTime() - 100 * 86400_000);
    const ticket = await createTicket(db.prisma, ownerId, "An active support issue");
    const orphan = await ready(ownerId, randomUUID(), ticket.id);
    await db.prisma.supportAttachment.update({ where: { id: orphan }, data: { expiresAt: old } });
    const draft = randomUUID(); const held = await ready(ownerId, draft);
    const closed = await createTicket(db.prisma, ownerId, "An old support issue", null, null, null, { attachmentIds: [held] });
    await db.prisma.supportTicket.update({ where: { id: closed.id }, data: { status: "CLOSED", closedAt: old, legalHold: true } });
    expect(await cleanupSupportMedia(db.prisma, now)).toEqual({ deleted: 1 });
    expect(await db.prisma.supportAttachment.findUnique({ where: { id: orphan } })).toMatchObject({ status: "DELETED" });
    expect(await db.prisma.supportAttachment.findUnique({ where: { id: held } })).toMatchObject({ status: "READY" });
    await db.prisma.supportTicket.update({ where: { id: closed.id }, data: { legalHold: false, status: "RESOLVED" } });
    expect(await cleanupSupportMedia(db.prisma, now)).toEqual({ deleted: 0 });
    await db.prisma.supportTicket.update({ where: { id: closed.id }, data: { status: "CLOSED" } });
    expect(await cleanupSupportMedia(db.prisma, now)).toEqual({ deleted: 1 });
  });
  it("serializes evidence hold and reopen against a claimed retention deletion", async () => {
    const id = await ready();
    const ticket = await createTicket(db.prisma, ownerId, "An expired closed case", null, null, null, { attachmentIds: [id] });
    const old = new Date(Date.now() - 100 * 86400_000);
    await db.prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: "CLOSED", closedAt: old } });
    const original = vi.mocked(fetch).getMockImplementation()!;
    let notifyStart!: () => void; let allowDelete!: () => void;
    const started = new Promise<void>((resolve) => { notifyStart = resolve; });
    const released = new Promise<void>((resolve) => { allowDelete = resolve; });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === "DELETE") { notifyStart(); await released; }
      return original(input, init);
    });
    const cleanup = cleanupSupportMedia(db.prisma);
    await started;
    try {
      await expect(setSupportLegalHold(db.prisma, ticket.id, true, adminId)).rejects.toMatchObject({ key: "helpdesk.retention_busy" });
      await expect(reopenTicketAdmin(db.prisma, ticket.id)).rejects.toMatchObject({ key: "helpdesk.retention_busy" });
    } finally { allowDelete(); }
    expect(await cleanup).toEqual({ deleted: 1 });
    expect(await db.prisma.supportTicket.findUnique({ where: { id: ticket.id } })).toMatchObject({ status: "CLOSED", legalHold: false });
  });

});
