/** Transitional text-only multipart readers. All active clients use V2's
 * direct-to-R2 upload intents. Historical disk attachments remain readable;
 * new file parts receive an explicit migration error and never touch disk. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyRequest } from "fastify";
import { ValidationError } from "@app/core/errors";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TICKET_DIR = join(process.env.UPLOADS_DIR ?? join(HERE, "..", "..", "..", "..", "data", "uploads"), "tickets");
export const MAX_TICKET_ATTACHMENTS = 3;
export type ParsedAttachment = never;
async function textFields(req: FastifyRequest) {
  const fields: Record<string, string> = {};
  for await (const part of req.parts({ limits: { fileSize: 20 * 1024 * 1024, files: 3, fields: 8, parts: 11, fieldSize: 8192 } })) {
    if (part.type === "field") { fields[part.fieldname] = String(part.value ?? ""); continue; }
    part.file.resume();
    if (part.filename) throw new ValidationError("helpdesk.use_direct_upload");
  }
  return fields;
}
export async function parseTicketMultipart(req: FastifyRequest) {
  const fields = await textFields(req);
  return { message: (fields.message ?? "").trim().slice(0, 2000), orderCode: fields.order_code?.trim() || null, attachments: [] as ParsedAttachment[] };
}
export async function parseNewTicketMultipart(req: FastifyRequest) {
  const fields = await textFields(req);
  return { subject: (fields.subject ?? "").trim(), category: (fields.category ?? "").trim(), productId: (fields.product_id ?? "").trim(), description: (fields.description ?? "").trim().slice(0, 2000), orderCode: fields.order_code?.trim() || null, attachments: [] as ParsedAttachment[] };
}
