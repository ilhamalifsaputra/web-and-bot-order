/**
 * Broadcast image upload — stateless: the compose form has no broadcast row
 * yet, so this just writes the file and hands back its URL; the URL rides
 * along in the POST /api/broadcast payload that actually creates the row.
 * Mirrors catalogPhoto.ts's shape/limits.
 */
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { UPLOADS_DIR } from "../paths";
import { handleUpload } from "../lib/upload";
import { currentAdmin } from "../plugins/auth";

const BROADCAST_PHOTO_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const BROADCASTS_DIR = join(UPLOADS_DIR, "broadcasts");
const BROADCASTS_URL_PREFIX = "/uploads/broadcasts";

export default async function broadcastPhotoRoutes(app: FastifyInstance): Promise<void> {
  app.post("/broadcast/photo", { preHandler: currentAdmin }, async (req, reply) => {
    return handleUpload(req, reply, {
      kind: "broadcast",
      field: "photo",
      allowed: BROADCAST_PHOTO_MIME,
      maxBytes: 5 * 1024 * 1024,
      destDir: BROADCASTS_DIR,
      urlPrefix: BROADCASTS_URL_PREFIX,
      auditAction: "broadcast_photo_upload",
      auditTarget: { type: "broadcast" },
      details: (filename) => `Uploaded a broadcast image (${filename}).`,
    });
  });
}
