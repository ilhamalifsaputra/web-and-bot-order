import { CategoryGroup, type CategoryGroup as CategoryGroupType } from "./enums";

/** Where a customer reaches a service: the Telegram bot or the website. */
export const SERVICE_CHANNELS = ["bot", "web"] as const;
export type ServiceChannel = (typeof SERVICE_CHANNELS)[number];

/**
 * How the bot lets a buyer pick from a service's product list and pickers.
 *  - "inline": one inline button per option on the list bubble itself; no
 *    numbered caption, no digit reply keyboard, no companion message.
 *  - "numbered": the numbered caption plus the digit reply keyboard (sent as
 *    one companion message), kept only for Premium Apps.
 * A service that does not state it gets {@link DEFAULT_LIST_SELECTION}.
 */
export type ListSelection = "inline" | "numbered";
export const DEFAULT_LIST_SELECTION: ListSelection = "inline";

/** The shape every registry entry must satisfy (see CUSTOMER_SERVICES). */
export interface CustomerServiceDefinition {
  id: string;
  label: string;
  /** The Category.group value (a free String column) that belongs to this service. */
  group: string;
  settingKeys: Record<ServiceChannel, string>;
  legacySettingKey?: string;
  /** Locale key of the service button / tag (en + id). */
  translationKey: string;
  /** Optional; omitted means {@link DEFAULT_LIST_SELECTION}. */
  listSelection?: ListSelection;
}

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
    listSelection: "inline",
  },
  {
    id: "premium_apps",
    label: "Premium Apps",
    group: CategoryGroup.PREMIUM_APPS,
    settingKeys: { bot: "service_premium_apps_enabled_bot", web: "service_premium_apps_enabled_web" },
    legacySettingKey: "service_premium_apps_enabled",
    translationKey: "browse.group_premium_apps",
    listSelection: "numbered",
  },
] as const satisfies readonly CustomerServiceDefinition[];

export type CustomerService = (typeof CUSTOMER_SERVICES)[number];
export type CustomerServiceId = CustomerService["id"];

/** Older categories have no group and belong to Premium Apps at display time. */
export function serviceForCategoryGroup(group: CategoryGroupType | null): CustomerService {
  return CUSTOMER_SERVICES.find((service) => service.group === (group ?? CategoryGroup.PREMIUM_APPS))
    ?? CUSTOMER_SERVICES.find((service) => service.group === CategoryGroup.PREMIUM_APPS)!;
}

/**
 * The list-selection style of a category group, through the same resolution
 * as serviceForCategoryGroup: a null/undefined group (legacy category) and an
 * unregistered group resolve to Premium Apps; a registered service without its
 * own `listSelection` gets the default ("inline"). `services` is the registry
 * to read, a parameter only so a test can add a service of its own.
 */
export function listSelectionFor(
  group: string | null | undefined,
  services: readonly CustomerServiceDefinition[] = CUSTOMER_SERVICES,
): ListSelection {
  const premium = services.find((service) => service.group === CategoryGroup.PREMIUM_APPS);
  const service = services.find((entry) => entry.group === (group ?? CategoryGroup.PREMIUM_APPS)) ?? premium;
  return service?.listSelection ?? DEFAULT_LIST_SELECTION;
}

/** True when the group's lists use the numbered caption + digit reply keyboard (Premium Apps only today). */
export function usesNumberedSelection(
  group: string | null | undefined,
  services: readonly CustomerServiceDefinition[] = CUSTOMER_SERVICES,
): boolean {
  return listSelectionFor(group, services) === "numbered";
}
