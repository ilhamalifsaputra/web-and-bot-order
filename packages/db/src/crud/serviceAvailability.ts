import {
  CUSTOMER_SERVICES,
  serviceForCategoryGroup,
  type CustomerService,
  type ServiceChannel,
} from "@app/core/services";
import type { CategoryGroup } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import type { Db } from "./_types";

/**
 * Read directly from Setting: a different app process may have changed it moments ago.
 * The channel key wins whenever its row exists; otherwise the pre-split legacy key
 * decides; with neither row the service is on. Only "false" (any case/whitespace) disables.
 */
async function resolveServiceEnabled(db: Db, service: CustomerService, channel: ServiceChannel): Promise<boolean> {
  const channelSetting = await db.setting.findUnique({ where: { key: service.settingKeys[channel] } });
  const setting = channelSetting ?? await db.setting.findUnique({ where: { key: service.legacySettingKey } });
  return setting?.value.trim().toLowerCase() !== "false";
}

export async function isServiceActive(db: Db, group: CategoryGroup | null, channel: ServiceChannel): Promise<boolean> {
  return resolveServiceEnabled(db, serviceForCategoryGroup(group), channel);
}

export async function listServiceStates(db: Db) {
  return Promise.all(CUSTOMER_SERVICES.map(async (service) => ({
    id: service.id,
    label: service.label,
    enabledBot: await resolveServiceEnabled(db, service, "bot"),
    enabledWeb: await resolveServiceEnabled(db, service, "web"),
  })));
}

export async function activeServiceGroups(db: Db, channel: ServiceChannel): Promise<Set<string>> {
  const enabled = await Promise.all(CUSTOMER_SERVICES.map(async (service) => ({
    group: service.group,
    enabled: await resolveServiceEnabled(db, service, channel),
  })));
  return new Set(enabled.filter((entry) => entry.enabled).map((entry) => entry.group));
}

export async function assertServiceActive(db: Db, group: CategoryGroup | null, channel: ServiceChannel): Promise<void> {
  if (!(await isServiceActive(db, group, channel))) {
    throw new ValidationError("error.service_unavailable");
  }
}
