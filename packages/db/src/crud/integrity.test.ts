import { describe, it, expect } from "vitest";
import { missingTables, PAYMENT_LEDGER_TABLES } from "./integrity";
import type { Db } from "./_types";

/**
 * Db stub: `$queryRawUnsafe` echoes back the queried names that are "present",
 * mirroring `SELECT name FROM sqlite_master ... WHERE name IN (...)`.
 */
function stubDb(present: string[]): Db {
  const set = new Set(present);
  return {
    $queryRawUnsafe: async (_sql: string, ...names: string[]) =>
      names.filter((n) => set.has(n)).map((name) => ({ name })),
  } as unknown as Db;
}

describe("missingTables", () => {
  it("returns the names that do not exist, in input order", async () => {
    const db = stubDb(["a", "c"]);
    expect(await missingTables(db, ["a", "b", "c", "d"])).toEqual(["b", "d"]);
  });

  it("returns [] when every requested table exists", async () => {
    const db = stubDb([...PAYMENT_LEDGER_TABLES]);
    expect(await missingTables(db, [...PAYMENT_LEDGER_TABLES])).toEqual([]);
  });

  it("flags the drift that broke NOWPayments/PayDisini delivery", async () => {
    // Live DB had tokopay + outbox but not the two newer ledgers.
    const db = stubDb(["processed_tokopay_tx", "notification_outbox"]);
    expect(await missingTables(db, [...PAYMENT_LEDGER_TABLES])).toEqual([
      "processed_binance_tx",
      "processed_bybit_tx",
      "processed_paydisini_tx",
      "processed_nowpayments_tx",
    ]);
  });

  it("returns [] for empty input without touching the DB", async () => {
    let called = false;
    const db = {
      $queryRawUnsafe: async () => {
        called = true;
        return [];
      },
    } as unknown as Db;
    expect(await missingTables(db, [])).toEqual([]);
    expect(called).toBe(false);
  });
});
