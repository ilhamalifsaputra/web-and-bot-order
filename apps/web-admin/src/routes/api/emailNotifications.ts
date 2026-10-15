import type { FastifyInstance } from "fastify";
import { EMAIL_EVENT_REGISTRY, renderEmailEventPreview, type EmailEventKey } from "@app/core/email";
import { prisma, getSmtpCreds, isEmailEventEnabled, setEmailEventEnabled, logAdminAction,
  emailInventoryThresholds, isFiniteEmailInventorySku, getEmailReportSchedule, validateEmailSchedule, setSetting } from "@app/db";
import { currentAdmin, csrfProtect, blockReadonlyReads } from "../../plugins/auth";
import { parsePositiveId } from "../../lib/params";

export async function emailNotificationsApi(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { key: string } }>("/api/settings/email-notifications/:key/preview", { preHandler: blockReadonlyReads }, async (req, reply) => {
    const event = EMAIL_EVENT_REGISTRY.find((row) => row.key === req.params.key);
    if (!event) return reply.code(404).send({ error: "Unknown email event." });
    const rendered = renderEmailEventPreview(event.key, { shopName: "Example shop", logoUrl: null, accentColor: "#4F46E5", supportEmail: null, storeUrl: null });
    return reply.header("Cache-Control", "no-store").send({ preview: true, subject: rendered.subject, text: rendered.text });
  });
  app.get("/api/settings/email-notifications", { preHandler: blockReadonlyReads }, async () => ({
    events: await Promise.all(EMAIL_EVENT_REGISTRY.map(async (row) => ({ ...row, enabled: await isEmailEventEnabled(prisma, row.key) }))),
    configured: !!(await getSmtpCreds(prisma)),
    policy: "Optional events follow their switches. Password recovery is always enabled. Sent means mail server accepted, not inbox delivery.",
    schedule: await getEmailReportSchedule(prisma),
  }));
  app.post<{ Body: { key?: unknown; enabled?: unknown } }>("/api/settings/email-notifications", { preHandler: csrfProtect }, async (req, reply) => {
    const { key, enabled } = req.body ?? {};
    const row = EMAIL_EVENT_REGISTRY.find((event) => event.key === key);
    if (!row || typeof enabled !== "boolean" || row.mandatory && !enabled) return reply.code(400).send({ error: "Choose a known event and a boolean enabled value; password recovery cannot be disabled." });
    await prisma.$transaction(async (tx) => {
      await setEmailEventEnabled(tx, key as EmailEventKey, enabled);
      await logAdminAction(tx, { adminId: req.admin!.userId, action: "email_event_policy", targetType: "setting", details: `${enabled ? "Enabled" : "Disabled"} the ${row.label} email notification.` });
    });
    return { key, enabled };
  });
  app.post<{ Body: unknown }>("/api/settings/email-notifications/schedule", { preHandler: csrfProtect }, async (req, reply) => {
    if (!validateEmailSchedule(req.body)) return reply.code(400).send({ error: "Use a valid timezone, HH:mm times, and weekday 0 (Sunday) through 6 (Saturday)." });
    await prisma.$transaction(async (tx) => {
      await setSetting(tx, "email_report_schedule", JSON.stringify(req.body));
      await logAdminAction(tx, { adminId: req.admin!.userId, action: "email_report_schedule", targetType: "setting", details: "Updated the email report delivery schedule and timezone." });
    });
    return { schedule: req.body };
  });
  app.get<{ Params: { id: string } }>("/api/settings/email-notifications/inventory/:id", { preHandler: currentAdmin }, async (req, reply) => {
    const id = parsePositiveId(req.params.id);
    if (id === null || !(await isFiniteEmailInventorySku(prisma, id))) return reply.code(404).send({ error: "This SKU does not use finite local stock." });
    return emailInventoryThresholds(prisma, id);
  });
  app.post<{ Params: { id: string }; Body: { critical?: unknown; recovery?: unknown } }>("/api/settings/email-notifications/inventory/:id", { preHandler: csrfProtect }, async (req, reply) => {
    const id = parsePositiveId(req.params.id);
    const { critical, recovery } = req.body ?? {};
    if (id === null || !(await isFiniteEmailInventorySku(prisma, id))) return reply.code(404).send({ error: "This SKU does not use finite local stock." });
    if (typeof critical !== "number" || typeof recovery !== "number" || !Number.isSafeInteger(critical) || !Number.isSafeInteger(recovery) || critical < 0 || recovery <= critical || recovery > 1_000_000) return reply.code(400).send({ error: "Critical must be a nonnegative integer, and recovery must be greater than critical (maximum 1000000)." });
    await prisma.$transaction(async (tx) => {
      await setSetting(tx, `email_inventory_critical_threshold:${id}`, String(critical));
      await setSetting(tx, `email_inventory_recovery_threshold:${id}`, String(recovery));
      await logAdminAction(tx, { adminId: req.admin!.userId, action: "email_stock_thresholds", targetType: "denomination", targetId: id, details: `Updated stock email thresholds to critical ${critical} and recovery ${recovery}.` });
    });
    return { critical, recovery };
  });
}
