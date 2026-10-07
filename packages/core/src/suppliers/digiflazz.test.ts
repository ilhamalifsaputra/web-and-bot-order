import { createHash, createHmac } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getPriceList,
  createTransaction,
  verifyWebhook,
  parseProductRegion,
  stripRegionSuffix,
  digiflazzGroupKey,
  DigiflazzRequestError,
  classifyDigiflazzHttpStatus,
  isRetryableDigiflazzErrorKind,
  type DigiflazzRequestErrorKind,
} from "./digiflazz";
import { logger } from "../logger";

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

/** Digiflazz's real scheme: `X-Hub-Signature: sha1=<hex>`, HMAC-SHA1 of the
 * RAW request body keyed by the dashboard-configured webhook secret. */
function hubSignature(rawBody: string | Buffer, secret = WEBHOOK_SECRET) {
  return `sha1=${createHmac("sha1", secret).update(rawBody).digest("hex")}`;
}

/** The real prepaid webhook payload shape (developer.digiflazz.com/api/buyer/webhook). */
function webhookBody(data: Record<string, unknown> = {}) {
  return JSON.stringify({
    data: {
      ref_id: "ORD-100",
      customer_no: "123456789",
      buyer_sku_code: "ml100",
      message: "Sukses",
      status: "Sukses",
      rc: "00",
      buyer_last_saldo: 0,
      sn: "SN-XYZ",
      price: 199800,
      ...data,
    },
  });
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

describe("createTransaction error classification (DigiflazzRequestError)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function caught(): Promise<DigiflazzRequestError> {
    try {
      await createTransaction(CREDS, { refId: "ORD-C", buyerSkuCode: "ML86", customerNo: "1" });
    } catch (err) {
      expect(err).toBeInstanceOf(DigiflazzRequestError);
      expect(err).toBeInstanceOf(Error);
      return err as DigiflazzRequestError;
    }
    throw new Error("createTransaction was expected to throw");
  }

  function timeoutError(): Error {
    const err = new Error(`aborted while sending apiKey=${CREDS.apiKey}`);
    err.name = "TimeoutError";
    return err;
  }

  const httpCases: Array<[number, DigiflazzRequestErrorKind, boolean]> = [
    [400, "http_4xx", false],
    [401, "http_4xx", false],
    [403, "http_4xx", false],
    [404, "http_4xx", false],
    [422, "http_4xx", false],
    [429, "http_429", true],
    [500, "http_5xx", true],
    [502, "http_5xx", true],
    [503, "http_5xx", true],
    [504, "http_5xx", true],
  ];

  it.each(httpCases)("HTTP %i is kind %s with retryable=%s and a static message", async (status, kind, retryable) => {
    stubFetchJson({}, { ok: false, status });
    const err = await caught();
    expect(err.kind).toBe(kind);
    expect(err.retryable).toBe(retryable);
    expect(err.httpStatus).toBe(status);
    expect(err.message).toBe(`Digiflazz transaction HTTP ${status}`);
  });

  it("a request that hits the deadline is kind timeout and retryable, with the old static message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutError()));
    const err = await caught();
    expect(err.kind).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("Digiflazz transaction timed out");
    expect(err.message).not.toContain(CREDS.apiKey);
    expect(err.cause).toBeUndefined();
  });

  it("a fetch() rejection is kind network and retryable, and never carries the original error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`ECONNRESET apiKey=${CREDS.apiKey}`)));
    const err = await caught();
    expect(err.kind).toBe("network");
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("Digiflazz transaction network error");
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain(CREDS.apiKey);
  });

  it("a body read that stalls past the deadline is kind timeout and retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw timeoutError(); } }),
    );
    const err = await caught();
    expect(err.kind).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("Digiflazz transaction response body read timed out");
  });

  it("a malformed body is kind unparseable and retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
    );
    const err = await caught();
    expect(err.kind).toBe("unparseable");
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("Digiflazz transaction returned an unparseable response");
  });

  it("a response with no transaction data is kind rejected and retryable (as uncertain as an unparseable body)", async () => {
    stubFetchJson({ data: null });
    const err = await caught();
    expect(err.kind).toBe("rejected");
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("Digiflazz transaction rejected: missing data in response");
  });

  it("getPriceList throws the same typed error, so the catalog sync keeps its messages", async () => {
    stubFetchJson({}, { ok: false, status: 503 });
    const err = await getPriceList(CREDS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DigiflazzRequestError);
    expect((err as DigiflazzRequestError).kind).toBe("http_5xx");
    expect((err as Error).message).toBe("Digiflazz price list HTTP 503");
  });
});

describe("classifyDigiflazzHttpStatus / isRetryableDigiflazzErrorKind", () => {
  it("maps statuses and kinds the same way createTransaction does", () => {
    expect(classifyDigiflazzHttpStatus(429)).toBe("http_429");
    expect(classifyDigiflazzHttpStatus(500)).toBe("http_5xx");
    expect(classifyDigiflazzHttpStatus(599)).toBe("http_5xx");
    expect(classifyDigiflazzHttpStatus(400)).toBe("http_4xx");
    expect(classifyDigiflazzHttpStatus(451)).toBe("http_4xx");
    for (const kind of ["timeout", "network", "http_5xx", "http_429", "unparseable", "rejected"] as const) {
      expect(isRetryableDigiflazzErrorKind(kind)).toBe(true);
    }
    for (const kind of ["http_4xx"] as const) {
      expect(isRetryableDigiflazzErrorKind(kind)).toBe(false);
    }
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

  const VALID_ROW = {
    product_name: "Mobile Legends 86 Diamonds",
    category: "Games",
    brand: "Mobile Legends",
    type: "Umum",
    buyer_sku_code: "ML86",
    price: 15750,
    buyer_product_status: true,
    seller_product_status: true,
    stock: 999,
  };

  it("skips a row with a non-finite (NaN) price but keeps the valid row alongside it", async () => {
    stubFetchJson({
      data: [VALID_ROW, { ...VALID_ROW, buyer_sku_code: "ML999", price: "NaN" }],
    });
    const list = await getPriceList(CREDS);
    expect(list).toHaveLength(1);
    expect(list[0]?.buyerSkuCode).toBe("ML86");
  });

  it("skips a row with price 0", async () => {
    stubFetchJson({
      data: [{ ...VALID_ROW, buyer_sku_code: "ML0", price: 0 }],
    });
    const list = await getPriceList(CREDS);
    expect(list).toEqual([]);
  });

  it("skips a row with a negative price", async () => {
    stubFetchJson({
      data: [{ ...VALID_ROW, buyer_sku_code: "MLNEG", price: -500 }],
    });
    const list = await getPriceList(CREDS);
    expect(list).toEqual([]);
  });

  it("skips a row with an Infinity price", async () => {
    stubFetchJson({
      data: [{ ...VALID_ROW, buyer_sku_code: "MLINF", price: "Infinity" }],
    });
    const list = await getPriceList(CREDS);
    expect(list).toEqual([]);
  });

  it("logs one warning naming the count of skipped rows, not one per row", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    stubFetchJson({
      data: [
        VALID_ROW,
        { ...VALID_ROW, buyer_sku_code: "ML0", price: 0 },
        { ...VALID_ROW, buyer_sku_code: "MLNEG", price: -500 },
      ],
    });
    await getPriceList(CREDS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("2"));
    warnSpy.mockRestore();
  });
});

describe("verifyWebhook", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a normalized payload for a correctly signed Sukses delivery", () => {
    const raw = webhookBody();
    const result = verifyWebhook(WEBHOOK_SECRET, raw, hubSignature(raw));
    expect(result).not.toBeNull();
    expect(result?.refId).toBe("ORD-100");
    expect(result?.status).toBe("Sukses");
    expect(result?.sn).toBe("SN-XYZ");
    expect(result?.message).toBe("Sukses");
    expect(result?.price?.toFixed(0)).toBe("199800");
  });

  it("accepts the raw body as a Buffer and an upper-case hex digest", () => {
    const raw = Buffer.from(webhookBody({ status: "Pending", sn: "" }));
    const hex = hubSignature(raw).slice("sha1=".length).toUpperCase();
    const result = verifyWebhook(WEBHOOK_SECRET, raw, `sha1=${hex}`);
    expect(result?.refId).toBe("ORD-100");
    expect(result?.status).toBe("Pending");
    expect(result?.sn).toBeNull();
  });

  it("normalizes a Gagal delivery with its failure reason", () => {
    const raw = webhookBody({ ref_id: "ORD-102", status: "Gagal", message: "Stok kosong", sn: "" });
    const result = verifyWebhook(WEBHOOK_SECRET, raw, hubSignature(raw));
    expect(result?.status).toBe("Gagal");
    expect(result?.message).toBe("Stok kosong");
    expect(result?.sn).toBeNull();
  });

  it("rejects a body signed with a different secret", () => {
    const raw = webhookBody();
    expect(verifyWebhook(WEBHOOK_SECRET, raw, hubSignature(raw, "someone-elses-secret"))).toBeNull();
  });

  it("rejects a body changed after signing (the signature covers the raw bytes, not the parsed JSON)", () => {
    const raw = webhookBody({ status: "Pending" });
    const header = hubSignature(raw);
    expect(verifyWebhook(WEBHOOK_SECRET, raw.replace("Pending", "Sukses"), header)).toBeNull();
    // A whitespace-only re-serialization is a different byte string too.
    expect(verifyWebhook(WEBHOOK_SECRET, JSON.stringify(JSON.parse(raw), null, 2), header)).toBeNull();
  });

  it("rejects a missing, empty or garbage signature header", () => {
    const raw = webhookBody();
    expect(verifyWebhook(WEBHOOK_SECRET, raw, undefined)).toBeNull();
    expect(verifyWebhook(WEBHOOK_SECRET, raw, "")).toBeNull();
    expect(verifyWebhook(WEBHOOK_SECRET, raw, "sha1=")).toBeNull();
    expect(verifyWebhook(WEBHOOK_SECRET, raw, "sha1=not-hex-at-all")).toBeNull();
    expect(verifyWebhook(WEBHOOK_SECRET, raw, `${hubSignature(raw)}00`)).toBeNull();
    expect(verifyWebhook(WEBHOOK_SECRET, raw, hubSignature(raw).slice(0, -2))).toBeNull();
  });

  it("rejects a correct digest that is not prefixed with sha1=", () => {
    const raw = webhookBody();
    const hex = hubSignature(raw).slice("sha1=".length);
    expect(verifyWebhook(WEBHOOK_SECRET, raw, hex)).toBeNull();
    expect(verifyWebhook(WEBHOOK_SECRET, raw, `sha256=${hex}`)).toBeNull();
  });

  it("rejects everything when no webhook secret is configured, even a body signed with an empty key", () => {
    const raw = webhookBody();
    expect(verifyWebhook("", raw, hubSignature(raw, ""))).toBeNull();
  });

  it("rejects a correctly signed body that has no data.ref_id or is not JSON", () => {
    const noRef = JSON.stringify({ data: { status: "Sukses" } });
    expect(verifyWebhook(WEBHOOK_SECRET, noRef, hubSignature(noRef))).toBeNull();
    // The old invented flat shape, with no `data` wrapper.
    const flat = JSON.stringify({ ref_id: "ORD-1", status: "Sukses" });
    expect(verifyWebhook(WEBHOOK_SECRET, flat, hubSignature(flat))).toBeNull();
    const notJson = "ref_id=ORD-1";
    expect(verifyWebhook(WEBHOOK_SECRET, notJson, hubSignature(notJson))).toBeNull();
  });

  it("never logs the secret, the signature or the body when it rejects", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const raw = webhookBody({ ref_id: "ORD-SECRETIVE" });
    const badHeader = hubSignature(raw, "wrong");
    verifyWebhook(WEBHOOK_SECRET, raw, badHeader);
    verifyWebhook(WEBHOOK_SECRET, raw, undefined);
    expect(warn).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(WEBHOOK_SECRET);
    expect(logged).not.toContain(badHeader.slice("sha1=".length));
    expect(logged).not.toContain("ORD-SECRETIVE");
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

  // Task 13 cutover: this function is now a thin wrapper delegating its
  // denylist decision to the Detection Engine's extractFeatures() against
  // DEFAULT_KNOWLEDGE_BASE (packages/core/src/detection). These cases add
  // coverage the pre-cutover regex-only implementation didn't exercise.
  it("returns null for multi-digit duration ranges (engine-backed denylist)", () => {
    expect(parseProductRegion("Foo (10-20 Menit)")).toBeNull();
    expect(parseProductRegion("Foo (12-24 Jam)")).toBeNull();
  });

  it("returns a parenthetical suffix verbatim, whether or not it matches a known region token", () => {
    expect(parseProductRegion("Foo (Russia)")).toBe("Russia");
    expect(parseProductRegion("Foo (Singapore)")).toBe("Singapore");
  });

  it("returns null for a duration range with no space before the unit word (review fix regression)", () => {
    // "1-3Menit" (unit glued to the second number) normalizes to "1 3menit";
    // the pre-fix DURATION_RANGE_PATTERN required a mandatory space before
    // the unit and missed this, so parseProductRegion returned "1-3Menit"
    // instead of null. See detection/features.ts's DURATION_RANGE_PATTERN.
    expect(parseProductRegion("Foo (1-3Menit)")).toBeNull();
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

  // Task 13 cutover: parseProductRegion (which this function delegates to)
  // is now engine-backed — a multi-digit duration range must still be
  // treated as denylisted noise, not a region, so nothing gets stripped.
  it("does not strip a multi-digit duration range (engine-backed denylist)", () => {
    expect(stripRegionSuffix("Foo (10-20 Menit)")).toBe("Foo (10-20 Menit)");
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

  // Task 13 cutover: end-to-end through the engine-backed parseProductRegion
  // for a multi-digit duration range — must still collapse to region: null,
  // displayName === brand, exactly like the pre-cutover regex.
  it("returns region: null for a multi-digit duration range (engine-backed denylist)", () => {
    const result = digiflazzGroupKey("Bar", "Bar (10-20 Menit)");
    expect(result.region).toBeNull();
    expect(result.displayName).toBe("Bar");
  });
});
