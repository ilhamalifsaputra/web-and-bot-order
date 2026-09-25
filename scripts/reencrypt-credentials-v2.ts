/**
 * Fase 6d, stage 2: rewrite every v1 credential envelope (no AAD) as a v2
 * envelope bound to where it is stored, in all three encrypted columns:
 * StockItem.credentials (`stock_items.credentials:{id}`),
 * Order.deliveredContent (`orders.delivered_content:{orderId}`) and the
 * ENCRYPTED_SETTING_KEYS Setting rows (`settings.value:{key}`).
 *
 * Run it only after the stage-1 reader code is deployed to EVERY process and
 * CREDENTIAL_ENVELOPE_WRITE_V2 is on (see DOCS.md, "Credential envelope v2").
 * A real run refuses to start while the flag is off: the flag is the single
 * switch meaning "v2 values may now exist", and once they do, only code that
 * reads v2 can be rolled back to. `--dry-run` is allowed at any time.
 *
 *   pnpm reencrypt-credentials-v2 --dry-run   # count only, write nothing
 *   pnpm reencrypt-credentials-v2
 *
 * Idempotent (v2 values are skipped) and safe to re-run after an interrupted
 * run. Rows are read in id-ordered batches; each rewrite is a compare-and-set
 * on the value just read, so a concurrent write is never overwritten (it is
 * counted and left for a re-run). Every new envelope is decrypted under its
 * context before it is written. Each rewritten stock row gets a REENCRYPTED
 * event (actor SYSTEM) in the same transaction and its credentialKeyVersion
 * stamped. Plaintext values are left to the plaintext backfill scripts;
 * envelopes that do not decrypt are counted and never touched.
 *
 * NEVER logs a credential, plaintext or encrypted, or a context string — only counts.
 */
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { prisma, initDb, recordStockEvent, ENCRYPTED_SETTING_KEYS } from "@app/db";
import { StockActorType, StockEventType } from "@app/core/enums";
import {
  CredentialKeyConfigError,
  credentialEnvelopeVersion,
  credentialEnvelopeWriteVersion,
  decryptCredentials,
  deliveredContentAad,
  encryptCredentials,
  settingValueAad,
  stockCredentialsAad,
  type CredentialEnvelope,
} from "@app/core/credentialCrypto";

const BATCH_SIZE = 500;

/** Raised when a real (non-dry) run is asked for while writers still emit v1. */
export class ReencryptRefusedError extends Error {
  constructor() {
    super(
      "CREDENTIAL_ENVELOPE_WRITE_V2 is off, so this run would create v2 values the operator has not enabled yet. Deploy the stage-1 reader everywhere, turn the flag on, then re-run (or pass --dry-run to count only).",
    );
    this.name = "ReencryptRefusedError";
  }
}

export interface ReencryptColumnReport {
  /** Rows holding a non-null value. */
  scanned: number;
  /** Readable v1 envelopes found (rewritten unless dry-run). */
  v1: number;
  reencrypted: number;
  /** Readable v2 envelopes under the row's own context; skipped. */
  alreadyV2: number;
  /** Plaintext or empty values; left to the plaintext backfill scripts. */
  notEncrypted: number;
  /** Envelopes that do not decrypt (tampered, another key, wrong context, unknown version); never touched. */
  unreadable: number;
  /** v1 values that changed between the read and the rewrite; left for a re-run. */
  changedDuringRun: number;
}

export interface ReencryptReport {
  dryRun: boolean;
  stock: ReencryptColumnReport;
  deliveredContent: ReencryptColumnReport;
  settings: ReencryptColumnReport;
}

function emptyReport(): ReencryptColumnReport {
  return { scanned: 0, v1: 0, reencrypted: 0, alreadyV2: 0, notEncrypted: 0, unreadable: 0, changedDuringRun: 0 };
}

type Classified = { kind: "v1"; plaintext: string } | { kind: "alreadyV2" | "notEncrypted" | "unreadable" };

/** What one stored value is under `aad`; only a key misconfiguration throws. */
function classify(stored: string, aad: string): Classified {
  let version: 1 | 2 | null;
  try {
    version = credentialEnvelopeVersion(stored);
  } catch {
    return { kind: "unreadable" }; // unknown version marker
  }
  if (version === null) return { kind: "notEncrypted" };
  try {
    const plaintext = decryptCredentials(stored, aad);
    return version === 2 ? { kind: "alreadyV2" } : { kind: "v1", plaintext };
  } catch (err) {
    if (err instanceof CredentialKeyConfigError) throw err;
    return { kind: "unreadable" };
  }
}

/** The v2 envelope for `plaintext` under `aad`, proven to read back before anything is written. */
function sealV2(plaintext: string, aad: string): string {
  const next = encryptCredentials(plaintext, aad);
  if (credentialEnvelopeVersion(next) !== 2 || decryptCredentials(next, aad) !== plaintext) {
    throw new Error("A freshly written v2 credential envelope did not read back under its own context; nothing was written for it.");
  }
  return next;
}

function tally(report: ReencryptColumnReport, c: Classified): c is { kind: "v1"; plaintext: string } {
  report.scanned++;
  if (c.kind === "v1") {
    report.v1++;
    return true;
  }
  report[c.kind]++;
  return false;
}

async function reencryptStock(db: PrismaClient, dryRun: boolean, report: ReencryptColumnReport): Promise<void> {
  let afterId = 0;
  for (;;) {
    const rows = await db.stockItem.findMany({
      where: { id: { gt: afterId } },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      select: { id: true, credentials: true },
    });
    if (rows.length === 0) return;
    afterId = rows[rows.length - 1]!.id;
    for (const row of rows) {
      const aad = stockCredentialsAad(row.id);
      const c = classify(row.credentials, aad);
      if (!tally(report, c) || dryRun) continue;
      const next = sealV2(c.plaintext, aad);
      const written = await db.$transaction(async (tx) => {
        const { count } = await tx.stockItem.updateMany({
          where: { id: row.id, credentials: row.credentials },
          data: { credentials: next, credentialKeyVersion: (JSON.parse(next) as CredentialEnvelope).keyVersion },
        });
        if (count !== 1) return false;
        await recordStockEvent(tx, {
          stockItemId: row.id,
          eventType: StockEventType.REENCRYPTED,
          actor: { type: StockActorType.SYSTEM },
          reasonCode: "ENVELOPE_V2",
        });
        return true;
      });
      if (written) report.reencrypted++;
      else report.changedDuringRun++;
    }
  }
}

async function reencryptDeliveredContent(db: PrismaClient, dryRun: boolean, report: ReencryptColumnReport): Promise<void> {
  let afterId = 0;
  for (;;) {
    const rows = await db.order.findMany({
      where: { id: { gt: afterId } },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      select: { id: true, deliveredContent: true },
    });
    if (rows.length === 0) return;
    afterId = rows[rows.length - 1]!.id;
    for (const row of rows) {
      const stored = row.deliveredContent;
      if (stored === null) continue;
      const aad = deliveredContentAad(row.id);
      const c = classify(stored, aad);
      if (!tally(report, c) || dryRun) continue;
      const { count } = await db.order.updateMany({
        where: { id: row.id, deliveredContent: stored },
        data: { deliveredContent: sealV2(c.plaintext, aad) },
      });
      if (count === 1) report.reencrypted++;
      else report.changedDuringRun++;
    }
  }
}

async function reencryptSettings(db: PrismaClient, dryRun: boolean, report: ReencryptColumnReport): Promise<void> {
  const rows = await db.setting.findMany({
    where: { key: { in: [...ENCRYPTED_SETTING_KEYS] } },
    orderBy: { key: "asc" },
    select: { key: true, value: true },
  });
  for (const row of rows) {
    const aad = settingValueAad(row.key);
    const c = classify(row.value, aad);
    if (!tally(report, c) || dryRun) continue;
    // Straight to the table: the running app's settings cache still holds the v1 value, which stays readable.
    const { count } = await db.setting.updateMany({
      where: { key: row.key, value: row.value },
      data: { value: sealV2(c.plaintext, aad) },
    });
    if (count === 1) report.reencrypted++;
    else report.changedDuringRun++;
  }
}

export async function reencryptCredentialsV2(
  db: PrismaClient,
  opts: { dryRun?: boolean } = {},
): Promise<ReencryptReport> {
  const dryRun = opts.dryRun ?? false;
  if (!dryRun && credentialEnvelopeWriteVersion() !== 2) throw new ReencryptRefusedError();
  const report: ReencryptReport = {
    dryRun,
    stock: emptyReport(),
    deliveredContent: emptyReport(),
    settings: emptyReport(),
  };
  await reencryptStock(db, dryRun, report.stock);
  await reencryptDeliveredContent(db, dryRun, report.deliveredContent);
  await reencryptSettings(db, dryRun, report.settings);
  return report;
}

function describeColumn(name: string, r: ReencryptColumnReport, dryRun: boolean): string {
  return (
    `${name}: ${r.scanned} value(s) scanned, ${r.v1} v1 ${dryRun ? "(would be rewritten)" : `found, ${r.reencrypted} rewritten as v2`}, ` +
    `${r.alreadyV2} already v2, ${r.notEncrypted} not encrypted (left to the plaintext backfills), ` +
    `${r.unreadable} unreadable (left untouched), ${r.changedDuringRun} changed during the run (re-run to pick them up).`
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await initDb();

  const r = await reencryptCredentialsV2(prisma, { dryRun });

  const tag = `[reencrypt-credentials-v2]${dryRun ? " (dry run, nothing written)" : ""}`;
  console.log(`${tag} ${describeColumn("Stock credentials", r.stock, dryRun)}`);
  console.log(`${tag} ${describeColumn("Order delivered content", r.deliveredContent, dryRun)}`);
  console.log(`${tag} ${describeColumn("Encrypted settings", r.settings, dryRun)}`);
  await prisma.$disconnect();
}

// Guarded so importing this file (the test does) never opens the app's own
// database connection or runs the rewrite as a side effect.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(async (e) => {
    // Name and code only: a Prisma validation message can echo query arguments, i.e. a credential.
    const code = (e as { code?: unknown } | null)?.code;
    console.error(
      `[reencrypt-credentials-v2] failed with ${e instanceof Error ? e.name : typeof e}${code ? ` (${String(code)})` : ""}; rows already rewritten stay rewritten and readable, nothing after the failing row was changed. Re-run once the cause is fixed.`,
    );
    if (e instanceof CredentialKeyConfigError || e instanceof ReencryptRefusedError) console.error(e.message);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
