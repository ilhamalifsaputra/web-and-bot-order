/**
 * One-time offline backfill for the stock-traceability hardening plan
 * (Fase 2). Populates, for StockItem rows that predate the traceability
 * columns/ledger:
 *   - identityFingerprint / credentialFingerprint (keyed HMACs, see
 *     @app/core/credentialCrypto),
 *   - credentialKeyVersion (the envelope's own keyVersion, 0 for legacy
 *     plaintext),
 *   - soldToOrderId / soldToOrderItemId for sold rows (SOLD, or soldAt set),
 *   - a synthetic SYSTEM event history (meta.backfilled = true) rebuilt from
 *     the row's own addedAt/reservedAt/soldAt timestamps, only for rows with
 *     no status-transition event yet,
 *   - activeCredentialKey (Fase 5b) for live rows, lowest id first; a live
 *     duplicate of an already-claimed credential is counted and left NULL,
 *     and a stale claim on a DEAD/soft-deleted row is released.
 *
 * Idempotent per field, so an interrupted run is simply re-run from the start.
 * Scans in batches of 500 by id, one small transaction per row; each row is
 * locked (SELECT ... FOR UPDATE) and re-read inside that transaction before
 * anything is written, so it is safe to run while the app is live.
 *
 *   pnpm backfill-stock-traceability            # writes
 *   pnpm backfill-stock-traceability --dry-run  # reports only
 *
 * Needs `DATABASE_URL_PRISMA` and `CREDENTIAL_ENCRYPTION_KEY` (same values as
 * the app). NEVER logs a credential, plaintext or encrypted — only ids/counts.
 */
import { pathToFileURL } from "node:url";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma, initDb, recordStockEvents, stockClaimKey, type Db, type StockEventInput } from "@app/db";
import { StockActorType, StockEventType, StockStatus } from "@app/core/enums";
import {
  computeCredentialFingerprint,
  computeIdentityFingerprint,
  decryptStockCredentials,
  deriveCredentialIndexKey,
  isEncryptedCredentialEnvelope,
  type CredentialEnvelope,
} from "@app/core/credentialCrypto";

const BATCH_SIZE = 500;
const LOG_PREFIX = "[backfill-stock-traceability]";
const RECONCILE_REASON = "BACKFILL_STATUS_RECONCILE";

export interface BackfillSummary {
  dryRun: boolean;
  scanned: number;
  batches: number;
  fingerprints: { computed: number; alreadyPresent: number; decryptFailed: number };
  soldTo: { backfilled: number; soldWithNoOrderId: number; soldWithNoOrderItem: number; soldOrderMismatch: number };
  events: {
    rowsBackfilled: number;
    eventsCreated: number;
    rowsAlreadyTraced: number;
    /** Rows whose timestamp-derived history did not end at their status and
     * got one closing MARKED_DEAD / RESERVATION_RELEASED event. */
    statusReconciled: number;
    /** Rows whose status (RESERVED/SOLD without its timestamp, or unknown)
     * could not be reached without inventing history — left for review. */
    statusUnreconciled: number;
  };
  keyVersion: { backfilled: number; legacyPlaintext: number };
  claims: {
    claimed: number;
    alreadyClaimed: number;
    /** Live rows left unclaimed because another live row already holds the same credential. */
    duplicate: number;
    /** DEAD/soft-deleted rows whose leftover claim was cleared. */
    released: number;
    /** Live rows with no fingerprint (failed to decrypt), so nothing to claim with. */
    unfingerprinted: number;
  };
}

type Counters = Omit<BackfillSummary, "dryRun" | "scanned" | "batches">;

function emptyCounters(): Counters {
  return {
    fingerprints: { computed: 0, alreadyPresent: 0, decryptFailed: 0 },
    soldTo: { backfilled: 0, soldWithNoOrderId: 0, soldWithNoOrderItem: 0, soldOrderMismatch: 0 },
    events: { rowsBackfilled: 0, eventsCreated: 0, rowsAlreadyTraced: 0, statusReconciled: 0, statusUnreconciled: 0 },
    keyVersion: { backfilled: 0, legacyPlaintext: 0 },
    claims: { claimed: 0, alreadyClaimed: 0, duplicate: 0, released: 0, unfingerprinted: 0 },
  };
}

function addCounters(into: Counters, from: Counters): void {
  for (const group of Object.keys(from) as (keyof Counters)[]) {
    const target = into[group] as Record<string, number>;
    for (const [k, v] of Object.entries(from[group] as Record<string, number>)) target[k] = (target[k] ?? 0) + v;
  }
}

const ROW_SELECT = {
  id: true,
  productId: true,
  status: true,
  deletedAt: true,
  activeCredentialKey: true,
  orderId: true,
  credentials: true,
  addedAt: true,
  reservedAt: true,
  soldAt: true,
  identityFingerprint: true,
  credentialFingerprint: true,
  soldToOrderId: true,
  soldToOrderItemId: true,
  credentialKeyVersion: true,
} satisfies Prisma.StockItemSelect;

type Row = Prisma.StockItemGetPayload<{ select: typeof ROW_SELECT }>;

/** Status-changing event that brings a timestamp-derived history to a status
 * which has no timestamp of its own. RESERVED/SOLD are deliberately absent:
 * without reservedAt/soldAt that would be invented history. */
const RECONCILE_EVENT: Partial<Record<string, StockEventType>> = {
  [StockStatus.DEAD]: StockEventType.MARKED_DEAD,
  [StockStatus.AVAILABLE]: StockEventType.RESERVATION_RELEASED,
};

function syntheticEvents(
  row: Row,
  soldToOrderId: number | null,
  soldToOrderItemId: number | null,
  counters: Counters,
): StockEventInput[] {
  const actor = { type: StockActorType.SYSTEM };
  const meta = { backfilled: true };
  const events: (StockEventInput & { occurredAt: Date })[] = [
    {
      stockItemId: row.id,
      eventType: StockEventType.IMPORTED,
      toStatus: StockStatus.AVAILABLE,
      actor,
      meta,
      occurredAt: row.addedAt,
    },
  ];
  if (row.reservedAt) {
    events.push({
      stockItemId: row.id,
      eventType: StockEventType.RESERVED,
      fromStatus: StockStatus.AVAILABLE,
      toStatus: StockStatus.RESERVED,
      orderId: row.orderId,
      actor,
      meta,
      occurredAt: row.reservedAt,
    });
  }
  if (row.soldAt) {
    events.push({
      stockItemId: row.id,
      eventType: StockEventType.SOLD,
      fromStatus: row.reservedAt ? StockStatus.RESERVED : StockStatus.AVAILABLE,
      toStatus: StockStatus.SOLD,
      orderId: soldToOrderId ?? row.orderId,
      orderItemId: soldToOrderItemId,
      actor,
      meta,
      occurredAt: row.soldAt,
    });
  }

  // "Latest" exactly as checkStockIntegrity sees it: max occurredAt, later insert (higher id) wins ties.
  const latest = events.reduce((a, b) => (b.occurredAt.getTime() >= a.occurredAt.getTime() ? b : a));
  if (latest.toStatus !== row.status) {
    const eventType = RECONCILE_EVENT[row.status];
    if (eventType) {
      events.push({
        stockItemId: row.id,
        eventType,
        fromStatus: latest.toStatus,
        toStatus: row.status,
        actor,
        reasonCode: RECONCILE_REASON,
        // No timestamp exists for this transition; the latest known one is a lower bound.
        meta: { backfilled: true, occurredAtIsLowerBound: true },
        occurredAt: latest.occurredAt,
      });
      counters.events.statusReconciled++;
    } else {
      counters.events.statusUnreconciled++;
      console.warn(
        `${LOG_PREFIX} Stock item ${row.id} has status ${row.status} but no timestamp to rebuild that transition from, ` +
          `so its backfilled history stops at ${String(latest.toStatus)} and the integrity check will flag it for review.`,
      );
    }
  }
  return events;
}

const LIVE_STATUSES: string[] = [StockStatus.AVAILABLE, StockStatus.RESERVED, StockStatus.SOLD];

/** Claim state shared across one run: `claimInRun` false retries a row without claiming (lost a race). */
interface ClaimContext {
  claimInRun: boolean;
  /** Keys this run has claimed (or, in a dry run, would have). */
  claimedKeys: Set<string>;
  /** Dead rows whose stale claim was already released (so a dry run doesn't count one twice). */
  releasedIds: Set<number>;
}

async function processRow(db: Db, row: Row, dryRun: boolean, claim: ClaimContext): Promise<Counters> {
  const counters = emptyCounters();
  const data: Prisma.StockItemUncheckedUpdateInput = {};

  // 2a. Fingerprints.
  if (row.identityFingerprint !== null && row.credentialFingerprint !== null) {
    counters.fingerprints.alreadyPresent++;
  } else {
    let plaintext: string | null = null;
    try {
      plaintext = decryptStockCredentials(row.credentials, row.id);
    } catch (err) {
      counters.fingerprints.decryptFailed++;
      console.warn(
        `${LOG_PREFIX} row ${row.id}: decrypt failed, skipped fingerprinting (${err instanceof Error ? err.message : "unknown error"}).`,
      );
    }
    if (plaintext !== null) {
      if (row.identityFingerprint === null) data.identityFingerprint = computeIdentityFingerprint(plaintext);
      if (row.credentialFingerprint === null) data.credentialFingerprint = computeCredentialFingerprint(plaintext);
      counters.fingerprints.computed++;
    }
  }

  // 2b. soldToOrderId / soldToOrderItemId — also for a sold row later retired
  // to DEAD by a StockReplacement (soldAt kept), or it would lose its buyer.
  let soldToOrderId = row.soldToOrderId;
  let soldToOrderItemId = row.soldToOrderItemId;
  if ((row.status === StockStatus.SOLD || row.soldAt !== null) && row.soldToOrderId === null) {
    if (row.orderId === null) counters.soldTo.soldWithNoOrderId++;
    const items = await db.orderItem.findMany({
      where: { stockItemId: row.id },
      select: { id: true, orderId: true },
      orderBy: { id: "asc" },
    });
    const item = items.find((i) => i.orderId === row.orderId) ?? items[0];
    if (item) {
      if (row.orderId !== null && item.orderId !== row.orderId) {
        counters.soldTo.soldOrderMismatch++;
        console.warn(
          `${LOG_PREFIX} Stock item ${row.id} is linked to order ${row.orderId}, but the order item that delivered it ` +
            `belongs to order ${item.orderId}; recorded order ${item.orderId} as the buyer.`,
        );
      }
      soldToOrderId = item.orderId;
      soldToOrderItemId = item.id;
    } else {
      counters.soldTo.soldWithNoOrderItem++;
      soldToOrderId = row.orderId;
    }
    if (soldToOrderId !== null) {
      data.soldToOrderId = soldToOrderId;
      data.soldToOrderItemId = soldToOrderItemId;
      counters.soldTo.backfilled++;
    }
  }

  // 2d. credentialKeyVersion (needs no decryption, so a corrupt envelope still gets it).
  if (row.credentialKeyVersion === null) {
    const keyVersion = isEncryptedCredentialEnvelope(row.credentials)
      ? (JSON.parse(row.credentials) as CredentialEnvelope).keyVersion
      : 0;
    data.credentialKeyVersion = keyVersion;
    counters.keyVersion.backfilled++;
    if (keyVersion === 0) counters.keyVersion.legacyPlaintext++;
  }

  // 2e. activeCredentialKey — the unique dedup claim bulkAddStock relies on.
  const live = row.deletedAt === null && LIVE_STATUSES.includes(row.status);
  const fingerprint = (data.credentialFingerprint as string | undefined) ?? row.credentialFingerprint;
  if (!live) {
    if (row.activeCredentialKey !== null && !(dryRun && claim.releasedIds.has(row.id))) {
      data.activeCredentialKey = null;
      counters.claims.released++;
    }
  } else if (row.activeCredentialKey !== null) {
    counters.claims.alreadyClaimed++;
  } else if (fingerprint === null) {
    counters.claims.unfingerprinted++;
  } else {
    const key = stockClaimKey(row.productId, fingerprint);
    const holder = claim.claimInRun
      ? await db.stockItem.findFirst({
          where: { activeCredentialKey: key },
          select: { id: true, status: true, deletedAt: true },
        })
      : null;
    const holderLive = holder !== null && holder.deletedAt === null && LIVE_STATUSES.includes(holder.status);
    if (!claim.claimInRun || holderLive || claim.claimedKeys.has(key)) {
      counters.claims.duplicate++;
    } else {
      if (holder) {
        // A DEAD/deleted row still holds this key: free it first, or our claim would hit the unique index.
        if (!dryRun) await db.stockItem.update({ where: { id: holder.id }, data: { activeCredentialKey: null } });
        counters.claims.released++;
        claim.releasedIds.add(holder.id);
      }
      data.activeCredentialKey = key;
      counters.claims.claimed++;
    }
  }

  // 2c. Synthetic events — only when no status transition is recorded yet
  // (a REENCRYPTED/SOFT_DELETED/reveal event alone leaves the row untraced).
  let events: StockEventInput[] = [];
  const transitions = await db.stockItemEvent.count({ where: { stockItemId: row.id, toStatus: { not: null } } });
  if (transitions > 0) {
    counters.events.rowsAlreadyTraced++;
  } else {
    events = syntheticEvents(row, soldToOrderId, soldToOrderItemId, counters);
    counters.events.rowsBackfilled++;
    counters.events.eventsCreated += events.length;
  }

  if (!dryRun) {
    if (Object.keys(data).length > 0) await db.stockItem.update({ where: { id: row.id }, data });
    await recordStockEvents(db, events);
  }
  if (typeof data.activeCredentialKey === "string") claim.claimedKeys.add(data.activeCredentialKey);
  return counters;
}

export async function runBackfill(db: PrismaClient, opts: { dryRun: boolean }): Promise<BackfillSummary> {
  // Fail fast on a missing/malformed key instead of counting every row as a decrypt failure.
  deriveCredentialIndexKey();

  const summary: BackfillSummary = { dryRun: opts.dryRun, scanned: 0, batches: 0, ...emptyCounters() };
  const claimedKeys = new Set<string>();
  const releasedIds = new Set<number>();
  const unclaimedDuplicateIds: number[] = [];
  let afterId = 0;
  for (;;) {
    const batch = await db.stockItem.findMany({
      where: { id: { gt: afterId } },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      select: ROW_SELECT,
    });
    if (batch.length === 0) break;
    summary.batches++;
    for (const row of batch) {
      const writeRow = (claimInRun: boolean) =>
        db.$transaction(async (tx) => {
          // Same row lock as stock.ts's lockStockRows, then re-read: the app may
          // have moved this row since the batch read, and must wait for this commit.
          await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${row.id} FOR UPDATE`;
          const fresh = await tx.stockItem.findUnique({ where: { id: row.id }, select: ROW_SELECT });
          return fresh ? processRow(tx, fresh, false, { claimInRun, claimedKeys, releasedIds }) : emptyCounters();
        });
      let counters: Counters;
      if (opts.dryRun) {
        counters = await processRow(db, row, true, { claimInRun: true, claimedKeys, releasedIds });
      } else {
        try {
          counters = await writeRow(true);
        } catch (err) {
          // A live import claimed the same credential between our check and our write.
          if ((err as { code?: string }).code !== "P2002") throw err;
          counters = await writeRow(false);
        }
      }
      if (counters.claims.duplicate > 0) unclaimedDuplicateIds.push(row.id);
      addCounters(summary, counters);
      summary.scanned++;
    }
    afterId = batch[batch.length - 1]!.id;
    if (batch.length < BATCH_SIZE) break;
  }
  if (unclaimedDuplicateIds.length > 0) {
    console.warn(
      `${LOG_PREFIX} ${unclaimedDuplicateIds.length} live stock row(s) were left without a claim because another live row ` +
        `holds the same credential, so the same account may be sellable twice; review stock items ${unclaimedDuplicateIds.join(", ")}.`,
    );
  }
  return summary;
}

export function formatSummary(s: BackfillSummary): string {
  return [
    `${LOG_PREFIX} ${s.dryRun ? "dry-run: " : ""}${s.scanned} row(s) scanned across ${s.batches} batch(es).`,
    `  Fingerprints: ${s.fingerprints.computed} computed, ${s.fingerprints.alreadyPresent} already had one, ${s.fingerprints.decryptFailed} failed to decrypt.`,
    `  soldToOrderId: ${s.soldTo.backfilled} backfilled, ${s.soldTo.soldWithNoOrderId} sold rows with no orderId, ` +
      `${s.soldTo.soldWithNoOrderItem} sold rows with no matching OrderItem, ${s.soldTo.soldOrderMismatch} mismatches (see lines above).`,
    `  Synthetic events: ${s.events.rowsBackfilled} row(s) got new events (${s.events.eventsCreated} events created total), ` +
      `${s.events.rowsAlreadyTraced} row(s) already had events (skipped); ${s.events.statusReconciled} closed with a status-reconciling event, ` +
      `${s.events.statusUnreconciled} left for review (see lines above).`,
    `  credentialKeyVersion: ${s.keyVersion.backfilled} backfilled (${s.keyVersion.legacyPlaintext} as legacy/0).`,
    `  activeCredentialKey: ${s.claims.claimed} claimed, ${s.claims.alreadyClaimed} already claimed, ` +
      `${s.claims.duplicate} live duplicates left unclaimed (review them), ${s.claims.released} stale claims released, ` +
      `${s.claims.unfingerprinted} live rows with no fingerprint to claim with.`,
  ].join("\n");
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await initDb();
  const summary = await runBackfill(prisma, { dryRun });
  console.log(formatSummary(summary));
  await prisma.$disconnect();
}

// Guarded so importing this file (the test does) never opens the app's own
// database connection or runs the backfill as a side effect.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(async (e) => {
    console.error(`${LOG_PREFIX} failed:`, e instanceof Error ? e.message : e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
