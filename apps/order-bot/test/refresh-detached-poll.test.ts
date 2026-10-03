// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The "🔄 Refresh Status" button answers the buyer's tap immediately and then
 * kicks its rail's poller off the handler's own promise chain, so the toast
 * never waits on a gateway round trip. That detached promise is what these
 * tests are about, so the rail's `pollOnce` is replaced wholesale with a stub a
 * test can make reject on demand — which is what a gateway timeout, an HTTP
 * error, an unparseable response or an unreadable database all look like from
 * the handler's side.
 *
 * Its own file rather than a block in handlers.test.ts because `vi.mock` is
 * file-wide: handlers.test.ts drives the REAL TokoPay poller (through a stubbed
 * global fetch) in its neighbouring Refresh tests, and mocking the module there
 * would silently gut them.
 */
vi.mock("../src/payments/tokopayReconcile", async (orig) => ({
  ...(await orig<typeof import("../src/payments/tokopayReconcile")>()),
  pollOnce: vi.fn().mockResolvedValue(undefined),
}));

import { prisma, createOrderDirect, finalizeOrderPayment } from "@app/db";
import { OrderCurrency, PaymentMethod } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx } from "./helpers/ctx";
import { pollOnce as tokopayPollOnce } from "../src/payments/tokopayReconcile";
import * as checkout from "../src/handlers/checkout";
import type { SessionData } from "../src/context";

let sample: SampleData;

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

function customerCtx(callbackData: string) {
  return makeCtx({
    from: { id: 42, username: "tester" },
    callbackData,
    session: {
      lang: "en",
      scratch: {},
      dbUser: {
        id: sample.user.id,
        telegramId: String(sample.user.telegramId),
        role: sample.user.role,
        language: sample.user.language,
        referralCode: sample.user.referralCode,
        walletBalance: String(sample.user.walletBalance),
      },
    } as Partial<SessionData>,
  });
}

/** A PENDING_PAYMENT TokoPay order — the state the Refresh button polls from. */
async function makeTokopayPendingOrder() {
  const order = await prisma.$transaction(async (tx) => {
    const created = await createOrderDirect(tx, { channel: "bot",
      user: { id: sample.user.id, role: sample.user.role },
      productId: sample.product.id,
      quantity: 1,
    });
    return finalizeOrderPayment(tx, created!.id, { currency: OrderCurrency.IDR });
  });
  expect(order!.paymentMethod).toBe(PaymentMethod.TOKOPAY);
  return order!;
}

/**
 * Run `body`, then give Node a full turn to decide whether any promise
 * rejection inside it went unhandled, collecting whatever it reports.
 *
 * An unhandled rejection is not a cosmetic problem here: Node ≥15 defaults to
 * `--unhandled-rejections=throw`, so one rejected detached poll takes the
 * ENTIRE bot process down — every buyer's checkout, every poller, every
 * scheduled job — over one buyer tapping Refresh at the wrong moment.
 */
async function collectUnhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
}

describe("Refresh Status: the detached background poll", () => {
  it("survives a poller that rejects — no unhandled rejection escapes to kill the bot process", async () => {
    const order = await makeTokopayPendingOrder();
    vi.mocked(tokopayPollOnce).mockRejectedValue(new Error("TokoPay gateway unreachable"));
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const { ctx } = customerCtx(`v1:checkout:refresh:${order.id}`);

    const unhandled = await collectUnhandledRejections(() => checkout.refreshPaymentStatus(ctx, order.id));

    expect(unhandled).toEqual([]);
  });

  it("reports the failed background poll as a warning naming the order, so it is not swallowed silently", async () => {
    const order = await makeTokopayPendingOrder();
    const gatewayError = new Error("TokoPay gateway unreachable");
    vi.mocked(tokopayPollOnce).mockRejectedValue(gatewayError);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const { ctx } = customerCtx(`v1:checkout:refresh:${order.id}`);

    await collectUnhandledRejections(() => checkout.refreshPaymentStatus(ctx, order.id));

    const reported = warn.mock.calls.find(
      ([meta, message]) =>
        typeof message === "string" &&
        message.includes(order.orderCode) &&
        (meta as { err?: unknown } | undefined)?.err === gatewayError,
    );
    expect(reported).toBeDefined();
  });

  it("still answers the buyer's tap — the failure is background-only, never surfaced as a broken button", async () => {
    const order = await makeTokopayPendingOrder();
    vi.mocked(tokopayPollOnce).mockRejectedValue(new Error("TokoPay gateway unreachable"));
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const { ctx, sink } = customerCtx(`v1:checkout:refresh:${order.id}`);

    await collectUnhandledRejections(() => checkout.refreshPaymentStatus(ctx, order.id));

    const toast = sink.filter((c) => c.method === "answerCallbackQuery").at(-1);
    expect((toast!.args[0] as { text?: string }).text).toBe("Payment not received yet. Still waiting…");
  });
});
