/**
 * Owner email recipient resolution for the owner-notifications feature
 * (paid order, manual queue, new ticket, ticket reply, wallet top-up).
 * Whether an event is on is decided by `isEmailEventEnabled` (./emailPolicy),
 * the same policy the dispatcher rechecks at send time; the address comes from
 * the `owner_email` web-admin Setting — no env fallback, unlike SMTP: an owner
 * email address has no bootstrap/recovery equivalent, it's DB-only. The
 * address read is bounded by getSetting's 30s cache.
 */
import type { Db } from "./_types";
import { getSetting } from "./settings";
import { isEmailEventEnabled } from "./emailPolicy";

export const OWNER_EMAIL_KEY = "owner_email";
export const OWNER_EMAIL_ENABLED_KEY = "owner_email_enabled";
export const OWNER_EMAIL_ON_PAID_ORDER_KEY = "owner_email_on_paid_order";
export const OWNER_EMAIL_ON_MANUAL_QUEUE_KEY = "owner_email_on_manual_queue";
export const OWNER_EMAIL_ON_NEW_TICKET_KEY = "owner_email_on_new_ticket";
export const OWNER_EMAIL_ON_TICKET_REPLY_KEY = "owner_email_on_ticket_reply";
export const OWNER_EMAIL_ON_WALLET_TOPUP_KEY = "owner_email_on_wallet_topup";

export type OwnerEmailEvent = "paid_order" | "manual_queue" | "new_ticket" | "ticket_reply" | "wallet_topup";

/** The email-policy event key each owner event is dispatched under; the
 * dispatcher decides with `isEmailEventEnabled(canonicalEmailEventFor(event))`,
 * so the enqueue gate asks the same question about the same key. */
const EVENT_POLICY_KEY: Record<OwnerEmailEvent, string> = {
  paid_order: "legacy.owner_order_paid",
  manual_queue: "legacy.owner_manual_queue",
  new_ticket: "support.ticket.created.admin",
  ticket_reply: "legacy.owner_ticket_reply",
  wallet_topup: "legacy.owner_wallet_topup",
};

// Plain recipient address only — unlike SMTP_FROM_RE (settings.ts), owner_email
// never accepts the "Display Name <email>" form. Exported so the web-admin
// settings route (apps/web-admin/src/routes/api/settings.ts) validates a save
// with the exact same pattern this resolver gates on — the two can never drift.
export const OWNER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resolve the owner's notification email address for one event. Null when
 * unconfigured — the master toggle, the event's own toggle, the address, or
 * its shape — so the feature stays inert until an admin explicitly opts in,
 * exactly as getSmtpCreds returning null leaves the forgot-password mail off
 * today.
 */
export async function resolveOwnerEmailRecipient(db: Db, event: OwnerEmailEvent): Promise<string | null> {
  // One policy decision source: the same `isEmailEventEnabled` the dispatcher
  // rechecks at send time (an explicit `email_event_enabled:<key>` wins,
  // otherwise the legacy master + per-event toggles decide, so the defaults
  // are unchanged). Enqueue and dispatch can no longer disagree.
  if (!(await isEmailEventEnabled(db, EVENT_POLICY_KEY[event]))) return null;

  const address = ((await getSetting(db, OWNER_EMAIL_KEY)) ?? "").trim();
  if (!address) return null;
  if (!OWNER_EMAIL_RE.test(address)) return null;

  return address;
}
