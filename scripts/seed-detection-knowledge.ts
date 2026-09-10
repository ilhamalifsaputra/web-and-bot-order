/**
 * Idempotent first-run seed for the Detection Engine's Knowledge Base:
 * copies every `DEFAULT_KNOWLEDGE_BASE.tokens`/`.aliases` entry
 * (packages/core/src/detection/knowledge/defaultVocabulary.ts) into the
 * `detection_tokens`/`detection_aliases` tables via the same
 * `upsertDetectionToken`/`upsertDetectionAlias` crud helpers the admin UI
 * will eventually use — so re-running this script is always a safe no-op
 * (the upsert's unique-constraint keys, `[category, token]` and `alias`,
 * make a second run update the same rows in place rather than duplicate
 * them). `DEFAULT_KNOWLEDGE_BASE` has no `overrides`, so there is nothing to
 * seed there.
 *
 * `adminId: null` marks every row as a CLI/system write, same convention as
 * scripts/reset-admin-password.ts's break-glass audit entries.
 *
 *   pnpm seed-detection-knowledge
 */
import { prisma, initDb, upsertDetectionToken, upsertDetectionAlias } from "@app/db";
import { DEFAULT_KNOWLEDGE_BASE } from "@app/core/detection/knowledge";

async function main(): Promise<void> {
  await initDb(); // no-op on Postgres; kept for boot-sequencing parity with the app

  let tokenCount = 0;
  for (const token of DEFAULT_KNOWLEDGE_BASE.tokens) {
    await upsertDetectionToken(
      prisma,
      {
        category: token.category,
        token: token.token,
        canonical: token.canonical,
        isProductDefining: token.isProductDefining,
        enabled: token.enabled,
      },
      null,
    );
    tokenCount += 1;
  }

  let aliasCount = 0;
  for (const alias of DEFAULT_KNOWLEDGE_BASE.aliases) {
    await upsertDetectionAlias(
      prisma,
      { alias: alias.alias, expandsTo: alias.expandsTo, reason: alias.reason },
      null,
    );
    aliasCount += 1;
  }

  console.log(
    `[seed-detection-knowledge] seeded ${tokenCount} token(s) and ${aliasCount} alias(es) from DEFAULT_KNOWLEDGE_BASE.`,
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[seed-detection-knowledge] failed:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
