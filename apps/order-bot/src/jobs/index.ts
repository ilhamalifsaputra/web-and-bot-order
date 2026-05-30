/**
 * Background scheduled jobs — port of utils/jobs.py, scheduled via croner
 * (timezone-aware) instead of PTB's JobQueue. Each job takes the bot `Api` so
 * it can DM users/admins directly.
 *
 * Schedule (scheduleJobs): auto-cancel every minute, stale-ticket close hourly,
 * finance reconcile every 6h, warranty reminders daily at 09:00 config.TIMEZONE.
 */
import { Cron } from "croner";
import type { Api } from "grammy";
import { config } from "@app/core/config";
import { langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  listExpiredPendingOrders,
  cancelOrder,
  listStaleRepliedTickets,
  closeTicket,
  reconcileFinances,
  listOrderItemsExpiringWarranty,
  logAdminAction,
} from "@app/db";
import { coreT } from "../util/i18n";
import { notificationKb } from "../keyboards/customer";

export async function autoCancelExpiredOrders(api: Api): Promise<void> {
  const now = new Date();
  const expired = await listExpiredPendingOrders(prisma, now);
  const orderData = expired.map((o) => ({
    id: o.id,
    code: o.orderCode,
    tgId: o.user.telegramId,
    lang: langCode(o.user.language),
  }));

  for (const o of orderData) {
    try {
      await prisma.$transaction((tx) => cancelOrder(tx, o.id, "expired"));
      logger.info(`Auto-cancelled expired order ${o.code}`);
      try {
        await api.sendMessage(Number(o.tgId), coreT("order.auto_cancelled", o.lang, { code: o.code }), {
          parse_mode: "HTML",
          reply_markup: notificationKb(o.lang),
        });
      } catch (err) {
        logger.error({ err }, `Failed to notify user about expired order ${o.id}`);
      }
    } catch (err) {
      logger.error({ err }, `Failed to cancel expired order ${o.id}`);
    }
  }
}

export async function autoCloseStaleTickets(api: Api): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 3_600_000);
  const stale = await listStaleRepliedTickets(prisma, cutoff);
  for (const ticket of stale) {
    const user = await prisma.user.findUnique({ where: { id: ticket.userId } });
    if (user === null) continue;
    await closeTicket(prisma, ticket.id);
    logger.info(`Auto-closed stale ticket #${ticket.id} (user_id=${ticket.userId})`);
    try {
      await api.sendMessage(
        Number(user.telegramId),
        coreT("ticket.auto_closed", langCode(user.language), { ticket_id: ticket.id }),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logger.error({ err }, `Failed to notify user about auto-closed ticket #${ticket.id}`);
    }
  }
}

export async function reconcileFinancesJob(api: Api): Promise<void> {
  const findings = await reconcileFinances(prisma);
  const total =
    findings.order_drift.length + findings.voucher_drift.length + findings.negative_wallets.length;
  if (total === 0) {
    logger.info("Reconciliation: clean (no drift)");
    return;
  }

  logger.warn(
    `Reconciliation FOUND DRIFT: orders=${findings.order_drift.length} ` +
      `vouchers=${findings.voucher_drift.length} negative_wallets=${findings.negative_wallets.length}`,
  );

  await logAdminAction(prisma, {
    adminId: null, // system action
    action: "reconcile_finances.drift",
    targetType: "system",
    targetId: null,
    details: JSON.stringify(findings).slice(0, 4000),
  });

  if (config.ADMIN_IDS.length) {
    try {
      await api.sendMessage(
        config.ADMIN_IDS[0]!,
        "⚠ Reconciliation drift detected\n" +
          `orders: ${findings.order_drift.length}\n` +
          `vouchers: ${findings.voucher_drift.length}\n` +
          `negative wallets: ${findings.negative_wallets.length}\n` +
          "See audit log for full details.",
      );
    } catch (err) {
      logger.error({ err }, "Failed to alert admin about reconciliation drift");
    }
  }
}

export async function sendWarrantyReminders(api: Api): Promise<void> {
  const now = Date.now();
  const start = new Date(now + (2 * 24 * 60 + 23 * 60) * 60_000); // +2d23h
  const end = new Date(now + (3 * 24 * 60 + 60) * 60_000); // +3d1h
  const items = await listOrderItemsExpiringWarranty(prisma, start, end);
  for (const item of items) {
    const lang = langCode(item.order.user.language);
    try {
      await api.sendMessage(
        Number(item.order.user.telegramId),
        coreT("order.warranty_reminder", lang, { product: item.product.name, code: item.order.orderCode }),
        { parse_mode: "HTML", reply_markup: notificationKb(lang) },
      );
    } catch (err) {
      logger.error({ err }, `Failed to send warranty reminder for item ${item.id}`);
    }
  }
}

/** Register all four jobs against croner. Returns the Cron handles. */
export function scheduleJobs(api: Api): Cron[] {
  const wrap = (name: string, fn: (api: Api) => Promise<void>) => () =>
    fn(api).catch((err) => logger.error({ err }, `Job ${name} failed`));
  return [
    new Cron("*/1 * * * *", wrap("autoCancelExpiredOrders", autoCancelExpiredOrders)),
    new Cron("0 * * * *", wrap("autoCloseStaleTickets", autoCloseStaleTickets)),
    new Cron("0 */6 * * *", wrap("reconcileFinancesJob", reconcileFinancesJob)),
    new Cron("0 9 * * *", { timezone: config.TIMEZONE }, wrap("sendWarrantyReminders", sendWarrantyReminders)),
  ];
}
