import { describe, it, expect } from "vitest";
import { missingTables, PAYMENT_LEDGER_TABLES } from "./integrity";
import { prisma } from "../client";

/**
 * Runs against the real dev Postgres container (DATABASE_URL_PRISMA in
 * .env), not a mock — `missingTables()` now queries
 * `information_schema.tables`, which only a real Postgres connection can
 * answer meaningfully. `prisma db push` must have been run against that
 * container first so the real tables exist to assert against.
 */
describe("missingTables", () => {
  it("returns [] when every requested table exists", async () => {
    expect(await missingTables(prisma, [...PAYMENT_LEDGER_TABLES])).toEqual([]);
  });

  it("returns [] when a mix of real tables all exist", async () => {
    expect(await missingTables(prisma, ["users", "categories", "orders"])).toEqual([]);
  });

  it("returns the names that do not exist, in input order, alongside real ones that do", async () => {
    expect(
      await missingTables(prisma, ["users", "no_such_table_xyz", "categories", "also_missing_abc"]),
    ).toEqual(["no_such_table_xyz", "also_missing_abc"]);
  });

  it("flags the drift that broke NOWPayments/PayDisini delivery (simulated: table names outside the real schema)", async () => {
    expect(
      await missingTables(prisma, ["processed_tokopay_tx", "notification_outbox", "processed_ghost_tx"]),
    ).toEqual(["processed_ghost_tx"]);
  });

  it("returns [] for empty input without touching the DB", async () => {
    expect(await missingTables(prisma, [])).toEqual([]);
  });
});
