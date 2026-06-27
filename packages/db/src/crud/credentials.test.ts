import { describe, it, expect, vi } from "vitest";

vi.mock("@app/core/config", () => ({
  config: { BOT_TOKEN: undefined, BOT_USERNAME: undefined, NOTIF_BOT_TOKEN: undefined, PUBLIC_CHANNEL_ID: -100999 },
}));

import { resolveBotCredentials } from "./credentials";
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

describe("resolveBotCredentials publicChannelId", () => {
  it("parses the numeric Setting (Setting wins over env)", async () => {
    const creds = await resolveBotCredentials(stubDb({ public_channel_id: "-1003960444894" }));
    expect(creds.publicChannelId).toBe(-1003960444894);
  });

  it("falls back to env config.PUBLIC_CHANNEL_ID when the Setting is blank", async () => {
    const creds = await resolveBotCredentials(stubDb({ public_channel_id: "  " }));
    expect(creds.publicChannelId).toBe(-100999);
  });

  it("falls back to env when the Setting is non-numeric garbage", async () => {
    const creds = await resolveBotCredentials(stubDb({ public_channel_id: "@notanumber" }));
    expect(creds.publicChannelId).toBe(-100999);
  });

  it("uses env (no crash) when the Setting row is absent entirely", async () => {
    const creds = await resolveBotCredentials(stubDb({}));
    expect(creds.publicChannelId).toBe(-100999);
  });
});
