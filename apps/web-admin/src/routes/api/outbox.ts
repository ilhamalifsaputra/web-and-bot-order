import type { FastifyInstance } from "fastify";
import { parsePositiveId, parsePageParam } from "../../lib/params";
import { EMAIL_RECIPIENT_RE } from "@app/core/mailer";
import { NotificationStatus } from "@app/core/enums";
import { prisma, listNotifications, countNotifications, outboxStatusCounts, retryNotification, getNotification, logAdminAction } from "@app/db";
import { logger } from "@app/core/logger";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { displayDateTime } from "../../dateDisplay";

const PAGE_SIZE = 50;
const STATUS_VALUES = Object.values(NotificationStatus) as string[];

const SAFE_EMAIL_ERRORS = new Set([
  "NO_RECIPIENT", "SKIPPED_NO_RECIPIENT", "INVALID_PAYLOAD", "SKIPPED_DISABLED", "EMAIL_POLICY_UNAVAILABLE", "EMAIL_RENDER_FAILED", "SMTP_SETTINGS_UNAVAILABLE",
  "SMTP_UNAVAILABLE", "SMTP_NOT_CONFIGURED", "SMTP_AUTH", "SMTP_RECIPIENT", "SMTP_TLS",
  "SMTP_REJECTED", "SMTP_TEMPORARY", "SMTP_CONNECTION", "SMTP_ACCEPTANCE_UNCONFIRMED", "UNSUPPORTED_EVENT", "UNKNOWN_EMAIL_EVENT",
]);

/** Only operational evidence is returned: reset payloads and dedupe keys are private. */
function emailDiagnostics(row: { channel: string; event: string; status: string; payloadJson: string; lastError: string | null }) {
  if (row.channel !== "EMAIL") {
    return row.event === "ADMIN_PW_RESET" ? { payloadJson: "{}", dedupeKey: null } : {};
  }
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payloadJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* Malformed payloads are never echoed to the client. */ }
  const address = typeof payload.to === "string" && EMAIL_RECIPIENT_RE.test(payload.to) ? payload.to : null;
  const emailRecipientMasked = address ? `${address[0]}***@${address.split("@")[1]}` : null;
  const evidence = payload.delivery as { acceptedAt?: unknown } | undefined;
  const emailAcceptedAt = row.status === "SENT" && typeof evidence?.acceptedAt === "string" && Number.isFinite(Date.parse(evidence.acceptedAt))
    ? new Date(evidence.acceptedAt).toISOString() : null;
  const emailErrorCode = row.lastError ? SAFE_EMAIL_ERRORS.has(row.lastError) ? row.lastError : "LEGACY_ERROR_REDACTED" : null;
  const deliveryOutcome = row.status === "SENT" ? emailAcceptedAt ? "transport_accepted" : "sent_without_evidence"
    : emailErrorCode?.startsWith("SKIPPED_") ? "skipped" : emailErrorCode === "NO_RECIPIENT" ? "no_recipient"
    : row.status === "PENDING" ? "queued" : row.status === "SENDING" ? "attempting" : "failed";
  return {
    payloadJson: JSON.stringify({ recipient: emailRecipientMasked, accepted_at: emailAcceptedAt }),
    dedupeKey: null,
    lastError: emailErrorCode,
    emailRecipientMasked,
    emailAcceptedAt,
    emailErrorCode,
    deliveryOutcome,
  };
}

export default async function outboxApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/outbox", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const status = q.status && STATUS_VALUES.includes(q.status) ? q.status : null;
    const page = parsePageParam(q.page);
    const offset = (page - 1) * PAGE_SIZE;

    const [rows, total, counts] = await Promise.all([
      listNotifications(prisma, { status, limit: PAGE_SIZE, offset }),
      countNotifications(prisma, { status }),
      outboxStatusCounts(prisma),
    ]);

    const rowsWithDisplay = rows.map((r) => ({
      ...r,
      ...emailDiagnostics(r),
      createdAtDisplay: displayDateTime(r.createdAt),
      sentAtDisplay: displayDateTime(r.sentAt),
    }));
    return reply.send({ rows: rowsWithDisplay, total, page, hasNext: offset + rows.length < total, counts });
  });

  // JSON counterpart of the legacy POST /outbox/:id/retry (routes/outbox.ts),
  // which 303-redirects to a retired GET /outbox and breaks fetch()'s
  // res.json() once the SPA catch-all serves HTML there instead. The web
  // panel's React page calls this one; the legacy route is left in place
  // (still covered by test/web.test.ts) since nothing requires removing it.
  app.post("/api/outbox/:id/retry", { preHandler: csrfProtect }, async (req, reply) => {
    const id = parsePositiveId((req.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: "Invalid notification id." });
    const existing = await getNotification(prisma, id);
    if (existing?.channel === "EMAIL" && !["FAILED","DEAD_LETTER"].includes(existing.status)) return reply.code(409).send({error:"Only failed email notifications may be retried."});
    const ok = await retryNotification(prisma, id);
    if (!ok) return reply.code(404).send({ error: "That notification no longer exists." });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "outbox_retry",
      targetType: "notification",
      targetId: id,
      details: `Requeued a ${existing?.event ?? "notification"} notification for delivery.`,
    });
    logger.info(`Admin ${req.admin!.userId} requeued outbox notification ${id} for delivery via the web panel`);
    return reply.send({ ok: true });
  });
}
