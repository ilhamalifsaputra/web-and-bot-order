/**
 * CRUD for the Digiflazz-backed "Top Up Game" instant-checkout pilot —
 * plan for the checkoutFlow="instant" category (schema.prisma Category
 * .checkoutFlow, Denomination.autoDeliverySource/.supplierSku,
 * Order.digiflazzDispatchedAt).
 *
 * The HTTP/signature side (request shapes, MD5 signing) lives in
 * @app/core/suppliers/digiflazz; this module only mutates the DB and decides
 * when to call it. Mirrors crud/tokopay.ts's split between the two layers.
 *
 * Three responsibilities:
 *  - getDigiflazzCreds       — read the gateway credentials from Settings.
 *  - dispatchPendingDigiflazzOrders — the poller: find PROCESSING orders
 *    routed to Digiflazz and not yet dispatched, claim them one at a time,
 *    and place the top-up order with the supplier.
 *  - fulfillDigiflazzOrder   — the twin of orders.ts's fulfillManualOrder,
 *    for the "Sukses" (and later, webhook-driven) case: flips the order to
 *    DELIVERED and runs the same shared side effects a manually-fulfilled
 *    order gets.
 *
 * Retry safety: `refId = order.orderCode` is passed to every
 * createTransaction call (@app/core/suppliers/digiflazz — see its own doc
 * comment) and is Digiflazz's own idempotency key: a repeat call with the
 * same refId returns the existing transaction rather than creating a new
 * one. That is what makes it safe for this module to automatically retry a
 * "Pending" or transient-error (HTTP/network) outcome — re-dispatching the
 * same order never double-charges or double-delivers at the supplier.
 * recordDigiflazzOutcome (below) is the one place that decides retry vs.
 * terminal, bounded by the 24h backoff window in digiflazzBackoff.ts. An
 * explicit "Gagal" is never retried — the same input would just fail
 * identically again — and goes straight to a terminal, admin-alerted
 * failure instead.
 *
 * This whole argument rests on createTransaction's refId-dedup behavior
 * (@app/core/suppliers/digiflazz) actually working as documented — that
 * function's own doc comment carries an explicit "⚠ ASSUMPTION... Verify
 * against the live dashboard before go-live" flag on the exact request
 * shape/field names this depends on, not yet confirmed against a live
 * Digiflazz account (same hedge checkout.ts's webhook doc comment already
 * carries for this same call).
 */
import { OrderStatus, ProductType, DeliveryType } from "@app/core/enums";
import { Decimal, moneyEq } from "@app/core/money";
import { quantizeMoney } from "@app/core/formatters";
import { logger } from "@app/core/logger";
import { encryptDeliveredContent } from "@app/core/credentialCrypto";
import { ValidationError } from "@app/core/errors";
import { parseAdditionalFields, parseCustomerData } from "@app/core/deliveryFields";
import {
  createTransaction,
  getPriceList,
  parseProductRegion,
  digiflazzGroupKey,
  stripRegionSuffix,
  type DigiflazzCreds,
  type DigiflazzPriceListItem,
} from "@app/core/suppliers/digiflazz";
import { NicknameService } from "@app/core/nickname/service";
import { nicknameFieldMapping } from "@app/core/nickname/fieldMapping";
import type { PrismaClient } from "../client";
import type { Db } from "./_types";
import { getSetting, getDecryptedSetting } from "./settings";
import { getOrder, finalizeDeliverySideEffects } from "./orders";
import { resolveNicknameGate, buildNicknameProviderEntries } from "./nickname";
import { enqueueManualOrderAdminAlert, enqueueManualDeliveredDm, enqueueAdminDigiflazzResyncAborted } from "./notifications";
import { logAdminAction } from "./audit";
import {
  createCatalogProduct,
  createDenomination,
  updateDenomination,
  updateCatalogProduct,
  ensureUniqueSlug,
  slugify,
} from "./catalog";
import { nextDigiflazzRecheckAt } from "./digiflazzBackoff";
import { emitDigiflazzOrderStatusChanged, emitDigiflazzCatalogSyncChanged } from "@app/core/realtime/digiflazzEvents";
import { recordDigiflazzSyncStatus } from "./digiflazzSyncStatus";
import { recordPollHealth } from "./poll_health";
import {
  detect,
  normalize,
  extractFeatures,
  buildSkuKey,
  type DetectionResult,
  type KnowledgeBase,
  type CatalogIndex,
} from "@app/core/detection";
import { loadKnowledgeBase } from "./detectionKnowledge";
import { getCatalogIndex, bumpCatalogRevision } from "./detectionIndex";

/** Setting keys — not yet wired to any admin UI (a later task adds that);
 * this module is only the read-side resolver, matching the shape every other
 * `getXCreds` sibling (e.g. getTokopayCreds) already uses. */
export const DIGIFLAZZ_USERNAME_KEY = "digiflazz_username";
export const DIGIFLAZZ_API_KEY_KEY = "digiflazz_api_key";
export const DIGIFLAZZ_ENABLED_KEY = "digiflazz_enabled";

/** Read Digiflazz supplier credentials from Settings; null = the Digiflazz
 * auto-fulfilment path is off (either not configured, or explicitly
 * disabled). Mirrors getTokopayCreds's null-on-disabled-or-missing shape. */
export async function getDigiflazzCreds(db: Db): Promise<DigiflazzCreds | null> {
  const [username, apiKey, enabled] = await Promise.all([
    getSetting(db, DIGIFLAZZ_USERNAME_KEY),
    getDecryptedSetting(db, DIGIFLAZZ_API_KEY_KEY),
    getSetting(db, DIGIFLAZZ_ENABLED_KEY),
  ]);
  if (!username || !apiKey) return null;
  if ((enabled ?? "").trim().toLowerCase() === "false") return null;
  return { username, apiKey };
}

/**
 * Format one order's buyer-supplied answers (Order.customerData — one
 * {fieldKey: answer} map per unit, see @app/core/deliveryFields) into the
 * `customer_no` string Digiflazz expects for this denomination's SKU.
 *
 * ⚠ ASSUMPTION: Digiflazz's real per-SKU customer_no format (a single game
 * id vs. a combined "id server" pair, and the exact separator) isn't
 * knowable generically from this repo — this joins every non-empty answer
 * for the order's first unit, in the SKU's field-definition order, with a
 * single space. Reasonable pilot default, NOT a verified Digiflazz
 * convention; may need per-SKU customization once real SKUs are onboarded
 * (see the ⚠ ASSUMPTION notes throughout @app/core/suppliers/digiflazz for
 * the same caveat on the wire format itself).
 */
export function buildDigiflazzCustomerNo(
  product: { additionalFields: string | null },
  customerDataJson: string | null,
): string {
  const fields = parseAdditionalFields(product.additionalFields);
  const unit = parseCustomerData(customerDataJson)[0] ?? {};
  return fields
    .map((field) => unit[field.key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .join(" ");
}

export type DigiflazzItemResolution =
  | { ok: true; supplierSku: string; product: { additionalFields: string | null } }
  | { ok: false; reason: string };

/**
 * The single "is this order a valid one-unit Digiflazz dispatch?" rule,
 * shared by dispatchPendingDigiflazzOrders (the poller) and
 * fulfillDigiflazzOrder's order-kind guard, and by the storefront webhook's
 * live re-verification flow (checkout.ts POST /pay/digiflazz/callback).
 * Refuses (never throws) unless there is EXACTLY ONE Digiflazz-routed item at
 * quantity 1.
 */
export function resolveSingleDigiflazzItem(order: {
  items: {
    quantity: number;
    product: { supplierSku: string | null; additionalFields: string | null; autoDeliverySource: string | null };
  }[];
}): DigiflazzItemResolution {
  // I6 fix: don't assume the Digiflazz-routed item is order.items[0] — an
  // order can carry other, non-Digiflazz lines alongside it (or none at all,
  // for an order that isn't Digiflazz-routed in the first place).
  const digiflazzItems = order.items.filter((i) => i.product.autoDeliverySource === "digiflazz");
  const item = digiflazzItems[0];
  if (!item) {
    // Hit by a plain (non-Digiflazz) order, e.g. the storefront webhook
    // looking up an order that isn't Digiflazz-routed at all — distinct from
    // the "item exists but is misconfigured" case below so the message
    // doesn't imply a Digiflazz item exists when there simply isn't one.
    return { ok: false, reason: "this order has no Digiflazz-routed item" };
  }
  const supplierSku = item.product.supplierSku;
  if (!supplierSku) {
    return { ok: false, reason: "the SKU has no supplierSku configured" };
  }

  // N1 defense-in-depth: exactly ONE Digiflazz unit per order — either a
  // single line with quantity > 1, or more than one Digiflazz-routed line in
  // the same order, both count as "more than 1 unit" from the supplier's
  // point of view and must be refused rather than partially dispatched.
  if (digiflazzItems.length !== 1 || item.quantity !== 1) {
    const reason =
      digiflazzItems.length === 1
        ? `this order's Digiflazz item has quantity ${item.quantity} — auto-delivery only supports quantity 1 per order, needs manual review`
        : `this order has ${digiflazzItems.length} Digiflazz line(s) totaling quantity ${digiflazzItems.reduce((sum, i) => sum + i.quantity, 0)} — auto-delivery only supports a single line of quantity 1 per order, needs manual review`;
    return { ok: false, reason };
  }

  return { ok: true, supplierSku, product: { additionalFields: item.product.additionalFields } };
}

/** Minimal shape dispatchPendingDigiflazzOrders needs per candidate order —
 * a narrower include than orders.ts's full getOrder, since the poller only
 * needs enough to place the supplier order and, on failure, alert admins. */
type DigiflazzCandidateOrder = {
  id: number;
  orderCode: string;
  customerData: string | null;
  totalAmount: Decimal;
  currency: string;
  digiflazzDispatchedAt: Date | null;
  digiflazzAttempts: number;
  items: {
    quantity: number;
    product: {
      name: string;
      supplierSku: string | null;
      additionalFields: string | null;
      autoDeliverySource: string | null;
      /** The Denomination's own nickname-check fields (confusingly, this
       * `product` relation on OrderItem actually points at a Denomination
       * row — see schema.prisma's own comments — and Denomination's OWN
       * `product` relation below points at the real Product row). Needed
       * only for the reactive account/region diagnostic terminalFailDigiflazzOrder
       * runs when Digiflazz itself gave no failure reason — see this file's
       * module doc comment and resolveNicknameGate (./nickname).
       *
       * `product` (the nested Product row) is declared OPTIONAL here purely
       * for structural-typing convenience — both real callers now actually
       * join it: the poller's own dispatchPendingDigiflazzOrders query below,
       * and the storefront webhook's live re-check (checkout.ts POST
       * /pay/digiflazz/callback), which fetches via getOrderByCode
       * (packages/db/src/crud/orders.ts) — that function now nests this same
       * `product.product` sub-object too, so catalog auto-detect works from
       * both entry points. computeAccountDiagnosticNote still treats a
       * missing/undefined product exactly like a null one (no catalog
       * auto-detect possible), as a defensive fallback only. */
      nicknameCheckGameCode: string | null;
      product?: { digiflazzBrand: string | null; name: string } | null;
    };
  }[];
};

/** Tally of one dispatchPendingDigiflazzOrders pass, for the caller (a later
 * task's cron job) to log. */
export interface DigiflazzDispatchSummary {
  /** Candidate orders this call won the atomic claim on and actually called
   * Digiflazz for (excludes orders a concurrent/earlier tick already claimed). */
  claimed: number;
  /** Of the claimed orders, how many Digiflazz reported "Sukses" for and
   * were fulfilled (DELIVERED) in this same pass. */
  delivered: number;
  /** Of the claimed orders, how many are still in flight — either Digiflazz
   * reported Pending, or the HTTP call itself failed transiently, and either
   * way a recheck is scheduled within the 24h backoff window (see
   * digiflazzBackoff.ts). */
  pending: number;
  /** Of the claimed orders, how many reached a terminal failure this pass —
   * Digiflazz explicitly reported Gagal, the order failed structural
   * validation (missing supplierSku / wrong quantity), or a Pending/
   * transient-error recheck exhausted its 24h backoff window without
   * resolving. Each of these enqueued an admin alert and left the order
   * PROCESSING for a human to finish via fulfillManualOrder. */
  failed: number;
}

const ZERO_SUMMARY: DigiflazzDispatchSummary = { claimed: 0, delivered: 0, pending: 0, failed: 0 };

/** How long a recheck claim's lease lasts before the order becomes
 * eligible for re-claiming again — self-heals a crashed/killed attempt
 * (a process restart between the claim committing and
 * recordDigiflazzOutcome writing the real outcome) instead of leaving the
 * order permanently unclaimable (neither candidate-query arm would ever
 * match a bare `null`, since arm 1 needs digiflazzDispatchedAt: null —
 * already false by the time of a recheck — and arm 2 needs
 * digiflazzNextRecheckAt <= now, never true for null). Comfortably longer
 * than a single createTransaction HTTP round-trip (HTTP_TIMEOUT_MS.gatewayWrite,
 * @app/core/http) with generous margin, short enough that a genuinely
 * crashed attempt recovers within a couple of poller ticks rather than
 * being stuck until the 24h window silently expires with nobody paged. */
export const DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS = 3 * 60_000;

/**
 * Atomically claim the right for a Digiflazz callback to run one live
 * re-check (`createTransaction` with the order's refId) — backend audit,
 * Task B3d. The callback's signature, md5(refId:apiKey), is a fixed token
 * that replays forever, and that re-POST is only a harmless status check if
 * Digiflazz really dedups by ref_id (an unverified assumption, see
 * createTransaction in @app/core/suppliers/digiflazz). So a callback may
 * re-check only an order that:
 *   - is PROCESSING and has already been dispatched by the poller
 *     (digiflazzDispatchedAt set) — a callback must never place the FIRST
 *     purchase;
 *   - is still "pending_at_supplier" — never one whose dispatch already
 *     failed terminally and is waiting for a human;
 *   - has no /transaction call in flight. Every in-flight call (poller fresh
 *     dispatch, poller recheck, a previous callback) holds a lease by setting
 *     digiflazzNextRecheckAt to at most now + DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS,
 *     so a recheck time inside that window is treated as leased. A scheduled
 *     backoff that happens to fall inside the window is refused too — the
 *     poller rechecks that order within the window anyway, so a refused
 *     genuine callback delays delivery by at most the lease, never loses it.
 * Winning the claim takes the lease itself; recordDigiflazzOutcome /
 * fulfillDigiflazzOrder then overwrite or clear it as usual.
 */
export async function claimDigiflazzWebhookRecheck(db: Db, orderId: number, now: Date = new Date()): Promise<boolean> {
  const leaseUntil = new Date(now.getTime() + DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS);
  const claim = await db.order.updateMany({
    where: {
      id: orderId,
      status: OrderStatus.PROCESSING,
      digiflazzDispatchedAt: { not: null },
      digiflazzStatus: "pending_at_supplier",
      OR: [
        { digiflazzNextRecheckAt: null },
        { digiflazzNextRecheckAt: { lte: now } },
        { digiflazzNextRecheckAt: { gt: leaseUntil } },
      ],
    },
    data: { digiflazzNextRecheckAt: leaseUntil },
  });
  return claim.count === 1;
}

/**
 * Enqueue the "needs a human" admin alert for an order this poller could not
 * auto-fulfil via Digiflazz (SKU missing supplierSku, Digiflazz reported
 * "Gagal", or the HTTP call itself threw) — same channel/shape
 * fulfillManualOrder's own admin alert already uses
 * (enqueueManualOrderAdminAlert, ADMIN_MANUAL_ORDER_QUEUED), since the
 * remedy is identical: a human finishes the order via the existing
 * fulfillManualOrder path. Also writes an AuditLog row (system actor, no
 * human admin id) so there's a forensic trail for why an order that reached
 * PROCESSING never auto-delivered.
 *
 * Exported (not just used internally by dispatchPendingDigiflazzOrders) so
 * the storefront's Digiflazz webhook route (checkout.ts, POST
 * /pay/digiflazz/callback) can raise the same alert for a "Gagal" callback
 * without duplicating this message text or the audit-log call.
 */
export async function alertDigiflazzDispatchFailed(
  db: Db,
  order: DigiflazzCandidateOrder,
  reason: string,
  /** The reactive KokinPay account/region diagnostic note (see
   * terminalFailDigiflazzOrder), when one was computed for this failure —
   * folded into the audit log as a second sentence. Omitted/null for a
   * failure that never ran the diagnostic (e.g. Digiflazz gave its own
   * reason, or this alert came from a non-diagnostic caller). */
  accountDiagnosticNote?: string | null,
): Promise<void> {
  await enqueueManualOrderAdminAlert(db, {
    orderId: order.id,
    orderCode: order.orderCode,
    items: order.items.map((item) => ({ name: item.product.name, qty: item.quantity })),
    total: order.totalAmount,
    currency: order.currency,
  });
  const details = accountDiagnosticNote
    ? `Digiflazz gagal — perlu ditangani manual. Order ${order.orderCode}: ${reason}. ${accountDiagnosticNote}`
    : `Digiflazz gagal — perlu ditangani manual. Order ${order.orderCode}: ${reason}`;
  await logAdminAction(db, {
    adminId: null,
    action: "order.digiflazz_dispatch_failed",
    targetType: "order",
    targetId: order.id,
    details,
  });
  logger.warn(
    `Digiflazz dispatch failed for order ${order.orderCode} (${reason}) — queued for manual fulfilment and alerted admins`,
  );
}

/** Turns a fulfillDigiflazzOrder failure into a natural-language sentence
 * for the admin-facing alert/audit text (CLAUDE.md: audit log details
 * must read as a sentence, never a raw i18n key). fulfillDigiflazzOrder
 * only ever throws ValidationError with one of a closed, small set of
 * keys (or, for a non-ValidationError failure — an unexpected DB error —
 * whatever that error's own message already is, which is already
 * natural text, not a key). */
function describeFulfillFailure(err: unknown): string {
  if (err instanceof ValidationError) {
    switch (err.key) {
      case "error.order_not_processing":
        return "the order was no longer PROCESSING by the time delivery ran (likely already resolved by another process)";
      case "error.order_not_found":
        return "the order could not be found";
      case "error.order_not_digiflazz":
        return "the order is no longer recognized as a single-item Digiflazz order";
      default:
        return err.key; // any future ValidationError key this function doesn't know about yet — still better than nothing, and cheap to extend
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export type DigiflazzOutcome =
  | { kind: "pending" }
  | { kind: "transient_error"; message: string }
  | {
      kind: "terminal";
      reason: string;
      /** Whether Digiflazz's own "Gagal" response carried real content in
       * its `message` field (or, for a structural resolution failure like a
       * missing supplierSku, always true — that's a config problem, not a
       * "Digiflazz gave no reason" case). Only when this is false does
       * terminalFailDigiflazzOrder run the reactive KokinPay account/region
       * diagnostic — see this file's module doc comment and the "Gagal"
       * branch in dispatchPendingDigiflazzOrders, the one place this
       * distinction is still knowable (by the time a raw Digiflazz response
       * becomes a DigiflazzOutcome, `reason` has already been folded into
       * one string and "empty" is no longer a usable signal). */
      supplierGaveReason: boolean;
    };

/**
 * Single place that decides what a non-Sukses Digiflazz dispatch/recheck
 * attempt does to an order's digiflazz* fields — shared by the poller
 * (dispatchPendingDigiflazzOrders, below) and the storefront webhook's
 * live re-check (checkout.ts POST /pay/digiflazz/callback, a later task)
 * so the two entry points can never drift on what "Pending"/"Gagal"/a
 * thrown error means for these fields. Never called for "Sukses" — that
 * outcome goes straight to fulfillDigiflazzOrder instead.
 *
 * - "pending" (Digiflazz said Pending) and "transient_error" (the HTTP
 *   call itself threw — network/timeout/malformed response) share the
 *   SAME backoff-recheck logic: safe to retry because refId=order.orderCode
 *   is Digiflazz's own idempotency key (see this file's module doc
 *   comment / createTransaction's own doc comment). Computes the next
 *   attempt via nextDigiflazzRecheckAt (digiflazzBackoff.ts); if a next
 *   recheck time exists within the 24h window, the order stays
 *   "pending_at_supplier" with digiflazzAttempts/digiflazzNextRecheckAt
 *   advanced. digiflazzFailureDetail is cleared to null on a clean
 *   "pending" (nothing is actually wrong), but set to the error message
 *   on "transient_error" — so an admin can see WHY the last attempt
 *   failed even while it's still being retried, not only once it goes
 *   terminal. If the 24h window is exhausted, falls through to the same
 *   terminal handling "terminal" gets below (same remedy either way: a
 *   human must finish the order).
 * - "terminal" (explicit "Gagal", or a structural resolution failure like
 *   a missing supplierSku) never retries — the same input would fail
 *   identically again — and immediately alerts admins via
 *   alertDigiflazzDispatchFailed, same as today's Gagal handling.
 *
 * Returns "pending" or "failed" so the caller can tally its own summary
 * counters without re-deriving this same branch logic.
 */
export async function recordDigiflazzOutcome(
  db: PrismaClient,
  order: DigiflazzCandidateOrder,
  outcome: DigiflazzOutcome,
  dispatchedAt: Date,
): Promise<"pending" | "failed"> {
  if (outcome.kind !== "terminal") {
    const attempt = order.digiflazzAttempts + 1;
    const nextRecheckAt = nextDigiflazzRecheckAt(dispatchedAt, attempt);
    if (nextRecheckAt) {
      const claim = await db.order.updateMany({
        where: { id: order.id, status: OrderStatus.PROCESSING },
        data: {
          digiflazzStatus: "pending_at_supplier",
          digiflazzAttempts: attempt,
          digiflazzNextRecheckAt: nextRecheckAt,
          digiflazzFailureDetail: outcome.kind === "transient_error" ? outcome.message : null,
        },
      });
      if (claim.count === 1) emitDigiflazzOrderStatusChanged(order.id);
      return "pending";
    }
    const reason =
      outcome.kind === "pending"
        ? "Digiflazz never resolved this order within 24h of dispatch — still reporting Pending"
        : `Digiflazz dispatch kept failing transiently for 24h and gave up retrying (last error: ${outcome.message})`;
    // Both of these reasons are always-meaningful, structural explanations
    // (a 24h backoff window exhausted) — never a "Digiflazz gave no reason"
    // case, so the reactive diagnostic below must not run for them.
    return terminalFailDigiflazzOrder(db, order, reason, true);
  }
  return terminalFailDigiflazzOrder(db, order, outcome.reason, outcome.supplierGaveReason);
}

/**
 * The reactive account/region diagnostic: when Digiflazz's own "Gagal"
 * report gave no specific reason (supplierGaveReason: false at the call
 * site — see terminalFailDigiflazzOrder below), run a best-effort KokinPay
 * nickname lookup on the order's target account so the admin reviewing the
 * failure has a hint whether it's a wrong-ID/region problem or something
 * else. Reuses resolveNicknameGate/buildNicknameProviderEntries (the same
 * functions the 3 pre-checkout nickname-check call sites use) — never
 * duplicates their resolution logic.
 *
 * Deliberately silent (returns null, never throws) for every "we couldn't
 * tell" case — no matching game, no KokinPay credentials, no target on the
 * order, or a non-definitive lookup result — so a diagnostic that can't say
 * anything useful never blocks or pollutes the existing failure-handling
 * path (alert/audit log/realtime emit) it runs inside of. The whole body
 * runs inside a try/catch for the same reason: buildNicknameProviderEntries
 * → getKokinpayCreds → getDecryptedSetting → decryptCredentials can throw
 * CredentialKeyConfigError when CREDENTIAL_ENCRYPTION_KEY is unset/
 * misconfigured (widened to cover this the same way apiTopup.ts's own
 * nickname-check catch does — see its comment "Widened to also cover
 * getKokinpayCreds above"), and if that throw escaped here it would
 * propagate through terminalFailDigiflazzOrder → recordDigiflazzOutcome into
 * the poller's outer catch around the Digiflazz createTransaction call,
 * misclassifying a genuine terminal failure as a transient HTTP error.
 */
async function computeAccountDiagnosticNote(
  db: PrismaClient,
  order: DigiflazzCandidateOrder,
): Promise<string | null> {
  try {
    // Don't assume the Digiflazz-routed item is at index 0 — an order can
    // carry other, non-Digiflazz lines alongside it (same rule
    // resolveSingleDigiflazzItem above applies; `autoDeliverySource` is
    // already selected on this nested `product` object by
    // dispatchPendingDigiflazzOrders's query).
    const item = order.items.find((i) => i.product.autoDeliverySource === "digiflazz");
    const denomination = item?.product; // NOTE: confusingly, OrderItem's relation field is
    // literally named `product` but points at a Denomination row (this repo's
    // schema renamed the old products table to denominations); denomination.product
    // (yes, again) is the ACTUAL Product row, which has digiflazzBrand/name.
    if (!denomination) return null;

    const { gameCode, requiresZone, requiresServer } = resolveNicknameGate(denomination);
    if (!gameCode) return null;

    const entries = await buildNicknameProviderEntries(db, gameCode);
    if (entries.length === 0) return null;

    // Resolve target/zone/server through the SAME nicknameFieldMapping the
    // write side (nicknameCheck.ts) now uses, keyed off this denomination's
    // OWN additionalFields — NOT the old hardcoded {target,zone,server}
    // shape, which only ever matched bot-originated orders and left this
    // diagnostic permanently dead for every storefront-placed order
    // (final-review round 2 fix). Falls back to the legacy {target,zone,
    // server} keys for backward compat with any order already in PROCESSING
    // at deploy time whose customerData was written by the pre-fix
    // nicknameCheck.ts.
    const unit = parseCustomerData(order.customerData)[0] ?? {};
    const fields = parseAdditionalFields(denomination.additionalFields);
    const mapping = nicknameFieldMapping(fields, requiresZone, requiresServer);
    const target = (mapping ? unit[mapping.targetKey] : undefined) || unit.target;
    if (!target) return null;
    const zone = (mapping?.zoneKey ? unit[mapping.zoneKey] : undefined) || unit.zone;
    const server = (mapping?.serverKey ? unit[mapping.serverKey] : undefined) || unit.server;

    const result = await new NicknameService(entries).checkNickname({ target, zone, server });
    if (result.status === "found") {
      return `KokinPay: akun ditemukan (nickname "${result.nickname}") — kemungkinan bukan masalah ID/region.`;
    }
    if (result.status === "not_found" && result.definitive) {
      return `KokinPay: akun tidak ditemukan untuk kode game ${gameCode} — kemungkinan salah ID/region.`;
    }
    // Any other status (no_providers_configured — already ruled out above by
    // the entries.length check, but kept exhaustive — or a non-definitive
    // not_found) — don't write a misleading note.
    return null;
  } catch (err) {
    // No credentials, no stack trace with secrets — just enough for an
    // operator to notice the diagnostic is silently degrading for every
    // order, not a specific customer's data. warn (not info): this usually
    // means CredentialKeyConfigError fired, which makes this reactive
    // diagnostic silently dead fleet-wide until the config is fixed — that's
    // worth an operator's attention, not routine noise.
    logger.warn(
      { err, orderId: order.id },
      "Could not compute the reactive account diagnostic for one Digiflazz order — proceeding without a diagnostic note; this order's terminal failure is otherwise unaffected.",
    );
    return null;
  }
}

/** Shared terminal-failure tail for recordDigiflazzOutcome above: writes
 * the order's digiflazz* fields to their terminal-failed shape, alerts
 * admins via alertDigiflazzDispatchFailed (unchanged), and emits the
 * realtime status-changed event. Not exported — recordDigiflazzOutcome is
 * the only entry point callers (this file and, later, the webhook) use.
 *
 * `supplierGaveReason` gates the reactive account/region diagnostic
 * (computeAccountDiagnosticNote above): only when Digiflazz's own "Gagal"
 * report carried no real explanation of its own is it worth running a
 * fallback KokinPay lookup — see this file's module doc comment for why
 * "reason is non-empty" isn't a usable trigger on its own (every call site
 * already folds a fallback string in even when Digiflazz gave nothing). */
async function terminalFailDigiflazzOrder(
  db: PrismaClient,
  order: DigiflazzCandidateOrder,
  reason: string,
  supplierGaveReason: boolean,
): Promise<"failed"> {
  const accountDiagnosticNote = supplierGaveReason ? null : await computeAccountDiagnosticNote(db, order);

  const claim = await db.order.updateMany({
    where: { id: order.id, status: OrderStatus.PROCESSING },
    data: {
      digiflazzStatus: "failed",
      digiflazzNextRecheckAt: null,
      digiflazzFailureDetail: reason,
      // Never overwrite a previous note with null when this particular call
      // didn't produce one.
      ...(accountDiagnosticNote ? { accountDiagnosticNote } : {}),
    },
  });
  if (claim.count === 1) {
    await alertDigiflazzDispatchFailed(db, order, reason, accountDiagnosticNote);
    emitDigiflazzOrderStatusChanged(order.id);
  }
  return "failed";
}

/**
 * The Digiflazz dispatch poller. Finds PROCESSING orders whose item routes to
 * Digiflazz (denomination.autoDeliverySource === "digiflazz") and matches
 * EITHER of two candidate-query arms: (1) haven't been dispatched yet
 * (digiflazzDispatchedAt IS NULL), or (2) are due for a recheck of a
 * previous "Pending"/transient-error attempt (digiflazzStatus ===
 * "pending_at_supplier" AND digiflazzNextRecheckAt has passed — see
 * recordDigiflazzOutcome's own doc comment below for how that backoff
 * schedule is decided). Claims each one atomically (same
 * updateMany-with-status-guard shape fulfillManualOrder's own claim uses,
 * applied to the dispatch step instead of the delivery step — see
 * Order.digiflazzDispatchedAt's doc comment in schema.prisma), and places the
 * top-up order with Digiflazz.
 *
 * No-op (returns the zero summary, touches nothing) if Digiflazz isn't
 * configured — never claims orders it can't actually dispatch.
 *
 * Each candidate is claimed and dispatched one at a time (not batched inside
 * one transaction): a supplier HTTP round-trip
 * inside a long-held transaction would hold a connection and its locks, so the
 * atomic claim is its own short write and the HTTP call happens outside it —
 * same reasoning as enqueueFlashSaleBroadcast's chunking.
 *
 * COUPLING WARNING (final whole-branch review): the `autoDeliverySource:
 * "digiflazz"` filter below is a hardcoded literal — this is the ONLY
 * dispatcher that exists, so any Denomination whose `autoDeliverySource` is
 * some other provider string is picked up by NO dispatcher at all and its
 * paid orders sit in the manual queue forever.
 * `packages/db/src/crud/productProviderMappings.ts`'s
 * resolveDenominationProvider can write such a value (its own comment names
 * this and the other two affected sites: `@app/core/cartComposition`'s
 * DIGIFLAZZ_SOURCE/cartKindOf and apps/storefront/src/routes/api.ts's
 * single-unit guard). Not reachable today (no production caller of that
 * resolver yet), but a real multi-provider dispatch registry is required
 * before a second transaction provider is ever onboarded through that table.
 */
export async function dispatchPendingDigiflazzOrders(db: PrismaClient): Promise<DigiflazzDispatchSummary> {
  const creds = await getDigiflazzCreds(db);
  if (!creds) return ZERO_SUMMARY;

  const now = new Date();
  const candidates: DigiflazzCandidateOrder[] = await db.order.findMany({
    where: {
      status: OrderStatus.PROCESSING,
      items: { some: { product: { autoDeliverySource: "digiflazz" } } },
      OR: [
        { digiflazzDispatchedAt: null },
        { digiflazzStatus: "pending_at_supplier", digiflazzNextRecheckAt: { lte: now } },
      ],
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              name: true,
              supplierSku: true,
              additionalFields: true,
              autoDeliverySource: true,
              nicknameCheckGameCode: true,
              product: { select: { digiflazzBrand: true, name: true } },
            },
          },
        },
      },
    },
  });

  const summary: DigiflazzDispatchSummary = { claimed: 0, delivered: 0, pending: 0, failed: 0 };

  for (const order of candidates) {
    const isFreshDispatch = order.digiflazzDispatchedAt === null;
    const claimNow = new Date();
    // Atomic claim: only proceed to call Digiflazz if THIS call wins the
    // race (count === 1). A concurrent tick, a restarted poller, or a retry
    // that re-fetched the same candidate list all lose here instead of
    // double-dispatching the same order to the supplier — same guard as
    // before, now with a second shape covering the recheck branch (claims by
    // digiflazzStatus/digiflazzNextRecheckAt instead of digiflazzDispatchedAt
    // being null).
    //
    // The fresh-dispatch claim also takes the in-flight lease on
    // digiflazzNextRecheckAt (Task B3d), exactly like the recheck claim: it
    // tells claimDigiflazzWebhookRecheck that a /transaction call is in
    // flight, so a callback arriving mid-dispatch cannot fire a concurrent
    // one; and if this process dies before recording an outcome, the
    // recheck arm picks the order up once the lease lapses instead of it
    // sitting with a null recheck time forever.
    const claim = isFreshDispatch
      ? await db.order.updateMany({
          where: { id: order.id, status: OrderStatus.PROCESSING, digiflazzDispatchedAt: null },
          data: {
            digiflazzDispatchedAt: claimNow,
            digiflazzStatus: "pending_at_supplier",
            digiflazzNextRecheckAt: new Date(claimNow.getTime() + DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS),
          },
        })
      : await db.order.updateMany({
          where: {
            id: order.id,
            status: OrderStatus.PROCESSING,
            digiflazzStatus: "pending_at_supplier",
            digiflazzNextRecheckAt: { lte: claimNow },
          },
          data: { digiflazzNextRecheckAt: new Date(claimNow.getTime() + DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS) },
        });
    if (claim.count !== 1) continue;
    summary.claimed++;

    // dispatchedAt anchors the 24h backoff window: for a fresh dispatch
    // this is the claimNow just written above (this in-memory `order` row
    // was fetched BEFORE the claim, so order.digiflazzDispatchedAt is
    // still its pre-claim null here); for a recheck it's the already-set
    // original dispatch time, unchanged by this claim.
    const dispatchedAt = order.digiflazzDispatchedAt ?? claimNow;

    // I6/N1 fixes: resolveSingleDigiflazzItem is the single shared rule for
    // "find the order's Digiflazz-routed item(s) and refuse unless there is
    // exactly one at quantity 1" — see its doc comment above for the two
    // failure shapes (no/unconfigured item vs. more than one unit) it
    // distinguishes.
    const resolution = resolveSingleDigiflazzItem(order);
    if (!resolution.ok) {
      // A structural resolution failure (missing supplierSku, wrong
      // quantity) is always a specific, meaningful explanation — a config
      // problem, not a "Digiflazz gave no reason" one — so the reactive
      // diagnostic must never run for it.
      await recordDigiflazzOutcome(
        db,
        order,
        { kind: "terminal", reason: resolution.reason, supplierGaveReason: true },
        dispatchedAt,
      );
      summary.failed++;
      continue;
    }
    const { supplierSku } = resolution;

    const customerNo = buildDigiflazzCustomerNo(resolution.product, order.customerData);

    try {
      const result = await createTransaction(creds, {
        refId: order.orderCode,
        buyerSkuCode: supplierSku,
        customerNo,
      });

      if (result.status === "Sukses") {
        try {
          await fulfillDigiflazzOrder(db, order.id, { sn: result.sn ?? "" });
          summary.delivered++;
          logger.info(`Digiflazz auto-delivered order ${order.orderCode} (buyerSkuCode ${supplierSku})`);
        } catch (fulfillErr) {
          // Digiflazz already confirmed Sukses — this order must NEVER be
          // retried or re-dispatched (retrying would call Digiflazz again
          // for an order it already fulfilled; fulfillDigiflazzOrder's own
          // atomic claim would just throw ValidationError a second time
          // regardless). Whatever failed here — a side effect after the
          // DELIVERED claim already committed, or the claim itself losing
          // a race to another caller — needs a human, same as any other
          // terminal failure: alert directly (NOT via recordDigiflazzOutcome,
          // which would wrongly write pending/terminal digiflazz* fields
          // onto an order that may already be DELIVERED).
          const fulfillMessage = describeFulfillFailure(fulfillErr);
          await alertDigiflazzDispatchFailed(
            db,
            order,
            `Digiflazz confirmed Sukses but fulfilling the order failed (${fulfillMessage})`,
          );
          // The order genuinely transitioned PROCESSING -> DELIVERED (the
          // claim inside fulfillDigiflazzOrder committed before this later
          // side effect threw) — realtime subscribers must still hear about
          // that, even though this catch's own remedy is an admin alert
          // rather than a digiflazz* field write.
          emitDigiflazzOrderStatusChanged(order.id);
          summary.failed++;
        }
      } else if (result.status === "Pending") {
        const outcome = await recordDigiflazzOutcome(db, order, { kind: "pending" }, dispatchedAt);
        if (outcome === "pending") {
          summary.pending++;
          logger.info(
            `Digiflazz order ${order.orderCode} (buyerSkuCode ${supplierSku}) is Pending — scheduled for a recheck, awaiting the supplier's final report`,
          );
        } else {
          summary.failed++;
        }
      } else {
        const outcome = await recordDigiflazzOutcome(
          db,
          order,
          {
            kind: "terminal",
            reason: `Digiflazz reported Gagal${result.message ? ` (${result.message})` : ""}`,
            // Only true when Digiflazz's own `message` field carried real
            // content — a bare "Gagal" with no explanation is exactly the
            // case the reactive account/region diagnostic exists for (see
            // this file's module doc comment).
            supplierGaveReason: Boolean(result.message),
          },
          dispatchedAt,
        );
        summary.failed++;
        void outcome; // always "failed" for kind:"terminal" — see recordDigiflazzOutcome
      }
    } catch (err) {
      // The HTTP call itself failed (network error, timeout, malformed
      // response — see @app/core/suppliers/digiflazz's fetchDigiflazzJson).
      // err's message is already credential-free (the client's own
      // guarantee); never log err.cause or the request body. Unlike
      // before this task, this is now RETRIED (recordDigiflazzOutcome's
      // "transient_error" branch) rather than immediately terminal — see
      // this file's module doc comment for why that's safe.
      const message = err instanceof Error ? err.message : String(err);
      const outcome = await recordDigiflazzOutcome(db, order, { kind: "transient_error", message }, dispatchedAt);
      if (outcome === "pending") summary.pending++;
      else summary.failed++;
    }
  }

  return summary;
}

/**
 * Auto-fulfilment: Digiflazz reported "Sukses" (or, in a later task, its
 * webhook callback reports the same for a previously-Pending order). A twin
 * of orders.ts's fulfillManualOrder — same atomic PROCESSING -> DELIVERED
 * claim, same OrderStatusHistory write, same shared
 * finalizeDeliverySideEffects (referral commission, testimonial post,
 * bulk-purchase broadcast) — but the "content" delivered to the buyer is the
 * supplier's serial number rather than admin-typed text, and the actor
 * audited is the system, not a human admin.
 *
 * Reuses enqueueManualDeliveredDm/ORDER_MANUAL_DELIVERED_DM for the buyer DM
 * rather than a new event: that event's dispatcher already renders
 * Order.deliveredContent live at send time and never puts the content itself
 * in the outbox payload — exactly the shape this needs for the SN receipt.
 */
export async function fulfillDigiflazzOrder(
  db: Db,
  orderId: number,
  args: { sn: string },
) {
  const order = await getOrder(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");

  // I-4 fix (backend audit 2026-08-21): refuse to deliver an order that
  // isn't actually a single-unit Digiflazz-routed order, regardless of
  // caller — the single choke-point this function's every current AND
  // future caller (the poller, the webhook's live re-check, any later
  // caller) is forced through, rather than trusting each call site to have
  // already checked.
  if (!resolveSingleDigiflazzItem(order).ok) {
    throw new ValidationError("error.order_not_digiflazz");
  }

  const now = new Date();
  const claim = await db.order.updateMany({
    where: { id: orderId, status: OrderStatus.PROCESSING },
    data: {
      status: OrderStatus.DELIVERED,
      deliveredContent: encryptDeliveredContent(args.sn, orderId),
      deliveredAt: now,
      // Final whole-branch review I-1 (+ deferred #1/#2): this order is no
      // longer "in flight at the supplier" once it's DELIVERED — clear the
      // three digiflazz* fields the dispatch/recheck path set so they read
      // null once terminal (see this field's own doc comment in
      // schema.prisma), instead of permanently showing a stale
      // "pending_at_supplier" badge on every successfully auto-delivered
      // order. digiflazzAttempts/digiflazzDispatchedAt are left untouched —
      // those are historical facts about how the order got here, not
      // current in-flight state, and nothing renders them as if they were.
      digiflazzStatus: null,
      digiflazzNextRecheckAt: null,
      digiflazzFailureDetail: null,
    },
  });
  if (claim.count !== 1) throw new ValidationError("error.order_not_processing");
  await db.orderStatusHistory.create({
    data: { orderId, status: OrderStatus.DELIVERED, meta: "digiflazz_fulfill" },
  });

  await finalizeDeliverySideEffects(db, order, now);

  await enqueueManualDeliveredDm(db, {
    orderId,
    orderCode: order.orderCode,
    telegramId: order.user.telegramId,
    language: order.user.language,
  });

  await logAdminAction(db, {
    adminId: null,
    action: "order.auto_fulfill_digiflazz",
    targetType: "order",
    targetId: order.id,
    details: `Auto-fulfilled Digiflazz order ${order.orderCode} and sent the receipt to the buyer.`,
  });

  logger.info(`Auto-fulfilled Digiflazz order ${order.orderCode}`);
  const refreshed = await getOrder(db, orderId);
  emitDigiflazzOrderStatusChanged(orderId);
  return { order: refreshed! };
}

// ---- Import wizard: brand-grouping, matching, price computation, import, re-sync ----

export const DIGIFLAZZ_MARKUP_TYPE_KEY = "digiflazz_markup_type";
export const DIGIFLAZZ_MARKUP_VALUE_KEY = "digiflazz_markup_value";

/** The two-field Game ID + Server template every Digiflazz-imported
 * denomination gets by default — the same shape the original plan's Task 4
 * (manual admin entry) would have had the admin type by hand. Admin can still
 * edit or delete a field afterward through the existing field-builder UI. */
const DEFAULT_DIGIFLAZZ_FIELDS = [
  { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
  { key: "server_id", label: { id: "Server / Zone", en: "Server / Zone" }, type: "text", required: false, options: [], placeholder: "" },
];

/**
 * Digiflazz's price list can list the same buyerSkuCode more than once, from
 * different sellers at different prices — confirmed against Digiflazz's own
 * docs (developer.digiflazz.com/api/buyer/daftar-harga/): the API does not
 * pre-select a seller for the buyer. Collapse to one row per buyerSkuCode,
 * keeping the cheapest, so a duplicate SKU never becomes two lookalike
 * catalog rows (import) or a coin-flip cost value (re-sync). Every function
 * below that reads a raw price list calls this first.
 */
export function collapseToCheapestSeller(items: DigiflazzPriceListItem[]): DigiflazzPriceListItem[] {
  const bySku = new Map<string, DigiflazzPriceListItem>();
  for (const item of items) {
    const existing = bySku.get(item.buyerSkuCode);
    if (!existing || item.price.lessThan(existing.price)) {
      bySku.set(item.buyerSkuCode, item);
    }
  }
  return [...bySku.values()];
}

/** Digiflazz's price-list `type` value for a brand's base edition. Rows with
 * this type (case-insensitively), or with no type at all, carry no variant
 * suffix. */
export const DIGIFLAZZ_BASE_TYPE = "Umum";

/** The Product.gameVariant label written to the BASE subset when a brand is
 * split by type. Matches the term the shop owner sees in the Digiflazz
 * dashboard. */
export const DIGIFLAZZ_BASE_GAME_VARIANT = "Umum";

/**
 * Normalise a Digiflazz `type` value to a variant suffix, or null when it is
 * the base edition. null / "" / whitespace / case-insensitive "Umum" → null.
 * Otherwise the trimmed value in its original surface casing ("Infinite",
 * "Garena", "Global").
 */
export function digiflazzTypeSuffix(type: string | null | undefined): string | null {
  if (type == null) return null;
  const trimmed = type.trim();
  if (trimmed === "" || trimmed.toLowerCase() === DIGIFLAZZ_BASE_TYPE.toLowerCase()) return null;
  return trimmed;
}

export interface DigiflazzBrandGroup {
  /** Composite display name — `` `${rawBrand} (${region})` `` when a region
   * suffix was found on any row's productName, otherwise identical to
   * rawBrand (see digiflazzGroupKey). This is the value used as both
   * Product.name and Product.digiflazzBrand — i.e. the exact-match key
   * importDigiflazzBrand's upsert lookup uses. */
  brand: string;
  /** The original Digiflazz brand string this group's items were reported
   * under, before region-suffix splitting — for UI grouping/headers so a
   * multi-region brand can still be shown under one heading. */
  rawBrand: string;
  /** The region parsed from this group's rows' productName (parseProductRegion),
   * or null when no row had a (non-denylisted) region suffix. */
  region: string | null;
  items: DigiflazzPriceListItem[];
  /** Sub-edition label taken from Digiflazz's `type` field ("Infinite",
   * "Garena", "Global", …), or "Umum" for the base subset when this brand
   * was split by type; null when the brand was not split. Seeded into
   * Product.gameVariant on CREATE only (importDigiflazzBrand), never on
   * re-import of an existing Product. */
  gameVariant: string | null;
  /** Non-null when a Product with this exact digiflazzBrand already exists —
   * the wizard renders this group read-only ("Sudah ada"; updates flow
   * through resyncDigiflazzCatalog, not a re-import). */
  existingProductId: number | null;
  /** Shadow-mode detection result for this group's items[0], informational
   * only until the Task 12 cutover gate. Never feeds back into
   * brand/region/existingProductId above (those are the production re-sync
   * matching keys). Undefined when the detection engine could not be set up
   * for this call (a load failure is logged and swallowed). */
  detection?: DetectionResult;
}

/**
 * Group a raw Digiflazz price-list fetch by a composite key of its `brand`
 * field plus any region suffix parsed out of `productName`
 * (digiflazzGroupKey) — Digiflazz encodes a SKU's region as a trailing
 * `(Region)` parenthetical on productName rather than as a distinct `brand`
 * string, so grouping by `brand` alone previously mixed every region's
 * denominations (Indonesia, Filipina, Russia, Brazil, ...) into one product.
 * Also marks which groups already have a matching Product via
 * Product.digiflazzBrand. Collapses to the cheapest seller per buyerSkuCode
 * first (see collapseToCheapestSeller) — a group's `items` never contains two
 * rows for the same SKU.
 *
 * Non-regression (region): for a brand where no row's productName has a
 * (non-denylisted) region suffix, digiflazzGroupKey's displayName equals the
 * raw brand string, so the composite key is byte-identical to today's plain
 * `item.brand` — every brand already imported into the DB continues to match
 * on the next sync (see digiflazzGroupKey/parseProductRegion's denylist in
 * @app/core/suppliers/digiflazz).
 *
 * Non-regression (type): for a brand whose rows all normalise to the same
 * `digiflazzTypeSuffix` (including every row `type:"Umum"` and every row a
 * single other type), the distinct-suffix count is 1, the split branch never
 * runs, and `displayName` is byte-identical to the pre-change value, so
 * `existingProductId` and `importDigiflazzBrand`'s `findFirst` both still
 * match every already-imported Product. A split only happens when one brand
 * reports ≥ 2 different `type` values — a two-stage grouping: Stage 1 buckets
 * by the region-aware display key (unchanged), Stage 2 sub-groups a bucket by
 * `digiflazzTypeSuffix` into a base subset (`gameVariant: "Umum"`) plus one
 * group per non-null suffix (`gameVariant` = that suffix). Existing catalog
 * data and every test fixture use `type:"Umum"` only, so this is inert until
 * the import wizard runs against a brand Digiflazz reports with mixed types.
 */
export async function groupDigiflazzPriceListByBrand(
  db: Db,
  rawItems: DigiflazzPriceListItem[],
): Promise<DigiflazzBrandGroup[]> {
  const items = collapseToCheapestSeller(rawItems);

  // Stage 1 (unchanged): bucket every item by its region-aware display key
  // (digiflazzGroupKey) — the raw brand plus any "(Region)" suffix parsed off
  // productName. Map insertion order is preserved for deterministic output.
  const stage1 = new Map<string, { rawBrand: string; region: string | null; items: DigiflazzPriceListItem[] }>();
  // Distinct digiflazzTypeSuffix values seen per RAW Digiflazz brand, across
  // every region bucket — a brand is type-split only when this set has ≥ 2
  // entries (null, the base edition, counts as one). Keyed by rawBrand, not by
  // the Stage-1 key, so a brand's "Umum" rows and its "Global" rows still
  // count together even when they land in different region buckets.
  const suffixesByRawBrand = new Map<string, Set<string | null>>();
  for (const item of items) {
    if (!item.brand) continue;
    const { displayName, region } = digiflazzGroupKey(item.brand, item.productName);
    const bucket = stage1.get(displayName) ?? { rawBrand: item.brand, region, items: [] };
    bucket.items.push(item);
    stage1.set(displayName, bucket);

    const suffixes = suffixesByRawBrand.get(item.brand) ?? new Set<string | null>();
    suffixes.add(digiflazzTypeSuffix(item.type));
    suffixesByRawBrand.set(item.brand, suffixes);
  }

  // Stage 2 (new): within each Stage-1 bucket whose rawBrand reports ≥ 2
  // distinct type suffixes, sub-group by digiflazzTypeSuffix — base subset
  // (suffix null) first, then the non-null suffixes ascending by `<`. A bucket
  // whose rawBrand has ≤ 1 distinct suffix is emitted unchanged (byte-
  // identical displayName, gameVariant null), so every brand already in the
  // catalog is untouched.
  type PreGroup = {
    brand: string;
    rawBrand: string;
    region: string | null;
    gameVariant: string | null;
    items: DigiflazzPriceListItem[];
  };
  const preGroups: PreGroup[] = [];
  for (const [displayName, bucket] of stage1) {
    const distinctSuffixes = suffixesByRawBrand.get(bucket.rawBrand)!;
    if (distinctSuffixes.size <= 1) {
      preGroups.push({
        brand: displayName,
        rawBrand: bucket.rawBrand,
        region: bucket.region,
        gameVariant: null,
        items: bucket.items,
      });
      continue;
    }

    // Type-split this bucket, preserving item order within each sub-group.
    const bySuffix = new Map<string | null, DigiflazzPriceListItem[]>();
    for (const item of bucket.items) {
      const suffix = digiflazzTypeSuffix(item.type);
      const list = bySuffix.get(suffix) ?? [];
      list.push(item);
      bySuffix.set(suffix, list);
    }

    // Base subset first — byte-identical displayName, only gameVariant differs.
    const baseItems = bySuffix.get(null);
    if (baseItems && baseItems.length > 0) {
      preGroups.push({
        brand: displayName,
        rawBrand: bucket.rawBrand,
        region: bucket.region,
        gameVariant: DIGIFLAZZ_BASE_GAME_VARIANT,
        items: baseItems,
      });
    }

    // Then each non-null suffix, ascending by `<`.
    const nonNullSuffixes = [...bySuffix.keys()]
      .filter((s): s is string => s !== null)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const suffix of nonNullSuffixes) {
      const subItems = bySuffix.get(suffix)!;
      const representativeProductName = subItems[0]!.productName;
      // Region dedupe: when the type suffix already names this bucket's region
      // (e.g. type:"Global" on rows all ending "(Global)"), the region is
      // expressed twice — fold it into the suffix and drop the paren so the
      // displayName is "Free Fire Global", not "Free Fire Global (Global)".
      const regionDuplicatesSuffix =
        bucket.region != null && bucket.region.toLowerCase() === suffix.toLowerCase();
      const nameForKey = regionDuplicatesSuffix
        ? stripRegionSuffix(representativeProductName)
        : representativeProductName;
      const split = digiflazzGroupKey(`${bucket.rawBrand} ${suffix}`, nameForKey);
      preGroups.push({
        brand: split.displayName,
        rawBrand: bucket.rawBrand,
        region: regionDuplicatesSuffix ? null : split.region,
        gameVariant: suffix,
        items: subItems,
      });
    }
  }

  // existingProductId + shadow detection are computed against the FINAL
  // (post-split) displayName set — one findMany over every emitted brand.
  const finalBrands = preGroups.map((g) => g.brand);
  const existing = await db.product.findMany({
    where: { digiflazzBrand: { in: finalBrands } },
    select: { id: true, digiflazzBrand: true },
  });
  const existingByBrand = new Map(existing.map((p) => [p.digiflazzBrand!, p.id]));

  // Shadow-mode detection (Task 10): classify each group's representative
  // item and attach the DetectionResult for informational use only. This is
  // additive — it never influences `brand`/`region`/`existingProductId`,
  // which stay byte-identical to their pre-Task-10 values. A setup failure
  // (e.g. the detection tables are unavailable) is logged and swallowed so
  // grouping never regresses.
  let knowledge: KnowledgeBase | null = null;
  let catalogIndex: CatalogIndex | null = null;
  try {
    [knowledge, catalogIndex] = await Promise.all([loadKnowledgeBase(db), getCatalogIndex(db)]);
  } catch (err) {
    logger.warn(
      { err },
      "Shadow-mode detection setup failed while grouping the Digiflazz price list — groups are returned without a detection field for this run.",
    );
  }

  return preGroups.map((group) => {
    const representative = group.items[0];
    let detection: DetectionResult | undefined;
    if (knowledge && catalogIndex && representative) {
      // detect() is documented as never throwing, but a shadow-mode field
      // must never be able to break production grouping regardless — guard
      // per-group so one bad group can't take out the whole batch either.
      try {
        detection = detect(
          { productName: representative.productName, externalId: representative.buyerSkuCode },
          { knowledge, index: catalogIndex, supplier: "digiflazz" },
        );
      } catch (err) {
        logger.warn(
          { err },
          `Shadow-mode detection threw while grouping the Digiflazz brand "${group.brand}" — that group is returned without a detection field.`,
        );
      }
    }
    return {
      brand: group.brand,
      rawBrand: group.rawBrand,
      region: group.region,
      items: group.items,
      gameVariant: group.gameVariant,
      existingProductId: existingByBrand.get(group.brand) ?? null,
      detection,
    };
  });
}

/** The admin's configured global markup rule, as read from Settings — split
 * out of computeDigiflazzMarkupPrice (I3 fix) so a caller processing many
 * rows/denominations in one run (resyncDigiflazzCatalog's loop, the sync
 * preview route's per-SKU computation) reads Settings ONCE per run instead
 * of twice per row. */
export async function getDigiflazzMarkupSettings(db: Db): Promise<{ type: string | null; value: string | null }> {
  const [type, value] = await Promise.all([
    getSetting(db, DIGIFLAZZ_MARKUP_TYPE_KEY),
    getSetting(db, DIGIFLAZZ_MARKUP_VALUE_KEY),
  ]);
  return { type, value };
}

/** Pure price computation from an already-read markup setting — no DB
 * access, safe to call per-row inside a loop. */
export function applyDigiflazzMarkup(cost: Decimal, settings: { type: string | null; value: string | null }): Decimal {
  const amount = settings.value ? new Decimal(settings.value) : new Decimal(0);
  if (settings.type === "percent") return cost.plus(cost.times(amount).dividedBy(100));
  if (settings.type === "flat") return cost.plus(amount);
  return cost;
}

/** Suggest a sell price from a Digiflazz cost using the admin's configured
 * global markup rule. Defaults to zero markup (sell === cost) when unset —
 * a deliberately visible "no markup configured yet" price rather than a
 * silently wrong guess, so an admin who hasn't set a rule notices at the
 * review screen instead of shipping a $0-margin catalog unknowingly.
 *
 * Kept working (one Settings read per call) for any single-row caller; a
 * caller iterating many rows in one run should call
 * getDigiflazzMarkupSettings once and applyDigiflazzMarkup per row instead. */
export async function computeDigiflazzMarkupPrice(db: Db, cost: Decimal): Promise<Decimal> {
  return applyDigiflazzMarkup(cost, await getDigiflazzMarkupSettings(db));
}

/**
 * Whether a Digiflazz-routed denomination's price counts as admin-
 * overridden — protected from the next resyncDigiflazzCatalog tick, which
 * only ever recomputes `price` when this is false (see resyncDigiflazzCatalog
 * below). True when there's no cost on record to compare the price against
 * (can't confirm it matches a suggestion, so protect it rather than assume
 * it doesn't need protecting), or when the price disagrees with what the
 * current markup rule suggests for that cost.
 *
 * Single source of truth for this decision for single-row callers (batch 4
 * fix) — the web admin PATCH route and the order-bot's product-edit
 * conversation both call this now, closing the gap where their two
 * hand-rolled copies of this exact check had already drifted out of sync
 * once across review rounds. Callers pass the cost value THEIR OWN request
 * is actually about to persist (never a stale pre-request row value) — this
 * function only compares what it's given.
 *
 * importDigiflazzBrand below intentionally does NOT call this: looping many
 * rows per call, it needs applyDigiflazzMarkup with a markup-settings read
 * done ONCE for the whole run (I3 fix) rather than the per-call Settings
 * read computeDigiflazzMarkupPrice (and so this function) does — but it
 * must stay logically equivalent to the rule here if either ever changes.
 */
export async function isDigiflazzPriceOverridden(
  db: Db,
  price: Decimal,
  costPrice: Decimal | null,
): Promise<boolean> {
  if (costPrice == null) return true;
  return !moneyEq(price, await computeDigiflazzMarkupPrice(db, costPrice));
}

export interface DigiflazzImportRow {
  buyerSkuCode: string;
  productName: string;
  price: Decimal.Value;
  /** The Digiflazz cost this row was priced from (I11 fix) — without this,
   * a freshly-imported denomination had costPrice: null until the first
   * resync tick overwrote it; carrying it through at import time closes
   * that gap. */
  costPrice: Decimal.Value;
}

/**
 * Task 10 shadow-mode side effect: run `detect()` over a just-imported
 * Digiflazz brand and record its `DetectionResult` on the Product's
 * `detection*` columns and each denomination's `detectionSkuKey` /
 * `detectionStamp`. Purely informational until the Task 12 cutover gate —
 * the import/resync matching logic never reads these columns back.
 *
 * Runs on `db` (the real client) AFTER `importDigiflazzBrand`'s transaction
 * has committed — NOT on `tx` inside it. A `tx.*.update` failure inside a
 * Prisma interactive transaction aborts the whole transaction block; a JS
 * `try/catch` around it cannot un-abort it, so if this ran on `tx` and the
 * `detection_*` columns didn't exist yet (a migration-ordering hazard),
 * the entire brand import would fail where it used to succeed. Post-commit,
 * a failure here is genuinely isolated from the catalog import (the
 * try/catch at the call site actually holds).
 *
 * `denoms` is the exact set of denomination rows this import created/updated
 * (threaded out of `importDigiflazzBrand`'s main loop — no re-query needed).
 * Deliberately touches ONLY the `detection*` columns — never `brand` /
 * `digiflazzBrand` / `price` / `costPrice` / `isActive` / `supplierSku`.
 *
 * `detectionConfidence` is written as a Decimal (schema type `Decimal?`),
 * never a JS float.
 */
async function writeShadowDetectionForImport(
  db: Db,
  productId: number,
  brand: string,
  denoms: { id: number; name: string }[],
): Promise<void> {
  const [knowledge, index] = await Promise.all([loadKnowledgeBase(db), getCatalogIndex(db)]);
  const detection = detect({ productName: brand }, { knowledge, index, supplier: "digiflazz" });
  const detectionStamp = index.stamp;
  const resolved = detection.status === "resolved" ? detection : null;

  await db.product.update({
    where: { id: productId },
    data: {
      detectionStatus: detection.status,
      detectionStamp,
      detectionProductKey: resolved ? resolved.productKey : null,
      detectionBaseProductKey: resolved ? resolved.baseProductKey : null,
      detectionConfidence: resolved ? new Decimal(resolved.confidence) : null,
    },
  });

  // DetectionInput carries no denomination field, so detect() always returns
  // skuKey: null — compose the SKU-level key here via buildSkuKey (same
  // pattern as engine.acceptance.test.ts's AC-04). Distribution tokens come
  // from the brand name's own feature extraction.
  const distributionTokens = extractFeatures(normalize(brand), knowledge).distributionTokens;
  for (const denom of denoms) {
    const skuKey = resolved
      ? buildSkuKey(resolved.productKey, normalize(denom.name), distributionTokens)
      : null;
    await db.denomination.update({
      where: { id: denom.id },
      data: { detectionSkuKey: skuKey, detectionStamp },
    });
  }
}

/**
 * Bulk-create (or add to, on a repeat call for the same brand) one Product +
 * one Denomination per row, all inside one transaction. Imported inactive —
 * "review before it goes live" per the design: the import itself is
 * automatic, publishing is a separate explicit step.
 *
 * Idempotent by (product, supplierSku) (I4 fix): re-running the wizard for a
 * brand/SKU that's already imported UPDATES the existing denomination
 * instead of creating a duplicate — a realistic scenario (an admin re-syncs
 * and re-imports the same brand because they missed a SKU the first time).
 * Scoped to this brand's own Product, not a cross-catalog lookup —
 * supplierSku has no unique DB constraint, and this matches the only
 * realistic re-import scenario without an extra broad query.
 *
 * Each row's price is compared against the admin's configured markup rule
 * (read ONCE per call, not once per row — I3 fix) to decide priceOverridden
 * (C2 fix): a row the admin hand-edited in the wizard before submitting gets
 * priceOverridden: true, protecting it from being silently recomputed by the
 * very first resync tick after import.
 */
export async function importDigiflazzBrand(
  db: PrismaClient,
  args: {
    brand: string;
    categoryId: number;
    rows: DigiflazzImportRow[];
    /** Seeded into Product.gameVariant on the CREATE path only (from
     * groupDigiflazzPriceListByBrand's type-split). Never written on the
     * reuse-existing path — after birth, gameVariant is admin-owned. */
    gameVariant?: string | null;
  },
): Promise<{ productId: number; denominationCount: number }> {
  const { productId, touchedDenoms } = await db.$transaction(async (tx) => {
    let product = await tx.product.findFirst({ where: { digiflazzBrand: args.brand } });
    if (!product) {
      product = await createCatalogProduct(tx, {
        categoryId: args.categoryId,
        name: args.brand,
        digiflazzBrand: args.brand,
        gameVariant: args.gameVariant ?? null,
        isActive: false,
      });
    }
    const markupSettings = await getDigiflazzMarkupSettings(tx);
    // Threaded out to the post-commit Task 10 shadow-detection pass below —
    // {id, name} of every denomination this call created/updated, so that
    // pass never has to re-query for rows this same loop already touched.
    const touchedDenoms: { id: number; name: string }[] = [];

    // De-dupe by buyerSkuCode BEFORE the batched existence check below, last
    // occurrence wins (regression fix for the Task 6 batching change). Before
    // that change, a duplicate buyerSkuCode within one call's rows was
    // create-then-update-in-place: each loop iteration re-queried the DB, so
    // the second occurrence's findFirst saw the first occurrence's
    // just-created row and updated it — final state always reflected the
    // LAST occurrence. The batched existence-check Map is built once before
    // the loop from what existed before this call started, so it never sees
    // rows created earlier in the same loop — without this de-dupe, a
    // duplicate buyerSkuCode would create two rows with the same
    // supplierSku instead. Building a Map keyed by buyerSkuCode and
    // iterating args.rows in order reproduces "last write wins" exactly,
    // since a later entry naturally overwrites an earlier one in a Map.
    const rows = [...new Map(args.rows.map((row) => [row.buyerSkuCode, row])).values()];

    // Batch the existence check that used to run as one findFirst PER row
    // (N sequential round-trips inside this 10s-bounded transaction — P1,
    // Task 6 fix) into a single findMany, then look up by supplierSku via a
    // Map inside the loop below. The per-row create/update calls themselves
    // stay untouched — they have their own side effects (e.g. slug
    // generation on create) that must not be batched.
    const existingDenoms = await tx.denomination.findMany({
      where: { productId: product.id, supplierSku: { in: rows.map((r) => r.buyerSkuCode) } },
    });
    const existingDenomBySku = new Map(existingDenoms.map((d) => [d.supplierSku, d]));

    for (const row of rows) {
      const price = quantizeMoney(row.price, 4);
      const costPrice = quantizeMoney(row.costPrice, 4);
      const suggestedPrice = quantizeMoney(applyDigiflazzMarkup(costPrice, markupSettings), 4);
      const priceOverridden = !price.equals(suggestedPrice);

      // The Product itself is already region-scoped (args.brand is the
      // composite display name, e.g. "Mobile Legends (Indonesia)") once
      // groupDigiflazzPriceListByBrand has split by region — repeating the
      // region suffix on every denomination name/durationLabel would be
      // redundant, so strip it here. Purely cosmetic: supplierSku (the
      // resync matching key) stays row.buyerSkuCode, untouched.
      const denomName = stripRegionSuffix(row.productName);

      const existingDenom = existingDenomBySku.get(row.buyerSkuCode);
      if (existingDenom) {
        await updateDenomination(tx, existingDenom.id, {
          name: denomName,
          durationLabel: denomName,
          supplierRawName: row.productName,
          price,
          costPrice,
          priceOverridden,
        });
        touchedDenoms.push({ id: existingDenom.id, name: denomName });
      } else {
        const created = await createDenomination(tx, {
          productId: product.id,
          name: denomName,
          // ProductType only accepts SHARED | PRIVATE (packages/core/src/enums.ts)
          // — Digiflazz top-ups have no such distinction, SHARED is the neutral
          // default, same as this codebase's own sample/test data.
          type: ProductType.SHARED,
          durationLabel: denomName,
          price,
          costPrice,
          priceOverridden,
          autoDeliverySource: "digiflazz",
          supplierSku: row.buyerSkuCode,
          supplierRawName: row.productName,
          deliveryType: DeliveryType.MANUAL_WITH_INFO,
          additionalFields: JSON.stringify(DEFAULT_DIGIFLAZZ_FIELDS),
          isActive: false,
        });
        touchedDenoms.push({ id: created.id, name: denomName });
      }
    }

    return { productId: product.id, touchedDenoms };
  });

  // Invalidate every Db handle's cached CatalogIndex so the next
  // getCatalogIndex()/detection run picks up the newly-imported Product and
  // denominations (Task 8). Done after the transaction commits.
  await bumpCatalogRevision(db);

  // Task 10 shadow wiring: record the detection result on the new
  // Product/denomination rows. Deliberately runs AFTER the transaction has
  // committed (on `db`, not `tx`) — a failure inside an interactive
  // transaction aborts the whole transaction block regardless of any JS
  // try/catch, so running this here is what actually keeps a shadow-mode
  // failure from ever taking the catalog import down with it. NOTE: there is
  // no automatic healing if this fails partway through — runDetectionForCatalog
  // (the hourly job) never writes these Product/Denomination detection
  // columns, it only counts/upserts DetectionIssue rows and bumps override
  // hitCount. A crash mid-loop here leaves some denominations of THIS import
  // batch stamped and others not; the only retry path is re-running
  // importDigiflazzBrand for this brand.
  try {
    await writeShadowDetectionForImport(db, productId, args.brand, touchedDenoms);
  } catch (err) {
    logger.warn(
      { err },
      `Shadow-mode detection wiring failed while importing the Digiflazz brand "${args.brand}" — the catalog import itself is committed; the detection columns were left unset for this run.`,
    );
  }

  // touchedDenoms.length, not args.rows.length — it reflects the deduped
  // row count (one entry per unique buyerSkuCode), not the raw input size.
  return { productId, denominationCount: touchedDenoms.length };
}

/**
 * The recurring re-sync: for every Denomination with a non-null supplierSku,
 * refresh costPrice + recompute price (unless priceOverridden) from a fresh
 * Digiflazz price list, and deactivate any whose buyerProductStatus has gone
 * false. Deactivate-ONLY (I1 fix) — this never flips isActive back to true,
 * even when Digiflazz's buyerProductStatus reports the SKU as available
 * again: a manually-deactivated SKU (including a freshly-imported one,
 * which importDigiflazzBrand always creates isActive: false so an admin can
 * review it first) must stay off until a human explicitly reactivates it
 * through the catalog UI, never silently flipped back on by this job. Never
 * creates or renames anything — a genuinely new SKU only ever enters the
 * catalog through importDigiflazzBrand (the wizard), reviewed by an admin
 * first. No-op if Digiflazz isn't configured.
 *
 * Writes a single summary audit entry (adminId: null, system actor) when
 * anything actually changed — I2 fix — not one per denomination, which
 * would spam the audit log on a run touching hundreds of rows.
 *
 * Task 10 blast-radius circuit breaker: before writing anything, compares
 * every would-reprice row's new price against its current price and aborts
 * the entire run — no writes, a `digiflazz_catalog_resync_aborted` audit
 * entry, an alert to every admin — when more than 20% of at least 5
 * considered rows would move by more than 50% in either direction. Guards
 * against a malformed price-list *response* (not just an individually bad
 * row, which getPriceList itself already rejects) silently repricing a large
 * swath of the catalog.
 */
export async function resyncDigiflazzCatalog(
  db: PrismaClient,
): Promise<{ updated: number; deactivated: number }> {
  const zero = { updated: 0, deactivated: 0 };
  const creds = await getDigiflazzCreds(db);
  if (!creds) return zero;

  const [rawPriceList, mapped, markupSettings] = await Promise.all([
    getPriceList(creds),
    db.denomination.findMany({ where: { supplierSku: { not: null } } }),
    getDigiflazzMarkupSettings(db), // I3 fix: read once for the whole run, not once per denomination.
  ]);
  // collapseToCheapestSeller first — a plain Map keyed by buyerSkuCode over
  // an uncollapsed list lets whichever duplicate-seller row happens to come
  // last in the array silently win, instead of the cheapest one.
  const bySku = new Map(collapseToCheapestSeller(rawPriceList).map((item) => [item.buyerSkuCode, item]));

  // Minor 2 (final whole-branch review): the breaker's comparison loop below
  // and the write loop further down both need "this item's cost, marked up"
  // — extracted once so the two computations can't silently drift apart.
  const newSellPriceFor = (item: DigiflazzPriceListItem) => quantizeMoney(applyDigiflazzMarkup(item.price, markupSettings), 4);

  // Task 10 (backend audit 2026-08-21 C-1, second half) blast-radius circuit
  // breaker. Task 9 already rejects an individually invalid/non-finite/
  // non-positive supplier price, but a genuinely malformed *response* (a
  // field rename, a partial outage, the wrong endpoint) can still hand back
  // prices that are each individually "valid" yet collectively wrong for a
  // large swath of the catalog. Before writing anything, walk the same
  // would-reprice set the loop below touches (`!priceOverridden` rows with a
  // matching price-list item) and count how many would move by more than
  // 50% in either direction. Only trips for a shop with a real catalog
  // (>=5 rows considered) — a shop with only a handful of Digiflazz
  // denominations would otherwise see one legitimate supplier price swing
  // look like ">20% of the whole set" on every single run.
  let consideredRows = 0;
  let sharpChanges = 0;
  for (const denom of mapped) {
    if (denom.priceOverridden) continue;
    const item = bySku.get(denom.supplierSku!);
    if (!item) continue;
    consideredRows++;
    const newPrice = newSellPriceFor(item);
    const oldPrice = denom.price;
    // oldPrice.isZero() guards the ratio check below from dividing by zero:
    // any nonzero new price on a zero old price counts as a sharp change on
    // its own.
    const sharp = oldPrice.isZero()
      ? !newPrice.isZero()
      : newPrice.lessThan(oldPrice.times(0.5)) || newPrice.greaterThan(oldPrice.times(1.5));
    if (sharp) sharpChanges++;
  }

  // Important #2 (final whole-branch review): the breaker above only ever
  // compares rows that ARE present in the fetched price list against this
  // shop's existing denominations. If the fetch is malformed enough that
  // EVERY row gets rejected (Task 9's toPriceListItem returning null for
  // each one — e.g. the supplier renamed the `price` field) or the response
  // is simply empty, `rawPriceList` is `[]`, `bySku` is empty, and
  // `consideredRows` stays 0 for every denomination — the loop above never
  // finds a sharp change to count, so the >20%-of->=5 threshold above can
  // never fire. That's the MOST total form of the exact "malformed response"
  // scenario the breaker exists to catch, so treat it as another way the
  // breaker can trip: the fetch came back with zero usable rows at all
  // (`rawPriceList.length === 0`) while this shop has Digiflazz-routed
  // denominations that would normally be checked against it (`mapped.length
  // > 0`). Deliberately distinct from the normal, healthy case where the
  // fetch returns plenty of valid rows that simply don't include any of this
  // shop's configured SKUs this cycle (`rawPriceList.length > 0`) — that case
  // is left alone by this check, same as it always has been (the existing
  // per-denomination `if (!item) continue;` below already handles it
  // correctly).
  type AbortReason =
    | { kind: "sharp_change"; sharpChanges: number; consideredRows: number }
    | { kind: "no_usable_rows" };
  let abortReason: AbortReason | null = null;
  // Integer comparison (sharpChanges * 5 > consideredRows) instead of a
  // floating-point ratio — both sides are plain row counts, and this avoids
  // any doubt about a >20% boundary landing exactly on a float rounding
  // error.
  if (consideredRows >= 5 && sharpChanges * 5 > consideredRows) {
    abortReason = { kind: "sharp_change", sharpChanges, consideredRows };
  } else if (mapped.length > 0 && rawPriceList.length === 0) {
    abortReason = { kind: "no_usable_rows" };
  }

  if (abortReason) {
    if (abortReason.kind === "sharp_change") {
      logger.error(
        { sharpChanges: abortReason.sharpChanges, consideredRows: abortReason.consideredRows },
        "Aborted the hourly Digiflazz catalog resync because too many denominations' prices would have moved by more than 50% in this run — that usually means the supplier's price-list response is malformed (a field rename, a partial outage, the wrong endpoint) rather than a genuine market-wide price change, so nothing was written.",
      );
      await logAdminAction(db, {
        adminId: null,
        action: "digiflazz_catalog_resync_aborted",
        targetType: "product",
        targetId: null,
        details: `Aborted the hourly Digiflazz catalog sync: ${abortReason.sharpChanges} of ${abortReason.consideredRows} prices would have moved by more than 50%, which usually means the supplier's response is malformed rather than a real price change. Nothing was updated — please check the Digiflazz connection before the next run.`,
      });
    } else {
      logger.error(
        { mappedCount: mapped.length },
        "Aborted the hourly Digiflazz catalog resync because the supplier's price-list fetch returned no usable rows at all, even though this shop has Digiflazz-routed denominations to check against it — that usually means a field rename, a partial outage, or the wrong endpoint, not the supplier legitimately having nothing to report, so nothing was written.",
      );
      await logAdminAction(db, {
        adminId: null,
        action: "digiflazz_catalog_resync_aborted",
        targetType: "product",
        targetId: null,
        details:
          "Aborted the hourly Digiflazz catalog sync: the supplier returned no usable price data at all, even though this shop has Digiflazz-routed denominations to check. This usually means a field rename, a partial outage, or the wrong endpoint. Nothing was updated — please check the Digiflazz connection before the next run.",
      });
    }
    await enqueueAdminDigiflazzResyncAborted(
      db,
      abortReason.kind === "sharp_change"
        ? { kind: "sharp_change", sharpChanges: abortReason.sharpChanges, consideredRows: abortReason.consideredRows }
        : { kind: "no_usable_rows" },
    );
    await recordDigiflazzSyncStatus(db, {
      status: "aborted",
      updated: 0,
      deactivated: 0,
      abortReason: abortReason.kind,
      finishedAt: new Date().toISOString(),
    });
    await recordPollHealth(db, "digiflazzCatalogSync", {
      lastTxCount: 0,
      success: false,
      error:
        abortReason.kind === "sharp_change"
          ? `${abortReason.sharpChanges}/${abortReason.consideredRows} prices moved sharply`
          : "supplier returned no usable rows",
    });
    emitDigiflazzCatalogSyncChanged();
    return zero;
  }

  const result = { ...zero };
  for (const denom of mapped) {
    const item = bySku.get(denom.supplierSku!);
    if (!item) continue; // Digiflazz no longer lists this SKU — leave it as-is, not this job's concern.

    // I5 fix: quantize to the same 4-decimal precision createDenomination
    // already uses, so a percentage markup can't drift the stored price
    // away from import-time precision.
    const data: Record<string, unknown> = {
      costPrice: quantizeMoney(item.price, 4),
      // Raw identity updates even when a manual price override is protected.
      supplierRawName: item.productName,
    };
    if (!denom.priceOverridden) {
      data.price = newSellPriceFor(item);
      result.updated++;
    }
    if (denom.isActive && !item.buyerProductStatus) {
      data.isActive = false;
      result.deactivated++;
    }
    await updateDenomination(db, denom.id, data);
  }

  if (result.updated > 0 || result.deactivated > 0) {
    await logAdminAction(db, {
      adminId: null,
      action: "digiflazz_catalog_resync",
      targetType: "product",
      targetId: null,
      details: `Resynced ${result.updated} Digiflazz price(s) and deactivated ${result.deactivated} SKU(s) from the hourly catalog sync.`,
    });
  }

  await recordDigiflazzSyncStatus(db, {
    status: "success",
    updated: result.updated,
    deactivated: result.deactivated,
    abortReason: null,
    finishedAt: new Date().toISOString(),
  });
  await recordPollHealth(db, "digiflazzCatalogSync", {
    lastTxCount: result.updated + result.deactivated,
    success: true,
  });
  emitDigiflazzCatalogSyncChanged();
  return result;
}

// ---- One-time migration: split already-mixed-region Digiflazz products ----
//
// groupDigiflazzPriceListByBrand/importDigiflazzBrand (above) only fix NEW
// imports going forward. A live catalog can already hold Products imported
// BEFORE that fix, whose denominations mix several regions' SKUs together
// under one brand (e.g. a single "Mobile Legends" Product with
// Indonesia/Filipina/Russia/Brazil pricing all in one place). This section is
// the one-time fix-up for those pre-existing rows; scripts/split-digiflazz-
// regions.ts is its CLI entry point.

/** One region bucket found on a mixed Product's denominations. `region: null`
 * is the "(unspecified)" bucket — denominations whose `name` never carried a
 * region suffix. `displayName` is the composite name/digiflazzBrand this
 * bucket's Product will end up with (digiflazzGroupKey, same rule
 * groupDigiflazzPriceListByBrand uses for fresh imports). */
interface DigiflazzRegionGroup {
  region: string | null;
  displayName: string;
  denominations: { id: number; name: string }[];
}

/** One mixed Product's split plan — read-only, no DB writes implied.
 * `groups` is sorted winning-bucket-first (see detectMixedDigiflazzProducts),
 * so `groups[0]` is always the bucket that keeps `productId`. */
export interface DigiflazzMixedProductPlan {
  productId: number;
  originalName: string;
  /** The product's current slug, before any split — carried through so the
   * writer can reuse it when the winning bucket's displayName turns out to
   * equal `originalName` (see the conflict-avoidance note on `conflicts`
   * below and Finding 1 of the b710f44 review: regenerating the slug in
   * that case corrupts a live storefront URL for a product that isn't
   * actually being renamed). */
  originalSlug: string;
  categoryId: number;
  isActive: boolean;
  groups: DigiflazzRegionGroup[];
}

export interface DigiflazzMixedProductDetection {
  /** Products found with 2+ distinct region buckets — need splitting. Never
   * includes a plan that has a digiflazzBrand collision; see `conflicts`. */
  mixed: DigiflazzMixedProductPlan[];
  /** Names of candidate Digiflazz products that are NOT mixed (a single
   * region bucket — including "every denomination unsuffixed") and are left
   * untouched. */
  skipped: string[];
  /** Human-readable descriptions of mixed products that were found but
   * CANNOT be split because one of their target region names (a group's
   * `displayName`) already matches a DIFFERENT existing product's
   * `digiflazzBrand` — e.g. a fresh region-aware import already created
   * "Mobile Legends (Indonesia)" before this migration ran on old mixed
   * "Mobile Legends" data. Splitting anyway would silently create a second
   * product with the same digiflazzBrand, which downstream code
   * (importDigiflazzBrand's findFirst, groupDigiflazzPriceListByBrand's
   * brand map) would then resolve to one of the two duplicates arbitrarily.
   * These products are entirely excluded from `mixed` (not partially
   * split) — a human must resolve the collision (e.g. delete/merge the
   * stray duplicate) and re-run. */
  conflicts: string[];
}

/**
 * Read-only detection: find every non-archived, Digiflazz-backed Product and
 * group its denominations by `parseProductRegion(denomination.name)` (using
 * `name`, not `durationLabel` — pre-migration rows carry the raw suffixed
 * Digiflazz productName in `name`, which is what's needed to recover the
 * region; see the module doc comment above).
 *
 * Pure/no-write — this is the single place the region-grouping and
 * winner-selection logic lives. Both `splitMixedDigiflazzProducts` (the
 * writer) and the migration script's `--dry-run`-by-default plan output call
 * this, so the two can never drift out of sync with each other.
 */
export async function detectMixedDigiflazzProducts(db: Db): Promise<DigiflazzMixedProductDetection> {
  const candidates = await db.product.findMany({
    where: { digiflazzBrand: { not: null }, isArchived: false },
    include: { denominations: true },
  });

  const mixedCandidates: DigiflazzMixedProductPlan[] = [];
  const skipped: string[] = [];

  for (const product of candidates) {
    const byRegion = new Map<string | null, { id: number; name: string }[]>();
    for (const denom of product.denominations) {
      const region = parseProductRegion(denom.name);
      const bucket = byRegion.get(region);
      if (bucket) bucket.push({ id: denom.id, name: denom.name });
      else byRegion.set(region, [{ id: denom.id, name: denom.name }]);
    }

    // Every denomination maps to the same region (including "all null" —
    // never region-suffixed), or the product has no denominations at all:
    // nothing to split. Recording it here (rather than only in the writer)
    // is what makes a second run a true no-op end to end.
    if (byRegion.size <= 1) {
      skipped.push(product.name);
      continue;
    }

    const rawBrand = product.digiflazzBrand!; // guaranteed by the findMany's where clause
    const groups: DigiflazzRegionGroup[] = [...byRegion.entries()].map(([region, denominations]) => {
      // Any one denomination's raw name is enough to derive this bucket's
      // displayName — they all parse to the same region by construction.
      const { displayName } = digiflazzGroupKey(rawBrand, denominations[0]!.name);
      return { region, displayName, denominations };
    });

    // Winning bucket (keeps the original Product id): largest denomination
    // count; ties broken alphabetically by region name, with the
    // "(unspecified)" bucket sorting first (region ?? "" — an empty string
    // sorts before any named region) — deterministic across repeated runs on
    // the same data, which is what makes dry-run output reproducible.
    groups.sort((a, b) => {
      if (b.denominations.length !== a.denominations.length) {
        return b.denominations.length - a.denominations.length;
      }
      return (a.region ?? "").localeCompare(b.region ?? "");
    });

    mixedCandidates.push({
      productId: product.id,
      originalName: product.name,
      originalSlug: product.slug,
      categoryId: product.categoryId,
      isActive: product.isActive,
      groups,
    });
  }

  // Finding 2 fix: neither Product.name nor Product.digiflazzBrand is
  // unique in the schema, so splitting could otherwise create a second
  // product sharing a digiflazzBrand with one that already exists (e.g. a
  // fresh region-aware import ran for one of this brand's regions before
  // this one-time migration processed the old mixed product). Check every
  // candidate's target displayNames against the WHOLE catalog (not just the
  // mixed candidates) in one query, then exclude any plan with a collision
  // from `mixed` entirely rather than partially splitting it.
  const allTargetNames = [...new Set(mixedCandidates.flatMap((plan) => plan.groups.map((g) => g.displayName)))];
  const existingByTargetName =
    allTargetNames.length === 0
      ? []
      : await db.product.findMany({
          where: { digiflazzBrand: { in: allTargetNames } },
          select: { id: true, name: true, digiflazzBrand: true },
        });
  const existingByBrand = new Map(existingByTargetName.map((p) => [p.digiflazzBrand!, p]));

  const mixed: DigiflazzMixedProductPlan[] = [];
  const conflicts: string[] = [];
  for (const plan of mixedCandidates) {
    const collidingGroup = plan.groups.find((g) => {
      const existing = existingByBrand.get(g.displayName);
      return existing != null && existing.id !== plan.productId;
    });
    if (collidingGroup) {
      const existing = existingByBrand.get(collidingGroup.displayName)!;
      conflicts.push(
        `"${plan.originalName}" (product id ${plan.productId}) cannot be split: target name "${collidingGroup.displayName}" already belongs to a different existing product, "${existing.name}" (product id ${existing.id}). Resolve manually (e.g. delete or merge the stray duplicate) and re-run.`,
      );
      continue;
    }
    mixed.push(plan);
  }

  return { mixed, skipped, conflicts };
}

/**
 * The one-time write: split every already-mixed-region Digiflazz Product
 * `detectMixedDigiflazzProducts` finds into one Product per region.
 *
 * Repurposes the original mixed Product as the winning region's Product
 * (rename in place, keep its id) rather than archive-and-recreate — OrderItem
 * never references Product.id (only Denomination.id, whose ids this function
 * never changes), so this is a URL/id-continuity choice, not a
 * data-integrity one. It also avoids leaving a permanently archived,
 * denomination-less Product cluttering the catalog (hard-delete is refused
 * once a Product ever had denominations), and keeps each product's split as
 * one small transaction.
 *
 * One `db.$transaction` per mixed Product, not one catalog-wide transaction:
 * a bad brand can't block every other brand's split, and this doesn't hold
 * locks across a full-catalog scan.
 *
 * Deliberately does NOT copy webImageUrl/description/whatYouGet/terms/
 * warrantyNote onto the newly-created region Products — that copy was
 * written for the generic mixed brand and may say something region-
 * inaccurate (e.g. IDR-specific copy on a Brazil product); left empty for an
 * admin to fill in (the migration script's printed summary calls this out).
 *
 * Idempotent: a second run finds zero mixed products (every split product's
 * denominations are now single-region, having had their suffix stripped by
 * the first run) and returns `skipped` with everything, all counts zero.
 *
 * `conflicts` (Finding 2 of the b710f44 review) carries forward any mixed
 * products detectMixedDigiflazzProducts found but excluded from splitting
 * because a target region name already belongs to a different existing
 * product's digiflazzBrand — those products are left completely untouched
 * (not partially split); see detectMixedDigiflazzProducts's doc comment.
 *
 * Each product's transaction is individually try/caught (re-review Finding
 * B): if one product's transaction throws an unexpected error (e.g. a
 * transient DB error), that product is recorded in `failures` and the loop
 * continues to the next product — it does NOT abort the whole run. Earlier
 * products in the same call have already committed (each is its own
 * transaction) regardless of a later one failing, so `failures` is what
 * gives the operator visibility into that instead of the run throwing past
 * the caller with no summary of what already landed. This only covers
 * genuinely unexpected errors — the business-logic exclusions (not-mixed,
 * digiflazzBrand conflicts) are decided up front by detectMixedDigiflazzProducts
 * and never reach this try/catch at all.
 */
export async function splitMixedDigiflazzProducts(
  db: PrismaClient,
): Promise<{
  productsSplit: number;
  productsCreated: number;
  denominationsMoved: number;
  skipped: string[];
  conflicts: string[];
  failures: { productName: string; error: string }[];
}> {
  const { mixed, skipped, conflicts } = await detectMixedDigiflazzProducts(db);

  let productsSplit = 0;
  let productsCreated = 0;
  let denominationsMoved = 0;
  const failures: { productName: string; error: string }[] = [];

  for (const plan of mixed) {
    const [winningGroup, ...otherGroups] = plan.groups;
    const allNewNames = plan.groups.map((g) => g.displayName);

    try {
      // Counted inside the transaction closure but only folded into the
      // running totals below once the transaction has actually committed —
      // if it throws partway through, this local count is discarded along
      // with the rolled-back writes instead of inflating denominationsMoved
      // for denominations that were never actually moved.
      const movedThisProduct = await db.$transaction(async (tx) => {
        // Rename the ORIGINAL row in place. Finding 1 fix, hardened per the
        // Finding C re-review, then re-hardened again per the third-round
        // review (Finding 1): skip slug regeneration when EITHER guard says
        // "not actually changing" — the name is unchanged (the original I1
        // guard) OR the slugified name matches the current slug (the Finding
        // C guard). Neither guard alone is sufficient: product slugs are
        // frozen at creation and ensureUniqueSlug appends "-2", "-3", ... on
        // a name collision at creation time, so a product can legitimately
        // have name "Valorant" but slug "valorant-2" (another product already
        // held "valorant" when this one was created). Comparing only the slug
        // would then see slugify("Valorant") === "valorant" !== "valorant-2"
        // and wrongly call ensureUniqueSlug even though the name never
        // changed — which finds "valorant"/"valorant-2" both taken and
        // returns "valorant-3", corrupting a live storefront URL for a
        // product that isn't actually being renamed. Comparing only the name
        // has the Finding C failure mode (case/punctuation differences that
        // slugify identically). Combining both closes each other's gap.
        const winningSlug =
          winningGroup!.displayName === plan.originalName ||
          slugify(winningGroup!.displayName) === plan.originalSlug
            ? plan.originalSlug
            : await ensureUniqueSlug(tx, "product", winningGroup!.displayName);

        // Finding 3 (final whole-branch review): detectMixedDigiflazzProducts
        // checked for a digiflazzBrand collision once, up front, before ANY
        // product's transaction ran. Re-check right here, transactionally
        // (via `tx`, not the outer `db`), immediately before writing the
        // target digiflazzBrand — closes the TOCTOU window where a
        // concurrent wizard import could create the exact colliding product
        // in the gap between detection and this write. Excludes this
        // product's own id (a product's row can legitimately already carry
        // this displayName as its digiflazzBrand when nothing is actually
        // changing).
        const winningCollision = await tx.product.findFirst({
          where: { digiflazzBrand: winningGroup!.displayName, NOT: { id: plan.productId } },
        });
        if (winningCollision) {
          throw new Error(
            `digiflazzBrand collision detected inside transaction: target name "${winningGroup!.displayName}" now belongs to product id ${winningCollision.id} ("${winningCollision.name}") — a concurrent import must have created it after detection ran. Aborting this product's split; re-run the migration once the collision is resolved.`,
          );
        }
        await updateCatalogProduct(tx, plan.productId, {
          name: winningGroup!.displayName,
          digiflazzBrand: winningGroup!.displayName,
          slug: winningSlug,
        });
        // Finding 1 (final whole-branch review, user-decided): denominations
        // STAYING on the winning/original product are deliberately left
        // untouched here — no write at all. OrderItem carries no name
        // snapshot, so a historical order view (admin or buyer) renders the
        // LIVE denomination name; stripping every stayed denomination's
        // region suffix "for consistency with fresh imports" would silently
        // rewrite what an already-placed order displays even though the
        // product/denomination itself never actually moved. Only
        // denominations that MOVE to a new product (below) get the suffix
        // stripped — that product is now genuinely region-specific, so the
        // suffix really is redundant there.

        let moved = 0;
        for (const group of otherGroups) {
          // Finding 3 (final whole-branch review): same TOCTOU re-check as
          // the winning rename above, right before creating this new
          // product — a concurrent wizard import could have created a
          // product with this exact target digiflazzBrand after detection
          // ran but before this transaction reached it.
          const groupCollision = await tx.product.findFirst({ where: { digiflazzBrand: group.displayName } });
          if (groupCollision) {
            throw new Error(
              `digiflazzBrand collision detected inside transaction: target name "${group.displayName}" now belongs to product id ${groupCollision.id} ("${groupCollision.name}") — a concurrent import must have created it after detection ran. Aborting this product's split; re-run the migration once the collision is resolved.`,
            );
          }
          const newProduct = await createCatalogProduct(tx, {
            categoryId: plan.categoryId,
            name: group.displayName,
            digiflazzBrand: group.displayName,
            isActive: plan.isActive,
          });
          for (const denom of group.denominations) {
            const stripped = stripRegionSuffix(denom.name);
            // denom.id is never touched — only productId/name/durationLabel.
            await updateDenomination(tx, denom.id, {
              productId: newProduct.id,
              name: stripped,
              durationLabel: stripped,
            });
            moved++;
          }
        }

        await logAdminAction(tx, {
          adminId: null,
          action: "digiflazz_catalog_region_split",
          targetType: "product",
          targetId: plan.productId,
          details: `Split mixed-region product "${plan.originalName}" into ${plan.groups.length} region products: ${allNewNames.join(", ")}.`,
        });

        return moved;
      });

      productsSplit++;
      productsCreated += otherGroups.length;
      denominationsMoved += movedThisProduct;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ productName: plan.originalName, error: message });
      logger.warn(
        `Digiflazz region-split failed for product "${plan.originalName}" (product id ${plan.productId}): ${message}. ` +
          "This product's transaction rolled back and was left untouched — earlier products already split in this run are unaffected, and the migration is idempotent, so re-running --apply will retry this one.",
      );
    }
  }

  return { productsSplit, productsCreated, denominationsMoved, skipped, conflicts, failures };
}

// ---- One-time migration: split already-mixed-type Digiflazz products ----
//
// Task 21's groupDigiflazzPriceListByBrand/importDigiflazzBrand (above) only
// fix NEW imports going forward: a brand Digiflazz reports with ≥2 distinct
// `type` values (e.g. "Arena Breakout" base + "Arena Breakout Infinite") now
// splits into one Product per edition at import time. A live catalog can
// already hold a Product imported BEFORE that fix, whose denominations mix
// multiple editions together under one brand. This section is the one-time
// fix-up for that pre-existing data; scripts/split-digiflazz-types.ts is its
// CLI entry point. Closely mirrors the region-splitter pair immediately
// above — see that section's doc comments for the reasoning shared by both;
// comments here call out only what's genuinely different for `type`.
//
// Key difference from the region splitter: Digiflazz's `type` value is not
// persisted anywhere in this DB (not on Product, not on Denomination —
// Denomination.type is the unrelated ProductType enum, NOT NULL, already
// used for SHARED/PRIVATE). The region splitter can compute everything by
// reading parseProductRegion(denom.name) from data already in the DB; this
// migration cannot, so the caller (the CLI) fetches a live price list ONCE
// and passes in a `typeMap: Map<supplierSku, normalizedTypeSuffix>` as a
// plain parameter — this keeps detectMixedTypeProducts/splitMixedTypeProducts
// pure, DB-only, and unit-testable with a fake Map, and preserves the "one
// read-only planner shared by dry-run and apply" contract the region
// splitter already has.

/** One type-suffix bucket found on a mixed Product's denominations.
 * `suffix: null` is the base ("Umum") bucket. `displayName` is the composite
 * name/digiflazzBrand this bucket's Product will end up with — built via the
 * same digiflazzGroupKey composer groupDigiflazzPriceListByBrand uses for
 * fresh imports, so a migrated Product's digiflazzBrand always matches what a
 * fresh import of the same data would produce. */
export interface DigiflazzTypeGroup {
  suffix: string | null;
  displayName: string;
  denominations: { id: number; name: string }[];
}

/** One mixed Product's split plan — read-only, no DB writes implied. `groups`
 * is sorted winning-bucket-first (see detectMixedTypeProducts), so
 * `groups[0]` is always the bucket that keeps `productId`. */
export interface DigiflazzMixedTypeProductPlan {
  productId: number;
  originalName: string;
  originalSlug: string;
  categoryId: number;
  isActive: boolean;
  groups: DigiflazzTypeGroup[];
}

export interface DigiflazzMixedTypeDetection {
  /** Products found with 2+ distinct type suffixes — need splitting. Never
   * includes a plan that has a digiflazzBrand collision; see `conflicts`. */
  mixed: DigiflazzMixedTypeProductPlan[];
  /** Names of candidate Digiflazz products that are NOT mixed (a single type
   * suffix — including "every denomination base/Umum") and are left
   * untouched. */
  skipped: string[];
  /** Human-readable descriptions of mixed products that were found but
   * CANNOT be split because one of their target names (a group's
   * `displayName`) already matches a DIFFERENT existing product's
   * digiflazzBrand — same collision reasoning as detectMixedDigiflazzProducts's
   * `conflicts`. These products are entirely excluded from `mixed` (not
   * partially split) — a human must resolve the collision and re-run. */
  conflicts: string[];
  /** Candidate products excluded entirely because at least one denomination
   * could not be mapped to a type (its supplierSku is null — a manually-added
   * SKU — or the supplierSku is absent from `typeMap`, e.g. Digiflazz retired
   * it). Never partially split: one unmapped denomination excludes the WHOLE
   * product. Each entry names the product and lists the unmapped
   * denomination names (capped) so an operator can see why. */
  unmapped: { productName: string; productId: number; denominationNames: string[] }[];
}

/** Cap on how many unmapped denomination names are listed per product in
 * `DigiflazzMixedTypeDetection.unmapped` — an operator only needs enough to
 * recognize the product, not an exhaustive dump. */
const UNMAPPED_DENOM_NAMES_CAP = 10;

/**
 * Read-only detection: find every non-archived, Digiflazz-backed Product and
 * bucket its denominations by type suffix, using `typeMap` (built by the CLI
 * from one fresh `getPriceList()` call — see this file's module-level "Key
 * difference" comment above) to map each denomination's `supplierSku` to its
 * normalized suffix. `typeMap`'s values are already normalized
 * (digiflazzTypeSuffix's output — null for base, the trimmed original-case
 * string otherwise), never a raw Digiflazz `type` string — this keeps this
 * function simple and lets tests build a fake Map directly with the values
 * they want to assert against.
 *
 * Pure/no-write — this is the single place the type-grouping and
 * winner-selection logic lives. Both `splitMixedTypeProducts` (the writer)
 * and the migration script's `--dry-run`-by-default plan output call this,
 * so the two can never drift out of sync with each other.
 */
export async function detectMixedTypeProducts(
  db: Db,
  typeMap: Map<string, string | null>,
): Promise<DigiflazzMixedTypeDetection> {
  const candidates = await db.product.findMany({
    where: { digiflazzBrand: { not: null }, isArchived: false },
    include: { denominations: true },
  });

  const mixedCandidates: DigiflazzMixedTypeProductPlan[] = [];
  const skipped: string[] = [];
  const unmapped: { productName: string; productId: number; denominationNames: string[] }[] = [];

  for (const product of candidates) {
    const unmappedNames: string[] = [];
    const bySuffix = new Map<string | null, { id: number; name: string }[]>();
    for (const denom of product.denominations) {
      if (denom.supplierSku == null || !typeMap.has(denom.supplierSku)) {
        unmappedNames.push(denom.name);
        continue;
      }
      const suffix = typeMap.get(denom.supplierSku) ?? null;
      const bucket = bySuffix.get(suffix);
      if (bucket) bucket.push({ id: denom.id, name: denom.name });
      else bySuffix.set(suffix, [{ id: denom.id, name: denom.name }]);
    }

    // Never partially split: one denomination that can't be mapped to a
    // type excludes the WHOLE product from this run, regardless of what the
    // rest of its denominations would otherwise indicate.
    if (unmappedNames.length > 0) {
      unmapped.push({
        productName: product.name,
        productId: product.id,
        denominationNames: unmappedNames.slice(0, UNMAPPED_DENOM_NAMES_CAP),
      });
      continue;
    }

    // Every mapped denomination shares the same suffix (including "all
    // base"), or the product has no denominations at all: nothing to split.
    // Recording it here (rather than only in the writer) is what makes a
    // second run a true no-op end to end.
    if (bySuffix.size <= 1) {
      skipped.push(product.name);
      continue;
    }

    // The region (if any) MUST be recovered from product.digiflazzBrand
    // itself, not from a denomination's name — both importDigiflazzBrand and
    // splitMixedDigiflazzProducts unconditionally strip the region suffix off
    // every denomination name they write (stripRegionSuffix(row.productName)/
    // stripRegionSuffix(denom.name)), so for any already-imported or
    // already-region-migrated product a denomination name simply does not
    // carry the region anymore. Reading it from the denomination name here
    // would silently drop the region from a product like
    // digiflazzBrand: "Mobile Legends (Indonesia)" the first time this
    // migration ran, renaming it to plain "Mobile Legends" — destroying its
    // region scoping and, since that no longer matches what a fresh import
    // would produce, setting up a duplicate-SKU collision the next time the
    // wizard imports "Mobile Legends (Indonesia)" as "new".
    // parseProductRegion(denominations[0].name) is kept only as a fallback
    // for a product that was never region-migrated but happens to carry a
    // literal region suffix on its (hand-entered or pre-migration) rows.
    const brandRegion = parseProductRegion(product.digiflazzBrand!);
    const brandBase = stripRegionSuffix(product.digiflazzBrand!);
    const groups: DigiflazzTypeGroup[] = [...bySuffix.entries()].map(([suffix, denominations]) => {
      if (suffix === null) {
        // Base bucket keeps the product's current brand VERBATIM — the same
        // guarantee a fresh import gives a ≤1-suffix brand (byte-identical
        // displayName), so a base-bucket winner never churns its own name or
        // slug, and a base-bucket loser is created under the exact name a
        // fresh import of this same data would use.
        return { suffix, displayName: product.digiflazzBrand!, denominations };
      }
      const region = brandRegion ?? parseProductRegion(denominations[0]!.name);
      // Region×type dedupe — identical rule to groupDigiflazzPriceListByBrand's
      // own dedupe (Task 21): when the type suffix already names this
      // product's region (e.g. suffix "Global" on a brand region "Global"),
      // the region is expressed twice — fold it into the suffix instead of
      // emitting "Brand Global (Global)".
      const dedupe = region != null && region.toLowerCase() === suffix.toLowerCase();
      const displayName =
        region != null && !dedupe ? `${brandBase} ${suffix} (${region})` : `${brandBase} ${suffix}`;
      return { suffix, displayName, denominations };
    });

    // Winning bucket (keeps the original Product id): largest denomination
    // count; ties broken alphabetically by suffix, with the base ("Umum")
    // bucket sorting first (suffix ?? "" — an empty string sorts before any
    // named suffix) — identical comparator shape to the region splitter's
    // own tie-break, so a tie between base and a named suffix always
    // resolves to base first.
    groups.sort((a, b) => {
      if (b.denominations.length !== a.denominations.length) {
        return b.denominations.length - a.denominations.length;
      }
      return (a.suffix ?? "").localeCompare(b.suffix ?? "");
    });

    mixedCandidates.push({
      productId: product.id,
      originalName: product.name,
      originalSlug: product.slug,
      categoryId: product.categoryId,
      isActive: product.isActive,
      groups,
    });
  }

  // Collision guard — identical logic to detectMixedDigiflazzProducts: check
  // every candidate's target displayNames against the WHOLE catalog (not
  // just the mixed candidates) in one query, then exclude any plan with a
  // collision from `mixed` entirely rather than partially splitting it.
  const allTargetNames = [...new Set(mixedCandidates.flatMap((plan) => plan.groups.map((g) => g.displayName)))];
  const existingByTargetName =
    allTargetNames.length === 0
      ? []
      : await db.product.findMany({
          where: { digiflazzBrand: { in: allTargetNames } },
          select: { id: true, name: true, digiflazzBrand: true },
        });
  const existingByBrand = new Map(existingByTargetName.map((p) => [p.digiflazzBrand!, p]));

  const mixed: DigiflazzMixedTypeProductPlan[] = [];
  const conflicts: string[] = [];
  for (const plan of mixedCandidates) {
    const collidingGroup = plan.groups.find((g) => {
      const existing = existingByBrand.get(g.displayName);
      return existing != null && existing.id !== plan.productId;
    });
    if (collidingGroup) {
      const existing = existingByBrand.get(collidingGroup.displayName)!;
      conflicts.push(
        `"${plan.originalName}" (product id ${plan.productId}) cannot be split: target name "${collidingGroup.displayName}" already belongs to a different existing product, "${existing.name}" (product id ${existing.id}). Resolve manually (e.g. delete or merge the stray duplicate) and re-run.`,
      );
      continue;
    }
    mixed.push(plan);
  }

  return { mixed, skipped, conflicts, unmapped };
}

/**
 * The one-time write: split every already-mixed-type Digiflazz Product
 * `detectMixedTypeProducts` finds into one Product per edition.
 *
 * Mirrors splitMixedDigiflazzProducts's structure exactly (repurpose the
 * winning bucket's Product in place, one $transaction per product, TOCTOU
 * re-check, per-product failure isolation — see that function's doc comment
 * for the full reasoning), with two DELIBERATE DIFFERENCES:
 *
 * 1. Never rewrites a moved denomination's name/durationLabel. The region
 *    splitter strips the region suffix off moved denominations because the
 *    new product is now region-specific and the suffix is redundant — there
 *    is no equivalent here. Reasons: (a) formatDenominationLabel
 *    (apps/order-bot/src/util/denominationLabel.ts) already strips the
 *    product-name prefix at render time, so the bot never shows the raw
 *    stored name verbatim — no display bug to fix by rewriting; (b) the
 *    denomination name should keep matching the Digiflazz vendor's own
 *    naming for support/reconciliation; (c) OrderItem carries no name
 *    snapshot, so rewriting would silently change how a past order renders
 *    even though nothing about that order actually changed. Only productId
 *    moves.
 * 2. Every bucket's gameVariant is set, even the base ("Umum") one, on
 *    WHICHEVER side of the split it ends up on. Unlike a fresh import's
 *    ≤1-suffix path (Task 21, gameVariant: null when nothing splits), a
 *    product reaching this function is provably mixed (bySuffix.size >= 2 in
 *    detectMixedTypeProducts) — every bucket, including the winner, is one
 *    side of a real split. Both the winner and every created product get
 *    `<group>.suffix ?? DIGIFLAZZ_BASE_GAME_VARIANT` (so a base-bucket gets
 *    "Umum", never null) — the SAME fallback on both sides, deliberately,
 *    because the winning bucket is decided by denomination count, not by
 *    suffix: the base bucket can just as easily end up the non-winning
 *    (created) side of a split as the winning one. gameVariant must be
 *    non-null on BOTH sides of a real split, or listCategoryGameVariants can
 *    never report length > 1 for this pair.
 *
 * Return shape adds `unmapped` (passed through from detectMixedTypeProducts)
 * alongside the region splitter's existing fields. Does NOT call
 * bumpCatalogRevision — splitMixedDigiflazzProducts doesn't either.
 */
export async function splitMixedTypeProducts(
  db: PrismaClient,
  typeMap: Map<string, string | null>,
): Promise<{
  productsSplit: number;
  productsCreated: number;
  denominationsMoved: number;
  skipped: string[];
  conflicts: string[];
  unmapped: { productName: string; productId: number; denominationNames: string[] }[];
  failures: { productName: string; error: string }[];
}> {
  const { mixed, skipped, conflicts, unmapped } = await detectMixedTypeProducts(db, typeMap);

  let productsSplit = 0;
  let productsCreated = 0;
  let denominationsMoved = 0;
  const failures: { productName: string; error: string }[] = [];

  for (const plan of mixed) {
    const [winningGroup, ...otherGroups] = plan.groups;
    const allNewNames = plan.groups.map((g) => g.displayName);

    try {
      const movedThisProduct = await db.$transaction(async (tx) => {
        // Same slug-preservation guard as splitMixedDigiflazzProducts — see
        // its doc comment for why both the name-unchanged AND
        // slug-matches-current guards are needed together.
        const winningSlug =
          winningGroup!.displayName === plan.originalName || slugify(winningGroup!.displayName) === plan.originalSlug
            ? plan.originalSlug
            : await ensureUniqueSlug(tx, "product", winningGroup!.displayName);

        // TOCTOU re-check — same reasoning as splitMixedDigiflazzProducts:
        // detectMixedTypeProducts checked for a collision once, up front,
        // before any product's transaction ran; re-check here,
        // transactionally, immediately before writing the target
        // digiflazzBrand.
        const winningCollision = await tx.product.findFirst({
          where: { digiflazzBrand: winningGroup!.displayName, NOT: { id: plan.productId } },
        });
        if (winningCollision) {
          throw new Error(
            `digiflazzBrand collision detected inside transaction: target name "${winningGroup!.displayName}" now belongs to product id ${winningCollision.id} ("${winningCollision.name}") — a concurrent import must have created it after detection ran. Aborting this product's split; re-run the migration once the collision is resolved.`,
          );
        }
        await updateCatalogProduct(tx, plan.productId, {
          name: winningGroup!.displayName,
          digiflazzBrand: winningGroup!.displayName,
          slug: winningSlug,
          // Deliberate difference #2 — see doc comment above: this product is
          // provably mixed, so the winner (even the base bucket) gets a
          // non-null gameVariant.
          gameVariant: winningGroup!.suffix ?? DIGIFLAZZ_BASE_GAME_VARIANT,
        });

        let moved = 0;
        for (const group of otherGroups) {
          const groupCollision = await tx.product.findFirst({ where: { digiflazzBrand: group.displayName } });
          if (groupCollision) {
            throw new Error(
              `digiflazzBrand collision detected inside transaction: target name "${group.displayName}" now belongs to product id ${groupCollision.id} ("${groupCollision.name}") — a concurrent import must have created it after detection ran. Aborting this product's split; re-run the migration once the collision is resolved.`,
            );
          }
          const newProduct = await createCatalogProduct(tx, {
            categoryId: plan.categoryId,
            name: group.displayName,
            digiflazzBrand: group.displayName,
            // Same `?? DIGIFLAZZ_BASE_GAME_VARIANT` fallback as the winner,
            // above: the winning bucket isn't always the base one (a larger
            // non-null-suffix bucket can win), so a non-winning group can
            // itself be the base bucket — it must still get "Umum", not
            // null, or the base/suffix pair fails the same
            // "non-null on both sides" requirement this whole difference
            // exists for.
            gameVariant: group.suffix ?? DIGIFLAZZ_BASE_GAME_VARIANT,
            isActive: plan.isActive,
          });
          for (const denom of group.denominations) {
            // Deliberate difference #1 — see doc comment above: name/
            // durationLabel are NEVER rewritten here. Only productId moves.
            await updateDenomination(tx, denom.id, { productId: newProduct.id });
            moved++;
          }
        }

        await logAdminAction(tx, {
          adminId: null,
          action: "digiflazz_catalog_type_split",
          targetType: "product",
          targetId: plan.productId,
          details: `Split mixed-edition product "${plan.originalName}" into ${plan.groups.length} edition products: ${allNewNames.join(", ")}.`,
        });

        return moved;
      });

      productsSplit++;
      productsCreated += otherGroups.length;
      denominationsMoved += movedThisProduct;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ productName: plan.originalName, error: message });
      logger.warn(
        `Digiflazz type-split failed for product "${plan.originalName}" (product id ${plan.productId}): ${message}. ` +
          "This product's transaction rolled back and was left untouched — earlier products already split in this run are unaffected, and the migration is idempotent, so re-running --apply will retry this one.",
      );
    }
  }

  // Unlike splitMixedDigiflazzProducts (which relies on getCatalogIndex's 30s
  // TTL, acceptable while detection is shadow-mode-only), this migration
  // renames Products and moves denominations under an admin-triggered CLI
  // run rather than routine background traffic — bump once, after every
  // product's transaction has settled, so a detection pass immediately after
  // --apply sees the post-split catalog rather than a stale cached index.
  if (productsSplit > 0) {
    await bumpCatalogRevision(db);
  }

  return { productsSplit, productsCreated, denominationsMoved, skipped, conflicts, unmapped, failures };
}
