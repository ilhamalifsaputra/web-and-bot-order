import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@app/core/config", () => ({ config: { ADMIN_IDS: [] as number[] } }));

import { setAdminIds, resetBotIdentity } from "@app/core/runtime";
import {
  setupNeeded,
  isSetupCompleted,
  anyAdminPasswordSet,
  SETUP_COMPLETED_KEY,
} from "./setup";
import type { Db } from "./_types";

/** In-memory Setting store as a Db stub (only `setting.findUnique` is used). */
function stubDb(values: Record<string, string>): Db {
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        values[where.key] != null ? { key: where.key, value: values[where.key] } : null,
    },
  } as unknown as Db;
}

beforeEach(() => resetBotIdentity());

describe("setupNeeded", () => {
  it("is true on a virgin install (no setup flag, no admin password)", async () => {
    setAdminIds([111]);
    const db = stubDb({});
    expect(await setupNeeded(db)).toBe(true);
  });

  it("is false once setup_completed is 'true'", async () => {
    setAdminIds([111]);
    const db = stubDb({ [SETUP_COMPLETED_KEY]: "true" });
    expect(await isSetupCompleted(db)).toBe(true);
    expect(await setupNeeded(db)).toBe(false);
  });

  it("is false (backward compat) when an admin already has a password", async () => {
    setAdminIds([111]);
    const db = stubDb({ "web_admin_password_hash:111": "$2b$12$hash" });
    expect(await anyAdminPasswordSet(db)).toBe(true);
    expect(await setupNeeded(db)).toBe(false);
  });
});
