import { prisma, queueEmailReports } from "@app/db";
import { logger } from "@app/core/logger";

export async function runEmailMaintenance(signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    try { await queueEmailReports(prisma); }
    catch (err) { logger.error({ err }, "Email report scheduling failed; the next scheduled tick will retry."); }
    if (signal?.aborted) break;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, 60_000);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
  }
}
