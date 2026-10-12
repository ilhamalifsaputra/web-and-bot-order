import type { Db } from "./_types";
import { StockStatus } from "@app/core/enums";
import { enqueueEmailEvent } from "./emailEvents";

export async function emailInventoryThresholds(db: Db, id: number): Promise<{ critical: number; recovery: number }> {
  const rows = await db.setting.findMany({ where: { key: { in: [`email_inventory_critical_threshold:${id}`, `email_inventory_recovery_threshold:${id}`] } } });
  const critical = Number(rows.find((r) => r.key.startsWith("email_inventory_critical"))?.value ?? 3);
  const recovery = Number(rows.find((r) => r.key.startsWith("email_inventory_recovery"))?.value ?? Math.max(4, critical + 1));
  return { critical, recovery };
}
export async function isFiniteEmailInventorySku(db: Db, id: number): Promise<boolean> {
  const sku = await db.denomination.findUnique({ where: { id }, select: { deliveryType: true, autoDeliverySource: true } });
  return !!sku && sku.deliveryType === "auto" && (sku.autoDeliverySource == null || sku.autoDeliverySource.toLowerCase() === "stock");
}
export function inventoryBand(available: number, critical: number): "NORMAL" | "CRITICAL" | "OUT_OF_STOCK" {
  return available === 0 ? "OUT_OF_STOCK" : available <= critical ? "CRITICAL" : "NORMAL";
}
/** Runs after authoritative stock ledger writes, inside their transaction. No polling/historical replay. */
export async function evaluateEmailInventory(db: Db, changes: { stockItemId: number; fromStatus?: string | null; toStatus?: string | null }[]) {
  const changing = changes.filter((event) => (event.fromStatus === StockStatus.AVAILABLE) !== (event.toStatus === StockStatus.AVAILABLE));
  if (!changing.length) return;
  const stocks = await db.stockItem.findMany({ where: { id: { in: changing.map((e) => e.stockItemId) } }, select: { id: true, productId: true } });
  const ids = [...new Set(stocks.map((row) => row.productId))].sort((a, b) => a - b);
  for (const id of ids) {
    if (!(await isFiniteEmailInventorySku(db, id))) continue;
    // FK inserts in concurrent checkouts hold KEY SHARE on this denomination.
    // NO KEY UPDATE serializes counts without upgrading those locks to a
    // conflicting FOR UPDATE lock and deadlocking the checkouts.
    await db.$queryRaw`SELECT id FROM denominations WHERE id = ${id} FOR NO KEY UPDATE`;
    const sku = await db.denomination.findUnique({ where: { id }, select: { name: true } });
    const available = await db.stockItem.count({ where: { productId: id, deletedAt: null, status: StockStatus.AVAILABLE } });
    const { critical, recovery } = await emailInventoryThresholds(db, id);
    const stateKey = `email_inventory_state:${id}`;
    const saved = await db.setting.findUnique({ where: { key: stateKey } });
    const delta = changing.filter((e) => stocks.find((s) => s.id === e.stockItemId)?.productId === id)
      .reduce((n, e) => n + (e.toStatus === StockStatus.AVAILABLE ? 1 : -1), 0);
    const prior: { band: string; episode: number } = saved ? JSON.parse(saved.value) : { band: inventoryBand(Math.max(0, available - delta), critical), episode: 0 };
    const next = inventoryBand(available, critical);
    const recovered = !!saved && prior.band !== "NORMAL" && available >= recovery;
    const crossed = next === "OUT_OF_STOCK" && prior.band !== next || next === "CRITICAL" && prior.band === "NORMAL";
    const band = !saved || recovered ? next : prior.band !== "NORMAL" && next === "NORMAL" ? prior.band : next;
    const episode = prior.episode + (crossed || recovered ? 1 : 0);
    await db.setting.upsert({ where: { key: stateKey }, create: { key: stateKey, value: JSON.stringify({ band, episode }) }, update: { value: JSON.stringify({ band, episode }) } });
    if (crossed || recovered) await enqueueEmailEvent(db, {
      key: recovered ? "inventory.sku.restocked" : next === "OUT_OF_STOCK" ? "inventory.sku.out_of_stock" : "inventory.sku.critical",
      aggregateId: id, occurrence: episode, payload: { sku_name: sku?.name, available, critical, recovery },
    });
  }
}
