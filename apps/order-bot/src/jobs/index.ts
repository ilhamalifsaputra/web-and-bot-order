/**
 * Background scheduled jobs — port of utils/jobs.py, scheduled via croner
 * (timezone-aware) instead of PTB's JobQueue. Each job takes the bot `Api` so
 * it can DM users/admins directly.
 *
 * Schedule (scheduleJobs): auto-cancel every minute, stale-ticket close hourly,
 * finance reconcile every 6h.
 */
import { Cron } from "croner";
import type { Api } from "grammy";
import { config, isBinanceInternalEnabled } from "@app/core/config";
import { langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  listExpiredPendingOrders,
  cancelOrder,
  listStaleRepliedTickets,
  closeTicket,
  reconcileFinances,
  logAdminAction,
  getBinancePollHealth,
  getBybitPollHealth,
  resolveBybitConfig,
  getSetting,
  setSetting,
  claimNextDueBroadcast,
  resolveSegmentRecipients,
  finishBroadcast,
  isBroadcastSegment,
  refreshUsdIdrRate,
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

// Watchdog: how long without a completed poll cycle counts as "stuck".
const POLL_STALE_MINUTES = 5;
const POLL_ALERT_KEY = "binance_poll_alert_sent";

/**
 * Pure decision for the poller watchdog (unit-tested without DB/env):
 *  - "none"    — healthy, intentionally backing off, or already alerted & still stale.
 *  - "alert"   — stale (no cycle in staleMs) and not yet alerted this episode.
 *  - "recover" — back to healthy after having alerted (re-arm the alert).
 */
export function pollWatchdogDecision(
  health: { lastRun: string | null; backoffUntil: string | null },
  alreadyAlerted: boolean,
  now = Date.now(),
  staleMs = POLL_STALE_MINUTES * 60_000,
): "none" | "alert" | "recover" {
  const backoff = health.backoffUntil ? Date.parse(health.backoffUntil) : 0;
  if (backoff > now) return "none"; // rate-limited on purpose, not stuck
  const lastRun = health.lastRun ? Date.parse(health.lastRun) : 0;
  const stale = now - lastRun > staleMs;
  if (stale && !alreadyAlerted) return "alert";
  if (!stale && alreadyAlerted) return "recover";
  return "none";
}

/**
 * Alert admins if the Binance poller looks stuck — no completed cycle in
 * POLL_STALE_MINUTES, while NOT intentionally backing off (rate-limit). Fires
 * once per stale episode (state in a setting) and re-arms on recovery, so admins
 * aren't spammed every tick.
 */
export async function binancePollWatchdog(api: Api): Promise<void> {
  if (!isBinanceInternalEnabled()) return;
  const health = await getBinancePollHealth(prisma);
  const alerted = (await getSetting(prisma, POLL_ALERT_KEY)) === "1";
  const decision = pollWatchdogDecision(health, alerted);

  if (decision === "alert") {
    const lastRun = health.lastRun ? Date.parse(health.lastRun) : 0;
    const mins = lastRun ? Math.round((Date.now() - lastRun) / 60_000) : "∞";
    logger.error(`Binance poller watchdog: no cycle in ${mins} min — alerting admins`);
    for (const adminId of config.ADMIN_IDS) {
      try {
        await api.sendMessage(
          adminId,
          `⚠️ <b>Binance poller looks STUCK</b>\nNo completed cycle in <b>${mins}</b> min. ` +
            `Auto-confirm is paused — check the order-bot process.`,
          { parse_mode: "HTML" },
        );
      } catch (err) {
        logger.error({ err }, `Failed to alert admin ${adminId} about stuck poller`);
      }
    }
    await setSetting(prisma, POLL_ALERT_KEY, "1");
  } else if (decision === "recover") {
    await setSetting(prisma, POLL_ALERT_KEY, "0");
    logger.info("Binance poller watchdog: poller recovered");
  }
}

const BYBIT_POLL_ALERT_KEY = "bybit_poll_alert_sent";

/** Bybit-deposit twin of binancePollWatchdog — same stale/recover logic on the
 * Bybit poller heartbeat, with its own alert-state key so the two pollers'
 * alerts never clobber each other. */
export async function bybitPollWatchdog(api: Api): Promise<void> {
  if (!(await resolveBybitConfig(prisma)).enabled) return;
  const health = await getBybitPollHealth(prisma);
  const alerted = (await getSetting(prisma, BYBIT_POLL_ALERT_KEY)) === "1";
  const decision = pollWatchdogDecision(health, alerted);

  if (decision === "alert") {
    const lastRun = health.lastRun ? Date.parse(health.lastRun) : 0;
    const mins = lastRun ? Math.round((Date.now() - lastRun) / 60_000) : "∞";
    logger.error(`Bybit poller watchdog: no cycle in ${mins} min — alerting admins`);
    for (const adminId of config.ADMIN_IDS) {
      try {
        await api.sendMessage(
          adminId,
          `⚠️ <b>Bybit deposit poller looks STUCK</b>\nNo completed cycle in <b>${mins}</b> min. ` +
            `Auto-confirm is paused — check the order-bot process.`,
          { parse_mode: "HTML" },
        );
      } catch (err) {
        logger.error({ err }, `Failed to alert admin ${adminId} about stuck Bybit poller`);
      }
    }
    await setSetting(prisma, BYBIT_POLL_ALERT_KEY, "1");
  } else if (decision === "recover") {
    await setSetting(prisma, BYBIT_POLL_ALERT_KEY, "0");
    logger.info("Bybit poller watchdog: poller recovered");
  }
}

// Throttle between broadcast DMs — stays under Telegram's ~30 msg/s bulk limit.
const BROADCAST_THROTTLE_MS = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drain ONE due broadcast queued by the web admin and DM the segment. This is
 * the bot half of the broadcast feature — the web only enqueues, it never calls
 * Telegram. One broadcast per tick; the SENDING status guards against overlap.
 */
export async function drainBroadcasts(api: Api): Promise<void> {
  const bc = await claimNextDueBroadcast(prisma, new Date());
  if (!bc) return;
  if (!isBroadcastSegment(bc.segment)) {
    logger.error(`Broadcast #${bc.id} has an unknown segment "${bc.segment}" — marking sent with 0`);
    await finishBroadcast(prisma, bc.id, { sent: 0, failed: 0, total: 0 });
    return;
  }

  const recipients = await resolveSegmentRecipients(prisma, bc.segment);
  logger.info(`Broadcast #${bc.id}: sending to ${recipients.length} (${bc.segment})`);
  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    try {
      // Plain text — the operator types raw content; no parse_mode so '<' / '&'
      // can't break the message.
      await api.sendMessage(Number(r.telegramId), bc.message);
      sent++;
    } catch {
      failed++; // user blocked the bot / deactivated — counted, not fatal
    }
    await sleep(BROADCAST_THROTTLE_MS);
  }
  await finishBroadcast(prisma, bc.id, { sent, failed, total: recipients.length });
  logger.info(`Broadcast #${bc.id} done: sent=${sent} failed=${failed}`);
}

/** Register all scheduled jobs against croner. Returns the Cron handles. */
/**
 * Keep `usd_idr_rate` tracking the live market rate (rounded — plan.md §15.8).
 * Scheduled SEPARATELY from scheduleJobs because it needs no bot Api and must
 * keep running even when the bot is off (web-only boot, §16.3). Kicks once
 * immediately so a fresh install gets a rate without waiting for the hour.
 */
export function scheduleFxRefresh(): Cron {
  const run = () =>
    refreshUsdIdrRate(prisma)
      .then((r) => {
        if (r.status === "disabled") logger.debug("FX auto-update is off (usd_idr_rate_auto=false)");
      })
      .catch((err) => logger.error({ err }, "Job refreshUsdIdrRate failed (previous rate stays)"));
  void run();
  return new Cron("5 * * * *", { protect: true }, run);
}

export function scheduleJobs(api: Api): Cron[] {
  const wrap = (name: string, fn: (api: Api) => Promise<void>) => () =>
    fn(api).catch((err) => logger.error({ err }, `Job ${name} failed`));
  return [
    new Cron("*/1 * * * *", wrap("autoCancelExpiredOrders", autoCancelExpiredOrders)),
    new Cron("0 * * * *", wrap("autoCloseStaleTickets", autoCloseStaleTickets)),
    new Cron("0 */6 * * *", wrap("reconcileFinancesJob", reconcileFinancesJob)),
    new Cron("*/2 * * * *", wrap("binancePollWatchdog", binancePollWatchdog)),
    new Cron("*/2 * * * *", wrap("bybitPollWatchdog", bybitPollWatchdog)),
    new Cron("*/1 * * * *", { protect: true }, wrap("drainBroadcasts", drainBroadcasts)),
  ];
}
