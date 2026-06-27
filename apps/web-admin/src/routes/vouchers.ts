/**
 * Vouchers — list, create (percent/fixed), toggle active. Port of
 * routers/vouchers.py.
 */
import type { FastifyInstance } from "fastify";
import { VoucherType } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import {
  prisma,
  getVoucherByCode,
  getVoucher,
  createVoucher,
  setVoucherActive,
  deleteVoucher,
  logAdminAction,
} from "@app/db";
import { csrfProtect } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

const truthy = (v: string | undefined) => ["1", "true", "on", "yes"].includes((v ?? "").toLowerCase());
const VOUCHER_TYPES = Object.values(VoucherType) as string[];

export default async function vouchersRoutes(app: FastifyInstance): Promise<void> {
  // GET /vouchers retired — now served by React SPA via GET /api/vouchers.

  app.post("/vouchers", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const code = (body.code ?? "").trim().toUpperCase();
    if (!code) return redirectWithFlash(reply, "/vouchers", "Code is required.", "error");

    const typeUpper = (body.type ?? "").toUpperCase();
    if (!VOUCHER_TYPES.includes(typeUpper)) {
      return redirectWithFlash(reply, "/vouchers", "Invalid voucher type.", "error");
    }

    let valueDec: Decimal;
    let minDec: Decimal;
    try {
      valueDec = new Decimal((body.value ?? "").trim());
      minDec = new Decimal((body.min_purchase ?? "").trim() || "0");
    } catch {
      return redirectWithFlash(reply, "/vouchers", "Value and min purchase must be numbers.", "error");
    }

    let limit: number | null = null;
    if ((body.usage_limit ?? "").trim()) {
      const n = Number(body.usage_limit);
      if (!Number.isInteger(n)) {
        return redirectWithFlash(reply, "/vouchers", "Usage limit must be a number.", "error");
      }
      limit = n;
    }

    let expiry: Date | null = null;
    const expiresRaw = (body.expires_at ?? "").trim();
    if (expiresRaw) {
      const d = new Date(`${expiresRaw}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) {
        return redirectWithFlash(reply, "/vouchers", "Expiry must be YYYY-MM-DD.", "error");
      }
      expiry = d;
    }

    if ((await getVoucherByCode(prisma, code)) !== null) {
      return redirectWithFlash(reply, "/vouchers", `Voucher '${code}' already exists.`, "error");
    }
    const v = await createVoucher(prisma, {
      code,
      type: typeUpper as VoucherType,
      value: valueDec,
      usageLimit: limit,
      minPurchase: minDec,
      expiresAt: expiry,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "voucher_create",
      targetType: "voucher",
      targetId: v.id,
      details: `Created voucher "${code}" (${typeUpper}, value ${valueDec.toString()}, limit ${limit}).`,
    });
    return redirectWithFlash(reply, "/vouchers", `Voucher '${code}' created.`, "success");
  });

  app.post("/vouchers/:voucherId/toggle", { preHandler: csrfProtect }, async (req, reply) => {
    const voucherId = Number((req.params as { voucherId: string }).voucherId);
    const active = truthy((req.body as Record<string, string>).is_active);
    if ((await getVoucher(prisma, voucherId)) === null) {
      return redirectWithFlash(reply, "/vouchers", "Voucher not found.", "error");
    }
    await setVoucherActive(prisma, voucherId, active);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "voucher_toggle",
      targetType: "voucher",
      targetId: voucherId,
      details: `${active ? "Activated" : "Deactivated"} the voucher.`,
    });
    return redirectWithFlash(reply, "/vouchers", "Voucher updated.", "success");
  });

  app.post("/vouchers/:voucherId/delete", { preHandler: csrfProtect }, async (req, reply) => {
    const voucherId = Number((req.params as { voucherId: string }).voucherId);
    if ((await getVoucher(prisma, voucherId)) === null) {
      return redirectWithFlash(reply, "/vouchers", "Voucher not found.", "error");
    }
    try {
      await deleteVoucher(prisma, voucherId);
    } catch (err) {
      // Only the crud's specific "has been used" guard gets the friendly
      // flash — exact message match, not substring (mirrors the catalog
      // delete routes' rationale for the same discrimination).
      if (err instanceof Error && err.message === "cannot delete a voucher that has been used") {
        return redirectWithFlash(reply, "/vouchers", "Cannot delete: this code has already been used.", "error");
      }
      throw err;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "voucher_delete",
      targetType: "voucher",
      targetId: voucherId,
    });
    return redirectWithFlash(reply, "/vouchers", "Discount code deleted.", "success");
  });
}
