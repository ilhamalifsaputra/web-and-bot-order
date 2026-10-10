import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

/**
 * The Orders list/detail must not offer "Fulfil manually" on a Digiflazz order
 * the provider is still working on — fulfillManualOrder refuses it anyway.
 */

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let buyerId: number;

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
  cookie = makeSession(admin.id, ADMIN_TG, jti).raw;
  await setSetting(prisma, "setup_completed", "true");
  buyerId = (await upsertUser(prisma, { telegramId: 4242, username: "buyer", fullName: "Buyer" })).id;
});

function makeOrder(extra: Record<string, unknown>) {
  return prisma.order.create({
    data: { orderCode: `ORD-${Math.random()}`, userId: buyerId, subtotalAmount: "1", totalAmount: "1", status: "PROCESSING", ...extra },
  });
}

describe("order eligibility for Digiflazz orders", () => {
  it("detail and list: canFulfill false while in flight, true once the provider failed it, true for MANUAL", async () => {
    const inFlight = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "pending_at_supplier" });
    const failed = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "failed" });
    const manual = await makeOrder({ fulfillmentProvider: "MANUAL" });

    const detail = async (id: number) =>
      (await app.inject({ method: "GET", url: `/api/orders/${id}`, cookies: { [COOKIE]: cookie } })).json() as { canFulfill: boolean; canCredit: boolean };
    expect(await detail(inFlight.id)).toMatchObject({ canFulfill: false, canCredit: true });
    expect((await detail(failed.id)).canFulfill).toBe(true);
    expect((await detail(manual.id)).canFulfill).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/orders", cookies: { [COOKIE]: cookie } });
    const rows = list.json().orders as Array<{ id: number; eligibility: { canFulfill: boolean } }>;
    const canFulfill = (id: number) => rows.find((r) => r.id === id)!.eligibility.canFulfill;
    expect(canFulfill(inFlight.id)).toBe(false);
    expect(canFulfill(failed.id)).toBe(true);
    expect(canFulfill(manual.id)).toBe(true);
  });
});
