import { beforeEach, describe, expect, it, vi } from "vitest";
import { Bot, GrammyError, InputFile } from "grammy";
const db = vi.hoisted(() => ({ ticketMessage: { findFirst: vi.fn() }, notificationOutbox: { updateMany: vi.fn() }, supportAttachment: { update: vi.fn() } }));
vi.mock("@app/db", () => ({ prisma: db }));
vi.mock("@app/core/supportMedia", () => ({ supportMediaType: vi.fn(), supportObjectUrl: vi.fn(async () => "https://private-storage.invalid/object") }));
import { deliverSupportReply } from "./supportDelivery";

const row = { id: 102, claimedAt: new Date("2026-10-12") };
const payload = { ticket_id: 7, message_id: 9, chat_id: 1234 };
const attachment = { id: "proof", mime: "image/png", bytes: 4, filename: "proof.png", storageKey: "private-proof", bucket: "private-bucket", etag: "verified", telegramBotId: "777", telegramFileId: "cached-proof" };
const message = { content: "We are checking your payment.", ticket: { ticketNumber: "TKT-20261012-A7K9M2", user: { telegramId: 1234n, language: "en" } }, attachments: [attachment] };
function transport() {
  const bot = new Bot("777:test-only-token");
  const text = vi.spyOn(bot.api, "sendMessage").mockResolvedValue({ message_id: 1 } as Awaited<ReturnType<typeof bot.api.sendMessage>>);
  const photo = vi.spyOn(bot.api, "sendPhoto").mockResolvedValue({ message_id: 2, photo: [{ file_id: "new-cached-proof" }] } as Awaited<ReturnType<typeof bot.api.sendPhoto>>);
  return { bot, text, photo };
}
beforeEach(() => {
  vi.clearAllMocks(); db.ticketMessage.findFirst.mockResolvedValue(message); db.notificationOutbox.updateMany.mockResolvedValue({ count: 1 }); db.supportAttachment.update.mockResolvedValue({});
});
describe("public support reply delivery checkpoints", () => {
  it("sends one localized text and reuses the same bot's verified file cache", async () => {
    const { bot, text, photo } = transport();
    await deliverSupportReply(bot, row, payload);
    expect(text).toHaveBeenCalledTimes(1); expect(text.mock.calls[0]![2]).toMatchObject({ entities: [] }); expect(text.mock.calls[0]![1]).toContain("TKT-20261012-A7K9M2");
    expect(photo).toHaveBeenCalledExactlyOnceWith(1234, "cached-proof");
    expect(db.notificationOutbox.updateMany).toHaveBeenCalledTimes(2);
    expect(db.supportAttachment.update).toHaveBeenCalledWith({ where: { id: "proof" }, data: { telegramFileId: "new-cached-proof", telegramBotId: "777" } });
  });
  it("refuses internal/missing messages and revoked recipient links before sending", async () => {
    const { bot, text, photo } = transport();
    db.ticketMessage.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...message, ticket: { ...message.ticket, user: { ...message.ticket.user, telegramId: 9876n } } });
    await expect(deliverSupportReply(bot, row, payload)).rejects.toThrow("authorized");
    await expect(deliverSupportReply(bot, row, payload)).rejects.toThrow("authorized");
    expect(text).not.toHaveBeenCalled(); expect(photo).not.toHaveBeenCalled();
    expect(db.ticketMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 9, ticketId: 7, internal: false, senderType: "ADMIN" } }));
  });
  it("resumes a failed media send without repeating successful text", async () => {
    const { bot, text, photo } = transport(); photo.mockRejectedValueOnce(new Error("Telegram temporarily unavailable"));
    await expect(deliverSupportReply(bot, row, payload)).rejects.toThrow("unavailable");
    const saved = JSON.parse(db.notificationOutbox.updateMany.mock.calls[0]![0].data.payloadJson);
    expect(saved.delivery).toEqual({ text: true, media: [] });
    await deliverSupportReply(bot, row, saved);
    expect(text).toHaveBeenCalledTimes(1); expect(photo).toHaveBeenCalledTimes(2);
  });
  it("preserves an acknowledged send across a transient database checkpoint failure", async () => {
    const { bot, text, photo } = transport(); const claim = { ...row, id: 103 };
    db.notificationOutbox.updateMany.mockRejectedValueOnce(new Error("database temporarily unavailable"));
    await expect(deliverSupportReply(bot, claim, payload)).rejects.toThrow("database");
    await deliverSupportReply(bot, claim, payload);
    expect(text).toHaveBeenCalledTimes(1); expect(photo).toHaveBeenCalledTimes(1);
  });
  it("falls back from a rejected file cache to a bounded private stream", async () => {
    const { bot, text, photo } = transport();
    photo.mockRejectedValueOnce(new GrammyError("File cache expired", { ok: false, error_code: 400, description: "wrong file identifier" }, "sendPhoto", {}));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-length": "4" } })));
    try {
      await deliverSupportReply(bot, row, payload);
      expect(text).toHaveBeenCalledTimes(1); expect(photo).toHaveBeenCalledTimes(2); expect(photo.mock.calls[1]![1]).toBeInstanceOf(InputFile);
      expect(fetch).toHaveBeenCalledWith("https://private-storage.invalid/object", expect.objectContaining({ headers: { "If-Match": "verified" } }));
    } finally { vi.unstubAllGlobals(); }
  });
  it("refuses a stream exceeding verified bytes without checkpointing media delivery", async () => {
    const { bot, photo } = transport();
    db.ticketMessage.findFirst.mockResolvedValue({ ...message, attachments: [{ ...attachment, telegramBotId: "another-bot" }] });
    photo.mockImplementation(async (_chat, source) => {
      if (source instanceof InputFile) {
        const raw = await source.toRaw();
        if (!(raw instanceof Uint8Array)) for await (const _chunk of raw) { /* Simulated Telegram transport consumes the stream. */ }
      }
      return { message_id: 2, photo: [{ file_id: "new-cache" }] } as Awaited<ReturnType<typeof bot.api.sendPhoto>>;
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { headers: { "content-length": "4" } })));
    try {
      await expect(deliverSupportReply(bot, { ...row, id: 104 }, payload)).rejects.toThrow("transfer failed");
      expect(db.notificationOutbox.updateMany).toHaveBeenCalledTimes(1);
      expect(JSON.parse(db.notificationOutbox.updateMany.mock.calls[0]![0].data.payloadJson).delivery).toEqual({ text: true, media: [] });
      expect(db.supportAttachment.update).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

});
