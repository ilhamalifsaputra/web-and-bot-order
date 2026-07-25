/**
 * Bulk flash-sale authoring — apply or end a flash sale across many
 * denominations (SKUs) at once, possibly spanning different products. The
 * per-SKU flash-sale form on the denomination edit page
 * (`/api/catalog/denominations/:id/flash-sale`) is unchanged; this is a
 * second authoring surface over the same `setFlashSale`/`clearFlashSale`
 * primitives, for admins running a storewide promotion.
 */
import type { FastifyInstance } from "fastify";
import {
  prisma,
  listDenominationsWithFlashInfo,
  flashSalePerformance,
  availableStockCountsByDenomination,
  bulkSetFlashSale,
  bulkClearFlashSale,
  logAdminAction,
} from "@app/db";
import { Decimal } from "@app/core/money";
import { localize, parseShopLocal } from "@app/core/datetime";
import { isFlashActive } from "@app/core/flash";
import { quantizeMoney } from "@app/core/formatters";
import { DeliveryType } from "@app/core/enums";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

/** Parse a possibly-blank string into a Decimal, or null if blank/invalid. */
function parseDecimal(value: unknown): Decimal | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new Decimal(value.trim());
  } catch {
    return null;
  }
}

/** A body array of denomination ids, deduped, or null if empty/malformed. */
function parseDenominationIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = value.map((v) => Number(v));
  if (ids.some((id) => !Number.isInteger(id))) return null;
  return Array.from(new Set(ids));
}

export default async function flashSalesApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/flash-sales/denominations", { preHandler: currentAdmin }, async (req, reply) => {
    const rows = await listDenominationsWithFlashInfo(prisma);
    const now = new Date();

    // Bulk-compute both aggregates once up front (not per-row, which would be
    // N+1 queries): performance is scoped to each scheduled SKU's own flash
    // window, and available-stock only makes sense for auto-delivery SKUs.
    const scheduled = rows.filter(
      (d) => d.flashDiscountPercent != null && d.flashStartsAt != null && d.flashEndsAt != null,
    );
    const entries = scheduled.map((d) => ({
      denominationId: d.id,
      startsAt: d.flashStartsAt!,
      endsAt: d.flashEndsAt!,
    }));
    const performance = await flashSalePerformance(prisma, entries);
    const autoDeliveryIds = scheduled.filter((d) => d.deliveryType === DeliveryType.AUTO).map((d) => d.id);
    const availableStock = await availableStockCountsByDenomination(prisma, autoDeliveryIds);

    return reply.send({
      denominations: rows.map((d) => {
        const hasSchedule = d.flashDiscountPercent != null && d.flashStartsAt != null && d.flashEndsAt != null;
        return {
          id: d.id,
          name: d.name,
          price: d.price.toString(),
          isActive: d.isActive,
          productId: d.productId,
          productName: d.product.name,
          categoryName: d.product.category?.name ?? null,
          flash: hasSchedule
            ? {
                discountPercent: d.flashDiscountPercent!.toString(),
                // Pre-rendered shop-local wall clock — same convention as the
                // single-SKU edit form (apps/web-admin/src/routes/api/catalog.ts),
                // so an admin's own browser timezone never enters the display.
                startsAtDisplay: localize(d.flashStartsAt!, "dd LLL yyyy HH:mm"),
                endsAtDisplay: localize(d.flashEndsAt!, "dd LLL yyyy HH:mm"),
                // Additive raw instants (Task 3 scope extension — see
                // apps/web-admin/client/src/pages/FlashSalesPage.tsx) purely so
                // the client can do timezone-independent UTC millisecond math
                // for a "starts in / ends in" countdown, WITHOUT re-deriving a
                // shop-local wall-clock string from them (that still requires
                // the server's TIMEZONE config, which the client doesn't have —
                // these are not used for pre-filling the datetime-local edit form).
                startsAtIso: d.flashStartsAt!.toISOString(),
                endsAtIso: d.flashEndsAt!.toISOString(),
                // Computed here (not on the client) so no date math or timezone
                // handling has to travel to the browser at all.
                status: isFlashActive(d, now) ? "live" : d.flashStartsAt! > now ? "scheduled" : "ended",
                // Plain percent-off arithmetic, deliberately NOT gated by the
                // schedule window: unlike checkout's `flashPrice()` (which
                // must only ever charge the discount while the window is open),
                // this "Sale Price" column needs to show what the price IS
                // (live), WILL BE (scheduled), or WAS (ended) — hasSchedule
                // already guarantees discountPercent/startsAt/endsAt are all
                // non-null here. Same rounding convention flashPrice() itself
                // uses (packages/core/src/flash.ts): whole rupiah, not 2dp.
                salePrice: quantizeMoney(
                  new Decimal(d.price).times(new Decimal(100).minus(d.flashDiscountPercent!)).div(100),
                  0,
                ).toString(),
                sold: performance.get(d.id)?.sold ?? 0,
                revenue: (performance.get(d.id)?.revenue ?? new Decimal(0)).toString(),
                orders: performance.get(d.id)?.orders ?? 0,
                // null = no inventory concept for this SKU (manual delivery);
                // 0 = auto-delivery but currently out of stock. The client
                // needs to tell these apart to decide whether to render a
                // stock progress bar at all.
                availableStock: d.deliveryType === DeliveryType.AUTO ? (availableStock.get(d.id) ?? 0) : null,
              }
            : null,
        };
      }),
    });
  });

  app.post("/api/flash-sales/bulk-apply", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const denominationIds = parseDenominationIds(body.denominationIds);
    if (denominationIds === null) return reply.code(400).send({ error: "Select at least one SKU." });

    const discountPercent = parseDecimal(body.discountPercent);
    if (discountPercent === null) return reply.code(400).send({ error: "A valid discount percent is required." });

    // Same bare wall-clock convention as the single-SKU flash-sale route: the
    // form submits <input type="datetime-local"> strings in the shop's timezone.
    const startsAt = typeof body.startsAt === "string" ? parseShopLocal(body.startsAt) : null;
    if (startsAt === null) return reply.code(400).send({ error: "A valid start time is required." });
    const endsAt = typeof body.endsAt === "string" ? parseShopLocal(body.endsAt) : null;
    if (endsAt === null) return reply.code(400).send({ error: "A valid end time is required." });

    const { applied, overwritten, failed } = await bulkSetFlashSale(prisma, {
      denominationIds,
      discountPercent,
      startsAt,
      endsAt,
    });

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "flash_sale_bulk_set",
      targetType: "denomination",
      targetId: null,
      details:
        `Applied a ${discountPercent.toString()}% flash sale (${localize(startsAt, "dd LLL yyyy HH:mm")}` +
        `–${localize(endsAt, "dd LLL yyyy HH:mm")}) to ${applied} SKU(s)` +
        `${overwritten > 0 ? ` (${overwritten} replacing an existing schedule)` : ""}` +
        `${failed > 0 ? `; ${failed} failed.` : "."}`,
    });

    return reply.send({ ok: true, applied, overwritten, failed });
  });

  app.post("/api/flash-sales/bulk-end", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const denominationIds = parseDenominationIds(body.denominationIds);
    if (denominationIds === null) return reply.code(400).send({ error: "Select at least one SKU." });

    const { cleared, skipped } = await bulkClearFlashSale(prisma, denominationIds);

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "flash_sale_bulk_end",
      targetType: "denomination",
      targetId: null,
      details: `Ended the flash sale on ${cleared} SKU(s).`,
    });

    return reply.send({ ok: true, cleared, skipped });
  });
}
