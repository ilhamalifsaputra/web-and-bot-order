import type { FastifyInstance } from "fastify";
import { Decimal } from "@app/core/money";
import { isRoundingPolicy, resolveDenominationPrice, grossProfit, grossMarginPct } from "@app/core/pricingRule";
import {
  prisma, getPricingPolicy, getCategoryRule, setGlobalPricing, setCategoryRule, clearCategoryRule,
  computeRepriceImpact, applyReprice, PricingValidationError, PricingPolicyUnreadableError,
  RepriceBusyError, RepriceLeaseLostError, RepricePolicyChangedError, RepriceAuditFailedError, validateGlobalPricingInput, listPricingCategories,
  type GlobalPricingInput, type RepriceScope,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { exactFields, readMoneyField, readPercentField } from "../../lib/moneyField";
import { isServerAutoPriced } from "../../lib/catalogPricing";

function input(body: Record<string, unknown>): GlobalPricingInput {
  const exact = exactFields(body);
  const result: GlobalPricingInput = {};
  if ("markupType" in body || "markupValue" in body) {
    const type = body.markupType;
    if (type !== null && type !== "percent" && type !== "flat") throw new PricingValidationError("Choose a valid markup type.");
    const value = type === null ? new Decimal(0) : type === "percent"
      ? readPercentField(body.markupValue, { exact: exact.has("markupValue") })
      : readMoneyField(body.markupValue, "IDR", { exact: exact.has("markupValue") });
    if (value === null) throw new PricingValidationError("Enter a valid markup amount.");
    result.markupType = type;
    result.markupValue = value;
  }
  if ("rounding" in body) {
    if (!isRoundingPolicy(body.rounding)) throw new PricingValidationError("Choose a valid rounding policy.");
    result.rounding = body.rounding;
  }
  if ("lowMarginWarnPct" in body) {
    const raw = body.lowMarginWarnPct;
    const value = raw === null || raw === "" ? null : readPercentField(raw, { exact: exact.has("lowMarginWarnPct") });
    if (value === null && raw !== null && raw !== "") throw new PricingValidationError("Enter a valid margin threshold.");
    result.lowMarginWarnPct = value;
  }
  validateGlobalPricingInput(result);
  return result;
}

function positiveId(raw: unknown): number {
  if (typeof raw !== "number" && (typeof raw !== "string" || !/^\d+$/.test(raw))) throw new PricingValidationError("Invalid category or SKU id.");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new PricingValidationError("Invalid category or SKU id.");
  return id;
}
function scope(body: Record<string, unknown>): RepriceScope {
  return body.scope === "all" ? "all" : positiveId(body.scope);
}

export default async function pricingApiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preValidation", async req => {
    if (req.body !== undefined && req.body !== null && (typeof req.body !== "object" || Array.isArray(req.body))) {
      throw new PricingValidationError("Send a JSON object with pricing fields.");
    }
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PricingValidationError) return reply.code(400).send({ error: err.message });
    // error_args says which stored piece is unreadable, so the admin client can
    // show its own Indonesian sentence next to the button (review M2).
    if (err instanceof PricingPolicyUnreadableError) {
      const args: Record<string, string> = { policy: err.what };
      if (err.what === "category") args.categories = err.categoryNames.join(", ");
      return reply.code(400).send({ error: err.message, error_args: args });
    }
    if (err instanceof RepriceBusyError || err instanceof RepriceLeaseLostError || err instanceof RepricePolicyChangedError) {
      return reply.code(409).send({ error: err.message });
    }
    // Already logged at error level by applyReprice; the prices are live.
    if (err instanceof RepriceAuditFailedError) return reply.code(500).send({ error: err.message });
    throw err;
  });
  app.get("/api/pricing", { preHandler: currentAdmin }, async (req) => {
    const [policy, categories] = await Promise.all([getPricingPolicy(prisma), listPricingCategories(prisma)]);
    return { policy, isOwner: req.admin!.role === "super", categories };
  });
  app.post("/api/pricing/global", { preHandler: csrfProtect }, async req =>
    setGlobalPricing(prisma, req.admin!.userId, input((req.body ?? {}) as Record<string, unknown>)));
  app.put("/api/pricing/categories/:id", { preHandler: csrfProtect }, async req => {
    const rule = input((req.body ?? {}) as Record<string, unknown>);
    if (rule.markupType !== "percent" && rule.markupType !== "flat") throw new PricingValidationError("Choose percent or flat for a category override.");
    return setCategoryRule(prisma, req.admin!.userId, positiveId((req.params as { id: string }).id), { markupType: rule.markupType, markupValue: rule.markupValue! });
  });
  app.delete("/api/pricing/categories/:id", { preHandler: csrfProtect }, async req =>
    clearCategoryRule(prisma, req.admin!.userId, positiveId((req.params as { id: string }).id)));
  app.post("/api/pricing/preview", { preHandler: csrfProtect }, async req => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const draft = input(body);
    const stored = await getPricingPolicy(prisma);
    const rule = draft.markupType !== undefined ? { type: draft.markupType, value: draft.markupValue! } : stored.globalRule;
    if (!rule) throw new PricingPolicyUnreadableError("markup");
    if (draft.rounding === undefined && !stored.roundingReadable) throw new PricingPolicyUnreadableError("rounding");
    const denomination = body.denominationId === undefined ? null : await prisma.denomination.findUnique({ where: { id: positiveId(body.denominationId) }, include: { product: { include: { category: true } } } });
    if (body.denominationId !== undefined && !denomination) throw new PricingValidationError("SKU not found.");
    const categoryId = denomination?.product.categoryId ?? (body.categoryId == null ? null : positiveId(body.categoryId));
    const categoryRule = categoryId === null ? null : await getCategoryRule(prisma, categoryId);
    const costs = denomination ? [denomination.costPrice] : body.costs;
    if (!Array.isArray(costs) || !costs.length || costs.length > 20) throw new PricingValidationError("Supply between 1 and 20 sample costs.");
    return { rows: costs.map(raw => {
      const cost = denomination ? (raw === null ? null : new Decimal(String(raw))) : readMoneyField(raw, "IDR", { exact: exactFields(body).has("costs") });
      if (!denomination && cost === null) throw new PricingValidationError("Enter a valid sample cost.");
      // What the resync / Apply now will do to this SKU (pricing review I2).
      const manual = denomination ? denomination.priceOverridden || !isServerAutoPriced(denomination) : false;
      const resolved = resolveDenominationPrice({ cost, currentPrice: denomination ? new Decimal(denomination.price) : new Decimal(0), priceOverridden: manual,
        categoryRule, globalRule: rule, rounding: draft.rounding ?? stored.rounding,
        lowMarginWarnPct: draft.lowMarginWarnPct === undefined ? stored.lowMarginWarnPct : draft.lowMarginWarnPct });
      return { ...resolved, costPrice: cost, grossProfit: grossProfit(resolved.effectivePrice, cost), grossMarginPct: grossMarginPct(resolved.effectivePrice, cost) };
    }) };
  });
  app.post("/api/pricing/reprice/preview", { preHandler: csrfProtect }, async req =>
    computeRepriceImpact(prisma, scope((req.body ?? {}) as Record<string, unknown>)));
  app.post("/api/pricing/reprice/apply", { preHandler: csrfProtect }, async req => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fingerprint = body.policyFingerprint;
    // Apply is bound to the policy the admin previewed (a policy saved in
    // between is refused with 409 instead of applying prices nobody saw).
    if (typeof fingerprint !== "string" || !/^[0-9a-f]{32}$/.test(fingerprint)) {
      throw new PricingValidationError("Open the impact preview before applying prices.");
    }
    return applyReprice(prisma, req.admin!.userId, scope(body), new Date(), { expectedPolicyFingerprint: fingerprint });
  });
}
