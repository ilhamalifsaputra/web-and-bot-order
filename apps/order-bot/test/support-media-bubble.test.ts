// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/core/supportMedia", async (orig) => ({
  ...(await orig<typeof import("@app/core/supportMedia")>()),
  supportMediaAvailable: vi.fn(async () => true),
}));
vi.mock("@app/db", async (orig) => ({
  ...(await orig<typeof import("@app/db")>()),
  ingestSupportTelegramMedia: vi.fn(),
}));

import { prisma, ingestSupportTelegramMedia } from "@app/db";
import { ValidationError } from "@app/core/errors";
import { TicketStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, FakeConversation, calls, type SentCall, type MakeCtxOptions } from "./helpers/ctx";
import type { MyContext, SessionData } from "../src/context";
import { t } from "../src/util/i18n";
import { supportConversation } from "../src/conversations/support";
import { ticketUserReplyConversation } from "../src/conversations/customer";

const ingest = vi.mocked(ingestSupportTelegramMedia);
let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  ingest.mockReset();
  let n = 0;
  ingest.mockImplementation(async () => `att-${++n}`);
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

  it("cancel after one photo deletes the description too (the photo is already gone)", async () => {
    const h = harness();
    const conv = new FakeConversation([...toMedia(h), h.step("p1", photo("p1")), h.tap("cancel", "v1:support:v2:cancel")]);
    await supportConversation(conv.asMyConversation(), h.entry("v1:support:open"));
    expect(h.deletedIds(h.windowOf(4))).toEqual([h.idOf("description")]);
    expect(h.deletedIds(h.sink)).toEqual([h.idOf("p1"), h.idOf("description")]);
    expect(await prisma.supportTicket.count()).toBe(0);
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
  });

  it("cancel after text and one photo deletes the typed text too", async () => {
    const ticket = await openTicket(); const h = harness();
    const conv = new FakeConversation([h.step("text", { text: "Still broken" }), h.step("p1", photo("p1")), h.tap("cancel", `v1:ticket:view:${ticket.id}`)]);
    await ticketUserReplyConversation(conv.asMyConversation(), h.entry(`v1:ticket:reply:${ticket.id}`));
    expect(h.deletedIds(h.windowOf(2))).toEqual([h.idOf("text")]);
    expect(h.deletedIds(h.sink)).toEqual([h.idOf("p1"), h.idOf("text")]);
    expect(await prisma.ticketMessage.count({ where: { ticketId: ticket.id } })).toBe(0);
  });

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
