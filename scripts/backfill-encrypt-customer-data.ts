/**
 * One-time offline backfill: encrypt every `Order.customerData` (the buyer's
 * answers to a product's additional fields) still stored as plaintext from
 * before the column was encrypted at rest. Same shape as
 * scripts/backfill-encrypt-delivered-content.ts: idempotent (a row already
 * holding an encrypted envelope is left alone), safe to re-run after an
 * interrupted run, and it reports counts only.
 *
 * Run it with `DATABASE_URL_PRISMA` and `CREDENTIAL_ENCRYPTION_KEY` set to the
 * same values the app uses:
 *
 *   pnpm backfill-encrypt-customer-data --dry-run   # count only, write nothing
 *   pnpm backfill-encrypt-customer-data
 *
 * An envelope that no longer decrypts (tampered, or encrypted under another
 * key) is counted as corrupt and left untouched — rewriting it cannot recover
 * the answers. Once `plaintext` and `corrupt` both report 0 here AND for the
 * three other credential backfills, ALLOW_LEGACY_PLAINTEXT can be turned off.
 *
 * NEVER logs the answers, plaintext or encrypted — only counts.
 */
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { prisma, initDb } from "@app/db";
import {
  CredentialKeyConfigError,
  decryptCustomerData,
  encryptCustomerData,
  isEncryptedCredentialEnvelope,
} from "@app/core/credentialCrypto";

const BATCH_SIZE = 500;

export interface BackfillCustomerDataReport {
  /** Orders that carry any answers. */
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

export async function backfillEncryptCustomerData(
  db: PrismaClient,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillCustomerDataReport> {
  const report: BackfillCustomerDataReport = {
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
      select: { id: true, customerData: true },
    });
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      const stored = row.customerData;
      // An empty value carries no answers, and decryptCredentials passes "" through even
      // once ALLOW_LEGACY_PLAINTEXT is off, so it needs no rewrite.
      if (stored === null || stored === "") continue;
      report.scanned++;
      if (isEncryptedCredentialEnvelope(stored)) {
        try {
          decryptCustomerData(stored, row.id);
          report.alreadyEncrypted++;
        } catch (err) {
          if (err instanceof CredentialKeyConfigError) throw err;
          report.corrupt++;
        }
        continue;
      }
      report.plaintext++;
      if (opts.dryRun) continue;
      // Compare-and-set on the value just read, so a concurrent buyer edit is never overwritten.
      const { count } = await db.order.updateMany({
        where: { id: row.id, customerData: stored },
        data: { customerData: encryptCustomerData(stored, row.id) },
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

  const r = await backfillEncryptCustomerData(prisma, { dryRun });

  console.log(
    `[backfill-encrypt-customer-data]${dryRun ? " (dry run, nothing written)" : ""} ` +
      `${r.scanned} order(s) with buyer answers scanned: ${r.plaintext} plaintext, ` +
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
    // Name and code only: a Prisma validation message can echo query arguments, i.e. the answers.
    const code = (e as { code?: unknown } | null)?.code;
    console.error(
      `[backfill-encrypt-customer-data] failed with ${e instanceof Error ? e.name : typeof e}${code ? ` (${String(code)})` : ""}; nothing after the failing row was changed. Re-run once the cause is fixed.`,
    );
    if (e instanceof CredentialKeyConfigError) console.error(e.message);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
