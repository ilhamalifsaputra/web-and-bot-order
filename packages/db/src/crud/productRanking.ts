/**
 * Bestseller ranking for the storefront: how many distinct delivered orders a
 * product has had, a short-lived cached snapshot of those counts (so paging
 * sees a stable order), and the comparators that turn a snapshot into a sort.
 *
 * Deliberately independent of orders.ts (catalog.ts must not import it).
 */
import type { Db } from "./_types";
import { OrderKind, OrderStatus } from "@app/core/enums";

const RECENT_WINDOW_MS = 30 * 24 * 3600_000;
export const BESTSELLER_TTL_MS = 5 * 60_000;

/**
 * Product id -> number of DISTINCT delivered PRODUCT orders containing any of
 * its denominations (quantity ignored). With `since`, only orders delivered at
 * or after it count.
 */
export async function deliveredOrderCountsByProduct(db: Db, since?: Date): Promise<Map<number, number>> {
  return countDistinctOrders(await loadDeliveredPairs(db, since), since);
}

interface DeliveredPair {
  productId: number;
  orderId: number;
  deliveredAt: Date | null;
}

/** One scan: every (product, delivered PRODUCT order) pair, with the order's delivery time. */
async function loadDeliveredPairs(db: Db, since?: Date): Promise<DeliveredPair[]> {
  const rows = await db.orderItem.findMany({
    where: {
      order: {
        status: OrderStatus.DELIVERED,
        kind: OrderKind.PRODUCT,
        ...(since ? { deliveredAt: { gte: since } } : {}),
      },
    },
    distinct: ["productId", "orderId"],
    select: { productId: true, orderId: true, order: { select: { deliveredAt: true } } },
  });
  if (rows.length === 0) return [];

  // OrderItem.productId holds a Denomination id; map it to its Product.
  const denominationIds = [...new Set(rows.map((r) => r.productId))];
  const denominations = await db.denomination.findMany({
    where: { id: { in: denominationIds } },
    select: { id: true, productId: true },
  });
  const productOfDenomination = new Map(denominations.map((d) => [d.id, d.productId]));
  const pairs: DeliveredPair[] = [];
  for (const r of rows) {
    const productId = productOfDenomination.get(r.productId);
    if (productId !== undefined) pairs.push({ productId, orderId: r.orderId, deliveredAt: r.order.deliveredAt });
  }
  return pairs;
}

function countDistinctOrders(pairs: DeliveredPair[], since?: Date): Map<number, number> {
  const ordersByProduct = new Map<number, Set<number>>();
  for (const { productId, orderId, deliveredAt } of pairs) {
    if (since && (!deliveredAt || deliveredAt < since)) continue;
    let orders = ordersByProduct.get(productId);
    if (!orders) {
      orders = new Set();
      ordersByProduct.set(productId, orders);
    }
    orders.add(orderId);
  }
  return new Map([...ordersByProduct].map(([productId, orders]) => [productId, orders.size]));
}

export interface BestsellerSnapshot {
  /** Increments on every recompute, starting at 1. */
  version: number;
  computedAt: Date;
  /** Distinct delivered orders in the last 30 days. */
  recent: ReadonlyMap<number, number>;
  /** Distinct delivered orders ever. */
  allTime: ReadonlyMap<number, number>;
}

interface SnapshotState {
  current: BestsellerSnapshot | null;
  previous: BestsellerSnapshot | null;
  inflight: Promise<BestsellerSnapshot> | null;
  lastVersion: number;
}

// Per `db` instance, like the settings cache: production passes one client,
// tests with separate fixtures never share a snapshot.
const states = new WeakMap<object, SnapshotState>();

function stateFor(db: Db): SnapshotState {
  let s = states.get(db as object);
  if (!s) {
    s = { current: null, previous: null, inflight: null, lastVersion: 0 };
    states.set(db as object, s);
  }
  return s;
}

/** Drops the cached snapshots for `db` (tests; also forces a fresh version sequence). */
export function resetBestsellerCache(db: Db): void {
  states.delete(db as object);
}

/** The cached ranking snapshot, recomputed at most once per TTL; concurrent callers share one computation. */
export async function getBestsellerSnapshot(db: Db, opts: { now?: Date } = {}): Promise<BestsellerSnapshot> {
  const now = opts.now ?? new Date();
  const state = stateFor(db);
  if (state.current && now.getTime() - state.current.computedAt.getTime() < BESTSELLER_TTL_MS) {
    return state.current;
  }
  if (state.inflight) return state.inflight;

  const refresh = (async () => {
    // One scan feeds both maps.
    const pairs = await loadDeliveredPairs(db);
    const recent = countDistinctOrders(pairs, new Date(now.getTime() - RECENT_WINDOW_MS));
    const allTime = countDistinctOrders(pairs);
    const snapshot: BestsellerSnapshot = { version: ++state.lastVersion, computedAt: now, recent, allTime };
    state.previous = state.current;
    state.current = snapshot;
    return snapshot;
  })();
  state.inflight = refresh;
  try {
    return await refresh;
  } finally {
    state.inflight = null;
  }
}

/** The current snapshot or the one just before it, if its version matches; otherwise null (stable paging). */
export async function getBestsellerSnapshotByVersion(db: Db, version: number): Promise<BestsellerSnapshot | null> {
  const state = states.get(db as object);
  if (!state) return null;
  if (state.current?.version === version) return state.current;
  if (state.previous?.version === version) return state.previous;
  return null;
}

interface Rankable {
  id: number;
  createdAt: Date;
}

/** Newest first: createdAt desc, then id desc. */
export function compareNewest(a: Rankable, b: Rankable): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;
}

/** Bestseller first: recent count desc, all-time count desc, then newest. */
export function compareBestseller(snapshot: BestsellerSnapshot): (a: Rankable, b: Rankable) => number {
  return (a, b) =>
    (snapshot.recent.get(b.id) ?? 0) - (snapshot.recent.get(a.id) ?? 0) ||
    (snapshot.allTime.get(b.id) ?? 0) - (snapshot.allTime.get(a.id) ?? 0) ||
    compareNewest(a, b);
}
