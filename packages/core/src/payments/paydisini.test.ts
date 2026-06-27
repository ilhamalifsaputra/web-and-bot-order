import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyCallback, checkTransaction, createTransaction } from "./paydisini";

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
    expect(r.trxId).toBe("TRX-2");
  });

  it("falls back to the requested amount when the gateway omits one", async () => {
    stubFetchJson({ success: true, data: { status: "berhasil" } });
    const r = await checkTransaction(FULL_CREDS, { refId: "ORD-3", amountIdr: 12345 });
    expect(r.paid).toBe(true);
    expect(r.amount.toFixed(0)).toBe("12345");
    expect(r.trxId).toBeNull();
  });

  it("throws when the gateway rejects the request", async () => {
    stubFetchJson({ success: false, status: "error", msg: "nope" });
    await expect(checkTransaction(FULL_CREDS, { refId: "ORD-4", amountIdr: 1000 })).rejects.toThrow(/rejected/);
  });

  it("throws on a non-2xx HTTP response", async () => {
    stubFetchJson({}, { ok: false, status: 502 });
    await expect(checkTransaction(FULL_CREDS, { refId: "ORD-5", amountIdr: 1000 })).rejects.toThrow(/HTTP 502/);
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
});
