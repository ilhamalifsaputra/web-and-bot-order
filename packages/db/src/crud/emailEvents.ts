import { createHash } from "node:crypto";
import { EMAIL_EVENT_REGISTRY, type EmailEventKey } from "@app/core/email";
import { config } from "@app/core/config";
import { encryptCredentials } from "@app/core/credentialCrypto";
import { NotificationStatus, OrderStatus } from "@app/core/enums";
import type { Db } from "./_types";
import { isEmailEventEnabled } from "./emailPolicy";

export const validNotificationEmail = (value: unknown): value is string =>
  typeof value === "string" && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
export const emailRecipientFor = (user: { isGuest?: boolean; guestEmail?: string | null; email?: string | null }): string | null => {
  const value = user.isGuest ? user.guestEmail : user.email;
  return validNotificationEmail(value) ? value.trim().toLowerCase() : null;
};
export async function emailTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return "$transaction" in db ? db.$transaction((tx) => fn(tx)) : fn(db);
}

/** Caller passes the authoritative domain transaction. Unique key survives retries and restarts. */
export async function enqueueEmailEvent(db: Db, args: {
  key: EmailEventKey; aggregateId: string | number; occurrence?: string | number;
  userId?: number; to?: string | null; orderId?: number; payload?: Record<string, unknown>;
}): Promise<boolean> {
  const definition = EMAIL_EVENT_REGISTRY.find((row) => row.key === args.key)!;
  const safePayload = { ...args.payload };
  if (args.key === "account.password_reset.requested" && typeof safePayload.reset_url === "string") {
    safePayload.reset_url_encrypted = encryptCredentials(safePayload.reset_url, "notification.password-reset:v1");
    delete safePayload.reset_url;
  }
  let to = args.to;
  if (to === undefined) {
    if (definition.audience === "admin") to = (await db.setting.findUnique({ where: { key: "owner_email" } }))?.value ?? null;
    else if (args.userId) {
      const user = await db.user.findUnique({ where: { id: args.userId }, select: { email: true, guestEmail: true, isGuest: true } });
      to = user ? emailRecipientFor(user) : null;
    }
  }
  to = validNotificationEmail(to) ? to.trim().toLowerCase() : null;
  const allowed = await isEmailEventEnabled(db, args.key);
  const skip = !allowed ? "SKIPPED_DISABLED" : !to ? "SKIPPED_NO_RECIPIENT" : null;
  const recipientKey = createHash("sha256").update(to ?? "none").digest("hex").slice(0, 24);
  const factKey = `email:${args.key}:${args.aggregateId}:${args.occurrence ?? "first"}:${recipientKey}`;
  // A skipped row is only a record that this fact was not emailed. It lives in
  // its own `:skipped` slot so it can never block a real send of the same fact
  // after the owner re-enables the event or a recipient appears, while repeated
  // enqueues of the same skipped fact still collapse into one SKIPPED row.
  const dedupeKey = skip ? `${factKey}:skipped` : factKey;
  const result = await db.notificationOutbox.createMany({ skipDuplicates: true, data: [{
    event: args.key, channel: "EMAIL", orderId: args.orderId ?? null, dedupeKey,
    status: skip ? NotificationStatus.SKIPPED : NotificationStatus.PENDING, lastError: skip,
    payloadJson: JSON.stringify({ ...safePayload, to, event_key: args.key, occurred_at: new Date().toISOString(), ...(skip ? { outcome: skip } : {}) }),
  }] });
  return result.count === 1;
}

export async function enqueueOrderEmailFact(db: Db, orderId: number, keys: EmailEventKey[], occurrence: string = "first") {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { user: true } });
  if (!order) return;
  for (const key of keys) await enqueueEmailEvent(db, {
    key, orderId, userId: order.userId, aggregateId: orderId, occurrence,
    ...(key.endsWith("customer") ? { to: emailRecipientFor(order.user) } : {}),
    payload: { order_code: order.orderCode, status: order.status, payment_method: order.paymentMethod,
      order_url: key.endsWith("admin")
        ? (config.ADMIN_PUBLIC_URL ? `${config.ADMIN_PUBLIC_URL.replace(/\/+$/, "")}/orders/${orderId}` : null)
        : (config.SHOP_PUBLIC_URL ? `${config.SHOP_PUBLIC_URL.replace(/\/+$/, "")}/account/orders` : null),
    },
  });
}

/** Only terminal fulfillment failures, measured underpayments, and actual expiry are facts here. */
export async function enqueueOrderTransitionEmails(db: Db, orderId: number, to: string, meta?: string | null, from?: string) {
  if (to === OrderStatus.FAILED || to === OrderStatus.REJECTED)
    await enqueueOrderEmailFact(db, orderId, ["order.failed.customer", "order.failed.admin"]);
  if (to === OrderStatus.UNDERPAID)
    await enqueueOrderEmailFact(db, orderId, ["payment.underpaid.customer", "payment.underpaid.admin"]);
  if (to === OrderStatus.CANCELLED && meta === "expired" && from === OrderStatus.PENDING_PAYMENT) {
    const invoice = await db.order.findUnique({ where: { id: orderId }, select: { expiresAt: true, paidAt: true, paymentState: true, walletCreditState: true } });
    if (invoice?.expiresAt && invoice.expiresAt <= new Date() && !invoice.paidAt &&
      (!invoice.paymentState || invoice.paymentState === "WAITING_PAYMENT") && invoice.walletCreditState !== "NEEDS_REVIEW")
      await enqueueOrderEmailFact(db, orderId, ["payment.expired.customer"]);
  }
}
