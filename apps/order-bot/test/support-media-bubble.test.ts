// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/core/supportMedia", async (orig) => ({
  ...(await orig<typeof import("@app/core/supportMedia")>()),
  supportMediaAvailable: vi.fn(async () => true),
}));
vi.mock("@app/db", async (orig) => {
  const actual = await orig<typeof import("@app/db")>();
  return {
    ...actual,
    ingestSupportTelegramMedia: vi.fn(),
    discardSupportAttachment: vi.fn(async () => true),
    // Real by default; a test can make one call reject.
    createTicket: vi.fn(actual.createTicket),
  };
});

import { prisma, ingestSupportTelegramMedia, discardSupportAttachment, createTicket } from "@app/db";
import { supportMediaAvailable, supportMediaLimits } from "@app/core/supportMedia";
import { logger } from "@app/core/logger";
import { ValidationError } from "@app/core/errors";
import { TicketStatus } from "@app/core/enums";
import { NARROW_LABEL_WIDTH, visualWidth } from "@app/core/buttonLimits";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, FakeConversation, calls, type SentCall, type MakeCtxOptions } from "./helpers/ctx";
import type { MyContext, SessionData } from "../src/context";
import { t } from "../src/util/i18n";
import { supportConversation } from "../src/conversations/support";
import { ticketUserReplyConversation } from "../src/conversations/customer";

const ingest = vi.mocked(ingestSupportTelegramMedia);
const discard = vi.mocked(discardSupportAttachment);
let sample: SampleData;
/** Attachment ids are UUIDs in production; the mock hands out real-shaped ones. */
const attId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  ingest.mockReset();
  discard.mockClear();
  let n = 0;
  ingest.mockImplementation(async () => attId(++n));
});

afterAll(async () => {
  await prisma.$disconnect();
});

const ANCHOR = 500;
const chat = { id: 42, type: "private" as const };

/** One shared session (like a real chat), an anchor bubble already on screen,
 * and per-update windows of the sink so each update's Telegram calls can be
 * counted on their own. */
function harness() {
  const sink: SentCall[] = [];
  const shared = {
    lang: "en",
    scratch: {},
    menuMsgId: ANCHOR,
    dbUser: {
      id: sample.user.id,
      telegramId: String(sample.user.telegramId),
      role: sample.user.role,
      language: sample.user.language,
      referralCode: sample.user.referralCode,
      walletBalance: String(sample.user.walletBalance),
      preferredCurrency: null,
    },
  } as unknown as SessionData;
  const marks: number[] = [];
  const mk = (o: MakeCtxOptions) => makeCtx({ sink, from: { id: 42, username: "tester" }, sharedSession: shared, ...o }).ctx;
  const sent: Record<string, MyContext> = {};
  /** A scripted update that opens a new counting window when it arrives. */
  const step = (name: string, o: MakeCtxOptions) => () => {
    marks.push(sink.length);
    const ctx = mk(o);
    sent[name] = ctx;
    return ctx;
  };
  const tap = (name: string, data: string) => step(name, { callbackData: data, cbMessage: { message_id: shared.menuMsgId ?? ANCHOR, chat, date: 0 } });
  /** Calls made while handling the i-th scripted update (0-based, in order). */
  const windowOf = (i: number) => sink.slice(marks[i], marks[i + 1] ?? sink.length);
  const count = (w: SentCall[], method: string) => w.filter((c) => c.method === method).length;
  const sends = (w: SentCall[]) => ["sendMessage", "reply", "sendPhoto", "replyWithPhoto", "sendDocument", "replyWithDocument"].reduce((s, m) => s + count(w, m), 0);
  const edits = (w: SentCall[]) => w.filter((c) => c.method === "editMessageText" || c.method === "editMessageCaption");
  const deletedIds = (w: SentCall[]) => w.filter((c) => c.method === "deleteMessage").map((c) => c.args[1]);
  const editText = (c: SentCall) => String(c.args[0] === chat.id ? c.args[2] : c.args[0]);
  const idOf = (name: string) => sent[name]!.message!.message_id;
  const entry = (data: string) => mk({ callbackData: data, cbMessage: { message_id: ANCHOR, chat, date: 0 } });
  return { sink, shared, step, tap, windowOf, count, sends, edits, deletedIds, editText, idOf, entry };
}

const photo = (id: string): MakeCtxOptions => ({ photo: [{ file_id: id }] });
/** One photo of a Telegram album: every part shares the media_group_id. */
const albumPhoto = (id: string, group: string): MakeCtxOptions => ({ photo: [{ file_id: id }], messageExtra: { media_group_id: group } });
type Button = { text: string; callback_data?: string };
/** The inline keyboard an edit (api- or ctx-level) carried, as rows. */
const markupOf = (c: SentCall): Button[][] => (c.args[c.args.length - 1] as { reply_markup?: { inline_keyboard?: Button[][] } } | undefined)?.reply_markup?.inline_keyboard ?? [];
const removeButtons = (c: SentCall, prefix: string) => markupOf(c).flat().filter((b) => b.callback_data?.startsWith(prefix));
const imageDocument: MakeCtxOptions = { document: { file_id: "doc-1" }, messageExtra: { document: { file_id: "doc-1", file_name: "shot.jpg", mime_type: "image/jpeg", file_size: 1000 } } };
const en = (key: string, args?: Record<string, unknown>) => t({ session: { lang: "en" } } as unknown as MyContext, key, args as never);

/** Category → issue → description, leaving the wizard on the media step. */
function toMedia(h: ReturnType<typeof harness>) {
  return [h.tap("category", "v1:support:v2:category:ACCOUNT"), h.tap("issue", "v1:support:v2:issue:login"), h.step("description", { text: "Cannot sign into my account" })];
}

describe("support wizard media step (one bubble)", () => {
  it("a successful photo is 0 sends, 2 edits (uploading, counter) and 1 delete of that photo", async () => {
    const h = harness();
    const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    const w = h.windowOf(3);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(2);
    expect(h.deletedIds(w)).toEqual([h.idOf("p1")]);
    expect(h.editText(h.edits(w)[0]!)).toContain(en("helpdesk.uploading_bot"));
    const counter = h.editText(h.edits(w)[1]!);
    expect(counter).toContain("1/3");
    expect(counter).toContain(en("helpdesk.media_item", { n: 1 }));
    expect(counter).not.toContain(en("helpdesk.uploading_bot"));
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("a failed upload is 0 sends, 2 edits and 1 delete, with the bot retry text (not the web one)", async () => {
    const h = harness();
    ingest.mockRejectedValueOnce(new ValidationError("helpdesk.upload_failed"));
    const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    const w = h.windowOf(3);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(2);
    expect(h.deletedIds(w)).toEqual([h.idOf("p1")]);
    const after = h.editText(h.edits(w)[1]!);
    expect(after).toContain(en("helpdesk.upload_failed_bot"));
    expect(after).not.toContain(en("helpdesk.upload_failed"));
    expect(after).toContain("0/3");
  });

  it("an album of 5 photos: 3 uploaded, 2 refused, every photo deleted, 0 sends", async () => {
    const h = harness();
    const photos = ["a", "b", "c", "d", "e"].map((id) => h.step(id, photo(id)));
    const conv = new FakeConversation([...toMedia(h), ...photos, h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    expect(ingest).toHaveBeenCalledTimes(3);
    const album = [3, 4, 5, 6, 7].map((i) => h.windowOf(i));
    expect(album.map((w) => h.sends(w))).toEqual([0, 0, 0, 0, 0]);
    // uploading + counter for each accepted photo; one error re-render for each refused one
    expect(album.map((w) => h.edits(w).length)).toEqual([2, 2, 2, 1, 1]);
    expect(album.map((w) => h.deletedIds(w))).toEqual(["a", "b", "c", "d", "e"].map((id) => [h.idOf(id)]));
    const full = h.editText(h.edits(album[2]!)[1]!);
    expect(full).toContain("3/3");
    expect(full).toContain(en("helpdesk.media_limit_hint"));
    expect(full).toContain(`${en("helpdesk.media_item", { n: 1 })}  ${en("helpdesk.media_item", { n: 2 })}  ${en("helpdesk.media_item", { n: 3 })}`);
    const refused = h.editText(h.edits(album[3]!)[0]!);
    expect(refused).toContain(en("web.support_attach_error_count"));
    expect(refused).toContain("3/3");
  });

  it("a failed photo followed by a successful one still sends nothing", async () => {
    const h = harness();
    ingest.mockRejectedValueOnce(new ValidationError("helpdesk.upload_failed"));
    const conv = new FakeConversation([...toMedia(h), h.step("bad", photo("bad")), h.step("good", photo("good")), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    expect(h.sends(h.windowOf(3)) + h.sends(h.windowOf(4))).toBe(0);
    expect(h.deletedIds(h.windowOf(3))).toEqual([h.idOf("bad")]);
    expect(h.deletedIds(h.windowOf(4))).toEqual([h.idOf("good")]);
    expect(h.editText(h.edits(h.windowOf(4))[1]!)).toContain("1/3");
  });

  it("an image sent as a file gets 1 edit asking for a photo, no upload and no delete", async () => {
    const h = harness();
    const conv = new FakeConversation([...toMedia(h), h.step("doc", imageDocument), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    const w = h.windowOf(3);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(1);
    expect(h.deletedIds(w)).toEqual([]);
    expect(h.editText(h.edits(w)[0]!)).toContain(en("helpdesk.send_as_photo"));
    expect(ingest).not.toHaveBeenCalled();
  });

  it("shows one remove button per stored file, two per row, and none before the first file", async () => {
    const h = harness();
    const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.step("p2", photo("p2")), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    // The description window renders the empty media step: no remove buttons.
    expect(removeButtons(h.edits(h.windowOf(2)).at(-1)!, "v1:support:v2:rm:")).toEqual([]);
    const afterTwo = h.edits(h.windowOf(4)).at(-1)!;
    expect(removeButtons(afterTwo, "v1:support:v2:rm:")).toEqual([
      { text: en("helpdesk.media_remove", { n: 1 }), callback_data: `v1:support:v2:rm:${attId(1)}` },
      { text: en("helpdesk.media_remove", { n: 2 }), callback_data: `v1:support:v2:rm:${attId(2)}` },
    ]);
    expect(markupOf(afterTwo).some((row) => row.length === 2 && row.every((b) => b.callback_data?.startsWith("v1:support:v2:rm:")))).toBe(true);
  });

  it("removing a file is 0 sends, 1 edit and 0 deletes; the counter, checklist and buttons follow", async () => {
    const h = harness();
    const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.step("p2", photo("p2")), h.tap("rm", `v1:support:v2:rm:${attId(1)}`), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    const w = h.windowOf(5);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(1);
    expect(h.deletedIds(w)).toEqual([]);
    const text = h.editText(h.edits(w)[0]!);
    expect(text).toContain("1/3");
    expect(text).toContain(en("helpdesk.media_item", { n: 1 }));
    expect(text).not.toContain(en("helpdesk.media_item", { n: 2 }));
    expect(removeButtons(h.edits(w)[0]!, "v1:support:v2:rm:")).toEqual([{ text: en("helpdesk.media_remove", { n: 1 }), callback_data: `v1:support:v2:rm:${attId(2)}` }]);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(prisma, attId(1), sample.user.id);
  });

  it("a remove tap for an id not in the draft only re-renders: 0 sends, 1 edit, no error text, nothing discarded", async () => {
    const h = harness();
    const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.tap("rm", `v1:support:v2:rm:${attId(9)}`), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    const w = h.windowOf(4);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(1);
    expect(h.deletedIds(w)).toEqual([]);
    const text = h.editText(h.edits(w)[0]!);
    expect(text).toContain("1/3");
    expect(text).not.toContain(en("error.stale_screen"));
    expect(discard).not.toHaveBeenCalled();
  });

  it("the review screen carries no remove buttons", async () => {
    const h = harness();
    const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.tap("review", "v1:support:v2:review"), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    const review = h.edits(h.windowOf(4)).at(-1)!;
    expect(h.editText(review)).toContain(en("helpdesk.attachments"));
    expect(removeButtons(review, "v1:support:v2:rm:")).toEqual([]);
  });

  it("a double tap on the same remove button removes that one file only; the second tap just re-renders", async () => {
    const h = harness();
    const rm = `v1:support:v2:rm:${attId(1)}`;
    const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.step("p2", photo("p2")), h.tap("rm1", rm), h.tap("rm2", rm), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    const second = h.windowOf(6);
    expect({ sends: h.sends(second), edits: h.edits(second).length, deletes: h.deletedIds(second) }).toEqual({ sends: 0, edits: 1, deletes: [] });
    expect(h.editText(h.edits(second)[0]!)).toContain("1/3");
    expect(removeButtons(h.edits(second)[0]!, "v1:support:v2:rm:").map((b) => b.callback_data)).toEqual([`v1:support:v2:rm:${attId(2)}`]);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(prisma, attId(1), sample.user.id);
  });

  it("every remove callback (UUID id) stays within Telegram's 64-byte limit", async () => {
    const h = harness();
    const photos = ["a", "b", "c"].map((id) => h.step(id, photo(id)));
    const conv = new FakeConversation([...toMedia(h), ...photos, h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    const buttons = removeButtons(h.edits(h.windowOf(5)).at(-1)!, "v1:support:v2:rm:");
    expect(buttons).toHaveLength(3);
    for (const b of buttons) expect(Buffer.byteLength(b.callback_data!, "utf8")).toBeLessThanOrEqual(64);
  });

  it("a remove whose discard rejects still updates the bubble: 0 sends, 1 edit, counter dropped", async () => {
    const h = harness();
    discard.mockRejectedValueOnce(new Error("Database unavailable."));
    const warn = vi.spyOn(logger, "warn");
    try {
      const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.tap("rm", `v1:support:v2:rm:${attId(1)}`), h.tap("cancel", "v1:support:v2:cancel")]);
      await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
      const w = h.windowOf(4);
      expect({ sends: h.sends(w), edits: h.edits(w).length, deletes: h.deletedIds(w) }).toEqual({ sends: 0, edits: 1, deletes: [] });
      expect(h.editText(h.edits(w)[0]!)).toContain("0/3");
      expect(warn).toHaveBeenCalledWith({ attachmentId: attId(1), errorName: "Error" }, expect.any(String));
    } finally { warn.mockRestore(); }
  });

  it("a photo over the size limit is refused before upload: 0 sends, 1 edit, 1 delete, size text", async () => {
    const h = harness();
    const big = { messageExtra: { photo: [{ file_id: "big", file_size: supportMediaLimits().imageBytes + 1 }] } } as MakeCtxOptions;
    const conv = new FakeConversation([...toMedia(h), h.step("big", { ...big, photo: [{ file_id: "big" }] }), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    const w = h.windowOf(3);
    expect({ sends: h.sends(w), edits: h.edits(w).length, deletes: h.deletedIds(w) }).toEqual({ sends: 0, edits: 1, deletes: [h.idOf("big")] });
    const text = h.editText(h.edits(w)[0]!);
    expect(text).toContain(en("web.support_attach_error_size"));
    expect(text).not.toContain(en("helpdesk.uploading_bot"));
    expect(ingest).not.toHaveBeenCalled();
  });

  for (const key of ["web.support_attach_error_size", "web.support_attach_error_type", "web.support_attach_error_count"]) {
    it(`an upload refused with ${key} shows that reason, not "send it again", and logs only stage/name/key`, async () => {
      const h = harness();
      ingest.mockRejectedValueOnce(new ValidationError(key));
      const warn = vi.spyOn(logger, "warn");
      try {
        const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.tap("cancel", "v1:support:v2:cancel")]);
        await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
        const w = h.windowOf(3);
        expect({ sends: h.sends(w), edits: h.edits(w).length, deletes: h.deletedIds(w) }).toEqual({ sends: 0, edits: 2, deletes: [h.idOf("p1")] });
        const after = h.editText(h.edits(w)[1]!);
        expect(after).toContain(en(key));
        expect(after).not.toContain(en("helpdesk.upload_failed_bot"));
        expect(warn).toHaveBeenCalledWith({ stage: "ingest", errorName: "ValidationError", key }, expect.any(String));
      } finally { warn.mockRestore(); }
    });
  }

  it("a getFile failure keeps the retry text and logs only stage and error name", async () => {
    const h = harness();
    const warn = vi.spyOn(logger, "warn");
    try {
      const failing = () => {
        const ctx = h.step("p1", photo("secret-file-id"))();
        ctx.api.getFile = (() => Promise.reject(new Error("https://api.telegram.org/bot123:TOKEN/getFile failed"))) as typeof ctx.api.getFile;
        return ctx;
      };
      const conv = new FakeConversation([...toMedia(h), failing, h.tap("cancel", "v1:support:v2:cancel")]);
      await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
      const w = h.windowOf(3);
      expect({ sends: h.sends(w), edits: h.edits(w).length, deletes: h.deletedIds(w) }).toEqual({ sends: 0, edits: 2, deletes: [h.idOf("p1")] });
      expect(h.editText(h.edits(w)[1]!)).toContain(en("helpdesk.upload_failed_bot"));
      expect(ingest).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith({ stage: "telegram_get_file", errorName: "Error" }, expect.any(String));
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("secret-file-id");
      expect(logged).not.toContain("TOKEN");
    } finally { warn.mockRestore(); }
  });

  it("a ticket that cannot be created ends on one edited bubble with a way back: 0 sends, 1 edit, 0 deletes", async () => {
    const h = harness();
    vi.mocked(createTicket).mockRejectedValueOnce(new ValidationError("helpdesk.media_verification_failed"));
    const warn = vi.spyOn(logger, "warn");
    try {
      const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.tap("review", "v1:support:v2:review"), h.tap("submit", "v1:support:v2:submit")]);
      await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
      const w = h.windowOf(5);
      expect({ sends: h.sends(w), edits: h.edits(w).length, deletes: h.deletedIds(w) }).toEqual({ sends: 0, edits: 1, deletes: [] });
      expect(h.editText(h.edits(w)[0]!)).toContain(en("helpdesk.ticket_unavailable"));
      expect(markupOf(h.edits(w)[0]!).flat().map((b) => b.callback_data)).toEqual(["v1:support:open", "v1:menu:main"]);
      expect(warn).toHaveBeenCalledWith({ errorName: "ValidationError", key: "helpdesk.media_verification_failed" }, expect.any(String));
      expect(await prisma.supportTicket.count()).toBe(0);
    } finally { warn.mockRestore(); }
  });

  it("an album of 3 shows the uploading edit only for its first photo: edits 2,1,1, 0 sends", async () => {
    const h = harness();
    const parts = ["a", "b", "c"].map((id) => h.step(id, albumPhoto(id, "album-1")));
    const conv = new FakeConversation([...toMedia(h), ...parts, h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    const album = [3, 4, 5].map((i) => h.windowOf(i));
    expect(album.map((w) => h.sends(w))).toEqual([0, 0, 0]);
    expect(album.map((w) => h.edits(w).length)).toEqual([2, 1, 1]);
    expect(album.map((w) => h.deletedIds(w))).toEqual(["a", "b", "c"].map((id) => [h.idOf(id)]));
    expect(h.editText(h.edits(album[0]!)[0]!)).toContain(en("helpdesk.uploading_bot"));
    expect(h.editText(h.edits(album[1]!)[0]!)).toContain("2/3");
    expect(h.editText(h.edits(album[1]!)[0]!)).not.toContain(en("helpdesk.uploading_bot"));
    expect(ingest).toHaveBeenCalledTimes(3);
  });

  it("a new album after an earlier one gets its own uploading edit", async () => {
    const h = harness();
    const conv = new FakeConversation([...toMedia(h), h.step("a", albumPhoto("a", "g1")), h.step("b", albumPhoto("b", "g2")), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    expect([3, 4].map((i) => h.edits(h.windowOf(i)).length)).toEqual([2, 2]);
  });

  it("with media off a photo is 0 sends, 1 edit and 1 delete of that photo", async () => {
    vi.mocked(supportMediaAvailable).mockResolvedValueOnce(false);
    const h = harness();
    const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    const w = h.windowOf(3);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(1);
    expect(h.deletedIds(w)).toEqual([h.idOf("p1")]);
    expect(h.editText(h.edits(w)[0]!)).toContain(en("helpdesk.media_unavailable"));
    expect(ingest).not.toHaveBeenCalled();
  });

  for (const exit of [
    { name: "the Cancel button", update: (h: ReturnType<typeof harness>) => h.tap("exit", "v1:support:v2:cancel") },
    { name: "/start", update: (h: ReturnType<typeof harness>) => h.step("exit", { text: "/start" }) },
    { name: "/cancel", update: (h: ReturnType<typeof harness>) => h.step("exit", { text: "/cancel" }) },
  ]) {
    it(`leaving via ${exit.name} after one photo sends Home once and deletes only the description`, async () => {
      const h = harness();
      const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), exit.update(h)]);
      await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
      const w = h.windowOf(4);
      // Home carries the persistent reply keyboard, so it is the one send.
      expect({ sends: h.sends(w), edits: h.edits(w).length, deletes: h.deletedIds(w) }).toEqual({ sends: 1, edits: 0, deletes: [h.idOf("description")] });
      // The photo itself was already deleted when it was stored.
      expect(h.deletedIds(h.sink)).toEqual([h.idOf("p1"), h.idOf("description")]);
      expect(await prisma.supportTicket.count()).toBe(0);
    });
  }
});

describe("remove button label", () => {
  it("fits the two-per-row budget in both languages", () => {
    for (const lang of ["en", "id"]) for (const n of [1, 2, 3]) {
      const label = t({ session: { lang } } as unknown as MyContext, "helpdesk.media_remove", { n } as never);
      expect(visualWidth(label), label).toBeLessThanOrEqual(NARROW_LABEL_WIDTH);
    }
  });
});

describe("ticket reply media (one bubble)", () => {
  async function openTicket() {
    return prisma.supportTicket.create({ data: { userId: sample.user.id, message: "broken", status: TicketStatus.OPEN } });
  }

  it("a successful photo is 0 sends, 2 edits and 1 delete of that photo", async () => {
    const ticket = await openTicket(); const h = harness();
    const conv = new FakeConversation([h.step("p1", photo("p1")), h.tap("cancel", `v1:ticket:view:${ticket.id}`)]);
    await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
    const w = h.windowOf(0);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(2);
    expect(h.deletedIds(w)).toEqual([h.idOf("p1")]);
    expect(h.editText(h.edits(w)[0]!)).toContain(en("helpdesk.uploading_bot"));
    expect(h.editText(h.edits(w)[1]!)).toContain("1/3");
    expect(h.editText(h.edits(w)[1]!)).toContain(en("helpdesk.media_item", { n: 1 }));
  });

  it("a failed upload is 0 sends, 2 edits and 1 delete, with the bot retry text", async () => {
    const ticket = await openTicket(); const h = harness();
    ingest.mockRejectedValueOnce(new ValidationError("helpdesk.upload_failed"));
    const conv = new FakeConversation([h.step("p1", photo("p1")), h.tap("cancel", `v1:ticket:view:${ticket.id}`)]);
    await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
    const w = h.windowOf(0);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(2);
    expect(h.deletedIds(w)).toEqual([h.idOf("p1")]);
    expect(h.editText(h.edits(w)[1]!)).toContain(en("helpdesk.upload_failed_bot"));
    expect(h.editText(h.edits(w)[1]!)).not.toContain(en("helpdesk.upload_failed"));
  });

  it("a 4th photo is deleted with one error edit and no send", async () => {
    const ticket = await openTicket(); const h = harness();
    const photos = ["a", "b", "c", "d"].map((id) => h.step(id, photo(id)));
    const conv = new FakeConversation([...photos, h.tap("cancel", `v1:ticket:view:${ticket.id}`)]);
    await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
    expect(ingest).toHaveBeenCalledTimes(3);
    const w = h.windowOf(3);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(1);
    expect(h.deletedIds(w)).toEqual([h.idOf("d")]);
    expect(h.editText(h.edits(w)[0]!)).toContain(en("web.support_attach_error_count"));
    expect(h.editText(h.edits(w)[0]!)).toContain(en("helpdesk.media_limit_hint_reply"));
    // Below the limit the hint stays out of the way.
    expect(h.editText(h.edits(h.windowOf(1)).at(-1)!)).not.toContain(en("helpdesk.media_limit_hint_reply"));
  });

  it("shows one remove button per stored file; removing one is 0 sends, 1 edit, 0 deletes", async () => {
    const ticket = await openTicket(); const h = harness();
    const conv = new FakeConversation([h.step("p1", photo("p1")), h.step("p2", photo("p2")), h.tap("rm", `v1:support:reply:rm:${attId(2)}`), h.tap("cancel", `v1:ticket:view:${ticket.id}`)]);
    await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
    expect(removeButtons(h.edits(h.windowOf(0))[0]!, "v1:support:reply:rm:")).toEqual([]);
    expect(removeButtons(h.edits(h.windowOf(1)).at(-1)!, "v1:support:reply:rm:")).toEqual([
      { text: en("helpdesk.media_remove", { n: 1 }), callback_data: `v1:support:reply:rm:${attId(1)}` },
      { text: en("helpdesk.media_remove", { n: 2 }), callback_data: `v1:support:reply:rm:${attId(2)}` },
    ]);
    const w = h.windowOf(2);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(1);
    expect(h.deletedIds(w)).toEqual([]);
    const text = h.editText(h.edits(w)[0]!);
    expect(text).toContain("1/3");
    expect(text).not.toContain(en("helpdesk.media_item", { n: 2 }));
    expect(removeButtons(h.edits(w)[0]!, "v1:support:reply:rm:")).toEqual([{ text: en("helpdesk.media_remove", { n: 1 }), callback_data: `v1:support:reply:rm:${attId(1)}` }]);
    expect(discard).toHaveBeenCalledWith(prisma, attId(2), sample.user.id);
  });

  it("a remove tap for an id not in the draft only re-renders: 0 sends, 1 edit, no error text", async () => {
    const ticket = await openTicket(); const h = harness();
    const conv = new FakeConversation([h.step("p1", photo("p1")), h.tap("rm", `v1:support:reply:rm:${attId(9)}`), h.tap("cancel", `v1:ticket:view:${ticket.id}`)]);
    await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
    const w = h.windowOf(1);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(1);
    expect(h.deletedIds(w)).toEqual([]);
    expect(h.editText(h.edits(w)[0]!)).toContain("1/3");
    expect(h.editText(h.edits(w)[0]!)).not.toContain(en("error.stale_screen"));
    expect(discard).not.toHaveBeenCalled();
  });

  it("a double tap on the same remove button removes that one file only; the second tap just re-renders", async () => {
    const ticket = await openTicket(); const h = harness();
    const rm = `v1:support:reply:rm:${attId(1)}`;
    const conv = new FakeConversation([h.step("p1", photo("p1")), h.step("p2", photo("p2")), h.tap("rm1", rm), h.tap("rm2", rm), h.tap("cancel", `v1:ticket:view:${ticket.id}`)]);
    await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
    const second = h.windowOf(3);
    expect({ sends: h.sends(second), edits: h.edits(second).length, deletes: h.deletedIds(second) }).toEqual({ sends: 0, edits: 1, deletes: [] });
    expect(h.editText(h.edits(second)[0]!)).toContain("1/3");
    const buttons = removeButtons(h.edits(second)[0]!, "v1:support:reply:rm:");
    expect(buttons.map((b) => b.callback_data)).toEqual([`v1:support:reply:rm:${attId(2)}`]);
    expect(Buffer.byteLength(buttons[0]!.callback_data!, "utf8")).toBeLessThanOrEqual(64);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(prisma, attId(1), sample.user.id);
  });

  it("a photo over the size limit is refused before upload: 0 sends, 1 edit, 1 delete, size text", async () => {
    const ticket = await openTicket(); const h = harness();
    const big: MakeCtxOptions = { photo: [{ file_id: "big" }], messageExtra: { photo: [{ file_id: "big", file_size: supportMediaLimits().imageBytes + 1 }] } };
    const conv = new FakeConversation([h.step("big", big), h.tap("cancel", `v1:ticket:view:${ticket.id}`)]);
    await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
    const w = h.windowOf(0);
    expect({ sends: h.sends(w), edits: h.edits(w).length, deletes: h.deletedIds(w) }).toEqual({ sends: 0, edits: 1, deletes: [h.idOf("big")] });
    expect(h.editText(h.edits(w)[0]!)).toContain(en("web.support_attach_error_size"));
    expect(ingest).not.toHaveBeenCalled();
  });

  it("an album of 3 shows the uploading edit only for its first photo: edits 2,1,1, 0 sends", async () => {
    const ticket = await openTicket(); const h = harness();
    const parts = ["a", "b", "c"].map((id) => h.step(id, albumPhoto(id, "album-1")));
    const conv = new FakeConversation([...parts, h.tap("cancel", `v1:ticket:view:${ticket.id}`)]);
    await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
    const album = [0, 1, 2].map((i) => h.windowOf(i));
    expect(album.map((w) => h.sends(w))).toEqual([0, 0, 0]);
    expect(album.map((w) => h.edits(w).length)).toEqual([2, 1, 1]);
    expect(album.map((w) => h.deletedIds(w))).toEqual(["a", "b", "c"].map((id) => [h.idOf(id)]));
    expect(h.editText(h.edits(album[2]!)[0]!)).toContain("3/3");
  });

  it("with media off a photo is 0 sends, 1 edit and 1 delete of that photo", async () => {
    vi.mocked(supportMediaAvailable).mockResolvedValueOnce(false);
    const ticket = await openTicket(); const h = harness();
    const conv = new FakeConversation([h.step("p1", photo("p1")), h.tap("cancel", `v1:ticket:view:${ticket.id}`)]);
    await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
    const w = h.windowOf(0);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(1);
    expect(h.deletedIds(w)).toEqual([h.idOf("p1")]);
    expect(h.editText(h.edits(w)[0]!)).toContain(en("helpdesk.media_unavailable"));
    expect(ingest).not.toHaveBeenCalled();
  });

  for (const exit of [
    // Cancel turns the reply bubble into the "cancelled" screen (1 edit);
    // /start and /cancel go Home, whose reply keyboard needs its one send.
    { name: "the Cancel button", sends: 0, edits: 1, update: (h: ReturnType<typeof harness>, id: number) => h.tap("exit", `v1:ticket:view:${id}`) },
    { name: "/start", sends: 1, edits: 0, update: (h: ReturnType<typeof harness>) => h.step("exit", { text: "/start" }) },
    { name: "/cancel", sends: 1, edits: 0, update: (h: ReturnType<typeof harness>) => h.step("exit", { text: "/cancel" }) },
  ]) {
    it(`leaving via ${exit.name} after text and one photo deletes only the typed text`, async () => {
      const ticket = await openTicket(); const h = harness();
      const conv = new FakeConversation([h.step("text", { text: "Still broken" }), h.step("p1", photo("p1")), exit.update(h, ticket.id)]);
      await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
      const w = h.windowOf(2);
      expect({ sends: h.sends(w), edits: h.edits(w).length, deletes: h.deletedIds(w) }).toEqual({ sends: exit.sends, edits: exit.edits, deletes: [h.idOf("text")] });
      // The photo itself was already deleted when it was stored.
      expect(h.deletedIds(h.sink)).toEqual([h.idOf("p1"), h.idOf("text")]);
      expect(await prisma.ticketMessage.count({ where: { ticketId: ticket.id } })).toBe(0);
    });
  }

  it("an image sent as a file gets 1 edit asking for a photo, no upload and no delete", async () => {
    const ticket = await openTicket(); const h = harness();
    const conv = new FakeConversation([h.step("doc", imageDocument), h.tap("cancel", `v1:ticket:view:${ticket.id}`)]);
    await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
    const w = h.windowOf(0);
    expect(h.sends(w)).toBe(0);
    expect(h.edits(w)).toHaveLength(1);
    expect(h.deletedIds(w)).toEqual([]);
    expect(h.editText(h.edits(w)[0]!)).toContain(en("helpdesk.send_as_photo"));
    expect(ingest).not.toHaveBeenCalled();
  });
});
