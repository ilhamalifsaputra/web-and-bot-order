/**
 * Background scheduled jobs — port of utils/jobs.py, scheduled via croner
 * (timezone-aware) instead of PTB's JobQueue. Each job takes the bot `Api` so
 * it can DM users/admins directly.
 *
 * Schedule (scheduleJobs): auto-cancel every minute, stale-ticket close hourly,
 * finance reconcile every 6h.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cron } from "croner";
import { GrammyError, type Api, type InlineKeyboard } from "grammy";
import { adminIds } from "@app/core/runtime";
import { langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  listExpiredPendingOrders,
  cancelOrder,
  listStaleRepliedTickets,
  closeTicket,
  getUser,
  reconcileFinances,
  logAdminAction,
  getBinancePollHealth,
  getBybitPollHealth,
  getBybitBscPollHealth,
  getPollHealth,
  resolveBinanceInternalConfig,
  resolveBybitConfig,
  resolveBybitBscConfig,
  getTokopayCreds,
  getPaydisiniCreds,
  getNowpaymentsCreds,
  getSetting,
  setSetting,
  claimNextDueBroadcast,
  resolveSegmentRecipients,
  finishBroadcast,
  updateBroadcastProgress,
  isBroadcastSegment,
  reapStaleBroadcasts,
  BROADCAST_STALE_CLAIM_MS,
  failBroadcast,
  refreshUsdIdrRate,
  listUnannouncedStartedFlashSales,
  enqueueFlashSaleBroadcast,
  runStorageCleanup,
} from "@app/db";
import { flashPrice } from "@app/core/flash";
import { formatIdr } from "@app/core/formatters";
import { localize } from "@app/core/datetime";
import { evaluatePollHealth, type PollHeartbeat } from "@app/core/payments/pollHealth";
import {
  TOKOPAY_POLL_STALE_MS,
  PAYDISINI_POLL_STALE_MS,
  NOWPAYMENTS_POLL_STALE_MS,
} from "@app/core/payments/reconcileCycleBudget";
import { coreT } from "../util/i18n";
import { notificationKb } from "../keyboards/customer";
import { esc } from "../util/format";
import { broadcastPhotoArg, cacheBroadcastPhotoFileId } from "../util/broadcastPhoto";

/** What `editPaymentBubble` actually did, so the caller can tell a successful
 * edit apart from a failed one instead of guessing from side effects:
 *  - "edited"     — the bubble itself was updated in place (`via` says which
 *                    grammY call worked: "caption" for a photo/QR bubble,
 *                    "text" for a text-fallback bubble).
 *  - "dm_sent"    — the bubble could not be edited, but the fallback DM
 *                    (when the caller opted in) was sent instead.
 *  - "not_edited" — the bubble could not be edited and no fallback DM was
 *                    sent, either because the caller opted out (`fallbackDm:
 *                    null`) or because the DM itself failed too — `error`
 *                    carries that DM failure (unset in the opted-out case)
 *                    so a caller that needs the original propagated (like
 *                    `notifyAutoCancelled` below, preserving its pre-refactor
 *                    behavior) doesn't have to re-attempt the send just to
 *                    get it. */
export type BubbleEditResult =
  | { status: "edited"; via: "caption" | "text" }
  | { status: "dm_sent" }
  | { status: "not_edited"; error?: unknown };

/**
 * Edit an anchored payment/notification bubble in place: try `editMessageCaption`
 * first (photo/QR bubbles), fall back to `editMessageText` (text bubbles).
 * Extracted from `notifyAutoCancelled`'s original inline try/caption/text chain
 * (Task T2-C) so the upcoming generic bubble-flip sweeper can share it.
 *
 * `fallbackDm` makes the two calling modes explicit at the call site instead
 * of being an implicit side effect: `notifyAutoCancelled` below passes a
 * target so a buyer whose bubble is gone still gets the news as a DM (its
 * existing, unchanged behavior); the sweeper's own bubble-flip pass will
 * pass `null` — those buyers already received the account/top-up DM through
 * the normal delivery path, so a second DM here would only be noise.
 *
 * Never throws: every grammY call (including the fallback DM) is caught, so
 * a stale/uneditable bubble or a blocked/deactivated recipient degrades to a
 * reported outcome instead of an exception the caller must remember to guard.
 */
export async function editPaymentBubble(
  api: Api,
  args: {
    chatId: number;
    messageId: number;
    text: string;
    markup: InlineKeyboard;
    /** Telegram id to DM as a fallback when the bubble can't be edited. Pass
     * `null` to skip the DM entirely and just report the edit failed. */
    fallbackDm: { telegramId: number } | null;
  },
): Promise<BubbleEditResult> {
  try {
    await api.editMessageCaption(args.chatId, args.messageId, { caption: args.text, parse_mode: "HTML", reply_markup: args.markup });
    return { status: "edited", via: "caption" };
  } catch {
    try {
      await api.editMessageText(args.chatId, args.messageId, args.text, { parse_mode: "HTML", reply_markup: args.markup });
      return { status: "edited", via: "text" };
    } catch {
      // Bubble gone/uneditable.
      if (args.fallbackDm == null) return { status: "not_edited" };
      try {
        await api.sendMessage(args.fallbackDm.telegramId, args.text, { parse_mode: "HTML", reply_markup: args.markup });
        return { status: "dm_sent" };
      } catch (error) {
        return { status: "not_edited", error };
      }
    }
  }
}

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
    const result = await editPaymentBubble(api, {
      chatId: Number(o.paymentMsgChatId),
      messageId: o.paymentMsgId,
      text,
      markup,
      fallbackDm: { telegramId: Number(o.tgId) },
    });
    // "error" only appears once a fallback DM was actually attempted (never
    // for the sweeper's fallbackDm: null mode) — re-throwing it here
    // reproduces the pre-refactor behavior exactly: a failed fallback send
    // used to propagate out of this function uncaught, so
    // autoCancelExpiredOrders' own try/catch would log "Failed to notify the
    // customer...". Not re-attempting the send avoids DMing the buyer twice.
    if (result.status === "not_edited" && "error" in result) throw result.error;
    return;
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
    try {
      const user = await getUser(prisma, ticket.userId);
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
    } catch (err) {
      logger.error({ err }, `Failed to auto-close stale support ticket #${ticket.id} — ticket is still open and will be retried next tick`);
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

// Watchdog: how long without a completed poll cycle counts as "stuck" for
// the three crypto rails (Binance / Bybit / Bybit BSC). Their poll interval
// is ~10s and one cycle does a single bounded lookup, so 5 minutes without a
// completed cycle is already a generous multiple of their normal cadence — a
// cycle that slow IS a hang.
const POLL_STALE_MINUTES = 5;
// A poller that keeps cycling but fails every time (e.g. the destination is
// network-blocked) refreshes `lastRun` forever and never trips the staleness
// check above — this catches that case too.
const FAILURE_STREAK_ALERT_THRESHOLD = 3;
const POLL_ALERT_KEY = "binance_poll_alert_sent";
const BYBIT_POLL_ALERT_KEY = "bybit_poll_alert_sent";
const BYBIT_BSC_POLL_ALERT_KEY = "bybit_bsc_poll_alert_sent";
const TOKOPAY_POLL_ALERT_KEY = "tokopay_poll_alert_sent";
const PAYDISINI_POLL_ALERT_KEY = "paydisini_poll_alert_sent";
const NOWPAYMENTS_POLL_ALERT_KEY = "nowpayments_poll_alert_sent";

// QRIS/IDR rails' own staleness thresholds (Task 12) — TOKOPAY_POLL_STALE_MS,
// PAYDISINI_POLL_STALE_MS, and NOWPAYMENTS_POLL_STALE_MS now live in
// packages/core/src/payments/reconcileCycleBudget.ts (Task 13 review
// follow-up: apps/web-admin cannot import from apps/order-bot, so as long as
// these lived only here, the web-admin dashboard's Business Health card had
// no way to read a QRIS rail's real staleness threshold and silently fell
// back to evaluatePollHealth's 5-minute default meant for the crypto rails
// below — the same "three consumers, three different rules" divergence this
// branch's P1 fixed, reappearing at the seam between this watchdog and the
// dashboard). Imported above so this file and
// apps/web-admin/src/routes/api/dashboard.ts read the exact same numbers;
// see that module for the full derivation (why the margin tracks
// POLL_INTERVAL_SECONDS, why it does not re-add cycleTimeoutMs's own
// margin). Re-exported under their original names so existing imports
// (jobs.test.ts) keep working unchanged.
export { TOKOPAY_POLL_STALE_MS, PAYDISINI_POLL_STALE_MS, NOWPAYMENTS_POLL_STALE_MS };

/**
 * Pure decision for the poller watchdog (unit-tested without DB/env):
 *  - "none"    — healthy, intentionally backing off (regardless of alert
 *                state — see the backoff short-circuit below), or already
 *                alerted & still unhealthy for a reason other than backoff.
 *  - "alert"   — stale (no cycle in staleMs) OR failing every cycle
 *                (consecutiveFailures ≥ failureThreshold), and not yet alerted this episode.
 *  - "recover" — back to healthy after having alerted (re-arm the alert).
 *
 * `consecutiveFailures` is optional so callers whose health type doesn't track
 * it (e.g. Binance, currently) keep the original stale-only behavior unchanged.
 *
 * Delegates the actual unhealthy/healthy call to `evaluatePollHealth`
 * (packages/core/src/payments/pollHealth.ts) for the "alert" side of the
 * decision — its `paging` flag reproduces this function's original
 * stale/failing rule. The "recover" side needs one deliberate override on
 * top of `paging`, below: `evaluatePollHealth`'s `paging: false` during a
 * live backoff is correct for THAT module's consumers (the dashboard tile,
 * PaymentsPage — a live backoff genuinely isn't a paging condition for them),
 * but naively folding it into `!paging && alreadyAlerted` here would read a
 * live backoff as "recovered" and clear an alert flag set by a real,
 * still-ongoing outage (followup review fix — a rail that got hard-paged,
 * then hit a rate limit while STILL down, must not have its alert silently
 * cleared just because the rate limit is being backed off from on purpose;
 * every admin would get DM'd again once the backoff window ends and the rail
 * is still down). `enabled: true` is the truthful state here, not a
 * placeholder: every call site (binancePollWatchdog and its two twins)
 * already returns early while its rail is disabled, so this function only
 * ever runs for a rail that is enabled.
 */
export function pollWatchdogDecision(
  health: { lastRun: string | null; backoffUntil: string | null; consecutiveFailures?: number | null },
  alreadyAlerted: boolean,
  now = Date.now(),
  staleMs = POLL_STALE_MINUTES * 60_000,
  failureThreshold = FAILURE_STREAK_ALERT_THRESHOLD,
): "none" | "alert" | "recover" {
  // Unconditional, checked BEFORE the alerted comparison: a live (not yet
  // expired) backoff always yields "none", regardless of alert state. This
  // is the pre-rewrite body's original short-circuit (`if (backoff > now)
  // return "none"`), restored here specifically because it must win over
  // "already alerted" too — see the doc-comment above for the duplicate-
  // paging regression this prevents.
  const backoffUntil = health.backoffUntil ? Date.parse(health.backoffUntil) : NaN;
  if (!Number.isNaN(backoffUntil) && backoffUntil > now) return "none";

  const { paging } = evaluatePollHealth(
    {
      lastRun: health.lastRun,
      lastSuccessAt: null,
      backoffUntil: health.backoffUntil,
      consecutiveFailures: health.consecutiveFailures ?? null,
    },
    { enabled: true, now, staleMs, failureThreshold },
  );
  if (paging && !alreadyAlerted) return "alert";
  if (!paging && alreadyAlerted) return "recover";
  return "none";
}

/** What differs between one rail's watchdog and another's — everything else
 * (the alert/recover decision, the DM loop, the M-26 flag-write ordering) is
 * identical and lives once in `pollWatchdog` below (Task 12). */
interface PollWatchdogRail {
  /** Used verbatim in the "looks unhealthy" / "recovered" log lines and the
   * admin DM title, e.g. "Binance poller", "TokoPay reconcile poller". */
  label: string;
  /** Settings key holding "1" while this rail's current unhealthy episode
   * has already paged admins (cleared back to "0" on recovery). */
  alertKey: string;
  /** Whether this rail is turned on at all — the watchdog returns early
   * (no read, no page) while it's not, exactly like each original
   * per-rail watchdog did. */
  isEnabled: () => Promise<boolean>;
  readHealth: () => Promise<PollHeartbeat>;
  /** Defaults to POLL_STALE_MINUTES * 60_000. The QRIS rails pass their own,
   * wider value — see QRIS_STALE_MARGIN_MS above for why. */
  staleMs?: number;
  /** Admin-facing sentence appended to both the DM and the developer log line
   * describing what this rail's poller dying actually means operationally.
   * Defaults to DEFAULT_POLLER_IMPACT below, which is only true for the three
   * crypto rails: their poller IS the sole auto-confirm path, so its death
   * really does pause auto-confirm. That default is FALSE for the three QRIS
   * rails — the storefront webhook is their primary delivery path and keeps
   * running independently of this poller (tokopayReconcile.ts's module doc
   * comment) — so tokopayPollWatchdog and its two twins below override this
   * with QRIS_POLLER_IMPACT instead. Telling a QRIS admin "auto-confirm is
   * paused" here would be false and could send them off manually
   * confirming/refunding orders the webhook is already delivering fine. */
  impact?: string;
}

/** Default `impact` — true for the three crypto rails only (Binance, Bybit,
 * Bybit BSC): each one's poller is the ONLY auto-confirm path, so it dying
 * really does pause auto-confirm. See `PollWatchdogRail.impact` above. */
const DEFAULT_POLLER_IMPACT = "Auto-confirm is paused — check the order-bot process.";

/** `impact` override for the three QRIS/IDR rails (TokoPay, PayDisini,
 * NOWPayments) — see `PollWatchdogRail.impact` above for why the crypto
 * default would be false here. */
const QRIS_POLLER_IMPACT =
  "Auto-confirm is NOT paused — payments are still being delivered via the payment gateway's webhook as usual. " +
  "This backup checker has stopped though, so check the order-bot process when you can.";

/**
 * Alert admins if a payment poller looks unhealthy — either no completed
 * cycle within its staleness window, or a live cycle that's failing every
 * single time (consecutiveFailures past the threshold) — while NOT
 * intentionally backing off (rate-limit). Fires once per unhealthy episode
 * (state in the setting named by `rail.alertKey`) and re-arms on recovery,
 * so admins aren't spammed every tick.
 *
 * Shared by all six rails (Task 12) — `binancePollWatchdog`,
 * `bybitPollWatchdog`, `bybitBscPollWatchdog`, `tokopayPollWatchdog`,
 * `paydisiniPollWatchdog` and `nowpaymentsPollWatchdog` below are thin
 * wrappers that supply what differs (see `PollWatchdogRail` above) and are
 * kept as separate named exports so the cron registrations and existing
 * tests keep compiling unchanged.
 */
async function pollWatchdog(api: Api, rail: PollWatchdogRail): Promise<void> {
  if (!(await rail.isEnabled())) return;
  const health = await rail.readHealth();
  const alerted = (await getSetting(prisma, rail.alertKey)) === "1";
  const now = Date.now();
  const staleMs = rail.staleMs ?? POLL_STALE_MINUTES * 60_000;
  const decision = pollWatchdogDecision(health, alerted, now, staleMs);

  if (decision === "alert") {
    const { detail } = evaluatePollHealth(health, {
      enabled: true,
      now,
      staleMs,
      failureThreshold: FAILURE_STREAK_ALERT_THRESHOLD,
    });
    const impact = rail.impact ?? DEFAULT_POLLER_IMPACT;
    logger.error(`${rail.label} looks unhealthy: ${detail} Alerting admins. ${impact}`);
    // Flag flips BEFORE the DM loop, not after (M-26 fix, backend audit
    // 2026-07-31): the loop below awaits Telegram per admin, so writing the
    // flag only once every DM was sent left a window where a crash mid-loop
    // (or an overlapping tick, now also closed by `protect: true` on this
    // job's registration) left the flag unset and re-triggered a full
    // re-alert storm on the next run. Writing it first trades that storm for
    // a narrower failure mode: a crash mid-loop can now leave some admins
    // unpaged for this incident instead of everyone being paged repeatedly —
    // each DM failure below is still caught and logged individually, so a
    // single blocked/deactivated admin never aborts the rest of the loop.
    await setSetting(prisma, rail.alertKey, "1");
    for (const adminId of adminIds()) {
      try {
        await api.sendMessage(
          adminId,
          `⚠️ <b>${rail.label} looks unhealthy</b>\n${esc(detail)} ${esc(impact)}`,
          { parse_mode: "HTML" },
        );
      } catch (err) {
        logger.error({ err }, `Failed to DM admin ${adminId} about the unhealthy ${rail.label}`);
      }
    }
  } else if (decision === "recover") {
    await setSetting(prisma, rail.alertKey, "0");
    logger.info(`${rail.label} recovered — back to completing cycles normally, alert state cleared`);
  }
}

/** Alert admins if the Binance poller looks unhealthy — see `pollWatchdog`
 * above for the actual stale/failing/recover logic. */
export function binancePollWatchdog(api: Api): Promise<void> {
  return pollWatchdog(api, {
    label: "Binance poller",
    alertKey: POLL_ALERT_KEY,
    isEnabled: async () => (await resolveBinanceInternalConfig(prisma)).enabled,
    readHealth: () => getBinancePollHealth(prisma),
  });
}

/** Bybit-deposit twin of binancePollWatchdog — same stale/recover logic on the
 * Bybit poller heartbeat, with its own alert-state key so the two pollers'
 * alerts never clobber each other. */
export function bybitPollWatchdog(api: Api): Promise<void> {
  return pollWatchdog(api, {
    label: "Bybit deposit poller",
    alertKey: BYBIT_POLL_ALERT_KEY,
    isEnabled: async () => (await resolveBybitConfig(prisma)).enabled,
    readHealth: () => getBybitPollHealth(prisma),
  });
}

/** Bybit-BSC twin of bybitPollWatchdog — same stale/recover logic on the
 * Bybit BSC on-chain poller's own heartbeat, with its own alert-state key so
 * the two Bybit pollers' alerts never clobber each other (they can fail for
 * unrelated reasons — on-chain network congestion vs. an API outage). */
export function bybitBscPollWatchdog(api: Api): Promise<void> {
  return pollWatchdog(api, {
    label: "Bybit BSC deposit poller",
    alertKey: BYBIT_BSC_POLL_ALERT_KEY,
    isEnabled: async () => (await resolveBybitBscConfig(prisma)).enabled,
    readHealth: () => getBybitBscPollHealth(prisma),
  });
}

/**
 * TokoPay twin (Task 12) — same stale/failing/recover logic over the TokoPay
 * reconcile poller's heartbeat (docs/TROUBLESHOOTING.md's "webhook gateway
 * tidak pernah sampai" scenario: this is what pages admins and turns
 * Business Health red when that happens). Gated on TokoPay credentials being
 * configured — the same gate tokopayReconcile.ts's own poller uses — so a
 * shop that has never turned TokoPay on never gets paged for it. Uses a
 * wider staleMs than the crypto rails; see QRIS_STALE_MARGIN_MS above for
 * why a legitimately slow (not hung) cycle must not trip this.
 */
export function tokopayPollWatchdog(api: Api): Promise<void> {
  return pollWatchdog(api, {
    label: "TokoPay reconcile poller",
    alertKey: TOKOPAY_POLL_ALERT_KEY,
    isEnabled: async () => (await getTokopayCreds(prisma)) !== null,
    readHealth: () => getPollHealth(prisma, "tokopay"),
    staleMs: TOKOPAY_POLL_STALE_MS,
    impact: QRIS_POLLER_IMPACT,
  });
}

/** PayDisini twin of tokopayPollWatchdog — same reasoning, its own
 * credential gate and alert-state key. */
export function paydisiniPollWatchdog(api: Api): Promise<void> {
  return pollWatchdog(api, {
    label: "PayDisini reconcile poller",
    alertKey: PAYDISINI_POLL_ALERT_KEY,
    isEnabled: async () => (await getPaydisiniCreds(prisma)) !== null,
    readHealth: () => getPollHealth(prisma, "paydisini"),
    staleMs: PAYDISINI_POLL_STALE_MS,
    impact: QRIS_POLLER_IMPACT,
  });
}

/** NOWPayments twin of tokopayPollWatchdog — same reasoning, its own
 * credential gate and alert-state key. */
export function nowpaymentsPollWatchdog(api: Api): Promise<void> {
  return pollWatchdog(api, {
    label: "NOWPayments reconcile poller",
    alertKey: NOWPAYMENTS_POLL_ALERT_KEY,
    isEnabled: async () => (await getNowpaymentsCreds(prisma)) !== null,
    readHealth: () => getPollHealth(prisma, "nowpayments"),
    staleMs: NOWPAYMENTS_POLL_STALE_MS,
    impact: QRIS_POLLER_IMPACT,
  });
}

// Throttle between broadcast DMs — stays under Telegram's ~30 msg/s bulk limit.
const BROADCAST_THROTTLE_MS = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flush the running sent/failed counters to the broadcast row every this many
 *  recipients, so the admin's History table shows real progress instead of a
 *  frozen 0. For 1,000 recipients that is 40 tiny scattered writes — cheap even
 *  for a single-writer SQLite file. */
const BROADCAST_PROGRESS_FLUSH_EVERY = 25;

/**
 * Bounds on the flood-control retry path below. Three of them, at two levels,
 * because the per-recipient bounds alone do NOT bound the tick:
 *
 * 1. How LONG one back-off may be. Telegram's `retry_after` is normally a few
 *    seconds, but the drainer must not park for hours on a bogus or hostile
 *    value (croner's `protect: true` means no other drain tick can run while
 *    this one sleeps). Anything larger is clamped to this ceiling.
 * 2. How MANY times a single RECIPIENT may be retried. Clamping alone is not
 *    enough — a server that answered 429 forever would still loop for ever, so
 *    after this many consecutive flood-control responses that recipient is
 *    counted as failed and the loop moves on.
 * 3. How much total back-off the whole BROADCAST may spend. (1) and (2)
 *    together bound one recipient at roughly 3 x 61s, but N recipients each
 *    paying that is N x 183s — about 50 hours for a 1,000-recipient segment,
 *    with `protect: true` holding off every other drain tick throughout. That
 *    is not a hypothetical: the latency-aware throttle above is what finally
 *    lets this bot reach the ~25 msg/s it was sized for, and 25 msg/s sits
 *    right against Telegram's ~30 msg/s bulk ceiling, so sustained partial
 *    throttling is the expected case rather than a freak one.
 *
 *    The ceiling is deliberately set well under `BROADCAST_STALE_CLAIM_MS`
 *    (15 min, packages/db/src/crud/broadcasts.ts), which is the point at which
 *    a still-running drain's claim looks abandoned. Past that line
 *    `reapStaleBroadcasts` would flip the row to FAILED underneath the drainer
 *    that is still happily sending, and both the progress flushes and
 *    `finishBroadcast` would silently no-op on their `status: SENDING` guard —
 *    leaving the admin looking at a FAILED broadcast that actually delivered.
 *    Today only `protect: true` plus the reaper running solely at the top of
 *    this same job prevents that, which holds for the single-process
 *    `apps/server` deployment and stops holding the moment a second bot
 *    process shares the DB. 5 minutes is a third of that window, leaving the
 *    rest as headroom for the sends themselves (a 1,000-recipient segment
 *    needs ~40s of throttle at the designed rate). Once the budget is spent
 *    the broadcast stops retrying, counts everyone it never reached as failed,
 *    and says so in its finish log.
 */
const BROADCAST_MAX_RETRY_AFTER_S = 60;
const BROADCAST_MAX_FLOOD_RETRIES = 3;
const BROADCAST_MAX_TOTAL_FLOOD_MS = 5 * 60_000;

/**
 * How long Telegram's flood control wants us to wait, in milliseconds, or null
 * when this error is not flood control at all (a blocked bot, a deactivated
 * account, a network blip — none of which get a retry). Mirrors the outbox
 * dispatcher's handling, including its +1s of headroom on top of the value
 * Telegram asked for.
 */
function broadcastFloodWaitMs(e: unknown): number | null {
  // `=== undefined`, not a truthiness check: Telegram may answer 429 with
  // `retry_after: 0` ("you may retry immediately"), and treating that as
  // "not flood control" would write the recipient off as permanently failed.
  if (!(e instanceof GrammyError) || e.parameters?.retry_after === undefined) return null;
  const seconds = Math.min(Math.max(e.parameters.retry_after, 0), BROADCAST_MAX_RETRY_AFTER_S);
  return (seconds + 1) * 1000;
}

/**
 * Drain ONE due broadcast queued by the web admin and DM the segment. This is
 * the bot half of the broadcast feature — the web only enqueues, it never calls
 * Telegram. One broadcast per tick; the SENDING status guards against overlap.
 */
export async function drainBroadcasts(api: Api): Promise<void> {
  const reaped = await reapStaleBroadcasts(prisma, new Date());
  if (reaped > 0) {
    logger.warn(`drainBroadcasts: reaped ${reaped} stale SENDING broadcast(s) as FAILED (drainer crash recovery)`);
  }

  const bc = await claimNextDueBroadcast(prisma, new Date());
  if (!bc) return;
  if (!isBroadcastSegment(bc.segment)) {
    logger.error(`Broadcast #${bc.id} has an unknown recipient segment "${bc.segment}" — marking it FAILED`);
    await failBroadcast(prisma, bc.id, `Unknown recipient segment "${bc.segment}".`);
    return;
  }

  const recipients = await resolveSegmentRecipients(prisma, bc.segment);
  logger.info(`Broadcast #${bc.id} starting — sending to ${recipients.length} recipient(s) in segment "${bc.segment}"`);
  let sent = 0;
  let failed = 0;
  const photoArg = broadcastPhotoArg(bc);
  let cachedFileId = bc.imageFileId;
  const cacheFileId = cacheBroadcastPhotoFileId(bc.id);
  /** One delivery attempt at one recipient. Throws whatever grammY throws so
   *  the loop below can tell flood control apart from a permanent failure. */
  const deliver = async (telegramId: bigint | null) => {
    if (photoArg) {
      // No parse_mode on the caption either — same reasoning as the plain-text
      // branch below: the operator types raw content, unescaped.
      const photo = cachedFileId ?? photoArg.photo;
      const msg = await api.sendPhoto(Number(telegramId), photo, { caption: bc.message });
      if (!cachedFileId && photoArg.needsCache && msg.photo?.length) {
        cachedFileId = msg.photo[msg.photo.length - 1]!.file_id;
        await cacheFileId(cachedFileId);
      }
    } else {
      // Plain text — the operator types raw content; no parse_mode so '<' / '&'
      // can't break the message.
      await api.sendMessage(Number(telegramId), bc.message);
    }
  };

  let processed = 0;
  let floodedRecipients = 0; // hit flood control at least once (and so was retried)
  let floodAbandoned = 0; // ...and still never got through before its own retry budget ran out
  let floodSpentMs = 0; // total time this broadcast has spent in flood back-off
  let cutShort = 0; // recipients never attempted because the flood budget ran out
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i]!;
    // Measured around the WHOLE recipient (all its attempts included), so the
    // throttle below sleeps only the remainder of the send budget rather than
    // stacking a flat 40ms on top of however long Telegram took. A flat sleep
    // made the real rate 1/(latency+40ms) — roughly 7 msg/s at 100ms latency,
    // against the ~25 msg/s the throttle was sized for. This can only ever
    // shorten the wait, never push the rate above the designed ceiling.
    const startedAt = Date.now();
    let floodRetries = 0;
    let budgetExhausted = false;
    for (;;) {
      try {
        await deliver(r.telegramId);
        sent++;
        break;
      } catch (e) {
        const waitMs = broadcastFloodWaitMs(e);
        if (waitMs === null) {
          // A GrammyError here is the expected, common case — the user blocked
          // the bot or deleted their account — already summarised by the failed
          // count in the finish log, so it does not earn a line per recipient.
          // Anything else is NOT expected, and the most plausible candidate is
          // the image file_id cache write inside `deliver` failing on SQLite
          // write contention AFTER an otherwise successful sendPhoto, which
          // miscounts a delivered message as a failure. That is rare enough to
          // always be worth a line, and undiagnosable without one.
          if (e instanceof GrammyError) {
            logger.debug({ err: e }, `Broadcast #${bc.id} could not deliver to one recipient — counting it as failed and continuing with the rest`);
          } else {
            logger.warn(
              { err: e },
              `Broadcast #${bc.id} failed on one recipient with something that is not a Telegram API error — counting it as failed and continuing, ` +
                `but if this came from the image file_id cache write then the message itself was actually delivered and the failed count overstates the damage`,
            );
          }
          failed++;
          break;
        }
        // Tick-level bound (3): stop retrying once the whole broadcast has
        // spent its flood budget, rather than letting every recipient pay its
        // own worst case and dragging the tick past BROADCAST_STALE_CLAIM_MS.
        if (floodSpentMs + waitMs > BROADCAST_MAX_TOTAL_FLOOD_MS) {
          failed++;
          budgetExhausted = true;
          break;
        }
        if (floodRetries >= BROADCAST_MAX_FLOOD_RETRIES) {
          failed++;
          floodAbandoned++;
          break;
        }
        floodRetries++;
        if (floodRetries === 1) floodedRecipients++;
        // Logged once per broadcast, not once per back-off: at up to
        // BROADCAST_MAX_FLOOD_RETRIES pauses for each of N recipients this was
        // good for thousands of near-identical lines. The totals land in the
        // finish log below instead.
        if (floodedRecipients === 1 && floodRetries === 1) {
          logger.warn(
            `Telegram flood-controlled broadcast #${bc.id} — pausing ${Math.round(waitMs / 1000)}s and retrying the same recipient rather than writing them off as failed. ` +
              `Each recipient gets up to ${BROADCAST_MAX_FLOOD_RETRIES} retries and the broadcast as a whole may spend ${BROADCAST_MAX_TOTAL_FLOOD_MS / 60_000} minutes waiting before it gives up on the rest; ` +
              `further pauses are counted rather than logged, and the totals appear in this broadcast's finish line`,
          );
        }
        floodSpentMs += waitMs;
        await sleep(waitMs);
      }
    }

    if (budgetExhausted) {
      cutShort = recipients.length - (i + 1);
      failed += cutShort;
      logger.error(
        `Broadcast #${bc.id} was cut short by sustained Telegram flood control after spending its ${BROADCAST_MAX_TOTAL_FLOOD_MS / 60_000}-minute back-off budget — ` +
          `${cutShort} recipient(s) were never attempted and are counted as failed. Continuing would have pushed this drain past the ${BROADCAST_STALE_CLAIM_MS / 60_000}-minute stale-claim window, ` +
          `at which point the broadcast row can be reaped as FAILED underneath this still-running send. Re-send to the remaining recipients once the throttling clears`,
      );
      break;
    }

    processed++;
    // Mid-flight progress so the admin's Broadcast History counter actually
    // creeps up; finishBroadcast still writes the authoritative final numbers.
    // No-ops (by its SENDING guard) if the row was reaped or cancelled under us.
    // Purely cosmetic, so it must NEVER abort a send that is already under way:
    // this `await` sits outside the per-recipient try/catch, and a SQLITE_BUSY
    // past the client's busy_timeout would otherwise escape all the way out of
    // drainBroadcasts, leaving the row stuck on SENDING until the reaper flips
    // it to FAILED 15 minutes later with a restart message that isn't true.
    // A lost flush costs nothing — the next one (or finishBroadcast) writes the
    // correct running totals anyway.
    if (processed % BROADCAST_PROGRESS_FLUSH_EVERY === 0) {
      await updateBroadcastProgress(prisma, bc.id, { sent, failed, total: recipients.length }).catch((err) =>
        logger.warn(
          { err },
          `Broadcast #${bc.id} could not write its mid-flight progress counters, so the admin's History table will show a stale count for a while — ` +
            `the send itself is unaffected and the final numbers are still written when it completes`,
        ),
      );
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed < BROADCAST_THROTTLE_MS) await sleep(BROADCAST_THROTTLE_MS - elapsed);
  }
  if (cutShort > 0) {
    // A send that never reached part of its segment is NOT a success, and the
    // logger.error above is read by developers, not by the shop admin who has
    // to decide whether to re-send. Marking the row FAILED with a plain-English
    // reason is what puts that decision in front of them: Broadcast History
    // renders `failureReason` under the status badge, but only for FAILED rows.
    // Deliberately scoped to the cut-short case — recipients individually given
    // up on after their own retry budget ran out still leave a broadcast that
    // made a full pass over its segment, which is what the visible sent/total
    // fraction already reports (and what an ordinary blocked user looks like).
    // Same counters-only cosmetic write as the in-loop flush above, so it gets
    // the same treatment: no delivery is at stake here (the send loop has
    // already ended), but letting it throw would skip the failBroadcast below
    // and leave the row SENDING until the reaper relabels it 15 minutes later
    // with the factually wrong "the sender process restarted" reason — losing
    // the very explanation this branch exists to give the admin.
    await updateBroadcastProgress(prisma, bc.id, { sent, failed, total: recipients.length }).catch((err) =>
      logger.warn(
        { err },
        `Broadcast #${bc.id} could not write its final counters before marking itself cut short — ` +
          `the status and the admin-facing reason are still written, only the sent/failed numbers may lag behind`,
      ),
    );
    // Deliberately NOT guarded: this is the authoritative status write, and
    // `reapStaleBroadcasts` is the correct backstop if it fails — the same
    // contract `finishBroadcast` has always had.
    await failBroadcast(
      prisma,
      bc.id,
      `Telegram's rate limiting cut this broadcast short — ${cutShort} recipient(s) were never contacted. Send it again in a few minutes to reach them.`,
    );
  } else {
    await finishBroadcast(prisma, bc.id, { sent, failed, total: recipients.length });
  }
  logger.info(
    `Broadcast #${bc.id} finished — sent to ${sent} recipient(s), ${failed} failed (blocked the bot, deactivated, or unreachable)` +
      (floodedRecipients > 0
        ? `; Telegram flood-controlled ${floodedRecipients} recipient(s) along the way, of which ${floodAbandoned} never got through before their retry budget ran out`
        : "") +
      (cutShort > 0
        ? `; the broadcast was cut short by sustained throttling with ${cutShort} recipient(s) never attempted, so it under-delivered and should be re-sent to them`
        : ""),
  );
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
 * Two phases, deliberately NOT one transaction (H-7 fix, backend audit
 * 2026-07-31 — this used to wrap the claim AND the whole-customer-base
 * `enqueueFlashSaleBroadcast` fan-out in a single `$transaction` with an
 * explicit 15s timeout, which held SQLite's single writer lock for however
 * long that fan-out took, starving every other concurrent writer — checkout,
 * settlement, cancellation, the outbox dispatcher's own claim — past their
 * busy_timeout):
 *
 * 1. Claim: a short transaction does the conditional `updateMany` on
 *    `flashAnnouncedAt` still being null. A second worker — or an overlapping
 *    tick — that reaches the same row after this commits finds count 0 and
 *    skips it, so the claim alone is what stops the same sale fanning out
 *    twice; it commits (or rolls back) in milliseconds regardless of customer
 *    count.
 * 2. Enqueue: `enqueueFlashSaleBroadcast` runs OUTSIDE any transaction,
 *    against the top-level `prisma` client, batching its outbox inserts into
 *    chunks so no single write holds the lock for long.
 *
 * Trade-off this introduces: because the claim now commits before the
 * fan-out runs (rather than both rolling back together), a crash or thrown
 * error between the two leaves the sale stamped as announced with some or all
 * of the customer base never enqueued — and since `flashAnnouncedAt` is no
 * longer null, the next tick will NOT retry it (unlike the old design, where
 * that failure mode was impossible because everything shared one rollback).
 * The catch block below logs that case loudly, distinctly from a claim
 * failure, so it surfaces as an ops alert rather than silently under-sending.
 * This is judged an acceptable trade for no longer risking every other writer
 * in the app on a single large broadcast.
 *
 * What that manual recovery actually looks like (H-7 follow-up fix, backend
 * audit 2026-07-31/08-01 — corrected after an earlier version of this
 * comment promised a cleaner story than the code actually delivered):
 * `enqueueFlashSaleBroadcast` now writes its `Broadcast` row BEFORE its
 * chunked insert loop and flips it to FAILED (with a partial `sentCount`) if
 * a chunk throws, so Broadcast History WILL show a row for a partial
 * failure — it is no longer silently empty. But there is still no
 * de-duplication: re-scheduling the SKU resets `flashAnnouncedAt` to null in
 * `setFlashSale`, and the next tick's `enqueueFlashSaleBroadcast` run then
 * fans out to the ENTIRE eligible customer base again, with no check against
 * who the failed run's `sentCount` already reached. An admin re-announcing
 * after a partial failure WILL double-DM every customer the partial run
 * already got to. Building real de-duplication (tracking exactly which
 * customers a given announcement run already reached, across enqueue
 * attempts) is out of scope here; until that exists, the honest guidance is:
 * check the FAILED row's `sentCount` first, and treat re-announcing as a
 * "some customers get this DM twice" action, not a clean retry.
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

    let claimed: boolean;
    try {
      claimed = await prisma.$transaction(async (tx) => {
        const claim = await tx.denomination.updateMany({
          where: { id: denom.id, flashAnnouncedAt: null },
          data: { flashAnnouncedAt: new Date() },
        });
        return claim.count === 1;
      });
    } catch (err) {
      logger.error({ err }, `Failed to claim the announcement stamp for the flash sale on denomination ${denom.id} — nothing was enqueued and it stays unannounced, so it will be retried on the next tick`);
      continue;
    }
    if (!claimed) continue; // already announced elsewhere

    try {
      const sent = await enqueueFlashSaleBroadcast(prisma, {
        productName: denom.product.name,
        denominationName: denom.name,
        discountPercent: percent.toString(),
        oldPrice: formatIdr(denom.price),
        newPrice: formatIdr(discounted),
        endsAt: localize(endsAt, "yyyy-LL-dd HH:mm ZZZZ"),
      });
      announced++;
      recipients += sent;
    } catch (err) {
      // The claim above already committed, so this sale will NOT be retried —
      // unlike the claim-failure branch, this is not self-healing. Log it as
      // an ops alert. enqueueFlashSaleBroadcast has already flipped its
      // Broadcast row to FAILED with a partial sentCount before re-throwing,
      // so Broadcast History does show this run — but re-announcing (e.g. by
      // re-scheduling the SKU) is NOT a clean retry: it fans out to the whole
      // customer base again with no de-duplication against whoever the
      // partial run's sentCount already reached, so those customers get the
      // DM twice. Say that plainly rather than implying a clean recovery.
      logger.error({ err }, `The flash sale on denomination ${denom.id} was stamped as announced, but enqueueing the customer fan-out failed partway through — check Broadcast History for a FAILED row on this sale to see how many customers (sentCount) were already reached before it failed. Re-announcing this sale (e.g. re-scheduling it) will re-notify the WHOLE customer base with no de-duplication, so those already-reached customers will receive the DM twice; an admin should weigh that before deciding whether to re-announce`);
    }
  }
  if (announced > 0) {
    logger.info(`Announced ${announced} newly started flash sale(s) — queued ${recipients} customer direct message(s) for the outbox dispatcher to deliver`);
  }
}

// Module-relative, not cwd-relative — same reasoning as web-admin's paths.ts
// and the storefront's ticketAttachments.ts: pnpm runs each app's `start`
// script with cwd = the package dir, so anchoring to this module keeps this
// job in agreement with wherever web-admin/storefront actually write uploads.
const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(HERE, "..", "..", "..", "..", "data", "uploads");

/**
 * Daily storage-efficiency sweep: delete broadcast images/ticket evidence
 * past their retention window, prune terminal outbox rows / dead reset
 * tokens / abandoned carts, and checkpoint the WAL. Same `runStorageCleanup`
 * the web-admin Storage page's "Run cleanup now" button calls, so the
 * scheduled and manual paths can never drift apart.
 */
export async function storageCleanupJob(): Promise<void> {
  const summary = await runStorageCleanup(prisma, UPLOADS_DIR);
  logger.info(
    `Storage cleanup finished — removed ${summary.broadcastFilesDeleted} broadcast image(s) and ` +
      `${summary.ticketFilesDeleted} ticket attachment(s) from disk; pruned ${summary.outboxRowsDeleted} outbox row(s), ` +
      `${summary.resetTokensDeleted} expired reset token(s), and ${summary.cartsDeleted} abandoned cart line(s).`,
  );
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
    new Cron("0 */6 * * *", { protect: true }, wrap("reconcileFinancesJob", reconcileFinancesJob)),
    // { protect: true } (M-26 fix, backend audit 2026-07-31): these watchdogs
    // were the one group of jobs in this list missing it. A slow Telegram API
    // call during the admin DM loop below can let a tick overlap with the
    // next one; without protect, the overlapping run reads the same
    // still-unset alert flag and every admin gets paged twice for the same
    // incident. See the flag-write reordering inside pollWatchdog (shared by
    // all six of these) for the other half of this fix.
    new Cron("*/2 * * * *", { protect: true }, wrap("binancePollWatchdog", binancePollWatchdog)),
    new Cron("*/2 * * * *", { protect: true }, wrap("bybitPollWatchdog", bybitPollWatchdog)),
    new Cron("*/2 * * * *", { protect: true }, wrap("bybitBscPollWatchdog", bybitBscPollWatchdog)),
    // The three QRIS/IDR watchdogs (Task 12) are offset onto their own
    // seconds (:15/:17/:19 of every even minute) rather than sharing the
    // crypto three's implicit second 0 — six watchdogs all reading settings
    // (and, on a transition, writing them) in the same SQLite write-lock
    // instant is exactly the kind of collision that caused P1008/P2028 in
    // production (2026-07-20; see the seconds-collision comment below). Each
    // gets its OWN second (not all three sharing one) so no two of these six
    // watchdogs — nor any other second-resolution job in this list — can
    // still contend with each other.
    new Cron("15 */2 * * * *", { protect: true }, wrap("tokopayPollWatchdog", tokopayPollWatchdog)),
    new Cron("17 */2 * * * *", { protect: true }, wrap("paydisiniPollWatchdog", paydisiniPollWatchdog)),
    new Cron("19 */2 * * * *", { protect: true }, wrap("nowpaymentsPollWatchdog", nowpaymentsPollWatchdog)),
    // Both offset off second 0 (croner's optional leading seconds field) so
    // neither fires in the same SQLite write-lock instant as
    // autoCancelExpiredOrders and the hourly/6-hourly jobs above — they all
    // land on second 0 otherwise, and one of them ends up waiting out the 5s
    // busy_timeout (P1008/P2028 in production, 2026-07-20).
    //
    // drainBroadcasts ticks four times a minute rather than once: a broadcast
    // queued by the web admin used to wait up to a full minute before the bot
    // even picked it up, which is most of the "broadcasts are slow" complaint
    // for small segments. The seconds are listed explicitly instead of using
    // "*/15" precisely because "*/15" would put one of those ticks back on
    // second 0; :05/:20/:35/:50 stay 5s clear of second 0 and of
    // announceStartedFlashSales on second 40 below. The added cost is one
    // indexed findFirst per tick when the queue is empty.
    new Cron("5,20,35,50 * * * * *", { protect: true }, wrap("drainBroadcasts", drainBroadcasts)),
    new Cron("40 * * * * *", { protect: true }, wrap("announceStartedFlashSales", announceStartedFlashSales)),
    // Once daily, off-peak (03:15) — well clear of every other job's
    // minutely/hourly ticks, and unlike those it's a single sweep rather
    // than something that needs to run often.
    new Cron("30 15 3 * * *", { protect: true }, wrap("storageCleanupJob", storageCleanupJob)),
  ];
}
