// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import {
  prisma,
  createBybitBscOrder,
  setOrderPaymentMessage,
  setSetting,
  deleteSetting,
} from "@app/db";
import { OrderStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import {
  computeConfirmations,
  fetchConfirmations,
  pollOnce,
  MAX_CONSECUTIVE_LOOKUP_FAILURES,
} from "../src/payments/bybitBscConfirmationTracker";

let sample: SampleData;
const fakeApi = {} as Api; // most tests below never anchor a paymentMsgId, so pushTrackingUpdate's early-return means editMessageText is never actually called

function fakeApiWithEdits() {
  const edits: Array<{ chatId: number | string; messageId: number; text: string }> = [];
  const api = {
    editMessageText: async (chatId: number | string, messageId: number, text: string) => {
      edits.push({ chatId, messageId, text });
      return {};
    },
  } as unknown as Api;
  return { api, edits };
}

beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const makeTrackedOrder = async (txId: string) => {
  const order = (await prisma.$transaction((tx) =>
    createBybitBscOrder(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1, rate: 1 }),
  ))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { status: OrderStatus.PAYMENT_DETECTED, bybitTxid: txId, firstDetectedAt: new Date() },
  });
  return order;
};

// ===========================================================================
// computeConfirmations — pure function
// ===========================================================================

describe("computeConfirmations", () => {
  it("a tx mined in the latest block itself counts as 1 confirmation", () => {
    expect(computeConfirmations(100, 100)).toBe(1);
  });

  it("counts the block depth + 1", () => {
    expect(computeConfirmations(115, 100)).toBe(16);
  });

  it("returns null when the tx has no block yet (not found / still pending)", () => {
    expect(computeConfirmations(100, null)).toBeNull();
  });

  it("never returns negative confirmations (clamped at 0) for a stale/out-of-order read", () => {
    expect(computeConfirmations(99, 100)).toBe(0);
  });
});

// ===========================================================================
// fetchConfirmations — mocked BscScan "proxy" responses
// ===========================================================================

describe("fetchConfirmations", () => {
  const cfg = { apiBase: "https://api.bscscan.com/api", apiKey: "" };
  const rpc = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) }) as Response;

  function mockTwoCalls(blockNumberResult: unknown, txResult: unknown) {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("eth_blockNumber")) return Promise.resolve(rpc(blockNumberResult));
      if (url.includes("eth_getTransactionByHash")) return Promise.resolve(rpc(txResult));
      throw new Error(`unexpected BscScan call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("computes confirmations from the latest block + the tx's own block", async () => {
    mockTwoCalls("0x70", { blockNumber: "0x65" }); // latest=112, tx=101 -> 12 confirmations
    expect(await fetchConfirmations("0xabc", cfg)).toBe(12);
  });

  it("returns null when the tx isn't found at all (result: null)", async () => {
    mockTwoCalls("0x70", null);
    expect(await fetchConfirmations("0xabc", cfg)).toBeNull();
  });

  it("returns null when the tx is known but not yet mined (blockNumber: null)", async () => {
    mockTwoCalls("0x70", { blockNumber: null });
    expect(await fetchConfirmations("0xabc", cfg)).toBeNull();
  });

  it("throws on an HTTP 429 instead of returning null (rate limit is not 'not found')", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" } as Response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchConfirmations("0xabc", cfg)).rejects.toThrow(/rate limited/i);
  });
});

// ===========================================================================
// pollOnce — integration against the real test DB
// ===========================================================================

describe("pollOnce (confirmation tracker poll loop)", () => {
  const rpc = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) }) as Response;
  function mockChain(latestBlockHex: string, txBlockHex: string | null) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("eth_blockNumber")) return Promise.resolve(rpc(latestBlockHex));
        return Promise.resolve(rpc(txBlockHex == null ? null : { blockNumber: txBlockHex }));
      }),
    );
  }

  it("bumps confirmations and transitions PAYMENT_DETECTED -> CONFIRMING on the first confirmation", async () => {
    const order = await makeTrackedOrder("0x" + "1".repeat(64));
    mockChain("0x65", "0x65"); // latest == tx block -> 1 confirmation
    await pollOnce(fakeApi);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe(OrderStatus.CONFIRMING);
    expect(updated.confirmations).toBe(1);
  });

  it("transitions CONFIRMING -> CONFIRMED once confirmations reach the configured threshold", async () => {
    await setSetting(prisma, "bybit_bsc_required_confirmations", "3");
    const order = await makeTrackedOrder("0x" + "2".repeat(64));
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMING, confirmations: 1 } });
    mockChain("0x67", "0x65"); // latest - tx + 1 = 3 confirmations
    await pollOnce(fakeApi);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe(OrderStatus.CONFIRMED);
    expect(updated.confirmedAt).not.toBeNull();
    await deleteSetting(prisma, "bybit_bsc_required_confirmations");
  });

  it("never calls approveOrder/delivers — stays CONFIRMED, not DELIVERED, however high confirmations go", async () => {
    const order = await makeTrackedOrder("0x" + "3".repeat(64));
    mockChain("0x100000", "0x1"); // an absurdly large confirmation count
    await pollOnce(fakeApi);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe(OrderStatus.CONFIRMED);
    expect(updated.deliveredAt).toBeNull();
  });

  it("pushes the live tracking screen to the anchored bubble with the fresh confirmation count", async () => {
    const order = await makeTrackedOrder("0x" + "8".repeat(64));
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApiWithEdits();
    mockChain("0x65", "0x65"); // 1 confirmation
    await pollOnce(api);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.chatId).toBe(555);
    expect(edits[0]!.messageId).toBe(777);
    expect(edits[0]!.text).toContain("1/15");
  });

  it("keeps pushing on every successful tick, not just on a status transition (the count visibly climbs)", async () => {
    const order = await makeTrackedOrder("0x" + "9".repeat(64));
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApiWithEdits();

    mockChain("0x65", "0x65"); // 1 confirmation -> PAYMENT_DETECTED -> CONFIRMING
    await pollOnce(api);
    mockChain("0x66", "0x65"); // 2 confirmations -> still CONFIRMING, no status change
    await pollOnce(api);

    expect(edits).toHaveLength(2);
    expect(edits[0]!.text).toContain("1/15");
    expect(edits[1]!.text).toContain("2/15");
  });

  it("a tx-not-found cycle does not change status or escalate before the grace period is exhausted", async () => {
    const order = await makeTrackedOrder("0x" + "4".repeat(64));
    mockChain("0x65", null); // not found yet
    for (let i = 0; i < MAX_CONSECUTIVE_LOOKUP_FAILURES - 1; i++) await pollOnce(fakeApi);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe(OrderStatus.PAYMENT_DETECTED); // unchanged
  });

  it("escalates to FAILED once the not-found grace period is exhausted, and enqueues an admin alert via the outbox", async () => {
    const order = await makeTrackedOrder("0x" + "5".repeat(64));
    mockChain("0x65", null);
    for (let i = 0; i < MAX_CONSECUTIVE_LOOKUP_FAILURES; i++) await pollOnce(fakeApi);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe(OrderStatus.FAILED);
    const failedRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: "ORDER_PIPELINE_FAILED" },
    });
    expect(failedRows.length).toBeGreaterThan(0);
  });

  it("is a no-op with no tracked orders (no fetch call at all)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await pollOnce(fakeApi);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // MUST run last in this file: a rate-limit hit arms the module-level
  // backoff gate for several real seconds (Date.now()-based, not mocked) —
  // any test running after this one within the same file would have its own
  // pollOnce calls silently skipped by `backoff.shouldSkip()` before ever
  // reaching the orders it's trying to exercise.
  it("a rate-limited cycle leaves the order untouched and does not count toward the not-found grace period", async () => {
    const order = await makeTrackedOrder("0x" + "6".repeat(64));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "" } as Response));
    for (let i = 0; i < MAX_CONSECUTIVE_LOOKUP_FAILURES + 2; i++) await pollOnce(fakeApi);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe(OrderStatus.PAYMENT_DETECTED); // never escalated, never bumped
    expect(updated.confirmations).toBeNull();
  });
});
