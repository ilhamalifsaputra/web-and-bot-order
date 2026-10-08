// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import {
  prisma,
  createBybitBscOrder,
  deliverPaidBybitBscOrder,
  setOrderPaymentMessage,
  adoptTransactionMessage,
  setSetting,
  deleteSetting,
} from "@app/db";
import { OrderStatus, StockStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { FulfillmentMessageWorker } from "../../../packages/outbox-dispatcher/src/fulfillmentMessages";
import {
  computeConfirmations,
  fetchConfirmations,
  pollOnce,
  MAX_CONSECUTIVE_LOOKUP_FAILURES,
  MAX_ORDERS_PER_CYCLE,
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
    createBybitBscOrder(tx, { channel: "bot", user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1, rate: 1 }),
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

  it("bounds each BscScan RPC call so a hung explorer cannot stall the tracker forever", async () => {
    const fetchMock = mockTwoCalls("0x70", { blockNumber: "0x65" });
    await fetchConfirmations("0xabc", cfg);
    expect(fetchMock).toHaveBeenCalledTimes(2); // eth_blockNumber + eth_getTransactionByHash
    for (const call of fetchMock.mock.calls) {
      const init = (call as unknown[])[1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  // Minor 5 (Task 3 review follow-up): bscscanRpc previously had no try/catch
  // at all, so a rejected fetch() reached pollOnce's `logger.error({ err })`
  // raw — same M-15 shape as TokoPay/PayDisini's query-string credentials,
  // just on the (low-severity, optional, read-only-rate-limit) BscScan key.
  it("rethrows a brand-new, cause-free error instead of the raw (query-string-bearing) rejection", async () => {
    const cfgWithKey = { apiBase: "https://api.bscscan.com/api", apiKey: "LEAKED-BSCSCAN-KEY" };
    const original = Object.assign(new Error("fetch failed"), {
      cause: { request: { url: "https://api.bscscan.com/api?...&apikey=LEAKED-BSCSCAN-KEY" } },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(original));
    let caught: unknown;
    try {
      await fetchConfirmations("0xabc", cfgWithKey);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(original);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).message).not.toContain("LEAKED-BSCSCAN-KEY");
    expect((caught as Error).message).toMatch(/network error/);
  });

  it("distinguishes a timeout from a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })),
    );
    await expect(fetchConfirmations("0xabc", cfg)).rejects.toThrow(/timed out/);
  });

  // AbortSignal.timeout stays attached to the response body in undici
  // (http.ts), so a peer that sends headers and then stalls the body makes
  // res.json() reject with this same TimeoutError shape — a DIFFERENT case
  // from the fetch()-level timeout above (that one never gets a response at
  // all). Must not be reported as "unparseable" — that would tell the tracker
  // the explorer sent back garbage, when it actually just hung.
  it("reports a response-body-read timeout distinctly from a genuinely unparseable response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
        },
        text: async () => "",
      }),
    );
    let caught: unknown;
    try {
      await fetchConfirmations("0xabc", cfg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/timed out/);
    expect((caught as Error).message).not.toMatch(/unparseable/);
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

  it("persists confirmations and lets the coordinator update the adopted bubble", async () => {
    const order = await makeTrackedOrder("0x" + "8".repeat(64));
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    await adoptTransactionMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApiWithEdits();
    mockChain("0x65", "0x65"); // 1 confirmation
    await pollOnce(api);

    expect(edits).toHaveLength(0);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: OrderStatus.CONFIRMING, confirmations: 1, paymentMsgChatId: 555n, paymentMsgId: 777,
    });
    expect(await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({
      state: "ACTIVE", messageId: 777,
    });
    await new FulfillmentMessageWorker(api).tick(order.id);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.chatId).toBe("555");
    expect(edits[0]!.messageId).toBe(777);
    expect(edits[0]!.text).toContain("Confirming payment");
    expect(edits[0]!.text).toContain("35%");
  });

  it("updates durable confirmation counts without a second rail writer or fabricated progress", async () => {
    const order = await makeTrackedOrder("0x" + "9".repeat(64));
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    await adoptTransactionMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApiWithEdits();

    mockChain("0x65", "0x65"); // 1 confirmation -> PAYMENT_DETECTED -> CONFIRMING
    await pollOnce(api);
    expect(edits).toHaveLength(0);
    await new FulfillmentMessageWorker(api).tick(order.id);
    mockChain("0x66", "0x65"); // 2 confirmations -> still CONFIRMING, no status change
    await pollOnce(api);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.messageId).toBe(777);
    expect(edits[0]!.text).toContain("35%");
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: OrderStatus.CONFIRMING, confirmations: 2, paymentMsgChatId: 555n, paymentMsgId: 777,
    });
    expect(await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({
      state: "ACTIVE", messageId: 777, phase: "VERIFYING",
    });
  });

  it("a tx-not-found cycle does not change status or escalate before the grace period is exhausted", async () => {
    const order = await makeTrackedOrder("0x" + "4".repeat(64));
    mockChain("0x65", null); // not found yet
    for (let i = 0; i < MAX_CONSECUTIVE_LOOKUP_FAILURES - 1; i++) await pollOnce(fakeApi);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe(OrderStatus.PAYMENT_DETECTED); // unchanged
  });

  it("marks tracking stale (NOT FAILED) once the not-found grace period is exhausted, and enqueues an admin alert via the outbox (M-11 fix)", async () => {
    const txId = "0x" + "5".repeat(64);
    const order = await makeTrackedOrder(txId);
    mockChain("0x65", null);
    for (let i = 0; i < MAX_CONSECUTIVE_LOOKUP_FAILURES; i++) await pollOnce(fakeApi);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    // Non-terminal: the order stays exactly where the tracker last left it
    // (PAYMENT_DETECTED here, since fetchConfirmations never once succeeded),
    // NOT FAILED — that used to permanently block a later genuine Bybit
    // "Success" report from auto-delivering (M-11, backend audit 2026-07-31).
    expect(updated.status).toBe(OrderStatus.PAYMENT_DETECTED);
    expect(updated.trackingStaleAt).not.toBeNull();
    const alertRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: "ORDER_PIPELINE_FAILED" },
    });
    expect(alertRows.length).toBeGreaterThan(0);
  });

  it("does not re-enqueue a second admin alert on further not-found cycles once already marked stale", async () => {
    const order = await makeTrackedOrder("0x" + "5".repeat(64));
    mockChain("0x65", null);
    for (let i = 0; i < MAX_CONSECUTIVE_LOOKUP_FAILURES; i++) await pollOnce(fakeApi);
    const afterFirstEscalation = await prisma.notificationOutbox.count({
      where: { orderId: order.id, event: "ORDER_PIPELINE_FAILED" },
    });
    // enqueueOrderPipelineFailed fans out one row per resolved admin (2 in
    // this test env, ADMIN_IDS="999,1000") — that's one alert EPISODE, not
    // two. Confirm the baseline, then prove further not-found cycles don't
    // add any more rows on top of it.
    expect(afterFirstEscalation).toBe(2);

    // Several more not-found cycles past the grace period.
    for (let i = 0; i < 15; i++) await pollOnce(fakeApi);
    const alertRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: "ORDER_PIPELINE_FAILED" },
    });
    expect(alertRows).toHaveLength(afterFirstEscalation);
  });

  it("recovers full delivery after tracking went stale, once Bybit later reports genuine success (M-11 fix)", async () => {
    const txId = "0x" + "7".repeat(64);
    const order = await makeTrackedOrder(txId);

    // The explorer never finds the tx for MAX_CONSECUTIVE_LOOKUP_FAILURES
    // consecutive cycles — tracking is flagged stale, but the order must
    // stay in a state deliverPaidBybitBscOrder can still act on.
    mockChain("0x65", null);
    for (let i = 0; i < MAX_CONSECUTIVE_LOOKUP_FAILURES; i++) await pollOnce(fakeApi);
    const staled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(staled.status).toBe(OrderStatus.PAYMENT_DETECTED);
    expect(staled.trackingStaleAt).not.toBeNull();

    // Bybit's own API now genuinely reports the deposit as Success (status
    // 3) — the deposit poller's real delivery path, independent of this
    // flaky explorer. Before the M-11 fix this claimed the idempotency slot
    // and immediately returned "stale" because FAILED wasn't in
    // PRE_DELIVERY_STATUSES.
    const result = await deliverPaidBybitBscOrder(prisma, {
      orderId: order.id,
      bybitTxId: txId,
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");
    const delivered = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(delivered.status).toBe(OrderStatus.DELIVERED);
  });

  it("forgets the lookup-failure count for an order that leaves the tracked set", async () => {
    const order = await makeTrackedOrder("0x" + "a".repeat(64));
    mockChain("0x65", null); // tx not found every cycle

    // Accumulate failures right up to the edge of escalating, but stop short.
    for (let i = 0; i < MAX_CONSECUTIVE_LOOKUP_FAILURES - 1; i++) await pollOnce(fakeApi);
    let updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.trackingStaleAt).toBeNull(); // not escalated yet

    // Order leaves the tracked set through another path (delivered/cancelled/
    // expired) — simulated by flipping its status away from
    // PAYMENT_DETECTED/CONFIRMING while its bybitTxid stays set.
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
    await pollOnce(fakeApi); // this order is absent from listTrackedBybitBscOrders this cycle

    // ...then it re-enters the tracked set (still has bybitTxid from before).
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PAYMENT_DETECTED } });

    // If the old failure count survived the gap, this single cycle would be
    // the Nth consecutive failure and escalate immediately. It must not: a
    // re-tracked order's grace period starts over from zero.
    await pollOnce(fakeApi);
    updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.trackingStaleAt).toBeNull();
    expect(updated.status).toBe(OrderStatus.PAYMENT_DETECTED);
  });

  it("is a no-op with no tracked orders (no fetch call at all)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await pollOnce(fakeApi);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Important #3 (Task 3 review follow-up): pollOnce now caps how many
  // tracked orders one cycle inspects (MAX_ORDERS_PER_CYCLE), rotating the
  // starting point each cycle so a backlog larger than the cap still gets
  // full coverage over a few cycles instead of starving the same tail-end
  // orders forever. cycleCursor is module state shared with every earlier
  // test in this file, so this asserts the size of the covered set (true
  // regardless of the cursor's leftover position from prior tests), not
  // which specific orders land in the first batch.
  it("caps one cycle at MAX_ORDERS_PER_CYCLE orders, then covers the rest on a later cycle", async () => {
    const total = MAX_ORDERS_PER_CYCLE + 2;
    // makeTrackedOrder consumes one stock unit per call — buildSampleData's
    // default product only stocks enough for the other tests in this file,
    // so top it up before creating `total` tracked orders in one test.
    await prisma.stockItem.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        productId: sample.product.id,
        credentials: `bsc-tracker-cap-${i}@x.com:pw`,
        status: StockStatus.AVAILABLE,
      })),
    });
    for (let i = 0; i < total; i++) {
      await makeTrackedOrder("0x" + String(i).padStart(64, "0"));
    }
    const seenTxHashes = new Set<string>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("eth_blockNumber")) return Promise.resolve(rpc("0x65"));
        const match = /txhash=([^&]+)/.exec(url);
        if (match?.[1]) seenTxHashes.add(decodeURIComponent(match[1]));
        return Promise.resolve(rpc({ blockNumber: "0x65" }));
      }),
    );

    await pollOnce(fakeApi);
    expect(seenTxHashes.size).toBe(MAX_ORDERS_PER_CYCLE); // never all `total` in one cycle

    await pollOnce(fakeApi); // the rotating window's next slice picks up the rest
    expect(seenTxHashes.size).toBe(total); // full coverage within ceil(total / MAX_ORDERS_PER_CYCLE) = 2 cycles
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
