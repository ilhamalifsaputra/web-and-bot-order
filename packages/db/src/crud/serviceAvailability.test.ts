import { describe, expect, it } from "vitest";
import { CategoryGroup } from "@app/core/enums";
import { CUSTOMER_SERVICES, SERVICE_CHANNELS } from "@app/core/services";
import { ValidationError } from "@app/core/errors";
import {
  activeServiceGroups,
  assertServiceActive,
  isServiceActive,
  listServiceStates,
} from "./serviceAvailability";

function settingsDb(values: Record<string, string> = {}) {
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        Object.hasOwn(values, where.key) ? { value: values[where.key] } : null,
    },
  };
}

describe("service registry keys", () => {
  it("defines a bot key, a web key and the legacy key for each service", () => {
    expect(SERVICE_CHANNELS).toEqual(["bot", "web"]);
    expect(CUSTOMER_SERVICES.map((service) => ({
      id: service.id,
      settingKeys: service.settingKeys,
      legacySettingKey: service.legacySettingKey,
    }))).toEqual([
      {
        id: "game_topup",
        settingKeys: { bot: "service_game_topup_enabled_bot", web: "service_game_topup_enabled_web" },
        legacySettingKey: "service_game_topup_enabled",
      },
      {
        id: "premium_apps",
        settingKeys: { bot: "service_premium_apps_enabled_bot", web: "service_premium_apps_enabled_web" },
        legacySettingKey: "service_premium_apps_enabled",
      },
    ]);
  });
});

describe("service availability", () => {
  it("defaults both customer services to active on both channels and treats null groups as Premium Apps", async () => {
    const db = settingsDb();
    expect(await listServiceStates(db as never)).toEqual([
      { id: "game_topup", label: "Top Up Game", enabledBot: true, enabledWeb: true },
      { id: "premium_apps", label: "Premium Apps", enabledBot: true, enabledWeb: true },
    ]);
    expect(await isServiceActive(db as never, null, "bot")).toBe(true);
    expect(await isServiceActive(db as never, null, "web")).toBe(true);
  });

  it("maps a null group to the Premium Apps keys", async () => {
    const db = settingsDb({ service_premium_apps_enabled_web: "false" });
    expect(await isServiceActive(db as never, null, "web")).toBe(false);
    expect(await isServiceActive(db as never, null, "bot")).toBe(true);
    expect(await isServiceActive(db as never, CategoryGroup.GAME_TOPUP, "web")).toBe(true);
  });

  it("keeps the bot and web switches independent", async () => {
    const botOff = settingsDb({ service_game_topup_enabled_bot: "false" });
    expect(await isServiceActive(botOff as never, CategoryGroup.GAME_TOPUP, "bot")).toBe(false);
    expect(await isServiceActive(botOff as never, CategoryGroup.GAME_TOPUP, "web")).toBe(true);

    const webOff = settingsDb({ service_game_topup_enabled_web: "false" });
    expect(await isServiceActive(webOff as never, CategoryGroup.GAME_TOPUP, "bot")).toBe(true);
    expect(await isServiceActive(webOff as never, CategoryGroup.GAME_TOPUP, "web")).toBe(false);
  });

  it("falls back to the legacy key when the channel key is absent", async () => {
    const db = settingsDb({ service_game_topup_enabled: "false" });
    expect(await isServiceActive(db as never, CategoryGroup.GAME_TOPUP, "bot")).toBe(false);
    expect(await isServiceActive(db as never, CategoryGroup.GAME_TOPUP, "web")).toBe(false);
    expect(await isServiceActive(db as never, CategoryGroup.PREMIUM_APPS, "bot")).toBe(true);
  });

  it("lets a present channel key override the legacy key", async () => {
    const db = settingsDb({ service_game_topup_enabled: "false", service_game_topup_enabled_bot: "true" });
    expect(await isServiceActive(db as never, CategoryGroup.GAME_TOPUP, "bot")).toBe(true);
    expect(await isServiceActive(db as never, CategoryGroup.GAME_TOPUP, "web")).toBe(false);

    const reverse = settingsDb({ service_premium_apps_enabled: "true", service_premium_apps_enabled_web: "false" });
    expect(await isServiceActive(reverse as never, CategoryGroup.PREMIUM_APPS, "web")).toBe(false);
    expect(await isServiceActive(reverse as never, CategoryGroup.PREMIUM_APPS, "bot")).toBe(true);
  });

  it("treats only a trimmed, case-insensitive \"false\" as disabled", async () => {
    const db = settingsDb({
      service_game_topup_enabled_bot: "FALSE ",
      service_game_topup_enabled_web: " false",
      service_premium_apps_enabled_bot: "no",
      service_premium_apps_enabled_web: "",
    });
    expect(await isServiceActive(db as never, CategoryGroup.GAME_TOPUP, "bot")).toBe(false);
    expect(await isServiceActive(db as never, CategoryGroup.GAME_TOPUP, "web")).toBe(false);
    expect(await isServiceActive(db as never, CategoryGroup.PREMIUM_APPS, "bot")).toBe(true);
    expect(await isServiceActive(db as never, CategoryGroup.PREMIUM_APPS, "web")).toBe(true);
  });

  it("resolves from the latest persisted value on every call", async () => {
    const values: Record<string, string> = { service_game_topup_enabled_bot: "false" };
    const db = settingsDb(values);
    expect(await isServiceActive(db as never, CategoryGroup.GAME_TOPUP, "bot")).toBe(false);
    values.service_game_topup_enabled_bot = "true";
    expect(await isServiceActive(db as never, CategoryGroup.GAME_TOPUP, "bot")).toBe(true);
  });

  it("reports per-channel states in listServiceStates", async () => {
    const db = settingsDb({
      service_game_topup_enabled_bot: "false",
      service_premium_apps_enabled: "false",
      service_premium_apps_enabled_bot: "true",
    });
    expect(await listServiceStates(db as never)).toEqual([
      { id: "game_topup", label: "Top Up Game", enabledBot: false, enabledWeb: true },
      { id: "premium_apps", label: "Premium Apps", enabledBot: true, enabledWeb: false },
    ]);
  });

  it("returns the active groups for the requested channel only", async () => {
    const db = settingsDb({ service_game_topup_enabled_web: "false" });
    expect(await activeServiceGroups(db as never, "bot")).toEqual(
      new Set([CategoryGroup.GAME_TOPUP, CategoryGroup.PREMIUM_APPS]),
    );
    expect(await activeServiceGroups(db as never, "web")).toEqual(new Set([CategoryGroup.PREMIUM_APPS]));
  });

  it("throws service_unavailable only for the disabled channel", async () => {
    const db = settingsDb({ service_premium_apps_enabled_bot: "false" });
    await expect(assertServiceActive(db as never, CategoryGroup.PREMIUM_APPS, "bot")).rejects.toThrow(ValidationError);
    await expect(assertServiceActive(db as never, null, "bot")).rejects.toThrow("error.service_unavailable");
    await expect(assertServiceActive(db as never, CategoryGroup.PREMIUM_APPS, "web")).resolves.toBeUndefined();
    await expect(assertServiceActive(db as never, CategoryGroup.GAME_TOPUP, "bot")).resolves.toBeUndefined();
  });
});
