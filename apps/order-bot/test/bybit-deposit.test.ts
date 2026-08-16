// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createBybitOrder,
  createWalletTopupOrder,
  deliverPaidBybitOrder,
  markUnderpaidBybit,
  recordUnmatchedBybitTx,
  listPendingBybitOrders,
  resolveBybitConfig,
  getBybitPollHealth,
  setSetting,
  getSetting,
  deleteSetting,
  setOrderPaymentMessage,
  getUser,
  BYBIT_UID_KEY,
  BYBIT_API_KEY_KEY,
  BYBIT_API_SECRET_KEY,
  BYBIT_POLL_HEALTH_KEY,
} from "@app/db";
import type { Api } from "grammy";
import { telegramError } from "./helpers/ctx";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { OrderStatus, PaymentMethod, StockStatus, NotificationEvent } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { normalizeInternalDeposit, processDeposits, pollOnce, fetchRecentDeposits, type BybitDeposit } from "../src/payments/bybitDeposit";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedBybitTx.deleteMany(); // new table, not covered by resetDb
  sample = await buildSampleData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

// rate 1 keeps the USDT totals numerically equal to the fixture's central-IDR
// price ("5.00"), so the amount-matching assertions below stay exact.
const makeBybitOrder = (qty = 1) =>
  prisma.$transaction((tx) =>
    createBybitOrder(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: qty, rate: 1 }),
  );

// ===========================================================================
// normalizeInternalDeposit — Bybit /v5/asset/deposit/query-internal-record row shape
// ===========================================================================

describe("normalizeInternalDeposit (Bybit internal-deposit payload shape)", () => {
  // Realistic internal-deposit row (off-chain UID→UID transfer) per Bybit V5 docs.
  const real = {
    id: "9000000000000000001",
    txID: "9000000000000000001",
    coin: "USDT",
    amount: "746.99",
    status: 2, // 1=Processing, 2=Success, 3=Failed (DIFFERS from on-chain mapping)
    address: "uid:1234567",
    createdTime: "1700000000000",
  };

  it("maps a successful internal-transfer USDT deposit", () => {
    const d = normalizeInternalDeposit(real)!;
    expect(d.txId).toBe(real.txID);
    expect(d.amount.toString()).toBe("746.99");
  });

  it("accepts status 2 (Success) and rejects 1 (Processing) and 3 (Failed)", () => {
    expect(normalizeInternalDeposit({ ...real, status: 2 })).not.toBeNull();
    expect(normalizeInternalDeposit({ ...real, status: 1 })).toBeNull();
    expect(normalizeInternalDeposit({ ...real, status: 3 })).toBeNull();
  });

  it("rejects a non-USDT coin", () => {
    expect(normalizeInternalDeposit({ ...real, coin: "USDC" })).toBeNull();
  });

  it("has no chain filtering (internal transfers carry no chain)", () => {
    // A row with an arbitrary/absent chain field still maps successfully —
    // there is no chain parameter or chain filter for internal deposits.
    expect(normalizeInternalDeposit({ ...real, chain: "TRX" })).not.toBeNull();
    const { chain, ...withoutChain } = real as typeof real & { chain?: string };
    expect(normalizeInternalDeposit(withoutChain)).not.toBeNull();
  });

  it("rejects non-received / malformed rows", () => {
    expect(normalizeInternalDeposit({ ...real, amount: "0" })).toBeNull();
    expect(normalizeInternalDeposit({ ...real, amount: "-5" })).toBeNull();
    expect(normalizeInternalDeposit({ coin: "USDT", status: 2 })).toBeNull(); // no txID/amount
  });

  // Task 14: normalizeInternalDeposit now parses the raw amount string
  // directly with Decimal instead of Number(). `new Decimal("1,234.56")`
  // THROWS (unlike the old Number() -> NaN round-trip the guard turned into
  // a quiet skipped row) — a malformed gateway amount must stay a skipped
  // row, not become an exception escaping into the poll loop.
  it("rejects a malformed amount string instead of throwing", () => {
    expect(() => normalizeInternalDeposit({ ...real, amount: "1,234.56" })).not.toThrow();
    expect(normalizeInternalDeposit({ ...real, amount: "1,234.56" })).toBeNull();
  });

  // Task 14: preserves an amount with more precision than a double can
  // represent exactly (the whole point of parsing the raw string directly).
  it("preserves an amount with more precision than a double", () => {
    const precise = "746.00000000000001";
    expect(Number(precise).toString()).not.toBe(precise); // proves Number() really does truncate this
    expect(normalizeInternalDeposit({ ...real, amount: precise })!.amount.toString()).toBe(precise);
  });
});

// ===========================================================================
// Order creation
// ===========================================================================

describe("createBybitOrder", () => {
  it("creates a BYBIT order with an expiry and NO paymentRef (internal transfer has no memo)", async () => {
    const order = await makeBybitOrder();
    expect(order).toBeTruthy();
    expect(order!.paymentMethod).toBe(PaymentMethod.BYBIT);
    expect(order!.paymentRef).toBeNull();
    expect(order!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order!.expiresAt).not.toBeNull();
    expect(order!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  // Per-SKU delivery flows (dlv-task-5): createBybitOrder destructures
  // walletAmount/rate off args and spreads the rest into createOrderDirect, so
  // a manual_with_info checkout's collected answers must ride along untouched.
  it("forwards customerData verbatim onto the created order", async () => {
    const customerData = JSON.stringify([{ game_id: "GID-456" }]);
    const order = await prisma.$transaction((tx) =>
      createBybitOrder(tx, {
        user: { id: sample.user.id, role: sample.user.role },
        productId: sample.product.id,
        quantity: 1,
        rate: 1,
        customerData,
      }),
    );
    expect(order!.customerData).toBe(customerData);
  });

  // Checkout-4 (security audit, 2026-06-23): computeUniqueCents only has 49
  // buckets — two orders for the SAME base amount whose ids happen to land in
  // the same bucket used to get an IDENTICAL totalAmount, and Bybit has no
  // memo to disambiguate beyond the amount. finalizeOrderPayment now retries
  // within the bucket space against the SAME pool the matcher reads
  // (PENDING_PAYMENT, BYBIT, not-yet-expired), so amounts must stay distinct
  // well past the point where raw `id % 49` would have collided.
  it("totalAmount stays unique across many simultaneous orders for the same product (no two share a bucket)", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      // Stock up enough credentials for 20 single-unit orders.
      await prisma.stockItem.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          productId: sample.product.id,
          credentials: `bybit-uniq-${i}@x.com:pw`,
          status: StockStatus.AVAILABLE,
        })),
      });
      const orders = [];
      for (let i = 0; i < 20; i++) orders.push(await makeBybitOrder());
      const totals = orders.map((o) => new Decimal(o!.totalAmount).toString());
      expect(new Set(totals).size).toBe(totals.length); // all 20 distinct
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });
});

// ===========================================================================
// Idempotent delivery / unmatched
// ===========================================================================

describe("deliverPaidBybitOrder (idempotency + delivery)", () => {
  it("delivers once and is idempotent on the same tx id", async () => {
    const order = await makeBybitOrder();
    const amount = order!.totalAmount;

    const first = await deliverPaidBybitOrder(prisma, { orderId: order!.id, bybitTxId: "0xAAA", amount });
    expect(first.status).toBe("delivered");
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.bybitTxid).toBe("0xAAA");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: "0xAAA" } })).toBe(1);

    // Same tx again → already processed, no second delivery.
    const second = await deliverPaidBybitOrder(prisma, { orderId: order!.id, bybitTxId: "0xAAA", amount });
    expect(second.status).toBe("already_processed");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
  });

  it("returns 'stale' when a different tx targets an already-delivered order", async () => {
    const order = await makeBybitOrder();
    await deliverPaidBybitOrder(prisma, { orderId: order!.id, bybitTxId: "0x1", amount: order!.totalAmount });
    const res = await deliverPaidBybitOrder(prisma, { orderId: order!.id, bybitTxId: "0x2", amount: order!.totalAmount });
    expect(res.status).toBe("stale");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1); // not re-delivered
  });

  // H-3 (backend audit 2026-07-31): the ledger claim used to survive a failed
  // delivery transaction forever — every retry (poller cycle) hit the
  // bybit_tx_id UNIQUE constraint and was turned away as already_processed,
  // silently losing the buyer's payment. Wiping all stock for the product
  // forces settlePaidOrder's out-of-stock guard to throw INSIDE the delivery
  // $transaction, rolling it back (the real-world equivalent of a SQLITE_BUSY
  // collision or a transient failure mid-delivery).
  it("a claim whose delivery failed is retryable — a later call with the same tx id succeeds instead of already_processed", async () => {
    const order = await makeBybitOrder();

    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.DEAD } });

    await expect(
      deliverPaidBybitOrder(prisma, { orderId: order!.id, bybitTxId: "0x-retry-1", amount: order!.totalAmount }),
    ).rejects.toThrow();

    // The claim row survives the rollback, tagged delivery_failed — and the
    // order itself rolled all the way back to PENDING_PAYMENT, not stuck
    // mid-transition.
    const failedLedger = await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0x-retry-1" } });
    expect(failedLedger?.outcome).toBe("delivery_failed");
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Restock, then retry with the SAME tx id — this must now succeed
    // instead of hitting the UNIQUE constraint and returning already_processed.
    await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "retry-cred@example.com:pwd", status: StockStatus.AVAILABLE },
    });

    const retry = await deliverPaidBybitOrder(prisma, { orderId: order!.id, bybitTxId: "0x-retry-1", amount: order!.totalAmount });
    expect(retry.status).toBe("delivered");
    if (retry.status !== "delivered") throw new Error("expected delivered");
    expect(retry.order.status).toBe(OrderStatus.DELIVERED);

    const ledgerRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0x-retry-1" } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order!.id);

    // Still exactly one ledger row — reclaimed in place, not duplicated.
    const rows = await prisma.processedBybitTx.findMany({ where: { bybitTxId: "0x-retry-1" } });
    expect(rows.length).toBe(1);
  });
});

// ===========================================================================
// processDeposits — the poll-loop wiring (amount-only match + unmatched)
// ===========================================================================

describe("processDeposits (poll-loop wiring)", () => {
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

  const pending = () => listPendingBybitOrders(prisma, new Date());
  const dep = (over: { txId: string; amount: Decimal.Value } & Partial<Omit<BybitDeposit, "amount">>): BybitDeposit => ({
    ...over, amount: new Decimal(over.amount),
  });

  it("flips the anchored payment bubble to the success message with paymentSuccessKb (§9.1)", async () => {
    const order = (await makeBybitOrder())!;
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApi();
    await processDeposits(api, [dep({ txId: "0xFLIP", amount: order.totalAmount })], await pending());
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe(OrderStatus.DELIVERED);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.chatId).toBe(555);
    expect(edits[0]!.messageId).toBe(777);
    const markup = (edits[0]!.extra as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } })
      .reply_markup;
    const flat = (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    expect(flat).toContain("v1:browse:prods");
    expect(flat).toContain("v1:order:list");

    // T1: a successful terminal flip must clear the anchor pointer, so the
    // generic sweeper (added in a later task) knows this bubble is done and
    // doesn't re-edit it every cycle.
    expect(updated!.paymentMsgChatId).toBeNull();
    expect(updated!.paymentMsgId).toBeNull();
  });

  // T1 critical fix: a rejected edit (e.g. the buyer navigated away and the
  // bubble was deleted — "message to edit not found") must still clear the
  // anchor. Only a genuine wall-clock timeout is allowed to leave it in
  // place; a message that can never be edited must self-heal instead of
  // making the upcoming generic sweeper retry a doomed edit forever.
  it("clears the anchor even when the bubble edit is rejected by Telegram, so it self-heals instead of retrying forever (T1)", async () => {
    const order = (await makeBybitOrder())!;
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api } = fakeApi();
    api.editMessageText = async () => {
      throw telegramError(400, "Bad Request: message to edit not found");
    };
    await processDeposits(api, [dep({ txId: "0xEDITFAIL", amount: order.totalAmount })], await pending());
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    // Delivery itself must not be blocked by a bubble-edit failure.
    expect(updated!.status).toBe(OrderStatus.DELIVERED);
    // The anchor clears because the edit attempt genuinely completed (it was
    // just rejected) — a permanently-uneditable bubble must not stay
    // anchored forever.
    expect(updated!.paymentMsgChatId).toBeNull();
    expect(updated!.paymentMsgId).toBeNull();
  });

  // The other half of that contract (F1): a rejection Telegram may well accept
  // a minute later — flood control, a gateway hiccup, a network fault — is NOT
  // evidence the bubble is dead, so the anchor has to survive it or the buyer
  // is stranded on a stale payment screen with nothing left to retry the edit.
  it.each([
    ["Telegram flood control", () => telegramError(429, "Too Many Requests: retry after 30")],
    ["a Telegram server error", () => telegramError(502, "Bad Gateway")],
    ["a network fault that never reached Telegram", () => new Error("socket hang up")],
  ])("keeps the anchor when the bubble edit fails with %s, so a later sweep retries it", async (label, makeError) => {
    const order = (await makeBybitOrder())!;
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api } = fakeApi();
    api.editMessageText = async () => {
      throw makeError();
    };
    await processDeposits(api, [dep({ txId: `0xTRANSIENT-${label}`, amount: order.totalAmount })], await pending());
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe(OrderStatus.DELIVERED);
    expect(updated!.paymentMsgChatId).not.toBeNull();
    expect(updated!.paymentMsgId).not.toBeNull();
  });

  // T1 critical fix, other half of the same contract: a genuine wall-clock
  // timeout (the edit call hangs and never resolves at all — never rejects,
  // never resolves) is the ONLY case that must leave the anchor in place, so
  // the next sweep retries it. Real timers (not fake) — faking timers breaks
  // Prisma's own I/O in this test harness, same constraint the hung-upload
  // test above and tokopayReconcile's own sweep tests document.
  it("leaves the anchor in place when the bubble edit genuinely times out, so a later sweep retries it (T1)", async () => {
    const order = (await makeBybitOrder())!;
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api } = fakeApi();
    api.editMessageText = () => new Promise(() => {}); // hangs forever — never resolves or rejects
    await processDeposits(api, [dep({ txId: "0xEDITHANG", amount: order.totalAmount })], await pending());
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    // Delivery itself must not be blocked by a hung bubble-edit.
    expect(updated!.status).toBe(OrderStatus.DELIVERED);
    // The anchor must survive — unlike a rejection, a genuine timeout means
    // the edit's real outcome is still unknown, so the next sweep must retry.
    expect(updated!.paymentMsgChatId).not.toBeNull();
    expect(updated!.paymentMsgId).not.toBeNull();
  }, 10_000);

  it("delivers on a unique-amount match", async () => {
    const order = (await makeBybitOrder())!;
    const { api } = fakeApi();
    await processDeposits(api, [dep({ txId: "0xT1", amount: order.totalAmount })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xT1" } }))!.outcome).toBe("matched");
  });

  it("refuses on a collision (two equal-total orders) → unmatched", async () => {
    const a = (await makeBybitOrder())!;
    const b = (await makeBybitOrder())!; // unique-cents off in tests → equal totals
    expect(a.totalAmount).toEqual(b.totalAmount);
    const { api } = fakeApi();
    await processDeposits(api, [dep({ txId: "0xT2", amount: a.totalAmount })], await pending());
    expect((await prisma.order.findUnique({ where: { id: a.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.order.findUnique({ where: { id: b.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xT2" } }))!.outcome).toBe("unmatched");
  });

  // No pending orders at all — the only way to get a genuine "no candidate"
  // result now that matchByAmount accepts overpayment unbounded above (M-14):
  // with a pending order present, ANY amount at or above its total is a clean
  // match (deliver-as-overpaid) and any amount short of it alone is underpaid,
  // so "unmatched" only remains reachable via zero candidates or ambiguity.
  it("records a no-candidate deposit as unmatched (no pending orders)", async () => {
    const { api } = fakeApi();
    await processDeposits(api, [dep({ txId: "0xT3", amount: 999.99 })], await pending());
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xT3" } }))!.outcome).toBe("unmatched");
  });

  // M-14 (backend audit 2026-07-31): Internal Transfer has no memo, so amount
  // is the only disambiguator — a buyer who rounds up used to match nothing
  // (recorded unmatched, order later auto-cancels at expiry) even though the
  // money genuinely arrived. matchByAmount is now asymmetric: at-or-above the
  // order's total is accepted, overpayment included.
  it("delivers on a deposit that overpays the sole pending order (previously unmatched)", async () => {
    const order = (await makeBybitOrder())!;
    const { api } = fakeApi();
    const overpaid = Number(order.totalAmount) + 0.5; // well beyond float-noise tolerance
    await processDeposits(api, [dep({ txId: "0xOVER", amount: overpaid })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);
    // The buyer is delivered either way, but the excess is no longer swallowed
    // silently: `deliverPaidBybitOrder` stamps the ledger row "overpaid" and
    // enqueues an ADMIN_OVERPAID alert so a human can refund or credit it,
    // like the other five rails. This assertion read "matched" until this rail
    // gained that branch.
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xOVER" } }))!.outcome).toBe("overpaid");
  });

  // Mirror of the overpay case on the short side: a deposit that's uniquely
  // attributable to the sole pending order but short of its total beyond
  // tolerance now flags UNDERPAID instead of silently falling through to
  // "unmatched" (M-14).
  it("flags the sole pending order UNDERPAID on a deposit that's short (previously unmatched)", async () => {
    const order = (await makeBybitOrder())!;
    const { api, sent } = fakeApi();
    const underpaid = Number(order.totalAmount) - 0.5; // short beyond tolerance
    await processDeposits(api, [dep({ txId: "0xUNDER", amount: underpaid })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.UNDERPAID);
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xUNDER" } }))!.outcome).toBe("underpaid");
    expect(sent.some((m) => /[Uu]nderpaid/.test(m.text))).toBe(true);
  });

  // A deposit short of BOTH pending orders (ambiguous underpaid candidate)
  // must still refuse rather than guess which order it was meant for — same
  // ambiguity guard as the matched path, just on the short side.
  it("refuses an underpaid deposit that's ambiguous between two pending orders → unmatched", async () => {
    const a = (await makeBybitOrder())!;
    const b = (await makeBybitOrder())!; // unique-cents off in tests → equal totals
    expect(a.totalAmount).toEqual(b.totalAmount);
    const { api } = fakeApi();
    const underpaid = Number(a.totalAmount) - 0.5;
    await processDeposits(api, [dep({ txId: "0xUNDER-AMB", amount: underpaid })], await pending());
    expect((await prisma.order.findUnique({ where: { id: a.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.order.findUnique({ where: { id: b.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xUNDER-AMB" } }))!.outcome).toBe("unmatched");
  });

  // THE regression test (code-review follow-up, Important #4): the
  // production configuration is USE_UNIQUE_CENTS on (both Bybit rails
  // hard-gate the poller on it specifically because it makes every pending
  // order's total distinct). A prior version of this fix's amount-matching
  // treated ANY order at or below the paid amount as a "candidate" and
  // refused whenever ≥2 qualified — which meant a payment for any order
  // except the single cheapest pending one was refused as "ambiguous" the
  // instant a second, cheaper order existed. Best-fit selection (the largest
  // qualifying total) fixes this: the deposit here exactly matches the
  // PRICIER of two distinct-total pending orders and must deliver it, not
  // refuse.
  it("matches the pricier of two distinct-total pending orders when paid exactly, not refused as ambiguous", async () => {
    const cheap = (await makeBybitOrder())!;
    const pricier = (await makeBybitOrder())!;
    const pricierTotal = new Decimal(cheap.totalAmount).plus(2); // force distinct totals
    await prisma.order.update({ where: { id: pricier.id }, data: { totalAmount: pricierTotal } });
    const { api } = fakeApi();
    await processDeposits(api, [dep({ txId: "0xPRICIER", amount: pricierTotal.toNumber() })], await pending());
    expect((await prisma.order.findUnique({ where: { id: pricier.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect((await prisma.order.findUnique({ where: { id: cheap.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT); // untouched
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xPRICIER" } }))!.outcome).toBe("matched");
  });

  // Critical #2 (code-review follow-up): the ambiguity guard alone gives NO
  // protection once only one order is pending — the everyday overnight state
  // for a small shop. An amount far beyond the sole pending order's total
  // (an unrelated top-up to the same UID, a mistyped transfer, a late
  // payment for an already-expired order) must NOT auto-deliver on a guess —
  // it now falls through to "unmatched" for manual review instead.
  it("does not auto-deliver a deposit that overpays the sole pending order far beyond the cap → unmatched", async () => {
    const order = (await makeBybitOrder())!;
    const { api } = fakeApi();
    const farOverpaid = Number(order.totalAmount) + 500; // e.g. an unrelated $500 transfer vs a $5 order
    await processDeposits(api, [dep({ txId: "0xFAROVER", amount: farOverpaid })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xFAROVER" } }))!.outcome).toBe("unmatched");
  });

  // Critical #3 (code-review follow-up): a stray deposit far below the
  // underpaid floor (dust, a test transfer) against the sole pending order
  // must NOT flip it to UNDERPAID — that would pull it out of the matcher's
  // own pending pool and orphan the buyer's real payment when it lands.
  it("does not flag underpaid for a stray deposit far below the underpaid floor → unmatched", async () => {
    const order = (await makeBybitOrder())!;
    const { api } = fakeApi();
    const dust = Number(order.totalAmount) * 0.1; // 10% of expected — well under the 50% floor
    await processDeposits(api, [dep({ txId: "0xDUST", amount: dust })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xDUST" } }))!.outcome).toBe("unmatched");
  });

  // Finding #2 (followup-review-fixes-2): before this task, sendAccountFile
  // (the account-file `sendDocument` upload) was unbounded — a hung upload
  // would have blocked this whole cycle, potentially past cycleTimeoutMs,
  // paging admins over a rail that was in fact delivering fine. Now it's
  // bounded at TELEGRAM_DOCUMENT_TIMEOUT_MS: this test uses a `sendDocument`
  // that never resolves and asserts (a) the order still ends up DELIVERED —
  // the delivery itself already happened in the DB before this Telegram call
  // — and (b) the existing outbox-fallback path still fires on the timeout,
  // exactly as it already does for a genuine throw. Real timers (not fake) —
  // faking timers breaks Prisma's own I/O in this test harness, same
  // constraint tokopayReconcile's own sweep tests document.
  it("a hung account-file upload is bounded by TELEGRAM_DOCUMENT_TIMEOUT_MS and falls through to the outbox-DM fallback", async () => {
    const order = (await makeBybitOrder())!;
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn(() => new Promise(() => {})), // hangs forever
      editMessageText: vi.fn().mockResolvedValue({}),
    } as unknown as Api;

    await processDeposits(api, [dep({ txId: "0xHANGDOC", amount: order.totalAmount })], await pending());

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe(OrderStatus.DELIVERED); // the DB delivery already happened before the DM attempt

    const outboxRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: "ORDER_DELIVERED_DM" },
    });
    expect(outboxRows.length).toBeGreaterThan(0); // the same fallback a genuine sendAccountFile throw would enqueue
  }, 15_000);
});

// ===========================================================================
// processDeposits — WALLET_TOPUP delivery (Task 6 success UI). Same shape as
// binance-internal.test.ts's equivalent block; onDelivered isn't exported, so
// this drives it through the real poll-loop wiring (processDeposits).
// ===========================================================================

describe("processDeposits — WALLET_TOPUP delivery (onDelivered success UI)", () => {
  function fakeApi() {
    const sent: Array<{ chatId: number | string; text: string; extra?: unknown }> = [];
    const edits: Array<{ chatId: number | string; messageId: number; text: string; extra?: unknown }> = [];
    let sendDocumentCalls = 0;
    const api = {
      sendMessage: async (chatId: number | string, text: string, extra?: unknown) => {
        sent.push({ chatId, text, extra });
        return { message_id: 1 };
      },
      sendDocument: async () => {
        sendDocumentCalls++;
        return { message_id: 1 };
      },
      editMessageText: async (chatId: number | string, messageId: number, text: string, extra?: unknown) => {
        edits.push({ chatId, messageId, text, extra });
        return {};
      },
    } as unknown as Api;
    return { api, sent, edits, sendDocumentCalls: () => sendDocumentCalls };
  }

  const pending = () => listPendingBybitOrders(prisma, new Date());
  const dep = (over: { txId: string; amount: Decimal.Value } & Partial<Omit<BybitDeposit, "amount">>): BybitDeposit => ({
    ...over, amount: new Decimal(over.amount),
  });

  const makeTopupOrder = (amount: string) =>
    prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount, currency: "USDT", method: PaymentMethod.BYBIT, rate: "16000" }),
    );

  it("delivers, enqueues exactly one outbox top-up DM (never a direct Telegram DM), sends no credential file, and flips the anchored bubble to a neutral status", async () => {
    const order = await makeTopupOrder("7");
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api, sent, edits, sendDocumentCalls } = fakeApi();
    await processDeposits(api, [dep({ txId: "0xTOPUP-1", amount: order.totalAmount })], await pending());

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe(OrderStatus.DELIVERED);

    // No account file — a top-up has no product/credentials to deliver.
    expect(sendDocumentCalls()).toBe(0);

    // No direct Telegram DM either (Task E1) — this rail used to send the
    // "top-up successful" message straight from the bot process, which could
    // double-notify the buyer once the outbox also carried it for the same
    // top-up. The buyer's actual success message now comes exclusively from
    // the outbox, enqueued inside settleWalletTopup.
    expect(sent).toHaveLength(0);

    const freshUser = await getUser(prisma, sample.user.id);
    expect(freshUser!.walletBalanceUsdt.toString()).toBe("7"); // credited to the right currency field

    const dmRows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(dmRows).toHaveLength(1);
    const payload = JSON.parse(dmRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.chat_id).toBe(Number(sample.user.telegramId));
    expect(payload.order_code).toBe(order.orderCode);
    expect(payload.amount).toBe("7");
    expect(payload.currency).toBe("USDT");
    expect(payload.new_balance).toBe("7");

    // Anchored bubble carries a neutral "payment received" status — not the
    // generic "your items are being delivered now" product copy, and no
    // longer the balance-quoting success sentence (that now lives
    // exclusively in the outbox DM above).
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).not.toContain("items are being delivered");
    expect(edits[0]!.text).not.toContain("7.00 USDT");
    expect(edits[0]!.text).toContain("Payment received");
    expect(edits[0]!.text).toContain("top-up has been credited");

    // …and the wallet keyboard, not paymentSuccessKb's "My Orders": a top-up
    // leaves nothing in the order history to look up. Picked through
    // `settledPaymentKb` (apps/order-bot/src/util/delivery.ts), the same helper
    // the sweeper and the Refresh button use, so the buyer sees one keyboard
    // regardless of which path reaches the bubble first.
    const markup = (edits[0]!.extra as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } })
      .reply_markup;
    const flat = (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    expect(flat).toContain("v1:topup:open");
    expect(flat).not.toContain("v1:order:list");
  });
});

// ===========================================================================
// resolveBybitConfig — web-admin Settings win over .env (the gate for poller +
// checkout). In tests no BYBIT_* env is set, so Settings is the only source.
// ===========================================================================

describe("resolveBybitConfig (Settings-backed config)", () => {
  const clear = () => Promise.all([
    deleteSetting(prisma, BYBIT_UID_KEY),
    deleteSetting(prisma, BYBIT_API_KEY_KEY),
    deleteSetting(prisma, BYBIT_API_SECRET_KEY),
  ]);

  it("is disabled when no settings (and no env) are present", async () => {
    await clear();
    const cfg = await resolveBybitConfig(prisma);
    expect(cfg.enabled).toBe(false);
  });

  it("is disabled until ALL THREE of uid + key + secret are set", async () => {
    await clear();
    await setSetting(prisma, BYBIT_UID_KEY, "123456");
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    expect((await resolveBybitConfig(prisma)).enabled).toBe(false); // secret still missing
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
    const cfg = await resolveBybitConfig(prisma);
    expect(cfg.enabled).toBe(true);
    expect(cfg.uid).toBe("123456");
    expect(cfg.apiKey).toBe("k");
    expect(cfg.apiSecret).toBe("s");
  });

  it("treats a blank/whitespace setting as unset", async () => {
    await clear();
    await setSetting(prisma, BYBIT_UID_KEY, "  ");
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
    expect((await resolveBybitConfig(prisma)).enabled).toBe(false);
    await clear();
  });
});

// ===========================================================================
// pollOnce — refuses to run at all when enabled but USE_UNIQUE_CENTS is off
// (Payment-2 fix). Internal Transfer has no memo, so without unique cents two
// orders can share a total — a confused-deputy risk, not just an availability
// one. Asserting the tick returns immediately (no poll-health row written)
// proves it never reached the network call.
// ===========================================================================

describe("pollOnce — USE_UNIQUE_CENTS hard gate", () => {
  beforeEach(async () => {
    await setSetting(prisma, BYBIT_UID_KEY, "123456");
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
  });
  afterAll(async () => {
    await deleteSetting(prisma, BYBIT_UID_KEY);
    await deleteSetting(prisma, BYBIT_API_KEY_KEY);
    await deleteSetting(prisma, BYBIT_API_SECRET_KEY);
  });

  it("refuses to poll (no network call, no health setting written) when USE_UNIQUE_CENTS is off", async () => {
    expect(config.USE_UNIQUE_CENTS).toBe(false); // test-env default (setup-db.ts)
    await deleteSetting(prisma, BYBIT_POLL_HEALTH_KEY);
    const fakeApi = {} as Api; // never called — pollOnce must return before touching it
    await pollOnce(fakeApi);
    expect(await getSetting(prisma, BYBIT_POLL_HEALTH_KEY)).toBeNull(); // never reached fetchRecentDeposits
  });
});

// ===========================================================================
// pollOnce — HTTP timeout bound + credential-leak safety (Task 3). Bybit
// carries its API key in a header (X-BAPI-API-KEY), and until this task
// nothing wrapped the raw fetch() call — a rejection's err.cause could carry
// that header into a logger.error({ err }). These drive the deposit-query
// fetch through the real poll cycle rather than calling bybitGet directly,
// since it isn't exported.
// ===========================================================================

describe("pollOnce — HTTP timeout bound + credential-leak safety", () => {
  beforeEach(async () => {
    await setSetting(prisma, BYBIT_UID_KEY, "123456");
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await deleteSetting(prisma, BYBIT_UID_KEY);
    await deleteSetting(prisma, BYBIT_API_KEY_KEY);
    await deleteSetting(prisma, BYBIT_API_SECRET_KEY);
  });

  it("bounds the deposit-query request so a hung gateway cannot stall the poller forever", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ retCode: 0, result: { rows: [] } }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await pollOnce({} as Api);
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("wraps a rejected deposit-query request in a fresh, static-message error instead of the raw (header-bearing) rejection", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    // Node's fetch sometimes attaches the failed request — headers included,
    // one of which carries the X-BAPI-API-KEY credential — to a rejected
    // error's .cause. bybitGet must catch that and rethrow a fresh, static
    // Error before it can reach the poll-health heartbeat (or a logger).
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error("fetch failed"), { cause: { headers: { "X-BAPI-API-KEY": "LEAKED-API-KEY-VALUE" } } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await pollOnce({} as Api);
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
    const health = await getBybitPollHealth(prisma);
    expect(health.lastError).not.toContain("LEAKED-API-KEY-VALUE");
    expect(health.lastError).not.toBe("Error: fetch failed"); // proves the raw error was replaced, not just stringified
    // "network error" (not "timed out") — a plain rejection, not a deadline —
    // per fetchWithTimeoutSafe's shared wording (packages/core/src/http.ts).
    expect(health.lastError).toMatch(/network error/);
  });

  // Calls fetchRecentDeposits directly (now exported) rather than only
  // through pollOnce, so the test can inspect the actual thrown Error object
  // — not just its message after pollOnce reduces it to a string for the DB
  // health record — the same way tokopay/paydisini/nowpayments' own
  // credential-leak tests do. This is what pollOnce's own DB-observed test
  // above cannot catch: a future change that attached a `.cause` to the
  // rethrown error would not show up in `String(err)` (health.lastError),
  // but WOULD reach a logger via pino's cause serialization if this code
  // ever changed to log `err` directly instead of routing through the DB
  // heartbeat (Minor 10, Task 3 review follow-up).
  it("fetchRecentDeposits rethrows a brand-new, cause-free Error instead of letting the header-bearing rejection escape", async () => {
    const cfg = await resolveBybitConfig(prisma);
    const original = Object.assign(new Error("fetch failed"), {
      cause: { headers: { "X-BAPI-API-KEY": "LEAKED-API-KEY-VALUE" } },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(original));
    let caught: unknown;
    try {
      await fetchRecentDeposits(cfg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(original);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).message).not.toContain("LEAKED-API-KEY-VALUE");
    expect((caught as Error).message).not.toBe("fetch failed");
    expect((caught as Error).message).toMatch(/network error/);
  });

  it("fetchRecentDeposits distinguishes a timeout from a network error, both still cause-free", async () => {
    const cfg = await resolveBybitConfig(prisma);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })),
    );
    let caught: unknown;
    try {
      await fetchRecentDeposits(cfg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).message).toMatch(/timed out/);
  });

  // AbortSignal.timeout stays attached to the response body in undici
  // (http.ts), so a peer that sends headers and then stalls the body makes
  // res.json() reject with this same TimeoutError shape — a DIFFERENT case
  // from the fetch()-level timeout above (that one never gets a response at
  // all). Must not be reported as "unparseable" — that would tell whoever
  // reads lastError the gateway sent back garbage, when it actually just hung.
  it("fetchRecentDeposits reports a response-body-read timeout distinctly from a genuinely unparseable response", async () => {
    const cfg = await resolveBybitConfig(prisma);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
        },
        text: async () => "",
      }),
    );
    let caught: unknown;
    try {
      await fetchRecentDeposits(cfg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/timed out/);
    expect((caught as Error).message).not.toMatch(/unparseable/);
  });
});

describe("recordUnmatchedBybitTx", () => {
  it("records once and dedupes", async () => {
    expect(await recordUnmatchedBybitTx(prisma, { bybitTxId: "0xUNM", amount: "9.99" })).toBe(true);
    expect(await recordUnmatchedBybitTx(prisma, { bybitTxId: "0xUNM", amount: "9.99" })).toBe(false);
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: "0xUNM", outcome: "unmatched" } })).toBe(1);
  });
});

describe("markUnderpaidBybit", () => {
  it("flags the order UNDERPAID once (idempotent)", async () => {
    const order = await makeBybitOrder();
    const first = await markUnderpaidBybit(prisma, { orderId: order!.id, bybitTxId: "0xUP", amount: "1.00" });
    expect(first).toBe(true);
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.status).toBe(OrderStatus.UNDERPAID);
    const second = await markUnderpaidBybit(prisma, { orderId: order!.id, bybitTxId: "0xUP", amount: "1.00" });
    expect(second).toBe(false);
  });

  // Important #5 (code-review follow-up): the ledger claim and the order
  // mutation are now wrapped so a stale order (already moved on past
  // PENDING_PAYMENT by the time this runs) is a clean, reported "did not
  // apply" — not a blind `true` with the order silently left untouched. The
  // ledger claim itself still succeeds (same idempotency-first shape as
  // deliverPaidBybitOrder's own "stale" case), so a retry never re-attempts it.
  it("returns false (does not transition) when the order already left PENDING_PAYMENT — ledger claim still recorded", async () => {
    const order = (await makeBybitOrder())!;
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
    const result = await markUnderpaidBybit(prisma, { orderId: order.id, bybitTxId: "0xUP-STALE", amount: "1.00" });
    expect(result).toBe(false);
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.CANCELLED); // untouched
    const ledgerRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xUP-STALE" } });
    expect(ledgerRow?.outcome).toBe("underpaid"); // claim still recorded, just didn't apply to a stale order
  });
});
