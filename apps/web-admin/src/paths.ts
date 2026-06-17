/**
 * Filesystem paths shared by the web-admin app.
 *
 * UPLOADS_DIR is the ONE place uploaded files live. It is module-relative (not
 * `process.cwd()`-relative) on purpose: pnpm runs each app's `start` script with
 * cwd = the package dir, so a cwd-based path in the upload writers (catalog /
 * branding) resolves somewhere different from where the static server reads —
 * the file is written, but never served and lost on redeploy. Anchoring to this
 * module keeps writers and the reader in agreement in dev AND in Docker. Override
 * with the UPLOADS_DIR env when the data volume is mounted elsewhere.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const UPLOADS_DIR =
  process.env.UPLOADS_DIR ?? join(HERE, "..", "..", "..", "data", "uploads");
