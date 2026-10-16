# 01 - Findings

Pass 2 on base 7d92dcfa. Line numbers in Evidence are those of the base commit as given in the audit plan unless noted. Reproductions are the failing tests recorded in the task reports.

## Fixed

### [P1] A1 First-run setup takeover (with B9 limiter cap and B12 startup warnings)
- **Evidence**: `apps/web-admin/src/routes/setup.ts` `POST /setup/owner` (~144) and `/setup/bot` (~116) were pre-auth, with no rate limit, and `/setup/owner` did not require the Telegram ID to be in `ADMIN_IDS` (compare `/bootstrap`, `routes/auth.ts:55`). B9: `apps/web-admin/src/auth.ts` `attempts` (~297) and `accountFailures` (~323) maps were unbounded. B12: no production warning for weak config (`config.ts` ~215, ~261).
- **Impact**: the first visitor to an unfinished install could become super-admin; limiter maps could grow without bound under a flood of keys; unsafe production config went unnoticed.
- **Reproduction**: RED tests failed: `startupWarnings.test.ts` (module missing), `login-limiter-cap.test.ts` (`loginLimiterSizes is not a function`), 4 new "pre-auth takeover hardening" tests in `web.test.ts` (ADMIN_IDS refusal and both 429 behaviours absent). Nonce tests for the finish step were written together with the fix, so no separate RED run exists.
- **Root cause**: setup routes trusted any caller; limiter maps had no size cap.
- **Change**: `/setup/owner` requires `config.ADMIN_IDS` membership when that list is non-empty (an empty list lets the wizard set the first admin, as originally designed); `/setup/bot`, `/setup/owner`, `/setup/shop` share a per-IP limiter (20 per 600 s, 429). `/setup/shop` is bound to the step-2 browser via a random nonce cookie (only its sha256 is stored in Setting `setup_owner_nonce_hash`, constant-time compare, 403 otherwise). B9: `MAX_LOGIN_LIMITER_BUCKETS = 10_000` (`auth.ts:303`) with a once-per-window sweep; a new key at capacity fails closed (eviction was rejected because a flood could evict an attacker's own bucket). B12: pure `collectProductionWarnings` (`packages/core/src/startupWarnings.ts`) logs `logger.warn` in production when `TRUST_PROXY` is unset, `WEB_COOKIE_SECURE` is false, or `WEBHOOK_SECRET` is set but under 24 chars; never echoes the secret; warning only, no crash.
- **Tests**: `web.test.ts`, `login-limiter-cap.test.ts`, `startupWarnings.test.ts`: 3 files, 652 passed after review round 1. Existing wizard tests were adapted (owner ids pushed into `config.ADMIN_IDS`).
- **Compatibility/Rollback**: none for installs with `ADMIN_IDS` set; a fresh install with empty `ADMIN_IDS` still sets its first admin through the wizard (an earlier version of this fix wrongly blocked that; corrected afterwards). Revert commits 060c0d36 and 43241baf; no schema change.
- **Status**: fixed (accepted residual: `/setup/bot` token overwrite while the wizard is open, mitigated only by the rate limit).

### [P1] A2 Bybit BSC top-up status written from a stale read
- **Evidence**: `packages/db/src/crud/bybit_bsc_deposit.ts` (~680, `settleClaimedBybitBscDeposit`) did `tx.order.update({ data: { status: PENDING_PAYMENT } })` with no status guard, based on an earlier unlocked `getOrder`.
- **Impact**: an admin cancel committed between read and write was overwritten back to PENDING_PAYMENT, and a DELIVERED order could be rewound, re-claimed and re-credited (only the wallet ledger unique key stopped a double credit, driving the poller into its failure/NEEDS_REVIEW path).
- **Reproduction**: new tests in `bybit_bsc_deposit.test.ts` commit the concurrent write on a separate connection right after the delivery transaction's first `order.findUnique`. RED: cancel silently overwritten; concurrent settle gave `Unique constraint failed (order_id, reason)`; no-race history was `[]` instead of `[PENDING_PAYMENT, DELIVERED]` (3 failed).
- **Root cause**: blind UPDATE at READ COMMITTED.
- **Change**: `normalizeTopupToPendingPayment` does a compare-and-swap through `tryTransitionOrderStatus` (writes a history row, meta `wallet_topup_settling`); on a lost CAS it re-reads and retries only while the order is still in an on-chain milestone (bounded loop), else stops. `LEGAL_TRANSITIONS` gained the top-up-only edges PAYMENT_DETECTED/CONFIRMING/CONFIRMED -> PENDING_PAYMENT (`WALLET_TOPUP_ONLY_TRANSITIONS`, `orderStatus.ts:137`).
- **Tests**: 3 new tests plus `orderStatus.test.ts` edge tests; bybit/orderStatus/wallet_topup files 172 passed; related 15 files 488 passed; other gateway/order files 13 files 356 passed.
- **Compatibility/Rollback**: who is credited and how much is unchanged (an admin-cancel race now credits once as an honest late credit). A top-up timeline now shows a transient PENDING_PAYMENT hop. Revert commit 64fdeec2; no schema change.
- **Status**: fixed (open: poller `credited=0` leaves a deposit `matched` with no alert, pre-existing; see 05).

### [P2] B11 Top-up late credit had no history and an undeclared edge
- **Evidence**: `packages/db/src/crud/wallet_topup.ts` (~620) claimed CANCELLED -> DELIVERED, absent from `LEGAL_TRANSITIONS` (`orderStatus.ts:37-116`), and wrote no `OrderStatusHistory` row (nor did the on-time claim).
- **Impact**: audit trail missed the credit; the state-machine table was not the real source of truth.
- **Reproduction**: RED (tests against HEAD versions): late credit history `['CANCELLED']` instead of `['CANCELLED','DELIVERED']`; on-time credit left no row; `CANCELLED -> DELIVERED` refused for a top-up; 7 failed in total.
- **Root cause**: claim done by direct `updateMany` outside the state machine.
- **Change**: `LEGAL_TRANSITIONS[CANCELLED] = [DELIVERED]`, top-up-only. The claim is split into two `updateMany` calls (PENDING_PAYMENT, then CANCELLED), same status set. One DELIVERED history row with meta `wallet_topup_late_credit` or `wallet_topup_credited`; double settlement writes nothing. `_manualQrisClaim.ts` comment and `docs/arsitektur/ORDER_STATE_MACHINE.md` updated.
- **Tests**: `wallet_topup.test.ts`, `orderStatus.test.ts` (product-order CANCELLED -> DELIVERED still refused, a guard that already passes on HEAD).
- **Compatibility/Rollback**: the old "CANCELLED is terminal" pin was deliberately narrowed to REJECTED/REFUNDED. Revert 64fdeec2.
- **Status**: fixed (PENDING_PAYMENT -> DELIVERED left undeclared on purpose).

### [P1] A3 Notification enqueue could roll back a paid order
- **Evidence**: `packages/db/src/crud/orders.ts` `settlePaidOrder` (owner email ~2869, buyer receipt ~2898, `enqueueOrderEmailFact` ~2930, processing DM/admin alert/owner email ~2963-2991) and `orderStatus.ts` `enqueueOrderTransitionEmails` (~168) were bare awaits inside the rail's `$transaction`.
- **Impact**: an enqueue throw (JS or DB) aborted the transaction and un-paid an order the gateway had already charged.
- **Reproduction**: `settlePaidOrderNotifyIsolation.test.ts` (7 tests): RED 7/7 failed (`simulated failure`, `PrismaClientUnknownRequestError` from an outbox INSERT trigger). With the savepoint disabled (try/catch only), 3 DB-level tests fail with Postgres `25P02 current transaction is aborted`.
- **Root cause**: a failed statement aborts the whole Postgres transaction; no isolation around notification writes.
- **Change**: `enqueueNotificationSafely` (`notificationIsolation.ts`) wraps each enqueue in `SAVEPOINT`/`ROLLBACK TO`/`RELEASE` inside a transaction (plain try/catch on a top-level client) and logs `{ err, orderId, notification }`. Wrapped: approveOrder's two enqueues, settlePaidOrder AUTO (2) and MANUAL (4) enqueues, and `enqueueOrderTransitionEmails` in `transitionOrderStatus`. Money, stock, status and ledger writes, `finalizeDeliverySideEffects` and fulfilment-message writes are not wrapped. Fix wave: the original error is now logged before `ROLLBACK TO` so it survives a rollback failure.
- **Tests**: 7 isolation tests (assert status, paidAt, PAID, stock SOLD, history row, `order:{id}:payment` ledger posting), `notificationIsolation.test.ts` (2). Regression 364/364 and payment rails 607/607 (as reported); `pnpm test:guards` 198/198.
- **Compatibility/Rollback**: a failed notification is now silently dropped apart from a pino error ("Could not queue the ... notification"); ops should alert on it. Two extra round trips per wrapped enqueue. Revert 393e1d57 (and e123731b for the log-order tweak); no schema change.
- **Status**: fixed for the listed sites; other enqueue sites remain unisolated (see "Proposed" below).

### [P1] A6 Wallet checkout debited the live price, not the quoted one
- **Evidence**: `createOrderDirect` (`orders.ts` ~1086) and `createOrderFromCart` (~765) re-price from the live denomination; `wallet_checkout.ts` debits at once.
- **Impact**: a price change between preview and click charged the new price (preview Rp40.000, admin raised to Rp45.000, debit Rp45.000, 201).
- **Reproduction**: `checkout-quote-dedupe.test.ts` RED: wallet_idr price changed gave 201 not 409; wallet_usdt stale quote 201 not 409; unreadable `expected_total` 201 not 400; cart wallet 201 not 409; header path 201 not 409.
- **Root cause**: no client-supplied quote to bind against.
- **Change**: optional `expected_total` on `POST /api/v1/checkout` and `POST /api/v1/topup/order` for wallet methods; `assertQuotedTotal` runs before insert, stock and debit; Decimal value comparison; USDT compared against `usdtFromIdr(total, rate)`. 409 `error.quote_changed` with `currency`, `expected_total`, `current_total` (`checkout.ts:1024`). Canonical wire format only (400 otherwise).
- **Tests**: `quote_binding.test.ts` (5), part of `checkout-quote-dedupe.test.ts` (18 total with A7); affected suites 269/269 after A6.
- **Compatibility/Rollback**: backward compatible (absent field = no check; idempotency hash unchanged). The SPA does not send the field yet. Revert ca8f9396.
- **Status**: fixed (server side; SPA adoption pending, see 05).

### [P1] A7 Keyless double submit created two orders or two charges
- **Evidence**: `apps/storefront/src/routes/apiTopup.ts` (~344) deduped only with an `Idempotency-Key`; `checkout.ts` (~784, ~914) never passed `checkoutIntentId`; `apiWalletTopup.ts` had no pending-top-up guard.
- **Impact**: two concurrent keyless `wallet_idr` submits produced two orders and two debits; gateway method produced two pending orders; two wallet top-up posts produced two top-ups.
- **Reproduction**: RED in `checkout-quote-dedupe.test.ts`: keyless wallet_idr gave two different order codes, keyless gateway two orders, wallet top-up two top-ups. The cart concurrent test passed at RED (verified-no-change: `lockCartForCheckout` serializes it).
- **Root cause**: dedupe depended on a client-supplied header.
- **Change**: `KEYLESS_DEDUPE_WINDOW_MS = 10_000`, `deriveKeylessIdempotencyKey`, optional `replayWindowMs` on `claimIdempotentRequest` (compare-and-swap re-claim of an expired completed row). Signed-in keyless requests on `/topup/order` use ledger endpoint `storefront.topup.order.create.keyless`; only 2xx stored. Guests deliberately not deduped. `createOrReuseWalletTopupOrder` locks the user row and reuses an equivalent pending top-up within the window.
- **Tests**: `idempotency.test.ts` (+4), `checkout-quote-dedupe.test.ts`; post-A7 `idempotency + checkout-quote-dedupe` 38/38; wider set 140/140. Two existing tests that pinned the defect were rewritten (`topup-order-api.test.ts`, `wallet-topup-api.test.ts`).
- **Compatibility/Rollback**: header clients unchanged. Inside 10 s an identical signed-in keyless purchase or identical wallet top-up folds into the first. No schema change. Revert 4bcbd71c.
- **Status**: fixed. Follow-ups: keyless window starts at claim not completion; no concurrent USDT wallet top-up test; keyless guests can still double-create pending gateway orders (no money moves); `idempotency_records` has no retention job (pre-existing).

### [P1] A8 Voucher/summary oracle throttled only for anonymous callers
- **Evidence**: `apps/storefront/src/routes/apiCheckout.ts` GET `/checkout` (~62) and POST `/checkout/voucher/preview` (~85).
- **Impact**: a registered account could probe voucher codes without limit.
- **Reproduction**: RED: signed-in user expected 429, got 200.
- **Root cause**: only the anonymous quota existed.
- **Change**: `checkoutPreviewAuthedRateLimited(userId, ip)` in storefront `rateLimit.ts`: 60/min per user, 240/min per IP, separate maps; used by both routes.
- **Tests**: `guest-checkout-api.test.ts` 21/21.
- **Compatibility/Rollback**: new 429 for heavy authenticated callers. Revert 62e472eb.
- **Status**: fixed.

### [P1] A9 Legacy ticket creation race
- **Evidence**: `apps/storefront/src/routes/apiAccount.ts` (~531, ~654) called `getOpenTicketForOrder` outside a transaction and without `dedupeOrder`.
- **Impact**: concurrent creates yielded duplicate tickets per order.
- **Reproduction**: RED: 2 and 3 tickets for one order on both legacy and `/new` routes.
- **Root cause**: no order-row lock on the legacy path.
- **Change**: both routes pass `dedupeOrder` to `createTicket` (V2 order-row lock). Fix wave: `createTicket` returns `SupportTicket & { reused?: true }` set only when an existing ticket is returned; the `createdAt < startedAt` timestamp heuristic was removed and the routes use `ticket.reused`.
- **Tests**: `support-api.test.ts` 24/24 then 27/27; `support.test.ts` "reused" (new ticket has no flag, reused has; RED = flag did not exist); spa-api duplicate test still green.
- **Compatibility/Rollback**: loser gets `{ ok:false, duplicate:true, ticket_id }`. Callers supportV2/bot unaffected. Revert 34baeb36 and e123731b.
- **Status**: fixed.

### [P2] B8 Bad path ids and unbounded page produced 500
- **Evidence**: `Number(req.params.id)` in `apiAccount.ts` (~679, 718, 789, 802, 819), `emailNotifications.ts` (~39, 44), `orderDigiflazzStream.ts` (~38), `catalogPhoto.ts` (~29); unbounded `page` (`apiAccount.ts` ~470, admin `Number(q.page) || 1`).
- **Impact**: Prisma errors surfaced as HTTP 500.
- **Reproduction**: RED: admin id `99999999999` and `page=1e999` gave 500 on 9 list routes and 3 id routes; storefront bad ids and `page=1e999` gave 500. (`page=99999999999999` alone did not 500.)
- **Root cause**: no shared positive-id parser.
- **Change**: shared `parsePositiveId`, `parseQueryInt`, new `parsePageParam` (clamp 1..100000) in `@app/core/params`; `apps/web-admin/src/lib/params.ts` re-exports. Applied to 12 admin list routes, the three admin id routes and storefront ticket/restock ids and `page`. Bad ids become 404 (400 where the route already used 400).
- **Tests**: route-id-params 87/87, support-api 27/27.
- **Compatibility/Rollback**: restock keeps its "unavailable" 200 shape. Revert 525e8b42.
- **Status**: fixed (admin `Number(id)` in `catalog.ts`/`digiflazzSync.ts` untouched; `page_size` already clamped 1..50 by `listUserTicketsPaged`).

### [P2] B10 Readonly admins could fetch support media
- **Evidence**: `apps/web-admin/src/routes/api/supportMedia.ts` ignored the readonly role while `/uploads/tickets/*` blocked it.
- **Impact**: inconsistent access control on ticket attachments.
- **Reproduction**: RED: readonly got 404 (reached lookup), expected 403.
- **Root cause**: missing role gate.
- **Change**: route uses `blockReadonlyReads` (403).
- **Tests**: route-id-params green.
- **Compatibility/Rollback**: readonly admins now get 403 here (while `/uploads/tickets` returns 404). Revert c323cd92.
- **Status**: fixed.

### [P2] B13 Unbounded downloads
- **Evidence**: admin photo proxy (`apps/web-admin/src/routes/api/support.ts` ~753) and bot `downloadTgText` (`apps/order-bot/src/conversations/admin.ts` ~104).
- **Impact**: a large upstream body could exhaust memory.
- **Reproduction**: RED: proxy returned 200 for an oversize body; bot buffered unbounded (bot RED by inspection of the old `res.text()`, no swap-back run).
- **Root cause**: no size limit.
- **Change**: `readBodyWithLimit` (`packages/core/src/boundedBody.ts`: Content-Length precheck plus streaming cut-off). Photo proxy 20 MB cap with 413; bot text 1 MB cap returning null (existing `admin.stock_err_too_large` message). Fix wave: `upstream.body?.cancel()` on `!ok` and 415 returns.
- **Tests**: boundedBody 5/5, photo tests 9/9, bot 3/3.
- **Compatibility/Rollback**: only oversize inputs change. Revert c73684c2 and e123731b.
- **Status**: fixed.

### [P2] B1 Disabled email events stored as FAILED
- **Evidence**: `packages/db/src/crud/emailEvents.ts:44-45`, `packages/outbox-dispatcher/src/dispatcher.ts:846-847`, `markNotificationFailed` (`notifications.ts:1231`) stored `lastError` `SKIPPED_DISABLED`/`SKIPPED_NO_RECIPIENT` as FAILED.
- **Impact**: inflated FAILED counts, rows offered for retry, and the `dedupeKey` blocked re-enqueue after the owner re-enabled the event.
- **Reproduction**: RED: ownerEmail (2), notifications retry + `markNotificationSkipped` (2), storageMaintenance prune, emailEvents (24), dispatcher (10) tests.
- **Root cause**: no real skipped state.
- **Change**: `NotificationStatus.SKIPPED` (terminal, non-failure, non-retryable; no DDL). Enqueue-time skips store `dedupeKey = <factKey>:skipped`; dispatch-time skips release the key (`markNotificationSkipped(..., releaseDedupeKey: true)`). `pruneSentOutbox` prunes SKIPPED; admin `/api/outbox` filter and `counts` include SKIPPED (shape unchanged), `deliveryOutcome` reports "skipped".
- **Tests**: db notifications/ownerEmail/emailEvents/storageMaintenance/settlePaidOrder/support, outbox-dispatcher (371 tests), web-admin outbox/metrics/route-id tests. Tests that encoded the old FAILED/SENT behaviour were updated deliberately.
- **Compatibility/Rollback**: legacy FAILED rows with `SKIPPED_*` stay as they are (still pruned as FAILED); admin UI status dropdown not updated. Revert 31d7bd08.
- **Status**: fixed.

### [P2] B2 Intentional dedupe drops recorded as SENT
- **Evidence**: `dispatcher.ts:349-366` and `:544-551`.
- **Impact**: SENT counts and history overstated real deliveries.
- **Reproduction**: dispatcher tests (part of the 10 RED).
- **Root cause**: no SKIPPED status.
- **Change**: dedupe drops are SKIPPED with reasons `ALREADY_COVERED_BY_TRACKED_MESSAGE` / `CREDENTIALS_ALREADY_DELIVERED`, no `sentAt`; Telegram sends unchanged.
- **Tests**: dispatcher tests.
- **Compatibility/Rollback**: revert 31d7bd08.
- **Status**: fixed.

### [P2] B3 Global SMTP misconfiguration failed every queued email terminally
- **Evidence**: `packages/core/src/mailer.ts:46-49`, `dispatcher.ts:929` versus the unconfigured path at `:898-903`.
- **Impact**: an auth/TLS misconfiguration dead-lettered the whole queue.
- **Reproduction**: dispatcher tests (RED set).
- **Root cause**: SMTP_AUTH/SMTP_TLS treated like per-recipient permanent errors.
- **Change**: SMTP_AUTH/SMTP_TLS release the claim with backoff (`lastError` keeps the category); after the first in a tick, remaining email rows of that tick are released without `sendMail` (`smtpBlocked` flag local to `drainBatch`). SMTP_RECIPIENT/SMTP_REJECTED stay terminal. Fix wave added tests that those do not block following rows and that the flag resets next tick (characterization tests, no source change).
- **Tests**: dispatcher tests incl. "3 rows, one sendMail call, all PENDING with future nextRetryAt".
- **Compatibility/Rollback**: each backed-off try counts an attempt but never goes terminal; attempts can grow in a long outage and the first transient failure afterwards dead-letters (same as the unconfigured path). Revert a138517a / 31d7bd08.
- **Status**: fixed.

### [P2] B4 Retry accepted any status
- **Evidence**: `retryNotification` (`notifications.ts` ~1838) had no status filter for non-EMAIL rows.
- **Impact**: PENDING/SENDING/SENT rows could be requeued, risking duplicate sends.
- **Reproduction**: notifications retry tests (RED set); `outbox-reviews-api.test.ts` retry 409 tests (RED in review fix).
- **Root cause**: missing filter.
- **Change**: only FAILED/DEAD_LETTER may be requeued for every channel; the admin retry route returns 409 ("Only failed notifications may be retried.") for any existing non-eligible row, 404 only when missing.
- **Tests**: notifications.test.ts, outbox-reviews-api.test.ts. One existing test that used a backed-off PENDING row now uses a terminal row.
- **Compatibility/Rollback**: previously accepted retries of non-failed rows now give 409. Revert a138517a / 31d7bd08.
- **Status**: fixed.

### [P2] B5 Two sources of truth for owner-email enablement
- **Evidence**: `notifications.ts` (~710) `resolveOwnerEmailRecipient` gated on legacy `owner_email_*` settings while dispatch used `isEmailEventEnabled` (`emailPolicy.ts:20-21`).
- **Impact**: an event could be enqueued but skipped, or the reverse.
- **Reproduction**: ownerEmail tests (2 RED).
- **Root cause**: duplicated policy.
- **Change**: `resolveOwnerEmailRecipient` asks `isEmailEventEnabled` with each owner event's canonical policy key; defaults unchanged (explicit `email_event_enabled:*` wins, else legacy master + per-event toggles). `emailPolicy.enabled` is now trim/case-insensitive.
- **Tests**: ownerEmail.test.ts, emailEvents.test.ts.
- **Compatibility/Rollback**: a legacy "TRUE" keeps working; dispatch parsing is slightly widened. Revert 31d7bd08.
- **Status**: fixed.

### [P2] B7 Telegram sends without per-call timeout
- **Evidence**: `dispatcher.ts` (~771); `STALE_CLAIM_MS` is 5 min.
- **Impact**: a hung send could outlive the claim and be re-claimed by another tick.
- **Reproduction**: dispatcher tests (RED set), plus the support-limit test in the review round.
- **Root cause**: no timeout.
- **Change**: all dispatcher sends go through `trySend` wrapped by `withTimeout` (60 s; support-reply/media step `SUPPORT_REPLY_SEND_TIMEOUT_MS` = 4 min, below 5 min). Timeout is a retryable failure. Test hook `setTelegramSendTimeoutMsForTests`. The fulfilment-message worker already had its own timeouts.
- **Tests**: dispatcher.test.ts (asserts the constant is above 120 s and below `STALE_CLAIM_MS`; a 300 ms support reply passes while the single limit is 50 ms).
- **Compatibility/Rollback**: a timed-out call may still deliver, so a retry can duplicate that message (accepted); the support-reply worst case (270 s) exceeds the 240 s limit slightly. Revert a138517a / 31d7bd08.
- **Status**: fixed.

### [P2] B6 Ticket-closed buyer DM missing from web, bulk and auto-close paths
- **Evidence**: `TICKET_CLOSED_DM` was only enqueued from the bot (`apps/order-bot/src/handlers/admin.ts:675`); web close (`apps/web-admin/src/routes/api/support.ts` ~428-438), bulk close (~684) and `autoCloseStaleTickets` (`apps/order-bot/src/jobs/index.ts` ~628-636, direct `api.sendMessage`, no retry) did not.
- **Impact**: buyers closed via web/auto-close got no notice, or one without retry.
- **Reproduction**: RED: 5 of 6 new `support.test.ts` tests failed (closeTicket, bulkCloseTickets, transitionTicketStatus -> CLOSED and auto_closed enqueued nothing).
- **Root cause**: notification lived only in one caller.
- **Change**: `closeTicket(db, id, {autoClosed?})` is the single close helper (own `$transaction` or joins a tx) and enqueues one `TICKET_CLOSED_DM` only when it flipped the ticket and the buyer has a `telegramId`; key `ticket-closed:<ticketId>:<closedAt ms>`. `enqueueTicketClosedDm` gained `dedupeKey` (raw `INSERT ... ON CONFLICT DO NOTHING`, `orderId` NULL) and `autoClosed`. The bot dropped its own post-hoc enqueue; `autoCloseStaleTickets` dropped the direct send. The dispatcher template renders the existing `ticket.auto_closed` wording for `auto_closed:true`; the plain path is byte-identical.
- **Tests**: support.test.ts, notifications.test.ts, templates.test.ts 314 passed; jobs.test.ts autoClose 2; handlers.test.ts "ticket close" 3; dispatcher TICKET_CLOSED 13; web-admin users-vouchers-support-audit-api 114.
- **Compatibility/Rollback**: auto-close buyers now get the message via the outbox tick (slight delay, but retried); bulk close runs one transaction per ticket. Revert c11e69a0 (and b8017e54 only affects tracking of a scratch file).
- **Status**: fixed (minors: `_api` parameter unused in `autoCloseStaleTickets`, kept because jobs.test.ts and the wrapper call it with `api`; a malformed `auto_closed` payload renders `#undefined`).

## Proposed or not implemented (approval-gated)

### [P1] A4 UNDERPAID/FAILED orders hold stock, vouchers and wallet with no expiry
- **Evidence**: the expiry sweep (`listExpiredPendingOrders`, `apps/order-bot/src/jobs/index.ts` `autoCancelExpiredOrders`) selects PENDING_PAYMENT only; UNDERPAID and FAILED orders were never resolved.
- **Impact**: stock, voucher use and spent wallet credit stayed reserved indefinitely.
- **Change**: new `packages/db/src/crud/underpaidExpiry.ts` and an order-bot job every 10 minutes. An UNDERPAID product order older than the Setting `underpaid_auto_resolve_hours` is resolved under the order row lock through the existing `refundUnderpaidOrderTx`: the received amount is credited once in the order currency, all holds are released, the order becomes REFUNDED, audited as a system action. **Default is "0" (off)** so a deploy never refunds the existing backlog; the owner turns it on through the admin settings API (keys added to `routes/api/settings.ts`). Wallet top-ups, orders with no recorded received amount, anything handed to Digiflazz and orders marked paid are left to an admin with one alert. FAILED orders are never changed (they are usually fully paid; the only writer runs after a confirmed Bybit deposit); after `failed_order_alert_hours` (default 24) admins get one alert. `refundUnderpaidOrderTx` also had a bug: an admin refund left stock RESERVED and never returned `walletUsed`; it now locks the order and releases all holds.
- **Tests**: `underpaidExpiry.test.ts`, `aged-orders-job.test.ts`, `settings-aged-orders.test.ts`, updated `binance_internal.test.ts` and `payments-refund-idempotency.test.ts`.
- **Compatibility/Rollback**: setting "0" disables the sweep; no schema change. Admin "refund to wallet" now also returns `walletUsed` and frees stock.
- **Status**: fixed (default off). Commits 330e5d3d, 42a561b3. Follow-ups: batch starvation on orders that keep erroring, re-alert after outbox pruning, one-off repair of refunds made before this change, `creditOrderToBalance` credits full `totalAmount` for UNDERPAID, the admin "underpaid cancel" route (`payments.ts` ~483) cancels without crediting the amount paid, TokoPay refunds include the buyer-paid fee.

### [P1] A5 Digiflazz 24 h Pending treated as definite failure
- **Evidence**: `recordDigiflazzOutcome` (`packages/db/src/crud/digiflazz.ts`) sent an exhausted 24 h window to `terminalFailDigiflazzOrder`, setting `digiflazzStatus = "failed"`, which unlocks credit, refund and manual fulfilment while the supplier can still deliver.
- **Change**: a Pending or transient-exhausted order now becomes `unresolved_at_supplier` (free String column, no schema change). It stays locked everywhere `digiflazzStatus !== "failed"` is read, is rechecked every 6 h for up to 7 days, a late Sukses delivers it and a late Gagal fails it through the normal paths, admins get one alert on entry and a daily reminder after 7 days. The only human exit is the new audited `markDigiflazzOrderFailedByAdmin` (`POST /api/orders/:id/digiflazz/mark-failed`). A recheck of an already submitted order no longer fails it for missing credentials or a missing/unbuildable SKU or customer number (treated as transient); a fresh dispatch is unchanged.
- **Tests**: `digiflazzUnresolved.test.ts` (new), `digiflazz.test.ts`, `digiflazzBackoff.test.ts`, `digiflazz-webhook.test.ts`, `order-eligibility-digiflazz.test.ts`, `orderFulfillment.test.ts`.
- **Compatibility/Rollback**: revert commits bb44592b and 76dce158. Orders the old code already failed with "never resolved within 24h" stay `failed` and unlocked; admins should reconcile them (query `digiflazzFailureDetail`).
- **Status**: fixed. Follow-ups: admin UI (badge, "mark failed" button, error message keys `error.digiflazz_*` in `errorMessages.ts`), the reused alert heading still says "tracking failed", the override sends the same failure emails as a supplier Gagal, a CANCELLED dispatched unresolved order cannot be overridden.

### [P2] Other proposed items (not changed)
- **Evidence**: lockout-DoS and login timing leak in admin auth; TOTP replay and secret encryption; no DB CHECK constraints (wallet balance >= 0, status enums); CI disabled (`ci.yml:10`); `/setup/bot` pre-auth token overwrite; enqueues still unisolated in `finalizeDeliverySideEffects`, `cancelOrder`, `fulfillManualOrder` and wallet top-up settlement; poller `credited=0` leaves a deposit `matched` with no alert; a paid-after-expiry product order only alerts the admin; `settleWalletTopup` credits `order.totalAmount` regardless of the reported amount; outbox index `(status, next_retry_at)` and a redundant index (P3).
- **Impact**: see `05-remaining-risks-and-next-steps.md` for each.
- **Reproduction**: none recorded in this pass.
- **Root cause**: see 05.
- **Change**: none.
- **Tests**: none.
- **Compatibility/Rollback**: each needs an owner decision, a schema/data change, billing, or a measurement first.
- **Status**: proposed (indexes: not measured, so not changed).

## Verified-no-change
### [P3] Cart checkout double submit
- **Evidence**: `POST /api/v1/checkout` with `lockCartForCheckout`.
- **Impact**: none; the loser gets 400 `error.cart_empty`, one order, one debit.
- **Reproduction**: the new concurrent test passed at RED.
- **Root cause**: n/a.
- **Change**: none; a route-level test pins the behavior.
- **Tests**: `checkout-quote-dedupe.test.ts`.
- **Compatibility/Rollback**: n/a.
- **Status**: verified-no-change.
