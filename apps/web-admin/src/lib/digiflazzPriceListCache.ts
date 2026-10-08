/**
 * A short-lived, in-process cache in front of Digiflazz's price list, for the
 * admin panel only.
 *
 * One press of the Sync button runs the full catalog sync (/sync/run) and then
 * loads the import preview (/sync/preview) — two price-list fetches a second
 * apart, and Digiflazz refuses the second with rc 83 ("Anda telah mencapai
 * limitasi pengecekan pricelist"). Both routes go through this cache, so the
 * pair costs one fetch.
 *
 *  - Keyed per credential pair by a SHA-256 of `username:apiKey`; the raw
 *    credentials are never stored or logged.
 *  - Successful lists are reused for PRICE_LIST_CACHE_TTL_MS. A sync priced
 *    from a cached list therefore uses data at most five minutes old — the
 *    same list the previous press just used. The hourly cron runs in the
 *    order-bot process and never goes through this cache, so it always
 *    prices from a fresh list.
 *  - Concurrent requests share one in-flight fetch (single flight).
 *  - Failures are not cached, except an rc 83 refusal: for
 *    RATE_LIMIT_COOLDOWN_MS every request gets the same error back without
 *    asking Digiflazz, so repeated presses do not keep extending the limit.
 *
 * `now` is injectable so tests can move time without fake timers.
 */
import { createHash } from "node:crypto";
import {
  getPriceList,
  isDigiflazzRateLimited,
  type DigiflazzCreds,
  type DigiflazzPriceListItem,
} from "@app/core/suppliers/digiflazz";
import { logger } from "@app/core/logger";

export const PRICE_LIST_CACHE_TTL_MS = 5 * 60_000;
export const RATE_LIMIT_COOLDOWN_MS = 60_000;

const cached = new Map<string, { items: DigiflazzPriceListItem[]; expiresAt: number }>();
const inFlight = new Map<string, Promise<DigiflazzPriceListItem[]>>();
const cooldowns = new Map<string, { error: unknown; until: number }>();

function cacheKey(creds: DigiflazzCreds): string {
  return createHash("sha256").update(`${creds.username}:${creds.apiKey}`).digest("hex");
}

/** Digiflazz's price list for `creds`, from the cache when it is fresh enough. */
export async function getPriceListCached(
  creds: DigiflazzCreds,
  now: number = Date.now(),
): Promise<DigiflazzPriceListItem[]> {
  const key = cacheKey(creds);

  const cooldown = cooldowns.get(key);
  if (cooldown) {
    if (now < cooldown.until) throw cooldown.error;
    cooldowns.delete(key);
  }

  const hit = cached.get(key);
  if (hit) {
    // A copy, so a caller reordering its list never changes the next caller's.
    if (now < hit.expiresAt) return [...hit.items];
    cached.delete(key);
  }

  const pending = inFlight.get(key);
  if (pending) return [...(await pending)];

  const request = (async () => {
    try {
      const items = await getPriceList(creds);
      cached.set(key, { items, expiresAt: now + PRICE_LIST_CACHE_TTL_MS });
      return items;
    } catch (err) {
      if (isDigiflazzRateLimited(err)) {
        cooldowns.set(key, { error: err, until: now + RATE_LIMIT_COOLDOWN_MS });
        logger.warn(
          "Digiflazz refused a price-list request with rc 83 (too many price-list checks); the admin panel will not ask again for sixty seconds, and requests in that window get the same refusal.",
        );
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return [...(await request)];
}

/** Forget every cached list, in-flight request and cooldown (tests only). */
export function clearDigiflazzPriceListCache(): void {
  cached.clear();
  inFlight.clear();
  cooldowns.clear();
}
