import { CategoryGroup, type CategoryGroup as CategoryGroupType } from "./enums";

/** Where a customer reaches a service: the Telegram bot or the website. */
export const SERVICE_CHANNELS = ["bot", "web"] as const;
export type ServiceChannel = (typeof SERVICE_CHANNELS)[number];

/**
 * Customer-facing service groups. Adding one here automatically adds its admin switches.
 * Each channel has its own on/off key; when a channel key has no row yet, the
 * pre-split `legacySettingKey` still decides, so existing switches keep working.
 */
export const CUSTOMER_SERVICES = [
  {
    id: "game_topup",
    label: "Top Up Game",
    group: CategoryGroup.GAME_TOPUP,
    settingKeys: { bot: "service_game_topup_enabled_bot", web: "service_game_topup_enabled_web" },
    legacySettingKey: "service_game_topup_enabled",
    translationKey: "browse.group_game_topup",
  },
  {
    id: "premium_apps",
    label: "Premium Apps",
    group: CategoryGroup.PREMIUM_APPS,
    settingKeys: { bot: "service_premium_apps_enabled_bot", web: "service_premium_apps_enabled_web" },
    legacySettingKey: "service_premium_apps_enabled",
    translationKey: "browse.group_premium_apps",
  },
] as const;

export type CustomerService = (typeof CUSTOMER_SERVICES)[number];
export type CustomerServiceId = CustomerService["id"];

/** Older categories have no group and belong to Premium Apps at display time. */
export function serviceForCategoryGroup(group: CategoryGroupType | null): CustomerService {
  return CUSTOMER_SERVICES.find((service) => service.group === (group ?? CategoryGroup.PREMIUM_APPS))
    ?? CUSTOMER_SERVICES.find((service) => service.group === CategoryGroup.PREMIUM_APPS)!;
}
