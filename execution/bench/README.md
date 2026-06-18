# execution/05 — Catalog read performance (M-2 / M-3)

Benchmark plan, measurements, and the size-based decision for the two catalog
read issues from the audit (phase-15: P5-01 search, P5-02 catalog render).

## Run it

```bash
pnpm exec tsx execution/bench/search-bench.ts [products] [iterations]
# defaults: 5000 products, 200 iterations
```

Spins an **isolated** SQLite DB (`tests/helpers/testdb` — never touches
`data/bot.db`), seeds a synthetic catalog (~10% of products in groups of 5 to
exercise the collapse/group path), warms up, then reports p50/p95/mean for the
three storefront read paths.

## Metrics & success criteria

| Path | What it feeds | Success |
|---|---|---|
| `searchCatalogEntries('a', 24)` | `/search` | bounded rows read; p95 flat as catalog grows |
| `listNewestCatalogEntries(12)` | home "latest" grid | p95 acceptable at realistic scale |
| `listCatalogEntries(category)` | category page | p95 acceptable at realistic scale |

Correctness gate (independent of timing): `npx vitest run packages/db/src/crud/product_groups.test.ts`
— incl. the **P5-01 parity** test (120 matches > cap ⇒ result is still the
name-sorted top 24).

## Results (this machine, 200 iters)

| Path | 500 products (realistic) | 5000 products (stress) |
|---|---|---|
| `searchCatalogEntries('a')` | **p95 2.38ms** | **p95 2.17ms** |
| `listNewestCatalogEntries(12)` | p95 8.88ms | p95 56.81ms |
| `listCatalogEntries(category)` | p95 9.27ms | p95 56.61ms |

Search p95 is **flat** (~2ms) across 500→5000 because of M-2's cap. Render p95
scales ~linearly with catalog size (~9ms/500 → ~57ms/5000).

## Decisions

### M-2 — `searchCatalogEntries` cap — **DONE**
Added `orderBy: { name: "asc" } + take: limit * SEARCH_OVERFETCH (4)` to both
candidate reads (`catalog.ts`). The DB now returns a name-sorted superset instead
of every LIKE match, so the in-memory `slice(0, limit)` can't be starved and
output stays identical to the unbounded version (proven by the parity test).
Search p95 stays ~2ms even when a broad query matches the whole catalog.

### M-3 — catalog read cache — **DEFERRED (YAGNI)**
At realistic single-shop scale (hundreds of products) home/category render is
**<10ms p95** — not a bottleneck. A cache would add invalidation surface
(`createProduct` / `updateProduct` / `assignProductToGroup`) and a staleness
risk in exchange for single-digit-ms wins. Not worth it now.

**Revisit trigger:** a deployment whose active catalog grows past ~2–3k products
*and* shows a measured home/category p95 problem. Then implement a short-TTL
per-process cache with invalidation-on-write and re-run this bench before/after.
