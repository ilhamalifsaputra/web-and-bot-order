import { describe, it, expect } from "vitest";
import { gatewayLedgerTrxId } from "./ledgerKey";

describe("gatewayLedgerTrxId", () => {
  it("uses the gateway's own transaction id when the live status call returned one", () => {
    expect(gatewayLedgerTrxId("TRX-9", "ORD-1")).toBe("TRX-9");
  });

  // The whole point of the helper: the webhook route and the reconcile poller
  // call it with the same two inputs for the same payment, so they can never
  // claim two different UNIQUE ledger rows.
  it("falls back to the order code — the ref_id we handed the gateway — when it returned none", () => {
    for (const missing of [null, undefined, "", "   "]) {
      expect(gatewayLedgerTrxId(missing, "ORD-1")).toBe("ORD-1");
    }
  });

  it("never returns a blank key, which would poison the ledger's UNIQUE row for every later payment", () => {
    expect(gatewayLedgerTrxId(null, "ORD-1")).not.toBe("");
    expect(gatewayLedgerTrxId("  ", "ORD-1")).not.toBe("");
  });

  it("is deterministic — two calls about the same payment agree", () => {
    expect(gatewayLedgerTrxId(null, "ORD-42")).toBe(gatewayLedgerTrxId(null, "ORD-42"));
  });

  it("trims a padded gateway id rather than keying the ledger on whitespace", () => {
    expect(gatewayLedgerTrxId("  TRX-9  ", "ORD-1")).toBe("TRX-9");
  });
});
