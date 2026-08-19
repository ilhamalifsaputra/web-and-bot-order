import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getPriceList,
  createTransaction,
  verifyCallback,
  parseProductRegion,
  stripRegionSuffix,
  digiflazzGroupKey,
} from "./digiflazz";

const CREDS = { username: "shop01", apiKey: "s3cr3t-key" };
const WEBHOOK_SECRET = "wh-s3cr3t";

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

function makeCallbackSignature(refId: string) {
  return createHash("md5").update(`${refId}:${WEBHOOK_SECRET}`).digest("hex");
}

describe("createTransaction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns Sukses with a serial number on a successful top-up", async () => {
    stubFetchJson({
      data: {
        ref_id: "ORD-1",
        buyer_sku_code: "ML86",
        customer_no: "12345678",
        status: "Sukses",
        message: "Transaksi Sukses",
        sn: "SN-ABC-123",
        price: 15000,
        rc: "00",
      },
    });
    const r = await createTransaction(CREDS, { refId: "ORD-1", buyerSkuCode: "ML86", customerNo: "12345678" });
    expect(r.status).toBe("Sukses");
    expect(r.sn).toBe("SN-ABC-123");
    expect(r.refId).toBe("ORD-1");
    expect(r.price?.toFixed(0)).toBe("15000");
  });

  it("returns Pending when the supplier has not settled the order yet", async () => {
    stubFetchJson({
      data: {
        ref_id: "ORD-2",
        buyer_sku_code: "ML86",
        customer_no: "12345678",
        status: "Pending",
        message: "Transaksi sedang diproses",
        sn: null,
      },
    });
    const r = await createTransaction(CREDS, { refId: "ORD-2", buyerSkuCode: "ML86", customerNo: "12345678" });
    expect(r.status).toBe("Pending");
    expect(r.sn).toBeNull();
  });

  it("returns Gagal with a reason when the supplier rejects the top-up", async () => {
    stubFetchJson({
      data: {
        ref_id: "ORD-3",
        buyer_sku_code: "ML86",
        customer_no: "00000",
        status: "Gagal",
        message: "Nomor tujuan tidak valid",
        rc: "40",
      },
    });
    const r = await createTransaction(CREDS, { refId: "ORD-3", buyerSkuCode: "ML86", customerNo: "00000" });
    expect(r.status).toBe("Gagal");
    expect(r.message).toBe("Nomor tujuan tidak valid");
  });

  it("treats an unrecognised status as Pending rather than assuming success or failure", async () => {
    stubFetchJson({
      data: { ref_id: "ORD-4", status: "Diproses", message: "?" },
    });
    const r = await createTransaction(CREDS, { refId: "ORD-4", buyerSkuCode: "ML86", customerNo: "1" });
    expect(r.status).toBe("Pending");
  });

  it("sends the ref_id-bound signature and the credentials in the POST body, not the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { ref_id: "ORD-5", status: "Pending" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await createTransaction(CREDS, { refId: "ORD-5", buyerSkuCode: "ML86", customerNo: "1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).not.toContain(CREDS.apiKey);
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.username).toBe(CREDS.username);
    expect(sentBody.ref_id).toBe("ORD-5");
    expect(sentBody.sign).toBe(
      createHash("md5").update(`${CREDS.username}${CREDS.apiKey}ORD-5`).digest("hex"),
    );
  });

  it("bounds the request so a hung supplier cannot stall checkout forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { ref_id: "ORD-6", status: "Sukses", sn: "SN-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await createTransaction(CREDS, { refId: "ORD-6", buyerSkuCode: "ML86", customerNo: "1" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never leaks the API-key-bearing request body when fetch() itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`fetch failed: request carrying apiKey=${CREDS.apiKey} failed`)),
    );
    let caught: unknown;
    try {
      await createTransaction(CREDS, { refId: "ORD-7", buyerSkuCode: "ML86", customerNo: "1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/network error/);
    expect(message).not.toContain(CREDS.apiKey);
  });

  it("throws on a non-2xx HTTP response without leaking the request body", async () => {
    stubFetchJson({}, { ok: false, status: 502 });
    await expect(
      createTransaction(CREDS, { refId: "ORD-8", buyerSkuCode: "ML86", customerNo: "1" }),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("throws when the response carries no data payload", async () => {
    stubFetchJson({ data: null });
    await expect(
      createTransaction(CREDS, { refId: "ORD-9", buyerSkuCode: "ML86", customerNo: "1" }),
    ).rejects.toThrow(/rejected/);
  });
});

describe("getPriceList", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses the supplier's SKU/price list, keeping price as Decimal", async () => {
    stubFetchJson({
      data: [
        {
          product_name: "Mobile Legends 86 Diamonds",
          category: "Games",
          brand: "Mobile Legends",
          type: "Umum",
          buyer_sku_code: "ML86",
          price: 15750,
          buyer_product_status: true,
          seller_product_status: true,
          stock: 999,
        },
      ],
    });
    const list = await getPriceList(CREDS);
    expect(list).toHaveLength(1);
    expect(list[0]?.buyerSkuCode).toBe("ML86");
    expect(list[0]?.price.toFixed(0)).toBe("15750");
    expect(list[0]?.buyerProductStatus).toBe(true);
  });

  it("returns an empty list rather than throwing when the supplier sends no data array", async () => {
    stubFetchJson({ data: null });
    const list = await getPriceList(CREDS);
    expect(list).toEqual([]);
  });

  it("signs the price-list request with the fixed 'pricelist' command signature", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getPriceList(CREDS);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.sign).toBe(
      createHash("md5").update(`${CREDS.username}${CREDS.apiKey}pricelist`).digest("hex"),
    );
  });
});

describe("verifyCallback", () => {
  it("returns a normalized payload on a valid signature", () => {
    const refId = "ORD-100";
    const body = {
      ref_id: refId,
      signature: makeCallbackSignature(refId),
      status: "Sukses",
      sn: "SN-XYZ",
      message: "Transaksi Sukses",
      price: "15000",
    };
    const result = verifyCallback(WEBHOOK_SECRET, body);
    expect(result).not.toBeNull();
    expect(result?.refId).toBe(refId);
    expect(result?.status).toBe("Sukses");
    expect(result?.sn).toBe("SN-XYZ");
    expect(result?.price?.toFixed(0)).toBe("15000");
  });

  it("returns null when the signature is wrong", () => {
    const body = { ref_id: "ORD-101", signature: "not-the-right-signature", status: "Sukses" };
    expect(verifyCallback(WEBHOOK_SECRET, body)).toBeNull();
  });

  it("returns null when ref_id or signature is missing", () => {
    expect(verifyCallback(WEBHOOK_SECRET, { signature: makeCallbackSignature("x") })).toBeNull();
    expect(verifyCallback(WEBHOOK_SECRET, { ref_id: "x" })).toBeNull();
  });

  it("normalizes a Gagal callback with its failure reason", () => {
    const refId = "ORD-102";
    const body = {
      ref_id: refId,
      signature: makeCallbackSignature(refId),
      status: "Gagal",
      message: "Stok kosong",
    };
    const result = verifyCallback(WEBHOOK_SECRET, body);
    expect(result?.status).toBe("Gagal");
    expect(result?.message).toBe("Stok kosong");
    expect(result?.sn).toBeNull();
  });
});

describe("parseProductRegion", () => {
  it("returns null when there are no parens at all", () => {
    expect(parseProductRegion("Mobile Legends 86 Diamonds")).toBeNull();
    expect(parseProductRegion("Foo Bar")).toBeNull();
    expect(parseProductRegion("")).toBeNull();
  });

  it("extracts a real region suffix like (Filipina)", () => {
    expect(parseProductRegion("Mobile Legends 22 Diamonds (Filipina)")).toBe("Filipina");
    expect(parseProductRegion("Foo (Indonesia)")).toBe("Indonesia");
    expect(parseProductRegion("Product (Brazil)")).toBe("Brazil");
  });

  it("returns null for denylisted annotations (case-insensitive)", () => {
    expect(parseProductRegion("Foo (Instant)")).toBeNull();
    expect(parseProductRegion("Foo (INSTANT)")).toBeNull();
    expect(parseProductRegion("Foo (instant)")).toBeNull();
    expect(parseProductRegion("Foo (Proses Cepat)")).toBeNull();
    expect(parseProductRegion("Foo (PROSES CEPAT)")).toBeNull();
    expect(parseProductRegion("Foo (proses cepat)")).toBeNull();
  });

  it("returns null for duration patterns like (1-3 Menit)", () => {
    expect(parseProductRegion("Foo (1-3 Menit)")).toBeNull();
    expect(parseProductRegion("Foo (2-4 Menit)")).toBeNull();
    expect(parseProductRegion("Foo (1-2 Jam)")).toBeNull();
    expect(parseProductRegion("Foo (1-7 Hari)")).toBeNull();
    expect(parseProductRegion("Foo (1-3 menit)")).toBeNull();
    expect(parseProductRegion("Foo (1-3 JAM)")).toBeNull();
  });

  it("considers only the trailing parenthetical in a multi-paren string", () => {
    expect(parseProductRegion("Foo (Bar) (Indonesia)")).toBe("Indonesia");
    expect(parseProductRegion("A (B) (C) (Filipina)")).toBe("Filipina");
  });

  it("handles whitespace edge cases correctly", () => {
    expect(parseProductRegion("Foo   (Indonesia)")).toBe("Indonesia");
    expect(parseProductRegion("Foo(Indonesia)")).toBe("Indonesia");
    expect(parseProductRegion("Foo (Indonesia)   ")).toBe("Indonesia");
    expect(parseProductRegion("Foo   (Indonesia)   ")).toBe("Indonesia");
  });

  it("trims whitespace from the captured region", () => {
    expect(parseProductRegion("Foo ( Indonesia )")).toBe("Indonesia");
    expect(parseProductRegion("Foo (  Filipina  )")).toBe("Filipina");
  });
});

describe("stripRegionSuffix", () => {
  it("returns the input unchanged when there are no parens", () => {
    expect(stripRegionSuffix("Mobile Legends 86 Diamonds")).toBe("Mobile Legends 86 Diamonds");
    expect(stripRegionSuffix("Foo Bar")).toBe("Foo Bar");
  });

  it("strips a real region suffix", () => {
    expect(stripRegionSuffix("Mobile Legends 22 Diamonds (Filipina)")).toBe("Mobile Legends 22 Diamonds");
    expect(stripRegionSuffix("Foo (Indonesia)")).toBe("Foo");
  });

  it("returns the input unchanged for denylisted annotations", () => {
    expect(stripRegionSuffix("Foo (Instant)")).toBe("Foo (Instant)");
    expect(stripRegionSuffix("Foo (INSTANT)")).toBe("Foo (INSTANT)");
    expect(stripRegionSuffix("Foo (1-3 Menit)")).toBe("Foo (1-3 Menit)");
    expect(stripRegionSuffix("Foo (Proses Cepat)")).toBe("Foo (Proses Cepat)");
  });

  it("only strips the trailing group in multi-paren strings", () => {
    expect(stripRegionSuffix("Foo (Bar) (Indonesia)")).toBe("Foo (Bar)");
    expect(stripRegionSuffix("A (B) (C) (Filipina)")).toBe("A (B) (C)");
  });

  it("preserves whitespace when not stripping", () => {
    expect(stripRegionSuffix("Foo   (Instant)")).toBe("Foo   (Instant)");
    expect(stripRegionSuffix("Foo   (1-3 Menit)")).toBe("Foo   (1-3 Menit)");
  });

  it("handles whitespace edge cases when stripping", () => {
    expect(stripRegionSuffix("Foo   (Indonesia)")).toBe("Foo");
    expect(stripRegionSuffix("Foo(Indonesia)")).toBe("Foo");
    expect(stripRegionSuffix("Foo (Indonesia)   ")).toBe("Foo");
  });

  // Finding 5 (final whole-branch review): a productName that is ENTIRELY a
  // parenthetical strips down to an empty string, which would then become an
  // empty name/durationLabel and an empty ensureUniqueSlug base — must return
  // the original, unstripped string instead of "".
  it("returns the original string, not an empty string, when the whole name is a parenthetical", () => {
    expect(stripRegionSuffix("(Indonesia)")).toBe("(Indonesia)");
    expect(stripRegionSuffix("   (Indonesia)   ")).toBe("   (Indonesia)   ");
    expect(stripRegionSuffix("(Filipina)")).toBe("(Filipina)");
  });
});

describe("digiflazzGroupKey", () => {
  it("returns region: null and displayName === brand when no parens are present", () => {
    const result = digiflazzGroupKey("Mobile Legends", "Mobile Legends 86 Diamonds");
    expect(result.brand).toBe("Mobile Legends");
    expect(result.region).toBeNull();
    expect(result.displayName).toBe("Mobile Legends");
  });

  it("extracts region and builds displayName from a real region suffix", () => {
    const result = digiflazzGroupKey("Mobile Legends", "Mobile Legends 22 Diamonds (Filipina)");
    expect(result.brand).toBe("Mobile Legends");
    expect(result.region).toBe("Filipina");
    expect(result.displayName).toBe("Mobile Legends (Filipina)");
  });

  it("returns region: null for denylisted annotations", () => {
    const result1 = digiflazzGroupKey("Foo", "Foo (Instant)");
    expect(result1.region).toBeNull();
    expect(result1.displayName).toBe("Foo");

    const result2 = digiflazzGroupKey("Bar", "Bar (1-3 Menit)");
    expect(result2.region).toBeNull();
    expect(result2.displayName).toBe("Bar");
  });

  it("uses only the trailing group in multi-paren strings", () => {
    const result = digiflazzGroupKey("Product", "Product (Bar) (Indonesia)");
    expect(result.region).toBe("Indonesia");
    expect(result.displayName).toBe("Product (Indonesia)");
  });

  it("is deterministic across the same inputs", () => {
    const input1 = digiflazzGroupKey("ML", "Mobile Legends (Filipina)");
    const input2 = digiflazzGroupKey("ML", "Mobile Legends (Filipina)");
    expect(input1.region).toBe(input2.region);
    expect(input1.displayName).toBe(input2.displayName);
  });
});
