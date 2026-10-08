/**
 * Every rail's "is this paid?" mapping, pinned in one place (Task E7).
 *
 * The cases that matter most here are the NEGATIVE ones. A mapping that wrongly
 * says "paid" delivers goods for money that never arrived, and no other test in
 * this repo would catch it: the rail tests all feed a status their own adapter
 * already agreed was paid. So each rail below asserts both the values that
 * settle and the near-misses that must not — NOWPayments' `confirmed`/`sending`
 * (which sound final and are not), its `partially_paid` (which sounds close
 * enough and would deliver goods for an underpayment), and the Bybit integer
 * that means Success on one ledger and Failed on the other.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeProviderStatus,
  isProviderPaid,
  StatusProvider,
  PROVIDERS_WITHOUT_STATUS,
} from "./paymentStatus";

describe("TokoPay and PayDisini", () => {
  const idrGateways = [StatusProvider.TOKOPAY, StatusProvider.PAYDISINI] as const;

  it.each(idrGateways)("%s settles on every value in the shared paid list", (provider) => {
    // Including the two Indonesian ones. TokoPay's webhook once carried a copy
    // of this list missing `lunas`/`berhasil`, so the same payment settled or
    // not depending on which path saw it first (Task E4, 37668a9).
    for (const paid of ["paid", "success", "completed", "settlement", "lunas", "berhasil"]) {
      expect(normalizeProviderStatus(provider, paid)).toBe("paid");
    }
  });

  it.each(idrGateways)("%s is case- and whitespace-insensitive, as the adapters were", (provider) => {
    expect(normalizeProviderStatus(provider, "  PAID  ")).toBe("paid");
    expect(normalizeProviderStatus(provider, "Success")).toBe("paid");
  });

  it.each(idrGateways)("%s does not settle on anything else", (provider) => {
    for (const notPaid of ["pending", "unpaid", "belum bayar", "processing", "waiting", "refunded"]) {
      expect(normalizeProviderStatus(provider, notPaid)).not.toBe("paid");
    }
  });

  it.each(idrGateways)("%s reports terminal outcomes as themselves, not as pending", (provider) => {
    expect(normalizeProviderStatus(provider, "expired")).toBe("expired");
    expect(normalizeProviderStatus(provider, "failed")).toBe("failed");
    expect(normalizeProviderStatus(provider, "cancelled")).toBe("failed");
    expect(normalizeProviderStatus(provider, "gagal")).toBe("failed");
  });
});

describe("NOWPayments", () => {
  it("settles only on an exact `finished`", () => {
    expect(normalizeProviderStatus(StatusProvider.NOWPAYMENTS, "finished")).toBe("paid");
  });

  it("does NOT settle on the statuses that sound final but are not", () => {
    // `confirmed` and `sending` both mean the funds have not landed in the
    // merchant account yet. `partially_paid` is an underpayment, and treating
    // it as paid would hand over goods the buyer did not fully pay for.
    for (const notYet of ["waiting", "confirming", "confirmed", "sending", "partially_paid"]) {
      expect(normalizeProviderStatus(StatusProvider.NOWPAYMENTS, notYet)).not.toBe("paid");
    }
  });

  it("classifies its terminal non-success outcomes", () => {
    expect(normalizeProviderStatus(StatusProvider.NOWPAYMENTS, "failed")).toBe("failed");
    expect(normalizeProviderStatus(StatusProvider.NOWPAYMENTS, "refunded")).toBe("failed");
    expect(normalizeProviderStatus(StatusProvider.NOWPAYMENTS, "partially_paid")).toBe("underpaid");
    expect(normalizeProviderStatus(StatusProvider.NOWPAYMENTS, "expired")).toBe("expired");
  });

  it("treats the in-flight statuses as pending, so a later cycle retries", () => {
    expect(normalizeProviderStatus(StatusProvider.NOWPAYMENTS, "waiting")).toBe("pending");
    expect(normalizeProviderStatus(StatusProvider.NOWPAYMENTS, "confirming")).toBe("detected");
    expect(normalizeProviderStatus(StatusProvider.NOWPAYMENTS, "confirmed")).toBe("verifying");
    expect(normalizeProviderStatus(StatusProvider.NOWPAYMENTS, "sending")).toBe("verifying");
  });
});

// THE test this module exists for. Same exchange, same API credential, same
// ledger table — opposite meanings for the same integer.
describe("the Bybit inversion", () => {
  it("reads 2 as Success on the internal-transfer ledger and NOT on the on-chain one", () => {
    expect(normalizeProviderStatus(StatusProvider.BYBIT_INTERNAL, 2)).toBe("paid");
    expect(normalizeProviderStatus(StatusProvider.BYBIT_BSC, 2)).not.toBe("paid");
  });

  it("reads 3 as Success on the on-chain ledger and as FAILED on the internal-transfer one", () => {
    expect(normalizeProviderStatus(StatusProvider.BYBIT_BSC, 3)).toBe("paid");
    expect(normalizeProviderStatus(StatusProvider.BYBIT_INTERNAL, 3)).toBe("failed");
  });

  it("settles on nothing else, on either rail", () => {
    for (const status of [0, 1, 4, 5, 99, -1]) {
      expect(normalizeProviderStatus(StatusProvider.BYBIT_INTERNAL, status)).not.toBe("paid");
      expect(normalizeProviderStatus(StatusProvider.BYBIT_BSC, status)).not.toBe("paid");
    }
  });

  it("refuses a numeric STRING — a Bybit status that arrived as text is a response we do not understand", () => {
    expect(normalizeProviderStatus(StatusProvider.BYBIT_INTERNAL, "2")).toBe("pending");
    expect(normalizeProviderStatus(StatusProvider.BYBIT_BSC, "3")).toBe("pending");
  });
});

describe("malformed and missing statuses", () => {
  const everyProvider = Object.values(StatusProvider);

  it.each(everyProvider)("%s never settles on null, undefined or empty", (provider) => {
    for (const raw of [null, undefined, "", "   "]) {
      expect(normalizeProviderStatus(provider, raw)).toBe("pending");
    }
  });

  it.each(everyProvider)("%s falls back to pending on an unrecognised value, never failed", (provider) => {
    // `pending` means "come back next cycle". Mapping the unknown to `failed`
    // would let one garbled gateway response strand a buyer who really paid.
    expect(normalizeProviderStatus(provider, "something-nobody-has-seen")).toBe("pending");
  });
});

describe("isProviderPaid", () => {
  it("agrees with normalizeProviderStatus on every rail", () => {
    expect(isProviderPaid(StatusProvider.TOKOPAY, "lunas")).toBe(true);
    expect(isProviderPaid(StatusProvider.NOWPAYMENTS, "confirmed")).toBe(false);
    expect(isProviderPaid(StatusProvider.BYBIT_INTERNAL, 2)).toBe(true);
    expect(isProviderPaid(StatusProvider.BYBIT_BSC, 2)).toBe(false);
  });
});

describe("rails with no provider status", () => {
  it("names Binance Internal as having none, rather than leaving it silently absent", () => {
    // Its confirmation is decided entirely by OUR matching — the order code in
    // the transfer note, or the unique amount. There is no gateway status to
    // normalise, and inventing one would be a lie this module refuses to tell.
    expect(PROVIDERS_WITHOUT_STATUS).toContain("BINANCE_INTERNAL");
    expect(Object.keys(StatusProvider)).not.toContain("BINANCE_INTERNAL");
  });
});
