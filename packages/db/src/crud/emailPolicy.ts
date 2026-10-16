import { EMAIL_EVENT_REGISTRY, canonicalEmailEventFor, type EmailEventKey } from "@app/core/email";
import type { Db } from "./_types";
import { setSetting } from "./settings";

export { canonicalEmailEventFor };
export const emailPolicyKey = (key: string) => `email_event_enabled:${key}`;
const legacyFlags: Record<string, string> = {
  "legacy.owner_order_paid": "owner_email_on_paid_order",
  "legacy.owner_manual_queue": "owner_email_on_manual_queue",
  "legacy.owner_ticket_reply": "owner_email_on_ticket_reply",
  "legacy.owner_wallet_topup": "owner_email_on_wallet_topup",
  "support.ticket.created.admin": "owner_email_on_new_ticket",
};
// Case/whitespace-insensitive, as the legacy owner-email toggles always were,
// so a legacy "TRUE" keeps meaning on now that enqueue and dispatch share this.
const enabled = (value?: string | null) => { const v = (value ?? "").trim().toLowerCase(); return v === "true" || v === "1"; };
/** Read fresh: turning a switch OFF must affect rows already waiting in the outbox. */
export async function isEmailEventEnabled(db: Db, event: string): Promise<boolean> {
  const key = canonicalEmailEventFor(event);
  const definition = EMAIL_EVENT_REGISTRY.find((row) => row.key === key);
  if (definition?.mandatory) return true;
  const explicit = await db.setting.findUnique({ where: { key: emailPolicyKey(key) } });
  if (explicit) return enabled(explicit.value);
  const legacy = legacyFlags[key];
  if (legacy) {
    const rows = await db.setting.findMany({ where: { key: { in: ["owner_email_enabled", legacy] } } });
    return enabled(rows.find((r) => r.key === "owner_email_enabled")?.value) && enabled(rows.find((r) => r.key === legacy)?.value);
  }
  return definition?.defaultEnabled ?? true;
}
export async function setEmailEventEnabled(db: Db, key: EmailEventKey, value: boolean): Promise<void> {
  const row = EMAIL_EVENT_REGISTRY.find((event) => event.key === key);
  if (!row || typeof value !== "boolean" || (row.mandatory && !value)) throw new Error("Invalid email policy.");
  if ("$transaction" in db) return db.$transaction((tx) => setEmailEventEnabled(tx, key, value));
  // Serialize competing saves before deciding whether this is a new activation.
  const policyKey = emailPolicyKey(key);
  await db.setting.createMany({ data: { key: policyKey, value: String(await isEmailEventEnabled(db, key)) }, skipDuplicates: true });
  await db.$queryRaw`SELECT key FROM settings WHERE key = ${policyKey} FOR UPDATE`;
  const wasEnabled = await isEmailEventEnabled(db, key);
  await setSetting(db, emailPolicyKey(key), String(value));
  if (value && !wasEnabled && row.category === "Reports") await setSetting(db, `email_report_enabled_at:${key}`, new Date().toISOString());
}
