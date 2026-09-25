/**
 * One-time offline backfill (Fase 6c): encrypt every `Order.deliveredContent`
 * still stored as plaintext from before the column was encrypted at rest.
 * Same shape as scripts/backfill-encrypt-stock-credentials.ts: idempotent (a
 * row already holding an encrypted envelope is left alone), safe to re-run
 * after an interrupted run, and it reports counts only.
 *
 * Run it with `DATABASE_URL_PRISMA` and `CREDENTIAL_ENCRYPTION_KEY` set to the
 * same values the app uses:
 *
 *   pnpm backfill-encrypt-delivered-content --dry-run   # count only, write nothing
 *   pnpm backfill-encrypt-delivered-content
 *
 * An envelope that no longer decrypts (tampered, or encrypted under another
 * key) is counted as corrupt and left untouched — rewriting it cannot recover
 * the content. Once `plaintext` and `corrupt` both report 0, ALLOW_LEGACY_PLAINTEXT
 * can be turned off for this column.
 *
 * NEVER logs delivered content, plaintext or encrypted — only counts.
 */
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { prisma, initDb } from "@app/db";
import {
  CredentialKeyConfigError,
  decryptCredentials,
  encryptDeliveredContent,
  isEncryptedCredentialEnvelope,
} from "@app/core/credentialCrypto";

const BATCH_SIZE = 500;

export interface BackfillDeliveredContentReport {
  /** Orders that carry any delivered content. */
  scanned: number;
  /** Plaintext rows found (rewritten unless dry-run). */
  plaintext: number;
  encrypted: number;
  alreadyEncrypted: number;
  /** Envelope-shaped rows that fail to decrypt; never rewritten. */
  corrupt: number;
  /** Plaintext rows that changed between the read and the rewrite; left for a re-run. */
  changedDuringRun: number;
}

export async function backfillEncryptDeliveredContent(
  db: PrismaClient,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillDeliveredContentReport> {
  const report: BackfillDeliveredContentReport = {
    scanned: 0,
    plaintext: 0,
    encrypted: 0,
    alreadyEncrypted: 0,
    corrupt: 0,
    changedDuringRun: 0,
  };
  let afterId = 0;
  for (;;) {
    // Paged by id only; the null check happens here, not as a query filter on the column.
    const rows = await db.order.findMany({
      where: { id: { gt: afterId } },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      select: { id: true, deliveredContent: true },
    });
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      const stored = row.deliveredContent;
      if (stored === null) continue;
      report.scanned++;
      if (isEncryptedCredentialEnvelope(stored)) {
        try {
          decryptCredentials(stored);
          report.alreadyEncrypted++;
        } catch (err) {
          if (err instanceof CredentialKeyConfigError) throw err;
          report.corrupt++;
        }
        continue;
      }
      report.plaintext++;
      if (opts.dryRun) continue;
      // Compare-and-set on the value just read, so a concurrent write is never overwritten.
      const { count } = await db.order.updateMany({
        where: { id: row.id, deliveredContent: stored },
        data: { deliveredContent: encryptDeliveredContent(stored) },
      });
      if (count === 1) report.encrypted++;
      else report.changedDuringRun++;
    }
  }
  return report;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await initDb();

  const r = await backfillEncryptDeliveredContent(prisma, { dryRun });

  console.log(
    `[backfill-encrypt-delivered-content]${dryRun ? " (dry run, nothing written)" : ""} ` +
      `${r.scanned} order(s) with delivered content scanned: ${r.plaintext} plaintext, ` +
      `${r.encrypted} encrypted now, ${r.alreadyEncrypted} already encrypted, ` +
      `${r.corrupt} corrupt envelope(s) left untouched, ${r.changedDuringRun} changed during the run (re-run to pick them up).`,
  );
  await prisma.$disconnect();
}

// Guarded so importing this file (the test does) never opens the app's own
// database connection or runs the backfill as a side effect.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(async (e) => {
    // Name and code only: a Prisma validation message can echo query arguments, i.e. the content.
    const code = (e as { code?: unknown } | null)?.code;
    console.error(
      `[backfill-encrypt-delivered-content] failed with ${e instanceof Error ? e.name : typeof e}${code ? ` (${String(code)})` : ""}; nothing after the failing row was changed. Re-run once the cause is fixed.`,
    );
    if (e instanceof CredentialKeyConfigError) console.error(e.message);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
