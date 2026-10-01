/**
 * Storage-efficiency admin page — read-only disk/DB size summary, plus a
 * manual trigger for the same cleanup the order-bot's daily
 * `storageCleanupJob` cron runs (see @app/db's `runStorageCleanup`), so an
 * admin isn't stuck waiting for 03:15 if disk fills up unexpectedly.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { logger } from "@app/core/logger";
import { prisma, runStorageCleanup, getDatabaseSizeBytes, logAdminAction } from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { UPLOADS_DIR } from "../../paths";

const UPLOAD_SUBFOLDERS = ["branding", "products", "broadcasts", "tickets"] as const;

async function folderStats(dir: string): Promise<{ fileCount: number; totalBytes: number }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { fileCount: 0, totalBytes: 0 }; // folder doesn't exist yet — nothing uploaded there
  }
  let fileCount = 0;
  let totalBytes = 0;
  for (const name of entries) {
    const s = await stat(join(dir, name));
    if (!s.isFile()) continue;
    fileCount += 1;
    totalBytes += s.size;
  }
  return { fileCount, totalBytes };
}

export default async function storageApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/storage/summary", { preHandler: currentAdmin }, async (_req, reply) => {
    const folders = await Promise.all(
      UPLOAD_SUBFOLDERS.map(async (name) => ({ name, ...(await folderStats(join(UPLOADS_DIR, name))) })),
    );
    let dbBytes = 0;
    try {
      dbBytes = await getDatabaseSizeBytes(prisma);
    } catch (err) {
      // Don't fail the whole page over the size card — the upload folders are still useful to show.
      logger.warn(
        { err },
        "Could not read the database size for the admin Storage page, so it will show 0 bytes for the database; check that the database user is allowed to call pg_database_size().",
      );
    }
    return reply.send({ folders, dbBytes });
  });

  app.post("/api/storage/cleanup", { preHandler: csrfProtect }, async (req, reply) => {
    const summary = await runStorageCleanup(prisma, UPLOADS_DIR);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "storage_cleanup",
      targetType: "system",
      targetId: null,
      details:
        `Ran a manual storage cleanup: removed ${summary.broadcastFilesDeleted} broadcast image(s) and ` +
        `${summary.ticketFilesDeleted} ticket attachment(s); pruned ${summary.outboxRowsDeleted} outbox row(s), ` +
        `${summary.resetTokensDeleted} expired reset token(s), and ${summary.cartsDeleted} abandoned cart line(s).`,
    });
    return reply.send({ summary });
  });
}
