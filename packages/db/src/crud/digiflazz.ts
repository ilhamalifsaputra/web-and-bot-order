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
 */
import { OrderStatus, ProductType, DeliveryType } from "@app/core/enums";
import { Decimal, moneyEq } from "@app/core/money";
import { quantizeMoney } from "@app/core/formatters";
import { logger } from "@app/core/logger";
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
import type { PrismaClient } from "../client";
import type { Db } from "./_types";
import { getSetting } from "./settings";
import { getOrder, finalizeDeliverySideEffects } from "./orders";
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
    getSetting(db, DIGIFLAZZ_API_KEY_KEY),
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
  items: {
    quantity: number;
    product: {
      name: string;
      supplierSku: string | null;
      additionalFields: string | null;
      autoDeliverySource: string | null;
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
  /** Of the claimed orders, how many Digiflazz reported "Pending" for — left
   * PROCESSING, awaiting the webhook callback (a later task) to finish them. */
  pending: number;
  /** Of the claimed orders, how many failed — either Digiflazz reported
   * "Gagal", the SKU had no supplierSku configured, or the HTTP call itself
   * threw. Each of these enqueued an admin alert and left the order
   * PROCESSING for a human to finish via fulfillManualOrder. */
  failed: number;
}

const ZERO_SUMMARY: DigiflazzDispatchSummary = { claimed: 0, delivered: 0, pending: 0, failed: 0 };

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
): Promise<void> {
  await enqueueManualOrderAdminAlert(db, {
    orderId: order.id,
    orderCode: order.orderCode,
    items: order.items.map((item) => ({ name: item.product.name, qty: item.quantity })),
    total: order.totalAmount,
    currency: order.currency,
  });
  await logAdminAction(db, {
    adminId: null,
    action: "order.digiflazz_dispatch_failed",
    targetType: "order",
    targetId: order.id,
    details: `Digiflazz gagal — perlu ditangani manual. Order ${order.orderCode}: ${reason}`,
  });
  logger.warn(
    `Digiflazz dispatch failed for order ${order.orderCode} (${reason}) — queued for manual fulfilment and alerted admins`,
  );
}

/**
 * The Digiflazz dispatch poller. Finds PROCESSING orders whose item routes to
 * Digiflazz (denomination.autoDeliverySource === "digiflazz") and haven't been
 * dispatched yet (digiflazzDispatchedAt IS NULL), claims each one atomically
 * (same updateMany-with-status-guard shape fulfillManualOrder's own claim
 * uses, applied to the dispatch step instead of the delivery step — see
 * Order.digiflazzDispatchedAt's doc comment in schema.prisma), and places the
 * top-up order with Digiflazz.
 *
 * No-op (returns the zero summary, touches nothing) if Digiflazz isn't
 * configured — never claims orders it can't actually dispatch.
 *
 * Each candidate is claimed and dispatched one at a time (not batched inside
 * one transaction): SQLite has one writer, and a supplier HTTP round-trip
 * inside a long-held transaction would starve every other writer, so the
 * atomic claim is its own short write and the HTTP call happens outside it —
 * same reasoning as enqueueFlashSaleBroadcast's chunking.
 */
export async function dispatchPendingDigiflazzOrders(db: PrismaClient): Promise<DigiflazzDispatchSummary> {
  const creds = await getDigiflazzCreds(db);
  if (!creds) return ZERO_SUMMARY;

  const candidates: DigiflazzCandidateOrder[] = await db.order.findMany({
    where: {
      status: OrderStatus.PROCESSING,
      digiflazzDispatchedAt: null,
      items: { some: { product: { autoDeliverySource: "digiflazz" } } },
    },
    include: {
      items: {
        include: {
          product: { select: { name: true, supplierSku: true, additionalFields: true, autoDeliverySource: true } },
        },
      },
    },
  });

  const summary: DigiflazzDispatchSummary = { claimed: 0, delivered: 0, pending: 0, failed: 0 };

  for (const order of candidates) {
    // Atomic claim: only proceed to call Digiflazz if THIS call wins the
    // race (count === 1). A concurrent tick, a restarted poller, or a retry
    // that re-fetched the same candidate list all lose here instead of
    // double-dispatching the same order to the supplier.
    const claim = await db.order.updateMany({
      where: { id: order.id, status: OrderStatus.PROCESSING, digiflazzDispatchedAt: null },
      data: { digiflazzDispatchedAt: new Date() },
    });
    if (claim.count !== 1) continue;
    summary.claimed++;

    // I6/N1 fixes: resolveSingleDigiflazzItem is the single shared rule for
    // "find the order's Digiflazz-routed item(s) and refuse unless there is
    // exactly one at quantity 1" — see its doc comment above for the two
    // failure shapes (no/unconfigured item vs. more than one unit) it
    // distinguishes.
    const resolution = resolveSingleDigiflazzItem(order);
    if (!resolution.ok) {
      await alertDigiflazzDispatchFailed(db, order, resolution.reason);
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
        await fulfillDigiflazzOrder(db, order.id, { sn: result.sn ?? "" });
        summary.delivered++;
        logger.info(`Digiflazz auto-delivered order ${order.orderCode} (buyerSkuCode ${supplierSku})`);
      } else if (result.status === "Pending") {
        summary.pending++;
        logger.info(
          `Digiflazz order ${order.orderCode} (buyerSkuCode ${supplierSku}) is Pending — left PROCESSING, awaiting the supplier's final report`,
        );
      } else {
        await alertDigiflazzDispatchFailed(
          db,
          order,
          `Digiflazz reported Gagal${result.message ? ` (${result.message})` : ""}`,
        );
        summary.failed++;
      }
    } catch (err) {
      // The HTTP call itself failed (network error, timeout, malformed
      // response — see @app/core/suppliers/digiflazz's fetchDigiflazzJson).
      // The claim above already committed, so this order will never be
      // retried by this poller — whether Digiflazz actually placed the order
      // is now unknown, so this can only be resolved by a human, same as an
      // explicit "Gagal". err's message is already credential-free (the
      // client's own guarantee); never log err.cause or the request body.
      const message = err instanceof Error ? err.message : String(err);
      await alertDigiflazzDispatchFailed(db, order, `the request to Digiflazz failed (${message})`);
      summary.failed++;
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
    data: { status: OrderStatus.DELIVERED, deliveredContent: args.sn, deliveredAt: now },
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
  /** Non-null when a Product with this exact digiflazzBrand already exists —
   * the wizard renders this group read-only ("Sudah ada"; updates flow
   * through resyncDigiflazzCatalog, not a re-import). */
  existingProductId: number | null;
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
 * Non-regression: for a brand where no row's productName has a
 * (non-denylisted) region suffix, digiflazzGroupKey's displayName equals the
 * raw brand string, so the composite key is byte-identical to today's plain
 * `item.brand` — every brand already imported into the DB continues to match
 * on the next sync (see digiflazzGroupKey/parseProductRegion's denylist in
 * @app/core/suppliers/digiflazz).
 */
export async function groupDigiflazzPriceListByBrand(
  db: Db,
  rawItems: DigiflazzPriceListItem[],
): Promise<DigiflazzBrandGroup[]> {
  const items = collapseToCheapestSeller(rawItems);
  const byBrand = new Map<string, { rawBrand: string; region: string | null; items: DigiflazzPriceListItem[] }>();
  for (const item of items) {
    if (!item.brand) continue;
    const { displayName, region } = digiflazzGroupKey(item.brand, item.productName);
    const group = byBrand.get(displayName) ?? { rawBrand: item.brand, region, items: [] };
    group.items.push(item);
    byBrand.set(displayName, group);
  }
  const brands = [...byBrand.keys()];
  const existing = await db.product.findMany({
    where: { digiflazzBrand: { in: brands } },
    select: { id: true, digiflazzBrand: true },
  });
  const existingByBrand = new Map(existing.map((p) => [p.digiflazzBrand!, p.id]));
  return brands.map((brand) => {
    const group = byBrand.get(brand)!;
    return {
      brand,
      rawBrand: group.rawBrand,
      region: group.region,
      items: group.items,
      existingProductId: existingByBrand.get(brand) ?? null,
    };
  });
}

/** The admin's configured global markup rule, as read from Settings — split
 * out of computeDigiflazzMarkupPrice (I3 fix) so a caller processing many
 * rows/denominations in one run (resyncDigiflazzCatalog's loop, the sync
 * preview route's per-SKU computation) reads Settings ONCE per run instead
 * of twice per row against this repo's single-writer SQLite. */
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
  args: { brand: string; categoryId: number; rows: DigiflazzImportRow[] },
): Promise<{ productId: number; denominationCount: number }> {
  return db.$transaction(async (tx) => {
    let product = await tx.product.findFirst({ where: { digiflazzBrand: args.brand } });
    if (!product) {
      product = await createCatalogProduct(tx, {
        categoryId: args.categoryId,
        name: args.brand,
        digiflazzBrand: args.brand,
        isActive: false,
      });
    }
    const markupSettings = await getDigiflazzMarkupSettings(tx);
    for (const row of args.rows) {
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

      const existingDenom = await tx.denomination.findFirst({
        where: { productId: product.id, supplierSku: row.buyerSkuCode },
      });
      if (existingDenom) {
        await updateDenomination(tx, existingDenom.id, {
          name: denomName,
          durationLabel: denomName,
          price,
          costPrice,
          priceOverridden,
        });
      } else {
        await createDenomination(tx, {
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
          deliveryType: DeliveryType.MANUAL_WITH_INFO,
          additionalFields: JSON.stringify(DEFAULT_DIGIFLAZZ_FIELDS),
          isActive: false,
        });
      }
    }
    return { productId: product.id, denominationCount: args.rows.length };
  });
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
    const newPrice = quantizeMoney(applyDigiflazzMarkup(item.price, markupSettings), 4);
    const oldPrice = denom.price;
    // oldPrice.isZero() guards the ratio check below from dividing by zero:
    // any nonzero new price on a zero old price counts as a sharp change on
    // its own.
    const sharp = oldPrice.isZero()
      ? !newPrice.isZero()
      : newPrice.lessThan(oldPrice.times(0.5)) || newPrice.greaterThan(oldPrice.times(1.5));
    if (sharp) sharpChanges++;
  }
  // Integer comparison (sharpChanges * 5 > consideredRows) instead of a
  // floating-point ratio — both sides are plain row counts, and this avoids
  // any doubt about a >20% boundary landing exactly on a float rounding
  // error.
  if (consideredRows >= 5 && sharpChanges * 5 > consideredRows) {
    logger.error(
      { sharpChanges, consideredRows },
      "Aborted the hourly Digiflazz catalog resync because too many denominations' prices would have moved by more than 50% in this run — that usually means the supplier's price-list response is malformed (a field rename, a partial outage, the wrong endpoint) rather than a genuine market-wide price change, so nothing was written.",
    );
    await logAdminAction(db, {
      adminId: null,
      action: "digiflazz_catalog_resync_aborted",
      targetType: "product",
      targetId: null,
      details: `Aborted the hourly Digiflazz catalog sync: ${sharpChanges} of ${consideredRows} prices would have moved by more than 50%, which usually means the supplier's response is malformed rather than a real price change. Nothing was updated — please check the Digiflazz connection before the next run.`,
    });
    await enqueueAdminDigiflazzResyncAborted(db, { sharpChanges, consideredRows });
    return zero;
  }

  const result = { ...zero };
  for (const denom of mapped) {
    const item = bySku.get(denom.supplierSku!);
    if (!item) continue; // Digiflazz no longer lists this SKU — leave it as-is, not this job's concern.

    // I5 fix: quantize to the same 4-decimal precision createDenomination
    // already uses, so a percentage markup can't drift the stored price
    // away from import-time precision.
    const data: Record<string, unknown> = { costPrice: quantizeMoney(item.price, 4) };
    if (!denom.priceOverridden) {
      data.price = quantizeMoney(applyDigiflazzMarkup(item.price, markupSettings), 4);
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
 * SQLite's single-writer lock across a full-catalog scan.
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
