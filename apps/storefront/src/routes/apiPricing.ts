/**
 * GET /api/v1/pricing/quote — the price of ONE denomination at a quantity,
 * for the product page's quantity field.
 *
 * Server-authoritative by design: the client sends a denomination id and a
 * quantity, never a price, and renders exactly what comes back. The figures
 * are the volume-tier engine's (`quoteBulkForLines`, @app/db crud/bulkTiers.ts)
 * — the same call `computeTotals` (the checkout preview) and both order
 * creation paths make — priced for the signed-in viewer (a reseller's
 * effective unit, a live flash sale), so the product page can never quote a
 * per-unit price or a saving the checkout would not charge.
 *
 * A pure read: no CSRF (nothing changes), no cart access, `private, no-store`
 * because a reseller and a guest get different answers. The same
 * denomination/quantity validation as `POST /topup/preview` applies (an
 * inactive or hidden plan, or a quantity outside 1..99 — 1 for a
 * Digiflazz-routed SKU — is a 400).
 */
import type { FastifyPluginAsync } from "fastify";
import { UserRole } from "@app/core/enums";
import { prisma, quoteBulkForLines } from "@app/db";
import { optionalCustomer } from "../plugins/auth";
import { linePricingView } from "../tierView";
import { resolveTopupDenomination, resolveTopupQuantity } from "./apiTopup";

const apiPricingRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { denomination_id?: string; qty?: string } }>("/pricing/quote", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const denom = await resolveTopupDenomination(req.query?.denomination_id);
    if (!denom) return reply.code(400).send({ error: "invalid_request" });
    const quantity = resolveTopupQuantity(req.query?.qty, denom);
    if (quantity === null) return reply.code(400).send({ error: "invalid_request" });
    const customer = await optionalCustomer(req);
    const isReseller = customer?.user.role === UserRole.RESELLER;
    const quote = await quoteBulkForLines(
      prisma,
      [{ denominationId: denom.id, quantity, denomination: denom }],
      isReseller,
      new Date(),
    );
    return reply.send({ denomination_id: denom.id, ...linePricingView(quote.lines[0]!.priced) });
  });
};

export default apiPricingRoutes;
