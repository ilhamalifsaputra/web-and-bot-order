import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyCallback } from "./tokopay";

const CREDS = { merchantId: "MERCH", secret: "s3cr3t" };

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
