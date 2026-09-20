/**
 * Splitting an id list into batches small enough to pass as an `IN (...)` filter.
 *
 * ## Why this exists
 *
 * Postgres's wire protocol caps a single statement at 65535 bind parameters, and
 * Prisma renders `where: { id: { in: ids } }` as one parameter PER id. A query
 * built from an unbounded id list therefore does not get slower as the list
 * grows — it starts failing outright, with a protocol-level error that names the
 * parameter count rather than the report the operator asked for.
 *
 * Every id list in this package that came from "read the rows in this window,
 * then look up something keyed by their ids" has that shape, and the lists are
 * window-sized, not bounded by anything the code chose: a year view over a busy
 * shop, or a lifetime-wide reconciliation, are exactly the cases that reach the
 * ceiling — and exactly the cases nobody runs until the day they matter.
 *
 * ## Why 10000 and not 65535
 *
 * The cap is on the whole statement, not on this one filter, so a query that
 * also carries a date range, a status list and a kind filter has fewer than
 * 65535 slots left for ids. 10000 leaves that headroom without making the chunk
 * count interesting: 100k orders is 10 round trips, and the per-statement
 * planning cost of a 10k-element `IN` is already well past the point where
 * shrinking the chunk further buys anything.
 *
 * Chunking changes no result. Every caller here is summing, grouping or
 * set-building over rows selected by id, which are associative operations over
 * disjoint id sets — so N chunked reads fold to exactly what one read would have
 * returned. What it does change is that the reads are no longer one atomic
 * snapshot; that is acceptable for the reporting and reconciliation callers that
 * use it (each already reads its operational rows and its ledger rows in
 * separate statements) and would NOT be for anything asserting an invariant
 * across the two.
 */

/** Ids per `IN (...)` filter. See this module's doc comment for why. */
export const ID_CHUNK_SIZE = 10_000;

/**
 * `ids` split into consecutive chunks of at most `size`. An empty input yields
 * no chunks at all, so `for (const chunk of idChunks(ids))` runs zero times
 * rather than issuing one query with an empty `IN ()` — which Postgres accepts
 * but which is a wasted round trip every caller would otherwise have to guard
 * against itself.
 */
export function idChunks<T>(ids: readonly T[], size = ID_CHUNK_SIZE): T[][] {
  if (size < 1) throw new Error(`idChunks needs a positive chunk size, not ${size}`);
  const chunks: T[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    chunks.push(ids.slice(start, start + size));
  }
  return chunks;
}
