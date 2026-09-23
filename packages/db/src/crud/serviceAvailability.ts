import { CUSTOMER_SERVICES, serviceForCategoryGroup } from "@app/core/services";
import type { CategoryGroup } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import type { Db } from "./_types";

/** Read directly from Setting: a different app process may have changed it moments ago. */
export async function isServiceActive(db: Db, group: CategoryGroup | null): Promise<boolean> {
  const service = serviceForCategoryGroup(group);
  const setting = await db.setting.findUnique({ where: { key: service.settingKey } });
  return setting?.value.trim().toLowerCase() !== "false";
}

export async function listServiceStates(db: Db) {
  return Promise.all(CUSTOMER_SERVICES.map(async (service) => ({
    id: service.id,
    label: service.label,
    enabled: await isServiceActive(db, service.group),
  })));
}

export async function activeServiceGroups(db: Db): Promise<Set<string>> {
  const states = await listServiceStates(db);
  const enabledIds = new Set(states.filter((state) => state.enabled).map((state) => state.id));
  return new Set(CUSTOMER_SERVICES.filter((service) => enabledIds.has(service.id)).map((service) => service.group));
}

export async function assertServiceActive(db: Db, group: CategoryGroup | null): Promise<void> {
  if (!(await isServiceActive(db, group))) {
    throw new ValidationError("error.service_unavailable");
  }
}
