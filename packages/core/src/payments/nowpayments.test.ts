import { createHmac } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyIpn, getPaymentStatus, createInvoice } from "./nowpayments";

const CREDS = { apiKey: "API-KEY", ipnSecret: "ipn-s3cr3t" };
const FULL_CREDS = { apiKey: "API-KEY", ipnSecret: "ipn-s3cr3t", payCurrency: "usdttrc20" };

function stubFetchJson(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => payload,
    }),
  );
}

/**
 * Independent re-implementation of recursive alphabetical key-sorting, written
 * separately from `nowpayments.ts`'s internal `sortKeysDeep` so the mandatory
 * regression test below isn't just calling the same code it's supposed to be
 * checking. Used only to build the "expected" signature in the test fixture.
 */
function independentSortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(independentSortKeysDeep);
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      out[key] = independentSortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return out;
  }
  return obj;
}

/** Build a correct signature the same way the implementation should: sort keys
 * recursively, JSON.stringify, HMAC-SHA512 with the ipn secret. */
function makeSignature(body: Record<string, unknown>) {
  return createHmac("sha512", CREDS.ipnSecret).update(JSON.stringify(independentSortKeysDeep(body))).digest("hex");
}

describe("verifyIpn", () => {
  it("returns null when the signature header is missing", () => {
    expect(verifyIpn({ order_id: "ORD-1", payment_status: "finished" }, undefined, CREDS)).toBeNull();
  });

  it("returns null when the signature is wrong", () => {
    const body = { order_id: "ORD-1", payment_status: "finished", payment_id: "PID-1", actually_paid: 10 };
    expect(verifyIpn(body, "deadbeef", CREDS)).toBeNull();
  });

  it("verifies a correctly signed payload and normalizes fields", () => {
    const body = {
      order_id: "ORD-1",
      payment_status: "finished",
      payment_id: "PID-1",
      actually_paid: 10.5,
    };
    const sig = makeSignature(body);
    const result = verifyIpn(body, sig, CREDS);
    expect(result).not.toBeNull();
    expect(result?.orderId).toBe("ORD-1");
    expect(result?.trxId).toBe("PID-1");
    expect(result?.paid).toBe(true);
    expect(result?.status).toBe("finished");
    expect(result?.amount.toFixed(2)).toBe("10.50");
  });

  it("marks a non-finished status as not paid", () => {
    const body = { order_id: "ORD-2", payment_status: "waiting", payment_id: "PID-2", pay_amount: 5 };
    const sig = makeSignature(body);
    const result = verifyIpn(body, sig, CREDS);
    expect(result).not.toBeNull();
    expect(result?.paid).toBe(false);
    expect(result?.status).toBe("waiting");
  });

  /**
   * MANDATORY regression test (per task brief): hand/independently-compute the
   * HMAC-SHA512 over a fixture whose keys are DELIBERATELY out of alphabetical
   * order in the literal, including a nested object that is also unsorted.
   * This proves the implementation actually sorts (recursively) before hashing
   * rather than hashing whatever key order the JS engine happens to iterate in.
   */
  it("verifies a signature computed independently over a manually-sorted fixture with deliberately unsorted keys", () => {
    // Deliberately unsorted at both levels: {c, a, b} and nested {z, y}.
    const body: Record<string, unknown> = {
      payment_status: "finished",
      order_id: "ORD-XYZ",
      payment_id: "PID-999",
      actually_paid: 42,
      extra: { z: 1, y: 2 },
    };

    // Independently (NOT calling sortKeysDeep) construct the expected sorted
    // JSON string by hand, mirroring alphabetical key order at every level:
    // top-level sorted: actually_paid, extra, order_id, payment_id, payment_status
    // nested "extra" sorted: y, z
    const handSortedJson =
      '{"actually_paid":42,"extra":{"y":2,"z":1},"order_id":"ORD-XYZ","payment_id":"PID-999","payment_status":"finished"}';
    const independentSignature = createHmac("sha512", CREDS.ipnSecret).update(handSortedJson).digest("hex");

    const result = verifyIpn(body, independentSignature, CREDS);
    expect(result).not.toBeNull();
    expect(result?.orderId).toBe("ORD-XYZ");
    expect(result?.trxId).toBe("PID-999");
    expect(result?.paid).toBe(true);

    // Sanity-check the hand-sorted string itself matches the independent
    // sorter, so a typo in the literal above can't silently invalidate the test.
    expect(JSON.stringify(independentSortKeysDeep(body))).toBe(handSortedJson);
  });
});

describe("createInvoice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns normalized invoice info on a happy path", async () => {
    stubFetchJson({ id: "INV-1", invoice_url: "https://nowpayments.io/payment/INV-1" });
    const r = await createInvoice(FULL_CREDS, {
      orderId: "ORD-1",
      amountUsd: "9.99",
      ipnCallbackUrl: "https://example.com/ipn",
    });
    expect(r.invoiceId).toBe("INV-1");
    expect(r.invoiceUrl).toBe("https://nowpayments.io/payment/INV-1");
  });

  it("accepts a numeric id in the response", async () => {
    stubFetchJson({ id: 12345, invoice_url: "https://nowpayments.io/payment/12345" });
    const r = await createInvoice(FULL_CREDS, {
      orderId: "ORD-2",
      amountUsd: "1.00",
      ipnCallbackUrl: "https://example.com/ipn",
    });
    expect(r.invoiceId).toBe("12345");
  });

  it("throws on a non-2xx HTTP response", async () => {
    stubFetchJson({}, { ok: false, status: 500 });
    await expect(
      createInvoice(FULL_CREDS, { orderId: "ORD-3", amountUsd: "1.00", ipnCallbackUrl: "https://example.com/ipn" }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws when the response is missing id or invoice_url", async () => {
    stubFetchJson({ invoice_url: "https://nowpayments.io/payment/x" });
    await expect(
      createInvoice(FULL_CREDS, { orderId: "ORD-4", amountUsd: "1.00", ipnCallbackUrl: "https://example.com/ipn" }),
    ).rejects.toThrow(/missing id/);

    stubFetchJson({ id: "INV-5" });
    await expect(
      createInvoice(FULL_CREDS, { orderId: "ORD-5", amountUsd: "1.00", ipnCallbackUrl: "https://example.com/ipn" }),
    ).rejects.toThrow(/missing invoice_url/);
  });
});

describe("getPaymentStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports paid for a finished payment status", async () => {
    stubFetchJson({ payment_status: "finished", payment_id: "PID-1", actually_paid: 10 });
    const r = await getPaymentStatus(FULL_CREDS, { invoiceId: "INV-1" });
    expect(r.paid).toBe(true);
    expect(r.trxId).toBe("PID-1");
    expect(r.amount.toFixed(0)).toBe("10");
    expect(r.status).toBe("finished");
  });

  it("reports not paid for a waiting payment status", async () => {
    stubFetchJson({ payment_status: "waiting", payment_id: "PID-2", pay_amount: 5 });
    const r = await getPaymentStatus(FULL_CREDS, { invoiceId: "INV-2" });
    expect(r.paid).toBe(false);
    expect(r.status).toBe("waiting");
  });

  it("throws on a non-2xx HTTP response", async () => {
    stubFetchJson({}, { ok: false, status: 404 });
    await expect(getPaymentStatus(FULL_CREDS, { invoiceId: "INV-3" })).rejects.toThrow(/HTTP 404/);
  });
});
