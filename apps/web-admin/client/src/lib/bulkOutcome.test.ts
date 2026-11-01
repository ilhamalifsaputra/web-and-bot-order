import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  bulkFailureLines,
  bulkOutcomeKind,
  bulkOutcomeMessage,
  sendSequentially,
  toastBulkOutcome,
  withoutSucceeded,
} from "./bulkOutcome";

const ROWS = { done: "Deleted", noun: "voucher" };

describe("bulkOutcomeKind", () => {
  it("is success only when every item succeeded", () => {
    expect(bulkOutcomeKind({ ...ROWS, succeeded: 3, failed: 0 })).toBe("success");
  });
  it("is warning when some succeeded and some did not", () => {
    expect(bulkOutcomeKind({ ...ROWS, succeeded: 1, failed: 2 })).toBe("warning");
    expect(bulkOutcomeKind({ ...ROWS, succeeded: 1, failed: 0, notAttempted: 2 })).toBe("warning");
  });
  it("is error when nothing succeeded", () => {
    expect(bulkOutcomeKind({ ...ROWS, succeeded: 0, failed: 3 })).toBe("error");
    expect(bulkOutcomeKind({ ...ROWS, succeeded: 0, failed: 0, notAttempted: 3 })).toBe("error");
  });
});

describe("bulkOutcomeMessage", () => {
  it("states the counts", () => {
    expect(bulkOutcomeMessage({ ...ROWS, succeeded: 1, failed: 0 })).toBe("Deleted 1 voucher.");
    expect(bulkOutcomeMessage({ ...ROWS, succeeded: 3, failed: 0 })).toBe("Deleted 3 vouchers.");
    expect(bulkOutcomeMessage({ ...ROWS, succeeded: 1, failed: 2 })).toBe("Deleted 1 of 3 vouchers — 2 failed.");
    expect(bulkOutcomeMessage({ ...ROWS, succeeded: 0, failed: 1 })).toBe("Deleted 0 of 1 voucher — 1 failed.");
    expect(bulkOutcomeMessage({ ...ROWS, succeeded: 1, failed: 1, notAttempted: 2 })).toBe(
      "Deleted 1 of 4 vouchers — 1 failed, 2 not attempted.",
    );
  });
  it("uses the caller's wording only when everything succeeded", () => {
    const report = { ...ROWS, allDone: "Voucher deleted." };
    expect(bulkOutcomeMessage({ ...report, succeeded: 1, failed: 0 })).toBe("Voucher deleted.");
    expect(bulkOutcomeMessage({ ...report, succeeded: 0, failed: 1 })).toBe("Deleted 0 of 1 voucher — 1 failed.");
  });
});

describe("toastBulkOutcome", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(toast, "success");
    vi.spyOn(toast, "warning");
    vi.spyOn(toast, "error");
  });

  it("raises exactly one toast of the matching kind", () => {
    toastBulkOutcome({ ...ROWS, succeeded: 2, failed: 0 });
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    toastBulkOutcome({ ...ROWS, succeeded: 1, failed: 1 });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);

    toastBulkOutcome({ ...ROWS, succeeded: 0, failed: 2 });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});

describe("withoutSucceeded", () => {
  it("drops only the ids that succeeded and leaves the input alone", () => {
    const selected = new Set([1, 2, 3]);
    expect(withoutSucceeded(selected, [1, 3])).toEqual(new Set([2]));
    expect(selected).toEqual(new Set([1, 2, 3]));
  });
});

describe("bulkFailureLines", () => {
  it("maps keys through the error helper and fills the figures", () => {
    const lines = bulkFailureLines(
      [
        { id: 1, error: "error.cannot_deliver_out_of_stock", error_args: { product: "Netflix" } },
        { id: 2, error: "error.not_eligible" },
      ],
      (id) => `ORD-${id}`,
    );
    expect(lines[0]).toEqual({ label: "ORD-1", reason: expect.stringContaining("Netflix has no stock") });
    expect(lines[1]!.label).toBe("ORD-2");
    expect(lines[1]!.reason).not.toContain("error.");
  });

  it("has hand-written copy for every key the bulk routes send", () => {
    const keys = ["error.not_eligible", "error.unexpected", "error.order_not_found", "error.order_not_pending_verification", "error.order_is_wallet_topup"];
    for (const key of keys) {
      expect(bulkFailureLines([{ id: 1, error: key }], String)[0]!.reason).not.toContain("error.");
    }
  });
});

describe("sendSequentially", () => {
  it("sends one at a time, in order, and never overlaps", async () => {
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];
    const result = await sendSequentially([1, 2, 3], async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(n);
      await Promise.resolve();
      inFlight -= 1;
    }, () => false);
    expect(order).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
    expect(result).toEqual({ succeeded: [1, 2, 3], failed: [], stopped: null, notAttempted: [] });
  });

  it("carries on past an ordinary failure", async () => {
    const boom = new Error("nope");
    const send = vi.fn(async (n: number) => { if (n === 2) throw boom; });
    const result = await sendSequentially([1, 2, 3], send, () => false);
    expect(send).toHaveBeenCalledTimes(3);
    expect(result.succeeded).toEqual([1, 3]);
    expect(result.failed).toEqual([{ item: 2, error: boom }]);
    expect(result.stopped).toBeNull();
  });

  it("stops at the first item the predicate calls a stop, and reports it and the rest as not attempted", async () => {
    const limit = Object.assign(new Error("error.rate_limited"), { status: 429 });
    const send = vi.fn(async (n: number) => { if (n === 2) throw limit; });
    const result = await sendSequentially([1, 2, 3, 4], send, (e) => (e as { status?: number }).status === 429);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ succeeded: [1], failed: [], stopped: limit, notAttempted: [2, 3, 4] });
  });
});
