// Unit coverage for redactPath() — the access-log path scrubber that keeps
// the live, single-use password-reset token out of Pino logs (CLAUDE.md:
// "Never log secrets"). Regression: the redaction regex was only ever
// anchored to the deleted Nunjucks route (`^/reset/:token`); once the reset
// flow moved to the React SPA's `POST /api/v1/auth/reset/:token` (a
// different path shape, under the /api/v1 prefix), the anchor stopped
// matching and the token started getting logged in full on every request.
// This exercises the pure function directly — no Fastify app, no captured
// log output — so the regex's behavior is pinned independent of any router.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTestDb } from "./setup-env";
import { redactPath } from "../src/server";

afterAll(() => {
  cleanupTestDb();
});

describe("redactPath", () => {
  it("redacts the current React SPA reset route (/api/v1/auth/reset/:token)", () => {
    expect(redactPath("/api/v1/auth/reset/AbCdEf123456-_token")).toBe(
      "/api/v1/auth/reset/[redacted]",
    );
  });

  it("redacts the legacy Nunjucks reset route (/reset/:token) if it ever recurs", () => {
    expect(redactPath("/reset/AbCdEf123456-_token")).toBe("/reset/[redacted]");
  });

  it("leaves a normal path with no reset token untouched", () => {
    expect(redactPath("/api/v1/products")).toBe("/api/v1/products");
    expect(redactPath("/account")).toBe("/account");
    expect(redactPath("/")).toBe("/");
  });

  it("does not touch an unrelated path merely containing the word 'reset'", () => {
    expect(redactPath("/api/v1/resetting-something")).toBe("/api/v1/resetting-something");
  });
});
