import { describe, it, expect } from "vitest";
import { describeError } from "./errorMessages";

describe("describeError", () => {
  it("maps error.cannot_deliver_out_of_stock to a readable sentence (Finding #12)", () => {
    // P2 gave this sentence the product name, which the error has always carried
    // as `{product}` and this surface used to drop. Passed the bare key with no
    // figures, it behaves the way `t()` does everywhere else in this repo: a
    // template it cannot fill is left intact rather than half-substituted.
    expect(describeError("error.cannot_deliver_out_of_stock")).toBe(
      "{product} has no stock reserved and can't be delivered automatically — refund or credit the buyer instead.",
    );
  });

  it("maps error.order_not_processing to a readable sentence (Finding #13)", () => {
    expect(describeError("error.order_not_processing")).toBe(
      "This order is no longer awaiting fulfilment — it may have already been processed.",
    );
  });

  it("maps error.rate_limited to a readable sentence (whole-branch review I-2 — payments 429s used to show the raw i18n key)", () => {
    expect(describeError("error.rate_limited")).toBe(
      "You're doing that too quickly — wait a minute and try again.",
    );
  });

  it("maps error.denomination_has_stock_history to a readable sentence", () => {
    expect(describeError("error.denomination_has_stock_history")).toBe(
      "This item has stock history and cannot be deleted; deactivate it instead.",
    );
  });

  it("maps the five credit-to-balance refusals to readable sentences", () => {
    expect(describeError("error.transfer_already_used")).toBe(
      "This transfer has already been matched, credited, or dismissed, or belongs to another order, so it can't be credited here. Refresh the page to see the current state.",
    );
    expect(
      describeError(
        Object.assign(new Error("error.payment_currency_mismatch"), {
          errorArgs: { paymentCurrency: "USDT", orderCurrency: "IDR" },
        }),
      ),
    ).toBe("This payment's currency (USDT) does not match the order's currency (IDR), so it can't be applied to this order.");
    expect(describeError("error.already_credited")).toBe(
      "This order's payment has already been credited to the buyer's balance, so nothing was handed over a second time. Refresh the page to see the current state.",
    );
    expect(describeError("error.order_already_refunded")).toBe(
      "This cancelled order has already been refunded, so its payment can't also be credited to balance. Refresh the page to see the current state.",
    );
    expect(describeError("error.order_never_paid")).toBe(
      "This cancelled order was never paid, so there's nothing to credit to the buyer's balance. Refresh the page to see the current state.",
    );
  });

  it("falls back to the raw string for an unknown key, so it's always safe to wrap any e.message", () => {
    expect(describeError("error.some_unmapped_key")).toBe("error.some_unmapped_key");
    expect(describeError("Failed to load")).toBe("Failed to load");
  });

  // ---------------------------------------------------------------------------
  // P2: the figures a refusal carries.
  // ---------------------------------------------------------------------------

  it("reads the key and figures off an Error, not just a message string", () => {
    const err = Object.assign(new Error("error.cannot_deliver_out_of_stock"), {
      errorArgs: { product: "Mobile Legends 86 Diamonds" },
    });
    expect(describeError(err)).toBe(
      "Mobile Legends 86 Diamonds has no stock reserved and can't be delivered automatically — refund or credit the buyer instead.",
    );
  });

  it("renders a mapped sentence unchanged when the error carries no figures", () => {
    // The many messages that name no placeholder must read byte-identically
    // whether they arrive as a string or as an Error.
    const err = new Error("error.order_not_processing");
    expect(describeError(err)).toBe(describeError("error.order_not_processing"));
  });

  it("names the request an admin has to go and resolve", () => {
    const err = Object.assign(new Error("error.stock_replacement_already_open"), {
      errorArgs: { existingId: "412" },
    });
    // Without the id the old sentence sent the admin looking for a request it
    // would not name — this one is the whole point of carrying args here.
    expect(describeError(err)).toContain("#412");
  });

  it("quotes the money left in a refusal about money", () => {
    const err = Object.assign(new Error("error.refund_exceeds_refundable_amount"), {
      errorArgs: { refundable: "18500", currency: "IDR", alreadyPaidOut: "0", attempted: "25000" },
    });
    const text = describeError(err);
    expect(text).toContain("18500");
    expect(text).toContain("IDR");
  });

  it("leaves a template intact when a figure it names is missing, rather than printing half a sentence", () => {
    const err = Object.assign(new Error("error.refund_exceeds_refundable_amount"), {
      errorArgs: { refundable: "18500" }, // no `currency`
    });
    expect(describeError(err)).toBe(describeError("error.refund_exceeds_refundable_amount"));
  });

  it("appends an unmapped key's figures so a refusal nobody wrote copy for still says the number", () => {
    // The settlement and ledger keys are the live example: rich `{grossAmount}`
    // /`{netAmount}` copy on the storefront side, no hand-written admin
    // sentence, and the admin needs to know which of three numbers is wrong.
    const err = Object.assign(new Error("error.settlement_amounts_inconsistent"), {
      errorArgs: { netAmount: "900000", feeAmount: "23500", grossAmount: "1000000", currency: "IDR" },
    });
    expect(describeError(err)).toBe(
      "error.settlement_amounts_inconsistent (netAmount: 900000, feeAmount: 23500, grossAmount: 1000000, currency: IDR)",
    );
  });

  it("uses the caller's fallback when the failure carries no message of its own", () => {
    // Replaces the `e instanceof Error ? e.message : "Failed to …"` ternary the
    // call sites used to write out by hand.
    expect(describeError({ notAnError: true }, "Failed to delete product.")).toBe("Failed to delete product.");
    expect(describeError(null, "Failed to delete product.")).toBe("Failed to delete product.");
    expect(describeError(undefined)).toBe("Something went wrong. Please try again.");
  });

  it("ignores an errorArgs that is not a flat map of strings", () => {
    for (const hostile of [["product", "x"], "product=x", { product: { nested: true } }, null]) {
      const err = Object.assign(new Error("error.cannot_deliver_out_of_stock"), { errorArgs: hostile });
      expect(describeError(err)).toBe(describeError("error.cannot_deliver_out_of_stock"));
    }
  });
});

// Audit A5 follow-up: the refusals of the three ways out of an order
// unresolved at Digiflazz (check now, mark delivered, mark failed) and of Reject
// on an order still in flight there. Every throw site passes `orderCode`.
describe("describeError — unresolved at the supplier", () => {
  const withCode = (key: string) => Object.assign(new Error(key), { errorArgs: { orderCode: "ORD-7" } });

  it("maps the two required-note refusals", () => {
    expect(describeError("error.digiflazz_failure_note_required")).toBe(
      "Write down what Digiflazz confirmed about this order before marking it as failed.",
    );
    expect(describeError("error.digiflazz_delivery_note_required")).toBe(
      "Write down what Digiflazz confirmed about this order before marking it as delivered.",
    );
  });

  it("maps the state refusals with the order code", () => {
    expect(describeError(withCode("error.digiflazz_not_unresolved"))).toBe(
      "This action is only available for order ORD-7 while it is unresolved at Digiflazz. Refresh the page to see the current state.",
    );
    expect(describeError(withCode("error.digiflazz_check_in_flight"))).toBe(
      "A status check for order ORD-7 is running with Digiflazz right now. Try again in a minute.",
    );
    expect(describeError(withCode("error.digiflazz_not_configured"))).toBe(
      "Digiflazz is not connected, so order ORD-7 can't be checked right now. Add the Digiflazz credentials in Settings first.",
    );
  });

  it("maps the refusal Mark delivered gets for an order with no usable Digiflazz item", () => {
    expect(describeError("error.order_not_digiflazz")).toBe(
      "This order isn't a single-item Digiflazz order, so it can't be delivered through Digiflazz. If Digiflazz confirmed it was not delivered, mark it failed instead; otherwise check its product's supplier code.",
    );
  });

  it("says the in-flight lock covers credit and Reject alike", () => {
    expect(describeError(withCode("error.order_in_flight_at_supplier"))).toBe(
      "Order ORD-7 is still waiting for the supplier's result, so it can't be credited or rejected until that status is final. Refresh the page to see the current state.",
    );
  });
});
