/**
 * A hand-made wallet adjustment has no order or status to guard it, so unlike
 * the payment mutations nothing downstream would stop a repeat: a retry after
 * a lost response would simply move the money again. The Idempotency-Key is the
 * only protection, which is why every test here counts the rows it leaves.
 */
import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, setSetting, upsertUser, hashIdempotentRequest } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let customerId: number;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
  customerId = (await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" })).id;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function adjust(key: string | null, body: Record<string, unknown>, userId = customerId) {
  return app.inject({
    method: "POST",
    url: `/api/users/${userId}/wallet`,
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrf,
      ...(key ? { "idempotency-key": key } : {}),
    },
    cookies: { [COOKIE]: cookie },
    payload: JSON.stringify(body),
  });
}

/** Every row a wallet adjustment writes, plus the balance it leaves. */
async function moneyState() {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
  return {
    walletRows: await prisma.walletTransaction.count({ where: { userId: customerId } }),
    postings: await prisma.financialTransaction.count({ where: { type: "ADJUSTMENT" } }),
    audits: await prisma.auditLog.count({ where: { action: "wallet_adjust" } }),
    idr: user.walletBalance.toString(),
    usdt: user.walletBalanceUsdt.toString(),
  };
}

const CASES = [
  { currency: "IDR", delta: "50.000", one: { idr: "50000", usdt: "0" }, two: { idr: "100000", usdt: "0" }, newBalance: "50000" },
  { currency: "USDT", delta: "2.5", one: { idr: "0", usdt: "2.5" }, two: { idr: "0", usdt: "5" }, newBalance: "2.5" },
] as const;

describe.each(CASES)("POST /api/users/:userId/wallet idempotency in $currency", ({ currency, delta, one, two, newBalance }) => {
  const body = { delta, currency, note: "Goodwill credit" };

  it("moves the money once when the same key is sent twice, replaying the first response", async () => {
    const first = await adjust("key-1", body);
    const second = await adjust("key-1", body);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, newBalance });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await moneyState()).toEqual({ walletRows: 1, postings: 1, audits: 1, ...one });
  });

  it("moves the money once when the same key arrives concurrently", async () => {
    const results = await Promise.all([adjust("key-1", body), adjust("key-1", body), adjust("key-1", body)]);

    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(results.map((r) => r.json())).toEqual(Array(3).fill({ ok: true, newBalance }));
    expect(await moneyState()).toEqual({ walletRows: 1, postings: 1, audits: 1, ...one });
  });

  it("moves the money twice for two different keys", async () => {
    expect((await adjust("key-1", body)).statusCode).toBe(200);
    expect((await adjust("key-2", body)).statusCode).toBe(200);

    expect(await moneyState()).toEqual({ walletRows: 2, postings: 2, audits: 2, ...two });
  });

  it("refuses the same key with a different body, moving nothing more", async () => {
    await adjust("key-1", body);

    for (const changed of [
      { ...body, delta: "7" },
      { ...body, note: "Another reason" },
      { ...body, currency: currency === "IDR" ? "USDT" : "IDR", delta: "7" },
    ]) {
      const res = await adjust("key-1", changed);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "idempotency_key_reused" });
    }
    expect(await moneyState()).toEqual({ walletRows: 1, postings: 1, audits: 1, ...one });
  });

  it("does not move the money twice when the response cannot be stored after the move", async () => {
    // A failed store must take the move back with it: otherwise the admin sees
    // a 500, the claim is released, and the retry they are invited to make runs
    // the adjustment a second time under the very key meant to prevent that.
    const realTransaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(((run: (tx: unknown) => Promise<unknown>, options: unknown) =>
      realTransaction(
        (tx: object) =>
          run(
            new Proxy(tx, {
              get: (target, property, receiver) =>
                property === "idempotencyRecord"
                  ? { updateMany: () => Promise.reject(new Error("The database dropped the connection.")) }
                  : Reflect.get(target, property, receiver),
            }),
          ),
        options,
      )) as never);

    const failed = await adjust("key-1", body);
    spy.mockRestore();

    expect(failed.statusCode).toBe(500);
    expect(await moneyState()).toEqual({ walletRows: 0, postings: 0, audits: 0, idr: "0", usdt: "0" });

    const retried = await adjust("key-1", body);
    expect(retried.statusCode).toBe(200);
    expect(await moneyState()).toEqual({ walletRows: 1, postings: 1, audits: 1, ...one });
  });
});

describe("POST /api/users/:userId/wallet idempotency edges", () => {
  const body = { delta: "1000", currency: "IDR", note: "Goodwill credit" };

  it("refuses a key reused for a different customer", async () => {
    const other = await upsertUser(prisma, { telegramId: 43, username: "other", fullName: "Other" });
    await adjust("key-1", body);

    const res = await adjust("key-1", body, other.id);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "idempotency_key_reused" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).walletBalance.toString()).toBe("0");
  });

  it("replays a stored refusal instead of reconsidering it", async () => {
    const debit = { delta: "-1000", currency: "IDR", note: "Correction" };
    const refused = await adjust("key-1", debit);
    expect(refused.statusCode).toBe(422);

    await prisma.user.update({ where: { id: customerId }, data: { walletBalance: "5000" } });
    const replayed = await adjust("key-1", debit);

    expect(replayed.statusCode).toBe(422);
    expect(replayed.json()).toEqual(refused.json());
    expect(await moneyState()).toEqual({ walletRows: 0, postings: 0, audits: 0, idr: "5000", usdt: "0" });
  });

  it("answers in progress without moving money while the first request is unfinished", async () => {
    await prisma.idempotencyRecord.create({
      data: {
        key: "key-1",
        endpoint: "web-admin.users.adjustWallet",
        requestHash: hashIdempotentRequest({ userId: customerId, delta: "1000", currency: "IDR", note: "Goodwill credit" }),
        statusCode: 0,
        responseBody: "",
        pendingSince: new Date(),
      },
    });

    const res = await adjust("key-1", body);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "idempotency_request_in_progress" });
    expect(await moneyState()).toEqual({ walletRows: 0, postings: 0, audits: 0, idr: "0", usdt: "0" });
  }, 15_000);

  it("still runs every request that carries no key", async () => {
    expect((await adjust(null, body)).statusCode).toBe(200);
    expect((await adjust(null, body)).statusCode).toBe(200);

    expect(await moneyState()).toEqual({ walletRows: 2, postings: 2, audits: 2, idr: "2000", usdt: "0" });
  });

  it("stores nothing for input it refuses before any money is considered", async () => {
    const res = await adjust("key-1", { ...body, note: "   " });

    expect(res.statusCode).toBe(400);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });
});
