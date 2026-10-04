import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyCallback, checkTransaction, createTransaction, RateLimitedError } from "./paydisini";

const CREDS = { userKey: "USERKEY", apiKey: "s3cr3tapikey" };
const FULL_CREDS = { userKey: "USERKEY", apiKey: "s3cr3tapikey", channel: "QRIS" };

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

function makeSignature(refId: string, amount: string) {
  return createHash("md5").update(`${CREDS.apiKey}:${CREDS.userKey}:${refId}:${amount}`).digest("hex");
}

describe("verifyCallback", () => {
  it("returns a normalized payload on a valid signature", () => {
    const refId = "ORD-001";
    const body = {
      ref_id: refId,
      signature: makeSignature(refId, "100000"),
      unique_code: "TRX-XYZ",
      amount: "100000",
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
      amount: "100000",
      status: "success",
    };
    expect(verifyCallback(body, CREDS)).toBeNull();
  });

  it("returns null when ref_id or signature is missing", () => {
    expect(verifyCallback({ signature: makeSignature("x", "0") }, CREDS)).toBeNull();
    expect(verifyCallback({ ref_id: "x" }, CREDS)).toBeNull();
  });

  it("marks status 'failed' as not paid", () => {
    const refId = "ORD-002";
    const body = {
      ref_id: refId,
      signature: makeSignature(refId, "50000"),
      amount: "50000",
      status: "failed",
    };
    const result = verifyCallback(body, CREDS);
    expect(result).not.toBeNull();
    expect(result?.paid).toBe(false);
  });
});

describe("checkTransaction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports paid for a settled gateway status", async () => {
    stubFetchJson({ success: true, data: { status: "Paid", unique_code: "TRX-1", amount: "100000" } });
    const r = await checkTransaction(FULL_CREDS, { refId: "ORD-1", amountIdr: 100000 });
    expect(r.paid).toBe(true);
    expect(r.trxId).toBe("TRX-1");
    expect(r.amount.toFixed(0)).toBe("100000");
  });

  it("reports not paid for an unpaid status (numeric API status ok)", async () => {
    stubFetchJson({ status: 200, data: { status: "Unpaid", unique_code: "TRX-2" } });
    const r = await checkTransaction(FULL_CREDS, { refId: "ORD-2", amountIdr: 50000 });
    expect(r.paid).toBe(false);
    expect(r.unverified).toBe(false);
    expect(r.trxId).toBe("TRX-2");
  });

  // Task B3b (backend audit): falling back to the REQUESTED amount made every
  // short-payment check downstream pass by construction — the amount being
  // checked was the one we asked about. No amount from the gateway means the
  // payment is not verified: report it unpaid so nothing is delivered on it.
  it("reports NOT paid (unverified) when the gateway omits the amount, instead of echoing the requested one", async () => {
    stubFetchJson({ success: true, data: { status: "berhasil" } });
    const r = await checkTransaction(FULL_CREDS, { refId: "ORD-3", amountIdr: 12345 });
    expect(r.paid).toBe(false);
    expect(r.amount.toFixed(0)).toBe("0");
    expect(r.unverified).toBe(true);
    expect(r.trxId).toBeNull();
  });

  it("reports NOT paid (unverified) when the gateway's amount does not parse", async () => {
    stubFetchJson({ success: true, data: { status: "berhasil", amount: "lots" } });
    const r = await checkTransaction(FULL_CREDS, { refId: "ORD-3b", amountIdr: 12345 });
    expect(r.paid).toBe(false);
    expect(r.amount.toFixed(0)).toBe("0");
    expect(r.unverified).toBe(true);
  });

  it("throws when the gateway rejects the request", async () => {
    stubFetchJson({ success: false, status: "error", msg: "nope" });
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
    expect((err as Error).message).toBe("PayDisini status HTTP 429");
  });

  it("never leaks the api-key-bearing query string when fetch() itself rejects (M-15)", async () => {
    // Simulate a network-level failure (DNS/connection/TLS) whose error object
    // — as Node's fetch sometimes does — echoes the failed request URL back on
    // its message/cause. If that raw error (or an unhandled rejection carrying
    // it) ever reached a logger, the api key in the query string would leak.
    // checkTransaction must catch it and rethrow a sanitized error.
    const secretUrl = `https://api.paydisini.co.id/v1/transaction?user_key=${FULL_CREDS.userKey}&api_key=${FULL_CREDS.apiKey}&ref_id=ORD-6`;
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
    expect(message).not.toContain(FULL_CREDS.apiKey);
    expect(message).not.toContain("http");
  });

  it("never leaks the api-key-bearing query string when the response body is unparseable JSON (M-15)", async () => {
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
    expect(message).not.toContain(FULL_CREDS.apiKey);
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
    expect(message).not.toContain(FULL_CREDS.apiKey);
  });

  it("checkTransaction bounds the request so a hung gateway cannot stall the reconcile poller forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { status: "Paid", unique_code: "TRX-8" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await checkTransaction(FULL_CREDS, { refId: "ORD-8", amountIdr: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never leaks the api-key-bearing query string when the request times out", async () => {
    // Simulate what AbortSignal.timeout produces: fetch() rejects with a
    // DOMException named "TimeoutError" once the deadline elapses.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })),
    );
    let caught: unknown;
    try {
      await checkTransaction(FULL_CREDS, { refId: "ORD-9", amountIdr: 1000 });
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
    expect(message).not.toContain(FULL_CREDS.apiKey);
    expect(message).not.toContain("http");
  });
});

describe("createTransaction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns normalized order info on a happy path", async () => {
    stubFetchJson({
      success: true,
      data: {
        unique_code: "TRX-100",
        qr_string: "00020101...",
        qr_url: "https://paydisini.example/qr/TRX-100.png",
        checkout_url: "https://paydisini.example/pay/TRX-100",
        amount: "75000",
      },
    });
    const r = await createTransaction(FULL_CREDS, { refId: "ORD-10", amountIdr: 75000 });
    expect(r.trxId).toBe("TRX-100");
    expect(r.qrString).toBe("00020101...");
    expect(r.qrUrl).toBe("https://paydisini.example/qr/TRX-100.png");
    expect(r.checkoutUrl).toBe("https://paydisini.example/pay/TRX-100");
    expect(r.totalBayar).toBe("75000");
  });

  it("throws on a non-2xx HTTP response", async () => {
    stubFetchJson({}, { ok: false, status: 500 });
    await expect(createTransaction(FULL_CREDS, { refId: "ORD-11", amountIdr: 1000 })).rejects.toThrow(/HTTP 500/);
  });

  it("throws when the gateway rejects the request", async () => {
    stubFetchJson({ success: false, status: "error", msg: "invalid api key" });
    await expect(createTransaction(FULL_CREDS, { refId: "ORD-12", amountIdr: 1000 })).rejects.toThrow(/rejected/);
  });

  it("never leaks the api-key-bearing query string when fetch() itself rejects (M-15)", async () => {
    const secretUrl = `https://api.paydisini.co.id/v1/transaction?user_key=${FULL_CREDS.userKey}&api_key=${FULL_CREDS.apiKey}&ref_id=ORD-13`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`fetch failed: request to ${secretUrl} failed, reason: ECONNREFUSED`)),
    );
    let caught: unknown;
    try {
      await createTransaction(FULL_CREDS, { refId: "ORD-13", amountIdr: 1000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/network error/);
    expect(message).not.toContain(FULL_CREDS.apiKey);
    expect(message).not.toContain("http");
  });

  it("bounds the request so a hung gateway cannot stall checkout forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { unique_code: "TRX-14" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await createTransaction(FULL_CREDS, { refId: "ORD-14", amountIdr: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
