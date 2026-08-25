import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { findIdempotentResponse, saveIdempotentResponse, hashIdempotentRequest, IdempotencyKeyReuseError } from "./idempotency";

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

describe("findIdempotentResponse", () => {
  it("returns null when no record exists yet — first-time request", async () => {
    const requestHash = hashIdempotentRequest({ a: 1 });
    const result = await findIdempotentResponse(prisma, { key: "key-1", endpoint: ENDPOINT, requestHash });
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

    const result = await findIdempotentResponse(prisma, { key: "key-2", endpoint: ENDPOINT, requestHash });
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
      findIdempotentResponse(prisma, { key: "key-3", endpoint: ENDPOINT, requestHash: secondHash }),
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

    const result = await findIdempotentResponse(prisma, {
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

    const result = await findIdempotentResponse(prisma, { key: "key-4", endpoint: ENDPOINT, requestHash });
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
    // that doesn't check findIdempotentResponse first) must not clobber it.
    await saveIdempotentResponse(prisma, {
      key: "key-6",
      endpoint: ENDPOINT,
      requestHash,
      statusCode: 201,
      responseBody: JSON.stringify({ order_code: "SECOND" }),
    });

    const result = await findIdempotentResponse(prisma, { key: "key-6", endpoint: ENDPOINT, requestHash });
    expect(result?.responseBody).toBe(JSON.stringify({ order_code: "FIRST" }));
  });
});
