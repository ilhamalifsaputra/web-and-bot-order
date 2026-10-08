import type { Bot } from "grammy";
import type { Prisma } from "@prisma/client";
import { prisma, enqueueDigiflazzReviewAlert, findUnderpaidReceived, type PrismaClient } from "@app/db";
import { customerProgressPhase, fulfillmentProviderFor } from "@app/core/orderFulfillment";
import { formatIdrFor } from "@app/core/moneyFormat";
import { formatUsdt } from "@app/core/formatters";
import { t } from "@app/core/i18n";
import { langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { escape } from "./templates";
import { renderTransactionStatusMessage } from "./transactionMessage";

export type FulfillmentTelegramApi = Pick<Bot["api"], "sendMessage" | "editMessageText" | "editMessageCaption" | "deleteMessage" | "editMessageReplyMarkup">;
const include = { order: { include: { user: true, items: { include: { product: { include: { product: { include: { category: true } } } } } } } } } as const;
type MessageRow = Prisma.FulfillmentMessageGetPayload<{ include: typeof include }>;
const INTERVAL_MS = 2000;
const LEASE_MS = 60_000;
const REVIEW_INTERVAL_MS = 30_000;
/** Static waiting screens resume only when a canonical transition wakes them. */
const IDLE_INTERVAL_MS = 30_000;
/** A detected payment or confirmation can take a long time. After this long in
 * that one phase the spinner stops and the message is re-read only every
 * DETECTED_SLOW_INTERVAL_MS, until the order's state moves it to another phase. */
export const DETECTED_SLOW_AFTER_MS = 10 * 60_000;
const DETECTED_SLOW_INTERVAL_MS = 60_000;
const FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
/** Row states the worker polls. WAITING (a manual order's static wait) is not
 * one of them: `wakeFulfillmentMessage` moves it on when the order ends. */
const POLLED_STATES = ["READY", "ACTIVE", "REVIEW"];
const TERMINAL_PHASES: ReadonlySet<string> = new Set(["SUCCESS", "WALLET_CREDITED", "FAILED", "CANCELLED", "CREDITED"]);
/** Phases in which the payment is not verified yet, so a QR/invoice photo must
 * stay visible (its caption is edited). In any other phase the photo is
 * retired: one status text replaces it and the photo is deleted. */
const QR_LIVE_PHASES: ReadonlySet<string> = new Set(["NONE", "PAYMENT_DETECTED", "VERIFYING"]);
/** Phases whose status text offers the bot's existing Support entry. */
const SUPPORT_PHASES: ReadonlySet<string> = new Set(["UNDERPAID", "REVIEW", "FAILED", "CANCELLED"]);
/** Telegram's answer when editMessageText targets a photo/media message. */
const NO_TEXT_TO_EDIT = /there is no text in the message to edit/i;

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

  private keyboard(phase: string, kind: string, lang: string) {
    const menu = { text: t("menu.main", lang), callback_data: "v1:menu:main" };
    if (["SUCCESS", "WALLET_CREDITED", "CREDITED"].includes(phase)) {
      return { inline_keyboard: kind === "WALLET_TOPUP"
        ? [[{ text: t("transaction.wallet", lang), callback_data: "v1:wallet:view" }, menu]]
        : [[{ text: t("checkout.buy_again_btn", lang), callback_data: "v1:browse:prods" }], [{ text: t("order.all_history_btn", lang), callback_data: "v1:order:list" }, menu]] };
    }
    // The same entry as the Help Center's Support button (the support conversation).
    if (SUPPORT_PHASES.has(phase)) return { inline_keyboard: [[{ text: t("menu.support", lang), callback_data: "v1:support:open" }, menu]] };
    return { inline_keyboard: [[menu]] };
  }

  async tick(orderId?: number): Promise<void> {
    const now = this.now();
    const stale = new Date(now.getTime() - LEASE_MS);
    const rows = await this.db.fulfillmentMessage.findMany({
      where: { ...(orderId === undefined ? {} : { orderId }), nextUpdateAt: { lte: now }, OR: [
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

  /** Lock order matches status/credit writers: order, then message. No network
   * calls inside the transaction. If Telegram rendered a stale phase, persist
   * an immediately due correction together with its acknowledged message id;
   * a crash after commit needs no follow-up reread to make it recoverable. */
  private async saveProgress(row: MessageRow, data: Prisma.FulfillmentMessageUpdateManyMutationInput): Promise<void> {
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${row.orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: row.orderId }, include: include.order.include });
      const credited = order.status.toUpperCase() === "CANCELLED"
        && !!(await tx.walletTransaction.findFirst({ where: { orderId: order.id, reason: "unfulfilled_credit" }, select: { id: true } }));
      const messageSent = row.messageId !== null || typeof data.messageId === "number";
      const current = customerProgressPhase(order, { messageSent, credited });
      const correction = current.phase !== data.phase;
      await tx.fulfillmentMessage.updateMany({
        where: { orderId: row.orderId, state: row.state, claimedAt: row.claimedAt },
        data: { ...data, ...(correction ? {
          state: messageSent ? "ACTIVE" : "READY", finishedAt: null, nextUpdateAt: this.now(),
        } : {}) },
      });
    });
  }

  /** Best-effort cleanup of a QR photo once its status text replaced it. It
   * runs after the replacement is saved, is never retried and never throws:
   * a photo left in the chat must not hold up payment or fulfilment. When
   * Telegram refuses the delete (older than 48 hours, already gone, no
   * rights), only the photo's stale payment buttons are removed. */
  private async removeRetiredPhoto(row: MessageRow, photoId: number, signal: Parameters<FulfillmentTelegramApi["deleteMessage"]>[2]): Promise<void> {
    const chatId = String(row.chatId);
    try {
      await this.api.deleteMessage(chatId, photoId, signal);
      return;
    } catch (error) {
      const e = error as { error_code?: number; description?: string };
      if (e.error_code !== 400 && e.error_code !== 403) {
        logger.warn({ orderId: row.orderId, errorCode: e.error_code },
          e.error_code === 429
            ? "Telegram rate-limited deleting the replaced payment QR photo, so it stays in the chat; this cleanup is not retried."
            : "Deleting the replaced payment QR photo failed before Telegram answered, so it may stay in the chat; this cleanup is not retried.");
        return;
      }
      logger.info({ orderId: row.orderId, errorCode: e.error_code, description: e.description },
        "Telegram refused to delete the replaced payment QR photo, so its payment buttons are removed instead.");
    }
    try {
      await this.api.editMessageReplyMarkup(chatId, photoId, { reply_markup: { inline_keyboard: [] } }, signal);
    } catch (error) {
      const e = error as { error_code?: number; description?: string };
      logger.warn({ orderId: row.orderId, errorCode: e.error_code, description: e.description },
        "Removing the payment buttons from the replaced QR photo failed too; the photo keeps them, and the order is unaffected.");
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
      await this.saveProgress(row, {
        ...phaseFields, state: finished ? "FINISHED" : "READY", claimedAt: null, finishedAt: finished ? this.now() : null,
        nextUpdateAt: new Date(this.now().getTime() + INTERVAL_MS),
      });
      return false;
    }
    if (progress.phase === "NONE" && (row.lastText === null || row.phase === "NONE")) {
      // Keep the original transfer instructions while awaiting payment.
      await this.saveProgress(row, {
        ...phaseFields, state: "WAITING", claimedAt: null, nextUpdateAt: new Date(this.now().getTime() + IDLE_INTERVAL_MS),
      });
      return false;
    }
    const lang = langCode(order.user.language);
    const frame = FRAMES[Math.floor(this.now().getTime() / INTERVAL_MS) % FRAMES.length];
    const grouped = new Map<number, { name: string; quantity: number }>();
    for (const item of order.items) {
      const existing = grouped.get(item.productId);
      if (existing) existing.quantity += item.quantity;
      else grouped.set(item.productId, { name: item.product.name, quantity: item.quantity });
    }
    // Bound catalog text before escaping, leaving room below Telegram's 1024
    // character limit. Customer targets and delivered credentials stay private.
    const items = [...grouped.values()].slice(0, 3).map(item => `${escape(item.name.slice(0, 60))}${item.name.length > 60 ? "…" : ""} × ${item.quantity}`).join("\n");
    const summary = items ? `\n\n${items}${grouped.size > 3 ? "\n…" : ""}` : "";
    // Detected for too long: a static "still verifying" line on a slow re-read.
    // The order's state still decides; this only stops the animation.
    const slow = ["PAYMENT_DETECTED", "VERIFYING"].includes(progress.phase) && this.now().getTime() - phaseStartedAt.getTime() >= DETECTED_SLOW_AFTER_MS;
    const money = (value: Parameters<typeof formatUsdt>[0]) => order.currency === "USDT" ? formatUsdt(value) : formatIdrFor(value, lang);
    const walletCredit = progress.phase === "WALLET_CREDITED"
      ? await this.db.walletTransaction.findFirst({ where: { orderId: order.id, reason: "wallet_topup" }, select: { delta: true, balanceAfter: true } }) : null;
    const shortfall = progress.phase === "UNDERPAID" ? await findUnderpaidReceived(this.db, order.id) : null;
    const expected = progress.phase === "UNDERPAID" ? await this.db.qrisUnderpaidTx.findFirst({ where: { orderId: order.id }, select: { expectedAmount: true } }) : null;
    const text = renderTransactionStatusMessage({ orderCode: order.orderCode, presentation: progress, lang,
      frame: frame!, summary: summary.trim(), amount: money(walletCredit?.delta ?? order.totalAmount),
      balance: walletCredit ? money(walletCredit.balanceAfter) : undefined,
      underpayment: progress.phase === "UNDERPAID" ? { required: money(expected?.expectedAmount ?? order.totalAmount), received: shortfall ? money(shortfall) : null } : null, slow,
    });
    const terminal = TERMINAL_PHASES.has(progress.phase);
    const state = ["REVIEW", "UNDERPAID"].includes(progress.phase) ? "REVIEW" : progress.phase === "MANUAL_WAITING" ? "WAITING" : progress.phase === "NONE" ? "WAITING" : terminal ? "FINISHED" : "ACTIVE";
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
    const options = { parse_mode: "HTML" as const, reply_markup: this.keyboard(progress.phase, progress.transactionType, lang) };
    const qrLive = QR_LIVE_PHASES.has(progress.phase);
    // The lease this pass holds; retiring a photo upgrades it to SENDING.
    let claim: MessageRow = row;
    // What a legacy (kind unknown) message turned out to be on this pass.
    let learnedKind: "photo" | "text" | undefined;
    try {
      if (row.messageId === null) {
        const sent = await this.api.sendMessage(String(row.chatId), text, options, apiSignal);
        await this.saveProgress(row, { ...data, messageId: sent.message_id, messageKind: "text" });
        return false;
      }
      // A QR/invoice photo stays only while the payment is unverified. Never
      // call editMessageText on a known photo.
      let retire = row.messageKind === "photo" && !qrLive;
      if (!retire && row.lastText !== text) {
        if (row.messageKind === "photo") {
          await this.api.editMessageCaption(String(row.chatId), row.messageId, { ...options, caption: text }, apiSignal);
        } else {
          try {
            await this.api.editMessageText(String(row.chatId), row.messageId, text, options, apiSignal);
            if (row.messageKind !== "text") learnedKind = "text";
          } catch (error) {
            const e = error as { error_code?: number; description?: string };
            // Only Telegram's explicit photo response reveals a photo. A
            // timeout/429/5xx never deletes or replaces the canonical message.
            if (e.error_code !== 400 || !NO_TEXT_TO_EDIT.test(e.description ?? "")) throw error;
            learnedKind = "photo";
            if (qrLive) await this.api.editMessageCaption(String(row.chatId), row.messageId, { ...options, caption: text }, apiSignal);
            else retire = true;
          }
        }
      }
      if (!retire) {
        await this.saveProgress(row, { ...data, ...(learnedKind ? { messageKind: learnedKind } : {}) });
        return false;
      }
      // Claim the replacement exactly like an initial send: a crash between
      // sendMessage and saving its id leaves SENDING, which becomes UNCERTAIN
      // and is never resent.
      const upgraded = await this.db.fulfillmentMessage.updateMany({ where, data: { state: "SENDING" } });
      if (!upgraded.count) return false;
      claim = { ...row, state: "SENDING" };
      const sent = await this.api.sendMessage(String(row.chatId), text, options, apiSignal);
      await this.saveProgress(claim, { ...data, messageId: sent.message_id, messageKind: "text" });
      await this.removeRetiredPhoto(row, row.messageId, apiSignal);
      return false;
    } catch (error) {
      const e = error as { error_code?: number; description?: string; parameters?: { retry_after?: number } };
      const sending = claim.messageId === null || claim.state === "SENDING";
      const claimed = { orderId: claim.orderId, state: claim.state, claimedAt: claim.claimedAt };
      const kind = learnedKind ? { messageKind: learnedKind } : {};
      if (e.error_code === 429) {
        const nextUpdateAt = new Date(this.now().getTime() + Math.max(1, e.parameters?.retry_after ?? 30) * 1000);
        await this.db.fulfillmentMessage.updateMany({ where: claimed, data: { ...kind, state: row.messageId === null ? "READY" : "ACTIVE", claimedAt: null, nextUpdateAt } });
        // Durable global backoff also prevents another process draining ready rows.
        await this.db.fulfillmentMessage.updateMany({ where: { state: { in: POLLED_STATES }, nextUpdateAt: { lt: nextUpdateAt } }, data: { nextUpdateAt } });
        return true;
      }
      if (!sending && e.error_code === 400 && e.description?.includes("message is not modified")) {
        await this.saveProgress(claim, { ...data, ...kind });
      } else if (e.error_code === 403 || e.error_code === 400) {
        await this.stopAndAlert(claim, "STOPPED", "Telegram status message is unavailable; automatic replacement is disabled.");
      } else if (sending) {
        await this.stopAndAlert(claim, "UNCERTAIN", "Telegram status message delivery is uncertain; automatic resend is disabled.");
      } else {
        // Editing the same message is safe to retry after transport/database failure.
        await this.db.fulfillmentMessage.updateMany({ where: claimed, data: { ...kind, state: "ACTIVE", claimedAt: null, nextUpdateAt: new Date(this.now().getTime() + 10_000) } });
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
