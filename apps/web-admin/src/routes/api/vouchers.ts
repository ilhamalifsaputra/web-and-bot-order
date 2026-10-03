import type { FastifyInstance } from "fastify";
import { parsePositiveId } from "../../lib/params";
import { readMoneyField, readPercentField, moneyFieldError, percentFieldError } from "../../lib/moneyField";
import { VoucherType, VoucherScope } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { errorBody } from "@app/core/errorBody";
import { Decimal } from "@app/core/money";
import { parseShopLocal } from "@app/core/datetime";
import {
  prisma,
  listVouchersPaged,
  getVoucherStats,
  getVoucherPerformance,
  getVoucherProductNames,
  getVoucherProductIds,
  getVoucherByCode,
  getVoucher,
  createVoucher,
  updateVoucher,
  setVoucherActive,
  deleteVoucher,
  bulkSetVouchersActive,
  bulkDeleteVouchers,
  logAdminAction,
  deriveVoucherStatus,
  type VoucherStatus,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { displayDate } from "../../dateDisplay";

const VOUCHER_TYPES = Object.values(VoucherType) as string[];
const VOUCHER_SCOPES = Object.values(VoucherScope) as string[];
const PAGE_SIZE = 50;
const VOUCHER_STATUSES: readonly VoucherStatus[] = ["active", "expired", "usedUp", "disabled", "scheduled"];

/** Absent, null or whitespace-only: the form left the optional field empty. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** A voucher's value is a percent for PERCENT vouchers and a rupiah amount for FIXED ones. */
function readVoucherValue(value: unknown, type: string): Decimal | null {
  return type === VoucherType.PERCENT ? readPercentField(value) : readMoneyField(value);
}

function voucherValueError(type: string): string {
  return type === VoucherType.PERCENT ? percentFieldError("Value") : moneyFieldError("Value");
}

export default async function vouchersApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/vouchers", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const search = q.q?.trim() || null;
    const status = q.status && (VOUCHER_STATUSES as readonly string[]).includes(q.status) ? (q.status as VoucherStatus) : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const [{ rows, total }, stats] = await Promise.all([
      listVouchersPaged(prisma, { q: search, status, limit: PAGE_SIZE, offset }),
      getVoucherStats(prisma),
    ]);
    const voucherIds = rows.map((v) => v.id);
    const [performanceByVoucher, productNamesByVoucher] = await Promise.all([
      getVoucherPerformance(prisma, voucherIds),
      getVoucherProductNames(prisma, voucherIds),
    ]);
    const now = new Date();
    const vouchersWithDisplay = rows.map((v) => {
      const perf = performanceByVoucher.get(v.id);
      return {
        ...v,
        expiresAtDisplay: displayDate(v.expiresAt),
        products: v.scope === VoucherScope.SELECTED ? (productNamesByVoucher.get(v.id) ?? []) : [],
        status: deriveVoucherStatus(v, now),
        ordersCount: perf?.ordersCount ?? 0,
        revenue: perf?.revenue.toString() ?? "0",
        customers: perf?.customers ?? 0,
      };
    });
    return reply.send({
      vouchers: vouchersWithDisplay,
      types: VOUCHER_TYPES,
      scopes: VOUCHER_SCOPES,
      total,
      page,
      pageSize: PAGE_SIZE,
      stats,
    });
  });

  app.post("/api/vouchers", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const code = (body.code ?? "").trim().toUpperCase();
    if (!code) return reply.code(400).send({ error: "Code is required." });

    const typeUpper = (body.type ?? "").toUpperCase();
    if (!VOUCHER_TYPES.includes(typeUpper)) {
      return reply.code(400).send({ error: "Invalid voucher type." });
    }

    // Typed amounts are read by shape (`10.000` is ten thousand rupiah), and
    // the shared readers never return NaN/Infinity (M-3, backend audit
    // 2026-07-31) — an unreadable shape is a 400 naming the field.
    const valueDec = readVoucherValue(body.value, typeUpper);
    if (valueDec === null) return reply.code(400).send({ error: voucherValueError(typeUpper) });
    const minDec = isBlank(body.min_purchase) ? new Decimal(0) : readMoneyField(body.min_purchase);
    if (minDec === null) return reply.code(400).send({ error: moneyFieldError("Min purchase") });

    let limit: number | null = null;
    if ((body.usage_limit ?? "").trim()) {
      const n = Number(body.usage_limit);
      if (!Number.isInteger(n)) return reply.code(400).send({ error: "Usage limit must be a number." });
      limit = n;
    }

    let expiry: Date | null = null;
    const expiresRaw = (body.expires_at ?? "").trim();
    if (expiresRaw) {
      const d = parseShopLocal(`${expiresRaw}T23:59:59`);
      if (d === null) return reply.code(400).send({ error: "Expiry must be YYYY-MM-DD." });
      expiry = d;
    }

    // The four scope/scheduling fields below mirror POST /api/vouchers/:voucherId/update's
    // validation exactly (same field names, same error messages) so the create
    // and edit forms can share one request-body shape — see VouchersPage.tsx's
    // `voucherRequestBody` helper, which both the create and update mutations
    // now build their body from.
    let maxDiscountDec: Decimal | null = null;
    if (!isBlank(body.max_discount)) {
      maxDiscountDec = readMoneyField(body.max_discount);
      if (maxDiscountDec === null) return reply.code(400).send({ error: moneyFieldError("Max discount") });
    }

    let startAt: Date | null = null;
    const startAtRaw = (body.start_at ?? "").trim();
    if (startAtRaw !== "") {
      const d = parseShopLocal(startAtRaw);
      if (d === null) return reply.code(400).send({ error: "Start date must be YYYY-MM-DD." });
      startAt = d;
    }

    let scope: VoucherScope | undefined;
    if (body.scope !== undefined) {
      const scopeUpper = String(body.scope).toUpperCase();
      if (!VOUCHER_SCOPES.includes(scopeUpper)) {
        return reply.code(400).send({ error: "Invalid voucher scope." });
      }
      scope = scopeUpper as VoucherScope;
    }

    let productIds: number[] | undefined;
    if ((body as Record<string, unknown>).product_ids !== undefined) {
      const raw = (body as Record<string, unknown>).product_ids;
      if (!Array.isArray(raw) || !raw.every((id) => Number.isInteger(Number(id)) && Number(id) > 0)) {
        return reply.code(400).send({ error: "Product ids must be an array of positive integers." });
      }
      productIds = raw.map((id) => Number(id));
    }

    if ((await getVoucherByCode(prisma, code)) !== null) {
      return reply.code(409).send({ error: `Voucher '${code}' already exists.` });
    }
    let v;
    try {
      v = await createVoucher(prisma, {
        code,
        type: typeUpper as VoucherType,
        value: valueDec,
        usageLimit: limit,
        minPurchase: minDec,
        expiresAt: expiry,
        maxDiscount: maxDiscountDec,
        startAt,
        scope,
        productIds,
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(422).send(errorBody(err));
      }
      throw err;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "voucher_create",
      targetType: "voucher",
      targetId: v.id,
      details: `Created voucher "${code}" (${typeUpper}, value ${valueDec.toString()}, limit ${limit}).`,
    });
    return reply.code(201).send({ voucher: v });
  });

  app.post("/api/vouchers/:voucherId/update", { preHandler: csrfProtect }, async (req, reply) => {
    const voucherId = parsePositiveId((req.params as { voucherId: string }).voucherId);
    if (voucherId === null) return reply.code(400).send({ error: "Invalid voucher id." });
    const existing = await getVoucher(prisma, voucherId);
    if (existing === null) {
      return reply.code(404).send({ error: "Voucher not found." });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const args: Parameters<typeof updateVoucher>[2] = {};

    if (body.code !== undefined) {
      const code = String(body.code).trim().toUpperCase();
      if (!code) return reply.code(400).send({ error: "Code is required." });
      if (code !== existing.code) {
        const clash = await getVoucherByCode(prisma, code);
        if (clash !== null && clash.id !== voucherId) {
          return reply.code(409).send({ error: `Voucher '${code}' already exists.` });
        }
      }
      args.code = code;
    }

    if (body.type !== undefined) {
      const typeUpper = String(body.type).toUpperCase();
      if (!VOUCHER_TYPES.includes(typeUpper)) {
        return reply.code(400).send({ error: "Invalid voucher type." });
      }
      args.type = typeUpper as VoucherType;
    }

    // Amounts are read by shape (`10.000` is ten thousand rupiah); the shared
    // readers never return NaN/Infinity (M-3). The value is a percent or an
    // amount depending on the type this update leaves the voucher with.
    if (body.value !== undefined) {
      const effectiveType = args.type ?? existing.type;
      const value = readVoucherValue(body.value, effectiveType);
      if (value === null) return reply.code(400).send({ error: voucherValueError(effectiveType) });
      args.value = value;
    }

    if (body.min_purchase !== undefined) {
      const minPurchase = isBlank(body.min_purchase) ? new Decimal(0) : readMoneyField(body.min_purchase);
      if (minPurchase === null) return reply.code(400).send({ error: moneyFieldError("Min purchase") });
      args.minPurchase = minPurchase;
    }

    if (body.max_discount !== undefined) {
      if (isBlank(body.max_discount)) {
        args.maxDiscount = null;
      } else {
        const maxDiscount = readMoneyField(body.max_discount);
        if (maxDiscount === null) return reply.code(400).send({ error: moneyFieldError("Max discount") });
        args.maxDiscount = maxDiscount;
      }
    }

    if (body.usage_limit !== undefined) {
      const raw = String(body.usage_limit ?? "").trim();
      if (raw === "") {
        args.usageLimit = null;
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n)) return reply.code(400).send({ error: "Usage limit must be a number." });
        args.usageLimit = n;
      }
    }

    if (body.expires_at !== undefined) {
      const raw = String(body.expires_at ?? "").trim();
      if (raw === "") {
        args.expiresAt = null;
      } else {
        const d = parseShopLocal(`${raw}T23:59:59`);
        if (d === null) return reply.code(400).send({ error: "Expiry must be YYYY-MM-DD." });
        args.expiresAt = d;
      }
    }

    if (body.start_at !== undefined) {
      const raw = String(body.start_at ?? "").trim();
      if (raw === "") {
        args.startAt = null;
      } else {
        const d = parseShopLocal(raw);
        if (d === null) return reply.code(400).send({ error: "Start date must be YYYY-MM-DD." });
        args.startAt = d;
      }
    }

    if (body.scope !== undefined) {
      const scopeUpper = String(body.scope).toUpperCase();
      if (!VOUCHER_SCOPES.includes(scopeUpper)) {
        return reply.code(400).send({ error: "Invalid voucher scope." });
      }
      args.scope = scopeUpper as VoucherScope;
    }

    // Only touch the product set when the request explicitly mentions it —
    // defaulting a missing `product_ids` to `[]` here would silently wipe an
    // existing SELECTED-scope voucher's products on every partial update
    // that doesn't happen to mention them (the same bug fixed at the crud
    // layer in updateVoucher itself; see that function's doc comment).
    if (body.product_ids !== undefined) {
      const raw = body.product_ids;
      if (!Array.isArray(raw) || !raw.every((id) => Number.isInteger(Number(id)) && Number(id) > 0)) {
        return reply.code(400).send({ error: "Product ids must be an array of positive integers." });
      }
      args.productIds = raw.map((id) => Number(id));
    }

    let updated;
    try {
      updated = await updateVoucher(prisma, voucherId, args);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(422).send(errorBody(err));
      }
      if (err instanceof Error && err.message === "cannot change the code of a voucher that has been used") {
        return reply.code(409).send({ error: "Cannot change code: this voucher has already been used." });
      }
      throw err;
    }

    const summaryParts: string[] = [];
    if (updated && args.value !== undefined) {
      summaryParts.push(`value ${updated.value.toString()}${updated.type === VoucherType.PERCENT ? "%" : ""}`);
    }
    if (updated && (args.scope !== undefined || args.productIds !== undefined)) {
      const productCount = (await getVoucherProductIds(prisma, voucherId)).length;
      summaryParts.push(updated.scope === VoucherScope.SELECTED ? `scope: ${productCount} products` : "scope: all products");
    }
    const details = `Updated voucher "${updated?.code}"${summaryParts.length > 0 ? ` (${summaryParts.join(", ")})` : ""}.`;

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "voucher_update",
      targetType: "voucher",
      targetId: voucherId,
      details,
    });
    return reply.send({ voucher: updated });
  });

  app.post("/api/vouchers/:voucherId/toggle", { preHandler: csrfProtect }, async (req, reply) => {
    const voucherId = parsePositiveId((req.params as { voucherId: string }).voucherId);
    if (voucherId === null) return reply.code(400).send({ error: "Invalid voucher id." });
    const isActive = (req.body as Record<string, string>).is_active;
    const active = ["1", "true", "on", "yes"].includes((isActive ?? "").toLowerCase());
    if ((await getVoucher(prisma, voucherId)) === null) {
      return reply.code(404).send({ error: "Voucher not found." });
    }
    await setVoucherActive(prisma, voucherId, active);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "voucher_toggle",
      targetType: "voucher",
      targetId: voucherId,
      details: `${active ? "Activated" : "Deactivated"} the voucher.`,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/vouchers/:voucherId/delete", { preHandler: csrfProtect }, async (req, reply) => {
    const voucherId = parsePositiveId((req.params as { voucherId: string }).voucherId);
    if (voucherId === null) return reply.code(400).send({ error: "Invalid voucher id." });
    const existing = await getVoucher(prisma, voucherId);
    if (existing === null) {
      return reply.code(404).send({ error: "Voucher not found." });
    }
    try {
      await deleteVoucher(prisma, voucherId);
    } catch (err) {
      if (err instanceof Error && err.message === "cannot delete a voucher that has been used") {
        return reply.code(409).send({ error: "Cannot delete: this code has already been used." });
      }
      throw err;
    }
    // deleteVoucher throws above for a used voucher, so reaching here means
    // usedCount was 0 — "(never used)" is always accurate at this point.
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "voucher_delete",
      targetType: "voucher",
      targetId: voucherId,
      details: `Deleted voucher "${existing.code}" (never used).`,
    });
    return reply.send({ ok: true });
  });

  // Bulk row-selection actions from the Vouchers page toolbar. One endpoint
  // with an action discriminator (mirrors POST /api/orders/bulk-action,
  // apps/web-admin/src/routes/api/orders.ts:455-465) — same 50-id cap and
  // ids-validation shape. activate/deactivate can't fail per-id (a plain
  // updateMany), so every id is reported succeeded; delete can fail per-id
  // (a used voucher can't be deleted), so it returns bulkDeleteVouchers's
  // succeeded/failed shape directly.
  app.post("/api/vouchers/bulk-action", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown; action?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    if (ids.length === 0) {
      return reply.code(400).send({ error: "Select at least one voucher." });
    }
    if (ids.length > 50) {
      return reply.code(400).send({ error: "Select 50 vouchers or fewer per bulk action." });
    }
    const action = body.action;
    if (action !== "activate" && action !== "deactivate" && action !== "delete") {
      return reply.code(400).send({ error: "Unknown bulk action." });
    }

    if (action === "delete") {
      const result = await bulkDeleteVouchers(prisma, ids);
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "voucher_bulk_delete",
        targetType: "voucher",
        details:
          result.failed.length > 0
            ? `Deleted ${result.succeeded.length} vouchers; skipped ${result.failed.length} already-used.`
            : `Deleted ${result.succeeded.length} vouchers.`,
      });
      return reply.send(result);
    }

    const isActive = action === "activate";
    const count = await bulkSetVouchersActive(prisma, ids, isActive);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: isActive ? "voucher_bulk_activate" : "voucher_bulk_deactivate",
      targetType: "voucher",
      details: `${isActive ? "Activated" : "Deactivated"} ${count} vouchers.`,
    });
    return reply.send({ succeeded: ids, failed: [] });
  });
}
