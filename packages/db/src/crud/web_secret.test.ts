import { describe, it, expect, vi } from "vitest";

vi.mock("@app/core/config", () => ({ config: { WEB_COOKIE_SECRET: undefined } }));

import { resolveWebCookieSecret, WEB_COOKIE_SECRET_KEY } from "./web_secret";
import type { Db } from "./_types";

function stubDb(initial: string | null) {
  const store: Record<string, string> = {};
  if (initial != null) store[WEB_COOKIE_SECRET_KEY] = initial;
  const db = {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        store[where.key] != null ? { key: where.key, value: store[where.key] } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        store[where.key] = create.value;
        return { key: where.key, value: create.value };
      },
    },
  } as unknown as Db;
  return { db, store };
}

describe("resolveWebCookieSecret", () => {
  it("generates + persists a >=32 char secret when none exists", async () => {
    const { db, store } = stubDb(null);
    const secret = await resolveWebCookieSecret(db);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(store[WEB_COOKIE_SECRET_KEY]).toBe(secret);
  });
  it("reuses the persisted secret on the next boot", async () => {
    const { db } = stubDb("x".repeat(64));
    expect(await resolveWebCookieSecret(db)).toBe("x".repeat(64));
  });
});
