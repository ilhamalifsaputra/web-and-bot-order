import { CategoryGroup, type CategoryGroup as CategoryGroupType } from "./enums";

/** Customer-facing service groups. Adding one here automatically adds its admin switch. */
export const CUSTOMER_SERVICES = [
  {
    id: "game_topup",
    label: "Top Up Game",
    group: CategoryGroup.GAME_TOPUP,
    settingKey: "service_game_topup_enabled",
    translationKey: "browse.group_game_topup",
  },
  {
    id: "premium_apps",
    label: "Premium Apps",
    group: CategoryGroup.PREMIUM_APPS,
    settingKey: "service_premium_apps_enabled",
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
