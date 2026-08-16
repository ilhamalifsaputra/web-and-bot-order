/**
 * The one test that would catch Task E6 leaking a secret into the logs.
 *
 * The payment path is where the secrets are: gateway API keys, IPN/callback
 * signing secrets, and the credentials the buyer is actually paying for. E6
 * added structured metadata to every settlement log line on all six rails,
 * which is exactly the kind of change that quietly starts logging the whole
 * `creds` object or the whole `order` (whose eager-loaded `items[].stockItem`
 * carries the account credentials themselves).
 *
 * The other suites assert on what the code DOES. This one asserts on what it
 * SAYS, by capturing every line pino writes during a real settlement — message
 * strings and structured metadata alike, since a secret in the metadata object
 * is just as leaked as one in the sentence — and searching the whole stream for
 * values that must never appear.
 *
 * Deliberately checks the values, not the field names: a leak that matters
 * arrives as `{ creds: {...} }` or interpolated mid-sentence, not as a field
 * politely labelled `apiKey`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect } from "./orders";
import { bulkAddStock } from "./stock";
import { deliverPaidTokopayOrder } from "./tokopay";
import { OrderStatus, PaymentMethod } from "@app/core/enums";
import { logger } from "@app/core/logger";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

/** Values that must never reach a log line, whatever shape it takes. Each is
 *  distinctive enough that a substring match cannot collide with ordinary
 *  prose or an id. */
const GATEWAY_API_KEY = "tkp-secret-api-key-9f3a71";
const GATEWAY_SIGNING_SECRET = "tkp-signing-secret-b28c04";
const BUYER_CREDENTIAL = "buyer-account-password-c19d55";

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

/**
 * Capture everything pino emits while `fn` runs, as one string.
 *
 * Hooks the transport rather than spying on `logger.info`/`logger.warn`
 * individually: a spy per method only sees the methods it was told about, so a
 * leak added through `logger.debug` — or through a child logger — would walk
 * straight past it. Everything pino writes goes through this one stream.
 */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  let captured = "";
  const stream = (logger as unknown as { [k: symbol]: unknown });
  const streamSym = Object.getOwnPropertySymbols(stream).find((s) => s.toString().includes("stream"));
  const original = streamSym ? stream[streamSym] : undefined;
  const sink = {
    write: (chunk: string) => {
      captured += chunk;
    },
  };
  if (streamSym) (stream as Record<symbol, unknown>)[streamSym] = sink;
  try {
    await fn();
  } finally {
    if (streamSym) (stream as Record<symbol, unknown>)[streamSym] = original;
  }
  return captured;
}

describe("payment settlement logging never leaks a secret", () => {
  it("logs nothing containing gateway credentials or the buyer's delivered credential", async () => {
    // A real settlement, end to end: stock carrying a credential, a TokoPay
    // order, and gateway credentials sitting in Settings where the rail reads
    // them. Whatever E6's log lines interpolate, they interpolate it here.
    await prisma.setting.createMany({
      data: [
        { key: "tokopay_merchant_id", value: "merchant-1" },
        { key: "tokopay_secret", value: GATEWAY_API_KEY },
        { key: "tokopay_signature_secret", value: GATEWAY_SIGNING_SECRET },
      ],
    });
    await bulkAddStock(prisma, sample.product.id, [BUYER_CREDENTIAL]);
    const order = (await createOrderDirect(prisma, {
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
    }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.PENDING_PAYMENT, paymentMethod: PaymentMethod.TOKOPAY },
    });

    const output = await captureLogs(async () => {
      await deliverPaidTokopayOrder(prisma, {
        orderId: order.id,
        trxId: "TRX-LOGSAFE-1",
        amount: order.totalAmount,
        shopUrl: null,
      });
      // Settle the same transaction twice: the second call takes the
      // already-processed branch, which E6 gave a log line of its own.
      await deliverPaidTokopayOrder(prisma, {
        orderId: order.id,
        trxId: "TRX-LOGSAFE-1",
        amount: order.totalAmount,
        shopUrl: null,
      });
    });

    // The capture has to have worked, or this test passes by seeing nothing.
    expect(output).toContain("TRX-LOGSAFE-1");

    expect(output).not.toContain(GATEWAY_API_KEY);
    expect(output).not.toContain(GATEWAY_SIGNING_SECRET);
    expect(output).not.toContain(BUYER_CREDENTIAL);
  });

  it("carries the correlation fields that make a payment followable", async () => {
    // The other half of E6's contract: the metadata has to actually be there,
    // with the agreed field names, or the vocabulary buys nothing.
    await bulkAddStock(prisma, sample.product.id, ["cred-a"]);
    const order = (await createOrderDirect(prisma, {
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
    }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.PENDING_PAYMENT, paymentMethod: PaymentMethod.TOKOPAY },
    });

    const output = await captureLogs(async () => {
      await deliverPaidTokopayOrder(prisma, {
        orderId: order.id,
        trxId: "TRX-FIELDS-1",
        amount: order.totalAmount,
        shopUrl: null,
      });
    });

    const confirmed = output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === "PAYMENT_CONFIRMED");

    expect(confirmed).toBeDefined();
    expect(confirmed!.orderId).toBe(order.id);
    expect(confirmed!.provider).toBe(PaymentMethod.TOKOPAY);
    expect(confirmed!.providerPaymentId).toBe("TRX-FIELDS-1");
    expect(typeof confirmed!.msg).toBe("string");
    // The message beside the metadata still has to read as a sentence, not be
    // replaced by the event name (docs/LOGGING.md).
    expect(confirmed!.msg).not.toBe("PAYMENT_CONFIRMED");
    expect(String(confirmed!.msg).length).toBeGreaterThan(20);
  });
});
