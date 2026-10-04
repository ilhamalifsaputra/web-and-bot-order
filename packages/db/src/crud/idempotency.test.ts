import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  claimIdempotentRequest,
  saveIdempotentResponse,
  releaseIdempotentClaim,
  hashIdempotentRequest,
  IdempotencyKeyReuseError,
  IdempotencyRequestInProgressError,
  IDEMPOTENCY_CLAIM_EXPIRY_MS,
  type IdempotentReplay,
} from "./idempotency";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.idempotencyRecord.deleteMany();
});

const ENDPOINT = "POST /api/v1/checkout";

describe("hashIdempotentRequest", () => {
  it("is deterministic for the same payload", () => {
    const a = hashIdempotentRequest({ method: "wallet_idr", voucherCode: "SAVE10" });
    const b = hashIdempotentRequest({ method: "wallet_idr", voucherCode: "SAVE10" });
    expect(a).toBe(b);
  });

  it("differs when the payload differs", () => {
    const a = hashIdempotentRequest({ method: "wallet_idr", voucherCode: "SAVE10" });
    const b = hashIdempotentRequest({ method: "wallet_idr", voucherCode: null });
    expect(a).not.toBe(b);
  });

  it("treats undefined and null payloads the same (both hash as JSON null)", () => {
    expect(hashIdempotentRequest(undefined)).toBe(hashIdempotentRequest(null));
  });
});

describe("claimIdempotentRequest", () => {
  it("returns null when no record exists yet — first-time request", async () => {
    const requestHash = hashIdempotentRequest({ a: 1 });
    const result = await claimIdempotentRequest(prisma, { key: "key-1", endpoint: ENDPOINT, requestHash });
    expect(result).toBeNull();
  });

  it("replays the stored response for the same key + same hash", async () => {
    const requestHash = hashIdempotentRequest({ method: "wallet_idr" });
    await saveIdempotentResponse(prisma, {
      key: "key-2",
      endpoint: ENDPOINT,
      requestHash,
      statusCode: 201,
      responseBody: JSON.stringify({ order_code: "ORD-1" }),
    });

    const result = await claimIdempotentRequest(prisma, { key: "key-2", endpoint: ENDPOINT, requestHash });
    expect(result).toEqual({ statusCode: 201, responseBody: JSON.stringify({ order_code: "ORD-1" }) });
  });

  it("throws IdempotencyKeyReuseError for the same key + a DIFFERENT hash", async () => {
    const firstHash = hashIdempotentRequest({ method: "wallet_idr" });
    await saveIdempotentResponse(prisma, {
      key: "key-3",
      endpoint: ENDPOINT,
      requestHash: firstHash,
      statusCode: 201,
      responseBody: JSON.stringify({ order_code: "ORD-1" }),
    });

    const secondHash = hashIdempotentRequest({ method: "wallet_usdt" });
    await expect(
      claimIdempotentRequest(prisma, { key: "key-3", endpoint: ENDPOINT, requestHash: secondHash }),
    ).rejects.toThrow(IdempotencyKeyReuseError);
  });

  it("scopes replay by endpoint — the same key on a different endpoint is a fresh request", async () => {
    const requestHash = hashIdempotentRequest({ orderId: 5 });
    await saveIdempotentResponse(prisma, {
      key: "shared-key",
      endpoint: "POST /api/v1/checkout",
      requestHash,
      statusCode: 201,
      responseBody: JSON.stringify({ order_code: "ORD-1" }),
    });

    const result = await claimIdempotentRequest(prisma, {
      key: "shared-key",
      endpoint: "POST /api/payments/order/:orderId/refund",
      requestHash,
    });
    expect(result).toBeNull();
  });
});

describe("saveIdempotentResponse", () => {
  it("round-trips statusCode and responseBody exactly, including non-2xx responses", async () => {
    const requestHash = hashIdempotentRequest({ method: "binance_pay" });
    await saveIdempotentResponse(prisma, {
      key: "key-4",
      endpoint: ENDPOINT,
      requestHash,
      statusCode: 400,
      responseBody: JSON.stringify({ error: "error.out_of_stock" }),
    });

    const result = await claimIdempotentRequest(prisma, { key: "key-4", endpoint: ENDPOINT, requestHash });
    expect(result).toEqual({ statusCode: 400, responseBody: JSON.stringify({ error: "error.out_of_stock" }) });
  });

  it("a concurrent duplicate insert for the SAME key+endpoint+hash is swallowed, not thrown", async () => {
    const requestHash = hashIdempotentRequest({ method: "wallet_idr" });
    const args = {
      key: "key-5",
      endpoint: ENDPOINT,
      requestHash,
      statusCode: 201,
      responseBody: JSON.stringify({ order_code: "ORD-1" }),
    };
    // Two "concurrent" writers racing the same brand-new key: both resolve
    // without throwing, and the row is claimed exactly once.
    await Promise.all([saveIdempotentResponse(prisma, args), saveIdempotentResponse(prisma, args)]);

    const rows = await prisma.idempotencyRecord.findMany({ where: { key: "key-5", endpoint: ENDPOINT } });
    expect(rows).toHaveLength(1);
  });

  it("does not overwrite an existing row for the same key+endpoint (the first write wins)", async () => {
    const requestHash = hashIdempotentRequest({ method: "wallet_idr" });
    await saveIdempotentResponse(prisma, {
      key: "key-6",
      endpoint: ENDPOINT,
      requestHash,
      statusCode: 201,
      responseBody: JSON.stringify({ order_code: "FIRST" }),
    });
    // A second save attempt for the identical key+endpoint (e.g. a caller
    // that doesn't check claimIdempotentRequest first) must not clobber it.
    await saveIdempotentResponse(prisma, {
      key: "key-6",
      endpoint: ENDPOINT,
      requestHash,
      statusCode: 201,
      responseBody: JSON.stringify({ order_code: "SECOND" }),
    });

    const result = await claimIdempotentRequest(prisma, { key: "key-6", endpoint: ENDPOINT, requestHash });
    expect(result?.responseBody).toBe(JSON.stringify({ order_code: "FIRST" }));
  });
});

describe("claimIdempotentRequest — in-flight reservation (backend audit E2 item 1)", () => {
  it("two concurrent requests with the same key run the mutation ONCE; the second replays the first's response", async () => {
    const requestHash = hashIdempotentRequest({ orderId: 42 });
    const key = "race-key";
    let mutationRuns = 0;

    // Mirrors a route: claim, run the mutation when the claim is ours, then save.
    const handle = async (): Promise<IdempotentReplay> => {
      const replay = await claimIdempotentRequest(prisma, { key, endpoint: ENDPOINT, requestHash, waitMs: 5000 });
      if (replay) return replay;
      mutationRuns += 1;
      // The mutation takes a moment, so the second request arrives mid-flight.
      await new Promise((r) => setTimeout(r, 300));
      const response = { statusCode: 201, responseBody: JSON.stringify({ order_code: `ORD-${mutationRuns}` }) };
      await saveIdempotentResponse(prisma, { key, endpoint: ENDPOINT, requestHash, ...response });
      return response;
    };

    const results = await Promise.allSettled([handle(), handle()]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(mutationRuns).toBe(1);
    const bodies = results.map((r) => (r as PromiseFulfilledResult<IdempotentReplay>).value.responseBody);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("a request still in flight past the wait budget answers IdempotencyRequestInProgressError, not a second run", async () => {
    const requestHash = hashIdempotentRequest({ orderId: 7 });
    expect(await claimIdempotentRequest(prisma, { key: "slow", endpoint: ENDPOINT, requestHash })).toBeNull();
    await expect(
      claimIdempotentRequest(prisma, { key: "slow", endpoint: ENDPOINT, requestHash, waitMs: 200 }),
    ).rejects.toThrow(IdempotencyRequestInProgressError);
  });

  it("a crash between running the mutation and saving the response does not wedge the key: the claim expires and a retry takes it over", async () => {
    const requestHash = hashIdempotentRequest({ orderId: 8 });
    // First request claims, then "crashes" before saveIdempotentResponse.
    expect(await claimIdempotentRequest(prisma, { key: "crashed", endpoint: ENDPOINT, requestHash })).toBeNull();

    // Inside the expiry window the claim is still honoured.
    await expect(
      claimIdempotentRequest(prisma, { key: "crashed", endpoint: ENDPOINT, requestHash, waitMs: 0 }),
    ).rejects.toThrow(IdempotencyRequestInProgressError);

    // Past the window, exactly one of two concurrent retries takes it over.
    const later = new Date(Date.now() + IDEMPOTENCY_CLAIM_EXPIRY_MS + 1000);
    const retries = await Promise.allSettled([
      claimIdempotentRequest(prisma, { key: "crashed", endpoint: ENDPOINT, requestHash, waitMs: 0, now: later }),
      claimIdempotentRequest(prisma, { key: "crashed", endpoint: ENDPOINT, requestHash, waitMs: 0, now: later }),
    ]);
    const winners = retries.filter((r) => r.status === "fulfilled" && r.value === null);
    expect(winners).toHaveLength(1);
    const loser = retries.find((r) => !(r.status === "fulfilled" && r.value === null));
    expect(loser?.status).toBe("rejected");
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyRequestInProgressError);

    // The new owner can complete it, and the next retry replays.
    await saveIdempotentResponse(prisma, {
      key: "crashed",
      endpoint: ENDPOINT,
      requestHash,
      statusCode: 200,
      responseBody: JSON.stringify({ ok: true }),
    });
    expect(await claimIdempotentRequest(prisma, { key: "crashed", endpoint: ENDPOINT, requestHash })).toEqual({
      statusCode: 200,
      responseBody: JSON.stringify({ ok: true }),
    });
  });

  it("a pending claim reused with a DIFFERENT request still answers IdempotencyKeyReuseError", async () => {
    await claimIdempotentRequest(prisma, { key: "k-reuse", endpoint: ENDPOINT, requestHash: hashIdempotentRequest({ a: 1 }) });
    await expect(
      claimIdempotentRequest(prisma, {
        key: "k-reuse",
        endpoint: ENDPOINT,
        requestHash: hashIdempotentRequest({ a: 2 }),
        waitMs: 0,
      }),
    ).rejects.toThrow(IdempotencyKeyReuseError);
  });

  it("releaseIdempotentClaim frees a pending claim so an immediate retry runs again", async () => {
    const requestHash = hashIdempotentRequest({ orderId: 9 });
    await claimIdempotentRequest(prisma, { key: "released", endpoint: ENDPOINT, requestHash });
    await releaseIdempotentClaim(prisma, { key: "released", endpoint: ENDPOINT, requestHash });
    expect(
      await claimIdempotentRequest(prisma, { key: "released", endpoint: ENDPOINT, requestHash, waitMs: 0 }),
    ).toBeNull();
  });

  it("releaseIdempotentClaim never deletes a COMPLETED response", async () => {
    const requestHash = hashIdempotentRequest({ orderId: 10 });
    await claimIdempotentRequest(prisma, { key: "done", endpoint: ENDPOINT, requestHash });
    await saveIdempotentResponse(prisma, { key: "done", endpoint: ENDPOINT, requestHash, statusCode: 200, responseBody: "{}" });
    await releaseIdempotentClaim(prisma, { key: "done", endpoint: ENDPOINT, requestHash });
    expect(await claimIdempotentRequest(prisma, { key: "done", endpoint: ENDPOINT, requestHash })).toEqual({
      statusCode: 200,
      responseBody: "{}",
    });
  });
});
