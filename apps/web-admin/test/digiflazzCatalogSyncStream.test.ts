import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, recordDigiflazzSyncStatus, getDigiflazzSyncStatus } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
const STREAM_URL = "/api/dashboard/digiflazz-sync/stream";

let app: FastifyInstance;
let cookie: string;

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
});

// ---- streaming test helpers -------------------------------------------
//
// Plain `app.inject()` (light-my-request) accumulates the entire response
// body and only resolves once the handler's response ends — which never
// happens for streamSse's genuinely-never-ending SSE connection, so
// `await app.inject({ url: STREAM_URL, ... })` would hang the test forever.
//
// `payloadAsStream: true` avoids that: per
// node_modules/light-my-request/lib/response.js's `Response.prototype
// .writeHead` override, in this mode the injected response's promise
// resolves as soon as `writeHead()` is called — which streamSse does
// immediately after `reply.hijack()`, well before any `data:` frame is
// written — handing back a live Readable via `res.stream()` instead of
// waiting for the connection to close. That lets a test read the first
// `data:` frame off a genuinely open connection without hanging, so this
// is the approach used below (brief's option 1) rather than the two-level
// fallback (option 2).
//
// To keep each test from leaking streamSse's internal `setInterval` past
// its own scope, `closeSseConnection` destroys the underlying injected
// request object — accessed via `res.raw.res.req`, the same object as the
// route handler's own `req.raw`, since light-my-request's `Response`
// subclasses `http.ServerResponse`, on which Node sets `.req` internally
// (not part of light-my-request's own TS declarations, hence the cast
// below). Destroying it emits `close` on that request object, which is
// exactly the event streamSse listens for (`req.raw.on("close", cleanup)`)
// to clear its interval, unsubscribe, and end the response.

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
  // Let light-my-request's Request#destroy (process.nextTick(() =>
  // emit("close"))) actually run, which drives streamSse's own cleanup
  // (clearInterval + unsubscribe + reply.raw.end()) off that event.
  await new Promise((resolve) => setImmediate(resolve));
}

function parseSseData(chunk: string): unknown {
  const line = chunk.split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`No "data:" line in SSE chunk: ${JSON.stringify(chunk)}`);
  return JSON.parse(line.slice("data: ".length));
}

describe("GET /api/dashboard/digiflazz-sync/stream", () => {
  it("rejects an unauthenticated request with 401, no crash", async () => {
    const res = await injectStream(STREAM_URL, null);
    expect(res.statusCode).toBe(401);
  });

  it("opens the stream and pushes the never-run empty state (null) as the first frame", async () => {
    const res = await injectStream(STREAM_URL, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const chunk = await readOneChunk(res.stream());
    expect(parseSseData(chunk)).toBeNull();
    await closeSseConnection(res);
  });

  it("pushes the last recorded sync outcome as the first frame", async () => {
    await recordDigiflazzSyncStatus(prisma, {
      status: "success",
      updated: 12,
      deactivated: 3,
      abortReason: null,
      finishedAt: "2026-08-22T10:00:00.000Z",
    });

    const res = await injectStream(STREAM_URL, cookie);
    expect(res.statusCode).toBe(200);
    const chunk = await readOneChunk(res.stream());
    expect(parseSseData(chunk)).toEqual({
      status: "success",
      updated: 12,
      deactivated: 3,
      abortReason: null,
      finishedAt: "2026-08-22T10:00:00.000Z",
    });
    await closeSseConnection(res);

    // Belt-and-suspenders: the route's `readStatus` closure is just
    // `getDigiflazzSyncStatus(prisma)` — confirm the underlying data-access
    // function reads the identical shape directly (not through HTTP/SSE).
    const direct = await getDigiflazzSyncStatus(prisma);
    expect(direct).toEqual({
      status: "success",
      updated: 12,
      deactivated: 3,
      abortReason: null,
      finishedAt: "2026-08-22T10:00:00.000Z",
    });
  });
});
