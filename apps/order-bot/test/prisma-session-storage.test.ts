// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@app/db";
import { BotState, initialSession, type SessionData } from "../src/context";
import { prismaSessionStorage, classifySessionKind, NAV_TTL_MS, CHECKOUT_TTL_MS } from "../src/util/prismaSessionStorage";

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.botSession.deleteMany();
});

const navSession = (): SessionData => ({ ...initialSession(), state: BotState.PRODUCT_LIST });

// ===========================================================================
// classifySessionKind — the TTL-split decision
// ===========================================================================

describe("classifySessionKind", () => {
  it("a freshly-initialized session (just browsing) classifies as nav", () => {
    expect(classifySessionKind(initialSession())).toBe("nav");
  });

  it("a session with only nav bookkeeping set (menuMsgId, state) still classifies as nav", () => {
    const s = navSession();
    s.menuMsgId = 555;
    expect(classifySessionKind(s)).toBe("nav");
  });

  it.each([
    ["paymentAnchorMsgId", { paymentAnchorMsgId: 1 }],
    ["qrMsgId", { qrMsgId: 2 }],
    ["awaitingQtyDenomId", { awaitingQtyDenomId: 3 }],
    ["awaitingTopupCurrency", { awaitingTopupCurrency: "IDR" as const }],
  ])("a session with %s set classifies as checkout", (_name, patch) => {
    const s: SessionData = { ...initialSession(), ...patch };
    expect(classifySessionKind(s)).toBe("checkout");
  });

  it.each([
    ["pendingInfoProductId", { pendingInfoProductId: 10 }],
    ["pendingInfoQuantity", { pendingInfoQuantity: 2 }],
    ["editInfoOrderId", { editInfoOrderId: 99 }],
    ["appliedVoucherCode", { appliedVoucherCode: "SAVE10" }],
    ["customerData", { customerData: '[{"game_id":"1"}]' }],
    ["useWalletIdr", { useWalletIdr: true }],
    ["useWalletUsdt", { useWalletUsdt: true }],
  ])("a session with scratch.%s set classifies as checkout", (_name, scratchPatch) => {
    const s: SessionData = { ...initialSession(), scratch: { ...scratchPatch } };
    expect(classifySessionKind(s)).toBe("checkout");
  });

  it("scratch fields unrelated to checkout (e.g. a stray key) do NOT trigger checkout classification", () => {
    const s: SessionData = { ...initialSession(), scratch: { someUnrelatedKey: "x" } };
    expect(classifySessionKind(s)).toBe("nav");
  });
});

// ===========================================================================
// The adapter itself — real StorageAdapter<SessionData> contract, backed by
// the real Prisma-provisioned test schema (not a mock/in-memory stand-in).
// ===========================================================================

describe("prismaSessionStorage — read/write/delete contract", () => {
  it("read() returns undefined for a key that was never written", async () => {
    const storage = prismaSessionStorage();
    expect(await storage.read("chat:1")).toBeUndefined();
  });

  it("write() then read() round-trips the session value", async () => {
    const storage = prismaSessionStorage();
    const value = navSession();
    await storage.write("chat:2", value);
    const read = await storage.read("chat:2");
    expect(read).toEqual(value);
  });

  it("the round trip is a REAL serialization boundary, not an in-memory reference: mutating the original object after write() does not affect what read() returns", async () => {
    const storage = prismaSessionStorage();
    const value = navSession();
    await storage.write("chat:3", value);
    // Mutate the object that was handed to write() — a Map-backed adapter
    // (the old boundedSessionStorage) would still hold this exact reference,
    // so read() would come back mutated too. Through the real Postgres-backed
    // adapter, the row was JSON-encoded at write time, so this mutation is
    // invisible to a later read().
    value.menuMsgId = 999999;
    const read = await storage.read("chat:3");
    expect(read?.menuMsgId).not.toBe(999999);
  });

  it("delete() removes the key", async () => {
    const storage = prismaSessionStorage();
    await storage.write("chat:4", navSession());
    await storage.delete("chat:4");
    expect(await storage.read("chat:4")).toBeUndefined();
  });

  it("write() persists a plain object indistinguishable in shape from the input (a Prisma round trip through JSON, not a class instance)", async () => {
    const storage = prismaSessionStorage();
    await storage.write("chat:5", navSession());
    const read = await storage.read("chat:5");
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
  });
});

// ===========================================================================
// TTL split — 24h nav / 15min checkout, stamped on every write()
// ===========================================================================

describe("prismaSessionStorage — TTL split", () => {
  it("a nav-only session is written with the 24h TTL and kind='nav'", async () => {
    const storage = prismaSessionStorage();
    const before = Date.now();
    await storage.write("chat:nav", navSession());
    const row = await prisma.botSession.findUnique({ where: { key: "chat:nav" } });
    expect(row?.kind).toBe("nav");
    const delta = row!.expiresAt.getTime() - before;
    // Generous tolerance for test-run wall-clock slop, but tight enough to
    // prove this is NAV_TTL_MS and not, say, CHECKOUT_TTL_MS or some other value.
    expect(delta).toBeGreaterThan(NAV_TTL_MS - 5_000);
    expect(delta).toBeLessThan(NAV_TTL_MS + 5_000);
  });

  it("a session with an active checkout draft is written with the 15min TTL and kind='checkout'", async () => {
    const storage = prismaSessionStorage();
    const checkoutSession: SessionData = { ...initialSession(), paymentAnchorMsgId: 777 };
    const before = Date.now();
    await storage.write("chat:checkout", checkoutSession);
    const row = await prisma.botSession.findUnique({ where: { key: "chat:checkout" } });
    expect(row?.kind).toBe("checkout");
    const delta = row!.expiresAt.getTime() - before;
    expect(delta).toBeGreaterThan(CHECKOUT_TTL_MS - 5_000);
    expect(delta).toBeLessThan(CHECKOUT_TTL_MS + 5_000);
  });

  it("a session that transitions from checkout back to nav (e.g. the draft completed/was abandoned) gets re-classified and re-stamped on the NEXT write, not stuck on its earlier TTL", async () => {
    const storage = prismaSessionStorage();
    const checkoutSession: SessionData = { ...initialSession(), paymentAnchorMsgId: 1 };
    await storage.write("chat:transition", checkoutSession);
    let row = await prisma.botSession.findUnique({ where: { key: "chat:transition" } });
    expect(row?.kind).toBe("checkout");

    const navAgain: SessionData = { ...initialSession() }; // paymentAnchorMsgId cleared
    await storage.write("chat:transition", navAgain);
    row = await prisma.botSession.findUnique({ where: { key: "chat:transition" } });
    expect(row?.kind).toBe("nav");
  });

  // Real Prisma-backed TTL-expiry test (not a mock): can't wait a genuine 15
  // minutes/24 hours in a test, so this backdates the persisted row's
  // expiresAt the same way packages/db/src/crud/telegramUpdates.test.ts's
  // own prune-cutoff test does, then proves the ADAPTER's read() — the exact
  // path session() calls on every update — treats it as gone, through the
  // real database round trip (readBotSession's own expiry check), not a
  // stubbed clock or an in-memory TTL simulation.
  it("a session key's data is gone (adapter read() returns undefined) after its configured window has passed", async () => {
    const storage = prismaSessionStorage();
    const checkoutSession: SessionData = { ...initialSession(), qrMsgId: 42 };
    await storage.write("chat:expired", checkoutSession);
    expect(await storage.read("chat:expired")).toEqual(checkoutSession); // still live immediately after write

    // Backdate the row as if CHECKOUT_TTL_MS had genuinely elapsed.
    await prisma.botSession.update({
      where: { key: "chat:expired" },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await storage.read("chat:expired")).toBeUndefined();
    // And the expired row was actually removed, not just masked — confirms
    // the adapter's read() reaches all the way through to the real lazy-
    // delete in readBotSession, not a shortcut that only checks the row exists.
    expect(await prisma.botSession.findUnique({ where: { key: "chat:expired" } })).toBeNull();
  });

  it("a nav session's longer TTL means it is still readable at a point in time a checkout session's TTL would already have expired", async () => {
    const storage = prismaSessionStorage();
    await storage.write("chat:longlived", navSession());
    // Simulate CHECKOUT_TTL_MS having elapsed (but not NAV_TTL_MS) by
    // backdating the write instant, same technique as above.
    await prisma.botSession.update({
      where: { key: "chat:longlived" },
      data: { expiresAt: new Date(Date.now() + NAV_TTL_MS - CHECKOUT_TTL_MS - 1_000) },
    });
    expect(await storage.read("chat:longlived")).not.toBeUndefined();
  });
});
