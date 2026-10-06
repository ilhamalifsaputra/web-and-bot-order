// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createInternalOrder,
  createWalletTopupOrder,
  deliverPaidInternalOrder,
  markUnderpaid,
  recordUnmatchedTx,
  dismissUnmatchedTx,
  listPendingInternalOrders,
  setOrderPaymentMessage,
  resolveBinanceInternalConfig,
  setSetting,
  deleteSetting,
  getUser,
  BINANCE_UID_KEY,
  BINANCE_API_KEY_KEY,
  BINANCE_API_SECRET_KEY,
  type BinanceInternalConfig,
  triggerDigiflazzDispatch,
} from "@app/db";
import { routeOrderToDigiflazz } from "../../../tests/helpers/digiflazzRouting";

// The instant Digiflazz dispatch is observed, not run: these tests check that the
// poller starts it for a PROCESSING settlement, not what Digiflazz answers.
vi.mock("@app/db", async (orig) => ({
  ...(await orig<typeof import("@app/db")>()),
  triggerDigiflazzDispatch: vi.fn(),
}));
import type { Api } from "grammy";
import { telegramError } from "./helpers/ctx";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { registerOutboxNudge } from "@app/core/nudge";
import { OrderStatus, PaymentMethod, StockStatus, NotificationEvent } from "@app/core/enums";
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
  vi.mocked(triggerDigiflazzDispatch).mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// rate 1 keeps the USDT totals numerically equal to the fixture's central-IDR
// price ("5.00"), so the amount-matching assertions below stay exact.
const makeInternalOrder = (qty = 1) =>
  prisma.$transaction((tx) =>
    createInternalOrder(tx, { channel: "bot", user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: qty, rate: 1 }),
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
    expect(tx.amount.toString()).toBe("1");
    expect(tx.currency).toBe("USDT");
    expect(tx.note).toBe(""); // Binance's orderId must NOT leak into note
  });

  it("uses a real memo when present (remark fallback, empty-string skipped)", () => {
    expect(normalizeTx({ ...real, note: "BCC1BDDE6F" })!.note).toBe("BCC1BDDE6F");
    expect(normalizeTx({ ...real, note: "  ", remark: "BCC1BDDE6F" })!.note).toBe("BCC1BDDE6F");
  });

  // Task 14: normalizeTx used to do Number(raw.amount) — a plain IEEE-754
  // double, which silently truncates any decimal string with more precision
  // than a double can represent exactly. Binance/Bybit report amounts as
  // decimal strings, and that string now flows straight into Decimal instead
  // of round-tripping through Number() first.
  it("preserves an amount with more precision than a double", () => {
    const precise = "1234.00000000000001";
    expect(Number(precise).toString()).not.toBe(precise); // proves Number() really does truncate this
    expect(normalizeTx({ ...real, amount: precise })!.amount.toString()).toBe(precise);
  });

  it("rejects non-received / malformed rows", () => {
    expect(normalizeTx({ ...real, amount: "0" })).toBeNull();
    expect(normalizeTx({ ...real, amount: "-5" })).toBeNull();
    expect(normalizeTx({ transactionId: "X" })).toBeNull(); // no amount
  });

  // Task 14 review hazard: `new Decimal("1,234.56")` THROWS (unlike the old
  // Number() -> NaN round-trip, which the guard turned into a quiet skipped
  // row). A malformed gateway amount must stay a skipped row, not become an
  // exception escaping into the poll loop.
  it("rejects a malformed amount string instead of throwing", () => {
    expect(() => normalizeTx({ ...real, amount: "1,234.56" })).not.toThrow();
    expect(normalizeTx({ ...real, amount: "1,234.56" })).toBeNull();
  });

  // The same review hazard in the other direction: Number(" 746.99") was
  // whitespace-tolerant and new Decimal(" 746.99") is not, so a padded
  // gateway amount would have gone from "matches" to "silently unmatched".
  it("still accepts an amount padded with whitespace", () => {
    expect(normalizeTx({ ...real, amount: " 746.99 " })?.amount.toString()).toBe("746.99");
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

  // Followup review fix (duplicate paging): a rail can be hard-down long
  // enough to page admins (alreadyAlerted flips to true), and THEN start
  // getting rate-limited, which writes a live backoffUntil. evaluatePollHealth
  // correctly reports `paging: false` for a live backoff (Rule 2 — it's an
  // intentional pause, not a failure), but that must not, on its own, read as
  // "recovered": the rail is still down underneath the backoff, nothing was
  // fixed, and clearing the alert flag here means the NEXT unhealthy tick
  // (once the backoff expires and the rail is still down) pages every admin
  // again for the exact same incident. The pre-rewrite body's unconditional
  // `if (backoff > now) return "none"` — evaluated BEFORE the alerted
  // comparison — is what stopped that; this pins the same "none" outcome
  // through the evaluatePollHealth-derived path.
  it("stays quiet (does not clear the alert flag / does not recover) when already alerted and a live backoff then appears", () => {
    expect(
      pollWatchdogDecision(
        { lastRun: ago(5_000), backoffUntil: ago(-60_000), consecutiveFailures: 0 },
        true,
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
  // `overpaymentCap` in amountMatching.ts. A modest overpay of the best-fit
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

  // Task 13: the matcher's internals now run on Decimal, not IEEE-754 double
  // arithmetic — this is the regression proof that a caller can pass the raw
  // decimal STRING a gateway returns (rather than a pre-parsed float) and
  // still get a clean match.
  it("matches when the transfer amount is the exact decimal string the gateway returned", () => {
    expect(matchByAmount({ amount: "7.5000" }, orders)?.id).toBe(2);
  });

  // Task 13: matchByAmount's tie-detection at :182 used to compare `total`s
  // that were both put through `Decimal.toNumber()` with exact `===` on the
  // resulting IEEE-754 doubles. Two DISTINCT decimal totals can round to the
  // identical double — 0.1 + 0.2 !== 0.3 is the canonical example of the
  // inverse failure (same value, different doubles); this is the same class
  // of float representation risk from the other direction. Construct two
  // totals that are decimal-distinct but which naive Number()/toNumber()
  // conversion collapses onto the same double, and confirm the matcher does
  // NOT declare a false tie (refuse) when Decimal.equals is used instead of
  // double `===`.
  it("does not declare a false tie between two totals that collapse to the same double", () => {
    // "4.35" cannot be represented exactly in IEEE-754 double precision — its
    // nearest double is shared by "4.3499999999999999" too (verified below),
    // even though the two are decimal-distinct values. Under the old
    // `Number.toNumber()` + `===` tie check both would collapse onto the
    // exact same double and get refused as an ambiguous tie; `Decimal.equals`
    // keeps them apart.
    const collapsing = [
      { id: 1, totalAmount: "4.3499999999999999" },
      { id: 2, totalAmount: "4.35" },
    ];
    // Confirm the premise: both decimal strings really do collapse onto the
    // very same double under plain Number() conversion.
    expect(Number("4.3499999999999999")).toBe(Number("4.35"));
    // A payment that exactly covers the larger (pricier, decimal-exact) of
    // the two must match THAT one specifically, not be refused as an
    // ambiguous tie just because both totals round to the same double.
    expect(matchByAmount({ amount: "4.35" }, collapsing)?.id).toBe(2);
  });

  // Task 13: overpaymentCap's own doc-comment above states the cap is
  // Math.max(fixed, percent * total) — pin an exact value so a future
  // regression in the Decimal port (e.g. an off-by-a-rounding-step in the
  // percent multiply) shows up here instead of only in the pass/refuse
  // behavior of matchByAmount itself.
  it("the overpayment cap is computed exactly", () => {
    // order 3's total is 12.3400 — 20% of that is 2.468, which beats the 2
    // USDT fixed floor, so the cap is exactly 2.468. Paying 12.3400 + 2.468 =
    // 14.808 is AT the cap (still matches); one cent more blows it.
    expect(matchByAmount({ amount: "14.8080" }, [orders[2]!])?.id).toBe(3);
    expect(matchByAmount({ amount: "14.8081" }, [orders[2]!])).toBeNull();
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
      createInternalOrder(tx, { channel: "bot",
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
  // $transaction, rolling it back (the real-world equivalent of a deadlock
  // or a transient failure mid-delivery).
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
  const txFor = (over: { txId: string; amount: Decimal.Value } & Partial<Omit<BinanceTx, "amount">>): BinanceTx => ({
    note: "", currency: "USDT", ...over, amount: new Decimal(over.amount),
  });

  it("flips the anchored payment bubble to the success message with paymentSuccessKb (§9.1)", async () => {
    const order = (await makeInternalOrder())!;
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T-FLIP", note: order.paymentRef!, amount: order.totalAmount })], await pending());
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
    const order = (await makeInternalOrder())!;
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api } = fakeApi();
    api.editMessageText = async () => {
      throw telegramError(400, "Bad Request: message to edit not found");
    };
    await processTransfers(api, [txFor({ txId: "T-EDITFAIL", note: order.paymentRef!, amount: order.totalAmount })], await pending());
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
  // evidence the bubble is dead. Clearing the anchor on those strands the
  // buyer on a stale payment screen forever, because the anchor is the only
  // thing that puts this order back in the generic sweeper's work queue.
  it.each([
    ["Telegram flood control", () => telegramError(429, "Too Many Requests: retry after 30")],
    ["a Telegram server error", () => telegramError(502, "Bad Gateway")],
    ["a network fault that never reached Telegram", () => new Error("socket hang up")],
  ])("keeps the anchor when the bubble edit fails with %s, so a later sweep retries it", async (_label, makeError) => {
    const order = (await makeInternalOrder())!;
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api } = fakeApi();
    api.editMessageText = async () => {
      throw makeError();
    };
    await processTransfers(api, [txFor({ txId: `T-TRANSIENT-${_label}`, note: order.paymentRef!, amount: order.totalAmount })], await pending());
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe(OrderStatus.DELIVERED);
    expect(updated!.paymentMsgChatId).not.toBeNull();
    expect(updated!.paymentMsgId).not.toBeNull();
  });

  it("starts the instant Digiflazz dispatch exactly once for a Digiflazz order it settles into PROCESSING, before the bubble edit", async () => {
    const order = (await makeInternalOrder())!;
    await routeOrderToDigiflazz(prisma, order.id);
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApi();
    const trigger = vi.mocked(triggerDigiflazzDispatch);
    let editsAtTrigger = -1;
    trigger.mockImplementationOnce(() => {
      editsAtTrigger = edits.length;
    });

    await processTransfers(api, [txFor({ txId: "T-DIGIFLAZZ", note: order.paymentRef!, amount: order.totalAmount })], await pending());

    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PROCESSING);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(order.id);
    expect(edits.length).toBeGreaterThan(0);
    expect(editsAtTrigger).toBe(0);
  });

  it("does not start a Digiflazz dispatch for an order delivered from stock", async () => {
    const order = (await makeInternalOrder())!;
    const { api } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T-STOCK", note: order.paymentRef!, amount: order.totalAmount })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect(triggerDigiflazzDispatch).not.toHaveBeenCalled();
  });

  it("delivers on a note match", async () => {
    const order = (await makeInternalOrder())!;
    const { api } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T1", note: order.paymentRef!, amount: order.totalAmount })], await pending());
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
      await processTransfers(api, [txFor({ txId: "T2", note: "", amount: order.totalAmount })], await pending());
      expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);
    } finally {
      config.USE_UNIQUE_CENTS = false;
    }
  });

  it("never attempts the amount fallback when USE_UNIQUE_CENTS is off — unmatched, not delivered", async () => {
    const order = (await makeInternalOrder())!; // unique-cents off in tests → no memo, no unique total
    const { api } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T2B", note: "", amount: order.totalAmount })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "T2B" } }))!.outcome).toBe("unmatched");
  });

  it("refuses the amount fallback on a collision (two equal-total orders) → unmatched", async () => {
    const a = (await makeInternalOrder())!;
    const b = (await makeInternalOrder())!; // unique-cents off in tests → equal totals
    expect(a.totalAmount).toEqual(b.totalAmount);
    const { api } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T3", note: "", amount: a.totalAmount })], await pending());
    expect((await prisma.order.findUnique({ where: { id: a.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.order.findUnique({ where: { id: b.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "T3" } }))!.outcome).toBe("unmatched");
  });

  it("flags underpaid (note match, short amount) and alerts admins", async () => {
    const order = (await makeInternalOrder())!;
    const { api, sent } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T4", note: order.paymentRef!, amount: new Decimal(order.totalAmount).minus(1) })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.UNDERPAID);
    expect(sent.some((m) => /[Uu]nderpaid/.test(m.text))).toBe(true);
  });
});

// ===========================================================================
// processTransfers — WALLET_TOPUP delivery (Task 6 success UI). onDelivered
// isn't exported, so these drive it the same way the PRODUCT-order tests
// above do: through the real poll-loop wiring (processTransfers), asserting
// on the fake Api's recorded calls.
// ===========================================================================

describe("processTransfers — WALLET_TOPUP delivery (onDelivered success UI)", () => {
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

  const pending = () => listPendingInternalOrders(prisma, new Date());
  const txFor = (over: { txId: string; amount: Decimal.Value } & Partial<Omit<BinanceTx, "amount">>): BinanceTx => ({
    note: "", currency: "USDT", ...over, amount: new Decimal(over.amount),
  });

  const makeTopupOrder = (amount: string) =>
    prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount,
        currency: "USDT",
        method: PaymentMethod.BINANCE_INTERNAL,
        rate: "16000",
      }),
    );

    // Task E9 follow-up (I-1): the flip-before-nudge ORACLE for this rail.
  // `nudgeOutboxDispatcher()` is otherwise unobserved here, so this rail could
  // silently revert to `nudge(); flip();` — the reported credential-before-
  // confirmation ordering — with the whole suite still green. The outbox
  // dispatcher's flush hook makes such a regression cosmetic in the combined
  // server, but the standalone order-bot binary registers no flush hook at
  // all, so there it is fully user-visible.
  it("flips the settled bubble BEFORE nudging the outbox dispatcher", async () => {
    const order = await makeTopupOrder("10");
    await setOrderPaymentMessage(prisma, order.id, 555, 778);
    const sequence: string[] = [];
    registerOutboxNudge(() => sequence.push("nudge"));
    const api = {
      sendMessage: async () => {
        sequence.push("bubble");
        return { message_id: 1 };
      },
      sendDocument: async () => ({ message_id: 1 }),
      editMessageText: async () => {
        sequence.push("bubble");
        return {};
      },
      deleteMessage: async () => {
        sequence.push("bubble");
        return true;
      },
    } as unknown as Api;

    await processTransfers(api, [txFor({ txId: "T-ORDERING", note: order.paymentRef!, amount: order.totalAmount })], await pending());

    // Both must have happened — a pass because neither ran is worthless.
    expect(sequence).toContain("bubble");
    expect(sequence).toContain("nudge");
    expect(sequence.lastIndexOf("bubble")).toBeLessThan(sequence.indexOf("nudge"));
    registerOutboxNudge(null);
  });

  it("delivers, credits the wallet, and enqueues exactly one outbox top-up DM — never a direct Telegram DM, never a credential file", async () => {
    const order = await makeTopupOrder("10");
    const { api, sent, sendDocumentCalls } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T-TOPUP-DM", note: order.paymentRef!, amount: order.totalAmount })], await pending());

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

    // New balance reads walletBalanceUsdt, not walletBalance — proves the
    // IDR/USDT currency branch picked the right field.
    const freshUser = await getUser(prisma, sample.user.id);
    expect(freshUser!.walletBalanceUsdt.toString()).toBe("10");

    const dmRows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(dmRows).toHaveLength(1);
    const payload = JSON.parse(dmRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.chat_id).toBe(Number(sample.user.telegramId));
    expect(payload.order_code).toBe(order.orderCode);
    expect(payload.amount).toBe("10");
    expect(payload.currency).toBe("USDT");
    expect(payload.new_balance).toBe("10");
  });

  it("flips the anchored payment bubble to a neutral 'payment received' status, not the generic 'items being delivered' product copy or a balance-quoting success sentence", async () => {
    const order = await makeTopupOrder("10");
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T-TOPUP-BUBBLE", note: order.paymentRef!, amount: order.totalAmount })], await pending());

    expect(edits).toHaveLength(1);
    expect(edits[0]!.chatId).toBe(555);
    expect(edits[0]!.messageId).toBe(777);
    expect(edits[0]!.text).not.toContain("items are being delivered");
    // The bubble no longer quotes the credited amount or new balance — that
    // now lives exclusively in the outbox DM (WALLET_TOPUP_CREDITED_DM).
    expect(edits[0]!.text).not.toContain("10.00 USDT");
    expect(edits[0]!.text).toContain("Payment received");
    expect(edits[0]!.text).toContain("top-up has been credited");

    // …and the wallet keyboard, not paymentSuccessKb's "My Orders". A top-up
    // leaves nothing in the order history to look up, so offering it there is
    // a dead end. This rail used to hand out "My Orders" while the sweeper and
    // the Refresh button handed out the wallet keyboard for the same order, so
    // which one the buyer saw depended on who reached the bubble first — both
    // now go through `settledPaymentKb` (apps/order-bot/src/util/delivery.ts).
    const markup = (edits[0]!.extra as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } })
      .reply_markup;
    const flat = (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    expect(flat).toContain("v1:topup:open");
    expect(flat).not.toContain("v1:order:list");
  });

  it("credits an IDR top-up's walletBalance (not walletBalanceUsdt) and enqueues the outbox DM with IDR-currency payload", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "50000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    // Re-route this IDR/TOKOPAY order onto the Binance Internal poll path
    // purely as a delivery-mechanism shortcut for this test (paymentRef +
    // BINANCE_INTERNAL are what processTransfers matches on) — settleWalletTopup
    // itself is currency-agnostic, so this still proves the onDelivered
    // IDR-vs-USDT branch reads the right wallet field.
    const paymentRef = "IDRTOPUPTEST";
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentMethod: PaymentMethod.BINANCE_INTERNAL, paymentRef, expiresAt: new Date(Date.now() + 60_000) },
    });
    const { api, sent } = fakeApi();
    await processTransfers(api, [txFor({ txId: "T-TOPUP-IDR", note: paymentRef, amount: 50000 })], await pending());

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe(OrderStatus.DELIVERED);
    const freshUser = await getUser(prisma, sample.user.id);
    expect(freshUser!.walletBalance.toString()).toBe("50000");
    expect(freshUser!.walletBalanceUsdt.toString()).toBe("0"); // never crossed into the USDT field
    expect(sent).toHaveLength(0); // no direct DM — the outbox carries it instead

    const dmRows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: order.id },
    });
    expect(dmRows).toHaveLength(1);
    const payload = JSON.parse(dmRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.currency).toBe("IDR");
    expect(payload.amount).toBe("50000");
    expect(payload.new_balance).toBe("50000");
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

  // Important #1 (Task 3 review follow-up): requestIncomingTransfers now
  // routes through fetchWithTimeoutSafe, the same credential-safe choke
  // point Bybit/NOWPayments use — the primary's raw rejection ("always
  // fails") is exactly the kind of thing that could carry the X-MBX-APIKEY
  // header on err.cause in production, so it must NOT survive verbatim to
  // this function's own caller/logger. The assertion below moved from
  // pinning the raw message to pinning the sanitized one.
  it("all bases exhausted (primary + every fallback) throws a sanitized error, never the raw rejection", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("always fails"));
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    try {
      await fetchIncomingTransfers(baseCfg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("always fails");
    expect((caught as Error).message).toMatch(/network error/);
    expect(fetchMock).toHaveBeenCalledTimes(5); // 3 primary + 2 fallbacks (1 each)
  }, 15_000);

  it("empty fallback list behaves exactly like today — no fallback attempted, still a sanitized error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect refused"));
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    try {
      await fetchIncomingTransfers({ ...baseCfg, apiBaseFallbacks: [] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("connect refused");
    expect((caught as Error).message).toMatch(/network error/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // primary's retry budget only
  }, 15_000);

  // Minor 10-style coverage for Important #1: prove the header credential
  // never rides along via `.cause`, the same shape as the NOWPayments/Bybit
  // tests, not just that the message text changed.
  it("wraps a rejected request in a fresh, cause-free error instead of letting the header-bearing rejection escape", async () => {
    const original = Object.assign(new Error("fetch failed"), {
      cause: { request: { headers: { "X-MBX-APIKEY": "LEAKED-BINANCE-API-KEY" } } },
    });
    const fetchMock = vi.fn().mockRejectedValue(original);
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    try {
      await fetchIncomingTransfers(baseCfg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(original);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).message).not.toContain("LEAKED-BINANCE-API-KEY");
    expect((caught as Error).message).not.toBe("fetch failed");
  }, 15_000);

  it("distinguishes a timeout from a network error, both still cause-free", async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }));
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    try {
      await fetchIncomingTransfers({ ...baseCfg, apiBaseFallbacks: [] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).message).toMatch(/timed out/);
  }, 15_000);

  // Task 3: the primary host previously relied on undici's implicit (much
  // longer) default timeout — only the fallback-mirror path had an explicit
  // deadline. A hung primary now gets the same gatewayRead budget so it
  // can't stall the poll cycle past the loop's abandon deadline.
  it("bounds the primary-host request with a real deadline, not just the fallback mirrors", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await fetchIncomingTransfers(baseCfg);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("a malformed Binance response body fails the cycle cleanly instead of throwing a raw SyntaxError", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    try {
      await fetchIncomingTransfers(baseCfg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect((caught as Error).message).toMatch(/unparseable|malformed|invalid/i);
  });

  // AbortSignal.timeout stays attached to the response body in undici
  // (http.ts), so a peer that sends headers and then stalls the body makes
  // res.json() reject with this same TimeoutError shape — a DIFFERENT case
  // from the fetch()-level timeout tested above (that one never gets a
  // response at all). Must not be reported as "unparseable" — that would
  // tell whoever reads lastError the gateway sent back garbage, when it
  // actually just hung.
  it("a body-read timeout on the Binance response is reported distinctly from a malformed body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
      },
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    try {
      await fetchIncomingTransfers(baseCfg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/timed out/);
    expect((caught as Error).message).not.toMatch(/unparseable|malformed|invalid/i);
  });
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
