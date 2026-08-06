/**
 * Owner email recipient/toggle resolution for the owner-notifications feature
 * (paid order, manual queue, new ticket, ticket reply). Resolved from
 * web-admin Settings — no env fallback, unlike SMTP: an owner email address
 * has no bootstrap/recovery equivalent, it's DB-only. Same pattern as
 * getSmtpCreds (./smtp.ts): an edit takes effect on the next enqueue,
 * bounded by getSetting's 30s cache.
 */
import type { Db } from "./_types";
import { getSetting } from "./settings";

export const OWNER_EMAIL_KEY = "owner_email";
export const OWNER_EMAIL_ENABLED_KEY = "owner_email_enabled";
export const OWNER_EMAIL_ON_PAID_ORDER_KEY = "owner_email_on_paid_order";
export const OWNER_EMAIL_ON_MANUAL_QUEUE_KEY = "owner_email_on_manual_queue";
export const OWNER_EMAIL_ON_NEW_TICKET_KEY = "owner_email_on_new_ticket";
export const OWNER_EMAIL_ON_TICKET_REPLY_KEY = "owner_email_on_ticket_reply";

export type OwnerEmailEvent = "paid_order" | "manual_queue" | "new_ticket" | "ticket_reply";

const EVENT_TOGGLE_KEY: Record<OwnerEmailEvent, string> = {
  paid_order: OWNER_EMAIL_ON_PAID_ORDER_KEY,
  manual_queue: OWNER_EMAIL_ON_MANUAL_QUEUE_KEY,
  new_ticket: OWNER_EMAIL_ON_NEW_TICKET_KEY,
  ticket_reply: OWNER_EMAIL_ON_TICKET_REPLY_KEY,
};

// Plain recipient address only — unlike SMTP_FROM_RE (settings.ts), owner_email
// never accepts the "Display Name <email>" form. Exported so the web-admin
// settings route (apps/web-admin/src/routes/api/settings.ts) validates a save
// with the exact same pattern this resolver gates on — the two can never drift.
export const OWNER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "true" (case-insensitive) is on; anything else, including missing/blank, is off. */
function isOn(raw: string | null): boolean {
  return (raw ?? "").trim().toLowerCase() === "true";
}

/**
 * Resolve the owner's notification email address for one event. Null when
 * unconfigured — the master toggle, the event's own toggle, the address, or
 * its shape — so the feature stays inert until an admin explicitly opts in,
 * exactly as getSmtpCreds returning null leaves the forgot-password mail off
 * today.
 */
export async function resolveOwnerEmailRecipient(db: Db, event: OwnerEmailEvent): Promise<string | null> {
  const [masterToggle, eventToggle, addressSetting] = await Promise.all([
    getSetting(db, OWNER_EMAIL_ENABLED_KEY),
    getSetting(db, EVENT_TOGGLE_KEY[event]),
    getSetting(db, OWNER_EMAIL_KEY),
  ]);

  if (!isOn(masterToggle)) return null;
  if (!isOn(eventToggle)) return null;

  const address = (addressSetting ?? "").trim();
  if (!address) return null;
  if (!OWNER_EMAIL_RE.test(address)) return null;

  return address;
}
