import type { Bot } from "grammy";
import type { Prisma } from "@prisma/client";
import { prisma, enqueueDigiflazzReviewAlert, wakeFulfillmentMessage, type PrismaClient } from "@app/db";
import { customerProgressPhase, fulfillmentProviderFor, type CustomerProgress, type CustomerProgressPhase } from "@app/core/orderFulfillment";
import { t } from "@app/core/i18n";
import { langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { escape } from "./templates";

export type FulfillmentTelegramApi = Pick<Bot["api"], "sendMessage" | "editMessageText">;
const include = { order: { include: { user: true, items: { include: { product: true } } } } } as const;
type MessageRow = Prisma.FulfillmentMessageGetPayload<{ include: typeof include }>;
const INTERVAL_MS = 2000;
const LEASE_MS = 60_000;
const REVIEW_INTERVAL_MS = 30_000;
/** A sent message whose order has nothing to show (payment fell back to
 * awaiting) keeps its last text and is only re-read this often. */
const IDLE_INTERVAL_MS = 30_000;
/** A payment can sit in the detected phase for a long time (an admin has not
 * checked the proof yet, or settlement keeps rolling back). After this long in
 * that one phase the spinner stops and the message is re-read only every
 * DETECTED_SLOW_INTERVAL_MS, until the order's state moves it to another phase. */
export const DETECTED_SLOW_AFTER_MS = 10 * 60_000;
const DETECTED_SLOW_INTERVAL_MS = 60_000;
const FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
/** Row states the worker polls. WAITING (a manual order's static wait) is not
 * one of them: `wakeFulfillmentMessage` moves it on when the order ends. */
const POLLED_STATES = ["READY", "ACTIVE", "REVIEW"];
/** Order statuses in which a manual order may legitimately still be waiting. */
const STILL_WAITING_STATUSES: ReadonlySet<string> = new Set(["PROCESSING", "PAID"]);
const TERMINAL_PHASES: ReadonlySet<string> = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

/** Title + body locale keys per phase; the order status decides, never a timer.
 * NONE has no text: the caller keeps whatever the message already says. */
function progressKeys({ phase, topUp }: CustomerProgress & { phase: Exclude<CustomerProgressPhase, "NONE"> }): { title: string; body: string } {
  switch (phase) {
    case "PAYMENT_DETECTED": return { title: "title_detected", body: "detected" };
    case "AUTO_QUEUED": return { title: "title_confirmed", body: "auto_queued" };
    case "AUTO_SUBMITTING": return { title: "title_confirmed", body: "auto_submitting" };
    case "AUTO_PROCESSING": return { title: "title_confirmed", body: "auto_processing" };
    case "PREPARING": return { title: "title_confirmed", body: "preparing" };
    case "MANUAL_ENQUEUING": return { title: "title_confirmed", body: "manual_enqueuing" };
    case "MANUAL_WAITING": return { title: "title_waiting", body: "manual_waiting" };
    case "SUCCESS": return topUp ? { title: "title_topup_success", body: "topup_success" } : { title: "title_success", body: "success" };
    case "FAILED": return { title: topUp ? "title_topup_failed" : "title_failed", body: "failed" };
    case "REVIEW": return { title: "title_review", body: "review" };
    case "CREDITED": return { title: "title_credited", body: "credited" };
    case "CANCELLED": return { title: "title_cancelled", body: "cancelled" };
  }
}

/** One persisted message per order. An initial send without an acknowledgement
 * cannot safely be retried: Telegram has no idempotent send API. */
export class FulfillmentMessageWorker {
  private readonly db: PrismaClient;
  private readonly now: () => Date;
  private readonly signal?: AbortSignal;
  constructor(private readonly api: FulfillmentTelegramApi, opts: { db?: PrismaClient; now?: () => Date; signal?: AbortSignal } = {}) {
    this.db = opts.db ?? prisma;
    this.now = opts.now ?? (() => new Date());
    this.signal = opts.signal;
  }

  async tick(): Promise<void> {
    const now = this.now();
    const stale = new Date(now.getTime() - LEASE_MS);
    const rows = await this.db.fulfillmentMessage.findMany({
      where: { nextUpdateAt: { lte: now }, OR: [
        { state: { in: POLLED_STATES }, claimedAt: null },
        { state: { in: ["SENDING", "EDITING"] }, claimedAt: { lte: stale } },
      ] }, include, take: 10, orderBy: [{ nextUpdateAt: "asc" }, { orderId: "asc" }],
    });
    for (const row of rows) {
      if (this.signal?.aborted) break;
      // A crash between sendMessage and saving its id has an unknown outcome.
      if (row.state === "SENDING") {
        await this.stopAndAlert(row, "UNCERTAIN", "Telegram status message send was interrupted; delivery is uncertain.");
        continue;
      }
      const initial = row.messageId === null;
      const claimedAt = this.now();
      const result = await this.db.fulfillmentMessage.updateMany({
        where: { orderId: row.orderId, state: row.state, claimedAt: row.claimedAt, nextUpdateAt: { lte: claimedAt } },
        data: { state: initial ? "SENDING" : "EDITING", claimedAt },
      });
      if (!result.count) continue;
      const claimed = { ...row, claimedAt, state: initial ? "SENDING" : "EDITING" };
      if (await this.deliver(claimed)) break; // Telegram flood control applies to the whole bot.
    }
  }

  /** Stop a message that can no longer be sent or edited safely. Only a
   * Digiflazz order pages the admins (its review alert); for manual and stock
   * orders the admin flow and the delivery DM are unaffected, so a blocked or
   * deleted chat is only logged. */
  private async stopAndAlert(row: MessageRow, state: "UNCERTAIN" | "STOPPED", reason: string): Promise<void> {
    const provider = fulfillmentProviderFor(row.order);
    await this.db.$transaction(async tx => {
      const updated = await tx.fulfillmentMessage.updateMany({
        where: { orderId: row.orderId, state: row.state, claimedAt: row.claimedAt },
        data: { state, claimedAt: null, finishedAt: this.now() },
      });
      if (updated.count && provider === "DIGIFLAZZ") await enqueueDigiflazzReviewAlert(tx, {
        orderId: row.orderId, orderCode: row.order.orderCode, reason, incident: "telegram_message",
      });
    });
    logger.warn(
      { orderId: row.orderId, state, provider },
      provider === "DIGIFLAZZ"
        ? `${reason} Order ${row.order.orderCode} was flagged for admin review.`
        : `${reason} Order ${row.order.orderCode} is a ${provider.toLowerCase()} order, so no admin alert was raised; its fulfilment continues without the progress message.`,
    );
  }

  /** WAITING is not polled, so a final transition that committed after this
   * worker read the order (its wake found the row still claimed) must not be
   * lost: re-read the order once the WAITING save is durable. */
  private async recheckWaiting(orderId: number): Promise<void> {
    const order = await this.db.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (order && !STILL_WAITING_STATUSES.has(order.status.toUpperCase())) {
      await wakeFulfillmentMessage(this.db, orderId, this.now());
    }
  }

  private async deliver(row: MessageRow): Promise<boolean> {
    // Re-read after acquiring the claim so a final callback wins over a stale frame.
    const order = await this.db.order.findUniqueOrThrow({ where: { id: row.orderId }, include: include.order.include });
    const credited = order.status.toUpperCase() === "CANCELLED"
      && !!(await this.db.walletTransaction.findFirst({ where: { orderId: order.id, reason: "unfulfilled_credit" }, select: { id: true } }));
    const progress = customerProgressPhase(order, { messageSent: row.messageId !== null, credited });
    const where = { orderId: row.orderId, state: row.state, claimedAt: row.claimedAt };
    const provider = fulfillmentProviderFor(order);
    // When the message entered the phase it now shows. A change of phase, in
    // either direction, starts the clock again.
    const phaseStartedAt = row.phase === progress.phase && row.phaseStartedAt ? row.phaseStartedAt : this.now();
    const phaseFields = { phase: progress.phase, phaseStartedAt };
    if (row.messageId === null && (progress.phase === "NONE" || progress.phase === "CANCELLED"
      || (progress.phase === "SUCCESS" && provider === "STOCK"))) {
      // Nothing to tell yet (payment never seen), the order ended before the
      // buyer heard anything, or a stock order was delivered instantly (its
      // credentials DM is the message): release the claim without sending.
      const finished = progress.phase !== "NONE";
      await this.db.fulfillmentMessage.updateMany({ where, data: {
        ...phaseFields, state: finished ? "FINISHED" : "READY", claimedAt: null, finishedAt: finished ? this.now() : null,
        nextUpdateAt: new Date(this.now().getTime() + INTERVAL_MS),
      } });
      return false;
    }
    if (progress.phase === "NONE") {
      // A sent message whose order fell back to awaiting payment (a detected
      // deposit was withdrawn): keep the last text rather than guess.
      await this.db.fulfillmentMessage.updateMany({ where, data: {
        ...phaseFields, state: "ACTIVE", claimedAt: null, nextUpdateAt: new Date(this.now().getTime() + IDLE_INTERVAL_MS),
      } });
      return false;
    }
    const lang = langCode(order.user.language);
    const keys = progressKeys({ ...progress, phase: progress.phase });
    const frame = FRAMES[Math.floor(this.now().getTime() / INTERVAL_MS) % FRAMES.length];
    const grouped = new Map<number, { name: string; quantity: number }>();
    for (const item of order.items) {
      const existing = grouped.get(item.productId);
      if (existing) existing.quantity += item.quantity;
      else grouped.set(item.productId, { name: item.product.name, quantity: item.quantity });
    }
    // Bound catalog text before escaping, leaving room below Telegram's 4096
    // character limit. Customer targets and delivered credentials stay private.
    const items = [...grouped.values()].slice(0, 6).map(item => `${escape(item.name.slice(0, 80))}${item.name.length > 80 ? "…" : ""} × ${item.quantity}`).join("\n");
    const summary = items ? `\n\n${items}${grouped.size > 6 ? "\n…" : ""}` : "";
    // Detected for too long: a static "still verifying" line on a slow re-read.
    // The order's state still decides; this only stops the animation.
    const slow = progress.phase === "PAYMENT_DETECTED" && this.now().getTime() - phaseStartedAt.getTime() >= DETECTED_SLOW_AFTER_MS;
    const body = t(`order.progress_${slow ? "detected_slow" : keys.body}`, lang);
    const title = t(`order.progress_${keys.title}`, lang);
    const orderLine = t("order.progress_order_line", lang, { code: escape(order.orderCode) });
    const text = `${title}\n${orderLine}${summary}\n\n${progress.spinner && !slow ? `${frame} ${body}` : body}`;
    const terminal = TERMINAL_PHASES.has(progress.phase);
    const state = progress.phase === "REVIEW" ? "REVIEW" : progress.phase === "MANUAL_WAITING" ? "WAITING" : terminal ? "FINISHED" : "ACTIVE";
    const interval = state === "REVIEW" ? REVIEW_INTERVAL_MS : slow ? DETECTED_SLOW_INTERVAL_MS : INTERVAL_MS;
    const data = { ...phaseFields, state, claimedAt: null, lastText: text, finishedAt: terminal ? this.now() : null,
      nextUpdateAt: new Date(this.now().getTime() + interval) };
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.signal?.addEventListener("abort", abort, { once: true });
    if (this.signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 20_000);
    // grammY types its signal with the abort-controller shim; native Node
    // signals implement the same runtime contract accepted by fetch.
    const apiSignal = controller.signal as unknown as NonNullable<Parameters<FulfillmentTelegramApi["sendMessage"]>[3]>;
    try {
      if (row.messageId === null) {
        const sent = await this.api.sendMessage(String(row.chatId), text, { parse_mode: "HTML" }, apiSignal);
        await this.db.fulfillmentMessage.updateMany({ where, data: { ...data, messageId: sent.message_id } });
      } else {
        if (row.lastText !== text) await this.api.editMessageText(String(row.chatId), row.messageId, text, { parse_mode: "HTML" }, apiSignal);
        await this.db.fulfillmentMessage.updateMany({ where, data });
      }
      if (state === "WAITING") await this.recheckWaiting(row.orderId);
      return false;
    } catch (error) {
      const e = error as { error_code?: number; description?: string; parameters?: { retry_after?: number } };
      if (e.error_code === 429) {
        const nextUpdateAt = new Date(this.now().getTime() + Math.max(1, e.parameters?.retry_after ?? 30) * 1000);
        await this.db.fulfillmentMessage.updateMany({ where, data: { state: row.messageId === null ? "READY" : "ACTIVE", claimedAt: null, nextUpdateAt } });
        // Durable global backoff also prevents another process draining ready rows.
        await this.db.fulfillmentMessage.updateMany({ where: { state: { in: POLLED_STATES }, nextUpdateAt: { lt: nextUpdateAt } }, data: { nextUpdateAt } });
        return true;
      }
      if (row.messageId !== null && e.error_code === 400 && e.description?.includes("message is not modified")) {
        await this.db.fulfillmentMessage.updateMany({ where, data });
        if (state === "WAITING") await this.recheckWaiting(row.orderId);
      } else if (e.error_code === 403 || e.error_code === 400) {
        await this.stopAndAlert(row, "STOPPED", "Telegram status message is unavailable; automatic replacement is disabled.");
      } else if (row.messageId === null) {
        await this.stopAndAlert(row, "UNCERTAIN", "Telegram status message delivery is uncertain; automatic resend is disabled.");
      } else {
        // Editing the same message is safe to retry after transport/database failure.
        await this.db.fulfillmentMessage.updateMany({ where, data: { state: "ACTIVE", claimedAt: null, nextUpdateAt: new Date(this.now().getTime() + 10_000) } });
        logger.warn({ orderId: row.orderId }, "Telegram fulfillment edit deferred");
      }
      return false;
    } finally {
      clearTimeout(timeout);
      this.signal?.removeEventListener("abort", abort);
    }
  }
}

function wait(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, INTERVAL_MS);
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runFulfillmentMessages(api: FulfillmentTelegramApi, signal: AbortSignal): Promise<void> {
  const worker = new FulfillmentMessageWorker(api, { signal });
  while (!signal.aborted) {
    try { await worker.tick(); }
    catch (err) { logger.error({ err }, "Telegram fulfillment message tick failed"); }
    await wait(signal);
  }
}
