import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { OrderStatus } from "@app/core/enums";
import { prisma, initDb, upsertUser, setSetting, createOrderDirect } from "@app/db";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti, webRoleKey } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;

let app: FastifyInstance;
let cookie: string;
let sample: SampleData;

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
  const { raw } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  await setSetting(prisma, "setup_completed", "true");
  sample = await buildSampleData(prisma);
});

function setRole(role: string) {
  return setSetting(prisma, webRoleKey(ADMIN_TG), role);
}

async function makeOrder(): Promise<number> {
  const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
  return order.id;
}

// ---- streaming test helpers -------------------------------------------
// See digiflazzCatalogSyncStream.test.ts for the full rationale: plain
// `app.inject()` hangs on a genuinely-never-ending SSE response, so these
// tests use `payloadAsStream: true` (light-my-request resolves as soon as
// `streamSse` calls `reply.raw.writeHead()`, handing back a live Readable
// via `res.stream()`) and destroy the injected request afterward to drive
// streamSse's own cleanup (clearInterval + unsubscribe) instead of leaking
// its poll interval past the test.

function injectStream(url: string, cookieValue: string | null) {
  return app.inject({
    method: "GET",
    url,
    cookies: cookieValue ? { [COOKIE]: cookieValue } : {},
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

describe("GET /api/orders/:orderId/digiflazz/stream", () => {
  it("rejects an unauthenticated request with 401, no crash", async () => {
    const orderId = await makeOrder();
    const res = await injectStream(`/api/orders/${orderId}/digiflazz/stream`, null);
    expect(res.statusCode).toBe(401);
  });

  it("rejects a readonly admin with 403, mirroring GET /api/orders/:orderId's blockReadonlyReads gate", async () => {
    const orderId = await makeOrder();
    await setRole("readonly");
    const res = await injectStream(`/api/orders/${orderId}/digiflazz/stream`, cookie);
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for a nonexistent order id, without ever hijacking the reply", async () => {
    const res = await injectStream("/api/orders/999999/digiflazz/stream", cookie);
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for a non-numeric order id", async () => {
    const res = await injectStream("/api/orders/not-a-number/digiflazz/stream", cookie);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for a negative order id", async () => {
    const res = await injectStream("/api/orders/-1/digiflazz/stream", cookie);
    expect(res.statusCode).toBe(400);
  });

  it("opens the stream and pushes a freshly-created order's snapshot (no digiflazz dispatch yet) as the first frame", async () => {
    const orderId = await makeOrder();
    const res = await injectStream(`/api/orders/${orderId}/digiflazz/stream`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const chunk = await readOneChunk(res.stream());
    expect(parseSseData(chunk)).toEqual({
      orderStatus: OrderStatus.PENDING_PAYMENT,
      digiflazzStatus: null,
      digiflazzAttempts: 0,
      digiflazzNextRecheckAt: null,
      digiflazzFailureDetail: null,
    });
    await closeSseConnection(res);
  });

  it("pushes a seeded order's Digiflazz dispatch fields as the first frame", async () => {
    const orderId = await makeOrder();
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.PROCESSING,
        digiflazzStatus: "pending_at_supplier",
        digiflazzAttempts: 2,
        digiflazzNextRecheckAt: new Date("2026-08-23T12:00:00.000Z"),
        digiflazzFailureDetail: "Digiflazz timed out",
      },
    });

    const res = await injectStream(`/api/orders/${orderId}/digiflazz/stream`, cookie);
    expect(res.statusCode).toBe(200);
    const chunk = await readOneChunk(res.stream());
    expect(parseSseData(chunk)).toEqual({
      orderStatus: OrderStatus.PROCESSING,
      digiflazzStatus: "pending_at_supplier",
      digiflazzAttempts: 2,
      digiflazzNextRecheckAt: "2026-08-23T12:00:00.000Z",
      digiflazzFailureDetail: "Digiflazz timed out",
    });
    await closeSseConnection(res);
  });

  it("support and super roles keep read access, matching GET /api/orders/:orderId's RBAC", async () => {
    const orderId = await makeOrder();

    await setRole("support");
    const asSupport = await injectStream(`/api/orders/${orderId}/digiflazz/stream`, cookie);
    expect(asSupport.statusCode).toBe(200);
    await closeSseConnection(asSupport);

    await setRole("super");
    const asSuper = await injectStream(`/api/orders/${orderId}/digiflazz/stream`, cookie);
    expect(asSuper.statusCode).toBe(200);
    await closeSseConnection(asSuper);
  });
});
