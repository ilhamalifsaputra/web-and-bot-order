import { describe, expect, it } from "vitest";
import { CategoryGroup } from "@app/core/enums";
import { isServiceActive, listServiceStates } from "./serviceAvailability";

function settingsDb(values: Record<string, string> = {}) {
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        Object.hasOwn(values, where.key) ? { value: values[where.key] } : null,
    },
  };
}

describe("service availability", () => {
  it("defaults both customer services to active and treats legacy null groups as Premium Apps", async () => {
    const db = settingsDb();
    expect(await listServiceStates(db as never)).toEqual([
      { id: "game_topup", label: "Top Up Game", enabled: true },
      { id: "premium_apps", label: "Premium Apps", enabled: true },
    ]);
    expect(await isServiceActive(db as never, null)).toBe(true);
  });

  it("resolves each switch independently from the latest persisted value", async () => {
    const values = { service_game_topup_enabled: "false", service_premium_apps_enabled: "true" };
    const db = settingsDb(values);
    expect(await isServiceActive(db as never, CategoryGroup.GAME_TOPUP)).toBe(false);
    expect(await isServiceActive(db as never, CategoryGroup.PREMIUM_APPS)).toBe(true);
    values.service_game_topup_enabled = "true";
    expect(await isServiceActive(db as never, CategoryGroup.GAME_TOPUP)).toBe(true);
  });
});
