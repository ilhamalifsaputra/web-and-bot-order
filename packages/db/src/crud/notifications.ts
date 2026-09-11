/**
 * Notification outbox CRUD — port of the four functions in Python crud.py
 * (enqueue_notification / fetch_pending_notifications / mark_notification_sent
 * / mark_notification_failed). Same semantics; see migrate.md §5.5.
 *
 * Every function takes a Prisma client or transaction client as its first
 * argument (mirrors the SQLAlchemy `session` parameter). enqueue() does NOT
 * commit on its own — pass the same `tx` used by the triggering business
 * transaction so the outbox row lands atomically with the state change.
 */
import type { PrismaClient, Tx } from "../client";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import { PaymentLogEvent } from "@app/core/payments/logEvents";
import {
  NotificationEvent,
  NotificationStatus,
  NotificationChannel,
  BroadcastStatus,
  langCode,
} from "@app/core/enums";
import type { Decimal } from "@app/core/money";
import { resolveAdminIds } from "./admins";
import { resolveOwnerEmailRecipient, type OwnerEmailEvent } from "./ownerEmail";

type Db = PrismaClient | Tx;

/**
 * Insert one outbox row. Caller's transaction owns the commit.
 *
 * `dedupeKey` is optional and defaults to null. When given, it is written to
 * the UNIQUE `notification_outbox.dedupe_key` column via a raw
 * `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`: a collision
 * with an existing key resolves as a no-op (the row already exists, the
 * notification is already queued or sent, and re-enqueueing is a no-op
 * rather than an error) instead of a thrown UNIQUE violation — the database,
 * not the placement of the call, is what makes the enqueue happen at most
 * once. `RETURNING id` gives a precise "did THIS call insert a row" signal
 * (empty result = collision), which a payload-equality check on `upsert`
 * couldn't: the two real dedupeKey call sites retry with a byte-identical
 * payload on collision, so comparing payloads can't tell a genuine insert
 * apart from a same-payload collision.
 *
 * Two events set a key today:
 *  - `WALLET_TOPUP_CREDITED_DM`, as `topup-credited:<orderId>` — genuinely one
 *    DM per top-up order; see `enqueueWalletTopupCreditedDm`.
 *  - `ADMIN_UNCONFIRMABLE_PAYMENT`, as
 *    `unconfirmable-payment:<orderId>:<adminId>` — one per admin per order,
 *    NOT one per order, because that event fans out a row per admin; see
 *    `enqueueAdminUnconfirmablePayment`.
 *
 * Every other event leaves it null, and NULLs are distinct in a SQLite UNIQUE
 * index, so those rows may repeat freely. `ORDER_DELIVERED_DM` in particular
 * must NOT get a key even though it looks once-per-order: an admin can
 * legitimately re-send a buyer's credentials (`POST /api/orders/:orderId/resend`
 * and the bulk `resend` action in apps/web-admin/src/routes/api/orders.ts),
 * and that re-send goes through this same helper — a key there would silently
 * swallow the second send instead of delivering it. The per-admin fan-out
 * events and the per-recipient broadcasts deliberately write many rows too.
 *
 * Note the swallow is per row, not per call: a caller that loops over admins
 * gets exactly the rows whose keys were new.
 */
export async function enqueueNotification(
  db: Db,
  event: NotificationEvent,
  orderId: number,
  payload: Record<string, unknown>,
  dedupeKey?: string,
): Promise<void> {
  const payloadJson = JSON.stringify(payload);
  if (dedupeKey !== undefined) {
    // Raw INSERT ... ON CONFLICT DO NOTHING on the UNIQUE dedupeKey: a
    // collision resolves as a no-op (keeping the first row's payload)
    // instead of a thrown UNIQUE violation, so it can never abort an open
    // caller transaction on Postgres. RETURNING id gives a precise signal
    // for whether THIS call inserted a row — unlike a payload comparison,
    // it isn't fooled by a same-payload retry (the realistic case for both
    // call sites that pass a key).
    const inserted = await db.$queryRaw<{ id: number }[]>`
      INSERT INTO notification_outbox (event, order_id, payload_json, dedupe_key)
      VALUES (${event}, ${orderId}, ${payloadJson}, ${dedupeKey})
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) {
      // Collision: no row was written by this call — an earlier call
      // already owns this dedupe key. Deliberately silent, and no
      // NOTIFICATION_CREATED log below — claiming one was created here
      // would be a lie even when the colliding payload happens to match.
      return;
    }
  } else {
    await db.notificationOutbox.create({
      data: { event, orderId, payloadJson, dedupeKey: null },
    });
  }
  // The one line that says a notification now exists for this order. Logged
  // here rather than at each of the dozen enqueue* wrappers because this is
  // the single row-writing chokepoint they all funnel through, so it cannot
  // drift out of sync with them. `provider` is absent by design — see
  // PaymentLogFields (@app/core/payments/logEvents) for why the outbox does
  // not know which rail it is serving. Low volume: this is once per queued
  // notification, not per dispatcher tick — the broadcast fan-outs write their
  // thousands of rows through their own helpers, not through here.
  logger.info(
    { event: PaymentLogEvent.NOTIFICATION_CREATED, orderId, notificationEvent: event },
    `Queued a ${event} notification for order ${orderId} — it will be delivered on the outbox dispatcher's next tick`,
  );
}

/**
 * Enqueue a one-time web-admin password-reset code as an admin DM (orderId is
 * null — this is not tied to an order). The dispatcher routes ADMIN_PW_RESET
 * rows to `payload.chat_id` instead of the public channel. The web NEVER sends
 * Telegram itself; this just drops the row for the notifier/bot to deliver.
 */
export async function enqueueAdminPasswordReset(
  db: Db,
  args: { telegramId: number; code: string; ttlMinutes: number },
): Promise<void> {
  await db.notificationOutbox.create({
    data: {
      event: NotificationEvent.ADMIN_PW_RESET,
      orderId: null,
      payloadJson: JSON.stringify({
        chat_id: args.telegramId,
        code: args.code,
        ttl_minutes: args.ttlMinutes,
      }),
    },
  });
}

/**
 * Enqueue one admin DM per resolved admin (env ADMIN_IDS ∪ the DB `admin_ids`
 * Setting — same allow-list the bot/web panel resolve at runtime via
 * `resolveAdminIds`/`adminIds()`) alerting that a payment path delivered an
 * order whose paid amount exceeded the total. All six rails call this now, not
 * only the three gateway webhooks: the QRIS/IDR + NOWPayments webhooks
 * (`deliverPaid{Tokopay,Paydisini,Nowpayments}Order`) and the three
 * amount-matched deposit pollers (`deliverPaidInternalOrder`,
 * `deliverPaidBybitOrder`, `deliverPaidBybitBscOrder`). Previously looped
 * over `config.ADMIN_IDS` alone, so a shop managed entirely through the
 * DB/setup-wizard (no env ADMIN_IDS) never got these alerts (Infra-4 fix,
 * security audit 2026-06-23). orderId is set (unlike ADMIN_PW_RESET) so the
 * rows are visible from the order in the admin /outbox panel. No-op if no
 * admin is resolved. Numbers are carried as Decimal `.toString()` — never
 * `number` — per money rules.
 */
export async function enqueueAdminOverpaid(
  db: Db,
  args: {
    orderId: number;
    orderCode: string;
    paid: Decimal;
    expected: Decimal;
    excess: Decimal;
    currency: string;
  },
): Promise<void> {
  for (const adminId of await resolveAdminIds(db)) {
    await db.notificationOutbox.create({
      data: {
        event: NotificationEvent.ADMIN_OVERPAID,
        orderId: args.orderId,
        payloadJson: JSON.stringify({
          chat_id: adminId,
          order_code: args.orderCode,
          paid: args.paid.toString(),
          expected: args.expected.toString(),
          excess: args.excess.toString(),
          currency: args.currency,
        }),
      },
    });
  }
}

/**
 * Enqueue one admin DM per resolved admin alerting that a Bybit BSC order's
 * automated tracking needs manual attention post-detection. Two triggers:
 * (1) the tracker's lookup-failure grace period exhausted — non-terminal
 * since M-11 (backend audit 2026-07-31): the order stays in
 * PAYMENT_DETECTED/CONFIRMING (`recordBybitBscTrackingStale`) so a later
 * genuine Bybit "Success" report can still auto-deliver it, this alert is
 * just "an admin should sanity-check this one" — or (2) a delivery throw
 * after Bybit reported the deposit Success, which DOES escalate the order to
 * FAILED. Same fan-out-per-admin shape as `enqueueAdminOverpaid`. `reason` is
 * a short diagnostic string — never a secret/credential, but still not the
 * kind of detail a buyer should see, hence an admin DM rather than anything
 * customer-facing.
 */
export async function enqueueOrderPipelineFailed(
  db: Db,
  args: { orderId: number; orderCode: string; reason: string },
): Promise<void> {
  for (const adminId of await resolveAdminIds(db)) {
    await db.notificationOutbox.create({
      data: {
        event: NotificationEvent.ORDER_PIPELINE_FAILED,
        orderId: args.orderId,
        payloadJson: JSON.stringify({
          chat_id: adminId,
          order_code: args.orderCode,
          reason: args.reason.slice(0, 300),
        }),
      },
    });
  }
}

/**
 * Enqueue one admin DM per resolved admin alerting that a paid order routed
 * to the hand-fulfilment queue (settlePaidOrder's MANUAL branch — a
 * MANUAL/MANUAL_WITH_INFO SKU) and is waiting on an admin to fulfil it by
 * hand. Same fan-out-per-admin shape as `enqueueOrderPipelineFailed`. Numbers
 * are carried as Decimal `.toString()` — never `number` — per money rules.
 * No-op if no admin is resolved.
 */
export async function enqueueManualOrderAdminAlert(
  db: Db,
  args: {
    orderId: number;
    orderCode: string;
    items: { name: string; qty: number }[];
    total: Decimal;
    currency: string;
  },
): Promise<void> {
  for (const adminId of await resolveAdminIds(db)) {
    await db.notificationOutbox.create({
      data: {
        event: NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED,
        orderId: args.orderId,
        payloadJson: JSON.stringify({
          chat_id: adminId,
          order_code: args.orderCode,
          items: args.items,
          total: args.total.toString(),
          currency: args.currency,
        }),
      },
    });
  }
}

/**
 * Enqueue one admin DM per resolved admin alerting that a payment-gateway
 * webhook (TokoPay/PayDisini/NOWPayments) confirmed payment for an order that
 * had already left PENDING_PAYMENT by the time the delivery transaction ran
 * (M-10 fix, backend audit 2026-07-31) — routine, since
 * `autoCancelExpiredOrders` cancels orders on a timer and can race a slow
 * webhook. Nothing else recovers this automatically: the reconcile pollers
 * only act on orders still PENDING_PAYMENT, and `reconcileFinances` doesn't
 * scan ledger rows, so this needs a human to check whether the buyer actually
 * paid and reconcile manually. Same fan-out-per-admin shape as
 * `enqueueAdminOverpaid`. No-op if no admin is resolved.
 */
export async function enqueueAdminStalePayment(
  db: Db,
  args: { orderId: number; orderCode: string; gateway: string; trxId: string },
): Promise<void> {
  for (const adminId of await resolveAdminIds(db)) {
    await db.notificationOutbox.create({
      data: {
        event: NotificationEvent.ADMIN_STALE_PAYMENT,
        orderId: args.orderId,
        payloadJson: JSON.stringify({
          chat_id: adminId,
          order_code: args.orderCode,
          gateway: args.gateway,
          trx_id: args.trxId.slice(0, 300),
        }),
      },
    });
  }
}

/**
 * Enqueue one admin DM per resolved admin alerting that the hourly Digiflazz
 * catalog resync (`resyncDigiflazzCatalog`) tripped its own blast-radius
 * circuit breaker and wrote nothing (Task 10, backend audit 2026-08-21 C-1,
 * second half). Two distinct trip reasons, mirroring `resyncDigiflazzCatalog`'s
 * own local `AbortReason` union — kept as an equivalent inline union here
 * rather than importing it, matching this file's existing plain-object-args
 * style for `enqueueAdmin*` functions:
 *   - `"sharp_change"`: more than 20% of the denominations it would have
 *     repriced (out of at least 5 considered) moved by more than 50% in one
 *     direction.
 *   - `"no_usable_rows"`: the supplier's price-list fetch returned no usable
 *     rows at all, even though this shop has Digiflazz-routed denominations
 *     to check against it — the most total form of the same "malformed
 *     response" scenario.
 * Both usually mean the supplier's price-list response is malformed (a field
 * rename, a partial outage, the wrong endpoint) rather than a genuine
 * market-wide price swing or a legitimately empty catalog. Nothing else
 * surfaces this — the next hourly tick would otherwise silently retry the
 * same malformed data, over and over, with only a routine-looking audit
 * entry to notice by. Not order-scoped (`orderId: null`) — this is a
 * catalog-wide event, not tied to any single order. Same fan-out-per-admin
 * shape as `enqueueAdminStalePayment`. No-op if no admin is resolved.
 */
export async function enqueueAdminDigiflazzResyncAborted(
  db: Db,
  args: { kind: "sharp_change"; sharpChanges: number; consideredRows: number } | { kind: "no_usable_rows" },
): Promise<void> {
  for (const adminId of await resolveAdminIds(db)) {
    await db.notificationOutbox.create({
      data: {
        event: NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED,
        orderId: null,
        payloadJson: JSON.stringify({
          chat_id: adminId,
          kind: args.kind,
          // sharp_changes/considered_rows are only meaningful for the
          // sharp_change kind — omitted (not 0) for no_usable_rows so the
          // template can tell "not applicable" apart from "zero of zero".
          ...(args.kind === "sharp_change"
            ? { sharp_changes: args.sharpChanges, considered_rows: args.consideredRows }
            : {}),
        }),
      },
    });
  }
}

/**
 * Tell every admin that an order's payment may have succeeded at the gateway
 * while nothing in the system can confirm it — so a human can settle it before
 * the payment window closes and the order auto-cancels with the buyer's money
 * paid (Task E5 item 4).
 *
 * One caller today: the NOWPayments reconcile poller, on the branch where the
 * gateway reports an order `finished` but returns no `payment_id`. That id is
 * the rail's idempotency-ledger key, so Task E4 made the poller refuse to
 * deliver rather than invent one the IPN webhook could never collide with.
 * That refusal is correct and stays — this alert exists because its cost is
 * otherwise silent.
 *
 * Deduped per (order, admin), not per order. The admin events fan out one row
 * per admin (see ADMIN_DM_EVENTS, packages/outbox-dispatcher/src/dispatcher.ts),
 * so an order-only key would let the first admin's row swallow every other
 * admin's — they would never be told at all. Deduping matters here more than
 * for most events because the poller re-enters this branch on EVERY cycle
 * until the order expires: without a key, each admin would be DMed once a
 * cycle for the whole payment window. With it, each admin is told exactly
 * once per order, however many cycles run.
 */
export async function enqueueAdminUnconfirmablePayment(
  db: Db,
  args: { orderId: number; orderCode: string; gateway: string },
): Promise<void> {
  for (const adminId of await resolveAdminIds(db)) {
    await enqueueNotification(
      db,
      NotificationEvent.ADMIN_UNCONFIRMABLE_PAYMENT,
      args.orderId,
      { chat_id: adminId, order_code: args.orderCode, gateway: args.gateway },
      `unconfirmable-payment:${args.orderId}:${adminId}`,
    );
  }
}

// ---- Support ticket DMs (Task 2, Phase C) ----------------------------------
// The three sites below used to call ctx.api.sendMessage() directly from
// apps/order-bot — a deliberate-looking exception to the rule every other
// buyer/admin DM in this codebase already follows. These route them through
// the outbox like everything else, so a bot crash or a Telegram flood-control
// hiccup no longer silently drops a ticket notification with only a caught
// `logger.error` to show for it (retried by the dispatcher instead).

/**
 * Enqueue the "new support ticket" forward to the support group (or, with no
 * group configured, every resolved admin) — one outbox row per target,
 * mirroring `enqueueAdminOverpaid`/`enqueueManualOrderAdminAlert`'s
 * fan-out-per-admin shape, except the fan-out set is `config.SUPPORT_GROUP_ID`
 * when set (a single-element target list) rather than always
 * `resolveAdminIds`. Same target-resolution fallback the pre-outbox direct
 * send used (`conversations/support.ts`). Not routed through
 * `enqueueNotification` — like `enqueueAdminDigiflazzResyncAborted`, this is
 * not order-scoped (`orderId: null`), and `enqueueNotification`'s `orderId`
 * parameter is non-nullable.
 *
 * `photoFileIds` carries Telegram file ids only (never binary) — the
 * dispatcher re-sends them via `sendMediaGroup` right after the text, same
 * "file id, not the file itself" rule every credential-safe payload in this
 * file follows.
 */
export async function enqueueAdminNewTicketDm(
  db: Db,
  args: {
    ticketId: number;
    fromUserId: number;
    fromUsername: string | null;
    message: string;
    photoFileIds: string[];
  },
): Promise<void> {
  const targets: number[] = config.SUPPORT_GROUP_ID ? [config.SUPPORT_GROUP_ID] : await resolveAdminIds(db);
  for (const chatId of targets) {
    if (!chatId) continue;
    await db.notificationOutbox.create({
      data: {
        event: NotificationEvent.ADMIN_NEW_TICKET,
        orderId: null,
        payloadJson: JSON.stringify({
          chat_id: chatId,
          ticket_id: args.ticketId,
          from_user_id: args.fromUserId,
          from_username: args.fromUsername,
          message: args.message,
          photo_file_ids: args.photoFileIds,
        }),
      },
    });
  }
}

/**
 * Enqueue the buyer's "admin replied to your ticket" DM
 * (`conversations/admin.ts`'s `ticketReplyConversation`). Always rendered in
 * English by the dispatcher — see `NotificationEvent.TICKET_REPLY_DM`'s own
 * doc comment for why (preserves the pre-outbox direct send's behavior
 * byte-for-byte). Not order-scoped (`orderId: null`) — tickets have no order.
 */
export async function enqueueTicketReplyDm(
  db: Db,
  args: { ticketId: number; chatId: number; message: string },
): Promise<void> {
  await db.notificationOutbox.create({
    data: {
      event: NotificationEvent.TICKET_REPLY_DM,
      orderId: null,
      payloadJson: JSON.stringify({
        chat_id: args.chatId,
        ticket_id: args.ticketId,
        message: args.message,
      }),
    },
  });
}

/**
 * Enqueue the buyer's "your ticket was closed" DM (`handlers/admin.ts`'s
 * `closeTicketAdmin`). Rendered in the buyer's own stored language
 * (`buyerLanguage`, normalized via `langCode` the same way
 * `enqueueOrderDeliveredDm`/`enqueueOrderProcessingDm` normalize
 * `buyer_language`) — unlike `enqueueTicketReplyDm` above, which is always
 * English. Not order-scoped (`orderId: null`) — tickets have no order.
 */
export async function enqueueTicketClosedDm(
  db: Db,
  args: { ticketId: number; chatId: number; buyerLanguage: string | null },
): Promise<void> {
  await db.notificationOutbox.create({
    data: {
      event: NotificationEvent.TICKET_CLOSED_DM,
      orderId: null,
      payloadJson: JSON.stringify({
        chat_id: args.chatId,
        ticket_id: args.ticketId,
        buyer_language: langCode(args.buyerLanguage),
      }),
    },
  });
}

/**
 * Write one EMAIL-channel outbox row addressed to the shop owner, or nothing
 * at all. Resolves the recipient via `resolveOwnerEmailRecipient` — the
 * master toggle, the per-event toggle, and a valid `owner_email` address must
 * all be set, or this returns without writing a row (no PENDING row that then
 * never gets a `to`; the feature stays completely inert until configured,
 * same as `getSmtpCreds` returning null leaves the forgot-password mail off
 * today). Internal — the five `enqueueOwner*Email` wrappers below are the
 * public surface, each pinned to its own `NotificationEvent`/`OwnerEmailEvent`
 * pair so the dispatcher's email renderer and the Telegram `render()`
 * if-chain never have to handle each other's payload shape.
 */
async function enqueueOwnerEmail(
  db: Db,
  event: NotificationEvent,
  ownerEmailEvent: OwnerEmailEvent,
  orderId: number | null,
  payload: Record<string, unknown>,
): Promise<void> {
  const to = await resolveOwnerEmailRecipient(db, ownerEmailEvent);
  if (!to) return;
  await db.notificationOutbox.create({
    data: {
      event,
      orderId,
      channel: NotificationChannel.EMAIL,
      payloadJson: JSON.stringify({ to, ...payload }),
    },
  });
}

/**
 * Enqueue the shop owner's "a paid order landed" email (settlePaidOrder's
 * AUTO branch, beside `approveOrder`) — an auto-delivery SKU that just paid
 * and shipped with no admin action needed. No-op (see `enqueueOwnerEmail`)
 * unless the owner has the master toggle, `owner_email_on_paid_order`, and a
 * valid `owner_email` all configured.
 *
 * Carries the full order-summary detail the HTML "New Paid Order" template
 * (packages/core/src/email/templates/orderPaid.ts, rendered by
 * packages/outbox-dispatcher/src/emailTemplates.ts) needs to show a real
 * order summary instead of just a total — every optional field (`items`
 * money, `subtotal`, `discount`, `transactionId`, `voucherCode`, `orderUrl`)
 * is written into the payload as an explicit JSON `null` when the caller has
 * none, never omitted as a missing key and never the string `"null"` — the
 * renderer, not this enqueue layer, is what decides to omit the
 * corresponding email line for a null value. Every money `Decimal` field
 * (including each item's `unitPrice`) goes through `.toString()` — never a
 * raw `number` — per money rules; `paidAt` is written as an ISO string, the
 * same "caller formats, payload carries a plain value" pattern the rest of
 * this file's DM payloads use for timestamps.
 */
export async function enqueueOwnerOrderPaidEmail(
  db: Db,
  args: {
    orderId: number;
    orderCode: string;
    total: Decimal;
    currency: string;
    itemCount: number;
    customerLabel: string;
    items: { name: string; variant: string | null; quantity: number; unitPrice: Decimal }[];
    subtotal: Decimal;
    discount: Decimal;
    paymentMethod: string;
    transactionId: string | null;
    voucherCode: string | null;
    paidAt: Date;
    orderUrl: string | null;
  },
): Promise<void> {
  await enqueueOwnerEmail(db, NotificationEvent.OWNER_EMAIL_ORDER_PAID, "paid_order", args.orderId, {
    order_code: args.orderCode,
    total: args.total.toString(),
    currency: args.currency,
    item_count: args.itemCount,
    customer_label: args.customerLabel,
    items: args.items.map((item) => ({
      name: item.name,
      variant: item.variant,
      quantity: item.quantity,
      unitPrice: item.unitPrice.toString(),
    })),
    subtotal: args.subtotal.toString(),
    discount: args.discount.toString(),
    payment_method: args.paymentMethod,
    transaction_id: args.transactionId,
    voucher_code: args.voucherCode,
    paid_at: args.paidAt.toISOString(),
    order_url: args.orderUrl,
  });
}

/**
 * Enqueue the shop owner's "a paid order needs hand-fulfilment" email
 * (settlePaidOrder's MANUAL branch, beside `enqueueManualOrderAdminAlert`) —
 * same trigger, but a distinct event/payload from `ADMIN_MANUAL_ORDER_QUEUED`
 * so the email renderer never has to parse the Telegram alert's shape. No-op
 * unless the owner has the master toggle, `owner_email_on_manual_queue`, and
 * a valid `owner_email` all configured. `total` is carried as Decimal
 * `.toString()` — never `number` — per money rules.
 */
export async function enqueueOwnerManualQueueEmail(
  db: Db,
  args: { orderId: number; orderCode: string; items: { name: string; qty: number }[]; total: Decimal; currency: string },
): Promise<void> {
  await enqueueOwnerEmail(db, NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED, "manual_queue", args.orderId, {
    order_code: args.orderCode,
    items: args.items,
    total: args.total.toString(),
    currency: args.currency,
  });
}

/**
 * Enqueue the shop owner's "a new support ticket was opened" email —
 * enqueued from `createTicket` so both the storefront and the bot's ticket
 * creation paths are covered from one call site. Tickets have no order, so
 * `orderId` is always null (unlike the order-triggered owner emails above).
 * `message` is the ticket's opening body — customer-authored free text with
 * no length bound, going into the admin-visible outbox table, so it's
 * truncated to 500 chars (same length `markNotificationFailed` truncates
 * `lastError` to). No-op unless the owner has the master toggle,
 * `owner_email_on_new_ticket`, and a valid `owner_email` all configured.
 */
export async function enqueueOwnerNewTicketEmail(
  db: Db,
  args: { ticketId: number; userId: number; category?: string | null; message: string },
): Promise<void> {
  await enqueueOwnerEmail(db, NotificationEvent.OWNER_EMAIL_NEW_TICKET, "new_ticket", null, {
    ticket_id: args.ticketId,
    user_id: args.userId,
    category: args.category ?? null,
    message: args.message.slice(0, 500),
  });
}

/**
 * Enqueue the shop owner's "a customer replied to a ticket" email —
 * enqueued from `addTicketMessage`, but ONLY for `SenderType.USER` messages;
 * an admin's own reply must never trigger this (the caller is responsible for
 * that gate). Tickets have no order, so `orderId` is always null. `message`
 * is truncated to 500 chars, same reasoning as `enqueueOwnerNewTicketEmail`.
 * No-op unless the owner has the master toggle, `owner_email_on_ticket_reply`,
 * and a valid `owner_email` all configured.
 */
export async function enqueueOwnerTicketReplyEmail(
  db: Db,
  args: { ticketId: number; userId: number; message: string },
): Promise<void> {
  await enqueueOwnerEmail(db, NotificationEvent.OWNER_EMAIL_TICKET_REPLY, "ticket_reply", null, {
    ticket_id: args.ticketId,
    user_id: args.userId,
    message: args.message.slice(0, 500),
  });
}

/**
 * Enqueue the shop owner's "a buyer topped up their wallet" email —
 * `settleWalletTopup`'s single call site (wallet_topup.ts), placed inside the
 * successful atomic PENDING_PAYMENT -> DELIVERED claim branch, after
 * `adjustWallet`. That one call site is shared by all six top-up-capable
 * rails (TokoPay, PayDisini, NOWPayments, Binance Internal, Bybit, Bybit
 * BSC), so this enqueues exactly once per settled top-up no matter which
 * rail settled it — the caller must never call this a second time per-rail,
 * or it produces a duplicate email. No-op (see `enqueueOwnerEmail`) unless
 * the owner has the master toggle, `owner_email_on_wallet_topup`, and a
 * valid `owner_email` all configured.
 *
 * Distinct from `enqueueWalletTopupCreditedDm` above: that one is a Telegram
 * DM to the BUYER; this is an EMAIL to the shop OWNER. Different recipient,
 * different channel, different payload shape — the two must never be
 * conflated.
 *
 * `amount`/`newBalance` go through `.toString()` — never a raw `number` —
 * per money rules. `transactionId` is written as an explicit JSON `null`
 * when the caller has none, never omitted and never the string `"null"`,
 * same convention as `enqueueOwnerOrderPaidEmail`'s optional fields.
 * `toppedUpAt` is written as an ISO string.
 */
export async function enqueueOwnerWalletTopupEmail(
  db: Db,
  args: {
    orderId: number;
    orderCode: string;
    customerLabel: string;
    amount: Decimal;
    currency: string;
    newBalance: Decimal;
    paymentMethod: string;
    transactionId: string | null;
    toppedUpAt: Date;
  },
): Promise<void> {
  await enqueueOwnerEmail(db, NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, "wallet_topup", args.orderId, {
    order_code: args.orderCode,
    customer_label: args.customerLabel,
    amount: args.amount.toString(),
    currency: args.currency,
    new_balance: args.newBalance.toString(),
    payment_method: args.paymentMethod,
    transaction_id: args.transactionId,
    topped_up_at: args.toppedUpAt.toISOString(),
  });
}

/**
 * Enqueue the BUYER's "your order is ready" email — the completion receipt a
 * guest shopper gets when their order actually finishes. Enqueued from
 * `settlePaidOrder`'s AUTO branch and from `fulfillManualOrder`
 * (packages/db/src/crud/orders.ts), each guarded on
 * `order.user.isGuest && order.user.guestEmail`.
 *
 * STRUCTURALLY UNLIKE EVERY `enqueueOwner*Email` ABOVE — do not refactor them
 * together. Those resolve their recipient from Settings via
 * `enqueueOwnerEmail`/`resolveOwnerEmailRecipient` and no-op unless the shop
 * owner has turned the feature on. This one writes its row unconditionally,
 * addressed to the `to` the CALLER passed in (the guest's own checkout
 * address), and has no owner toggle at all: a buyer's completion receipt must
 * not disappear because the owner muted their own alerts, and must never be
 * delivered to the owner's address. It therefore calls
 * `db.notificationOutbox.create` directly rather than going through
 * `enqueueOwnerEmail`. The caller owns the decision to send; this function
 * owns only the row.
 *
 * NO CREDENTIALS IN THE PAYLOAD, EVER. There is no field here for delivered
 * content and none may be added: this payload is rendered in the admin
 * `/outbox` panel and the email built from it lands unencrypted in an inbox
 * that keeps it forever. The whole point of this email is to be a summary
 * plus a way back in — the buyer reads what they bought on the order page.
 *
 * Payload conventions match the owner-email helpers: every money `Decimal`
 * (including each item's `unitPrice` and `lineTotal`) goes through
 * `.toString()` — never a raw `number` — per money rules, and every optional
 * field
 * (`variant`, `warrantyDays`, `orderUrl`, `trackUrl`) is written as an
 * explicit JSON `null` when absent, never omitted and never the string
 * `"null"`; the renderer, not this layer, decides to drop the corresponding
 * line.
 */
export async function enqueueBuyerOrderReadyEmail(
  db: Db,
  args: {
    orderId: number;
    orderCode: string;
    /** The guest's own email address, straight from the call site — NOT the
     * `owner_email` Setting. See this function's header. */
    to: string;
    items: {
      name: string;
      variant: string | null;
      quantity: number;
      unitPrice: Decimal;
      /** The whole line's money, computed by the CALLER — not something this
       * layer or the renderer may re-derive as `unitPrice * quantity`. On a
       * currency-converted order `unitPrice` has already been rounded to the
       * nearest 0.1 USDT, so scaling it by the quantity would scale that
       * rounding error too and print a line total contradicting the subtotal
       * right below it. See the call site in crud/orders.ts. */
      lineTotal: Decimal;
    }[];
    /** The three money figures below must satisfy
     * `subtotal - discount + uniqueCents === total`, exactly, in the order's
     * settlement currency — the caller derives them so that they do (see
     * enqueueBuyerOrderReadyEmailIfGuest in crud/orders.ts). The reader is the
     * customer who just paid, and a receipt that does not reconcile reads as
     * an overcharge. */
    subtotal: Decimal;
    discount: Decimal;
    /** The order's unique-cents surcharge: 0.002-0.098 USDT of deterministic
     * noise finalizeOrderPayment folds into the total so the payment poller
     * can match the buyer's transfer by amount (zero on the IDR rails, which
     * confirm by gateway callback instead). It is money the buyer paid, so
     * the receipt prints it as its own row rather than burying it in the
     * total. */
    uniqueCents: Decimal;
    total: Decimal;
    currency: string;
    warrantyDays: number | null;
    /** The buyer-facing order page, or null when neither SHOP_PUBLIC_URL nor
     * PUBLIC_URL is configured — the template then renders no button. */
    orderUrl: string | null;
    /** The `/track` order-code recovery page, null under the same condition. */
    trackUrl: string | null;
  },
): Promise<void> {
  await db.notificationOutbox.create({
    data: {
      event: NotificationEvent.BUYER_EMAIL_ORDER_READY,
      orderId: args.orderId,
      channel: NotificationChannel.EMAIL,
      payloadJson: JSON.stringify({
        to: args.to,
        order_code: args.orderCode,
        items: args.items.map((item) => ({
          name: item.name,
          variant: item.variant,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toString(),
          lineTotal: item.lineTotal.toString(),
        })),
        subtotal: args.subtotal.toString(),
        discount: args.discount.toString(),
        unique_cents: args.uniqueCents.toString(),
        total: args.total.toString(),
        currency: args.currency,
        warranty_days: args.warrantyDays,
        order_url: args.orderUrl,
        track_url: args.trackUrl,
      }),
    },
  });
}

/**
 * A SENDING row whose claim is older than this is treated as abandoned (the
 * dispatcher that claimed it died mid-send, before reaching
 * markNotificationSent/Failed) and becomes claimable again. Infra-2 fix,
 * security audit 2026-06-23.
 */
export const STALE_CLAIM_MS = 5 * 60_000;

/**
 * `nextRetryAt` IS NULL OR <= now — a row markNotificationFailed backed off
 * isn't claimable again until its window passes (Infra-3 fix, security audit
 * 2026-06-23). Shared by fetchPendingNotifications and claimNotification so
 * a backed-off row can never sneak through one but not the other.
 */
function claimableWhere(staleCutoff: Date, now: Date) {
  return {
    OR: [
      { status: NotificationStatus.PENDING },
      { status: NotificationStatus.SENDING, claimedAt: { lt: staleCutoff } },
    ],
    AND: { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
  };
}

// Bulk fan-out events (createMany, one row per customer — potentially
// hundreds/thousands at once) that must never be allowed to queue ahead of a
// single-recipient urgent DM (e.g. ADMIN_PW_RESET, the admin-panel
// forgot-password OTP) just because they happened to enqueue first.
const BROADCAST_EVENTS = new Set<string>([
  NotificationEvent.PRODUCT_RESTOCKED_BROADCAST,
  NotificationEvent.FLASH_SALE_BROADCAST,
]);

/**
 * Oldest claimable rows first (PENDING, or SENDING claimed past
 * STALE_CLAIM_MS), capped at `limit` — but urgent (non-broadcast) rows are
 * always returned ahead of bulk-broadcast rows, regardless of enqueue order.
 * Without this split, a large `enqueueRestockBroadcast`/
 * `enqueueFlashSaleBroadcast` fan-out sitting in the same FIFO queue could
 * delay an urgent DM enqueued moments later by many minutes.
 */
export async function fetchPendingNotifications(db: Db, limit = 50, now: Date = new Date()) {
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const where = claimableWhere(staleCutoff, now);

  const urgent = await db.notificationOutbox.findMany({
    where: { ...where, event: { notIn: [...BROADCAST_EVENTS] } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  if (urgent.length >= limit) return urgent;

  const broadcasts = await db.notificationOutbox.findMany({
    where: { ...where, event: { in: [...BROADCAST_EVENTS] } },
    orderBy: { createdAt: "asc" },
    take: limit - urgent.length,
  });
  return [...urgent, ...broadcasts];
}

/**
 * Atomically claim a row (PENDING, or SENDING past STALE_CLAIM_MS) right
 * before attempting to send it — closes the crash-window double-send gap
 * where a row could be sent to Telegram but the SENT write never lands
 * (Infra-2 fix). Returns false if another dispatcher already claimed it
 * (multi-instance) or it's no longer claimable; the caller must skip the row.
 */
export async function claimNotification(db: Db, notifId: number, now: Date = new Date()): Promise<boolean> {
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const res = await db.notificationOutbox.updateMany({
    where: { id: notifId, ...claimableWhere(staleCutoff, now) },
    data: { status: NotificationStatus.SENDING, claimedAt: now },
  });
  return res.count === 1;
}

/**
 * Release a claimed row back to PENDING without counting it as a failed
 * attempt — used for transient conditions that aren't the row's fault (e.g.
 * Telegram flood-control), so it's immediately retryable on the next tick
 * instead of waiting out the full STALE_CLAIM_MS window. No-op if the row was
 * already claimed by someone else or moved on (SENT/FAILED).
 */
export async function releaseNotificationClaim(db: Db, notifId: number): Promise<void> {
  await db.notificationOutbox.updateMany({
    where: { id: notifId, status: NotificationStatus.SENDING },
    data: { status: NotificationStatus.PENDING, claimedAt: null },
  });
}

/** Mark a row SENT with the current timestamp. */
export async function markNotificationSent(
  db: Db,
  notifId: number,
): Promise<void> {
  await db.notificationOutbox.update({
    where: { id: notifId },
    data: { status: NotificationStatus.SENT, sentAt: new Date(), claimedAt: null },
  });
}

// Exponential backoff for a row markNotificationFailed sends back to PENDING
// (Infra-3 fix, security audit 2026-06-23) — base 30s, doubling per attempt,
// capped at 10 minutes. At the default NOTIF_POLL_INTERVAL_SECONDS=10 this
// frees up several tick's worth of "top N" batch slots for valid rows
// instead of a permanently-failing row re-claiming one every single tick.
export const NOTIF_RETRY_BASE_MS = 30_000;
export const NOTIF_RETRY_MAX_MS = 10 * 60_000;

/** Exponential backoff delay for the Nth attempt (1-indexed), capped. */
export function notificationBackoffMs(attempts: number): number {
  return Math.min(NOTIF_RETRY_BASE_MS * 2 ** (attempts - 1), NOTIF_RETRY_MAX_MS);
}

/**
 * Increment attempts and record the error (truncated to 500 chars). Once
 * attempts >= maxAttempts the row goes terminal (nextRetryAt cleared);
 * otherwise it goes back to PENDING with an exponential-backoff
 * `nextRetryAt`, for a later retry. No-op if the row is gone.
 *
 * The terminal status depends on whether the row was ever actually eligible
 * for retry:
 * - `maxAttempts > 1`: the row went through real exponential-backoff retries
 *   and still exhausted them all → DEAD_LETTER ("retried to the ceiling,
 *   still failing" — worth paging an operator about).
 * - `maxAttempts <= 1`: the row was terminal on its very first and only
 *   call — a permanently invalid row (malformed payload, missing template,
 *   missing chat_id, etc.) that retrying would never fix → FAILED, same as
 *   before this split existed.
 *
 * Worst-case time-to-DEAD_LETTER under the current default
 * (`NOTIF_MAX_ATTEMPTS=10`, `NOTIF_RETRY_BASE_MS=30s` doubling, capped at
 * `NOTIF_RETRY_MAX_MS=10min`) is ~55.5 minutes (30+60+120+240+480+600×4) —
 * up from ~7.5 minutes under the old default of 5. The row stays visible via
 * the `/metrics` `outbox_backlog_size`/`outbox_oldest_unsent_age_seconds`
 * gauges throughout that window, so an operator alerting only on
 * `outbox_dead_letter_count` should also watch those two for an earlier
 * signal.
 */
export async function markNotificationFailed(
  db: Db,
  notifId: number,
  error: string,
  maxAttempts = 5,
  now: Date = new Date(),
): Promise<void> {
  const row = await db.notificationOutbox.findUnique({ where: { id: notifId } });
  if (!row) return;
  const attempts = row.attempts + 1;
  const terminal = attempts >= maxAttempts;
  const terminalStatus = maxAttempts > 1 ? NotificationStatus.DEAD_LETTER : NotificationStatus.FAILED;
  await db.notificationOutbox.update({
    where: { id: notifId },
    data: {
      attempts,
      lastError: error.slice(0, 500),
      claimedAt: null,
      status: terminal ? terminalStatus : NotificationStatus.PENDING,
      nextRetryAt: terminal ? null : new Date(now.getTime() + notificationBackoffMs(attempts)),
    },
  });
}

/**
 * Release a claimed row back to PENDING with the same exponential backoff
 * `markNotificationFailed` uses (attempts increment + `notificationBackoffMs`),
 * but WITHOUT ever transitioning it to FAILED — for conditions that are the
 * shop's configuration, not the row's fault (e.g. a channel-post event like
 * ORDER_DELIVERED enqueued while PUBLIC_CHANNEL_ID was set, then the channel
 * is unset/changed before it's delivered). An admin can fix the configuration
 * at any time, so no attempt count is ever terminal for this path — unlike
 * `releaseNotificationClaim` (used for transient conditions like Telegram
 * flood control), this backs off so the row stops re-claiming a batch slot
 * every single tick. No-op if the row was already claimed by someone else or
 * moved on (SENT/FAILED).
 */
export async function releaseNotificationClaimWithBackoff(
  db: Db,
  notifId: number,
  now: Date = new Date(),
): Promise<void> {
  const row = await db.notificationOutbox.findUnique({ where: { id: notifId } });
  if (!row) return;
  const attempts = row.attempts + 1;
  await db.notificationOutbox.updateMany({
    where: { id: notifId, status: NotificationStatus.SENDING },
    data: {
      attempts,
      claimedAt: null,
      status: NotificationStatus.PENDING,
      nextRetryAt: new Date(now.getTime() + notificationBackoffMs(attempts)),
    },
  });
}

/**
 * Enqueue the buyer's account-credentials DM for a DELIVERED order, for
 * callers that don't send it themselves — the web-admin panel's approve and
 * resend actions (CLAUDE.md: the web NEVER sends Telegram, only enqueues).
 * Same payload shape the payment-gateway auto-confirm rails already enqueue
 * (see tokopay.ts `deliverPaidTokopayOrder`). No-op for web-only buyers
 * (telegramId=null) — they see their order on the storefront instead.
 */
export async function enqueueOrderDeliveredDm(
  db: Db,
  args: { orderId: number; orderCode: string; telegramId: bigint | null; language: string | null },
): Promise<void> {
  if (args.telegramId == null) return;
  const shopUrl = config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null;
  await db.notificationOutbox.create({
    data: {
      event: NotificationEvent.ORDER_DELIVERED_DM,
      orderId: args.orderId,
      payloadJson: JSON.stringify({
        chat_id: Number(args.telegramId),
        order_code: args.orderCode,
        order_url: shopUrl ? `${shopUrl.replace(/\/+$/, "")}/account/orders/${args.orderCode}` : null,
        buyer_language: langCode(args.language),
      }),
    },
  });
}

/**
 * Enqueue the buyer's "payment received — being prepared by hand" DM when a
 * manual-delivery order moves PAID → PROCESSING (see settlePaidOrder). Carries
 * chat_id + order_code + language only; the dispatcher renders the reassurance
 * copy. No-op for web-only buyers (they see the status on the storefront).
 */
export async function enqueueOrderProcessingDm(
  db: Db,
  args: { orderId: number; orderCode: string; telegramId: bigint | null; language: string | null },
): Promise<void> {
  if (args.telegramId == null) return;
  const shopUrl = config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null;
  await enqueueNotification(db, NotificationEvent.ORDER_PROCESSING_DM, args.orderId, {
    chat_id: Number(args.telegramId),
    order_code: args.orderCode,
    order_url: shopUrl ? `${shopUrl.replace(/\/+$/, "")}/account/orders/${args.orderCode}` : null,
    buyer_language: langCode(args.language),
  });
}

/**
 * Enqueue the buyer's DM carrying the admin-typed fulfillment text for a manual
 * order (PROCESSING → DELIVERED, see fulfillManualOrder). Like the credentials
 * DM, the CONTENT itself is NOT placed in the payload — the dispatcher reads
 * Order.deliveredContent live at send time (the outbox table is admin-visible).
 * No-op for web-only buyers (they read deliveredContent on the storefront).
 */
export async function enqueueManualDeliveredDm(
  db: Db,
  args: { orderId: number; orderCode: string; telegramId: bigint | null; language: string | null },
): Promise<void> {
  if (args.telegramId == null) return;
  await enqueueNotification(db, NotificationEvent.ORDER_MANUAL_DELIVERED_DM, args.orderId, {
    chat_id: Number(args.telegramId),
    order_code: args.orderCode,
    buyer_language: langCode(args.language),
  });
}

/**
 * Enqueue the buyer's "wallet top-up credited" DM — the ONE call site for
 * this event across all six top-up-capable rails (TokoPay, PayDisini,
 * NOWPayments, Binance Internal, Bybit, Bybit BSC). Called from
 * `settleWalletTopup` (packages/db/src/crud/wallet_topup.ts) right after the
 * wallet credit lands, which sits behind that function's atomic claim — so
 * no rail-specific caller may enqueue this event itself, or the buyer would
 * be notified twice for the same top-up. `telegramId == null` is checked by
 * `settleWalletTopup` before calling this, same as the `credited.greaterThan(0)`
 * gate — see that function's own doc-comment. Money is carried as Decimal
 * `.toString()` — never `number` — per money rules.
 *
 * Carries the dedupe key `topup-credited:<orderId>`, so a second enqueue for
 * the same top-up order writes nothing instead of a second row. The atomic
 * claim in `settleWalletTopup` is still the primary guard and still the
 * reason this has exactly one call site; the key is the database-level
 * backstop for the case that guard is bypassed — a caller re-passing an
 * upstream ledger claim, or a future second call site. It does NOT make the
 * DM idempotent end to end: it stops a duplicate row being queued, and says
 * nothing about whether Telegram delivered the first one.
 */
export async function enqueueWalletTopupCreditedDm(
  db: Db,
  args: { orderId: number; orderCode: string; chatId: number; amount: Decimal; currency: string; newBalance: Decimal },
): Promise<void> {
  await enqueueNotification(
    db,
    NotificationEvent.WALLET_TOPUP_CREDITED_DM,
    args.orderId,
    {
      chat_id: args.chatId,
      order_code: args.orderCode,
      amount: args.amount.toString(),
      currency: args.currency,
      new_balance: args.newBalance.toString(),
    },
    `topup-credited:${args.orderId}`,
  );
}

/**
 * Enqueue a "back in stock" DM to every non-banned customer with a linked
 * Telegram account, for a product whose `broadcastOnRestock` flag is on.
 * Unlike RestockSubscription (per-SKU opt-in, one-shot), this targets the
 * entire customer base every time the flag is on and stock is added, so a
 * single `createMany` is used instead of a per-row loop (potentially
 * hundreds/thousands of recipients). No-op (returns 0) if there are no
 * eligible customers. The web NEVER sends Telegram itself — this just drops
 * the rows for the notifier/bot to deliver.
 *
 * Also writes a `Broadcast` row with status SENT so this shows up in the
 * web-admin Broadcast History table alongside manually-composed broadcasts —
 * that table is otherwise populated only by the separate admin-compose
 * flow (`createBroadcast`/`drainBroadcasts` in crud/broadcasts.ts), which
 * this feature deliberately does NOT route through (that pipeline sends with
 * no parse_mode, so the bold formatting below wouldn't render). The
 * sent/total counts here are optimistic (assume delivery succeeds) since the
 * actual per-recipient send happens later, asynchronously, via the outbox
 * dispatcher — unlike drainBroadcasts's real-time counts.
 *
 * `message` here MUST be kept in sync (plain-text, same content) with the
 * HTML template for NotificationEvent.PRODUCT_RESTOCKED_BROADCAST in
 * packages/outbox-dispatcher/src/templates.ts — that's the one actually sent
 * to customers; this is only what the admin sees in the History table.
 */
export async function enqueueRestockBroadcast(
  db: Db,
  args: { productName: string; stockCount: number; createdById?: number | null },
): Promise<number> {
  const users = await db.user.findMany({
    where: { banned: false, telegramId: { not: null } },
    select: { telegramId: true, language: true },
  });
  if (!users.length) return 0;
  await db.notificationOutbox.createMany({
    data: users.map((u) => ({
      event: NotificationEvent.PRODUCT_RESTOCKED_BROADCAST,
      orderId: null,
      payloadJson: JSON.stringify({
        chat_id: Number(u.telegramId),
        product_name: args.productName,
        stock_count: args.stockCount,
        buyer_language: langCode(u.language),
      }),
    })),
  });
  await db.broadcast.create({
    data: {
      message:
        `👋 Hello!\n\n` +
        `We're happy to let you know that ${args.productName} is back in stock! 🎉\n\n` +
        `📦 Available Stock: ${args.stockCount} accounts\n\n` +
        `Order now while supplies last. Thank you for choosing us!`,
      segment: "ALL",
      status: "SENT",
      totalCount: users.length,
      sentCount: users.length,
      failedCount: 0,
      createdById: args.createdById ?? null,
      scheduledAt: null,
      sentAt: new Date(),
    },
  });
  return users.length;
}

/**
 * Cap on how many outbox rows a single `createMany` call inside
 * `enqueueFlashSaleBroadcast` writes at once. SQLite has one writer for the
 * whole shared `data/bot.db`, so even a single `createMany` call briefly holds
 * that writer lock for however long it takes to insert all of its rows —
 * chunking keeps each individual write short (a few hundred rows) regardless
 * of how large the customer base grows, instead of one insert scaling with it.
 */
export const FLASH_SALE_BROADCAST_CHUNK_SIZE = 500;

/**
 * Enqueue a "flash sale is live" DM to every non-banned customer with a linked
 * Telegram account, for a denomination whose scheduled sale window has just
 * opened. MUST be called with the top-level `PrismaClient`, never a `tx` — see
 * the order-bot's `announceStartedFlashSales` job, which claims
 * `flashAnnouncedAt` in its own short transaction and only then calls this
 * function outside that transaction (H-7 fix, backend audit 2026-07-31): the
 * claim and the fan-out no longer share one transaction, because holding
 * SQLite's single writer lock for the whole customer-base enumeration +
 * insert would starve every other concurrent writer (checkout, settlement,
 * cancellation, the outbox dispatcher's own claim) past their busy_timeout.
 * The customer `findMany` runs unguarded (a plain read), and the outbox rows
 * are written in `FLASH_SALE_BROADCAST_CHUNK_SIZE`-row chunks — each
 * `createMany` call is its own short, self-contained write — rather than one
 * `createMany` sized to the whole customer base. No-op (returns 0, no
 * `Broadcast` row) if there are no eligible customers.
 *
 * Prices and the end time arrive here as already-formatted display strings
 * (shop currency via `formatIdr`, shop timezone via `localize`) — the caller
 * owns that formatting, exactly like ORDER_DELIVERED's `delivered_at`, so the
 * dispatcher never has to do money or timezone math at send time.
 *
 * The `Broadcast` row (so the announcement shows up in the web-admin
 * Broadcast History table alongside the restock ones) is written BEFORE the
 * chunk loop below, as SENDING with `sentCount: 0`, and is updated after each
 * chunk lands and once more at the very end — NOT written only after every
 * chunk has already succeeded (H-7 follow-up fix, backend audit
 * 2026-07-31/08-01: the original version of this split wrote the Broadcast
 * row only on full success, so a chunk throwing partway through left ZERO
 * trace in Broadcast History even though the earlier chunks' `createMany`
 * calls had already committed real, already-delivered-to-the-dispatcher
 * outbox rows for those customers — directly contradicting
 * `announceStartedFlashSales`'s own guidance to check Broadcast History after
 * a partial failure). If a chunk throws, the row is flipped to FAILED with a
 * `failureReason` and its `sentCount` frozen at however many customers the
 * successful chunks already reached, then the original error is re-thrown so
 * the caller's existing logging still fires — so Broadcast History now always
 * reflects reality: SENT with the full count on success, or FAILED with an
 * honest partial `sentCount` on a partial failure. Total/sent counts here are
 * otherwise optimistic (assume delivery succeeds) since the actual
 * per-recipient send happens later, asynchronously, via the outbox
 * dispatcher.
 *
 * `message` here MUST be kept in sync (plain-text, same content) with the HTML
 * template for NotificationEvent.FLASH_SALE_BROADCAST in
 * packages/outbox-dispatcher/src/templates.ts — that's the one actually sent to
 * customers; this is only what the admin sees in the History table.
 *
 * Both terminal status writes (the SENT-flip on success, the FAILED-flip in
 * the `catch`) are themselves ordinary SQLite writes that can fail under the
 * exact writer contention this whole function exists to relieve — so neither
 * is allowed to leave the row silently stuck (H-7 follow-up fix #2, backend
 * audit 2026-07-31/08-01):
 * - The row is created with `claimedAt` set, the same "atomically claimed"
 *   marker `claimNextDueBroadcast` sets on the admin-compose broadcast path.
 *   That's what makes `reapStaleBroadcasts` (`crud/broadcasts.ts`) able to see
 *   this row at all — its `claimedAt: { lt: staleCutoff }` filter matches
 *   nothing on a NULL column, so a row created without it would be invisible
 *   to that existing stale-claim safety net forever. With `claimedAt` set, a
 *   row that never reaches SENT or FAILED here (because BOTH the primary
 *   write and its own recovery write failed) is still reclaimed as FAILED by
 *   `reapStaleBroadcasts`, which `drainBroadcasts` already runs on every tick
 *   — no new job needed.
 * - The FAILED-flip in `catch` is itself wrapped in try/catch: if that write
 *   ALSO throws (a double fault), the secondary error is logged but NEVER
 *   allowed to replace the original chunk error in what gets re-thrown — a
 *   caller catching this must always see the real root cause, not a masking
 *   failure from the recovery attempt.
 * - The trailing SENT-flip is also wrapped: if it throws, all customers WERE
 *   still successfully enqueued (the loop above already completed), so this
 *   function does NOT throw over a purely cosmetic bookkeeping failure — it
 *   logs and returns `users.length` as normal. The row is left SENDING with
 *   `claimedAt` set, so `reapStaleBroadcasts` reclaims it as FAILED later;
 *   that terminal status ends up misleading for what was actually a full
 *   success, but "eventually FAILED" beats "stuck forever."
 */
export async function enqueueFlashSaleBroadcast(
  db: PrismaClient,
  args: {
    productName: string;
    denominationName: string;
    discountPercent: string;
    oldPrice: string;
    newPrice: string;
    endsAt: string;
    createdById?: number | null;
  },
): Promise<number> {
  const users = await db.user.findMany({
    where: { banned: false, telegramId: { not: null } },
    select: { telegramId: true, language: true },
  });
  if (!users.length) return 0;
  const rows = users.map((u) => ({
    event: NotificationEvent.FLASH_SALE_BROADCAST,
    orderId: null,
    payloadJson: JSON.stringify({
      chat_id: Number(u.telegramId),
      product_name: args.productName,
      denomination_name: args.denominationName,
      discount_percent: args.discountPercent,
      old_price: args.oldPrice,
      new_price: args.newPrice,
      ends_at: args.endsAt,
      buyer_language: langCode(u.language),
    }),
  }));

  const bc = await db.broadcast.create({
    data: {
      message:
        `⚡ FLASH SALE — ${args.discountPercent}% OFF\n\n` +
        `${args.productName} — ${args.denominationName} is on sale right now! 🎉\n\n` +
        `💸 Now ${args.newPrice} (was ${args.oldPrice})\n` +
        `⏳ Ends: ${args.endsAt}\n\n` +
        `Grab it before the timer runs out!`,
      segment: "ALL",
      status: BroadcastStatus.SENDING,
      totalCount: users.length,
      sentCount: 0,
      failedCount: 0,
      createdById: args.createdById ?? null,
      scheduledAt: null,
      // Same "atomically claimed" marker claimNextDueBroadcast sets — without
      // it, reapStaleBroadcasts's `claimedAt: { lt: staleCutoff }` filter can
      // never match this row (NULL never compares less-than anything), so a
      // row stuck in SENDING here would be invisible to that safety net
      // forever (H-7 follow-up fix #2, backend audit 2026-07-31/08-01).
      claimedAt: new Date(),
      sentAt: null,
    },
  });

  try {
    for (let i = 0; i < rows.length; i += FLASH_SALE_BROADCAST_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + FLASH_SALE_BROADCAST_CHUNK_SIZE);
      await db.notificationOutbox.createMany({ data: chunk });
      // Reflect progress after every chunk, not just at the end, so a crash
      // between chunks still leaves an accurate partial sentCount behind.
      await db.broadcast.update({ where: { id: bc.id }, data: { sentCount: { increment: chunk.length } } });
    }
  } catch (err) {
    try {
      await db.broadcast.update({
        where: { id: bc.id },
        data: {
          status: BroadcastStatus.FAILED,
          failureReason: (
            "Enqueueing the customer fan-out failed partway through — sentCount reflects how many customers " +
            "were already queued the DM before the failure; the remainder were never reached. Re-announcing " +
            "this sale (e.g. by re-scheduling it) will re-notify the WHOLE customer base with no de-duplication " +
            "against those already reached here, so anyone covered by sentCount will receive it twice."
          ).slice(0, 500),
        },
      });
    } catch (recoveryErr) {
      // Double fault: the row also failed to flip to FAILED (same writer
      // contention that caused the original chunk failure is a likely cause).
      // Log it, but do NOT let it replace the original error below — a
      // caller catching this must see the real root cause. The row is left
      // SENDING, but claimedAt is already set above, so reapStaleBroadcasts
      // reclaims it as FAILED once BROADCAST_STALE_CLAIM_MS passes instead of
      // it being lost forever.
      logger.error(
        { err: recoveryErr, broadcastId: bc.id },
        "Failed to flip a flash-sale Broadcast row to FAILED after its customer fan-out already failed — the row stays SENDING for now, but reapStaleBroadcasts will reclaim it as FAILED once its stale-claim window passes",
      );
    }
    throw err;
  }

  try {
    await db.broadcast.update({
      where: { id: bc.id },
      data: { status: BroadcastStatus.SENT, sentAt: new Date() },
    });
  } catch (err) {
    // Every customer WAS successfully enqueued — the loop above already
    // completed — so this is purely the terminal bookkeeping write failing,
    // not a delivery failure. Don't throw over it: the caller (and this
    // function's return value) should still reflect the real outcome. The
    // row is left SENDING with claimedAt set, so reapStaleBroadcasts
    // reclaims it as FAILED later — a misleading terminal status for what
    // was actually a full success, but "eventually FAILED" beats "stuck
    // forever," and the sentCount on the row already shows the true count.
    logger.error(
      { err, broadcastId: bc.id },
      "Enqueued the whole flash-sale customer fan-out successfully, but failed to flip its Broadcast row from SENDING to SENT — the row stays SENDING (with an accurate sentCount) until reapStaleBroadcasts reclaims it as FAILED, even though delivery itself was not affected",
    );
  }
  return users.length;
}

// ---- Outbox monitor (web-admin /outbox) -----------------------------------

/** Newest-first outbox rows, optionally filtered by status, with linked order code. */
export function listNotifications(
  db: Db,
  opts: { status?: string | null; limit?: number; offset?: number } = {},
) {
  return db.notificationOutbox.findMany({
    where: opts.status ? { status: opts.status } : {},
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 50,
    include: { order: { select: { id: true, orderCode: true } } },
  });
}

export function countNotifications(db: Db, opts: { status?: string | null } = {}) {
  return db.notificationOutbox.count({ where: opts.status ? { status: opts.status } : {} });
}

/**
 * Age in seconds of the single oldest unsent outbox row — "unsent" meaning
 * PENDING, or SENDING with a claim older than STALE_CLAIM_MS (an abandoned
 * claim from a dispatcher that died mid-send effectively never sent, exactly
 * like fetchPendingNotifications/claimNotification already treat it
 * elsewhere in this file). Drives the /metrics `outbox_oldest_unsent_age_seconds`
 * gauge (apps/web-admin/src/routes/metrics.ts). A single query — `MIN(createdAt)`
 * over that set via `findFirst`/`orderBy` — not a fetch-then-compute-in-app-code.
 *
 * Returns `null` when no such row exists (an empty/healthy outbox) rather
 * than `0`: a Prometheus gauge should simply not report a sample in that
 * case, since `0` would misleadingly read as "a row aged out at exactly this
 * instant."
 */
export async function oldestUnsentNotificationAge(db: Db, now: Date = new Date()): Promise<number | null> {
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const row = await db.notificationOutbox.findFirst({
    where: {
      OR: [
        { status: NotificationStatus.PENDING },
        { status: NotificationStatus.SENDING, claimedAt: { lt: staleCutoff } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!row) return null;
  return Math.floor((now.getTime() - row.createdAt.getTime()) / 1000);
}

/** Count of outbox rows per status — drives the summary cards. */
export async function outboxStatusCounts(db: Db): Promise<Record<string, number>> {
  const grouped = await db.notificationOutbox.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  return counts;
}

/** A single outbox row's `event` type — just enough for an audit-log `details`
 * sentence (e.g. "Requeued a ${event} notification for delivery.") without
 * pulling the full row (payload JSON, timestamps, etc.) into a route. */
export function getNotification(db: Db, notifId: number) {
  return db.notificationOutbox.findUnique({ where: { id: notifId }, select: { event: true } });
}

/**
 * Requeue a FAILED (or stuck) notification: back to PENDING, attempts reset to
 * 0, error/sent cleared, so the notifier drains it again on its next cycle.
 * `nextRetryAt` is cleared too (Infra-3 fix, security audit 2026-06-23) — an
 * admin clicking "retry" means NOW, not "wait out whatever backoff window
 * this row was already in." Returns false if the row is gone. The web NEVER
 * sends Telegram itself.
 */
export async function retryNotification(db: Db, notifId: number): Promise<boolean> {
  const row = await db.notificationOutbox.findUnique({ where: { id: notifId } });
  if (!row) return false;
  await db.notificationOutbox.update({
    where: { id: notifId },
    data: { status: NotificationStatus.PENDING, attempts: 0, lastError: null, sentAt: null, nextRetryAt: null },
  });
  return true;
}
