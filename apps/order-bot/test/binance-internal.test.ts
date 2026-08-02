// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createInternalOrder,
  deliverPaidInternalOrder,
  markUnderpaid,
  recordUnmatchedTx,
  dismissUnmatchedTx,
  listPendingInternalOrders,
  setOrderPaymentMessage,
  resolveBinanceInternalConfig,
  setSetting,
  deleteSetting,
  BINANCE_UID_KEY,
  BINANCE_API_KEY_KEY,
  BINANCE_API_SECRET_KEY,
  type BinanceInternalConfig,
} from "@app/db";
import type { Api } from "grammy";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { OrderStatus, PaymentMethod, StockStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import {
  classifyTx,
  noteMatches,
  matchByAmount,
  matchUnderpaidByAmount,
  normalizeTx,
  processTransfers,
  fetchIncomingTransfers,
  type BinanceTx,
} from "../src/payments/binanceInternal";
import { pollWatchdogDecision } from "../src/jobs";

afterEach(() => {
  vi.unstubAllGlobals();
});

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedBinanceTx.deleteMany(); // new table, not covered by resetDb
  sample = await buildSampleData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

// rate 1 keeps the USDT totals numerically equal to the fixture's central-IDR
// price ("5.00"), so the amount-matching assertions below stay exact.
const makeInternalOrder = (qty = 1) =>
  prisma.$transaction((tx) =>
    createInternalOrder(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: qty, rate: 1 }),
  );

// ===========================================================================
// Matching (pure)
// ===========================================================================

describe("classifyTx / noteMatches", () => {
  const order = { paymentRef: "BCC1BDDE6F", totalAmount: "5.0000" };

  it("matches note case-insensitively and trimmed", () => {
    expect(noteMatches({ note: " bcc1bdde6f " }, order)).toBe(true);
    expect(noteMatches({ note: "OTHER" }, order)).toBe(false);
    expect(noteMatches({ note: "x" }, { paymentRef: null })).toBe(false);
  });

  it("exact / within-tolerance / overpaid → match", () => {
    expect(classifyTx({ note: "BCC1BDDE6F", amount: 5.0 }, order)).toBe("match");
    expect(classifyTx({ note: "BCC1BDDE6F", amount: 5.0005 }, order)).toBe("match"); // within 0.001
    expect(classifyTx({ note: "BCC1BDDE6F", amount: 5.5 }, order)).toBe("match"); // overpaid
  });

  it("short beyond tolerance → underpaid", () => {
    expect(classifyTx({ note: "BCC1BDDE6F", amount: 4.5 }, order)).toBe("underpaid");
    expect(classifyTx({ note: "BCC1BDDE6F", amount: 4.9985 }, order)).toBe("underpaid");
  });

  it("wrong note → none (regardless of amount)", () => {
    expect(classifyTx({ note: "NOPE", amount: 5.0 }, order)).toBe("none");
  });
});

describe("normalizeTx (real pay/transactions payload shape)", () => {
  // Captured (redacted) from scripts/binance-probe.ts against the live account:
  // a real C2C transfer — note is EMPTY and orderId is Binance's OWN id.
  const real = {
    uid: "123", counterpartyId: "456", orderId: "434526121546129408",
    note: "", orderType: "C2C", transactionId: "P_A226WCUE7FH71115",
    transactionTime: 1780200000000, amount: "1", currency: "USDT",
    walletType: 1, totalPaymentFee: "0",
  };

  it("maps id/amount/currency and keeps note empty (no orderId leak)", () => {
    const tx = normalizeTx(real)!;
    expect(tx.txId).toBe("P_A226WCUE7FH71115");
    expect(tx.amount).toBe(1);
    expect(tx.currency).toBe("USDT");
    expect(tx.note).toBe(""); // Binance's orderId must NOT leak into note
  });

  it("uses a real memo when present (remark fallback, empty-string skipped)", () => {
    expect(normalizeTx({ ...real, note: "BCC1BDDE6F" })!.note).toBe("BCC1BDDE6F");
    expect(normalizeTx({ ...real, note: "  ", remark: "BCC1BDDE6F" })!.note).toBe("BCC1BDDE6F");
  });

  it("rejects non-received / malformed rows", () => {
    expect(normalizeTx({ ...real, amount: "0" })).toBeNull();
    expect(normalizeTx({ ...real, amount: "-5" })).toBeNull();
    expect(normalizeTx({ transactionId: "X" })).toBeNull(); // no amount
  });
});

describe("pollWatchdogDecision (poller stuck/recover logic)", () => {
  const now = 1_000_000_000_000;
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const FIVE_MIN = 5 * 60_000;

  it("alerts when stale and not yet alerted", () => {
    expect(pollWatchdogDecision({ lastRun: ago(10 * 60_000), backoffUntil: null }, false, now)).toBe("alert");
  });

  it("stays quiet when stale but already alerted (no spam)", () => {
    expect(pollWatchdogDecision({ lastRun: ago(10 * 60_000), backoffUntil: null }, true, now)).toBe("none");
  });

  it("recovers (re-arms) when healthy again after an alert", () => {
    expect(pollWatchdogDecision({ lastRun: ago(10_000), backoffUntil: null }, true, now)).toBe("recover");
  });

  it("stays quiet while intentionally backing off, even if stale", () => {
    expect(pollWatchdogDecision({ lastRun: ago(30 * 60_000), backoffUntil: ago(-60_000) }, false, now)).toBe("none");
  });

  it("fresh cycle within the window is healthy", () => {
    expect(pollWatchdogDecision({ lastRun: ago(FIVE_MIN - 1000), backoffUntil: null }, false, now)).toBe("none");
  });

  it("never-run poller (no lastRun) is treated as stale", () => {
    expect(pollWatchdogDecision({ lastRun: null, backoffUntil: null }, false, now)).toBe("alert");
  });

  // consecutiveFailures: catches a poller that keeps cycling on schedule
  // (lastRun stays fresh) but fails every single cycle — e.g. the destination
  // is network-blocked. Optional field, so callers without it (Binance, today)
  // keep the original stale-only behavior from the cases above.
  it("alerts on a fresh lastRun if consecutiveFailures has crossed the threshold", () => {
    expect(
      pollWatchdogDecision({ lastRun: ago(5_000), backoffUntil: null, consecutiveFailures: 3 }, false, now),
    ).toBe("alert");
  });

  it("stays quiet below the failure threshold even with a fresh lastRun", () => {
    expect(
      pollWatchdogDecision({ lastRun: ago(5_000), backoffUntil: null, consecutiveFailures: 2 }, false, now),
    ).toBe("none");
  });

  it("recovers once consecutiveFailures drops back below threshold", () => {
    expect(
      pollWatchdogDecision({ lastRun: ago(5_000), backoffUntil: null, consecutiveFailures: 0 }, true, now),
    ).toBe("recover");
  });

  it("a backoff window still suppresses the alert even while failing", () => {
    expect(
      pollWatchdogDecision(
        { lastRun: ago(5_000), backoffUntil: ago(-60_000), consecutiveFailures: 5 },
        false,
        now,
      ),
    ).toBe("none");
  });
});

describe("matchByAmount (note-less fallback, best fit + capped overpayment)", () => {
  // Distinct totals, unique-cents-style — the PRODUCTION configuration (both
  // Bybit rails hard-gate on USE_UNIQUE_CENTS specifically so every order's
  // total is distinct). All assertions below run against the FULL multi-order
  // array unless a test is specifically about a single-order scenario, so a
  // regression that only shows up with ≥2 distinct-total pending orders (like
  // the one a prior version of this fix shipped) can't hide behind
  // single-element fixtures.
  const orders = [
    { id: 1, totalAmount: "5.0000" },
    { id: 2, totalAmount: "7.5000" },
    { id: 3, totalAmount: "12.3400" },
  ];

  // THE regression test (Important #4, code-review follow-up): a payment
  // that exactly matches a PRICIER pending order must still match that order
  // — not get refused as "ambiguous" just because it also happens to clear a
  // cheaper order's threshold. An earlier version of this fix filtered on
  // "any candidate at or below the amount, refuse on ≥2" — which made every
  // order except the single cheapest pending one unmatchable the instant a
  // second, cheaper order existed. Best-fit (largest qualifying total) fixes
  // this: only a genuine TIE at the top refuses.
  it("matches the PRICIER of two distinct-total pending orders when paid exactly, not refused as ambiguous", () => {
    expect(matchByAmount({ amount: 7.5 }, orders)?.id).toBe(2); // exact for order 2, also clears order 1's cheaper threshold
    expect(matchByAmount({ amount: 12.3401 }, orders)?.id).toBe(3); // exact (within float tolerance) for order 3
  });

  // Overpayment (a buyer rounding up) is accepted, but only up to a cap — see
  // `overpaymentCap` in binanceInternal.ts. A modest overpay of the best-fit
  // (pricier) candidate still matches even with cheaper orders present.
  it("matches a modest overpay of the best-fit order, cheaper orders present", () => {
    expect(matchByAmount({ amount: 13 }, orders)?.id).toBe(3); // overpays order 3 by 0.66, well under its cap (~2.47)
  });

  // M-14 code-review follow-up (Critical #2): an unbounded overpayment
  // ceiling gives ZERO protection once only one order is pending — the
  // day-to-day state for a small shop. A wildly larger amount than any
  // pending order (an unrelated top-up, a mistyped transfer, a late payment
  // for an expired order) must NOT auto-attribute to whichever order happens
  // to be the best fit; it refuses (falls through to "unmatched") instead.
  it("refuses (does not auto-match) an amount far beyond the best-fit order's overpayment cap", () => {
    expect(matchByAmount({ amount: 99 }, orders)).toBeNull(); // best fit would be order 3 (12.34), but 99 blows its ~2.47 cap
    expect(matchByAmount({ amount: 20 }, [orders[2]!])).toBeNull(); // same, single-candidate case: 20 vs 12.34, cap ~2.47
  });

  it("refuses when no order's total the payment covers (genuinely underpaid on the amount check)", () => {
    expect(matchByAmount({ amount: 4.5 }, orders)).toBeNull(); // short of every order beyond tolerance
  });

  it("refuses on a genuine tie at the best-fit total, even with a cheaper non-tied order also present", () => {
    // Two orders tied at 10.0 plus an unrelated cheaper order at 5.0 — the
    // cheaper order must not interfere with tie detection at the top: it's
    // excluded from the max-total group, but the tie between the two 10.0s
    // still correctly refuses.
    const withTie = [
      { id: 1, totalAmount: "5.0000" },
      { id: 2, totalAmount: "10.0000" },
      { id: 3, totalAmount: "10.0000" },
    ];
    expect(matchByAmount({ amount: 10.0 }, withTie)).toBeNull();
  });

  it("refuses on a collision (all candidates tied) rather than guessing", () => {
    const dup = [{ id: 1, totalAmount: "5.0000" }, { id: 2, totalAmount: "5.0000" }];
    expect(matchByAmount({ amount: 5.0 }, dup)).toBeNull();
  });
});

describe("matchUnderpaidByAmount (mirrored short-side search for memo-less rails, floored)", () => {
  const orders = [
    { id: 1, totalAmount: "5.0000" },
    { id: 2, totalAmount: "7.5000" },
  ];

  it("returns the sole order the received amount falls short of beyond tolerance (well within the floor)", () => {
    expect(matchUnderpaidByAmount({ amount: 4.5 }, [orders[0]!])?.id).toBe(1); // 90% of expected
  });

  it("refuses within tolerance (that's a clean match, not underpaid)", () => {
    expect(matchUnderpaidByAmount({ amount: 4.9995 }, [orders[0]!])).toBeNull();
  });

  it("refuses on a collision — short of ≥2 candidates at once", () => {
    // 4.0 is short of BOTH orders' totals beyond tolerance — can't tell which
    // one the buyer was trying (and failing) to pay.
    expect(matchUnderpaidByAmount({ amount: 4.0 }, orders)).toBeNull();
  });

  it("refuses when the amount isn't short of anything (that's matchByAmount's job)", () => {
    expect(matchUnderpaidByAmount({ amount: 10 }, orders)).toBeNull();
  });

  // M-14 code-review follow-up (Critical #3): amount alone, with no memo,
  // can't confirm intent — a wholly unrelated tiny stray deposit against a
  // large pending order must NOT get attributed to it (that would flip the
  // order UNDERPAID, pulling it out of the matcher's own pending pool, and
  // orphan the buyer's real payment when it arrives later). The floor draws
  // the line: below 50% of the order's total, it's "not plausibly this
  // order", not "this order, badly underpaid".
  describe("floor (a deposit must be at least half the order's total to count as underpaid for it)", () => {
    const bigOrder = [{ id: 9, totalAmount: "500.0000" }];

    it("refuses a stray deposit well below the floor against a large pending order", () => {
      expect(matchUnderpaidByAmount({ amount: 50 }, bigOrder)).toBeNull(); // 10% of expected — dust, not underpaid
    });

    it("flags underpaid right at the floor boundary (inclusive)", () => {
      expect(matchUnderpaidByAmount({ amount: 250 }, bigOrder)?.id).toBe(9); // exactly 50%
    });

    it("refuses just below the floor boundary", () => {
      expect(matchUnderpaidByAmount({ amount: 249.99 }, bigOrder)).toBeNull(); // just under 50%
    });
  });
});

// ===========================================================================
// Order creation
// ===========================================================================

describe("createInternalOrder", () => {
  it("creates a BINANCE_INTERNAL order with a unique paymentRef and 15-min expiry", async () => {
    const order = await makeInternalOrder();
    expect(order).toBeTruthy();
    expect(order!.paymentMethod).toBe(PaymentMethod.BINANCE_INTERNAL);
    expect(order!.paymentRef).toMatch(/^[0-9A-F]{10}$/);
    expect(order!.status).toBe(OrderStatus.PENDING_PAYMENT);
    const minsToExpiry = (order!.expiresAt!.getTime() - Date.now()) / 60000;
    expect(minsToExpiry).toBeGreaterThan(13);
    expect(minsToExpiry).toBeLessThanOrEqual(15.1);
  });

  // Per-SKU delivery flows (dlv-task-5): createInternalOrder destructures
  // walletAmount/rate off args and spreads the rest into createOrderDirect, so
  // a manual_with_info checkout's collected answers must ride along untouched.
  it("forwards customerData verbatim onto the created order", async () => {
    const customerData = JSON.stringify([{ game_id: "GID-123" }]);
    const order = await prisma.$transaction((tx) =>
      createInternalOrder(tx, {
        user: { id: sample.user.id, role: sample.user.role },
        productId: sample.product.id,
        quantity: 1,
        rate: 1,
        customerData,
      }),
    );
    expect(order!.customerData).toBe(customerData);
  });

  it("leaves customerData null when the caller doesn't pass one (auto/manual checkout, unaffected)", async () => {
    const order = await makeInternalOrder();
    expect(order!.customerData).toBeNull();
  });
});

// ===========================================================================
// Idempotent delivery / underpaid / unmatched
// ===========================================================================

describe("deliverPaidInternalOrder (idempotency + delivery)", () => {
  it("delivers once and is idempotent on the same tx id", async () => {
    const order = await makeInternalOrder();
    const amount = order!.totalAmount;

    const first = await deliverPaidInternalOrder(prisma, { orderId: order!.id, binanceTxId: "TX-AAA", amount });
    expect(first.status).toBe("delivered");
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
    expect(await prisma.processedBinanceTx.count({ where: { binanceTxId: "TX-AAA" } })).toBe(1);

    // Same tx again → already processed, no second delivery.
    const second = await deliverPaidInternalOrder(prisma, { orderId: order!.id, binanceTxId: "TX-AAA", amount });
    expect(second.status).toBe("already_processed");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
  });

  it("returns 'stale' when a different tx targets an already-delivered order", async () => {
    const order = await makeInternalOrder();
    await deliverPaidInternalOrder(prisma, { orderId: order!.id, binanceTxId: "TX-1", amount: order!.totalAmount });
    const res = await deliverPaidInternalOrder(prisma, { orderId: order!.id, binanceTxId: "TX-2", amount: order!.totalAmount });
    expect(res.status).toBe("stale");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1); // not re-delivered
  });

  // H-3 (backend audit 2026-07-31): the ledger claim used to survive a failed
  // delivery transaction forever — every retry (poller cycle) hit the
  // binance_tx_id UNIQUE constraint and was turned away as already_processed,
  // silently losing the buyer's payment. Wiping all stock for the product
  // forces settlePaidOrder's out-of-stock guard to throw INSIDE the delivery
  // $transaction, rolling it back (the real-world equivalent of a SQLITE_BUSY
  // collision or a transient failure mid-delivery).
  it("a claim whose delivery failed is retryable — a later call with the same tx id succeeds instead of already_processed", async () => {
    const order = await makeInternalOrder();

    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.DEAD } });

    await expect(
      deliverPaidInternalOrder(prisma, { orderId: order!.id, binanceTxId: "TX-retry-1", amount: order!.totalAmount }),
    ).rejects.toThrow();

    // The claim row survives the rollback, tagged delivery_failed — and the
    // order itself rolled all the way back to PENDING_PAYMENT, not stuck
    // mid-transition.
    const failedLedger = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "TX-retry-1" } });
    expect(failedLedger?.outcome).toBe("delivery_failed");
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Restock, then retry with the SAME tx id — this must now succeed
    // instead of hitting the UNIQUE constraint and returning already_processed.
    await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "retry-cred@example.com:pwd", status: StockStatus.AVAILABLE },
    });

    const retry = await deliverPaidInternalOrder(prisma, { orderId: order!.id, binanceTxId: "TX-retry-1", amount: order!.totalAmount });
    expect(retry.status).toBe("delivered");
    if (retry.status !== "delivered") throw new Error("expected delivered");
    expect(retry.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "TX-retry-1" } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order!.id);

    // Still exactly one ledger row — reclaimed in place, not duplicated.
    const rows = await prisma.processedBinanceTx.findMany({ where: { binanceTxId: "TX-retry-1" } });
    expect(rows.length).toBe(1);
  });
});

// ===========================================================================
// processTransfers — the poll-loop wiring (note + amount + underpaid + unmatched)
// ===========================================================================

describe("processTransfers (poll-loop wiring)", () => {
  // Fake grammY Api that records outbound messages instead of hitting Telegram.
  function fakeApi() {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const edits: Array<{ chatId: number | string; messageId: number; text: string; extra?: unknown }> = [];
    const api = {
      sendMessage: async (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return { message_id: 1 };
      },
      sendDocument: async () => ({ message_id: 1 }),
      editMessageText: async (chatId: number | string, messageId: number, text: string, extra?: unknown) => {
        edits.push({ chatId, messageId, text, extra });
        return {};
      },
    } as unknown as Api;
    return { api, sent, edits };
  }

  const pending = () => listPendingInternalOrders(prisma, new Date());
  const txFor = (over: Partial<BinanceTx> & { txId: string; amount: number }): BinanceTx => ({
    note: "", currency: "USDT", ...over,
  });

  it("flips the anchored payment bubble to the success message with paymentSuccessKb (§9.1)", async () => {
    const order = (await makeInternalOrder())!;
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T-FLIP", note: order.paymentRef!, amount: Number(order.totalAmount) })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.chatId).toBe(555);
    expect(edits[0]!.messageId).toBe(777);
    const markup = (edits[0]!.extra as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } })
      .reply_markup;
    const flat = (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    expect(flat).toContain("v1:browse:prods");
    expect(flat).toContain("v1:order:list");
  });

  it("delivers on a note match", async () => {
    const order = (await makeInternalOrder())!;
    const { api } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T1", note: order.paymentRef!, amount: Number(order.totalAmount) })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "T1" } }))!.outcome).toBe("matched");
  });

  it("delivers on the amount fallback when the note is empty AND USE_UNIQUE_CENTS is on", async () => {
    // The amount fallback is gated on USE_UNIQUE_CENTS (Payment-2 fix) — without
    // distinct totals it's a confused-deputy risk, so it's the one precondition
    // this test must hold for real (toggled here, not just env-defaulted).
    config.USE_UNIQUE_CENTS = true;
    try {
      const order = (await makeInternalOrder())!;
      const { api } = fakeApi();
      await processTransfers(api, [txFor({ txId: "T2", note: "", amount: Number(order.totalAmount) })], await pending());
      expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);
    } finally {
      config.USE_UNIQUE_CENTS = false;
    }
  });

  it("never attempts the amount fallback when USE_UNIQUE_CENTS is off — unmatched, not delivered", async () => {
    const order = (await makeInternalOrder())!; // unique-cents off in tests → no memo, no unique total
    const { api } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T2B", note: "", amount: Number(order.totalAmount) })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "T2B" } }))!.outcome).toBe("unmatched");
  });

  it("refuses the amount fallback on a collision (two equal-total orders) → unmatched", async () => {
    const a = (await makeInternalOrder())!;
    const b = (await makeInternalOrder())!; // unique-cents off in tests → equal totals
    expect(a.totalAmount).toEqual(b.totalAmount);
    const { api } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T3", note: "", amount: Number(a.totalAmount) })], await pending());
    expect((await prisma.order.findUnique({ where: { id: a.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.order.findUnique({ where: { id: b.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "T3" } }))!.outcome).toBe("unmatched");
  });

  it("flags underpaid (note match, short amount) and alerts admins", async () => {
    const order = (await makeInternalOrder())!;
    const { api, sent } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T4", note: order.paymentRef!, amount: Number(order.totalAmount) - 1 })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.UNDERPAID);
    expect(sent.some((m) => /[Uu]nderpaid/.test(m.text))).toBe(true);
  });
});

describe("markUnderpaid / recordUnmatchedTx", () => {
  it("markUnderpaid flags the order once (idempotent)", async () => {
    const order = await makeInternalOrder();
    const first = await markUnderpaid(prisma, { orderId: order!.id, binanceTxId: "TX-UP", amount: "1.00" });
    expect(first).toBe(true);
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.status).toBe(OrderStatus.UNDERPAID);
    const second = await markUnderpaid(prisma, { orderId: order!.id, binanceTxId: "TX-UP", amount: "1.00" });
    expect(second).toBe(false);
  });

  it("recordUnmatchedTx records once and dedupes", async () => {
    expect(await recordUnmatchedTx(prisma, { binanceTxId: "TX-UNM", amount: "9.99" })).toBe(true);
    expect(await recordUnmatchedTx(prisma, { binanceTxId: "TX-UNM", amount: "9.99" })).toBe(false);
    expect(await prisma.processedBinanceTx.count({ where: { binanceTxId: "TX-UNM", outcome: "unmatched" } })).toBe(1);
  });

  it("dismissUnmatchedTx flips an unmatched row to dismissed (kept, not deleted)", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "TX-DIS", amount: "1.00" });
    await dismissUnmatchedTx(prisma, "TX-DIS");
    const row = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "TX-DIS" } });
    expect(row!.outcome).toBe("dismissed");
  });

  it("dismissUnmatchedTx rejects a missing tx", async () => {
    await expect(dismissUnmatchedTx(prisma, "NOPE")).rejects.toThrow();
  });

  it("dismissUnmatchedTx refuses a non-unmatched row (e.g. matched)", async () => {
    const order = await makeInternalOrder();
    await deliverPaidInternalOrder(prisma, { orderId: order!.id, binanceTxId: "TX-MTCH", amount: order!.totalAmount });
    await expect(dismissUnmatchedTx(prisma, "TX-MTCH")).rejects.toThrow();
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "TX-MTCH" } }))!.outcome).toBe("matched");
  });
});

describe("fetchIncomingTransfers (connect-fallback escalation)", () => {
  const baseCfg: BinanceInternalConfig = {
    enabled: true,
    receiveUid: "u",
    apiKey: "k",
    apiSecret: "s",
    apiBase: "https://api.binance.com",
    apiBaseFallbacks: ["https://api1.binance.com", "https://api2.binance.com"],
    currency: "USDT",
    pollIntervalSeconds: 10,
    windowMinutes: 15,
    minAmount: null,
  };
  const okResponse = (data: unknown[] = []) => ({ ok: true, status: 200, json: async () => ({ data }) }) as Response;

  it("primary succeeds immediately — no fallback attempted, no behavior change", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchIncomingTransfers(baseCfg)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain("api.binance.com");
  });

  it("primary exhausts its retry budget, then the first fallback succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect fail 1"))
      .mockRejectedValueOnce(new Error("connect fail 2"))
      .mockRejectedValueOnce(new Error("connect fail 3"))
      .mockResolvedValueOnce(okResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchIncomingTransfers(baseCfg)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 3 primary attempts + 1st fallback
    expect(fetchMock.mock.calls[3]![0]).toContain("api1.binance.com");
  }, 15_000);

  it("primary + first fallback fail, second fallback succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("p1"))
      .mockRejectedValueOnce(new Error("p2"))
      .mockRejectedValueOnce(new Error("p3"))
      .mockRejectedValueOnce(new Error("m1 fail"))
      .mockResolvedValueOnce(okResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchIncomingTransfers(baseCfg)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[4]![0]).toContain("api2.binance.com");
  }, 15_000);

  it("all bases exhausted (primary + every fallback) throws the primary's error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("always fails"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchIncomingTransfers(baseCfg)).rejects.toThrow("always fails");
    expect(fetchMock).toHaveBeenCalledTimes(5); // 3 primary + 2 fallbacks (1 each)
  }, 15_000);

  it("empty fallback list behaves exactly like today — no fallback attempted, same error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect refused"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchIncomingTransfers({ ...baseCfg, apiBaseFallbacks: [] })).rejects.toThrow("connect refused");
    expect(fetchMock).toHaveBeenCalledTimes(3); // primary's retry budget only
  }, 15_000);
});

describe("resolveBinanceInternalConfig — minAmount", () => {
  const clear = () => Promise.all([
    deleteSetting(prisma, BINANCE_UID_KEY),
    deleteSetting(prisma, BINANCE_API_KEY_KEY),
    deleteSetting(prisma, BINANCE_API_SECRET_KEY),
    deleteSetting(prisma, "binance_internal_min_amount"),
  ]);

  it("defaults to null when unset", async () => {
    await clear();
    expect((await resolveBinanceInternalConfig(prisma)).minAmount).toBeNull();
  });

  it("parses a configured positive value", async () => {
    await clear();
    await setSetting(prisma, "binance_internal_min_amount", "7.5");
    expect((await resolveBinanceInternalConfig(prisma)).minAmount).toEqual(new Decimal("7.5"));
    await clear();
  });

  it("treats a non-numeric or non-positive value as null (never throws)", async () => {
    await clear();
    await setSetting(prisma, "binance_internal_min_amount", "garbage");
    expect((await resolveBinanceInternalConfig(prisma)).minAmount).toBeNull();
    await setSetting(prisma, "binance_internal_min_amount", "-1");
    expect((await resolveBinanceInternalConfig(prisma)).minAmount).toBeNull();
    await clear();
  });
});
