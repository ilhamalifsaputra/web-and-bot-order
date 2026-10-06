import { describe, it, expect } from "vitest";
import { getDigiflazzSyncStatus, recordDigiflazzSyncStatus, DIGIFLAZZ_SYNC_STATUS_KEY } from "./digiflazzSyncStatus";
import { setSetting } from "./settings";
import type { Db } from "./_types";

/** Mutable in-memory Setting store backing both `findUnique` and `upsert`.
 * Mirrors the stub in poll_health.test.ts. */
function mutableStubDb(initial: Record<string, string> = {}): Db {
  const store = new Map(Object.entries(initial));
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        store.set(where.key, create.value);
        return { key: where.key, value: create.value };
      },
    },
  } as unknown as Db;
}

describe("Digiflazz catalog sync status store", () => {
  it("getDigiflazzSyncStatus on a fresh DB (never written) returns null", async () => {
    const status = await getDigiflazzSyncStatus(mutableStubDb());
    expect(status).toBeNull();
  });

  it("round-trips a full status object exactly", async () => {
    const db = mutableStubDb();
    const status = {
      status: "success" as const,
      updated: 42,
      deactivated: 3,
      added: 13,
      reactivated: 2,
      abortReason: null,
      finishedAt: "2026-08-22T01:00:00.000Z",
    };
    await recordDigiflazzSyncStatus(db, status);
    expect(await getDigiflazzSyncStatus(db)).toEqual(status);
  });

  it("a second record call fully overwrites the first (no field merging)", async () => {
    const db = mutableStubDb();
    await recordDigiflazzSyncStatus(db, {
      status: "success",
      updated: 10,
      deactivated: 1,
      added: 4,
      reactivated: 1,
      abortReason: null,
      finishedAt: "2026-08-22T00:00:00.000Z",
    });
    const second = {
      status: "aborted" as const,
      updated: 0,
      deactivated: 0,
      added: 0,
      reactivated: 0,
      abortReason: "sharp_change" as const,
      finishedAt: "2026-08-22T01:00:00.000Z",
    };
    await recordDigiflazzSyncStatus(db, second);
    expect(await getDigiflazzSyncStatus(db)).toEqual(second);
  });

  it("degrades corrupt (non-JSON) blob to null instead of throwing", async () => {
    const db = mutableStubDb();
    await setSetting(db, DIGIFLAZZ_SYNC_STATUS_KEY, "{not valid json");
    await expect(getDigiflazzSyncStatus(db)).resolves.toBeNull();
  });

  it("treats a well-formed JSON blob missing a required field as null (no per-field defaults)", async () => {
    const db = mutableStubDb();
    await setSetting(
      db,
      DIGIFLAZZ_SYNC_STATUS_KEY,
      JSON.stringify({
        status: "success",
        // updated is missing
        deactivated: 3,
        abortReason: null,
        finishedAt: "2026-08-22T01:00:00.000Z",
      }),
    );
    expect(await getDigiflazzSyncStatus(db)).toBeNull();
  });

  it("reads a blob stored before added/reactivated existed with both counts at 0", async () => {
    const db = mutableStubDb();
    await setSetting(
      db,
      DIGIFLAZZ_SYNC_STATUS_KEY,
      JSON.stringify({ status: "success", updated: 5, deactivated: 1, abortReason: null, finishedAt: "2026-08-22T01:00:00.000Z" }),
    );
    expect(await getDigiflazzSyncStatus(db)).toEqual({
      status: "success",
      updated: 5,
      deactivated: 1,
      added: 0,
      reactivated: 0,
      abortReason: null,
      finishedAt: "2026-08-22T01:00:00.000Z",
    });
  });

  it("treats a non-number added or reactivated count as a corrupt blob (null)", async () => {
    const db = mutableStubDb();
    await setSetting(
      db,
      DIGIFLAZZ_SYNC_STATUS_KEY,
      JSON.stringify({ status: "success", updated: 5, deactivated: 1, added: "13", abortReason: null, finishedAt: "2026-08-22T01:00:00.000Z" }),
    );
    expect(await getDigiflazzSyncStatus(db)).toBeNull();
  });
});
