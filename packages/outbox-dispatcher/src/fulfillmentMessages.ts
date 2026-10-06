import type { Bot } from "grammy";
import type { Prisma } from "@prisma/client";
import { prisma, enqueueDigiflazzReviewAlert, type PrismaClient } from "@app/db";
import { getOrderFulfillment } from "@app/core/orderFulfillment";
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
const FRAMES = ["◐", "◓", "◑", "◒"];

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
        { state: { in: ["READY", "ACTIVE", "REVIEW"] }, claimedAt: null },
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

  private async stopAndAlert(row: MessageRow, state: "UNCERTAIN" | "STOPPED", reason: string): Promise<void> {
    await this.db.$transaction(async tx => {
      const updated = await tx.fulfillmentMessage.updateMany({
        where: { orderId: row.orderId, state: row.state, claimedAt: row.claimedAt },
        data: { state, claimedAt: null, finishedAt: this.now() },
      });
      if (updated.count) await enqueueDigiflazzReviewAlert(tx, {
        orderId: row.orderId, orderCode: row.order.orderCode, reason, incident: "telegram_message",
      });
    });
    logger.warn({ orderId: row.orderId, state }, reason);
  }

  private async deliver(row: MessageRow): Promise<boolean> {
    // Re-read after acquiring the claim so a final callback wins over a stale frame.
    const order = await this.db.order.findUniqueOrThrow({ where: { id: row.orderId }, include: include.order.include });
    const fulfillment = getOrderFulfillment(order);
    const status = fulfillment.status;
    const terminal = ["SUCCESS", "FAILED", "NEEDS_REVIEW", "CANCELLED"].includes(status);
    const lang = langCode(order.user.language);
    const key = status === "SUCCESS" ? "success" : status === "FAILED" ? "failed" : status === "NEEDS_REVIEW" ? "review" : status === "CANCELLED" ? "cancelled" : status === "SUBMITTING" ? "submitting" : status === "PROCESSING" ? "processing" : "queued";
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
    const text = `${t("order.fulfillment_header", lang, { code: escape(order.orderCode) })}${summary}\n\n${terminal ? (status === "SUCCESS" ? "✅" : status === "NEEDS_REVIEW" ? "⚠️" : "✕") : frame} ${t(`order.fulfillment_${key}`, lang)}`;
    const state = status === "NEEDS_REVIEW" ? "REVIEW" : terminal ? "FINISHED" : "ACTIVE";
    const data = { state, claimedAt: null, lastText: text, finishedAt: terminal ? this.now() : null,
      nextUpdateAt: new Date(this.now().getTime() + (state === "REVIEW" ? REVIEW_INTERVAL_MS : INTERVAL_MS)) };
    const where = { orderId: row.orderId, state: row.state, claimedAt: row.claimedAt };
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
      return false;
    } catch (error) {
      const e = error as { error_code?: number; description?: string; parameters?: { retry_after?: number } };
      if (e.error_code === 429) {
        const nextUpdateAt = new Date(this.now().getTime() + Math.max(1, e.parameters?.retry_after ?? 30) * 1000);
        await this.db.fulfillmentMessage.updateMany({ where, data: { state: row.messageId === null ? "READY" : "ACTIVE", claimedAt: null, nextUpdateAt } });
        // Durable global backoff also prevents another process draining ready rows.
        await this.db.fulfillmentMessage.updateMany({ where: { state: { in: ["READY", "ACTIVE", "REVIEW"] }, nextUpdateAt: { lt: nextUpdateAt } }, data: { nextUpdateAt } });
        return true;
      }
      if (row.messageId !== null && e.error_code === 400 && e.description?.includes("message is not modified")) {
        await this.db.fulfillmentMessage.updateMany({ where, data });
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
