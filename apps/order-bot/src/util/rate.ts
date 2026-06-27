/**
 * Cached usd_idr_rate lookup for display rendering. Handlers render many
 * prices per screen; a 60s cache keeps that to ~zero extra queries while
 * still picking up admin rate edits quickly. Null = rate unset → screens
 * show Rupiah only and the Binance/USDT payment path is disabled.
 */
import { Decimal } from "@app/core/money";
import { prisma, getUsdIdrRate } from "@app/db";

const TTL_MS = 60_000;
let cache: { rate: Decimal | null; at: number } = { rate: null, at: 0 };

export async function currentUsdtRate(): Promise<Decimal | null> {
  if (Date.now() - cache.at > TTL_MS) {
    cache = { rate: await getUsdIdrRate(prisma), at: Date.now() };
  }
  return cache.rate;
}

/** Test hook / settings-edit hook: drop the cache so the next read is fresh. */
export function invalidateRateCache(): void {
  cache = { rate: null, at: 0 };
}
