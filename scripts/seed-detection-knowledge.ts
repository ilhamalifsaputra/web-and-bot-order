/**
 * Idempotent first-run seed for the Detection Engine's Knowledge Base:
 * copies every `DEFAULT_KNOWLEDGE_BASE.tokens`/`.aliases` entry
 * (packages/core/src/detection/knowledge/defaultVocabulary.ts) into the
 * `detection_tokens`/`detection_aliases` tables via the `seedDetectionKnowledge`
 * crud helper. That helper upserts each row on its unique-constraint key
 * (`[category, token]`, `alias`), so re-running this script is always a safe
 * no-op at the row level. `DEFAULT_KNOWLEDGE_BASE` has no `overrides`, so
 * there is nothing to seed there.
 *
 * Unlike the per-row `upsertDetection*` helpers, `seedDetectionKnowledge`
 * writes exactly ONE summary audit-log entry and bumps the knowledge
 * revision counter exactly ONCE for the whole batch — re-running the seed
 * would otherwise add one audit row (which shop admins read) and advance the
 * revision once per token/alias every single run.
 *
 * `adminId: null` marks the seed as a CLI/system write, same convention as
 * scripts/reset-admin-password.ts's break-glass audit entries.
 *
 *   pnpm seed-detection-knowledge
 */
import { prisma, initDb, seedDetectionKnowledge } from "@app/db";
import { DEFAULT_KNOWLEDGE_BASE } from "@app/core/detection/knowledge";

async function main(): Promise<void> {
  await initDb(); // no-op on Postgres; kept for boot-sequencing parity with the app

  const { tokenCount, aliasCount } = await seedDetectionKnowledge(
    prisma,
    { tokens: DEFAULT_KNOWLEDGE_BASE.tokens, aliases: DEFAULT_KNOWLEDGE_BASE.aliases },
    null,
  );

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
