// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { resetBotIdentity } from "@app/core/runtime";
import { bindUpdateId, commerceGate } from "../src/middleware";
import * as ckb from "../src/keyboards/customer";
import { makeCtx } from "./helpers/ctx";

/**
 * Behavior tests for two Phase D middlewares (apps/order-bot/src/middleware.ts):
 *  - bindUpdateId's update_id dedup guard (task-1-brief.md)
 *  - commerceGate, the blanket private-chat-only guard (task-1-brief.md)
 */
describe("bindUpdateId — update_id dedup", () => {
  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.processedTelegramUpdate.deleteMany();
    resetBotIdentity();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a redelivered update_id (same value twice) only runs the wrapped handler once", async () => {
    let handlerInvocations = 0;
    const handler = async () => {
      handlerInvocations += 1;
    };

    const { ctx: first } = makeCtx({ from: { id: 8001 } });
    first.update.update_id = 555555;
    const { ctx: redelivery } = makeCtx({ from: { id: 8001 } });
    redelivery.update.update_id = 555555; // same update_id: simulates Telegram redelivery

    await bindUpdateId(first, handler);
    await bindUpdateId(redelivery, handler);

    expect(handlerInvocations).toBe(1);
  });

  it("two distinct update_ids both run the handler — dedup doesn't over-block", async () => {
    let handlerInvocations = 0;
    const handler = async () => {
      handlerInvocations += 1;
    };

    const { ctx: a } = makeCtx({ from: { id: 8002 } });
    a.update.update_id = 700001;
    const { ctx: b } = makeCtx({ from: { id: 8002 } });
    b.update.update_id = 700002;

    await bindUpdateId(a, handler);
    await bindUpdateId(b, handler);

    expect(handlerInvocations).toBe(2);
  });

  it("persists a ProcessedTelegramUpdate row for a claimed update_id", async () => {
    const { ctx } = makeCtx({ from: { id: 8003 } });
    ctx.update.update_id = 800001;

    await bindUpdateId(ctx, async () => {});

    const row = await prisma.processedTelegramUpdate.findUnique({ where: { updateId: 800001n } });
    expect(row).not.toBeNull();
  });

  it("a redelivery that arrives after a crash mid-processing (first call's handler throws) still short-circuits the second", async () => {
    let handlerInvocations = 0;
    const throwingHandler = async () => {
      handlerInvocations += 1;
      throw new Error("simulated crash mid-processing");
    };
    const okHandler = async () => {
      handlerInvocations += 1;
    };

    const { ctx: first } = makeCtx({ from: { id: 8004 } });
    first.update.update_id = 900001;
    const { ctx: redelivery } = makeCtx({ from: { id: 8004 } });
    redelivery.update.update_id = 900001;

    await expect(bindUpdateId(first, throwingHandler)).rejects.toThrow("simulated crash mid-processing");
    // The claim row was already written before the handler ran (and before it
    // threw), so the redelivery is still recognized as a duplicate — the
    // whole point of claiming BEFORE next(), not after a successful next().
    await bindUpdateId(redelivery, okHandler);

    expect(handlerInvocations).toBe(1); // only the first (throwing) call ran
  });
});

describe("commerceGate — blanket private-chat guard", () => {
  beforeEach(async () => {
    await resetDb(prisma);
    resetBotIdentity();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const COMMERCE_CALLBACK = ckb.cb("browse", "prods"); // "v1:browse:prods"
  const ADMIN_COMMERCE_CALLBACK = ckb.cb("adm", "verif", "reject", 1); // "v1:adm:verif:reject:1"
  const NON_PRIVATE_TYPES = ["group", "supergroup", "channel"] as const;

  describe("commerce callback data (v1:-prefixed)", () => {
    it("private chat: passes a v1: callback through to next()", async () => {
      const { ctx } = makeCtx({ chatType: "private", callbackData: COMMERCE_CALLBACK });
      const next = vi.fn(async () => {});
      await commerceGate(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    for (const chatType of NON_PRIVATE_TYPES) {
      it(`${chatType} chat: blocks a customer v1: callback (${COMMERCE_CALLBACK}) — never calls next(), never replies`, async () => {
        const { ctx, sink } = makeCtx({ chatType, callbackData: COMMERCE_CALLBACK });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(sink).toHaveLength(0); // silently dropped, mirroring joinGate
      });

      it(`${chatType} chat: also blocks an admin-panel v1:adm: callback (${ADMIN_COMMERCE_CALLBACK}) — no admin exemption`, async () => {
        const { ctx, sink } = makeCtx({ chatType, callbackData: ADMIN_COMMERCE_CALLBACK, from: { id: 999 } }); // 999 is an admin per ADMIN_IDS
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(sink).toHaveLength(0);
      });
    }

    it("non-v1 callback data (a stale pre-migration tap) is not treated as commerce and passes through", async () => {
      const { ctx } = makeCtx({ chatType: "supergroup", callbackData: "adm:ticket:reply:1" });
      const next = vi.fn(async () => {});
      await commerceGate(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe("commerce commands (start/menu/listproduk/search)", () => {
    it("private chat: /listproduk passes through to next()", async () => {
      const { ctx } = makeCtx({ chatType: "private", text: "/listproduk" });
      const next = vi.fn(async () => {});
      await commerceGate(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    for (const chatType of NON_PRIVATE_TYPES) {
      it(`${chatType} chat: blocks /listproduk — never calls next(), never replies`, async () => {
        const { ctx, sink } = makeCtx({ chatType, text: "/listproduk" });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(sink).toHaveLength(0);
      });

      it(`${chatType} chat: blocks /start (main-menu entry point)`, async () => {
        const { ctx, sink } = makeCtx({ chatType, text: "/start" });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(sink).toHaveLength(0);
      });

      it(`${chatType} chat: blocks /search a product query`, async () => {
        const { ctx, sink } = makeCtx({ chatType, text: "/search mobile legends" });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(sink).toHaveLength(0);
      });

      it(`${chatType} chat: blocks /listproduk@TestBot (bot-username-suffixed command)`, async () => {
        const { ctx, sink } = makeCtx({ chatType, text: "/listproduk@TestBot" });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(sink).toHaveLength(0);
      });
    }
  });

  describe("non-commerce commands stay usable everywhere", () => {
    for (const chatType of [...NON_PRIVATE_TYPES, "private" as const]) {
      it(`${chatType} chat: /faq (informational) passes through to next()`, async () => {
        const { ctx } = makeCtx({ chatType, text: "/faq" });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).toHaveBeenCalledTimes(1);
      });

      it(`${chatType} chat: /language (settings, non-commerce) passes through to next()`, async () => {
        const { ctx } = makeCtx({ chatType, text: "/language" });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).toHaveBeenCalledTimes(1);
      });
    }
  });

  it("a plain text message (no command, no callback) in a group passes through untouched", async () => {
    const { ctx } = makeCtx({ chatType: "group", text: "hello there" });
    const next = vi.fn(async () => {});
    await commerceGate(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // Phase D final whole-branch review, Important #1: the bot's third input
  // channel — plain text, routed by main.ts's message:text handler into
  // customer.handleProductNumber — was entirely unguarded, so a group chat
  // could still reach browse/wallet/orders/tickets/referral and a typed
  // catalog number even though commands and callbacks were blocked.
  describe("commerce-surface typed text (persistent-keyboard labels + catalog numbers)", () => {
    it("private chat: a persistent-label tap (English 'Browse') passes through to next()", async () => {
      const { ctx } = makeCtx({ chatType: "private", text: ckb.persistentLabel("browse", "en") });
      const next = vi.fn(async () => {});
      await commerceGate(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    for (const chatType of NON_PRIVATE_TYPES) {
      it(`${chatType} chat: blocks the "Browse" persistent-label text — never calls next(), never replies`, async () => {
        const { ctx, sink } = makeCtx({ chatType, text: ckb.persistentLabel("browse", "en") });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(sink).toHaveLength(0);
      });

      it(`${chatType} chat: blocks the "Wallet" persistent-label text (would render a balance into the group)`, async () => {
        const { ctx, sink } = makeCtx({ chatType, text: ckb.persistentLabel("wallet", "en") });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(sink).toHaveLength(0);
      });

      it(`${chatType} chat: blocks an Indonesian-language persistent-label text ("Pesanan Saya")`, async () => {
        const { ctx, sink } = makeCtx({ chatType, text: ckb.persistentLabel("orders", "id") });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(sink).toHaveLength(0);
      });

      it(`${chatType} chat: blocks a bare 1-4 digit catalog-number reply ("3")`, async () => {
        const { ctx, sink } = makeCtx({ chatType, text: "3" });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(sink).toHaveLength(0);
      });

      it(`${chatType} chat: blocks a 4-digit catalog-number reply ("1234")`, async () => {
        const { ctx, sink } = makeCtx({ chatType, text: "1234" });
        const next = vi.fn(async () => {});
        await commerceGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(sink).toHaveLength(0);
      });
    }

    it("a 5-digit string (too long to be a catalog number) is not treated as commerce text and passes through", async () => {
      const { ctx } = makeCtx({ chatType: "group", text: "12345" });
      const next = vi.fn(async () => {});
      await commerceGate(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("free text that happens to start with digits but isn't a bare number still passes through (e.g. a support message)", async () => {
      const { ctx } = makeCtx({ chatType: "group", text: "3 items arrived damaged" });
      const next = vi.fn(async () => {});
      await commerceGate(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  it("my_chat_member status-change update in a non-private chat passes through (no command/callback to block)", async () => {
    const { ctx } = makeCtx({ chatType: "supergroup", myChatMember: true });
    const next = vi.fn(async () => {});
    await commerceGate(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
