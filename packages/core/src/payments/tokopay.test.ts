import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyCallback, checkTransaction } from "./tokopay";

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
  });
});
