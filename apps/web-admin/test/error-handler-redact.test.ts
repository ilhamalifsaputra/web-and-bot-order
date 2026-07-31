// Regression test for web-admin's global error handler (server.ts).
// Mirrors apps/storefront/test/error-handler-redact.test.ts: asserts the
// *logged* metadata from the actual Fastify error handler is redacted, not
// just that the redactPath() regex itself works.
//
// Security patch: web-admin's setErrorHandler logged the raw, unredacted
// req.url (including any query string), unlike the onResponse access-log
// hook two lines above it, which already stripped the query string with an
// explicit "may carry reset tokens" comment. No admin route embeds a secret
// in a URL today (the reset code travels via Telegram DM + POST body), but
// the storefront had this identical gap once (a Critical review finding) and
// this test keeps web-admin's error handler from silently reintroducing it
// if a future route ever does (CLAUDE.md: "Never log secrets").
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { logger } from "@app/core/logger";
import { prisma, initDb, setSetting } from "@app/db";
import { buildApp } from "../src/server";

let app: FastifyInstance;

beforeAll(async () => {
  await initDb();
  // Keep the first-run setup gate open — this suite models a configured
  // deploy, same as apps/web-admin/test/web.test.ts.
  await setSetting(prisma, "setup_completed", "true");
  app = await buildApp();
  // Test-only route shaped like a hypothetical /reset/:code URL that always
  // throws, so we can drive an unhandled error through app.setErrorHandler
  // without depending on any real route.
  app.get("/reset/:code/__test_throw", async () => {
    throw new Error("boom (test-only, exercising the error handler)");
  });
  // Test-only route for the query-string case (M-19): a query string can
  // carry secrets too (e.g. the storefront's Telegram Login HMAC payload),
  // so the error handler must strip it the same way the access-log hook does.
  app.get("/__test_throw_query", async () => {
    throw new Error("boom (test-only, exercising the error handler)");
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("web-admin setErrorHandler", () => {
  it("redacts a reset-code-shaped segment from the logged path on an unhandled error", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const secretCode = "AbCdEf123456-_liveResetCode";

    const res = await app.inject({
      method: "GET",
      url: `/reset/${secretCode}/__test_throw`,
    });

    expect(res.statusCode).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    const loggedMeta = errorSpy.mock.calls[0]?.[0] as { path?: string };
    expect(loggedMeta.path).toBe("/reset/[redacted]/__test_throw");
    expect(loggedMeta.path).not.toContain(secretCode);

    errorSpy.mockRestore();
  });

  it("strips the query string from the logged path on an unhandled error (M-19)", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const secretQuery = "token=AbCdEf123456-_liveSecretQueryValue";

    const res = await app.inject({
      method: "GET",
      url: `/__test_throw_query?${secretQuery}`,
    });

    expect(res.statusCode).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    const loggedMeta = errorSpy.mock.calls[0]?.[0] as { path?: string };
    expect(loggedMeta.path).toBe("/__test_throw_query");
    expect(loggedMeta.path).not.toContain("?");
    expect(loggedMeta.path).not.toContain(secretQuery);

    errorSpy.mockRestore();
  });
});
