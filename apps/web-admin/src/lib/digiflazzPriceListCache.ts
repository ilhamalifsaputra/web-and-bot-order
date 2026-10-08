/**
 * A short-lived, in-process cache in front of Digiflazz's price list, for the
 * admin panel only.
 *
 * One press of the Sync button runs the full catalog sync (/sync/run) and then
 * loads the import preview (/sync/preview) — two price-list fetches a second
 * apart, and Digiflazz refuses the second with rc 83 ("Anda telah mencapai
 * limitasi pengecekan pricelist"). The run fetches and stores the list; the
 * preview reads it back, so the pair costs one fetch.
 *
 * Two ways in, with different freshness rules:
 *  - getPriceListFresh (the run, which writes prices) always asks Digiflazz.
 *    It never reads a cached list and never joins a fetch that was already in
 *    flight when it was called — another process (the hourly cron in
 *    order-bot) may have written newer prices since that list was fetched,
 *    and pricing from it would roll them back. It does store its result.
 *  - getPriceListCached (the preview, which prices nothing — the apply step
 *    uses the numbers the admin reviewed) reuses a stored list for
 *    PRICE_LIST_CACHE_TTL_MS and joins an in-flight fetch (single flight).
 *
 * Shared by both:
 *  - Keyed per credential pair by a SHA-256 of `username:apiKey`; the raw
 *    credentials are never stored or logged.
 *  - Failures are not cached, except an rc 83 refusal: for
 *    RATE_LIMIT_COOLDOWN_MS from when the refusal arrived, every request gets
 *    the same error back without asking Digiflazz, so repeated presses do not
 *    keep extending the limit.
 *  - A list fetched earlier never overwrites one fetched later, whichever
 *    finishes first.
 *  - Expired lists and cooldowns are pruned on every call, so a rotated
 *    credential's entries do not linger.
 *
 * The clock is injectable so tests can move time without fake timers.
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

type Clock = () => number;

/** `seq` orders fetches by when they started, so an older one never wins. */
const cached = new Map<string, { items: DigiflazzPriceListItem[]; expiresAt: number; seq: number }>();
const inFlight = new Map<string, Promise<DigiflazzPriceListItem[]>>();
const cooldowns = new Map<string, { error: unknown; until: number }>();
let nextSeq = 0;
/** Bumped by clearDigiflazzPriceListCache, so a fetch begun before a clear never re-fills it. */
let generation = 0;

function cacheKey(creds: DigiflazzCreds): string {
  return createHash("sha256").update(`${creds.username}:${creds.apiKey}`).digest("hex");
}

function pruneExpired(now: number): void {
  for (const [key, entry] of cached) if (now >= entry.expiresAt) cached.delete(key);
  for (const [key, entry] of cooldowns) if (now >= entry.until) cooldowns.delete(key);
}

/** Starts a fetch for `key`, registers it as the in-flight one, and stores its list on success. */
function startFetch(key: string, creds: DigiflazzCreds, clock: Clock, startedAt: number): Promise<DigiflazzPriceListItem[]> {
  const seq = nextSeq++;
  const startedIn = generation;
  // Assigned before the body below runs past its first await, which is the
  // only place it is read.
  let request!: Promise<DigiflazzPriceListItem[]>;
  request = (async () => {
    // Yield first, so even a fetcher that throws synchronously settles only
    // after this request is registered in `inFlight` below — otherwise the
    // `finally` would run first and leave a rejected request there for good.
    await Promise.resolve();
    try {
      const items = await getPriceList(creds);
      const current = cached.get(key);
      if (startedIn === generation && (!current || current.seq < seq)) {
        cached.set(key, { items, expiresAt: startedAt + PRICE_LIST_CACHE_TTL_MS, seq });
      }
      return items;
    } catch (err) {
      if (isDigiflazzRateLimited(err) && startedIn === generation) {
        cooldowns.set(key, { error: err, until: clock() + RATE_LIMIT_COOLDOWN_MS });
        logger.warn(
          "Digiflazz refused a price-list request with rc 83 (too many price-list checks); the admin panel will not ask again for sixty seconds, and requests in that window get the same refusal.",
        );
      }
      throw err;
    } finally {
      // Only our own entry: a newer fetch may have taken the slot meanwhile.
      if (inFlight.get(key) === request) inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return request;
}

/** The rc 83 refusal to answer with instead of asking Digiflazz, if one is still cooling down. */
function throwIfCoolingDown(key: string, now: number): void {
  const cooldown = cooldowns.get(key);
  if (cooldown && now < cooldown.until) throw cooldown.error;
}

/**
 * Digiflazz's price list for `creds`, from the cache when it is fresh enough.
 * For read-only use (the import preview); never price from it.
 */
export async function getPriceListCached(
  creds: DigiflazzCreds,
  clock: Clock = Date.now,
): Promise<DigiflazzPriceListItem[]> {
  const now = clock();
  pruneExpired(now);
  const key = cacheKey(creds);
  throwIfCoolingDown(key, now);

  // A copy, so a caller reordering its list never changes the next caller's.
  const hit = cached.get(key);
  if (hit) return [...hit.items];

  const pending = inFlight.get(key) ?? startFetch(key, creds, clock, now);
  return [...(await pending)];
}

/**
 * Digiflazz's price list for `creds`, fetched now — for the catalog sync,
 * which writes prices from it. Still refuses during an rc 83 cooldown, and
 * stores the list so the preview that follows reuses it.
 */
export async function getPriceListFresh(
  creds: DigiflazzCreds,
  clock: Clock = Date.now,
): Promise<DigiflazzPriceListItem[]> {
  const now = clock();
  pruneExpired(now);
  const key = cacheKey(creds);
  throwIfCoolingDown(key, now);
  return [...(await startFetch(key, creds, clock, now))];
}

/** Forget every cached list, in-flight request and cooldown (tests only). */
export function clearDigiflazzPriceListCache(): void {
  cached.clear();
  inFlight.clear();
  cooldowns.clear();
  generation++;
}

/** How many lists, in-flight requests and cooldowns are held (tests only). */
export function digiflazzPriceListCacheEntryCount(): number {
  return cached.size + inFlight.size + cooldowns.size;
}
