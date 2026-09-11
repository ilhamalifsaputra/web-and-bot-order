// `withConnectionLimit` was SQLite-only (pinned Prisma's connection pool to 1
// so its per-connection PRAGMAs applied to every connection) and was removed
// once the datasource moved to Postgres, which has no such constraint. What
// remains worth a smoke test is `initDb()`, now a no-op kept only so its many
// existing `await initDb()` call sites across apps/scripts/tests keep working
// unchanged — this asserts that no-op stays a harmless, resolving no-op.
import { describe, it, expect } from "vitest";
import { initDb } from "./client";

describe("initDb", () => {
  it("resolves without throwing (Postgres needs no per-connection setup)", async () => {
    await expect(initDb()).resolves.toBeUndefined();
  });

  it("is safely callable more than once", async () => {
    await expect(initDb()).resolves.toBeUndefined();
    await expect(initDb()).resolves.toBeUndefined();
  });
});
