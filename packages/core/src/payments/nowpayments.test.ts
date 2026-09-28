import { createHmac } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyIpn, getPaymentStatus, createInvoice, NOWPAYMENTS_IPN_MAX_AGE_MS, RateLimitedError } from "./nowpayments";

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
 * Build a correct signature + matching (rawBody, parsedBody) pair the way
 * NOWPayments actually verifies (Task 2a fix): HMAC-SHA512 over the RAW
 * request body bytes, no re-serialization. `raw` is the literal string that
 * would have gone out over the wire; `body` is `JSON.parse(raw)`, exactly
 * what a Fastify JSON parser hands the route handler.
 */
function signedIpn(raw: string) {
  const signature = createHmac("sha512", CREDS.ipnSecret).update(raw).digest("hex");
  const body = JSON.parse(raw) as Record<string, unknown>;
  return { raw, body, signature };
}

describe("verifyIpn", () => {
  it("returns null when the signature header is missing", () => {
    const { raw, body } = signedIpn('{"order_id":"ORD-1","payment_status":"finished"}');
    expect(verifyIpn(raw, body, undefined, CREDS)).toBeNull();
  });

  it("returns null when the signature is wrong", () => {
    const { raw, body } = signedIpn(
      '{"order_id":"ORD-1","payment_status":"finished","payment_id":"PID-1","actually_paid":10}',
    );
    expect(verifyIpn(raw, body, "deadbeef", CREDS)).toBeNull();
  });

  it("verifies a correctly signed payload and normalizes fields", () => {
    const { raw, body, signature } = signedIpn(
      '{"order_id":"ORD-1","payment_status":"finished","payment_id":"PID-1","actually_paid":10.5}',
    );
    const result = verifyIpn(raw, body, signature, CREDS);
    expect(result).not.toBeNull();
    expect(result?.orderId).toBe("ORD-1");
    expect(result?.trxId).toBe("PID-1");
    expect(result?.paid).toBe(true);
    expect(result?.status).toBe("finished");
    expect(result?.amount.toFixed(2)).toBe("10.50");
  });

  // M-12 (backend audit 2026-07-31): a missing/malformed payment_id must be
  // rejected outright, never normalized to trxId: "" — an empty string would
  // otherwise become a valid (poisoned) idempotency ledger key upstream.
  it("returns null (rejects) when payment_id is missing, even with a correctly signed body", () => {
    const { raw, body, signature } = signedIpn('{"order_id":"ORD-NOPID","payment_status":"finished","actually_paid":10}');
    expect(verifyIpn(raw, body, signature, CREDS)).toBeNull();
  });

  it("returns null (rejects) when payment_id is present but not a string/number (e.g. null, object)", () => {
    const nullPid = signedIpn(
      '{"order_id":"ORD-NULLPID","payment_status":"finished","payment_id":null,"actually_paid":10}',
    );
    expect(verifyIpn(nullPid.raw, nullPid.body, nullPid.signature, CREDS)).toBeNull();

    const objPid = signedIpn(
      '{"order_id":"ORD-OBJPID","payment_status":"finished","payment_id":{"bad":true},"actually_paid":10}',
    );
    expect(verifyIpn(objPid.raw, objPid.body, objPid.signature, CREDS)).toBeNull();
  });

  // A literal "" payment_id passes `typeof x === "string"` — it's a distinct
  // case from "missing"/"malformed" above and must be rejected explicitly,
  // otherwise trxId: "" flows straight through as a valid, ledger-poisoning
  // idempotency key (this was the gap a reviewer caught in the first pass).
  it("returns null (rejects) when payment_id is a literal empty string", () => {
    const { raw, body, signature } = signedIpn(
      '{"order_id":"ORD-EMPTYPID","payment_status":"finished","payment_id":"","actually_paid":10}',
    );
    expect(verifyIpn(raw, body, signature, CREDS)).toBeNull();
  });

  it("still rejects a second, independent IPN missing payment_id — proves there's no shared poisoned state across calls", () => {
    const first = signedIpn('{"order_id":"ORD-NOPID-A","payment_status":"finished","actually_paid":10}');
    const second = signedIpn('{"order_id":"ORD-NOPID-B","payment_status":"finished","actually_paid":20}');
    expect(verifyIpn(first.raw, first.body, first.signature, CREDS)).toBeNull();
    expect(verifyIpn(second.raw, second.body, second.signature, CREDS)).toBeNull();
  });

  it("marks a non-finished status as not paid", () => {
    const { raw, body, signature } = signedIpn(
      '{"order_id":"ORD-2","payment_status":"waiting","payment_id":"PID-2","pay_amount":5}',
    );
    const result = verifyIpn(raw, body, signature, CREDS);
    expect(result).not.toBeNull();
    expect(result?.paid).toBe(false);
    expect(result?.status).toBe("waiting");
  });

  /**
   * MANDATORY regression test (Task 2a): a payload that is byte-identical in
   * MEANING but differently FORMATTED — `1.50` in the raw body vs. what
   * `JSON.parse` then `JSON.stringify` would produce (`1.5`, the trailing
   * zero dropped) — must still verify correctly, because `verifyIpn` now
   * HMACs the raw bytes directly instead of re-serializing.
   *
   * This is exactly the case the OLD `JSON.stringify(sortKeysDeep(body))`
   * approach would have silently broken on: NOWPayments computes its
   * signature over ITS OWN raw bytes (`"10.50"`), so a receiver that hashes
   * `JSON.stringify(JSON.parse(raw))` instead would get `"10.5"` — a
   * different string, a different HMAC, a mismatch — and reject a
   * genuinely-valid, correctly-signed IPN.
   */
  it("verifies a signature computed over raw bytes with a numeric field formatted differently than JSON.stringify would produce (1.50 vs 1.5) — the exact case the old re-serialization approach would have broken", () => {
    // NOWPayments' literal wire bytes: actually_paid keeps a trailing zero.
    const raw = '{"order_id":"ORD-FMT","payment_status":"finished","payment_id":"PID-FMT-1","actually_paid":1.50}';
    const body = JSON.parse(raw) as Record<string, unknown>;

    // Sanity-check the premise: re-serializing what JSON.parse produced does
    // NOT reproduce the original bytes — this is the divergence the fix
    // guards against.
    expect(JSON.stringify(body)).not.toBe(raw);
    expect(JSON.stringify(body)).toContain('"actually_paid":1.5');
    expect(raw).toContain('"actually_paid":1.50');

    // NOWPayments signs the RAW bytes it actually sent.
    const signature = createHmac("sha512", CREDS.ipnSecret).update(raw).digest("hex");

    // Correct (fixed) behavior: hashing the raw bytes verifies.
    const result = verifyIpn(raw, body, signature, CREDS);
    expect(result).not.toBeNull();
    expect(result?.trxId).toBe("PID-FMT-1");
    expect(result?.paid).toBe(true);
    expect(result?.amount.toFixed(2)).toBe("1.50");

    // Regression guard: the OLD approach (re-serializing the parsed body via
    // JSON.stringify before hashing, key-sorted or not) would have computed
    // a DIFFERENT digest than NOWPayments' own signature over `raw`, since
    // JSON.stringify(JSON.parse("1.50")) === "1.5", not "1.50". Prove that
    // divergence directly so this test would have failed loud against the
    // reverted implementation.
    const oldStyleDigest = createHmac("sha512", CREDS.ipnSecret).update(JSON.stringify(body)).digest("hex");
    expect(oldStyleDigest).not.toBe(signature);
  });

  it("rejects when the raw body was tampered with even though the parsed body still looks valid (proves the hash covers the real bytes, not a derived view)", () => {
    const raw = '{"order_id":"ORD-TAMPER","payment_status":"finished","payment_id":"PID-TAMPER-1","actually_paid":10}';
    const signature = createHmac("sha512", CREDS.ipnSecret).update(raw).digest("hex");
    // Attacker (or a proxy re-encoding the body) changes the amount but the
    // signature header travels with the ORIGINAL raw bytes' digest.
    const tamperedRaw = raw.replace('"actually_paid":10', '"actually_paid":999999');
    const tamperedBody = JSON.parse(tamperedRaw) as Record<string, unknown>;
    expect(verifyIpn(tamperedRaw, tamperedBody, signature, CREDS)).toBeNull();
  });

  // Task 2b: reject a signature-valid IPN whose own updated_at/created_at
  // timestamp is older than the 5-minute replay window.
  describe("replay window", () => {
    const NOW = Date.parse("2026-08-25T12:00:00.000Z");

    it("accepts a payload whose updated_at is within the 5-minute window", () => {
      const fresh = new Date(NOW - 60_000).toISOString(); // 1 minute old
      const { raw, body, signature } = signedIpn(
        `{"order_id":"ORD-FRESH","payment_status":"finished","payment_id":"PID-FRESH","actually_paid":10,"updated_at":"${fresh}"}`,
      );
      const result = verifyIpn(raw, body, signature, CREDS, NOW);
      expect(result).not.toBeNull();
      expect(result?.trxId).toBe("PID-FRESH");
    });

    it("rejects a payload whose updated_at is older than the 5-minute window, even with a correct signature", () => {
      const stale = new Date(NOW - NOWPAYMENTS_IPN_MAX_AGE_MS - 1_000).toISOString(); // 5m01s old
      const { raw, body, signature } = signedIpn(
        `{"order_id":"ORD-STALE","payment_status":"finished","payment_id":"PID-STALE","actually_paid":10,"updated_at":"${stale}"}`,
      );
      expect(verifyIpn(raw, body, signature, CREDS, NOW)).toBeNull();
    });

    it("accepts a payload exactly at the window boundary (not yet older than the window)", () => {
      const boundary = new Date(NOW - NOWPAYMENTS_IPN_MAX_AGE_MS).toISOString(); // exactly 5m old
      const { raw, body, signature } = signedIpn(
        `{"order_id":"ORD-BOUNDARY","payment_status":"finished","payment_id":"PID-BOUNDARY","actually_paid":10,"updated_at":"${boundary}"}`,
      );
      expect(verifyIpn(raw, body, signature, CREDS, NOW)).not.toBeNull();
    });

    it("falls back to created_at when updated_at is absent", () => {
      const stale = new Date(NOW - NOWPAYMENTS_IPN_MAX_AGE_MS - 1_000).toISOString();
      const { raw, body, signature } = signedIpn(
        `{"order_id":"ORD-CREATED","payment_status":"finished","payment_id":"PID-CREATED","actually_paid":10,"created_at":"${stale}"}`,
      );
      expect(verifyIpn(raw, body, signature, CREDS, NOW)).toBeNull();
    });

    it("prefers updated_at over created_at when both are present", () => {
      // created_at is stale (invoice opened long ago) but updated_at (the
      // latest status transition) is fresh — must not be rejected.
      const staleCreated = new Date(NOW - NOWPAYMENTS_IPN_MAX_AGE_MS * 10).toISOString();
      const freshUpdated = new Date(NOW - 30_000).toISOString();
      const { raw, body, signature } = signedIpn(
        `{"order_id":"ORD-BOTH","payment_status":"finished","payment_id":"PID-BOTH","actually_paid":10,"created_at":"${staleCreated}","updated_at":"${freshUpdated}"}`,
      );
      expect(verifyIpn(raw, body, signature, CREDS, NOW)).not.toBeNull();
    });

    // A payload with neither field must NOT be rejected on that basis alone
    // (see the ⚠ ASSUMPTION doc comment on NOWPAYMENTS_IPN_MAX_AGE_MS) — the
    // idempotency ledger remains the backstop for a body shaped this way.
    it("does not reject a payload carrying neither updated_at nor created_at, however old `now` is", () => {
      const { raw, body, signature } = signedIpn(
        '{"order_id":"ORD-NOTS","payment_status":"finished","payment_id":"PID-NOTS","actually_paid":10}',
      );
      const farFuture = NOW + NOWPAYMENTS_IPN_MAX_AGE_MS * 100;
      expect(verifyIpn(raw, body, signature, CREDS, farFuture)).not.toBeNull();
    });

    it("does not reject a payload whose timestamp field is present but unparseable as a date", () => {
      const { raw, body, signature } = signedIpn(
        '{"order_id":"ORD-BADTS","payment_status":"finished","payment_id":"PID-BADTS","actually_paid":10,"updated_at":"not-a-date"}',
      );
      expect(verifyIpn(raw, body, signature, CREDS, NOW)).not.toBeNull();
    });

    it("defaults `now` to the wall clock when not passed, so existing callers are unaffected", () => {
      // Freeze near "now" so this test is deterministic without pinning `now` explicitly.
      const nowIso = new Date().toISOString();
      const { raw, body, signature } = signedIpn(
        `{"order_id":"ORD-DEFAULT","payment_status":"finished","payment_id":"PID-DEFAULT","actually_paid":10,"updated_at":"${nowIso}"}`,
      );
      expect(verifyIpn(raw, body, signature, CREDS)).not.toBeNull();
    });
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

  it("bounds the request so a hung gateway cannot stall checkout forever", async () => {
    stubFetchJson({ id: "INV-6", invoice_url: "https://nowpayments.io/payment/INV-6" });
    await createInvoice(FULL_CREDS, { orderId: "ORD-6", amountUsd: "1.00", ipnCallbackUrl: "https://example.com/ipn" });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("wraps a rejected fetch() in a fresh, static-message error instead of letting the original (header-bearing) object escape", async () => {
    // Node's fetch sometimes attaches the failed request — including its
    // headers, one of which carries the x-api-key credential — to
    // err.cause. A naive `logger.error({ err })` downstream would serialize
    // that whole object. createInvoice must catch the rejection and rethrow
    // a brand-new Error with a static message, never the original.
    const original = Object.assign(new Error("fetch failed"), {
      cause: { request: { headers: { "x-api-key": FULL_CREDS.apiKey } } },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(original));
    let caught: unknown;
    try {
      await createInvoice(FULL_CREDS, { orderId: "ORD-7", amountUsd: "1.00", ipnCallbackUrl: "https://example.com/ipn" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(original);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).message).not.toContain(FULL_CREDS.apiKey);
    expect((caught as Error).message).not.toBe("fetch failed");
  });

  // AbortSignal.timeout stays attached to the response body in undici
  // (http.ts), so a peer that sends headers and then stalls the body makes
  // res.json() reject with this same TimeoutError shape — a DIFFERENT case
  // from the fetch()-level rejection above (that one never gets a response
  // at all). Must not be reported as "unparseable" — that would tell the
  // caller the gateway sent back garbage, when it actually just hung.
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
      await createInvoice(FULL_CREDS, { orderId: "ORD-8", amountUsd: "1.00", ipnCallbackUrl: "https://example.com/ipn" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/timed out/);
    expect((caught as Error).message).not.toMatch(/unparseable/);
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
    // Only a 429 is a rate-limit — any other non-2xx stays a plain Error.
    stubFetchJson({}, { ok: false, status: 404 });
    await expect(getPaymentStatus(FULL_CREDS, { invoiceId: "INV-3" })).rejects.not.toBeInstanceOf(RateLimitedError);
  });

  it("throws RateLimitedError (same message shape) on HTTP 429, so the reconcile poller can back off", async () => {
    stubFetchJson({}, { ok: false, status: 429 });
    const err = await getPaymentStatus(FULL_CREDS, { invoiceId: "INV-3b" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("NOWPayments status HTTP 429");
  });

  it("bounds the request so a hung gateway cannot stall the reconcile poller forever", async () => {
    stubFetchJson({ payment_status: "finished", payment_id: "PID-4", actually_paid: 10 });
    await getPaymentStatus(FULL_CREDS, { invoiceId: "INV-4" });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("wraps a rejected fetch() in a fresh, static-message error instead of letting the original (header-bearing) object escape", async () => {
    const original = Object.assign(new Error("fetch failed"), {
      cause: { request: { headers: { "x-api-key": FULL_CREDS.apiKey } } },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(original));
    let caught: unknown;
    try {
      await getPaymentStatus(FULL_CREDS, { invoiceId: "INV-5" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(original);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).message).not.toContain(FULL_CREDS.apiKey);
    expect((caught as Error).message).not.toBe("fetch failed");
  });

  // AbortSignal.timeout stays attached to the response body in undici
  // (http.ts), so a peer that sends headers and then stalls the body makes
  // res.json() reject with this same TimeoutError shape — a DIFFERENT case
  // from the fetch()-level rejection above (that one never gets a response
  // at all). Must not be reported as "unparseable" — that would tell the
  // reconcile poller the gateway sent back garbage, when it actually just hung.
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
      await getPaymentStatus(FULL_CREDS, { invoiceId: "INV-6" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/timed out/);
    expect((caught as Error).message).not.toMatch(/unparseable/);
  });
});
