# 05 - Remaining risks and next steps

## Approval-gated proposals (not implemented)
- **A4 UNDERPAID/FAILED hold with no expiry** (`orders.ts:1447`, `apps/order-bot/src/jobs/index.ts:494`). Stock, vouchers and wallet holds stay indefinitely. Needs an owner-chosen TTL and release semantics (interaction with late payments), so it was not changed.
- **A5 Digiflazz 24 h Pending treated as definite failure** (`digiflazz.ts:583-590`, `orders.ts:3159`). Touches refund and payment semantics. Suggested design: keep an in-flight "unknown" state and check supplier status before unlocking credit or manual fulfilment.
- **Login lockout DoS and timing leak**: UX/security decision.
- **TOTP replay protection and secret encryption**.
- **DB CHECK constraints** (wallet balance >= 0, status enums): migration plus live-data validation.
- **Re-enable CI**: `ci.yml:10` is `workflow_dispatch` only because of the GitHub Actions billing lock; billing action required.
- **Outbox index `(status, next_retry_at)` and a redundant index** (P3): not measured, so not changed.

## Residual issues and owner confirmations
- **`/setup/bot` pre-auth token overwrite** while the wizard is open: accepted residual, mitigated only by the per-IP rate limit.
- **Empty `ADMIN_IDS` now blocks the wizard owner step** (same rule as `/bootstrap`; the DB `admin_ids` Setting is not consulted). Owner confirmation needed. The "replace previous owner" branch in `setup.ts` is effectively dead.
- **Login limiter at capacity fails closed**: 10,000 distinct keys can block new IPs until the sweep, relevant only with a spoofable/misconfigured `TRUST_PROXY`.
- **Still-unisolated notification enqueues**: `finalizeDeliverySideEffects` (testimonial/referral), `cancelOrder`, `fulfillManualOrder` receipt, wallet top-up settlement. They can reuse `enqueueNotificationSafely`; ORDER_DELIVERED isolation is an owner decision. A dropped notification now leaves only a pino error ("Could not queue the ... notification"); alert on it.
- **Poller `credited=0`** leaves a deposit `matched` with no alert when two deposits map to one already-credited top-up (pre-existing).
- **Paid-after-expiry product order** only alerts the admin.
- **`settleWalletTopup` credits `order.totalAmount`** regardless of the amount reported by the payment.
- **`PENDING_PAYMENT` -> `DELIVERED`** top-up claim remains undeclared in `LEGAL_TRANSITIONS`.
- **Keyless dedupe**: the 10 s window starts at claim, not completion; keyless guests can still double-create pending gateway orders (no money moves); no concurrent USDT wallet top-up test; `idempotency_records` has no retention job.
- **Outbox**: attempts grow during a long SMTP outage and the first transient failure afterwards dead-letters; support-reply worst case (270 s) exceeds the 240 s limit; a timed-out Telegram send may still deliver and then be retried (duplicate); legacy FAILED rows with `SKIPPED_*` are left as is; the admin UI status dropdown does not list SKIPPED.
- **Minor code items**: `_api` parameter unused in `autoCloseStaleTickets`; a malformed `auto_closed` payload renders `#undefined`; admin `Number(id)` in `catalog.ts` and `digiflazzSync.ts` untouched; Bybit top-up timelines now show a transient `PENDING_PAYMENT` hop.
- **No runtime measurements** were taken; no performance claim is made.

## Prior open owner decisions, untouched
Settlement double-submit, `/track` second factor, and support-role refund remain exactly as before this pass.

## Rollback strategy
- All 16 commits are code-only with no schema change and no data migration, so any commit can be reverted independently with `git revert <sha>` (mapping in `03-implementation-log.md`). Reverting 64fdeec2 removes the new top-up-only edges and restores the old CANCELLED -> DELIVERED claim. Reverting 31d7bd08/a138517a stops writing SKIPPED; existing SKIPPED rows are inert strings, but older code would not treat them as terminal or prune them, so clean them up (or leave them) when rolling back.
- No flag gates the changes.

## Deploy notes
- Admin SPA need not change (admin responses keep their shape; `/api/outbox` filter and counts gain SKIPPED).
- Storefront SPA must adopt `expected_total` on wallet checkout and top-up order (send the preview `total` / `total_usdt`), mint a fresh `Idempotency-Key` after a 409 `error.quote_changed`, and add a locale key for `error.quote_changed`. Until then, the quote check is simply not active.
- Restart order-bot and the outbox dispatcher together with the web processes; no `prisma db push` is needed for this pass.
- Production config: set `TRUST_PROXY`, `WEB_COOKIE_SECURE` and a `WEBHOOK_SECRET` of at least 24 characters to avoid the new startup warnings. Make sure `ADMIN_IDS` is set before any first-run setup.
