import { describe, it, expect, vi } from "vitest";

vi.mock("@app/core/config", () => ({ config: { ADMIN_IDS: [111] } }));

import { resolveAdminIds, ADMIN_IDS_KEY } from "./admins";
import type { Db } from "./_types";

function stubDb(settingValue: string | null): Db {
  return {
    setting: { findUnique: async () => (settingValue == null ? null : { key: ADMIN_IDS_KEY, value: settingValue }) },
  } as unknown as Db;
}

describe("resolveAdminIds", () => {
  it("returns union of env and DB, deduped", async () => {
    const ids = await resolveAdminIds(stubDb("222, 333, 111"));
    expect(ids.sort((a, b) => a - b)).toEqual([111, 222, 333]);
  });
  it("returns env only when the Setting is empty/absent", async () => {
    expect(await resolveAdminIds(stubDb(null))).toEqual([111]);
    expect(await resolveAdminIds(stubDb(""))).toEqual([111]);
  });
});
