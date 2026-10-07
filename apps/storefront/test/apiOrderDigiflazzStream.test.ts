// GET /api/v1/account/orders/:code/digiflazz/stream — the storefront (buyer)
// twin of apps/web-admin/test/orderDigiflazzStream.test.ts (Task 10). The
// streaming-test technique (light-my-request's `payloadAsStream: true`,
// which resolves as soon as streamSse calls `reply.raw.writeHead()`) is
// copy-adapted from that file, per the task brief — there's no shared
// cross-app test-utils module for this yet.
//
// This route is buyer-facing, so the two things under test that matter most
// are (1) the ownership check mirrors GET /account/orders/:code exactly —
// always 404 on a mismatch, never 401/403 — and (2) the wire shape never
// leaks an internal digiflazzStatus value or diagnostic field.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import { prisma, initDb, setSetting, createCatalogProduct, createDenomination } from "@app/db";
import { OrderStatus } from "@app/core/enums";
import { emitDigiflazzOrderStatusChanged } from "@app/core/realtime/digiflazzEvents";
import { newJti, shopSessionJtiKey, makeCustomerSession, SHOP_COOKIE_NAME } from "../src/auth";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let denomId: number;

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Digiflazz Stream Cat", slug: "digiflazz-stream-cat", sortOrder: 1 },
  });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Digiflazz Stream Product" });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Digiflazz Stream Product",
    type: "SHARED",
    durationLabel: "1x",
    price: "15000",
    autoDeliverySource: "digiflazz",
  });
  denomId = denom.id;

  await setSetting(prisma, "setup_completed", "true");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

// ---- test fixtures ---------------------------------------------------

let userCounter = 0;

/** Mint a logged-in customer session directly (bypassing the login route,
 * same shortcut apps/web-admin/test/orderDigiflazzStream.test.ts takes with
 * makeSession) — sets the settings-row jti optionalCustomer checks against. */
async function makeCustomer(): Promise<{ userId: number; cookie: string }> {
  userCounter += 1;
  const user = await prisma.user.create({
    data: { telegramId: 900_000 + userCounter, referralCode: `STRM${userCounter}` },
  });
  const jti = newJti();
  await setSetting(prisma, shopSessionJtiKey(user.id), jti);
  const { raw } = makeCustomerSession(user.id, user.telegramId, jti);
  return { userId: user.id, cookie: raw };
}

/** A PRODUCT-kind order owned by `userId`, with the given Digiflazz fields —
 * created directly (bypassing checkout/the dispatch poller), same pattern as
 * digiflazz-webhook.test.ts's createProcessingDigiflazzOrder. */
async function makeProductOrder(
  userId: number,
  orderCode: string,
  overrides: {
    status?: string;
    digiflazzStatus?: string | null;
    digiflazzDispatchedAt?: Date | null;
    digiflazzAttempts?: number;
    digiflazzNextRecheckAt?: Date | null;
    digiflazzFailureDetail?: string | null;
  } = {},
) {
  return prisma.order.create({
    data: {
      orderCode,
      userId,
      subtotalAmount: "15000",
      totalAmount: "15000",
      status: overrides.status ?? OrderStatus.PROCESSING,
      currency: "IDR",
      paymentMethod: "TOKOPAY",
      kind: "PRODUCT",
      digiflazzStatus: overrides.digiflazzStatus ?? null,
      digiflazzDispatchedAt: overrides.digiflazzDispatchedAt ?? null,
      digiflazzAttempts: overrides.digiflazzAttempts ?? 0,
      digiflazzNextRecheckAt: overrides.digiflazzNextRecheckAt ?? null,
      digiflazzFailureDetail: overrides.digiflazzFailureDetail ?? null,
      items: {
        create: [{ productId: denomId, quantity: 1, unitPrice: "15000", warrantyDaysSnapshot: 0 }],
      },
    },
  });
}

/** A WALLET_TOPUP-kind order owned by `userId` — for the "sibling route's
 * same exclusion" test. */
async function makeWalletTopupOrder(userId: number, orderCode: string) {
  return prisma.order.create({
    data: {
      orderCode,
      userId,
      subtotalAmount: "15000",
      totalAmount: "15000",
      status: OrderStatus.PENDING_PAYMENT,
      currency: "IDR",
      paymentMethod: "TOKOPAY",
      kind: "WALLET_TOPUP",
    },
  });
}

// ---- streaming test helpers -------------------------------------------
// See apps/web-admin/test/orderDigiflazzStream.test.ts (Task 10) for the full
// rationale: plain `app.inject()` hangs on a genuinely-never-ending SSE
// response, so these tests use `payloadAsStream: true` (light-my-request
// resolves as soon as `streamSse` calls `reply.raw.writeHead()`, handing back
// a live Readable via `res.stream()`) and destroy the injected request
// afterward to drive streamSse's own cleanup (clearInterval + unsubscribe)
// instead of leaking its poll interval past the test.

function injectStream(url: string, cookieValue: string | null) {
  return app.inject({
    method: "GET",
    url,
    cookies: cookieValue ? { [SHOP_COOKIE_NAME]: cookieValue } : {},
    payloadAsStream: true,
  });
}

type InjectResponse = Awaited<ReturnType<typeof app.inject>>;

function readOneChunk(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk.toString("utf8"));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.on("error", onError);
  });
}

async function closeSseConnection(res: InjectResponse): Promise<void> {
  const rawReq = (res.raw.res as unknown as { req: { destroy: () => void } }).req;
  rawReq.destroy();
  await new Promise((resolve) => setImmediate(resolve));
}

function parseSseData(chunk: string): unknown {
  const line = chunk.split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`No "data:" line in SSE chunk: ${JSON.stringify(chunk)}`);
  return JSON.parse(line.slice("data: ".length));
}

let orderCodeCounter = 0;
function freshOrderCode(prefix: string): string {
  orderCodeCounter += 1;
  return `${prefix}-${orderCodeCounter}`;
}

describe("GET /api/v1/account/orders/:code/digiflazz/stream", () => {
  it("streams canonical fulfillment from payment through dispatch and delivery", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeProductOrder(userId, freshOrderCode("ORD-FULFILLMENT"), { status: OrderStatus.PENDING_PAYMENT });
    const res = await injectStream(`/api/v1/account/orders/${order.orderCode}/digiflazz/stream`, cookie);
    const stream = res.stream();
    try {
      expect(parseSseData(await readOneChunk(stream))).toMatchObject({ fulfillment: {
        mode: "AUTO", provider: "DIGIFLAZZ", status: "NOT_STARTED", payment_status: "PENDING", can_edit_customer_data: false,
      } });
      const changes = [
        { data: { status: OrderStatus.PROCESSING, paidAt: new Date() }, status: "QUEUED", editable: true },
        { data: { digiflazzDispatchedAt: new Date() }, status: "SUBMITTING", editable: false },
        { data: { digiflazzAttempts: 1, digiflazzStatus: "pending_at_supplier" }, status: "PROCESSING", editable: false },
        { data: { status: OrderStatus.DELIVERED }, status: "SUCCESS", editable: false },
      ];
      for (const change of changes) {
        await prisma.order.update({ where: { id: order.id }, data: change.data });
        const next = readOneChunk(stream);
        emitDigiflazzOrderStatusChanged(order.id);
        expect(parseSseData(await next)).toMatchObject({ fulfillment: { status: change.status, payment_status: "PAID", can_edit_customer_data: change.editable } });
      }
    } finally {
      await closeSseConnection(res);
    }
  });

  // Instant dispatch Task 4, item 3: once the order is final there is nothing
  // left to stream, so the server ends the response after the terminal frame
  // instead of holding an idle connection (and its 5-second poll) open.
  describe("closes the stream after a terminal snapshot", () => {
    /** Collects every chunk until the server ends the response; null if it is
     * still open after `ms`. */
    function readUntilEnd(stream: NodeJS.ReadableStream, ms = 3_000): Promise<string[] | null> {
      return new Promise((resolve) => {
        const chunks: string[] = [];
        const timer = setTimeout(() => resolve(null), ms);
        stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
        stream.on("end", () => {
          clearTimeout(timer);
          resolve(chunks);
        });
      });
    }

    it.each([
      [OrderStatus.DELIVERED, "SUCCESS"],
      [OrderStatus.CANCELLED, "CANCELLED"],
      [OrderStatus.REFUNDED, "CANCELLED"],
      [OrderStatus.FAILED, "FAILED"],
    ])("an order that is already %s gets one frame and the response ends", async (status, fulfillmentStatus) => {
      const { userId, cookie } = await makeCustomer();
      const order = await makeProductOrder(userId, freshOrderCode(`ORD-END-${status}`), { status });
      const res = await injectStream(`/api/v1/account/orders/${order.orderCode}/digiflazz/stream`, cookie);
      const chunks = await readUntilEnd(res.stream());
      expect(chunks).not.toBeNull();
      const frames = chunks!.join("").split("\n\n").filter((f) => f.startsWith("data: "));
      expect(frames).toHaveLength(1);
      expect(parseSseData(frames[0]!)).toMatchObject({ orderStatus: status, fulfillment: { status: fulfillmentStatus } });
    });

    it("a live order that an admin cancels gets the CANCELLED frame, then the response ends", async () => {
      const { userId, cookie } = await makeCustomer();
      const order = await makeProductOrder(userId, freshOrderCode("ORD-END-LIVE"), {
        digiflazzStatus: "pending_at_supplier",
        digiflazzDispatchedAt: new Date(),
        digiflazzAttempts: 1,
      });
      const res = await injectStream(`/api/v1/account/orders/${order.orderCode}/digiflazz/stream`, cookie);
      const stream = res.stream();
      expect(parseSseData(await readOneChunk(stream))).toMatchObject({ fulfillment: { status: "PROCESSING" } });
      const ended = readUntilEnd(stream);
      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
      emitDigiflazzOrderStatusChanged(order.id);
      const chunks = await ended;
      expect(chunks).not.toBeNull();
      expect(parseSseData(chunks!.join(""))).toMatchObject({ orderStatus: OrderStatus.CANCELLED, fulfillment: { status: "CANCELLED" } });
    });

    it("keeps streaming an order that needs review (an admin can still finish it)", async () => {
      const { userId, cookie } = await makeCustomer();
      const order = await makeProductOrder(userId, freshOrderCode("ORD-OPEN-REVIEW"), { digiflazzStatus: "failed" });
      const res = await injectStream(`/api/v1/account/orders/${order.orderCode}/digiflazz/stream`, cookie);
      try {
        const chunks = await readUntilEnd(res.stream(), 500);
        expect(chunks).toBeNull();
      } finally {
        await closeSseConnection(res);
      }
    });
  });

  it("refreshes fulfillment within five seconds when payment changes without an in-process event", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeProductOrder(userId, freshOrderCode("ORD-POLL"), { status: OrderStatus.PENDING_PAYMENT });
    const res = await injectStream(`/api/v1/account/orders/${order.orderCode}/digiflazz/stream`, cookie);
    const stream = res.stream();
    try {
      await readOneChunk(stream);
      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING, paidAt: new Date() } });
      const next = readOneChunk(stream);
      const withinFallback = await Promise.race([next, new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000))]);
      expect(withinFallback).not.toBeNull();
      expect(parseSseData(withinFallback!)).toMatchObject({ orderStatus: OrderStatus.PROCESSING, fulfillment: { status: "QUEUED", payment_status: "PAID" } });
    } finally {
      await closeSseConnection(res);
    }
  });

  // These four cases all short-circuit BEFORE streamSse's reply.hijack()
  // runs, so a plain app.inject() (no payloadAsStream) is used here — it
  // gives back a normal buffered JSON body to assert on, unlike the 200
  // streaming cases below which need payloadAsStream's live Readable.
  it("rejects an unauthenticated request with 401, no crash", async () => {
    const { userId } = await makeCustomer();
    const order = await makeProductOrder(userId, freshOrderCode("ORD-UNAUTH"));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/account/orders/${order.orderCode}/digiflazz/stream`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 404 (never 401/403) when the order belongs to a DIFFERENT customer", async () => {
    const owner = await makeCustomer();
    const other = await makeCustomer();
    const order = await makeProductOrder(owner.userId, freshOrderCode("ORD-OTHER"));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/account/orders/${order.orderCode}/digiflazz/stream`,
      cookies: { [SHOP_COOKIE_NAME]: other.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("returns 404 for an order code that doesn't exist at all", async () => {
    const { cookie } = await makeCustomer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/account/orders/ORD-NO-SUCH-CODE/digiflazz/stream",
      cookies: { [SHOP_COOKIE_NAME]: cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("returns 404 for a WALLET_TOPUP-kind order, matching the sibling route's own exclusion", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeWalletTopupOrder(userId, freshOrderCode("ORD-TOPUP"));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/account/orders/${order.orderCode}/digiflazz/stream`,
      cookies: { [SHOP_COOKIE_NAME]: cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("maps digiflazzStatus 'pending_at_supplier' to the buyer-safe 'pending' in the initial frame", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeProductOrder(userId, freshOrderCode("ORD-PENDING"), {
      digiflazzStatus: "pending_at_supplier",
      digiflazzDispatchedAt: new Date(),
      digiflazzAttempts: 1,
      digiflazzNextRecheckAt: new Date("2026-08-23T12:00:00.000Z"),
    });

    const res = await injectStream(`/api/v1/account/orders/${order.orderCode}/digiflazz/stream`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const chunk = await readOneChunk(res.stream());
    expect(parseSseData(chunk)).toEqual({
      orderStatus: OrderStatus.PROCESSING,
      digiflazzStatus: "pending",
      fulfillment: { mode: "AUTO", provider: "DIGIFLAZZ", status: "PROCESSING", payment_status: "PAID", can_edit_customer_data: false },
    });
    await closeSseConnection(res);
  });

  it("maps digiflazzStatus 'failed' to the buyer-safe 'reviewing' — never the raw word 'failed' — in the initial frame", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeProductOrder(userId, freshOrderCode("ORD-FAILED"), {
      digiflazzStatus: "failed",
      digiflazzAttempts: 5,
      digiflazzNextRecheckAt: null,
      digiflazzFailureDetail: "Digiflazz timed out",
    });

    const res = await injectStream(`/api/v1/account/orders/${order.orderCode}/digiflazz/stream`, cookie);
    expect(res.statusCode).toBe(200);
    const chunk = await readOneChunk(res.stream());
    expect(parseSseData(chunk)).toEqual({
      orderStatus: OrderStatus.PROCESSING,
      digiflazzStatus: "reviewing",
      fulfillment: { mode: "AUTO", provider: "DIGIFLAZZ", status: "NEEDS_REVIEW", payment_status: "PAID", can_edit_customer_data: false },
    });
    // Belt-and-suspenders against the exact leak this design prevents: the
    // raw internal word must not appear anywhere in the captured frame text,
    // not even as a substring of some other field.
    expect(chunk).not.toContain("failed");
    await closeSseConnection(res);
  });

  it("passes through digiflazzStatus: null (order not yet dispatched) as null in the initial frame", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeProductOrder(userId, freshOrderCode("ORD-NULL"), {
      status: OrderStatus.PENDING_PAYMENT,
      digiflazzStatus: null,
    });

    const res = await injectStream(`/api/v1/account/orders/${order.orderCode}/digiflazz/stream`, cookie);
    expect(res.statusCode).toBe(200);
    const chunk = await readOneChunk(res.stream());
    expect(parseSseData(chunk)).toEqual({
      orderStatus: OrderStatus.PENDING_PAYMENT,
      digiflazzStatus: null,
      fulfillment: { mode: "AUTO", provider: "DIGIFLAZZ", status: "NOT_STARTED", payment_status: "PENDING", can_edit_customer_data: false },
    });
    await closeSseConnection(res);
  });

  it("never sends digiflazzFailureDetail, digiflazzAttempts, or digiflazzNextRecheckAt as keys on the wire", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeProductOrder(userId, freshOrderCode("ORD-NOLEAK"), {
      digiflazzStatus: "failed",
      digiflazzAttempts: 7,
      digiflazzNextRecheckAt: new Date("2026-08-23T12:00:00.000Z"),
      digiflazzFailureDetail: "Saldo tidak cukup — internal diagnostic text",
    });

    const res = await injectStream(`/api/v1/account/orders/${order.orderCode}/digiflazz/stream`, cookie);
    expect(res.statusCode).toBe(200);
    const chunk = await readOneChunk(res.stream());
    const parsed = parseSseData(chunk) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["digiflazzStatus", "fulfillment", "orderStatus"]);
    await closeSseConnection(res);
  });
});
