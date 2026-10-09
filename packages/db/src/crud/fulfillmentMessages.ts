import type { Db } from "./_types";
import { fulfillmentProviderFor } from "@app/core/orderFulfillment";

/** Reserve bot checkout ownership before gateway work or Telegram I/O.
 * The worker cannot send while the initial screen is awaiting acknowledgement.
 */
export async function reserveTransactionMessage(db: Db, orderId: number): Promise<void> {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { user: { select: { telegramId: true } } } });
  if (order.user.telegramId == null) return;
  await db.fulfillmentMessage.upsert({ where: { orderId }, create: {
    orderId, chatId: order.user.telegramId, state: "WAITING_SCREEN",
  }, update: {} });
}

/** Indexed lookup used by navigation and legacy QR cleanup. */
export async function ownsTransactionMessageAt(db: Db, chatId: number | bigint, messageId: number): Promise<boolean> {
  return !!(await db.fulfillmentMessage.findFirst({ where: { chatId: BigInt(chatId), messageId }, select: { orderId: true } }));
}

/**
 * Register the buyer's single Telegram progress message for an order. The
 * outbox-dispatcher's FulfillmentMessageWorker sends it once and then edits
 * that same message from the order's canonical state.
 *
 * Register at a canonical payment transition, including wallet payments.
 * Adopt a persisted payment screen when available; replays preserve its ID.
 * Buyers without a Telegram chat do not need a message.
 */
export async function ensureFulfillmentMessage(db: Db, orderId: number): Promise<boolean> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: {
    kind: true, status: true, fulfillmentProvider: true, paymentMsgChatId: true, paymentMsgId: true,
    user: { select: { telegramId: true } },
    items: { select: { deliveryTypeSnapshot: true, product: { select: { autoDeliverySource: true, deliveryType: true } } } },
  } });
  const chatId = order?.user.telegramId;
  if (chatId == null || !order) return false;
  const tracked = await db.fulfillmentMessage.findUnique({ where: { orderId } });
  const anchored = order.paymentMsgId != null && order.paymentMsgChatId != null;
  // Instant stock delivery without a payment bubble uses its credentials artifact.
  if (!tracked && !anchored && order.kind === "PRODUCT" && order.status === "DELIVERED" && fulfillmentProviderFor(order) !== "DIGIFLAZZ") return false;
  await db.fulfillmentMessage.upsert({ where: { orderId }, create: {
    orderId, chatId: order.paymentMsgChatId ?? chatId, messageId: order.paymentMsgId,
    state: order.paymentMsgId == null ? "READY" : "ACTIVE",
  }, update: {} });
  await wakeFulfillmentMessage(db, orderId, new Date(), { correctFinishedOutcome: true });
  return true;
}

/** Which kind of Telegram message a tracked `messageId` is (`FulfillmentMessage.messageKind`). */
export type TransactionMessageKind = "photo" | "text";

/**
 * Adopt the actual payment screen, including QR captions, without a send.
 * `kind` is what was actually sent: a QR photo+caption bubble is "photo",
 * everything else "text". It is stored with the message id, and only when this
 * call is the one that sets the id — an already acknowledged message keeps its
 * own id and kind.
 */
export async function adoptTransactionMessage(
  db: Db, orderId: number, chatId: number | bigint, messageId: number, kind: TransactionMessageKind,
): Promise<void> {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, paymentState: true, walletCreditState: true } });
  const awaitingPayment = order.status === "PENDING_PAYMENT"
    && !["PAYMENT_DETECTED", "VERIFYING", "PAID", "UNDERPAID"].includes(order.paymentState ?? "")
    && !["NEEDS_REVIEW", "CREDITED"].includes(order.walletCreditState ?? "");
  // An acknowledged canonical message never changes ID on ordinary navigation.
  // The checkout anchor is assigned only once for a newly created transaction.
  await db.fulfillmentMessage.upsert({ where: { orderId }, create: {
    orderId, chatId: BigInt(chatId), messageId, messageKind: kind,
    state: awaitingPayment ? "WAITING" : "ACTIVE",
    phase: awaitingPayment ? "NONE" : null,
  }, update: {} });
  // Detection can register the row before checkout acknowledges its screen.
  // Fill that empty slot without moving an already acknowledged message.
  const empty = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId } });
  if (empty.messageId !== null) return;
  const adopted = await db.fulfillmentMessage.updateMany({ where: { orderId, messageId: null, claimedAt: null,
    state: { in: ["WAITING_SCREEN", "READY", "WAITING", "ACTIVE"] },
  }, data: {
    chatId: BigInt(chatId), messageId, messageKind: kind,
    state: awaitingPayment ? "WAITING" : "ACTIVE",
    phase: awaitingPayment ? "NONE" : null,
  } });
  if (!adopted.count) throw new Error("Transaction message delivery already holds the lease");
}

/**
 * Record that Telegram acknowledged the credentials `.txt` document for an
 * order. First writer wins: one conditional update sets both columns only while
 * `credentialsDeliveredAt` is still null, so a concurrent or repeated sender
 * can never overwrite the recorded document id.
 * Returns whether this call set them; when it did, the order's progress message
 * is made due so it re-renders from the new state.
 */
export async function markCredentialsDelivered(db: Db, orderId: number, messageId: number, now: Date = new Date()): Promise<boolean> {
  const set = await db.order.updateMany({
    where: { id: orderId, credentialsDeliveredAt: null },
    data: { credentialsDeliveredAt: now, credentialsDocMsgId: messageId },
  });
  if (!set.count) return false;
  await wakeFulfillmentMessage(db, orderId, now);
  // The status is waiting on exactly this fact ("sending your account
  // details…"), so a polled row is due now, not on its normal cadence. A
  // FINISHED row is never reopened.
  await db.fulfillmentMessage.updateMany({
    where: { orderId, state: { in: ["ACTIVE", "READY"] }, nextUpdateAt: { gt: now } },
    data: { nextUpdateAt: now },
  });
  return true;
}

/** Whether the credentials document for this order has been recorded as delivered. */
export async function credentialsDelivered(db: Db, orderId: number): Promise<boolean> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { credentialsDeliveredAt: true } });
  return order?.credentialsDeliveredAt != null;
}

/** Legacy pollers defer all message writes once the durable coordinator owns it. */
export async function ownsTransactionMessage(db: Db, orderId: number): Promise<boolean> {
  return !!(await db.fulfillmentMessage.findUnique({ where: { orderId }, select: { orderId: true } }));
}

/**
 * Bring an order's progress message forward when the order reaches a final
 * state, so the buyer sees the outcome promptly. Call it in the same
 * transaction as the status write.
 *
 * A manual order's static WAITING line is never polled (it would wait for
 * hours), so this is the only thing that moves it on: it becomes due as an
 * ACTIVE row and the worker edits it to the final text. REVIEW rows are
 * brought forward too. A row the worker holds right now (EDITING) only gets
 * its due time touched. The worker saves under the order lock and compares
 * the current phase, so a concurrent transition cannot disappear behind a
 * static or final save. A credit correction may also reopen a finished
 * failure/cancellation when it has a known message id. Flood-control backoffs
 * and stopped/uncertain sends are left alone.
 */
export async function wakeFulfillmentMessage(
  db: Db, orderId: number, now: Date = new Date(), opts: { correctFinishedOutcome?: boolean } = {},
): Promise<void> {
  await db.fulfillmentMessage.updateMany({
    where: { orderId, state: "WAITING" },
    data: { state: "ACTIVE", nextUpdateAt: now },
  });
  await db.fulfillmentMessage.updateMany({
    where: { orderId, state: { in: ["REVIEW", "EDITING"] } },
    data: { nextUpdateAt: now },
  });
  if (opts.correctFinishedOutcome) {
    await db.fulfillmentMessage.updateMany({
      where: { orderId, state: "FINISHED", messageId: { not: null }, phase: { in: ["FAILED", "CANCELLED"] } },
      data: { state: "ACTIVE", claimedAt: null, finishedAt: null, nextUpdateAt: now },
    });
  }
}
