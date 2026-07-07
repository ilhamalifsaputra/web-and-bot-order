// Regression test for the storefront's global error handler (server.ts).
// Split out from redact-path.test.ts (which pins redactPath() as a pure
// function, no Fastify app) because this exercises the actual Fastify error
// handler and asserts the *logged* metadata, not just the redaction regex.
//
// Task 3 follow-up: a Critical review finding caught app.setErrorHandler()
// logging `req.url` directly instead of `redactPath(req.url)` — the exact
// live, single-use reset-token leak the onResponse access-log hook was
// fixed to prevent, just via a second call site in the same file
// (CLAUDE.md: "Never log secrets").
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import { logger } from "@app/core/logger";
import { prisma, initDb, setSetting } from "@app/db";
import { buildApp } from "../src/server";

let app: FastifyInstance;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  // Storefront tests model a live shop — keep the setup gate open (mirrors
  // storefront.test.ts), otherwise setupGatePlugin's onRequest hook serves
  // the 503 "shop not active yet" page before our route ever runs.
  await setSetting(prisma, "setup_completed", "true");
  // Test-only route shaped like the real reset-token route
  // (/api/v1/auth/reset/:token) that always throws, so we can drive an
  // unhandled error through app.setErrorHandler without depending on the
  // real reset flow's DB/validation internals.
  app.get("/api/v1/auth/reset/:token/__test_throw", async () => {
    throw new Error("boom (test-only, exercising the error handler)");
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

describe("storefront setErrorHandler", () => {
  it("redacts the reset token from the logged path on an unhandled error", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const secretToken = "AbCdEf123456-_liveResetToken";

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/reset/${secretToken}/__test_throw`,
    });

    expect(res.statusCode).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    const loggedMeta = errorSpy.mock.calls[0]?.[0] as { path?: string };
    expect(loggedMeta.path).toBe("/api/v1/auth/reset/[redacted]/__test_throw");
    expect(loggedMeta.path).not.toContain(secretToken);

    errorSpy.mockRestore();
  });
});
