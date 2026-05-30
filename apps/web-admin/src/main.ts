/**
 * Entry point for the web admin. Port of `uvicorn app.main:app`.
 */
import { logger } from "@app/core/logger";
import { start } from "./server";

start().catch((e) => {
  logger.error({ err: e }, "Web admin crashed");
  process.exit(1);
});
