/**
 * Background scheduled jobs — port of utils/jobs.py, scheduled via croner
 * (timezone-aware) instead of PTB's JobQueue. Each job takes the bot `Api` so
 * it can DM users/admins directly.
 *
 * Schedule (scheduleJobs): auto-cancel every minute, stale-ticket close hourly,
 * finance reconcile every 6h, ledger reconcile every 6h.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cron } from "croner";
import { GrammyError, type Api, type InlineKeyboard } from "grammy";
import { adminIds } from "@app/core/runtime";
import { langCode, OrderStatus, ReconciliationFindingType, StockActorType } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { PaymentLogEvent } from "@app/core/payments/logEvents";
import {
  prisma,
  getSettledBubbleOrder,
  listExpiredPendingOrders,
  cancelOrder,
  listStaleRepliedTickets,
  closeTicket,
  getUser,
  reconcileFinances,
  reconcileLedger,
  countFindingsByType,
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
  alertIfUsdIdrRateStale,
  alertIfFxRateRejected,
  listUnannouncedStartedFlashSales,
  enqueueFlashSaleBroadcast,
  runStorageCleanup,
  listSettledOrdersAwaitingBubbleEdit,
  clearOrderPaymentMessage,
  resyncDigiflazzCatalog,
  dispatchPendingDigiflazzOrders,
  bumpCatalogRevision,
  runDetectionForCatalog,
  pruneProcessedTelegramUpdates,
  pruneExpiredBotSessions,
} from "@app/db";
import { flashPrice } from "@app/core/flash";
import { formatIdr } from "@app/core/formatters";
import { localize } from "@app/core/datetime";
import { evaluatePollHealth, type PollHeartbeat } from "@app/core/payments/pollHealth";
import {
  TOKOPAY_POLL_STALE_MS,
  PAYDISINI_POLL_STALE_MS,
  NOWPAYMENTS_POLL_STALE_MS,
  MAX_ORDERS_PER_CYCLE,
  SWEEP_EDIT_TIMEOUT_MS,
  SWEEP_TOTAL_BUDGET_MS,
} from "@app/core/payments/reconcileCycleBudget";
import { withTimeout, TELEGRAM_MESSAGE_TIMEOUT_MS } from "../payments/telegramTimeout";
import { isPermanentBubbleEditFailure } from "../util/bubbleEditFailure";
import { settledPaymentBubble, bubbleOnPhotoFor, type SettledBubbleOrder } from "../util/delivery";
import { coreT } from "../util/i18n";
import { notificationKb } from "../keyboards/customer";
import { esc, userPriceFormatter } from "../util/format";
import { currentUsdtRate } from "../util/rate";
import { broadcastPhotoArg, cacheBroadcastPhotoFileId } from "../util/broadcastPhoto";

/** What `editPaymentBubble` actually did, so the caller can tell a successful
 * edit apart from a failed one instead of guessing from side effects:
 *  - "edited"     — the bubble itself was updated in place. `via` has only
 *                    one member ("text") because that is the only edit this
 *                    helper performs; it is kept as a field so a caller that
 *                    already discriminates on it keeps compiling, and so a
 *                    future second edit method has somewhere to go.
 *  - "replaced"   — the bubble could not carry this text (it is a photo/QR
 *                    message) and the caller passed `onPhoto: "replace"`, so
 *                    it was DELETED and the text sent as a fresh message.
 *                    `messageId` is that new message's id: a caller holding
 *                    an anchor must re-point it there or drop it, because the
 *                    id it was holding no longer exists.
 *  - "deleted"    — the bubble could not carry this text and the caller
 *                    passed `onPhoto: "delete"`, so it was DELETED and
 *                    nothing was sent in its place (Task E2: a settled
 *                    WALLET_TOPUP's QR bubble carries no news the buyer
 *                    hasn't already had from the outbox's
 *                    WALLET_TOPUP_CREDITED_DM, so a replacement message here
 *                    would only be a second copy of it). No id to re-point
 *                    an anchor to: a caller holding one must clear it instead.
 *  - "dm_sent"    — the bubble could not be edited, but the fallback DM
 *                    (when the caller opted in) was sent instead.
 *  - "not_edited" — the bubble could not be edited and no fallback DM was
 *                    sent, either because the caller opted out (`fallbackDm:
 *                    null`), because `onPhoto: "delete"` means there is no
 *                    fallback DM to opt into at all (see the doc comment on
 *                    `editPaymentBubble`'s `args` below), or because the DM
 *                    itself failed too — `error` carries that DM failure
 *                    (unset in the first two cases) so a caller that needs
 *                    the original propagated (like `notifyAutoCancelled`
 *                    below, preserving its pre-refactor behavior) doesn't
 *                    have to re-attempt the send just to get it. `permanent`
 *                    describes the BUBBLE EDIT failure (never the fallback
 *                    DM's): true only when Telegram said this bubble can
 *                    never accept this edit, which is what tells an
 *                    anchor-owning caller it is safe to stop retrying — see
 *                    util/bubbleEditFailure.ts. */
export type BubbleEditResult =
  | { status: "edited"; via: "text" }
  | { status: "replaced"; messageId: number }
  | { status: "deleted" }
  | { status: "dm_sent" }
  | { status: "not_edited"; permanent: boolean; error?: unknown };

/**
 * Turn an anchored payment/notification bubble into `text`, whatever shape that
 * bubble has: edit it in place when it is a text message, and DELETE it when it
 * is a photo (a QRIS QR code) — then, depending on `args.onPhoto`, either send
 * `text` afresh in its place or send nothing at all.
 *
 * Why not simply edit the caption of a photo bubble, which is what this used to
 * do (Task T2-C)? Because that edit SUCCEEDS, and succeeds at the wrong thing:
 * Telegram has no way to turn a photo message into a text one, so the caption
 * flipped to "payment received" while the now-meaningless QR image stayed
 * parked in the buyer's chat — the exact complaint this helper's callers exist
 * to prevent. `editMessageMedia` would only swap one image for another, so
 * removing the picture at all means removing the message.
 *
 * The shape is never asked for up front (nothing carries it: the anchor is two
 * numbers) — it is inferred from how Telegram answers the text edit, using the
 * SAME classification the anchor decision already depends on
 * (`isPermanentBubbleEditFailure`, util/bubbleEditFailure.ts), rather than a
 * second, private list of Telegram strings that could drift away from it:
 *
 *  - The edit lands → it was a text bubble, and this is exactly the old
 *    behavior for the USDT rails and the QRIS text fallback.
 *  - Telegram says the bubble is dead or already shows this text (permanent)
 *    → there is nothing to replace. Deleting here would be actively wrong on
 *    "message is not modified": that bubble is already correct, and we would
 *    destroy it to re-send the identical thing.
 *  - Anything else (transient) → most likely "there is no text in the message
 *    to edit", which is Telegram's way of saying "this is a photo" and which
 *    bubbleEditFailure.ts deliberately keeps OFF the permanent list for
 *    exactly this recovery. A genuine transient fault (flood control, a 5xx, a
 *    dead socket) lands here too, and what that costs depends on `onPhoto`.
 *    Under "replace" it costs nothing: the delete usually fails for the same
 *    reason and nothing is sent, and even if the delete lands, the replacement
 *    send puts the same text back. Under "delete" there is no such self-heal —
 *    a text bubble whose edit hit a transient fault but whose delete succeeded
 *    is simply gone, with nothing in its place. That is accepted rather than
 *    guarded against: "delete" is only ever chosen for a settled WALLET_TOPUP,
 *    whose buyer is told what happened by the outbox's
 *    WALLET_TOPUP_CREDITED_DM regardless, so the worst case is that a stale
 *    payment-instructions bubble vanishes a little earlier than intended —
 *    strictly better than the duplicate success message this mode exists to
 *    prevent.
 *
 * `onPhoto` is required at every call site, not defaulted (Task E2): the five
 * callers' intents genuinely differ (a settled WALLET_TOPUP wants silence, a
 * settled PRODUCT sale and the auto-cancel notice both want the replacement),
 * and a default is exactly how the wrong one gets silently inherited by a
 * future call site that never stops to think about it. `"replace"` is today's
 * original behavior, unchanged. `"delete"` (new) is for a caller who knows
 * `text` carries no news the buyer doesn't already have through another
 * channel (a settled WALLET_TOPUP's outbox WALLET_TOPUP_CREDITED_DM) — the
 * photo is removed and nothing takes its place, so the buyer's chat shows one
 * fewer stale message instead of one duplicate one.
 *
 * `fallbackDm` exists only on the `"replace"` branch of `args`, not merely
 * defaulted to `null` on `"delete"` — deliberately unrepresentable rather than
 * resolved at runtime (Task E2 ambiguity #2). Asking for `onPhoto: "delete"`
 * (nothing sent on success) and a `fallbackDm` target (something sent on
 * failure) in the same call is contradictory: a caller that wants total
 * silence when the bubble edit works cannot also want a DM when it doesn't.
 * No caller combines them today — every real `"delete"` call site goes
 * through the shared `flipSettledOrderBubble` below (`flipSettledBubble`,
 * `sweepPaidOrderBubbles`, the three reconcile pollers, and the
 * payment-bubble flush hook alike), which passes `bubbleOnPhotoFor`'s
 * (util/delivery.ts) choice straight through and always wanted
 * `fallbackDm: null` regardless of `onPhoto`, so this costs none of
 * them anything and closes off the contradictory combination for good instead
 * of leaving it to be silently allowed later. The guard holds for the form the
 * call sites actually use, not just a hand-written literal: excess-property
 * checking rejects `{ ...bubbleOnPhotoFor(kind), fallbackDm: x }` too, because
 * the spread's union type is distributed over the argument before the extra
 * key is checked (verified against this repo's tsc, not assumed).
 *
 * Never throws: every grammY call (the edit, the delete, the replacement send
 * and the fallback DM) is caught, so a stale/uneditable bubble or a
 * blocked/deactivated recipient degrades to a reported outcome instead of an
 * exception the caller must remember to guard. Callers run this inside a
 * `withTimeout` race, where a throw would be indistinguishable from neither
 * side of the race having settled.
 */
export async function editPaymentBubble(
  api: Api,
  args: {
    chatId: number;
    messageId: number;
    text: string;
    markup: InlineKeyboard;
  } & (
    | {
        onPhoto: "replace";
        /** Telegram id to DM as a fallback when the bubble can't be edited.
         * Pass `null` to skip the DM entirely and just report the edit
         * failed. */
        fallbackDm: { telegramId: number } | null;
      }
    | { onPhoto: "delete" }
  ),
): Promise<BubbleEditResult> {
  /** The shared give-up tail, reached from every point where the bubble
   * itself turned out to be untouchable. `permanent` describes THAT failure
   * (never the DM's), because it is what tells an anchor-owning caller
   * whether retrying could ever pay off. No fallback DM exists to send when
   * `onPhoto: "delete"` — see this function's own doc comment for why that
   * combination is unrepresentable — so that mode always falls straight to
   * `not_edited` here, the same as `onPhoto: "replace", fallbackDm: null`. */
  const giveUp = async (permanent: boolean): Promise<BubbleEditResult> => {
    const fallbackDm = args.onPhoto === "replace" ? args.fallbackDm : null;
    if (fallbackDm == null) return { status: "not_edited", permanent };
    try {
      await api.sendMessage(fallbackDm.telegramId, args.text, { parse_mode: "HTML", reply_markup: args.markup });
      return { status: "dm_sent" };
    } catch (error) {
      return { status: "not_edited", permanent, error };
    }
  };

  try {
    await api.editMessageText(args.chatId, args.messageId, args.text, { parse_mode: "HTML", reply_markup: args.markup });
    return { status: "edited", via: "text" };
  } catch (editError) {
    // Dead bubble, or one that already shows this exact text. Either way there
    // is nothing here worth replacing, and on "message is not modified"
    // replacing would be destructive: the bubble is already what we wanted.
    if (isPermanentBubbleEditFailure(editError)) return giveUp(true);

    // Everything else is treated as "probably a photo bubble" — see the doc
    // comment above for why that read is safe even when it is wrong.
    try {
      await api.deleteMessage(args.chatId, args.messageId);
    } catch (deleteError) {
      // Classified on the DELETE's own answer alone: `editError` reaching this
      // line is transient by construction (the permanent case returned above),
      // so an "edit-or-delete says permanent" rule would be this same value.
      // Nothing was sent, so a transient answer here leaves the buyer looking
      // at exactly what they were looking at before — safe to retry.
      return giveUp(isPermanentBubbleEditFailure(deleteError));
    }

    // The photo is gone. `onPhoto: "delete"` stops right here on purpose —
    // see this function's own doc comment for why sending nothing is correct
    // for a settled WALLET_TOPUP.
    if (args.onPhoto === "delete") return { status: "deleted" };

    try {
      const replacement = await api.sendMessage(args.chatId, args.text, { parse_mode: "HTML", reply_markup: args.markup });
      return { status: "replaced", messageId: replacement.message_id };
    } catch (sendError) {
      // The only outcome here that cannot be undone or retried: the bubble is
      // already deleted, so every future attempt at that message id can only
      // ever answer "message to edit not found". Reporting it as permanent
      // releases the anchor instead of burning one of the sweep's per-cycle
      // slots every minute on an edit that provably cannot land. The stale QR
      // is at least gone; what is lost is the success message itself, which is
      // why this is worth a warning even though the sweeper otherwise
      // summarises failures by count.
      logger.warn({ err: sendError }, "Deleted a stale payment bubble but could not send its replacement, so the buyer's chat now shows neither the QR code nor the success message — the order itself is unaffected and the buyer can still see it under My Orders, but nothing will retry this message because the bubble it was anchored to no longer exists");
      return giveUp(true);
    }
  }
}

/** The two settled states a payment bubble can still be flipped from. NOT the
 * three in-flight ones Bybit BSC tracking uses (PAYMENT_DETECTED / CONFIRMING
 * / CONFIRMED): those orders are still waiting on on-chain confirmations and
 * their bubble is what shows that progress, so they must never be flipped to
 * a success message. Shared by every caller of `flipSettledOrderBubble`
 * below. */
const FLIPPABLE_SETTLED_STATUSES: readonly string[] = [OrderStatus.DELIVERED, OrderStatus.PROCESSING];

/** What a settled order needs to carry for `flipSettledOrderBubble` to flip
 * its bubble: everything `settledPaymentBubble`/`bubbleOnPhotoFor`
 * (util/delivery.ts) read, plus the row id and the anchor itself. Every real
 * caller's own order projection already satisfies this shape as-is — see
 * `SettledBubbleOrder`'s own doc-comment (util/delivery.ts) for why no caller
 * needs an extra read or merge to build one. */
type AnchoredSettledOrder = SettledBubbleOrder & {
  id: number;
  paymentMsgChatId: bigint | null;
  paymentMsgId: number | null;
};

/**
 * Outcome of `flipSettledOrderBubble`, shared by every caller so each only
 * owns its own logging/counting and (for `flipSettledBubble`,
 * handlers/checkout.ts) session-pointer differences:
 *  - "not_settled" — `order.status` isn't one of FLIPPABLE_SETTLED_STATUSES.
 *    Nothing was touched; this order isn't done yet.
 *  - "no_anchor"   — no bubble to flip. Nothing was touched; the order's own
 *    rail (or an earlier flip) already got there first — the overwhelmingly
 *    common case for the payment-bubble flush hook (Task E3), since every
 *    rail's own fast path normally wins the race against the outbox DM it
 *    precedes.
 *  - "timeout"     — the edit didn't finish inside `editTimeoutMs`. Anchor
 *    left in place on purpose so a later sweep retries it.
 *  - "kept"        — Telegram refused the edit for a reason that might not
 *    hold later (flood control, a 5xx, a network fault). Anchor left in
 *    place on purpose, same as "timeout".
 *  - anything else — the underlying `BubbleEditResult` once the anchor HAS
 *    been cleared (a finished attempt: edited/replaced/deleted/dm_sent, or a
 *    permanent failure reported as "not_edited"). `flipSettledBubble`
 *    (handlers/checkout.ts) is the one caller that also owns a session
 *    pointer, so it alone reacts to "replaced"/"deleted" here; every other
 *    caller only needs to know the anchor is gone.
 */
export type BubbleFlipOutcome = "not_settled" | "no_anchor" | "timeout" | "kept" | BubbleEditResult;

/**
 * The one shared body behind every settled-order bubble flip in this app:
 * `flipSettledBubble` (handlers/checkout.ts, the buyer's own "🔄 Refresh
 * Status" tap), `sweepPaidOrderBubbles` below (the generic cron sweep), both
 * QRIS reconcile pollers' `editBubbleAndClear`
 * (payments/tokopayReconcile.ts, payments/paydisiniReconcile.ts) and the
 * NOWPayments reconcile poller's own twin, and the payment-bubble flush hook
 * (`flushSettledOrderBubble` below, Task E3). Those six callers used to carry
 * four near-identical copies of this exact edit-classify-clear sequence — this is
 * the one body they now all call, differing only in what they do with a
 * "not_settled"/"no_anchor"/"timeout"/"kept" outcome (silently return, log +
 * count, or log + return) and, for `flipSettledBubble` alone, whether to
 * repoint a session pointer at a replaced/deleted bubble's id.
 *
 * Composes `settledPaymentBubble` (the text/keyboard) and `bubbleOnPhotoFor`
 * (the onPhoto choice) itself — the one mapping both read from, so a buyer
 * can never be shown a different ending for the same order depending on
 * which caller got there first. Clears the anchor itself (`clearOrderPaymentMessage`)
 * on any finished attempt, so callers never have to remember that step.
 *
 * Never throws: `editPaymentBubble` catches every grammY call it makes (see
 * its own doc comment), and `withTimeout` only ever resolves "timeout" or
 * whatever `editPaymentBubble` resolved — never rejects on that path either.
 * `clearOrderPaymentMessage` is a bare Prisma write with no timeout of its
 * own, same as every pre-refactor caller had.
 */
export async function flipSettledOrderBubble(
  api: Api,
  order: AnchoredSettledOrder,
  editTimeoutMs: number,
): Promise<BubbleFlipOutcome> {
  if (!FLIPPABLE_SETTLED_STATUSES.includes(order.status)) return "not_settled";
  if (order.paymentMsgChatId == null || order.paymentMsgId == null) return "no_anchor";
  const { text, markup } = settledPaymentBubble(order);
  const outcome = await withTimeout(
    editPaymentBubble(api, {
      chatId: Number(order.paymentMsgChatId),
      messageId: order.paymentMsgId,
      text,
      markup,
      ...bubbleOnPhotoFor(order.kind),
    }),
    editTimeoutMs,
  );
  if (outcome === "timeout") return "timeout";
  if (outcome.status === "not_edited" && !outcome.permanent) return "kept";
  await clearOrderPaymentMessage(prisma, order.id);
  // The bubble has reached its final state — edited in place, replaced, or
  // deleted — and its anchor is gone, so no later sweep will touch it again.
  // Emitted HERE, in the one shared flip body, rather than at each of the five
  // callers: that is what makes "the buyer's payment message is settled"
  // greppable once per order instead of five different ways depending on which
  // caller won the race. Deliberately not emitted for "timeout"/"kept" — those
  // keep their anchor precisely because they are NOT final, and the callers
  // already log them with their own rail-specific wording.
  logger.info(
    {
      event: PaymentLogEvent.TELEGRAM_PAYMENT_MESSAGE_UPDATED,
      orderId: order.id,
      status: outcome.status,
    },
    `Settled order ${order.orderCode}'s payment message in Telegram (${outcome.status}) and cleared its anchor, so no later sweep will revisit it`,
  );
  return outcome;
}

/**
 * Registered as the payment-bubble flush hook (`registerPaymentBubbleFlush`,
 * packages/core/src/nudge.ts) by apps/server's boot (Task E3) — see that
 * file's own doc-comment for the full "why" (the DM-before-bubble-flip
 * ordering bug this closes). `packages/outbox-dispatcher` calls it right
 * before it sends an order-scoped settlement DM (ORDER_DELIVERED_DM,
 * ORDER_MANUAL_DELIVERED_DM, WALLET_TOPUP_CREDITED_DM), passing only an
 * order id — the dispatcher knows nothing about bubble/anchor state, only
 * that this order just settled.
 *
 * Re-reads the order fresh (the dispatcher has no row to hand back) via
 * `getSettledBubbleOrder` (packages/db/src/crud/binance_internal.ts) — the
 * same lean `select` projection `listSettledOrdersAwaitingBubbleEdit` uses,
 * not `getOrder`'s `fullInclude`, since this runs once per settlement DM and
 * has no reason to materialise the buyer's items/stockItem credentials just
 * to read six scalars and `user.language` — and flips it through the exact
 * same `flipSettledOrderBubble` every other caller uses. In the
 * overwhelmingly common case the settling rail's own fast path (or the
 * background sweeper) already got there and cleared the anchor, so this is a
 * single indexed read that resolves to "no_anchor" — not an extra Telegram
 * call. It only does real work on the path that lost that race, or never ran
 * one at all (a storefront webhook, or admin manual approval — both
 * forbidden from touching Telegram directly).
 *
 * Never throws — an unhandled rejection here must never take down the
 * dispatcher's tick, and `packages/outbox-dispatcher` itself independently
 * bounds/swallows this call too (defence in depth: nothing on that side of
 * the process boundary can assume this function honours its contract
 * forever). Bounded at `TELEGRAM_MESSAGE_TIMEOUT_MS`, the same single-edit
 * budget `flipSettledBubble` and `sweepPaidOrderBubbles` use elsewhere on
 * this path — a hung edit must not stall the dispatcher.
 */
export async function flushSettledOrderBubble(api: Api, orderId: number): Promise<void> {
  try {
    const order = await getSettledBubbleOrder(prisma, orderId);
    if (!order) return; // shouldn't happen — a settlement DM's order id always exists — but never worth throwing over
    await flipSettledOrderBubble(api, order, TELEGRAM_MESSAGE_TIMEOUT_MS);
  } catch (err) {
    logger.warn({ err, orderId }, `Could not flush order ${orderId}'s payment bubble before its settlement DM — the background paid-order bubble sweep will still catch a stale bubble within a minute`);
  }
}

/**
 * Turn the anchored payment-instructions bubble (if any) into the
 * auto-cancelled notice, and only send a fresh DM when no anchor exists or the
 * bubble is gone — so the stale Refresh/Cancel buttons never survive next to a
 * brand-new message. `editPaymentBubble` decides how: a text bubble is edited
 * in place, a QR photo bubble is deleted and replaced (the QR is worthless for
 * an order that just expired, and leaving the image sitting above a
 * "cancelled" caption is what that used to look like). Always passes
 * `onPhoto: "replace"` (Task E2: unlike the settlement flips below, this is a
 * CANCELLATION notice — the buyer has received no other message about it, so
 * the replacement is the only way they find out at all, whatever the order's
 * kind).
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
      onPhoto: "replace",
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
      await prisma.$transaction((tx) => cancelOrder(tx, o.id, "expired", { type: StockActorType.SYSTEM }));
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

/**
 * Flip every settled order's stale payment bubble to its success message, for
 * ALL six payment methods at once. "Flip" is `editPaymentBubble`'s job: a text
 * bubble is edited in place; a QRIS photo bubble is DELETED, and then either
 * has its success message sent afresh (a PRODUCT sale) or is left deleted with
 * nothing in its place (a settled WALLET_TOPUP — Task E2: its outbox
 * WALLET_TOPUP_CREDITED_DM already told the buyer, so a replacement bubble
 * here would only be a second copy of that news). This whole sequence is
 * `flipSettledOrderBubble` above — the one body all five flip callers share,
 * which reads the onPhoto choice from `bubbleOnPhotoFor` (util/delivery.ts)
 * off `order.kind`, so a buyer can't get a different photo-bubble outcome
 * depending on which flip got there first.
 *
 * Why this exists: the two settlement paths that can pay an order off without
 * a bot Api anywhere in reach — a gateway webhook and an admin's manual
 * approval — run in the web process, which is forbidden from touching
 * Telegram at all. Since Task E3 the payment-bubble flush hook
 * (`flushSettledOrderBubble` above) normally flips those orders' bubbles
 * within the same second, right before their settlement DM, so this sweep is
 * the backstop rather than the first responder: it catches an order whose
 * flush lost a race, timed out, hit flood control, or never ran because that
 * process had no bot registered. The three crypto rails clear their own
 * anchor the moment they flip a bubble themselves, so orders they handled
 * never show up in this query — by design, not by omission.
 *
 * Idempotent: the anchor IS the work queue, so clearing it makes a re-run a
 * no-op. Bounded the same way TokoPay/PayDisini's own now-removed per-rail
 * sweeps were (Task T2-F deleted `sweepDeliveredAwaitingEdit`, whose shape
 * this follows): the batch is capped at MAX_ORDERS_PER_CYCLE, each edit gets
 * at most `editTimeoutMs`, and the whole sweep stops starting new rows once
 * `totalBudgetMs` of wall clock is gone. A timed-out or budget-cut-off edit
 * deliberately leaves its anchor in place so the next tick retries it, and so
 * does an edit Telegram refused for a reason that might not hold next minute
 * (flood control, a 5xx, a network fault). The anchor clears only when the
 * edit succeeded or failed for good — a bubble the buyer deleted self-heals
 * out of this queue instead of being retried forever, while a flood-controlled
 * one stays in it instead of leaving the buyer on a permanently stale QR. See
 * util/bubbleEditFailure.ts for which Telegram answers count as "for good".
 *
 * No fallback DM (`fallbackDm: null` on a "replace" order, and never an
 * option at all on a "delete" one — see `editPaymentBubble`'s own doc
 * comment): every order in this list already reached its buyer through the
 * normal path — the account file, the ORDER_PROCESSING_DM, or the wallet
 * top-up notice — so a DM here would only repeat news they already have.
 *
 * `opts` defaults to the shared exported constants; production never passes
 * it. It exists so the black-holed-bubble tests can drive the identical
 * give-up/budget-break logic with millisecond-scale values instead of really
 * sleeping ~40s, the same trick the per-rail sweep tests already use.
 */
export async function sweepPaidOrderBubbles(
  api: Api,
  opts?: { editTimeoutMs?: number; totalBudgetMs?: number },
): Promise<void> {
  const editTimeoutMs = opts?.editTimeoutMs ?? SWEEP_EDIT_TIMEOUT_MS;
  const totalBudgetMs = opts?.totalBudgetMs ?? SWEEP_TOTAL_BUDGET_MS;
  const orders = await listSettledOrdersAwaitingBubbleEdit(prisma, MAX_ORDERS_PER_CYCLE);
  const sweepStartedAt = Date.now();
  // Counted, not logged per order (CLAUDE.md: summarize by count). The failure
  // this tracks is overwhelmingly a shop-wide event — Telegram flood control
  // or an API outage hits every edit in the batch at once — so a line per
  // order meant up to MAX_ORDERS_PER_CYCLE near-identical warnings every
  // single minute for as long as the outage lasted. One aggregate line after
  // the loop says the same thing; which order hit which case stays available
  // at debug for whoever is actually chasing one order.
  let keptForRetry = 0;
  for (const [index, order] of orders.entries()) {
    if (Date.now() - sweepStartedAt > totalBudgetMs) {
      logger.warn(`The paid-order bubble sweep ran out of its ${totalBudgetMs}ms whole-sweep budget with ${orders.length - index} order(s) still showing a stale payment bubble — their anchors are left in place on purpose so the next cycle picks them up again`);
      break;
    }
    // The actual edit-classify-clear sequence is the shared body every
    // settled-bubble flip in this app now calls (`flipSettledOrderBubble`,
    // above) — "not_settled"/"no_anchor" are defensive no-ops here (the
    // query this loop iterates already filters to settled, anchored orders),
    // kept only so this loop needn't re-derive them itself.
    const outcome = await flipSettledOrderBubble(api, order, editTimeoutMs);
    if (outcome === "not_settled" || outcome === "no_anchor") continue;
    if (outcome === "timeout") {
      keptForRetry++;
      logger.debug(`The paid-order bubble sweep gave up waiting on the bubble edit for order ${order.orderCode} after ${editTimeoutMs}ms — the edit was not cancelled and may still land on its own; if it does not, the anchor stays put and the next cycle retries it`);
      continue;
    }
    if (outcome === "kept") {
      keptForRetry++;
      logger.debug(`The paid-order bubble sweep could not edit order ${order.orderCode}'s payment bubble, and Telegram's answer does not rule out the same edit succeeding later`);
      continue;
    }
    // Everything else is a finished attempt — "replaced" and "deleted" both
    // included: either way the QR bubble is gone, whatever took its place (a
    // fresh success message, or nothing) carries no Refresh/Cancel pair, and
    // there is nothing left for a later sweep to fix. Deliberately NOT
    // re-anchored on a "replaced" outcome's `messageId` — that would put a
    // message needing no further edit back into this queue forever. The
    // anchor is already cleared: `flipSettledOrderBubble` does that itself
    // on any finished attempt.
  }
  if (keptForRetry > 0) {
    logger.warn(`The paid-order bubble sweep left ${keptForRetry} of ${orders.length} order(s) still showing a stale payment bubble because the edit either hung past its ${editTimeoutMs}ms budget or was refused for a reason that does not rule out the same edit succeeding later (flood control, a server error, or a network fault) — their anchors are kept on purpose so the next cycle retries them, and which order hit which case is logged at debug level`);
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

/**
 * Ledger reconciliation (Financial Ledger M5) — cross-checks the double-entry
 * ledger against the rows it is supposed to describe, and pages an admin when
 * they disagree.
 *
 * Runs ALONGSIDE `reconcileFinancesJob` above, on the same 6-hourly schedule,
 * and deliberately does not replace it: that job checks the operational rows
 * against each other (order totals, voucher counts, negative balances), while
 * this one checks those same rows against the ledger. A shop can pass either
 * check and fail the other, so both alerts are worth having.
 *
 * Every finding `reconcileLedger` returns is CRITICAL by construction — each
 * check compares two records of the SAME money — so there is no severity
 * filtering here: anything it returns is worth an admin's attention. The DM
 * follows `reconcileFinancesJob`'s pattern exactly (plain text, first admin
 * only, swallowed failure), not the HTML/every-admin shape the payment-rail
 * watchdogs use: this is financial-drift reporting an admin reviews, not a
 * rail outage that needs everyone woken up.
 *
 * A clean run says what it compared, not that the books balance — see the
 * no-findings branch. `reconcileLedger` is a set of bounded checks inside a
 * cutover boundary, and on an un-backfilled shop the largest of them do not run
 * at all, so "no findings" and "reconciled" are not the same statement.
 */
export async function reconcileLedgerJob(api: Api): Promise<void> {
  const findings = await reconcileLedger(prisma);
  if (findings.length === 0) {
    // Deliberately narrower than "the books balance". This run checks five
    // specific things, each within a boundary, and an operator reading a clean
    // line has to know which: a silent "everything matched" would let a shop
    // whose entire history predates the ledger's first posting — where the
    // missing-posting checks do not run at all — read as fully reconciled.
    // `reconcileLedger` logs each skip on its own line; this says what was
    // actually compared.
    logger.info(
      "Ledger reconciliation finished with no findings. What it checked: every settled order and completed refund payout dated at or after the ledger's earliest posting has a posting under its own idempotency key; each currency's wallet-liability control account agrees with the balances buyers hold plus the checkout holds still outstanding; no two payments claim the same provider transaction id; every posted payout's ledger entries record the amount that was actually paid out; and every order a rail flagged short but an admin delivered anyway books only what actually arrived as owed by the gateway, with the rest as an absorbed shortfall. It did NOT check anything dated before that earliest posting (pre-ledger history, which the M10 backfill script owns, not this job) or any payout carrying no execution timestamp, and it does not verify that the ledger as a whole balances. Any check skipped for those reasons logged its own line during this run.",
    );
    return;
  }

  const counts = countFindingsByType(findings);
  const missingPostings = counts[ReconciliationFindingType.LEDGER_POSTING_MISSING] ?? 0;
  const walletDrift = counts[ReconciliationFindingType.WALLET_LEDGER_DRIFT] ?? 0;
  const duplicatePayments = counts[ReconciliationFindingType.DUPLICATE_PROVIDER_TRANSACTION] ?? 0;
  const refundMismatches = counts[ReconciliationFindingType.REFUND_AMOUNT_MISMATCH] ?? 0;
  const orderAmountMismatches = counts[ReconciliationFindingType.ORDER_POSTING_AMOUNT_MISMATCH] ?? 0;

  // The severity claim forks on that last count, because it is the one finding
  // type that does NOT mean the money may be wrong: an underpaid-but-delivered
  // order whose posting books the full total has the right money and the wrong
  // split between what a gateway owes and what the shop absorbed. Saying "the
  // books and the money may genuinely disagree" of those would page an admin
  // about documented pre-cutover history as though it were an incident.
  const seriousCount = missingPostings + walletDrift + duplicatePayments + refundMismatches;
  logger.warn(
    `Ledger reconciliation found drift — ${missingPostings} settled event(s) with no ledger posting, ` +
      `${walletDrift} wallet balance total(s) disagreeing with their control account, ` +
      `${duplicatePayments} duplicated provider transaction(s), ` +
      `${refundMismatches} refund payout(s) whose posted amount differs from what was paid, and ` +
      `${orderAmountMismatches} underpaid-but-delivered order(s) booking the full order total as owed by the gateway rather than only what arrived. ` +
      (seriousCount > 0
        ? `Each of the first four kinds means the books and the money may genuinely disagree, so each needs manual review. `
        : ``) +
      (orderAmountMismatches > 0
        ? `The last kind does not: that money is right, and only the split between the receivable and the shortfall the shop absorbed is wrong — the expected shape for any such order settled before that split shipped. `
        : ``) +
      `(see audit log for details)`,
  );

  await logAdminAction(prisma, {
    adminId: null, // system action
    action: "reconcile_ledger.drift",
    targetType: "system",
    targetId: null,
    details:
      `Ledger reconciliation found ${missingPostings} settled events with no ledger record, ` +
      `${walletDrift} wallet balance totals that disagree with the ledger, ` +
      `${duplicatePayments} duplicated provider transactions, ` +
      `${refundMismatches} refunds whose recorded amount differs from what was paid out, and ` +
      `${orderAmountMismatches} orders delivered despite a short payment whose bookkeeping still treats the whole total as money a gateway owes us.`,
  });

  if (adminIds().length) {
    try {
      await api.sendMessage(
        adminIds()[0]!,
        "⚠ Ledger drift detected\n" +
          `missing ledger postings: ${missingPostings}\n` +
          `wallet balance drift: ${walletDrift}\n` +
          `duplicate provider transactions: ${duplicatePayments}\n` +
          `refund amount mismatches: ${refundMismatches}\n` +
          `underpaid orders booked at their full total: ${orderAmountMismatches}\n` +
          "See audit log for full details.",
      );
    } catch (err) {
      logger.error({ err }, "Failed to DM the admin about ledger drift — the drift is still recorded in the audit log, but no one was paged");
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
// Task 15 (I-3, fresh backend audit 2026-08-21) — see outboxDispatcherPollWatchdog below.
const OUTBOX_WATCHDOG_ALERT_KEY = "outbox_watchdog_alerted";

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

/** Impact sentence for the outbox dispatcher watchdog (Task 15 / I-3) —
 * deliberately more severe than DEFAULT_POLLER_IMPACT/QRIS_POLLER_IMPACT
 * above: the outbox dispatcher (packages/outbox-dispatcher/src/dispatcher.ts's
 * `runDispatcher`) is the sole delivery path for every buyer credential DM
 * AND every admin alert this whole codebase enqueues — not just one payment
 * rail's auto-confirm. When it's down, no other channel picks up the slack,
 * including this very watchdog DM (see the isEnabled comment below for why
 * that's still worth sending anyway). */
const OUTBOX_DISPATCHER_IMPACT =
  "This is the sole delivery path for EVERY buyer credential DM and EVERY admin alert this shop sends — right now none of them are getting delivered. " +
  "This is more severe than any single payment rail failing: check the notifier/outbox dispatcher (a bad notifier bot token, or an unhandled exception in its loop) immediately.";

/**
 * Alert admins if the outbox dispatcher (Task 15 / I-3) looks unhealthy — see
 * `pollWatchdog` above for the actual stale/failing/recover logic. Seventh
 * rail wrapper around the shared `pollWatchdog`, alongside the six payment
 * pollers above, reading the heartbeat `runDispatcher` now records
 * (packages/outbox-dispatcher/src/dispatcher.ts) via `recordPollHealth(...,
 * "outbox", ...)`.
 *
 * `isEnabled` is `async () => true` — always armed, unlike every rail above.
 * The six payment rails each gate on "are this rail's credentials
 * configured", because an unconfigured rail's poller correctly never runs at
 * all. There is no equivalent "is the outbox dispatcher turned on" setting to
 * check here: whether a notifier token is configured (and therefore whether
 * `startNotifier`/`runDispatcher` actually run) is a decision made in
 * apps/server/src/index.ts, not in this module — this file must not import
 * from apps/server, and duplicating that check here would drift the moment
 * either side changed. Scoping this cron's SCHEDULING (not this function's
 * logic) to only the process where the dispatcher can possibly be running is
 * how that gap is closed instead — see scheduleOutboxDispatcherWatchdog's own
 * doc-comment below for the full reasoning. */
export function outboxDispatcherPollWatchdog(api: Api): Promise<void> {
  return pollWatchdog(api, {
    label: "Outbox dispatcher",
    alertKey: OUTBOX_WATCHDOG_ALERT_KEY,
    isEnabled: async () => true,
    readHealth: () => getPollHealth(prisma, "outbox"),
    impact: OUTBOX_DISPATCHER_IMPACT,
  });
}

// Throttle between broadcast DMs — stays under Telegram's ~30 msg/s bulk limit.
const BROADCAST_THROTTLE_MS = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flush the running sent/failed counters to the broadcast row every this many
 *  recipients, so the admin's History table shows real progress instead of a
 *  frozen 0. For 1,000 recipients that is 40 tiny scattered writes — cheap even
 *  for a busy shared database. */
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
          // the image file_id cache write inside `deliver` failing on a
          // transient database error AFTER an otherwise successful sendPhoto, which
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
    // this `await` sits outside the per-recipient try/catch, and a transient
    // database error (such as a lock timeout) would otherwise escape all the way out of
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
 * explicit 15s timeout, which held a transaction (and its locks) open for however
 * long that fan-out took, starving every other concurrent writer — checkout,
 * settlement, cancellation, the outbox dispatcher's own claim — past their
 * lock timeouts):
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
      // before the write-time guard existed, or straight into the database
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
      // One rate read per sale (cached 60s); each recipient's DM prices the
      // canonical IDR list/sale price in their own display currency (NULL →
      // IDR) with their own stored language's separators. The Broadcast
      // History row (admin-facing) keeps the shop's Rupiah strings.
      const rate = await currentUsdtRate();
      const sent = await enqueueFlashSaleBroadcast(prisma, {
        productName: denom.product.name,
        denominationName: denom.name,
        discountPercent: percent.toString(),
        oldPrice: formatIdr(denom.price),
        newPrice: formatIdr(discounted),
        endsAt: localize(endsAt, "yyyy-LL-dd HH:mm ZZZZ"),
        pricesForRecipient: (currency, language) => {
          const prices = userPriceFormatter(currency, rate, language);
          return { oldPrice: prices.price(denom.price), newPrice: prices.price(discounted) };
        },
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
 * tokens / abandoned carts. Same `runStorageCleanup`
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

/** Retention window for the update_id dedup ledger (`bindUpdateId`,
 * middleware.ts) — generous relative to how long Telegram could plausibly
 * still redeliver the same update_id (minutes, not days), but small enough
 * that keeping it doesn't cost anything. */
const PROCESSED_TELEGRAM_UPDATE_RETENTION_MS = 3 * 24 * 3_600_000; // 3 days

/**
 * Daily retention sweep for the update_id dedup ledger
 * (ProcessedTelegramUpdate, claimed by `bindUpdateId` in middleware.ts) —
 * deletes rows past their retention window so the table stays small. Unlike
 * the payment Processed*Tx ledgers (crud/storageMaintenance.ts deliberately
 * leaves those alone — see its own module doc comment), a row here carries
 * no double-payment risk if pruned early: Telegram's own redelivery window
 * is on the order of minutes, nowhere near this job's 3-day cutoff.
 */
export async function cleanupProcessedTelegramUpdatesJob(): Promise<void> {
  const cutoff = new Date(Date.now() - PROCESSED_TELEGRAM_UPDATE_RETENTION_MS);
  const removed = await pruneProcessedTelegramUpdates(prisma, cutoff);
  logger.info(`Update-id dedup ledger cleanup finished — pruned ${removed} row(s) older than ${PROCESSED_TELEGRAM_UPDATE_RETENTION_MS / 3_600_000}h.`);
}

/**
 * Daily retention sweep for the `BotSession` table
 * (`util/prismaSessionStorage.ts`, wired into `session()` in main.ts). Each
 * row already carries its own `expiresAt` (24h nav / 15min checkout, per
 * `classifySessionKind`) and `prismaSessionStorage.ts`'s `read()` lazily
 * deletes an expired row the next time that key is looked up — this sweep
 * only exists to reclaim rows for chats that never come back and so are
 * never looked up again. Unlike the update-id ledger above (insert-only, one
 * row per Telegram update), `bot_sessions` is upserted in place (one row per
 * active chat), so it does not grow unbounded the way that ledger would
 * without pruning — this job is hygiene, not a leak fix.
 */
export async function cleanupExpiredBotSessionsJob(): Promise<void> {
  const removed = await pruneExpiredBotSessions(prisma, new Date());
  logger.info(`Session storage cleanup finished — pruned ${removed} expired BotSession row(s).`);
}

/** Register all scheduled jobs against croner. Returns the Cron handles. */
/**
 * Keep `usd_idr_rate` tracking the live market rate (rounded — plan.md §15.8).
 * Scheduled SEPARATELY from scheduleJobs because it needs no bot Api and must
 * keep running even when the bot is off (web-only boot, §16.3). Kicks once
 * immediately so a fresh install gets a rate without waiting for the hour.
 */
export function scheduleFxRefresh(): Cron {
  void runFxRefreshTick();
  return new Cron("5 * * * *", { protect: true }, runFxRefreshTick);
}

/**
 * One hourly FX tick: try to re-confirm `usd_idr_rate` against the market,
 * then — whatever that attempt did — check whether the saved rate has aged
 * past `fx_rate_max_age_hours` and the USDT rail is now off shop-wide.
 *
 * Exported so the tick can be exercised directly in tests without a live cron,
 * same as `runDigiflazzCatalogSyncTick` below.
 *
 * The staleness check runs even when the refresh threw or was disabled, and
 * that is the point: those are precisely the states that PRODUCE staleness. It
 * lives here rather than inside `getUsdIdrRate` because `getUsdIdrRate` runs on
 * every catalogue render and every checkout — it has to stay a cheap,
 * side-effect-free read, and alerting from it would mean a DM per page view.
 * Once an hour is ample for a horizon measured in days.
 *
 * Alerting goes through the outbox (`alertIfFxRateRejected`,
 * `alertIfUsdIdrRateStale`), never a direct `api.sendMessage`: this job holds
 * no bot `Api` on purpose, because it must keep running on a web-only boot
 * (§16.3). Both alerts fire once per EPISODE rather than once per tick, each
 * through its own marker in the settings table, re-armed by the next confirmed
 * rate — so a source stuck in one failure mode does not turn into an hourly DM
 * to every admin for as long as it stays stuck. The two failures are also kept
 * isolated from each other — a throwing refresh must not skip the staleness
 * check, and a failing enqueue must not take down the tick.
 */
export async function runFxRefreshTick(): Promise<void> {
  try {
    const r = await refreshUsdIdrRate(prisma);
    if (r.status === "disabled") {
      logger.debug("FX auto-update is off (usd_idr_rate_auto=false)");
    } else if (r.status === "rejected") {
      // refreshUsdIdrRate has already logged which check failed and by how
      // much; this is the part it deliberately leaves to its caller, because
      // the admin panel's own refresh button answers its admin on screen and
      // must not also DM everyone. Nobody is watching this one.
      //
      // Once per EPISODE, not once per tick: `alertIfFxRateRejected` owns the
      // dedupe marker and the payload, the same way `alertIfUsdIdrRateStale`
      // below owns the staleness one. Building the payload here as well would
      // have put the DM's contents in the job and the "have they been told
      // already" rule in crud, which is how the two drift apart.
      await alertIfFxRateRejected(prisma, {
        reason: r.reason,
        market: r.market,
        rate: r.rate,
        consecutiveFailures: r.consecutiveFailures,
      });
    }
  } catch (err) {
    logger.error({ err }, "Failed to refresh the USD/IDR exchange rate from the market — keeping the previous rate");
  }

  try {
    await alertIfUsdIdrRateStale(prisma);
  } catch (err) {
    logger.error(
      { err },
      "Could not check whether the saved USD/IDR rate has gone stale — admins may not have been told that the USDT payment rail is switched off",
    );
  }
}

/**
 * One hourly Digiflazz catalog re-sync tick — refreshes costPrice/price/
 * isActive on every already-imported denomination (never creates/renames
 * anything; new SKUs only ever enter the catalog via the admin's Import
 * Wizard), then (Task 10, shadow mode) invalidates the Detection Engine's
 * catalog index and re-runs detection over the whole catalog so its review
 * queue and run-status blob (packages/db/src/crud/detectionRun.ts) reflect
 * this tick's writes. No `Api` needed, so this runs even on a web-only boot,
 * same as scheduleFxRefresh.
 *
 * Exported so the tick can be exercised directly in tests without a live
 * cron. The detection pass is best-effort and fully isolated: a failure in
 * it is logged and swallowed, so a successful resync is never undone by a
 * detection-pass error, and it is skipped entirely when the resync itself
 * failed.
 */
export async function runDigiflazzCatalogSyncTick(): Promise<void> {
  try {
    const r = await resyncDigiflazzCatalog(prisma);
    if (r.updated || r.deactivated) {
      logger.info(`Digiflazz catalog re-sync: ${r.updated} price update(s), ${r.deactivated} deactivated.`);
    }
  } catch (err) {
    logger.error({ err }, "Digiflazz catalog re-sync failed — will retry on the next hourly tick");
    return;
  }

  try {
    await bumpCatalogRevision(prisma);
    await runDetectionForCatalog(prisma);
  } catch (err) {
    logger.warn(
      { err },
      "The shadow-mode detection pass after the Digiflazz catalog resync failed; the catalog resync itself succeeded and its results stand, and the detection pass will be retried on the next hourly tick.",
    );
  }
}

export function scheduleDigiflazzCatalogSync(): Cron {
  return new Cron("15 * * * *", { protect: true }, () => runDigiflazzCatalogSyncTick());
}

/**
 * Digiflazz dispatch poller (Task 3, original pilot plan) — finds PROCESSING
 * orders routed to Digiflazz and not yet dispatched, claims each atomically,
 * and places the top-up order with the supplier (packages/db/src/crud/digiflazz.ts
 * dispatchPendingDigiflazzOrders). No `Api` needed, so this runs even on a
 * web-only boot, same as scheduleFxRefresh/scheduleDigiflazzCatalogSync above.
 * A five-second durable queue scan keeps paid orders moving without a browser
 * refresh. Every 5 seconds (croner six-field syntax) also honours the
 * front-loaded recheck schedule in digiflazzBackoff.ts (+10s, +30s, +1m, ...)
 * with seconds-level accuracy; the webhook is the primary path and this is the
 * safety net. `protect: true` prevents overlapping runs if one tick is slow.
 */
export function scheduleDigiflazzDispatch(): Cron {
  const run = () =>
    dispatchPendingDigiflazzOrders(prisma)
      .then((r) => {
        if (r.claimed) {
          logger.info(`Digiflazz dispatch: claimed ${r.claimed}, delivered ${r.delivered}, pending ${r.pending}, failed ${r.failed}.`);
        }
      })
      .catch((err) => logger.error({ err }, "Digiflazz dispatch poller failed — will retry on the next tick"));
  return new Cron("*/5 * * * * *", { protect: true }, run);
}

/**
 * Cron wrapper for outboxDispatcherPollWatchdog (Task 15 / I-3, fresh backend
 * audit 2026-08-21). Deliberately NOT registered inside scheduleJobs below,
 * unlike the six payment-rail watchdogs — read this carefully before "fixing"
 * that:
 *
 * scheduleJobs is called from BOTH apps/server/src/index.ts (the combined
 * web+bot process, where the outbox dispatcher's runDispatcher actually runs,
 * via that file's own startNotifier) AND apps/order-bot/src/main.ts (the
 * standalone bot-only binary) — and the standalone binary NEVER calls
 * runDispatcher/startNotifier at all. If this watchdog's Cron lived inside
 * scheduleJobs, the standalone binary would page admins forever with "the
 * outbox dispatcher has never completed a cycle" — a permanent false alarm in
 * a topology where the dispatcher isn't supposed to run in the first place.
 *
 * Exported separately instead, so apps/server/src/index.ts's start() can call
 * it directly — inside the exact same `if (bot)` block that already calls
 * scheduleJobs(bot.api), appending this Cron to the same `jobs` array so it
 * gets `.stop()`ed on shutdown like every other job. That block's condition
 * (`bot` resolved from a configured main bot token) is a SUBSET of — narrower
 * than — startNotifier's own enablement check (`dedicated || mainBot`: a
 * dedicated notifier token OR a main bot token), not identical to it: in the
 * specific topology "dedicated notifier token configured, no main bot token",
 * runDispatcher still runs but this watchdog never gets scheduled (`bot` is
 * falsy). That's safe — no false alarm — but it does mean that topology gets
 * no watchdog coverage; there is no bot token to page an admin from in it
 * anyway, so scheduling this watchdog only inside `if (bot)` still guarantees
 * it is never armed in a process/branch where it couldn't deliver a page even
 * if it fired.
 *
 * Every 2 minutes on second :21 — its own offset, clear of the six existing
 * watchdogs' seconds (implicit 0 for the crypto three; :15/:17/:19 for the
 * QRIS three below) so none of them contend for the same write locks in
 * the same instant (see the QRIS three's own comment in scheduleJobs for the
 * P1008/P2028 production history behind this rule), and `{ protect: true }`
 * like every other watchdog cron per this file's own M-26 comment.
 */
export function scheduleOutboxDispatcherWatchdog(api: Api): Cron {
  const run = () =>
    outboxDispatcherPollWatchdog(api).catch((err) =>
      logger.error({ err }, 'Scheduled job "outboxDispatcherPollWatchdog" threw an uncaught error — this run was skipped, will retry on its next tick'),
    );
  return new Cron("21 */2 * * * *", { protect: true }, run);
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
    // Additive alongside the finance reconcile above, not a replacement for it
    // (Financial Ledger M5): same cadence, same overlap guard, different
    // question — that one checks the operational rows against each other, this
    // one checks them against the double-entry ledger.
    new Cron("0 */6 * * *", { protect: true }, wrap("reconcileLedgerJob", reconcileLedgerJob)),
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
    // (and, on a transition, writing them) at the same instant is exactly the
    // kind of lock collision that caused P1008/P2028 in
    // production (2026-07-20; see the seconds-collision comment below). Each
    // gets its OWN second (not all three sharing one) so no two of these six
    // watchdogs — nor any other second-resolution job in this list — can
    // still contend with each other.
    new Cron("15 */2 * * * *", { protect: true }, wrap("tokopayPollWatchdog", tokopayPollWatchdog)),
    new Cron("17 */2 * * * *", { protect: true }, wrap("paydisiniPollWatchdog", paydisiniPollWatchdog)),
    new Cron("19 */2 * * * *", { protect: true }, wrap("nowpaymentsPollWatchdog", nowpaymentsPollWatchdog)),
    // Both offset off second 0 (croner's optional leading seconds field) so
    // neither fires at the same instant as
    // autoCancelExpiredOrders and the hourly/6-hourly jobs above — they all
    // land on second 0 otherwise, and one of them ends up waiting out a lock
    // timeout (P1008/P2028 in production, 2026-07-20).
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
    // Same daily off-peak slot, one minute later — second 10, not 15/17/19/25
    // (already used above by the QRIS watchdogs / sweepPaidOrderBubbles) and
    // not 30 (storageCleanupJob itself), so it never shares a firing second
    // with any other registered job.
    new Cron("10 16 3 * * *", { protect: true }, wrap("cleanupProcessedTelegramUpdatesJob", cleanupProcessedTelegramUpdatesJob)),
    // Same daily off-peak slot, on second 45 — NOT second 20 (drainBroadcasts
    // already fires every minute at :20, including 03:16:20, so that second
    // is a genuine, not just test-flagged, collision risk). 45 is clear of
    // every other registered job's second (0, 5/20/35/50, 10, 15/17/19, 25,
    // 30, 40).
    new Cron("45 16 3 * * *", { protect: true }, wrap("cleanupExpiredBotSessionsJob", cleanupExpiredBotSessionsJob)),
    // Second 25, NOT "*/1 * * * *" (which would fire on second 0): this sweep
    // writes up to MAX_ORDERS_PER_CYCLE anchor-clearing updates back to back
    // every tick — precisely the profile behind the P1008/P2028 write-lock
    // pile-up above, where several jobs landing on second 0 queued behind each
    // other on the same write locks until one blew past its lock timeout.
    // :25 is at least 5 seconds clear of every second already in use here:
    // 0 (autoCancelExpiredOrders + the hourly/6-hourly jobs), 5/20/35/50
    // (drainBroadcasts), 40 (announceStartedFlashSales), 15/17/19 (the QRIS
    // watchdogs) and 30 (storageCleanupJob).
    new Cron("25 * * * * *", { protect: true }, wrap("sweepPaidOrderBubbles", sweepPaidOrderBubbles)),
  ];
}
