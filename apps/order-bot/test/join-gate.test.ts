// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, setSetting, upsertUser } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { resetBotIdentity } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { joinGate, registeredUser } from "../src/middleware";
import * as ckb from "../src/keyboards/customer";
import { makeCtx, calls, lastMarkup } from "./helpers/ctx";
import { t } from "../src/util/i18n";

/**
 * Behavior tests for the `joinGate` middleware (apps/order-bot/src/middleware.ts):
 * blocks every customer interaction until the admin-configured join-gate
 * channel/group have been joined. See task-5-brief.md for the full spec.
 *
 * `joinGateCache` is module-level (keyed by telegram user id), so every test
 * here uses a distinct `from.id` to avoid cross-test cache bleed — except the
 * cache/check-again tests, which deliberately reuse the same id across two
 * calls within the same test.
 */
describe("joinGate middleware", () => {
  beforeEach(async () => {
    await resetDb(prisma);
    resetBotIdentity(); // admin ids fall back to config.ADMIN_IDS ("999,1000")
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("feature off (neither channel nor group configured) — calls next() with zero getChatMember calls", async () => {
    const gcmCalls: unknown[] = [];
    const { ctx } = makeCtx({
      from: { id: 6001 },
      getChatMember: async (...args) => {
        gcmCalls.push(args);
        return { status: "member" };
      },
    });
    const next = vi.fn(async () => {});

    await joinGate(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(gcmCalls).toHaveLength(0);
  });

  it("admin user passes through untouched, even with the gate active and no membership", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    const gcmCalls: unknown[] = [];
    const { ctx } = makeCtx({
      from: { id: 999 }, // 999 is an admin per ADMIN_IDS in setup-db.ts
      getChatMember: async (...args) => {
        gcmCalls.push(args);
        return { status: "left" };
      },
    });
    const next = vi.fn(async () => {});

    await joinGate(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(gcmCalls).toHaveLength(0);
  });

  it("channel-only required, not joined — replies with a channel-only join keyboard", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    await setSetting(prisma, "join_gate_channel_url", "https://t.me/mychannel");
    const { ctx, sink } = makeCtx({
      from: { id: 6003 },
      getChatMember: async () => ({ status: "left" }),
    });
    const next = vi.fn(async () => {});

    await joinGate(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(calls(sink, "reply")).toHaveLength(1);
    const markup = lastMarkup(sink) as { inline_keyboard?: Array<Array<{ text: string }>> };
    const texts = (markup.inline_keyboard ?? []).flat().map((b) => b.text);
    expect(texts).toContain(t(ctx, "gate.btn_join_channel"));
    expect(texts).not.toContain(t(ctx, "gate.btn_join_group"));
    expect(texts).toContain(t(ctx, "gate.btn_check_again"));
    const replyText = calls(sink, "reply")[0]!.args[0] as string;
    expect(replyText).toContain(t(ctx, "gate.line_channel"));
    expect(replyText).not.toContain(t(ctx, "gate.line_group"));
  });

  it("both required, channel joined but group not — message mentions only the group", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    await setSetting(prisma, "join_gate_group_id", "-100222");
    await setSetting(prisma, "join_gate_group_url", "https://t.me/mygroup");
    const { ctx, sink } = makeCtx({
      from: { id: 6004 },
      getChatMember: async (chatId) => ({ status: Number(chatId) === -100111 ? "member" : "left" }),
    });
    const next = vi.fn(async () => {});

    await joinGate(ctx, next);

    expect(next).not.toHaveBeenCalled();
    const replyText = calls(sink, "reply")[0]!.args[0] as string;
    expect(replyText).toContain(t(ctx, "gate.line_group"));
    expect(replyText).not.toContain(t(ctx, "gate.line_channel"));
    const markup = lastMarkup(sink) as { inline_keyboard?: Array<Array<{ text: string }>> };
    const texts = (markup.inline_keyboard ?? []).flat().map((b) => b.text);
    expect(texts).toContain(t(ctx, "gate.btn_join_group"));
    expect(texts).not.toContain(t(ctx, "gate.btn_join_channel"));
  });

  it("both required and both joined — calls next(), no reply sent", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    await setSetting(prisma, "join_gate_group_id", "-100222");
    const { ctx, sink } = makeCtx({
      from: { id: 6005 },
      getChatMember: async () => ({ status: "member" }),
    });
    const next = vi.fn(async () => {});

    await joinGate(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(calls(sink, "reply")).toHaveLength(0);
  });

  it("getChatMember throwing fails open (next() still called) and logs a warning", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    const { ctx, sink } = makeCtx({
      from: { id: 6006 },
      getChatMember: async () => {
        throw new Error("bot is not a member of the target chat");
      },
    });
    const next = vi.fn(async () => {});
    const warn = vi.spyOn(logger, "warn");

    let warnCalls: unknown[][] = [];
    try {
      await joinGate(ctx, next);
    } finally {
      warnCalls = warn.mock.calls;
      warn.mockRestore();
    }

    expect(next).toHaveBeenCalledTimes(1);
    expect(calls(sink, "reply")).toHaveLength(0);
    expect(warnCalls.length).toBeGreaterThan(0);
    const warnedAboutThisChat = warnCalls.some((c) => JSON.stringify(c).includes("-100111"));
    expect(warnedAboutThisChat).toBe(true);
  });

  it("caches a not-joined verdict: two updates from the same user within the TTL only call getChatMember once", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    const gcmCalls: unknown[] = [];
    const getChatMember = async (...args: unknown[]) => {
      gcmCalls.push(args);
      return { status: "left" };
    };
    const from = { id: 6007 };

    const first = makeCtx({ from, getChatMember });
    await joinGate(first.ctx, vi.fn(async () => {}));

    const second = makeCtx({ from, getChatMember });
    await joinGate(second.ctx, vi.fn(async () => {}));

    expect(gcmCalls).toHaveLength(1);
  });

  it('tapping "check again" (v1:menu:main) always forces a fresh check, even with a valid cache entry', async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    const gcmCalls: unknown[] = [];
    const getChatMember = async (...args: unknown[]) => {
      gcmCalls.push(args);
      return { status: "left" };
    };
    const from = { id: 6008 };

    // First update (not the check-again tap) populates the cache.
    const first = makeCtx({ from, getChatMember });
    await joinGate(first.ctx, vi.fn(async () => {}));
    expect(gcmCalls).toHaveLength(1);

    // Second update: tap "✅ I've Joined" — same cache-valid TTL window, but
    // must bypass the cache and re-check.
    const second = makeCtx({ from, getChatMember, callbackData: ckb.cb("menu", "main") });
    const next = vi.fn(async () => {});
    await joinGate(second.ctx, next);

    expect(gcmCalls).toHaveLength(2); // re-checked despite the valid cache entry
    expect(next).not.toHaveBeenCalled(); // still not joined
    const answers = calls(second.sink, "answerCallbackQuery");
    expect(answers).toHaveLength(1);
    expect(answers[0]!.args[0]).toMatchObject({
      text: t(second.ctx, "gate.alert_still_missing"),
      show_alert: true,
    });
  });

  it('"restricted" status honors is_member: true counts as joined, false counts as not joined', async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");

    const joinedCtx = makeCtx({
      from: { id: 6009 },
      getChatMember: async () => ({ status: "restricted", is_member: true }),
    });
    const joinedNext = vi.fn(async () => {});
    await joinGate(joinedCtx.ctx, joinedNext);
    expect(joinedNext).toHaveBeenCalledTimes(1);
    expect(calls(joinedCtx.sink, "reply")).toHaveLength(0);

    const notJoinedCtx = makeCtx({
      from: { id: 6010 },
      getChatMember: async () => ({ status: "restricted", is_member: false }),
    });
    const notJoinedNext = vi.fn(async () => {});
    await joinGate(notJoinedCtx.ctx, notJoinedNext);
    expect(notJoinedNext).not.toHaveBeenCalled();
    expect(calls(notJoinedCtx.sink, "reply")).toHaveLength(1);
  });

  it("my_chat_member status-change update passes straight through — no membership checks, no reply", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    const gcmCalls: unknown[] = [];
    const { ctx, sink } = makeCtx({
      from: { id: 6011 },
      myChatMember: true,
      getChatMember: async (...args) => {
        gcmCalls.push(args);
        return { status: "left" };
      },
    });
    const next = vi.fn(async () => {});

    await joinGate(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(gcmCalls).toHaveLength(0);
    expect(sink).toHaveLength(0);
  });

  it("non-private chat update (e.g. the required group itself) is silently swallowed once the gate is active — never replies into the group, never bypasses the gate", async () => {
    await setSetting(prisma, "join_gate_group_id", "-100222");
    const { ctx, sink } = makeCtx({
      from: { id: 6012 },
      chatType: "supergroup",
      text: "hello",
      getChatMember: async () => ({ status: "left" }),
    });
    const next = vi.fn(async () => {});

    await joinGate(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(sink).toHaveLength(0); // no reply posted publicly into the group
  });

  it("non-private chat update passes through untouched when the gate isn't configured at all — e.g. an ungated shop's support group", async () => {
    const { ctx, sink } = makeCtx({
      from: { id: 6016 },
      chatType: "supergroup",
      text: "hello",
      getChatMember: async () => ({ status: "left" }),
    });
    const next = vi.fn(async () => {});

    await joinGate(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(sink).toHaveLength(0);
  });

  it("admin's non-private chat update (e.g. a ticket Reply/Close tap in the support group) still passes through even with the gate active", async () => {
    await setSetting(prisma, "join_gate_group_id", "-100222");
    const { ctx, sink } = makeCtx({
      from: { id: 999 }, // 999 is an admin per ADMIN_IDS in setup-db.ts
      chatType: "supergroup",
      callbackData: "adm:ticket:reply:1",
      getChatMember: async () => ({ status: "left" }),
    });
    const next = vi.fn(async () => {});

    await joinGate(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(sink).toHaveLength(0);
  });

  // Referral attribution (`/start ref_<code>`) happens in `registeredUser`
  // — it's the middleware that actually creates the User row on first
  // sight, and `upsertUser` only ever applies `referredByCode` at creation
  // time. These tests run the real chain (`registeredUser` then `joinGate`)
  // so they'd fail if referral credit were ever lost to the gate again.
  it("/start ref_<code> deep link still credits the referral even though the update is gated", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    const referrer = await upsertUser(prisma, { telegramId: 6013, username: "referrer", fullName: "Referrer" });

    const { ctx, sink } = makeCtx({
      from: { id: 6014, username: "newbie" },
      text: `/start ref_${referrer.referralCode}`,
      getChatMember: async () => ({ status: "left" }),
    });
    const next = vi.fn(async () => {});

    await registeredUser(ctx, async () => {
      await joinGate(ctx, next);
    });

    expect(next).not.toHaveBeenCalled(); // still gated — the user sees the join prompt
    expect(calls(sink, "reply")).toHaveLength(1);

    const referee = await prisma.user.findUnique({ where: { telegramId: BigInt(6014) } });
    expect(referee).toBeTruthy();
    expect(referee?.referredById).toBe(referrer.id);
  });

  it("a gated /start without a ref_ payload doesn't touch referral attribution", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    const { ctx } = makeCtx({
      from: { id: 6015 },
      text: "/start",
      getChatMember: async () => ({ status: "left" }),
    });
    const next = vi.fn(async () => {});

    await registeredUser(ctx, async () => {
      await joinGate(ctx, next);
    });

    expect(next).not.toHaveBeenCalled();
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(6015) } });
    expect(user).toBeTruthy(); // registeredUser always creates the row
    expect(user?.referredById).toBeNull();
  });

  it("/start@botname ref_<code> (bot-username-suffixed deep link) also credits the referral", async () => {
    await setSetting(prisma, "join_gate_channel_id", "-100111");
    const referrer = await upsertUser(prisma, { telegramId: 6017, username: "referrer2", fullName: "Referrer Two" });

    const { ctx } = makeCtx({
      from: { id: 6018, username: "newbie2" },
      text: `/start@TestBot ref_${referrer.referralCode}`,
      getChatMember: async () => ({ status: "left" }),
    });
    const next = vi.fn(async () => {});

    await registeredUser(ctx, async () => {
      await joinGate(ctx, next);
    });

    const referee = await prisma.user.findUnique({ where: { telegramId: BigInt(6018) } });
    expect(referee?.referredById).toBe(referrer.id);
  });
});
