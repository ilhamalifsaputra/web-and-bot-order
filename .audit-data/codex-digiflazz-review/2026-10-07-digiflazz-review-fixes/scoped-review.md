# Scoped corrective review

Range: `a0a9bb68277334c55c3bf9f362c5d6f47b8e46f1..fd9d24388f7ce8f1fea9732e610888d901af21bc`.

**Verdict: addressed. No Critical, Important, or Minor findings in the corrective diff. Ready from code review, conditional on the coordinator's remaining integration checks passing.** This resolves the sole Important finding in `final-review.md`; that earlier not-ready verdict is superseded by this scoped result.

- `packages/db/src/crud/digiflazz.ts:2506` now locks `denominations`, matching `Denomination`'s actual table mapping at `prisma/schema.prisma:414`. The marker is still acquired first, the denomination is read after the lock, and the read/check/write remain in the same transaction. An ordinary editor already holding the denomination row must commit before sync reads it; an editor arriving after sync's lock must wait until sync commits. This closes the reported stale price-override/SKU window without changing the availability writer ordering.
- The new regression at `packages/db/src/crud/digiflazz.test.ts:3691` holds a real ordinary admin price edit uncommitted, starts synchronization against the old visible snapshot, observes a PostgreSQL lock wait, and then commits the edit. It verifies the override flag, the retained manual price of 25000, no automatic sell-price update, and the updated supplier cost of 15000. This directly exercises the previously missing writer that does not use the availability marker.
- `packages/db/src/crud/catalog.ts:8` corrects the misleading table-mapping comment that contributed to the error. It matches the current schema and has no runtime effect.

Evidence inspected: the corrective diff, appended task report, schema mapping, local corrected transaction, and red/green log tails. The red log records the actual incorrect persisted price (16500 instead of 25000); the green log records both affected files passing all 340 tests. The report also records passing test-source TypeScript and diff whitespace checks. These are existing recorded results, not checks rerun by this reviewer.

No new breakage was identified in the correction. No unrelated earlier areas were re-reviewed, no tests were rerun, no Git mutations were performed, and no agents were spawned. Full-suite/integration verification remains owned by the coordinator and was still running when this scoped review was written.
