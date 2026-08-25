/**
 * CRUD for ProductProviderMapping — the transaction-provider fallback
 * catalog layer (Task 4, Trustance Master Architecture Phase 1). Mirrors
 * `crud/games.ts`'s ProviderGameMapping pattern (list/getEnabled/upsert/
 * delete, `[fkId, provider]` unique key), applied to the *transaction*
 * dispatch side instead of the nickname-check side.
 *
 * Key difference from ProviderGameMapping: ProviderGameMapping is read live,
 * per nickname-check request, by NicknameService — a request-time fan-out is
 * cheap because nickname checks are inherently low-volume, interactive
 * lookups. Digiflazz dispatch (`crud/digiflazz.ts`,
 * `dispatchPendingDigiflazzOrders`/`resolveSingleDigiflazzItem`) is a
 * read-heavy poller path that must stay a single-table read — see
 * `Denomination.autoDeliverySource`/`supplierSku`'s doc comments. So instead
 * of the dispatch path joining against this table on every tick,
 * `resolveDenominationProvider` (below) is the one place that recomputes
 * those two Denomination fields from this table's current top-priority
 * ENABLED row, and is invoked automatically by every mutation in this file
 * (upsert/delete). The dispatch path itself is untouched by this task — it
 * keeps reading the two Denomination fields exactly as it did before, now
 * kept fresh by this resolver instead of hand-set at import time only.
 *
 * `productId` here holds a Denomination id — see the model's own doc
 * comment in schema.prisma for why the column is still called `product_id`
 * (Denomination was physically the old `products` table).
 *
 * additive/non-destructive guarantee: resolveDenominationProvider only ever
 * WRITES a resolved (provider, providerSku) pair onto the Denomination when
 * an enabled mapping row exists for it. It never clears
 * autoDeliverySource/supplierSku back to null when a Denomination's mapping
 * set becomes empty (every row deleted, or all rows disabled) — every
 * existing Digiflazz-routed Denomination that has never had a
 * ProductProviderMapping row at all is untouched by this module entirely
 * (this file is never called for it), and a Denomination that opts into a
 * mapping row keeps whatever was last resolved even if its mappings are
 * later removed, rather than silently going back to "no auto-delivery".
 * Building live failover-on-delivery-failure is explicitly out of scope for
 * this task (see .superpowers/sdd/task-4-brief.md) — this resolver only
 * proves the mapping-to-cache wiring works.
 */
import { Decimal } from "@app/core/money";
import { quantizeMoney } from "@app/core/formatters";
import type { PrismaClient } from "../client";
import type { Db } from "./_types";
import { updateDenomination } from "./catalog";

/** All provider mappings for a Denomination (SKU), ordered by priority ascending. */
export function listProviderMappingsForDenomination(db: Db, productId: number) {
  return db.productProviderMapping.findMany({
    where: { productId },
    orderBy: { priority: "asc" },
  });
}

/** Enabled provider mappings for a Denomination, ordered by priority ascending —
 * mirrors games.ts's getEnabledProviderMappingsForGame. Not consulted by the
 * live Digiflazz dispatch path (which reads the resolved cache instead); kept
 * for admin listing/inspection and as the resolver's own building block. */
export function getEnabledProviderMappingsForDenomination(db: Db, productId: number) {
  return db.productProviderMapping.findMany({
    where: { productId, enabled: true },
    orderBy: { priority: "asc" },
  });
}

/**
 * The resolver: recompute this Denomination's
 * `autoDeliverySource`/`supplierSku` from its current top-priority ENABLED
 * ProductProviderMapping row, if one exists. Returns the mapping row it
 * resolved to, or null if there is no enabled mapping (in which case the
 * Denomination's existing fields are left completely untouched — see this
 * file's module doc comment for why that's the deliberate, additive-safe
 * behavior rather than clearing them).
 */
export async function resolveDenominationProvider(db: Db, productId: number) {
  const top = await db.productProviderMapping.findFirst({
    where: { productId, enabled: true },
    orderBy: { priority: "asc" },
  });
  if (!top) return null;
  // COUPLING WARNING (final whole-branch review, Trustance Master
  // Architecture Phase 1): `top.provider` is an arbitrary provider string
  // from this table (the mapping tests themselves create "providerB"/
  // "providerC"), but THREE other places treat `autoDeliverySource` as a
  // boolean "is this Digiflazz-dispatched" flag, not an arbitrary provider
  // id:
  //   - packages/core/src/cartComposition.ts's `DIGIFLAZZ_SOURCE` constant /
  //     `cartKindOf` — reclassifies the SKU as PREMIUM (not TOPUP) the
  //     moment this isn't exactly "digiflazz".
  //   - apps/storefront/src/routes/api.ts's single-unit cart guard — stops
  //     applying the same way.
  //   - packages/db/src/crud/digiflazz.ts's `dispatchPendingDigiflazzOrders`
  //     — its poller query filters on `autoDeliverySource: "digiflazz"`
  //     literally, so any other value means the SKU is picked up by NO
  //     dispatcher at all.
  // Writing any provider value here other than `"digiflazz"` silently breaks
  // all three guards for that SKU: it misclassifies as a normal premium item
  // and a paid order for it sits in the manual queue forever, with nothing
  // to auto-fulfil it. This is not reachable today (no production caller
  // invokes `resolveDenominationProvider`), but MUST be fixed — with a real
  // multi-provider dispatch registry, not this single boolean-shaped column
  // — before a second transaction provider is ever actually onboarded
  // through this table.
  await updateDenomination(db, productId, { autoDeliverySource: top.provider, supplierSku: top.providerSku });
  return top;
}

/** Create or update the mapping for (productId, provider), keyed on the
 * schema's `@@unique([productId, provider])` compound key (Prisma-generated
 * field name `productId_provider`). A second call for the same pair updates
 * the existing row in place rather than creating a duplicate — same shape as
 * games.ts's upsertProviderGameMapping. Runs the resolver in the same
 * transaction so the Denomination's cached fields never observably lag the
 * mapping write. */
export async function upsertProductProviderMapping(
  db: PrismaClient,
  fields: {
    productId: number;
    provider: string;
    providerSku: string;
    providerCost?: Decimal.Value | null;
    costSyncedAt?: Date | null;
    enabled?: boolean;
    priority?: number;
  },
) {
  const { productId, provider, providerSku, providerCost, costSyncedAt, enabled, priority } = fields;
  const quantizedCost = providerCost != null ? quantizeMoney(providerCost, 4) : null;
  return db.$transaction(async (tx) => {
    const mapping = await tx.productProviderMapping.upsert({
      where: { productId_provider: { productId, provider } },
      create: { productId, provider, providerSku, providerCost: quantizedCost, costSyncedAt, enabled, priority },
      update: { providerSku, providerCost: quantizedCost, costSyncedAt, enabled, priority },
    });
    await resolveDenominationProvider(tx, productId);
    return mapping;
  });
}

/** Delete a mapping row and re-resolve its Denomination's cached fields from
 * whatever mapping is now top-priority (falls back to the next-enabled row,
 * or leaves the Denomination's fields untouched if none remain — see
 * resolveDenominationProvider's doc comment). */
export async function deleteProductProviderMapping(db: PrismaClient, id: number): Promise<void> {
  await db.$transaction(async (tx) => {
    const existing = await tx.productProviderMapping.findUnique({ where: { id } });
    if (!existing) return;
    await tx.productProviderMapping.delete({ where: { id } });
    await resolveDenominationProvider(tx, existing.productId);
  });
}
