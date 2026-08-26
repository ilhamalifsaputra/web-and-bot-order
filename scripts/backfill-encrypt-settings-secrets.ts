/**
 * One-time offline backfill: encrypt any `Setting` rows in
 * `ENCRYPTED_SETTING_KEYS` still stored as plaintext, from before AES-256-GCM
 * encryption at rest landed for these keys (Task 13). Idempotent — a row that
 * already holds a valid encrypted envelope is left untouched, so it's safe to
 * run more than once (e.g. re-run after a partial run was interrupted).
 * Mirrors scripts/backfill-encrypt-stock-credentials.ts (same "idempotent,
 * safe to re-run, reports a per-run count" shape) — that script covers
 * `StockItem.credentials`, this one covers the equivalent `Setting` rows
 * (provider API keys/secrets; bot_token/notif_bot_token are out of scope,
 * see packages/db/src/crud/settings.ts's ENCRYPTED_SETTING_KEYS doc-comment).
 *
 * Run it on the box that holds the SQLite DB, with `CREDENTIAL_ENCRYPTION_KEY`
 * set in the environment (same value the app will use), ideally with the app
 * stopped or at least no concurrent settings edit in flight:
 *
 *   pnpm backfill-encrypt-settings-secrets
 *
 * This does NOT touch prisma/schema.prisma or run `db push` — the column
 * stays a plain TEXT `value` column; only its stored string content changes
 * shape (plaintext -> JSON envelope), the same JSON-in-string convention
 * already used by NotificationOutbox.payloadJson and StockItem.credentials.
 *
 * NEVER logs a credential value, plaintext or encrypted — only counts.
 */
import { prisma, initDb, ENCRYPTED_SETTING_KEYS } from "@app/db";
import { encryptCredentials, isEncryptedCredentialEnvelope } from "@app/core/credentialCrypto";

async function main(): Promise<void> {
  await initDb();
  const rows = await prisma.setting.findMany({ where: { key: { in: [...ENCRYPTED_SETTING_KEYS] } } });
  let encrypted = 0, alreadyEncrypted = 0, skippedEmpty = 0;
  for (const row of rows) {
    if (!row.value) { skippedEmpty++; continue; }
    if (isEncryptedCredentialEnvelope(row.value)) { alreadyEncrypted++; continue; }
    await prisma.setting.update({ where: { key: row.key }, data: { value: encryptCredentials(row.value) } });
    encrypted++;
  }
  console.log(`[backfill-encrypt-settings-secrets] ${rows.length} row(s) scanned: ${encrypted} encrypted, ${alreadyEncrypted} already encrypted, ${skippedEmpty} empty (skipped).`);
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error("[backfill-encrypt-settings-secrets] failed:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
