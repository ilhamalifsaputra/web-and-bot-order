/**
 * Render notification_outbox EMAIL-channel payloads into plain-text mail for
 * the shop owner. Sibling to templates.ts's `render()`, but plain text (no
 * HTML, no `escape()`) since this feeds nodemailer's `text` field, and it
 * only ever handles the four OWNER_EMAIL_* events (Task 3's
 * enqueueOwner*Email helpers) — everything else returns `null`, which the
 * dispatcher (Task 7) treats as "no template", same as templates.ts's `""`
 * sentinel for an unrendered Telegram event.
 *
 * SUBJECT-LINE CONSTRAINT — read before touching this file: `sendMail`
 * (packages/core/src/mailer.ts:29-40) logs the subject on every send. The
 * order code is half the guest `/track` credential, so it — and every other
 * payload-derived value — must never appear in a subject. Every subject
 * below is a fixed string literal with zero interpolation. Order code,
 * ticket id, amounts, and message text all live in the body only.
 */
import { NotificationEvent } from "@app/core/enums";

interface Item {
  name?: unknown;
  qty?: unknown;
}

/** Format an item list as one "name x qty" line per item, name defaulting to
 * "?" and qty to 1 for a malformed entry — same defensiveness level
 * templates.ts's `fmtItems` uses for the Telegram side. */
function fmtItemLines(items: Item[]): string {
  return items
    .map((it) => {
      const name = String(it.name ?? "?");
      const qty = Number.parseInt(String(it.qty ?? 1), 10) || 1;
      return `  - ${name} x${qty}`;
    })
    .join("\n");
}

interface OrderPaidPayload {
  order_code?: unknown;
  total?: unknown;
  currency?: unknown;
  item_count?: unknown;
}

interface ManualQueuedPayload {
  order_code?: unknown;
  items?: Item[];
  total?: unknown;
  currency?: unknown;
}

interface NewTicketPayload {
  ticket_id?: unknown;
  category?: unknown;
  message?: unknown;
}

interface TicketReplyPayload {
  ticket_id?: unknown;
  message?: unknown;
}

/** Render an EMAIL-channel outbox row into a subject + plain-text body, or
 * `null` for anything that isn't one of the four OWNER_EMAIL_* events. */
export function renderEmail(
  event: string,
  payload: OrderPaidPayload & ManualQueuedPayload & NewTicketPayload & TicketReplyPayload,
): { subject: string; text: string } | null {
  if (event === NotificationEvent.OWNER_EMAIL_ORDER_PAID) {
    const code = String(payload.order_code ?? "unknown");
    const itemCount = Number.parseInt(String(payload.item_count ?? "0"), 10) || 0;
    const total = String(payload.total ?? "0");
    const currency = String(payload.currency ?? "");
    return {
      subject: "New paid order",
      text:
        `Order ${code} was paid.\n\n` +
        `${itemCount} item(s), total ${total} ${currency}.\n\n` +
        `Check the Orders page in the admin panel for details.`,
    };
  }
  if (event === NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED) {
    const code = String(payload.order_code ?? "unknown");
    const itemsText = fmtItemLines(payload.items ?? []);
    const total = String(payload.total ?? "0");
    const currency = String(payload.currency ?? "");
    return {
      subject: "Order queued for manual fulfilment",
      text:
        `Order ${code} was paid and needs manual fulfilment.\n\n` +
        `${itemsText}\n\n` +
        `Total: ${total} ${currency}\n\n` +
        `This order needs to be fulfilled by hand. Check the Orders page in the admin panel for details.`,
    };
  }
  if (event === NotificationEvent.OWNER_EMAIL_NEW_TICKET) {
    const ticketId = String(payload.ticket_id ?? "unknown");
    const category = payload.category;
    const categoryLine = typeof category === "string" && category ? `Category: ${category}\n` : "";
    const message = String(payload.message ?? "");
    return {
      subject: "New support ticket",
      text:
        `A new support ticket was opened (#${ticketId}).\n\n` +
        categoryLine +
        `${message}\n\n` +
        `Check the Support page in the admin panel to reply.`,
    };
  }
  if (event === NotificationEvent.OWNER_EMAIL_TICKET_REPLY) {
    const ticketId = String(payload.ticket_id ?? "unknown");
    const message = String(payload.message ?? "");
    return {
      subject: "New reply on a support ticket",
      text:
        `A customer replied to support ticket #${ticketId}.\n\n` +
        `${message}\n\n` +
        `Check the Support page in the admin panel to reply.`,
    };
  }
  return null;
}
