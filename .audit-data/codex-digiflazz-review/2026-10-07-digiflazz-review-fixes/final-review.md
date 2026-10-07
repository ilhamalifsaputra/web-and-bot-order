# Independent final fix review

Reviewed committed range `2250bf4886d8f7e3a45832e10e7ad879c555d3ef..a0a9bb68277334c55c3bf9f362c5d6f47b8e46f1`, the packaged diff, implementation plan, progress ledger, task report, and relevant unchanged writers/schema. Review is read-only except this artifact. No tests were rerun, no Git mutations were performed, and no additional agents were used.

## Verdict

**Not ready to integrate: one Important finding.** No Critical or separate Minor findings. The other requested fixes are coherent on static review. Correct the denomination row lock, add a controlled concurrency regression, then perform the coordinator's integration checks and a scoped review of that correction.

## Important: sync locks the wrong physical table

- Location: `packages/db/src/crud/digiflazz.ts:2506`.
- Evidence: the query is `SELECT id FROM products WHERE id = ${snapshot.id} FOR UPDATE`, immediately followed by `tx.denomination.findUnique` and later `updateDenomination`. `snapshot.id` is a denomination ID. `Denomination` maps to `denominations` (`prisma/schema.prisma:414`); `Product` maps to `products` (`prisma/schema.prisma:298`). These are different records and ID sequences. The query can lock an unrelated product or no row at all.
- Consequence: the claimed marker-then-denomination protocol does not actually lock the denomination before reading its mutable fields. The shared marker still serializes admin availability toggles, but ordinary admin edits do not take that marker. For example, after sync reads `priceOverridden=false`, an admin can save a manual price with `priceOverridden=true` through `apps/web-admin/src/routes/api/catalog.ts:865`; sync then overwrites the manual price using its earlier read while leaving the override flag true. A supplier SKU change in the same interval can similarly receive the former SKU's cost, name, or availability. The new current-SKU check at line 2508 cannot protect changes after that check.
- Fix: lock `denominations`, using the denomination ID, before the fresh read. Add a deterministic test that queues an ordinary denomination edit while the sync's read/write transaction is open, and asserts the edit cannot commit until that transaction releases the denomination lock and that its final values survive. Retain marker-before-denomination ordering.
- Test gap: the added tests at `digiflazz.test.ts:3622` and `:3658` exercise writers that share the marker lock, so they pass despite the wrong denomination lock target.

## Remaining fixes assessed

- **Availability/provenance:** each SKU's availability and remembered membership are changed in one transaction, so a later SKU failure cannot strand the earlier committed availability without provenance. Both availability toggles and sync take the marker first. Conflict-safe marker initialization avoids the absent-marker Prisma read/insert race. Cleanup rereads current remembered rows under the marker lock instead of overwriting concurrent remembered additions from an initial snapshot. Subject to the row-lock finding above, the inspected callers use compatible ordering.
- **Credential freshness:** `getDigiflazzCreds` bounds its expiry by all three source cache expiries; the metadata accessor performs no database read and exposes no value. The existing write listener invalidation and immediate hot-cache return are retained. The three aged-source regressions cover username, key, and enabled state.
- **Credited completion:** `CREDITED` is terminal at `packages/outbox-dispatcher/src/fulfillmentMessages.ts:29`. `creditOrderToBalanceLocked` wakes safe final failure/cancellation rows inside its existing transaction at `packages/db/src/crud/orders.ts:1979`, including the already-cancelled path. The optional correction predicate requires a saved message ID and a FINISHED FAILED/CANCELLED phase, excluding stopped/uncertain messages, successful completion, and already-credited completion.
- **Durable concurrent completion:** `saveProgress` at `packages/outbox-dispatcher/src/fulfillmentMessages.ts:117` takes the order lock before the message write, matching the inspected status/credit writers. It checks current canonical phase after the lock, persists any necessary immediately due correction in the same commit as the acknowledged message ID/text, and preserves the claimed state/timestamp predicate. The ordinary completion and Telegram not-modified paths both use it. No network request is held inside this transaction. A transition that comes after completion can perform its normal wake; one that commits before completion is observed by the phase check.
- **Lease integrity:** saves retain `state` and `claimedAt` ownership checks, and the credit correction only resets claims on FINISHED rows. Direct supplier dispatch, cron, and webhook lease ownership logic is unchanged by this fix range.

## Verification evidence and test quality

Read the recorded evidence, rather than rerunning the coordinator's work. `task-1-green-affected.log` records six files / 450 tests passing; `task-1-green-final-locking.log` records the final two catalog files / 339 tests passing. The report records 12 original red regressions, the additional absent-marker red/green case, and a passing test-source typecheck. These records establish the reported targeted results, not a completed workspace suite.

The new tests assert actual persisted availability/provenance, remembered recovery on a subsequent run, terminal message state, message-ID reuse, and recovery on a fresh worker. The absent-marker test uses a real PostgreSQL lock barrier. The waiting-save test injects failure at the obsolete post-save reread and asserts the correction is already durable; cancellation/credit tests cover both successful edits and Telegram not-modified. The missing ordinary denomination-writer race is the material coverage gap described above.

## Behaviors set aside / limits

- Earlier whole-feature dispatch, catalog, storefront, and progress reviews were not repeated; only surrounding code necessary to evaluate this fix range was inspected.
- The coordinator owns full-suite verification, builds, typechecks, integration, and push. Those were pending during this review.
- No real Telegram/supplier endpoints, production database, or load benchmarks were used. Per-SKU transactions and marker serialization add database work to catalog synchronization; this is visible in the implementation and task report but not performance-tested here.
- Existing conservative handling of unacknowledged initial Telegram sends, and existing money/refund policy or unrelated lock-order caveats, were not expanded into new scope.
