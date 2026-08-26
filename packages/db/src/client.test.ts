// Whole-branch review finding I-4: Prisma's SQLite connection pool defaults
// to several physical connections, so initDb()'s per-connection PRAGMAs
// (foreign_keys, busy_timeout, synchronous) only reliably apply once the
// datasource URL is pinned to a single connection. This is a pure unit test
// on the URL-construction helper only — actual pool behavior was verified
// empirically (40 concurrent queries: 4 connections without the param, 1
// with it; see the client.ts doc comment) rather than asserted here, since
// asserting real pool sizing isn't practical in this test harness.
import { describe, it, expect } from "vitest";
import { withConnectionLimit } from "./client";

describe("withConnectionLimit", () => {
  it("appends connection_limit=1 to a bare file: URL with no existing query string", () => {
    expect(withConnectionLimit("file:../data/bot.db")).toBe("file:../data/bot.db?connection_limit=1");
  });

  it("appends connection_limit=1 with & when the URL already has a query string", () => {
    expect(withConnectionLimit("file:./test.db?mode=rwc")).toBe("file:./test.db?mode=rwc&connection_limit=1");
  });

  it("is idempotent — leaves an explicit connection_limit already present untouched", () => {
    expect(withConnectionLimit("file:./test.db?connection_limit=5")).toBe("file:./test.db?connection_limit=5");
  });

  it("recognizes an existing connection_limit even when it isn't the first query param", () => {
    expect(withConnectionLimit("file:./test.db?mode=rwc&connection_limit=3")).toBe(
      "file:./test.db?mode=rwc&connection_limit=3",
    );
  });
});
