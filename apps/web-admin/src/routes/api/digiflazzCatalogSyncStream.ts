import type { FastifyPluginAsync } from "fastify";
import { prisma, getDigiflazzSyncStatus, type DigiflazzSyncStatus } from "@app/db";
import { onDigiflazzCatalogSyncChanged } from "@app/core/realtime/digiflazzEvents";
import { streamSse } from "@app/core/realtime/sseRoute";
import { requireSseAdmin } from "../../plugins/sseAuth";

/** Realtime stream of the hourly Digiflazz catalog-sync outcome — pushes a
 * fresh snapshot whenever a re-sync finishes (success, aborted, or error).
 * Open to every authenticated admin, same access level as every other
 * `/api/dashboard/*` route (see dashboard.ts, all guarded by plain
 * `currentAdmin` with no readonly restriction). */
const digiflazzCatalogSyncStreamRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/dashboard/digiflazz-sync/stream", async (req, reply) => {
    const admin = await requireSseAdmin(req, reply);
    if (!admin) return;

    const readStatus = () => getDigiflazzSyncStatus(prisma);

    await streamSse<DigiflazzSyncStatus | null>(reply, req, {
      initial: readStatus,
      poll: readStatus,
      subscribe: onDigiflazzCatalogSyncChanged,
      changed: (prev, next) => JSON.stringify(prev) !== JSON.stringify(next),
    });
  });
};

export default digiflazzCatalogSyncStreamRoutes;
