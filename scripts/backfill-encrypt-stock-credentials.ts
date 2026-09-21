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
 * Run it against the production Postgres database, with `DATABASE_URL_PRISMA`
 * and `CREDENTIAL_ENCRYPTION_KEY` set in the environment (same values the app
 * uses), ideally with the app stopped or at least no concurrent stock bulk-add
 * in flight:
 *
 *   pnpm backfill-encrypt-stock-credentials
 *
 * Every row it rewrites also gets a REENCRYPTED stock event (actor SYSTEM),
 * written in the same transaction as the rewrite, so a row's ledger shows when
 * its credential stopped being stored in plaintext. Rows already encrypted get
 * no event — nothing happened to them.
 *
 * This does NOT touch prisma/schema.prisma or run `db push` — the column
 * stays a plain TEXT `credentials` column; only its stored string content
 * changes shape (plaintext -> JSON envelope), the same JSON-in-string
 * convention already used by NotificationOutbox.payloadJson.
 *
 * NEVER logs a credential value, plaintext or encrypted — only counts.
 */
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { prisma, initDb, recordStockEvent } from "@app/db";
import { StockActorType, StockEventType } from "@app/core/enums";
import { encryptCredentials, isEncryptedCredentialEnvelope } from "@app/core/credentialCrypto";

export interface BackfillEncryptReport {
  scanned: number;
  encrypted: number;
  alreadyEncrypted: number;
}

export async function backfillEncryptStockCredentials(db: PrismaClient): Promise<BackfillEncryptReport> {
  const rows = await db.stockItem.findMany({ select: { id: true, credentials: true } });
  let encrypted = 0;
  let alreadyEncrypted = 0;

  for (const row of rows) {
    if (isEncryptedCredentialEnvelope(row.credentials)) {
      alreadyEncrypted++;
      continue;
    }
    await db.$transaction(async (tx) => {
      await tx.stockItem.update({
        where: { id: row.id },
        data: { credentials: encryptCredentials(row.credentials) },
      });
      await recordStockEvent(tx, {
        stockItemId: row.id,
        eventType: StockEventType.REENCRYPTED,
        actor: { type: StockActorType.SYSTEM },
        reasonCode: "PLAINTEXT_BACKFILL",
      });
    });
    encrypted++;
  }

  return { scanned: rows.length, encrypted, alreadyEncrypted };
}

async function main(): Promise<void> {
  await initDb();

  const { scanned, encrypted, alreadyEncrypted } = await backfillEncryptStockCredentials(prisma);

  console.log(
    `[backfill-encrypt-stock-credentials] ${scanned} row(s) scanned: ` +
      `${encrypted} encrypted, ${alreadyEncrypted} already encrypted (skipped).`,
  );
  await prisma.$disconnect();
}

// Guarded so importing this file (the test does) never opens the app's own
// database connection or runs the backfill as a side effect. Same guard as
// scripts/backfill-ledger-history.ts.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(async (e) => {
    console.error("[backfill-encrypt-stock-credentials] failed:", e instanceof Error ? e.message : e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
