import { describe, expect, it } from "vitest";
import { CategoryGroup } from "./enums";
import { CUSTOMER_SERVICES, DEFAULT_LIST_SELECTION, listSelectionFor, serviceForCategoryGroup, usesNumberedSelection, type CustomerServiceDefinition } from "./services";

describe("service list selection", () => {
  it("Premium Apps (and a legacy null group) is numbered; Game Top-up is inline", () => {
    expect(listSelectionFor(CategoryGroup.PREMIUM_APPS)).toBe("numbered");
    expect(listSelectionFor(null)).toBe("numbered");
    expect(listSelectionFor(undefined)).toBe("numbered");
    expect(listSelectionFor(CategoryGroup.GAME_TOPUP)).toBe("inline");
    expect(usesNumberedSelection(CategoryGroup.GAME_TOPUP)).toBe(false);
    expect(usesNumberedSelection(CategoryGroup.PREMIUM_APPS)).toBe(true);
  });

  it("an unregistered group resolves like serviceForCategoryGroup: to Premium Apps", () => {
    expect(listSelectionFor("NOT_A_SERVICE")).toBe("numbered");
  });

  it("a newly registered service without its own setting gets the inline default", () => {
    expect(DEFAULT_LIST_SELECTION).toBe("inline");
    const steam: CustomerServiceDefinition = {
      id: "steam_wallet",
      label: "Steam Wallet",
      group: "STEAM_WALLET",
      settingKeys: { bot: "service_steam_wallet_enabled_bot", web: "service_steam_wallet_enabled_web" },
      translationKey: "browse.group_steam_wallet",
    };
    const services = [...CUSTOMER_SERVICES, steam];
    expect(listSelectionFor("STEAM_WALLET", services)).toBe("inline");
    expect(usesNumberedSelection("STEAM_WALLET", services)).toBe(false);
    expect(usesNumberedSelection(CategoryGroup.PREMIUM_APPS, services)).toBe(true);
  });

  it("serviceForCategoryGroup reads an injected registry with the same fallbacks", () => {
    const steam: CustomerServiceDefinition = {
      id: "steam_wallet",
      label: "Steam Wallet",
      group: "STEAM_WALLET",
      settingKeys: { bot: "service_steam_wallet_enabled_bot", web: "service_steam_wallet_enabled_web" },
      translationKey: "browse.group_steam_wallet",
    };
    const services = [...CUSTOMER_SERVICES, steam];
    expect(serviceForCategoryGroup("STEAM_WALLET", services)).toBe(steam);
    expect(serviceForCategoryGroup(null, services).id).toBe("premium_apps");
    expect(serviceForCategoryGroup("NOT_A_SERVICE", services).id).toBe("premium_apps");
    expect(serviceForCategoryGroup(CategoryGroup.GAME_TOPUP, services).id).toBe("game_topup");
    // The default registry is unchanged.
    expect(serviceForCategoryGroup("STEAM_WALLET" as never).id).toBe("premium_apps");
  });
});
