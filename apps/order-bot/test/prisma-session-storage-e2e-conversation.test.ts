// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Bot, session } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { conversations, createConversation } from "@grammyjs/conversations";
import {
  prisma,
  createCategory,
  createCatalogProduct,
  createDenomination,
  updateDenomination,
  upsertUser,
} from "@app/db";
import { DeliveryType, ProductType } from "@app/core/enums";
import { AdditionalFieldType, type AdditionalField } from "@app/core/deliveryFields";
import { invalidateRateCache } from "../src/util/rate";
import { initialSession, type MyContext, type SessionData } from "../src/context";
import { prismaSessionStorage } from "../src/util/prismaSessionStorage";
import { customerInfoConversation } from "../src/conversations/customerInfo";

/**
 * THE mandatory end-to-end regression test for this migration (task-2-brief.md
 * / phase-d-plan.md's Task 2 intro): a real multi-step conversation, run
 * through grammY's REAL `session()` + `conversations()` middleware backed by
 * the REAL `prismaSessionStorage()` adapter under test — NOT `FakeConversation`
 * (test/helpers/ctx.ts), which every other conversation test in this suite
 * uses. `FakeConversation.external()` runs the given op inline and hands the
 * live JS value straight back — it never serializes anything, so it
 * structurally cannot reproduce the Phase B landmine class of bug (a
 * `conversation.external()` result carrying a function/closure "worked" only
 * because the OLD in-memory Map storage never serialized session data
 * either). This test instead drives two genuinely separate
 * `bot.handleUpdate()` calls against a real `Bot`, with session persistence
 * going through an actual `JSON.stringify`/`JSON.parse` + Postgres round
 * trip between them via `prismaSessionStorage()` — the same adapter
 * `apps/order-bot/src/main.ts` wires into the real bot. If any
 * `conversation.external()` call site in this conversation (or the plugin's
 * own internal op log) ever returns something that doesn't survive that
 * round trip, this test breaks.
 *
 * `customerInfoConversation` is used as the vehicle (not
 * `nicknameCheck.ts`, the conversation Phase B's actual fix touched) because
 * that file does not exist on this branch's history — it lives on a sibling,
 * not-yet-merged worktree (`worktree-nickname-verification`, commits
 * ea8fd082/54cbf47a — confirmed via `git branch --all --contains` and
 * `git merge-base`, see task-2-report.md's audit section). `customerInfoConversation`
 * is the closest structural analog actually present here: entered
 * programmatically (not via a command/callback trigger), does a real
 * `conversation.external()` DB read (`getDenomination`) before its first
 * `wait()`, collects buyer input across a `wait()` boundary, and writes a
 * terminal result into session scratch that must survive to the next
 * conversation step (renderOrderConfirmation) — the same shape of risk
 * nicknameCheck.ts had.
 *
 * Deliberately builds a MINIMAL bot (session + conversations + this one
 * conversation registered) rather than reusing `buildBot()` from main.ts:
 * the other production middleware (registeredUser, rateLimit, joinGate,
 * commerceGate, the callback router) is unrelated to what Task 2 changes and
 * is already covered elsewhere (middleware.test.ts, wiring.test.ts,
 * customer-info.test.ts's handler-level coverage of this same conversation
 * via FakeConversation) — pulling all of it in here would just add unrelated
 * failure surface without strengthening the one property this test exists to
 * prove: that a real multi-step conversation survives a real round trip
 * through the new storage adapter, across separate updates, to completion.
 */

// Cast rather than satisfy `UserFromGetMe` field-for-field: this object only
// needs to make `bot.botInfo` truthy (see `Bot`'s constructor — passing
// `botInfo` skips the `getMe()` network call `init()` would otherwise make),
// its exact shape is never inspected by anything this test exercises.
const FAKE_ME = {
  id: 1,
  is_bot: true,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as UserFromGetMe;

interface SentCall {
  method: string;
  payload: Record<string, unknown>;
}

/** Intercepts every outgoing Telegram API call with a plausible canned
 * success response, so the real bot/conversation code (which calls real
 * `ctx.api.*`/`ctx.reply`/`ctx.editMessageText`, etc.) runs to completion
 * without ever touching the network. Every call is recorded into `sink` so
 * assertions can inspect what the conversation actually sent — the same
 * "record + inspect" shape test/helpers/ctx.ts's `makeCtx` uses, but wired
 * at grammY's real `Api` transformer layer (`bot.api.config.use`) instead of
 * replacing `ctx` methods, so this exercises grammY's genuine Update →
 * Context construction and the real `session()`/`conversations()` plugins,
 * not a hand-built context object. */
function installFakeTransport(bot: Bot<MyContext>, sink: SentCall[]) {
  let msgSeq = 5000;
  // The real Telegram response shape varies per method (`ApiCallResult<M>`);
  // this stub deliberately returns one generic shape for every method — the
  // `any` is the boundary where that simplification happens, not a loosened
  // contract anywhere real bot code relies on.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot.api.config.use(async (_prev, method, payload): Promise<any> => {
    sink.push({ method, payload: payload as Record<string, unknown> });
    const p = payload as { chat_id?: number | string };
    const chatId = typeof p.chat_id === "number" ? p.chat_id : 42;
    if (method === "sendMessage" || method === "sendPhoto" || method === "copyMessage") {
      return { ok: true, result: { message_id: ++msgSeq, date: 0, chat: { id: chatId, type: "private" } } };
    }
    if (method === "editMessageText" || method === "editMessageCaption" || method === "editMessageReplyMarkup") {
      return { ok: true, result: { message_id: ++msgSeq, date: 0, chat: { id: chatId, type: "private" } } };
    }
    // deleteMessage, answerCallbackQuery, and everything else this flow
    // touches return a bare boolean on real Telegram.
    return { ok: true, result: true };
  });
}

/** Builds a minimal but real grammY bot: real `session()` (backed by the
 * adapter under test) + real `conversations()` + the real
 * `customerInfoConversation`. `seedDbUser` stands in for what the
 * production `registeredUser` middleware would have stamped onto a fresh
 * session (see this file's header comment for why that middleware isn't
 * pulled into this minimal composer) — `initial` only ever runs once, on a
 * chat's very first update, exactly like grammY's real session() behavior. */
function buildTestBot(sink: SentCall[], seedDbUser: SessionData["dbUser"]): Bot<MyContext> {
  const bot = new Bot<MyContext>("123456:test-token-not-real", { botInfo: FAKE_ME });
  installFakeTransport(bot, sink);
  bot.use(
    session({
      initial: () => ({ ...initialSession(), dbUser: seedDbUser }),
      storage: prismaSessionStorage(),
    }),
  );
  bot.use(conversations());
  bot.use(createConversation(customerInfoConversation, "customerInfo"));
  // Entry: only reached when no conversation is active for this chat (the
  // `createConversation` middleware above consumes the update instead,
  // resuming customerInfo, once it's active) — mirrors main.ts's own
  // "conversations plugin resumes first, entry triggers only run otherwise"
  // ordering (see that file's header comment).
  bot.use(async (ctx) => {
    const data = (ctx.callbackQuery?.data as string | undefined) ?? "";
    const m = /^test:buy:(\d+):(\d+)$/.exec(data);
    if (!m) return;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    ctx.session.scratch.pendingInfoProductId = parseInt(m[1]!, 10);
    ctx.session.scratch.pendingInfoQuantity = parseInt(m[2]!, 10);
    await ctx.conversation.enter("customerInfo");
  });
  return bot;
}

let updateSeq = 9000;

function buyTapUpdate(chatId: number, userId: number, denomId: number, qty: number): Update {
  return {
    update_id: ++updateSeq,
    callback_query: {
      id: `cbq${updateSeq}`,
      from: { id: userId, is_bot: false, first_name: "Buyer" },
      chat_instance: "ci",
      data: `test:buy:${denomId}:${qty}`,
      message: {
        message_id: ++updateSeq,
        date: 0,
        chat: { id: chatId, type: "private", first_name: "Buyer" },
        text: "placeholder",
      },
    },
  } as unknown as Update;
}

function textUpdate(chatId: number, userId: number, text: string): Update {
  return {
    update_id: ++updateSeq,
    message: {
      message_id: ++updateSeq,
      date: 0,
      chat: { id: chatId, type: "private", first_name: "Buyer" },
      from: { id: userId, is_bot: false, first_name: "Buyer" },
      text,
    },
  } as unknown as Update;
}

const GAME_ID_FIELD: AdditionalField = {
  key: "game_id",
  label: { id: "ID Game", en: "Game ID" },
  type: AdditionalFieldType.TEXT,
  required: true,
  options: [],
  placeholder: "e.g. 123456789",
};

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.botSession.deleteMany();
  invalidateRateCache();
});

describe("end-to-end: customerInfoConversation through the REAL Prisma session adapter", () => {
  it("mints session state on entry, persists it to Postgres, reads it back on a SEPARATE handleUpdate call, and completes the conversation correctly", async () => {
    const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Test Buyer" });
    const category = await createCategory(prisma, `e2e-cat-${Math.random()}`);
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `E2E Manual Info Product ${Math.random()}` });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "E2E Manual Info Denom",
      type: ProductType.SHARED,
      durationLabel: "1 Month",
      price: "10.00",
    });
    await updateDenomination(prisma, denom.id, {
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: JSON.stringify([GAME_ID_FIELD]),
    });

    const dbUserSnap: SessionData["dbUser"] = {
      id: user.id,
      telegramId: String(user.telegramId),
      role: user.role,
      language: user.language,
      referralCode: user.referralCode,
      walletBalance: String(user.walletBalance),
      preferredCurrency: null,
    };

    const sink: SentCall[] = [];
    const bot = buildTestBot(sink, dbUserSnap);
    const CHAT_ID = 42;

    // --- Update 1: the "Buy" tap that enters the conversation -------------
    await bot.handleUpdate(buyTapUpdate(CHAT_ID, 42, denom.id, 1));

    // --- Assert: real persistence after update 1 ---------------------------
    const rowAfterEntry = await prisma.botSession.findUnique({ where: { key: String(CHAT_ID) } });
    expect(rowAfterEntry).not.toBeNull();
    // The scratch fields set at entry are exactly what makes this a
    // "checkout in progress" session per classifySessionKind.
    expect(rowAfterEntry!.kind).toBe("checkout");
    const dataAfterEntry = JSON.parse(rowAfterEntry!.data) as SessionData & { conversation?: unknown };
    // The conversation is genuinely suspended mid-flight, waiting at its
    // first wait() — its replay op log (including the conversation.external()
    // result from getDenomination, a real Prisma row) is embedded in the
    // persisted session and must have round-tripped through Postgres intact.
    expect(dataAfterEntry.conversation).toBeDefined();
    expect(JSON.stringify(dataAfterEntry.conversation)).toContain("E2E Manual Info Denom");
    // The field prompt for the single configured field was sent — as an
    // edit of the "Buy" tap's own bubble (menuAnchor → smartEdit prefers
    // editing over a fresh send when the update carries a callbackQuery),
    // not a new message.
    expect(sink.some((c) => c.method === "editMessageText" && JSON.stringify(c.payload).includes("Game ID"))).toBe(true);

    // --- Update 2: the buyer's typed answer, on a SEPARATE handleUpdate() --
    // call, resuming purely from what was just read back out of Postgres —
    // nothing here shares a JS reference with update 1's context.
    await bot.handleUpdate(textUpdate(CHAT_ID, 42, "GID-777"));

    const rowAfterAnswer = await prisma.botSession.findUnique({ where: { key: String(CHAT_ID) } });
    expect(rowAfterAnswer).not.toBeNull();
    const dataAfterAnswer = JSON.parse(rowAfterAnswer!.data) as SessionData & { conversation?: Record<string, unknown> };

    // The conversation completed (its own return, no more wait() calls) —
    // grammY's conversations plugin deletes the per-conversation entry from
    // session.conversation once it finishes, and clears the whole object
    // once empty.
    expect(dataAfterAnswer.conversation).toBeUndefined();

    // The terminal write this conversation makes (scratch.customerData) is
    // exactly what the pre-Phase-B-fix nicknameCheck.ts bug would have
    // corrupted had it carried a closure: it survived, plain and correct.
    expect(JSON.parse(dataAfterAnswer.scratch.customerData as string)).toEqual([{ game_id: "GID-777" }]);
    expect(dataAfterAnswer.scratch.pendingInfoProductId).toBeUndefined();
    expect(dataAfterAnswer.scratch.pendingInfoQuantity).toBeUndefined();

    // Still mid-checkout (customerData set, order not yet created) — TTL
    // split correctly keeps this in the shorter "checkout" bucket, not the
    // 24h "nav" one.
    expect(rowAfterAnswer!.kind).toBe("checkout");

    // The conversation actually continued to completion and rendered the
    // order confirmation screen — not just "didn't throw".
    expect(sink.some((c) => c.method === "sendMessage" && JSON.stringify(c.payload).includes("Confirm Order"))).toBe(true);

    await prisma.$disconnect().catch(() => undefined);
  });
});
