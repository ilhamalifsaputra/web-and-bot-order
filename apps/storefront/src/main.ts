/**
 * Standalone dev entry point for the storefront (production runs through the
 * apps/server composition root instead — single process, single PrismaClient).
 */
import { logger } from "@app/core/logger";
import { start } from "./server";

start().catch((e) => {
  logger.error({ err: e }, "Storefront failed to start — exiting the process");
  process.exit(1);
});
