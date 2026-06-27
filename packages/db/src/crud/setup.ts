/**
 * First-run (setup wizard) detection — spec §3. Shared source of truth so
 * web-admin and storefront (which must not import each other) agree on whether
 * the buyer has finished onboarding.
 *
 *   setupNeeded = setup_completed !== "true" && no admin has a web password yet
 *
 * The second clause keeps existing deploys (an admin already bootstrapped a
 * password) out of the wizard forever — backward compatible.
 */
import { adminIds } from "@app/core/runtime";
import type { Db } from "./_types";
import { getSetting, setSetting } from "./settings";

export const SETUP_COMPLETED_KEY = "setup_completed";

// Storage contract mirrored from apps/web-admin/src/auth.ts `passwordHashKey`.
// Kept here (not imported) so @app/db stays free of an app-layer dependency.
const PWD_HASH_PREFIX = "web_admin_password_hash:";

/** True if ANY admin (env ∪ DB) already has a web password hash stored. */
export async function anyAdminPasswordSet(db: Db): Promise<boolean> {
  for (const tgId of adminIds()) {
    if ((await getSetting(db, `${PWD_HASH_PREFIX}${tgId}`)) !== null) return true;
  }
  return false;
}

/** True once the wizard's final step has run. */
export async function isSetupCompleted(db: Db): Promise<boolean> {
  return (await getSetting(db, SETUP_COMPLETED_KEY)) === "true";
}

/** True while first-run setup is still pending (drives the setup gate). */
export async function setupNeeded(db: Db): Promise<boolean> {
  if (await isSetupCompleted(db)) return false;
  return !(await anyAdminPasswordSet(db));
}

/** Mark first-run setup finished (idempotent). */
export async function markSetupComplete(db: Db): Promise<void> {
  await setSetting(db, SETUP_COMPLETED_KEY, "true");
}
