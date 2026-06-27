import type { FastifyInstance } from "fastify";
import { VoucherType } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import {
  prisma,
  listVouchers,
  getVoucherByCode,
  getVoucher,
  createVoucher,
  setVoucherActive,
  deleteVoucher,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

const VOUCHER_TYPES = Object.values(VoucherType) as string[];

export default async function vouchersApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/vouchers", { preHandler: currentAdmin }, async (req, reply) => {
    const vouchers = await listVouchers(prisma);
    return reply.send({ vouchers, types: VOUCHER_TYPES });
  });

  app.post("/api/vouchers", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const code = (body.code ?? "").trim().toUpperCase();
    if (!code) return reply.code(400).send({ error: "Code is required." });

    const typeUpper = (body.type ?? "").toUpperCase();
    if (!VOUCHER_TYPES.includes(typeUpper)) {
      return reply.code(400).send({ error: "Invalid voucher type." });
    }

    let valueDec: Decimal;
    let minDec: Decimal;
    try {
      valueDec = new Decimal((body.value ?? "").trim());
      minDec = new Decimal((body.min_purchase ?? "").trim() || "0");
    } catch {
      return reply.code(400).send({ error: "Value and min purchase must be numbers." });
    }

    let limit: number | null = null;
    if ((body.usage_limit ?? "").trim()) {
      const n = Number(body.usage_limit);
      if (!Number.isInteger(n)) return reply.code(400).send({ error: "Usage limit must be a number." });
      limit = n;
    }

    let expiry: Date | null = null;
    const expiresRaw = (body.expires_at ?? "").trim();
    if (expiresRaw) {
      const d = new Date(`${expiresRaw}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) return reply.code(400).send({ error: "Expiry must be YYYY-MM-DD." });
      expiry = d;
    }

    if ((await getVoucherByCode(prisma, code)) !== null) {
      return reply.code(409).send({ error: `Voucher '${code}' already exists.` });
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
    return reply.code(201).send({ voucher: v });
  });

  app.post("/api/vouchers/:voucherId/toggle", { preHandler: csrfProtect }, async (req, reply) => {
    const voucherId = Number((req.params as { voucherId: string }).voucherId);
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
    const voucherId = Number((req.params as { voucherId: string }).voucherId);
    if ((await getVoucher(prisma, voucherId)) === null) {
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
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "voucher_delete",
      targetType: "voucher",
      targetId: voucherId,
    });
    return reply.send({ ok: true });
  });
}
