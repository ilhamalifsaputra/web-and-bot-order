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
import { enqueueManualOrderAdminAlert, enqueueManualDeliveredDm } from "./notifications";
import { logAdminAction } from "./audit";
import {
  createCatalogProduct,
  createDenomination,
  updateDenomination,
  updateCatalogProduct,
  ensureUniqueSlug,
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

    // I6 fix: the candidate query's own filter is `some: { product: {
    // autoDeliverySource: "digiflazz" } } }` — it does NOT guarantee that
    // item is order.items[0]. Select the actual Digiflazz-routed item(s)
    // explicitly, matching the same field the query filtered on, instead of
    // implicitly relying on array order (an order whose Digiflazz item
    // wasn't first used to either raise a bogus "no supplierSku" alert or
    // dispatch the WRONG SKU to the supplier).
    const digiflazzItems = order.items.filter((i) => i.product.autoDeliverySource === "digiflazz");
    const item = digiflazzItems[0];
    const supplierSku = item?.product.supplierSku;
    if (!item || !supplierSku) {
      await alertDigiflazzDispatchFailed(db, order, "the SKU has no supplierSku configured");
      summary.failed++;
      continue;
    }

    // N1 defense-in-depth: this poller places exactly ONE supplier
    // top-up per order and then marks the WHOLE order DELIVERED, so it must
    // never dispatch when the order's Digiflazz allocation isn't exactly one
    // unit — whether that shows up as a single line with quantity > 1, or as
    // more than one Digiflazz-routed line in the same order (both are
    // "more than 1 unit" from the supplier's point of view). The front door
    // for this (storefront's cart-add / cart-update routes) is closed
    // separately; this is the backstop for anything that slips past it — a
    // pre-existing PROCESSING order from before that fix shipped, an admin
    // manually creating/editing an order, or a future code path nobody
    // thought to gate. Genuine multi-unit supplier dispatch (N separate
    // createTransaction calls / SNs) is out of scope by design — this only
    // refuses and alerts, it never attempts to dispatch more than one unit.
    if (digiflazzItems.length !== 1 || item.quantity !== 1) {
      const reason =
        digiflazzItems.length === 1
          ? `this order's Digiflazz item has quantity ${item.quantity} — auto-delivery only supports quantity 1 per order, needs manual review`
          : `this order has ${digiflazzItems.length} Digiflazz line(s) totaling quantity ${digiflazzItems.reduce((sum, i) => sum + i.quantity, 0)} — auto-delivery only supports a single line of quantity 1 per order, needs manual review`;
      await alertDigiflazzDispatchFailed(db, order, reason);
      summary.failed++;
      continue;
    }

    const customerNo = buildDigiflazzCustomerNo(item.product, order.customerData);

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
  categoryId: number;
  isActive: boolean;
  groups: DigiflazzRegionGroup[];
}

export interface DigiflazzMixedProductDetection {
  /** Products found with 2+ distinct region buckets — need splitting. */
  mixed: DigiflazzMixedProductPlan[];
  /** Names of candidate Digiflazz products that are NOT mixed (a single
   * region bucket — including "every denomination unsuffixed") and are left
   * untouched. */
  skipped: string[];
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

  const mixed: DigiflazzMixedProductPlan[] = [];
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

    mixed.push({
      productId: product.id,
      originalName: product.name,
      categoryId: product.categoryId,
      isActive: product.isActive,
      groups,
    });
  }

  return { mixed, skipped };
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
 */
export async function splitMixedDigiflazzProducts(
  db: PrismaClient,
): Promise<{ productsSplit: number; productsCreated: number; denominationsMoved: number; skipped: string[] }> {
  const { mixed, skipped } = await detectMixedDigiflazzProducts(db);

  let productsSplit = 0;
  let productsCreated = 0;
  let denominationsMoved = 0;

  for (const plan of mixed) {
    const [winningGroup, ...otherGroups] = plan.groups;
    const allNewNames = plan.groups.map((g) => g.displayName);

    await db.$transaction(async (tx) => {
      // Rename the ORIGINAL row in place. ensureUniqueSlug has no
      // "exclude this row" clause, so regenerate the slug BEFORE the update,
      // using the NEW name — safe since the composite name's slug will
      // essentially never collide with the product's own current (about to
      // be replaced) slug.
      const winningSlug = await ensureUniqueSlug(tx, "product", winningGroup!.displayName);
      await updateCatalogProduct(tx, plan.productId, {
        name: winningGroup!.displayName,
        digiflazzBrand: winningGroup!.displayName,
        slug: winningSlug,
      });
      // Strip the region suffix on the denominations staying put too, for
      // consistency with what fresh imports now produce (Task 2).
      for (const denom of winningGroup!.denominations) {
        const stripped = stripRegionSuffix(denom.name);
        await updateDenomination(tx, denom.id, { name: stripped, durationLabel: stripped });
      }

      for (const group of otherGroups) {
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
          denominationsMoved++;
        }
      }

      await logAdminAction(tx, {
        adminId: null,
        action: "digiflazz_catalog_region_split",
        targetType: "product",
        targetId: plan.productId,
        details: `Split mixed-region product "${plan.originalName}" into ${plan.groups.length} region products: ${allNewNames.join(", ")}.`,
      });
    });

    productsSplit++;
    productsCreated += otherGroups.length;
  }

  return { productsSplit, productsCreated, denominationsMoved, skipped };
}
