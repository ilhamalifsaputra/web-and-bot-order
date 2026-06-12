/**
 * Bundle the combined server (apps/server/src/index.ts) + every `@app/*` package
 * into a single `dist/server.cjs` for Hostinger Node.js App Manager (Passenger),
 * which installs with npm (no pnpm workspaces) and runs plain `node`.
 * See DEPLOY-HOSTINGER.md §2 #3.
 *
 * What stays EXTERNAL (loaded from node_modules at runtime, not inlined):
 *  - @prisma/client + the generated `.prisma/client` — ships a native query
 *    engine binary; must be regenerated on the server (`prisma generate`).
 *  - pino / pino-roll / thread-stream — resolve worker-thread transport files
 *    by path; bundling breaks that resolution.
 *  - nunjucks — loads templates from disk via dynamic requires.
 * Everything else (grammy, fastify, zod, decimal.js, luxon, croner, dotenv,
 * bcryptjs, and all `@app/*` source) is inlined.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

async function main(): Promise<void> {
  await build({
    entryPoints: [join(ROOT, "apps/server/src/index.ts")],
    outfile: join(ROOT, "dist/server.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    // Keep these resolved from node_modules on the server (see header).
    external: [
      "@prisma/client",
      ".prisma/client",
      "pino",
      "pino-roll",
      "thread-stream",
      "nunjucks",
    ],
    // CJS output has no real `import.meta.url`; point it at the bundle file so
    // the few modules that read it (config env-walk, the order-bot entry guard)
    // keep working. The entry guard ALSO checks APP_BUNDLED below, so the
    // bundled order-bot never self-starts — only apps/server drives boot.
    banner: {
      js: "const __import_meta_url = require('url').pathToFileURL(__filename).href;",
    },
    define: {
      "import.meta.url": "__import_meta_url",
      "process.env.APP_BUNDLED": '"1"',
    },
    logLevel: "info",
  });

  // eslint-disable-next-line no-console
  console.log("✓ Bundled apps/server -> dist/server.cjs");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
