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
import { adminIds } from "@app/core/runtime";
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
  getBybitBscPollHealth,
  resolveBinanceInternalConfig,
  resolveBybitConfig,
  resolveBybitBscConfig,
  getSetting,
  setSetting,
  claimNextDueBroadcast,
  resolveSegmentRecipients,
  finishBroadcast,
  isBroadcastSegment,
  refreshUsdIdrRate,
  listUnannouncedStartedFlashSales,
  enqueueFlashSaleBroadcast,
} from "@app/db";
import { flashPrice } from "@app/core/flash";
import { formatIdr } from "@app/core/formatters";
import { localize } from "@app/core/datetime";
import { coreT } from "../util/i18n";
import { notificationKb } from "../keyboards/customer";
import { esc } from "../util/format";
import { broadcastPhotoArg, cacheBroadcastPhotoFileId } from "../util/broadcastPhoto";

/**
 * Flip the anchored payment-instructions bubble (if any) to the auto-cancelled
 * notice in place — mirrors the reconcile pollers' success-bubble flip
 * (tokopayReconcile.editBubbleToSuccess): try caption edit first (QR photo
 * bubbles), fall back to text edit, and only send a fresh DM when no anchor
 * exists or the bubble is gone, so the stale Refresh/Cancel buttons never
 * survive next to a brand-new message.
 */
async function notifyAutoCancelled(
  api: Api,
  o: { tgId: bigint | null; lang: string; code: string; paymentMsgChatId: bigint | null; paymentMsgId: number | null },
): Promise<void> {
  const text = coreT("order.auto_cancelled", o.lang, { code: o.code });
  const markup = notificationKb(o.lang);
  if (o.paymentMsgChatId != null && o.paymentMsgId != null) {
    const chatId = Number(o.paymentMsgChatId);
    try {
      await api.editMessageCaption(chatId, o.paymentMsgId, { caption: text, parse_mode: "HTML", reply_markup: markup });
      return;
    } catch {
      try {
        await api.editMessageText(chatId, o.paymentMsgId, text, { parse_mode: "HTML", reply_markup: markup });
        return;
      } catch {
        /* bubble gone/uneditable — fall through to a fresh DM */
      }
    }
  }
  await api.sendMessage(Number(o.tgId), text, { parse_mode: "HTML", reply_markup: markup });
}

export async function autoCancelExpiredOrders(api: Api): Promise<void> {
  const now = new Date();
  const expired = await listExpiredPendingOrders(prisma, now);
  const orderData = expired.map((o) => ({
    id: o.id,
    code: o.orderCode,
    tgId: o.user.telegramId,
    lang: langCode(o.user.language),
    paymentMsgChatId: o.paymentMsgChatId,
    paymentMsgId: o.paymentMsgId,
  }));

  for (const o of orderData) {
    try {
      await prisma.$transaction((tx) => cancelOrder(tx, o.id, "expired"));
      logger.info(`Order ${o.code} auto-cancelled after its payment window expired`);
      try {
        await notifyAutoCancelled(api, o);
      } catch (err) {
        logger.error({ err }, `Failed to notify the customer that order ${o.id} was auto-cancelled — order is cancelled, but they won't see it until they reopen the bot`);
      }
    } catch (err) {
      logger.error({ err }, `Failed to auto-cancel expired order ${o.id} — order is still pending and will be retried next tick`);
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
    logger.info(`Support ticket #${ticket.id} (user ${ticket.userId}) auto-closed after 48h with no customer reply`);
    try {
      await api.sendMessage(
        Number(user.telegramId),
        coreT("ticket.auto_closed", langCode(user.language), { ticket_id: ticket.id }),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logger.error({ err }, `Failed to notify the customer that ticket #${ticket.id} was auto-closed — ticket is closed, but they won't see it until they reopen the bot`);
    }
  }
}

export async function reconcileFinancesJob(api: Api): Promise<void> {
  const findings = await reconcileFinances(prisma);
  const total =
    findings.order_drift.length + findings.voucher_drift.length + findings.negative_wallets.length;
  if (total === 0) {
    logger.info("Payment reconciliation finished — all checked orders matched, no drift found");
    return;
  }

  logger.warn(
    `Payment reconciliation found drift — ${findings.order_drift.length} order(s), ` +
      `${findings.voucher_drift.length} voucher(s), and ${findings.negative_wallets.length} negative wallet(s) ` +
      `need manual review (see audit log for details)`,
  );

  await logAdminAction(prisma, {
    adminId: null, // system action
    action: "reconcile_finances.drift",
    targetType: "system",
    targetId: null,
    details: `Reconciliation found drift: ${findings.order_drift.length} orders, ${findings.voucher_drift.length} vouchers, and ${findings.negative_wallets.length} negative wallets.`,
  });

  if (adminIds().length) {
    try {
      await api.sendMessage(
        adminIds()[0]!,
        "⚠ Reconciliation drift detected\n" +
          `orders: ${findings.order_drift.length}\n` +
          `vouchers: ${findings.voucher_drift.length}\n` +
          `negative wallets: ${findings.negative_wallets.length}\n` +
          "See audit log for full details.",
      );
    } catch (err) {
      logger.error({ err }, "Failed to DM the admin about reconciliation drift — drift is still recorded in the audit log, but no one was paged");
    }
  }
}

// Watchdog: how long without a completed poll cycle counts as "stuck".
const POLL_STALE_MINUTES = 5;
// A poller that keeps cycling but fails every time (e.g. the destination is
// network-blocked) refreshes `lastRun` forever and never trips the staleness
// check above — this catches that case too.
const FAILURE_STREAK_ALERT_THRESHOLD = 3;
const POLL_ALERT_KEY = "binance_poll_alert_sent";

/**
 * Pure decision for the poller watchdog (unit-tested without DB/env):
 *  - "none"    — healthy, intentionally backing off, or already alerted & still unhealthy.
 *  - "alert"   — stale (no cycle in staleMs) OR failing every cycle
 *                (consecutiveFailures ≥ failureThreshold), and not yet alerted this episode.
 *  - "recover" — back to healthy after having alerted (re-arm the alert).
 *
 * `consecutiveFailures` is optional so callers whose health type doesn't track
 * it (e.g. Binance, currently) keep the original stale-only behavior unchanged.
 */
export function pollWatchdogDecision(
  health: { lastRun: string | null; backoffUntil: string | null; consecutiveFailures?: number | null },
  alreadyAlerted: boolean,
  now = Date.now(),
  staleMs = POLL_STALE_MINUTES * 60_000,
  failureThreshold = FAILURE_STREAK_ALERT_THRESHOLD,
): "none" | "alert" | "recover" {
  const backoff = health.backoffUntil ? Date.parse(health.backoffUntil) : 0;
  if (backoff > now) return "none"; // rate-limited on purpose, not stuck
  const lastRun = health.lastRun ? Date.parse(health.lastRun) : 0;
  const stale = now - lastRun > staleMs;
  const failing = (health.consecutiveFailures ?? 0) >= failureThreshold;
  const unhealthy = stale || failing;
  if (unhealthy && !alreadyAlerted) return "alert";
  if (!unhealthy && alreadyAlerted) return "recover";
  return "none";
}

/**
 * Alert admins if the Binance poller looks unhealthy — either no completed
 * cycle in POLL_STALE_MINUTES, or a live cycle that's failing every single
 * time (consecutiveFailures past the threshold) — while NOT intentionally
 * backing off (rate-limit). Fires once per unhealthy episode (state in a
 * setting) and re-arms on recovery, so admins aren't spammed every tick.
 */
export async function binancePollWatchdog(api: Api): Promise<void> {
  if (!(await resolveBinanceInternalConfig(prisma)).enabled) return;
  const health = await getBinancePollHealth(prisma);
  const alerted = (await getSetting(prisma, POLL_ALERT_KEY)) === "1";
  const decision = pollWatchdogDecision(health, alerted);

  if (decision === "alert") {
    const lastRun = health.lastRun ? Date.parse(health.lastRun) : 0;
    const mins = lastRun ? Math.round((Date.now() - lastRun) / 60_000) : "∞";
    const failing = (health.consecutiveFailures ?? 0) >= FAILURE_STREAK_ALERT_THRESHOLD;
    const detail = failing
      ? `${health.consecutiveFailures} consecutive cycle(s) failed (last error: ${health.lastError ?? "unknown"})`
      : `no completed cycle in ${mins} min`;
    logger.error(`Binance poller looks unhealthy (${detail}) — alerting admins and pausing auto-confirm`);
    for (const adminId of adminIds()) {
      try {
        await api.sendMessage(
          adminId,
          `⚠️ <b>Binance poller looks unhealthy</b>\n${esc(detail)}. ` +
            `Auto-confirm is paused — check the order-bot process.`,
          { parse_mode: "HTML" },
        );
      } catch (err) {
        logger.error({ err }, `Failed to DM admin ${adminId} about the unhealthy Binance poller`);
      }
    }
    await setSetting(prisma, POLL_ALERT_KEY, "1");
  } else if (decision === "recover") {
    await setSetting(prisma, POLL_ALERT_KEY, "0");
    logger.info("Binance poller recovered — back to completing cycles normally, alert state cleared");
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
    const failing = (health.consecutiveFailures ?? 0) >= FAILURE_STREAK_ALERT_THRESHOLD;
    const detail = failing
      ? `${health.consecutiveFailures} consecutive cycle(s) failed (last error: ${health.lastError ?? "unknown"})`
      : `no completed cycle in ${mins} min`;
    logger.error(`Bybit deposit poller looks unhealthy (${detail}) — alerting admins and pausing auto-confirm`);
    for (const adminId of adminIds()) {
      try {
        await api.sendMessage(
          adminId,
          `⚠️ <b>Bybit deposit poller looks unhealthy</b>\n${esc(detail)}. ` +
            `Auto-confirm is paused — check the order-bot process.`,
          { parse_mode: "HTML" },
        );
      } catch (err) {
        logger.error({ err }, `Failed to DM admin ${adminId} about the unhealthy Bybit deposit poller`);
      }
    }
    await setSetting(prisma, BYBIT_POLL_ALERT_KEY, "1");
  } else if (decision === "recover") {
    await setSetting(prisma, BYBIT_POLL_ALERT_KEY, "0");
    logger.info("Bybit deposit poller recovered — back to completing cycles normally, alert state cleared");
  }
}

const BYBIT_BSC_POLL_ALERT_KEY = "bybit_bsc_poll_alert_sent";

/** Bybit-BSC twin of bybitPollWatchdog — same stale/recover logic on the
 * Bybit BSC on-chain poller's own heartbeat, with its own alert-state key so
 * the two Bybit pollers' alerts never clobber each other (they can fail for
 * unrelated reasons — on-chain network congestion vs. an API outage). */
export async function bybitBscPollWatchdog(api: Api): Promise<void> {
  if (!(await resolveBybitBscConfig(prisma)).enabled) return;
  const health = await getBybitBscPollHealth(prisma);
  const alerted = (await getSetting(prisma, BYBIT_BSC_POLL_ALERT_KEY)) === "1";
  const decision = pollWatchdogDecision(health, alerted);

  if (decision === "alert") {
    const lastRun = health.lastRun ? Date.parse(health.lastRun) : 0;
    const mins = lastRun ? Math.round((Date.now() - lastRun) / 60_000) : "∞";
    const failing = (health.consecutiveFailures ?? 0) >= FAILURE_STREAK_ALERT_THRESHOLD;
    const detail = failing
      ? `${health.consecutiveFailures} consecutive cycle(s) failed (last error: ${health.lastError ?? "unknown"})`
      : `no completed cycle in ${mins} min`;
    logger.error(`Bybit BSC deposit poller looks unhealthy (${detail}) — alerting admins and pausing auto-confirm`);
    for (const adminId of adminIds()) {
      try {
        await api.sendMessage(
          adminId,
          `⚠️ <b>Bybit BSC deposit poller looks unhealthy</b>\n${esc(detail)}. ` +
            `Auto-confirm is paused — check the order-bot process.`,
          { parse_mode: "HTML" },
        );
      } catch (err) {
        logger.error({ err }, `Failed to DM admin ${adminId} about the unhealthy Bybit BSC deposit poller`);
      }
    }
    await setSetting(prisma, BYBIT_BSC_POLL_ALERT_KEY, "1");
  } else if (decision === "recover") {
    await setSetting(prisma, BYBIT_BSC_POLL_ALERT_KEY, "0");
    logger.info("Bybit BSC deposit poller recovered — back to completing cycles normally, alert state cleared");
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
    logger.error(`Broadcast #${bc.id} has an unknown recipient segment "${bc.segment}" — skipping it and recording 0 sent/0 failed`);
    await finishBroadcast(prisma, bc.id, { sent: 0, failed: 0, total: 0 });
    return;
  }

  const recipients = await resolveSegmentRecipients(prisma, bc.segment);
  logger.info(`Broadcast #${bc.id} starting — sending to ${recipients.length} recipient(s) in segment "${bc.segment}"`);
  let sent = 0;
  let failed = 0;
  const photoArg = broadcastPhotoArg(bc);
  let cachedFileId = bc.imageFileId;
  const cacheFileId = cacheBroadcastPhotoFileId(bc.id);
  for (const r of recipients) {
    try {
      if (photoArg) {
        // No parse_mode on the caption either — same reasoning as the plain-text
        // branch below: the operator types raw content, unescaped.
        const photo = cachedFileId ?? photoArg.photo;
        const msg = await api.sendPhoto(Number(r.telegramId), photo, { caption: bc.message });
        if (!cachedFileId && photoArg.needsCache && msg.photo?.length) {
          cachedFileId = msg.photo[msg.photo.length - 1]!.file_id;
          await cacheFileId(cachedFileId);
        }
      } else {
        // Plain text — the operator types raw content; no parse_mode so '<' / '&'
        // can't break the message.
        await api.sendMessage(Number(r.telegramId), bc.message);
      }
      sent++;
    } catch {
      failed++; // user blocked the bot / deactivated — counted, not fatal
    }
    await sleep(BROADCAST_THROTTLE_MS);
  }
  await finishBroadcast(prisma, bc.id, { sent, failed, total: recipients.length });
  logger.info(`Broadcast #${bc.id} finished — sent to ${sent} recipient(s), ${failed} failed (blocked the bot or deactivated)`);
}

/**
 * Announce every scheduled flash sale whose window has just opened, once.
 *
 * An admin schedules a sale for a future time; nothing is sent then. This job
 * ticks every minute, picks up the sales that are now live and still carry
 * `flashAnnouncedAt = null`, and fans a DM out to the whole customer base
 * through the outbox (the bot never sends these itself either — the dispatcher
 * delivers them, throttled).
 *
 * The stamp and the enqueue share ONE short transaction, and the stamp is a
 * conditional `updateMany` on `flashAnnouncedAt` still being null: a crash
 * between them rolls both back (so the sale is simply announced on the next
 * tick), and a second worker — or an overlapping tick — that reaches the same
 * row finds count 0 and skips it. Neither ordering can therefore fan the same
 * sale out twice. Re-scheduling a SKU resets the stamp to null in
 * `setFlashSale`, which is what legitimately re-announces it.
 */
export async function announceStartedFlashSales(): Promise<void> {
  const started = await listUnannouncedStartedFlashSales(prisma);
  if (!started.length) return;
  let announced = 0;
  let recipients = 0;
  for (const denom of started) {
    const discounted = flashPrice(denom);
    const percent = denom.flashDiscountPercent;
    const endsAt = denom.flashEndsAt;
    if (discounted === null || percent == null || endsAt == null) {
      // activeFlashPercent rejected the row (a percent outside (0,100] written
      // before the write-time guard existed, or straight into the SQLite file
      // by hand). Announcing a sale we would not actually honour at checkout is
      // worse than staying quiet, so skip it and leave it for an admin to fix.
      logger.warn(`Flash sale on denomination ${denom.id} has an unusable discount percent — skipping its announcement; an admin should re-save the sale`);
      continue;
    }
    try {
      const sent = await prisma.$transaction(async (tx) => {
        const claimed = await tx.denomination.updateMany({
          where: { id: denom.id, flashAnnouncedAt: null },
          data: { flashAnnouncedAt: new Date() },
        });
        if (claimed.count !== 1) return null; // already announced elsewhere
        return enqueueFlashSaleBroadcast(tx, {
          productName: denom.product.name,
          denominationName: denom.name,
          discountPercent: percent.toString(),
          oldPrice: formatIdr(denom.price),
          newPrice: formatIdr(discounted),
          endsAt: localize(endsAt, "yyyy-LL-dd HH:mm ZZZZ"),
        });
      }, { timeout: 15000 });
      if (sent === null) continue;
      announced++;
      recipients += sent;
    } catch (err) {
      logger.error({ err }, `Failed to announce the flash sale on denomination ${denom.id} — nothing was enqueued and it stays unannounced, so it will be retried on the next tick`);
    }
  }
  if (announced > 0) {
    logger.info(`Announced ${announced} newly started flash sale(s) — queued ${recipients} customer direct message(s) for the outbox dispatcher to deliver`);
  }
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
      .catch((err) => logger.error({ err }, "Failed to refresh the USD/IDR exchange rate from the market — keeping the previous rate"));
  void run();
  return new Cron("5 * * * *", { protect: true }, run);
}

export function scheduleJobs(api: Api): Cron[] {
  const wrap = (name: string, fn: (api: Api) => Promise<void>) => () =>
    fn(api).catch((err) => logger.error({ err }, `Scheduled job "${name}" threw an uncaught error — this run was skipped, will retry on its next tick`));
  return [
    // { protect: true } (Bot-5 fix, security audit 2026-06-23): without it, a
    // slow tick (or a restart racing the next scheduled fire) can overlap
    // with itself and process the same expired-orders/stale-tickets set
    // twice, sending duplicate DMs — the exact gap drainBroadcasts below
    // already guards against.
    new Cron("*/1 * * * *", { protect: true }, wrap("autoCancelExpiredOrders", autoCancelExpiredOrders)),
    new Cron("0 * * * *", { protect: true }, wrap("autoCloseStaleTickets", autoCloseStaleTickets)),
    new Cron("0 */6 * * *", wrap("reconcileFinancesJob", reconcileFinancesJob)),
    new Cron("*/2 * * * *", wrap("binancePollWatchdog", binancePollWatchdog)),
    new Cron("*/2 * * * *", wrap("bybitPollWatchdog", bybitPollWatchdog)),
    new Cron("*/2 * * * *", wrap("bybitBscPollWatchdog", bybitBscPollWatchdog)),
    // Offset 20s/40s past the minute (croner's optional leading seconds field) so
    // these two don't fire in the same SQLite write-lock instant as
    // autoCancelExpiredOrders above — all three land on second 0 otherwise, and
    // one of them ends up waiting out the 5s busy_timeout (P1008/P2028 in
    // production, 2026-07-20).
    new Cron("20 * * * * *", { protect: true }, wrap("drainBroadcasts", drainBroadcasts)),
    new Cron("40 * * * * *", { protect: true }, wrap("announceStartedFlashSales", announceStartedFlashSales)),
  ];
}
