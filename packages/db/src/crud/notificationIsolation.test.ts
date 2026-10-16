import { describe, it, expect, vi, beforeEach } from "vitest";
import { logger } from "@app/core/logger";
import { enqueueNotificationSafely } from "./notificationIsolation";
import type { Db } from "./_types";

// A transaction-shaped client (no `$transaction`): every $executeRaw call is
// recorded, and the ROLLBACK TO SAVEPOINT one can be made to fail.
function fakeTx(failRollback: boolean) {
  const statements: string[] = [];
  const db = {
    $executeRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      statements.push(sql);
      if (failRollback && sql.startsWith("ROLLBACK")) throw new Error("rollback exploded");
      return 0;
    },
  } as unknown as Db;
  return { db, statements };
}

describe("enqueueNotificationSafely", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("logs the enqueue's own error before a failing rollback propagates", async () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const { db } = fakeTx(true);
    const original = new Error("enqueue insert failed");
    await expect(
      enqueueNotificationSafely(db, { orderId: 7, notification: "paid email" }, async () => { throw original; }),
    ).rejects.toThrow("rollback exploded");
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]![0]).toMatchObject({ err: original, orderId: 7 });
  });

  it("swallows the enqueue failure and logs once when the rollback succeeds", async () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const { db, statements } = fakeTx(false);
    await enqueueNotificationSafely(db, { orderId: 7, notification: "paid email" }, async () => { throw new Error("x"); });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(statements.some((s) => s.startsWith("ROLLBACK"))).toBe(true);
  });
});
