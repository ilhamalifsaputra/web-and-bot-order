# 02 - Business invariants (as implemented)

## Order state machine
- Source of truth: `LEGAL_TRANSITIONS` in `packages/db/src/crud/orderStatus.ts:38`. `transitionOrderStatus` (from `:146`) checks the edge at `:171`, claims the row atomically with `updateMany` on the expected `from` status, and writes an `OrderStatusHistory` row.
- Added in this pass (Task 2), all restricted to `kind = WALLET_TOPUP` through `WALLET_TOPUP_ONLY_TRANSITIONS` (`orderStatus.ts:137`; kind added to the claim at `:179`):
  - `PAYMENT_DETECTED`, `PAYMENT_CONFIRMING`, `PAYMENT_CONFIRMED` -> `PENDING_PAYMENT` (Bybit BSC top-up normalization before settlement).
  - `CANCELLED` -> `DELIVERED` (deliberate late credit of a top-up whose payment arrived after cancel; `isLateSettleableWalletTopup`).
- On a product order these edges fail as `illegal_status_transition` and write nothing. `CANCELLED` is no longer an empty list, so the old "CANCELLED is terminal" test now covers REJECTED/REFUNDED only.
- `PENDING_PAYMENT` -> `DELIVERED` (on-time top-up claim) is still not declared in `LEGAL_TRANSITIONS`; a history row is now written for it, but the edge was left undeclared (Task 2 concern 3).
- Bybit BSC normalization (`normalizeTopupToPendingPayment`, `bybit_bsc_deposit.ts`) is a compare-and-swap through `tryTransitionOrderStatus`; on a lost CAS it re-reads and retries only while the order is still in an on-chain milestone, otherwise leaves the order alone.

## Settlement and idempotency
- Settlement credits the order amount once. The wallet ledger has a unique key on (`order_id`, `reason`); before the A2 fix a rewound DELIVERED order was only stopped from double credit by that key raising `P2002` (Task 2 RED).
- `settleWalletTopup` claims PENDING_PAYMENT then CANCELLED with two `updateMany` calls (same status set as the old `IN (...)` claim), so the same orders are credited with the same amount (`order.totalAmount`). It writes one DELIVERED history row with meta `wallet_topup_credited` or `wallet_topup_late_credit`; a repeat settlement is a no-op and writes nothing.
- Header idempotency: `claimIdempotentRequest` (`packages/db/src/crud/idempotency.ts`) replays a completed row forever for header callers. Unchanged.

## Wallet debit and quote binding
- Wallet rails (`wallet_checkout.ts`) debit immediately via `adjustWallet`, which locks the user row.
- Quote binding (A6): optional `expected_total` on `POST /api/v1/checkout` and `POST /api/v1/topup/order` for `wallet_idr`/`wallet_usdt` only. `assertQuotedTotal` (`orders.ts`) runs right after the total is computed and before the order insert, stock reservation, voucher bump and debit. Comparison is `Decimal.equals`; for USDT the expected value is `usdtFromIdr(total, rate)` with the rail's rate. Mismatch: HTTP 409 `error.quote_changed` with `currency`, `expected_total`, `current_total` (`apps/storefront/src/routes/checkout.ts:1024`). Absent field means no check and an unchanged idempotency hash. Non-canonical values give 400 `invalid_request` (read via `readCanonicalMoney`).

## Keyless dedupe window
- `KEYLESS_DEDUPE_WINDOW_MS = 10_000` (`idempotency.ts:94`). A signed-in request without `Idempotency-Key` on `/topup/order` is claimed under `keyless:<sha256>` of the same content the header path hashes (including userId), ledger endpoint `storefront.topup.order.create.keyless`. Only 2xx responses are stored. A completed row older than the window is re-claimed by compare-and-swap (`replayWindowMs`).
- Guests are deliberately not deduplicated (a derived key could replay another person's order code, a /track credential; guests cannot pay from balance).
- Cart `POST /api/v1/checkout` was verified-no-change: `lockCartForCheckout` already serializes it.
- Wallet top-up creation (`createOrReuseWalletTopupOrder`, `wallet_topup.ts`): locks the user row, reuses a PENDING_PAYMENT top-up with the same user, amount (by value), currency and rail, not past `expiresAt`, created within 10 s.

## Notification outbox
- Statuses: PENDING, SENDING, SENT, FAILED, DEAD_LETTER and the new SKIPPED (`packages/core/src/enums.ts:843`). `NotificationOutbox.status` is a free string, so no DDL.
- SKIPPED is terminal, not a failure, not retryable. Used for disabled email events, no recipient, dispatch-time disable, and intentional dedupe drops (reasons `ALREADY_COVERED_BY_TRACKED_MESSAGE`, `CREDENTIALS_ALREADY_DELIVERED`). Metrics count only FAILED/DEAD_LETTER as failures; `pruneSentOutbox` prunes SKIPPED.
- Dedupe rule: an enqueue-time skipped row stores `dedupeKey = <factKey>:skipped`, so it never holds the real slot (repeats still collapse, and re-enabling the event lets the fact enqueue). A row skipped at dispatch because the event was switched off gets `dedupeKey = null`. A skip that is itself a dedupe keeps its key.
- Retry: only FAILED/DEAD_LETTER may be requeued, for every channel; the admin route returns 409 for other existing rows and 404 for missing.
- Global SMTP failures (SMTP_AUTH, SMTP_TLS) release the claim with backoff, and after the first in a tick the remaining email rows of that tick are released without calling `sendMail`. SMTP_RECIPIENT and SMTP_REJECTED stay terminal per row.
- Dispatcher Telegram sends are wrapped in `withTimeout` (60 s single message, 4 min `SUPPORT_REPLY_SEND_TIMEOUT_MS` for support replies), both below `STALE_CLAIM_MS` (5 min). A timed-out send may still deliver, so a retry can duplicate (accepted).
- Owner-email enqueue asks `isEmailEventEnabled`, the same decision the dispatcher uses; defaults unchanged.
- Notification isolation (A3): `enqueueNotificationSafely` (`packages/db/src/crud/notificationIsolation.ts`) wraps each enqueue in `SAVEPOINT notification_enqueue` inside a transaction; on error it rolls back to the savepoint, logs and continues. A failed notification is dropped with only a log line; a paid order is never rolled back by it.

## Ticket-closed notification rule
- `closeTicket(db, id, {autoClosed?})` (`packages/db/src/crud/support.ts`) is the shared close path (web close, bulk close, bot close, auto-close; `transitionTicketStatus` to CLOSED uses the same internal helper). It enqueues one `TICKET_CLOSED_DM` only when this call flipped the ticket, and only for a buyer with a `telegramId`. Dedupe key `ticket-closed:<ticketId>:<closedAt ms>`, so reopen-then-close notifies again and re-closing does not duplicate. Payload `auto_closed:true` renders the existing `ticket.auto_closed` wording; no direct `api.sendMessage` remains in auto-close.
- Ticket creation: `createTicket` takes the order-row lock via `dedupeOrder`; both legacy storefront create routes pass it. It returns `reused: true` only when an existing ticket is returned (order dedupe or requestKey replay).

## Stock allocation
- No stock-allocation logic was changed. Task 3 settlement tests assert stock goes to SOLD and items to QUEUED as before. The wallet quote check runs before stock reservation, so a 409 reserves nothing.

## Input and access invariants added
- Path ids and `page` are parsed with `parsePositiveId`/`parsePageParam` (`@app/core/params`, page clamped 1..100000); bad ids give 400/404, not 500.
- Admin `/api/support/media/:id/:filename` uses `blockReadonlyReads` (403 for readonly).
- Download caps: admin photo proxy 20 MB (`MAX_SUPPORT_PHOTO_BYTES`, `apps/web-admin/src/routes/api/support.ts:47`, 413), bot text download 1 MB, via `readBodyWithLimit` (`packages/core/src/boundedBody.ts`).
- First-run setup: owner Telegram ID must be in `config.ADMIN_IDS`; setup routes share a per-IP limiter (20 per 600 s, 429); `/setup/shop` needs the step-2 nonce cookie (sha256 stored in Setting `setup_owner_nonce_hash`).

## Owner decisions still open and untouched
Settlement double-submit, `/track` second factor, and support-role refund were not changed in this pass.
