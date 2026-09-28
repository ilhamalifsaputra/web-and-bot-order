import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyCallback, checkTransaction, createTransaction, computeQrisAdminFee, qrisChargeAmount, RateLimitedError } from "./tokopay";

const CREDS = { merchantId: "MERCH", secret: "s3cr3t" };
const FULL_CREDS = { merchantId: "MERCH", secret: "s3cr3t", channel: "QRIS" };

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

function makeSignature(refId: string) {
  return createHash("md5").update(`${CREDS.merchantId}:${CREDS.secret}:${refId}`).digest("hex");
}

describe("verifyCallback", () => {
  it("returns a normalized payload on a valid signature", () => {
    const refId = "ORD-001";
    const body = {
      ref_id: refId,
      signature: makeSignature(refId),
      trx_id: "TRX-XYZ",
      nominal: "100000",
      status: "success",
    };
    const result = verifyCallback(body, CREDS);
    expect(result).not.toBeNull();
    expect(result?.refId).toBe(refId);
    expect(result?.trxId).toBe("TRX-XYZ");
    expect(result?.paid).toBe(true);
    expect(result?.amount.toFixed(0)).toBe("100000");
  });

  it("returns null when the signature is wrong", () => {
    const body = {
      ref_id: "ORD-001",
      signature: "badsignature",
      nominal: "100000",
      status: "success",
    };
    expect(verifyCallback(body, CREDS)).toBeNull();
  });

  it("returns null when ref_id or signature is missing", () => {
    expect(verifyCallback({ signature: makeSignature("x") }, CREDS)).toBeNull();
    expect(verifyCallback({ ref_id: "x" }, CREDS)).toBeNull();
  });

  // The webhook used to carry its own inline paid-status list without the two
  // Indonesian values, so TokoPay reporting a settled transaction as `lunas`
  // or `berhasil` was honoured by the reconcile poller (`checkTransaction`)
  // and rejected here — one payment, two answers, decided by whichever path
  // happened to see it. Both now read the same PAID_STATES constant.
  it.each(["lunas", "berhasil", "settlement", "completed", "paid", "success"])(
    "accepts '%s' as paid, exactly like checkTransaction's own status check does",
    (status) => {
      const refId = `ORD-PAIDSTATE-${status}`;
      const result = verifyCallback(
        { ref_id: refId, signature: makeSignature(refId), nominal: "50000", status },
        CREDS,
      );
      expect(result?.paid).toBe(true);
    },
  );

  it("still treats an unlisted status as not paid, whatever its language", () => {
    const refId = "ORD-PAIDSTATE-NEG";
    const sign = makeSignature(refId);
    for (const status of ["pending", "menunggu", "gagal", "expired"]) {
      expect(verifyCallback({ ref_id: refId, signature: sign, nominal: "50000", status }, CREDS)?.paid).toBe(false);
    }
  });

  it("marks status 'failed' as not paid", () => {
    const refId = "ORD-002";
    const body = {
      ref_id: refId,
      signature: makeSignature(refId),
      nominal: "50000",
      status: "failed",
    };
    const result = verifyCallback(body, CREDS);
    expect(result).not.toBeNull();
    expect(result?.paid).toBe(false);
  });
});

describe("computeQrisAdminFee", () => {
  it("is Rp100 flat on a zero amount", () => {
    expect(computeQrisAdminFee(0).toFixed(0)).toBe("100");
  });

  it("adds 0.70% of the amount on top of the flat fee", () => {
    expect(computeQrisAdminFee(10000).toFixed(0)).toBe("170"); // 100 + 70
  });

  it("rounds a .5 fraction half-up to the nearest Rupiah", () => {
    // 500 * 0.007 = 3.5 -> 100 + 3.5 = 103.5 -> 104
    expect(computeQrisAdminFee(500).toFixed(0)).toBe("104");
  });
});

describe("qrisChargeAmount", () => {
  it("adds the fee computed on totalAmount itself to the order total (H-1 fix)", () => {
    // totalAmount=1000 -> fee = 100 + 0.007*1000 = 107
    expect(qrisChargeAmount(1000).toFixed(0)).toBe("1107");
  });

  it("bases the fee on the discounted total, not a separate pre-discount subtotal", () => {
    // A discounted order: gateway only ever sees totalAmount as `nominal`, so
    // the fee it actually adds is 0.7% of totalAmount, never the gross subtotal.
    // totalAmount=500 -> fee = 100 + 0.007*500 = 103.5 -> 104 (half-up)
    expect(qrisChargeAmount(500).toFixed(0)).toBe("604");
  });
});

describe("checkTransaction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports paid for a settled gateway status", async () => {
    stubFetchJson({ status: "Success", data: { status: "Paid", trx_id: "TRX-1", total_bayar: "100000" } });
    const r = await checkTransaction(FULL_CREDS, { refId: "ORD-1", amountIdr: 100000 });
    expect(r.paid).toBe(true);
    expect(r.trxId).toBe("TRX-1");
    expect(r.amount.toFixed(0)).toBe("100000");
  });

  it("reports not paid for an unpaid status (numeric API status ok)", async () => {
    stubFetchJson({ status: 200, data: { status: "Unpaid", trx_id: "TRX-2" } });
    const r = await checkTransaction(FULL_CREDS, { refId: "ORD-2", amountIdr: 50000 });
    expect(r.paid).toBe(false);
    expect(r.trxId).toBe("TRX-2");
  });

  it("falls back to the requested amount when the gateway omits one", async () => {
    stubFetchJson({ status: "success", data: { status: "berhasil" } });
    const r = await checkTransaction(FULL_CREDS, { refId: "ORD-3", amountIdr: 12345 });
    expect(r.paid).toBe(true);
    expect(r.amount.toFixed(0)).toBe("12345");
    expect(r.trxId).toBeNull();
  });

  it("throws when the gateway rejects the request", async () => {
    stubFetchJson({ status: "error", error_msg: "nope" });
    await expect(checkTransaction(FULL_CREDS, { refId: "ORD-4", amountIdr: 1000 })).rejects.toThrow(/rejected/);
  });

  it("throws on a non-2xx HTTP response", async () => {
    stubFetchJson({}, { ok: false, status: 502 });
    await expect(checkTransaction(FULL_CREDS, { refId: "ORD-5", amountIdr: 1000 })).rejects.toThrow(/HTTP 502/);
    // Only a 429 is a rate-limit — any other non-2xx stays a plain Error.
    stubFetchJson({}, { ok: false, status: 502 });
    await expect(checkTransaction(FULL_CREDS, { refId: "ORD-5", amountIdr: 1000 })).rejects.not.toBeInstanceOf(RateLimitedError);
  });

  it("throws RateLimitedError (same message shape) on HTTP 429, so the reconcile poller can back off", async () => {
    stubFetchJson({}, { ok: false, status: 429 });
    const err = await checkTransaction(FULL_CREDS, { refId: "ORD-5b", amountIdr: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("TokoPay status HTTP 429");
  });

  it("never leaks the secret-bearing query string when fetch() itself rejects (M-15)", async () => {
    // Simulate a network-level failure (DNS/connection/TLS) whose error object
    // — as Node's fetch sometimes does — echoes the failed request URL back on
    // its message/cause. If that raw error (or an unhandled rejection carrying
    // it) ever reached a logger, the merchant secret in the query string would
    // leak. checkTransaction must catch it and rethrow a sanitized error.
    const secretUrl = `https://api.tokopay.id/v1/order?merchant=${FULL_CREDS.merchantId}&secret=${FULL_CREDS.secret}&ref_id=ORD-6`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`fetch failed: request to ${secretUrl} failed, reason: ECONNREFUSED`)),
    );
    let caught: unknown;
    try {
      await checkTransaction(FULL_CREDS, { refId: "ORD-6", amountIdr: 1000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/network error/);
    expect(message).not.toContain(FULL_CREDS.secret);
    expect(message).not.toContain("http");
  });

  it("never leaks the secret-bearing query string when the response body is unparseable JSON (M-15)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }),
    );
    let caught: unknown;
    try {
      await checkTransaction(FULL_CREDS, { refId: "ORD-7", amountIdr: 1000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/unparseable/);
    expect(message).not.toContain(FULL_CREDS.secret);
  });

  // AbortSignal.timeout stays attached to the response body in undici
  // (http.ts), so a peer that sends headers and then stalls the body makes
  // res.json() reject with this same TimeoutError shape — a DIFFERENT case
  // from the fetch()-level rejection tested above (that one never gets a
  // response at all). Must not be reported as "unparseable" — that would
  // tell the reconcile poller the gateway sent back garbage, when it
  // actually just hung.
  it("reports a response-body-read timeout distinctly from a genuinely unparseable response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
        },
      }),
    );
    let caught: unknown;
    try {
      await checkTransaction(FULL_CREDS, { refId: "ORD-7B", amountIdr: 1000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/timed out/);
    expect(message).not.toMatch(/unparseable/);
    expect(message).not.toContain(FULL_CREDS.secret);
  });

  it("checkTransaction bounds the request so a hung gateway cannot stall the reconcile poller forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "success", data: { status: "Paid", trx_id: "TRX-8" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await checkTransaction(FULL_CREDS, { refId: "ORD-9", amountIdr: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never leaks the secret-bearing query string when the request times out", async () => {
    // Simulate what AbortSignal.timeout produces: fetch() rejects with a
    // DOMException named "TimeoutError" once the deadline elapses.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })),
    );
    let caught: unknown;
    try {
      await checkTransaction(FULL_CREDS, { refId: "ORD-10", amountIdr: 1000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // Tightened to pin the HttpTimeoutError branch actually running, not just
    // that the message happens to be credential-free either way (Minor 9,
    // Task 3 review follow-up): the old `/timed out|network error/`
    // alternation would still pass if the timeout branch silently stopped
    // firing and this fell through to the generic network-error message.
    expect(message).toMatch(/timed out/);
    expect(message).not.toContain(FULL_CREDS.secret);
    expect(message).not.toContain("http");
  });
});

describe("createTransaction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never leaks the secret-bearing query string when fetch() itself rejects (M-15)", async () => {
    const secretUrl = `https://api.tokopay.id/v1/order?merchant=${FULL_CREDS.merchantId}&secret=${FULL_CREDS.secret}&ref_id=ORD-8`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`fetch failed: request to ${secretUrl} failed, reason: ECONNREFUSED`)),
    );
    let caught: unknown;
    try {
      await createTransaction(FULL_CREDS, { refId: "ORD-8", amountIdr: 1000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/network error/);
    expect(message).not.toContain(FULL_CREDS.secret);
    expect(message).not.toContain("http");
  });

  it("bounds the request so a hung gateway cannot stall checkout forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "success", data: { trx_id: "TRX-9" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await createTransaction(FULL_CREDS, { refId: "ORD-9", amountIdr: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
