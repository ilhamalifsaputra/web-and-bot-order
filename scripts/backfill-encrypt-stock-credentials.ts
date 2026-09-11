/**
 * One-time offline backfill: encrypt any `StockItem.credentials` rows still
 * stored as plaintext, from before AES-256-GCM encryption at rest shipped
 * (Task 2, Trustance Master Architecture Phase 1). Idempotent — a row that
 * already holds a valid encrypted envelope is left untouched, so it's safe
 * to run more than once (e.g. re-run after a partial run was interrupted).
 * Mirrors this repo's existing one-time-backfill precedent
 * (scripts/backfill-catalog-slugs.ts): same "idempotent, safe to re-run,
 * reports a per-run count" shape.
 *
 * Run it on the box that holds the SQLite DB, with `CREDENTIAL_ENCRYPTION_KEY`
 * set in the environment (same value the app will use), ideally with the
 * app stopped or at least no concurrent stock bulk-add in flight:
 *
 *   pnpm backfill-encrypt-stock-credentials
 *
 * This does NOT touch prisma/schema.prisma or run `db push` — the column
 * stays a plain TEXT `credentials` column; only its stored string content
 * changes shape (plaintext -> JSON envelope), the same JSON-in-string
 * convention already used by NotificationOutbox.payloadJson.
 *
 * NEVER logs a credential value, plaintext or encrypted — only counts.
 */
import { prisma, initDb } from "@app/db";
import { encryptCredentials, isEncryptedCredentialEnvelope } from "@app/core/credentialCrypto";

async function main(): Promise<void> {
  await initDb();

  const rows = await prisma.stockItem.findMany({ select: { id: true, credentials: true } });
  let encrypted = 0;
  let alreadyEncrypted = 0;

  for (const row of rows) {
    if (isEncryptedCredentialEnvelope(row.credentials)) {
      alreadyEncrypted++;
      continue;
    }
    await prisma.stockItem.update({
      where: { id: row.id },
      data: { credentials: encryptCredentials(row.credentials) },
    });
    encrypted++;
  }

  console.log(
    `[backfill-encrypt-stock-credentials] ${rows.length} row(s) scanned: ` +
      `${encrypted} encrypted, ${alreadyEncrypted} already encrypted (skipped).`,
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[backfill-encrypt-stock-credentials] failed:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
