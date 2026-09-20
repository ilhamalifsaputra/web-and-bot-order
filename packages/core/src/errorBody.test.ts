import { describe, it, expect } from "vitest";
import { Decimal } from "./money";
import { AppError, ValidationError } from "./errors";
import { errorBody } from "./errorBody";

/**
 * These pin the behaviour the storefront relied on before the helper moved here
 * (whole-branch review F4a), because web-admin now depends on exactly the same
 * two promises: a body only grows `error_args` when the copy really asked for a
 * figure, and nothing reaches a page that a `{placeholder}` substitution would
 * render as gibberish.
 */
describe("errorBody", () => {
  it("sends the key alone when the message names no placeholder", () => {
    // "This field is required." — no braces anywhere in the copy.
    expect(errorBody(new ValidationError("error.field_required"))).toEqual({
      error: "error.field_required",
    });
  });

  it("carries the figures the message's own copy names", () => {
    const e = new ValidationError("error.amount_below_rail_minimum", {
      min: new Decimal("100000"),
      currency: "IDR",
    });
    expect(errorBody(e)).toEqual({
      error: "error.amount_below_rail_minimum",
      error_args: { min: "100000", currency: "IDR" },
    });
  });

  it("drops args the copy never mentions", () => {
    // `error.field_required` is thrown with the offending field's key and names
    // no placeholder at all — a developer-facing detail with no business in a
    // response a page renders.
    expect(errorBody(new ValidationError("error.field_required", { field: "email" }))).toEqual({
      error: "error.field_required",
    });
  });

  it("keeps only the named subset when an error carries extra args", () => {
    const e = new ValidationError("error.cart_too_large", { limit: 50, cartId: 7 });
    expect(errorBody(e)).toEqual({
      error: "error.cart_too_large",
      error_args: { limit: "50" },
    });
  });

  it("renders a Decimal as the digits an admin typed, not as an object", () => {
    const e = new ValidationError("error.voucher_min_purchase", { min: new Decimal("25000.50") });
    expect(errorBody(e).error_args).toEqual({ min: "25000.5" });
  });

  it("drops a value no substitution could render", () => {
    const e = new ValidationError("error.cart_too_large", { limit: { nested: true } });
    expect(errorBody(e)).toEqual({ error: "error.cart_too_large" });
  });

  it("drops null and undefined rather than printing them", () => {
    const e = new ValidationError("error.cart_too_large", { limit: null });
    expect(errorBody(e)).toEqual({ error: "error.cart_too_large" });
  });

  it("adds nothing for a key that has no copy at all", () => {
    // `t()` returns the key itself, which has no braces to find — so the page
    // shows the bare key, exactly as it did before this helper existed.
    const e = new AppError("error.no_such_message_exists", { min: 5 });
    expect(errorBody(e)).toEqual({ error: "error.no_such_message_exists" });
  });
});
