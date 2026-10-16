# 03 - Implementation log

Chronological, from `git log --reverse master..HEAD` on `worktree-backend-audit-2` (base 7d92dcfa). All changes are code-only; no schema change.

| # | Commit | Subject |
|---|---|---|
| 1 | 060c0d36 | fix(web-admin): require ADMIN_IDS and rate-limit first-run setup, bound login limiters, warn on weak production config |
| 2 | 43241baf | fix(web-admin): bind setup finish step to the owner step browser and rate-limit it |
| 3 | 64fdeec2 | fix(db): route top-up status rewinds and late credits through the order state machine |
| 4 | 393e1d57 | fix(db): isolate notification enqueues so they never roll back a paid order |
| 5 | ca8f9396 | fix(storefront): bind wallet checkout to the quoted total with optional expected_total |
| 6 | 4bcbd71c | fix(storefront): deduplicate keyless instant-buy submits and reuse pending wallet top-ups |
| 7 | 62e472eb | fix(storefront): throttle signed-in checkout summary and voucher preview per user and IP |
| 8 | 34baeb36 | fix(storefront): serialize legacy ticket creation per order with the V2 order lock |
| 9 | 525e8b42 | fix(web): validate path ids and clamp page numbers instead of letting Prisma 500 |
| 10 | c323cd92 | fix(web-admin): refuse readonly admins on the support media redirect like /uploads/tickets |
| 11 | c73684c2 | fix: cap Telegram download sizes in the admin photo proxy and bot stock upload |
| 12 | 31d7bd08 | fix(outbox): add a real SKIPPED status, back off on global SMTP errors, bound Telegram sends, guard retry |
| 13 | a138517a | fix(outbox): per-event send limit for support replies, 409 on ineligible retry, back off after global SMTP failure |
| 14 | c11e69a0 | fix(support): enqueue the buyer's ticket-closed DM from every close path, deduped per close |
| 15 | b8017e54 | chore: stop tracking SDD scratch report |
| 16 | e123731b | fix: explicit reused-ticket signal, log enqueue error before rollback, cancel unused photo bodies, add review-minor tests |

## 1. 060c0d36 - setup hardening (A1, B9, B12)
- Reason: pre-auth first-run setup could be taken by any visitor; login limiter maps were unbounded; no warning for weak production config.
- Files/functions: `apps/web-admin/src/routes/setup.ts` (`/setup/owner` ADMIN_IDS check, shared `setupRateLimited`, 20 per 600 s), `apps/web-admin/src/auth.ts` (`MAX_LOGIN_LIMITER_BUCKETS`, sweep, `loginLimiterSizes`, `resetSetupRateLimit`), `packages/core/src/startupWarnings.ts` (`collectProductionWarnings`, exported as `@app/core/startupWarnings`, called from web-admin `buildApp` in `src/server.ts`), `apps/web-admin/test/login-limiter-cap.test.ts`, `web.test.ts`.
- Regressions prevented: owner takeover by a non-allow-listed Telegram ID; setup brute force; limiter memory growth.

## 2. 43241baf - bind finish step (A1 review round)
- Reason: `/setup/shop` could mint a session without proof of having done step 2.
- Files/functions: `setup.ts` (nonce cookie, sha256 in Setting `setup_owner_nonce_hash`, constant-time compare, shared limiter on `/setup/shop`, nonce replaced on step-2 retry, deleted on finish), `web.test.ts`.
- Regressions prevented: session minting by a different browser than the owner step.

## 3. 64fdeec2 - state machine bypasses (A2, B11)
- Reason: blind status UPDATE from a stale read; late credit had no history and an undeclared edge.
- Files/functions: `packages/db/src/crud/bybit_bsc_deposit.ts` (`normalizeTopupToPendingPayment`), `orderStatus.ts` (new edges, `WALLET_TOPUP_ONLY_TRANSITIONS`, kind added to the claim), `wallet_topup.ts` (`settleWalletTopup` two-step claim plus history row), `_manualQrisClaim.ts` comment, `docs/arsitektur/ORDER_STATE_MACHINE.md`; tests in `bybit_bsc_deposit.test.ts`, `wallet_topup.test.ts`, `orderStatus.test.ts`.
- Regressions prevented: resurrecting a cancelled order, rewinding a delivered top-up into a re-credit attempt, silent late credits, top-up-only edges leaking to product orders.

## 4. 393e1d57 - notification isolation (A3)
- Reason: notification enqueue failures rolled back paid orders.
- Files/functions: new `packages/db/src/crud/notificationIsolation.ts` (`enqueueNotificationSafely`, SAVEPOINT based); wrapped call sites in `orders.ts` (`approveOrder`, `settlePaidOrder` AUTO and MANUAL) and `orderStatus.ts` (`transitionOrderStatus`); new `settlePaidOrderNotifyIsolation.test.ts` (7 tests).
- Regressions prevented: a paid order un-paid by an email/DM enqueue error, including DB-level errors (`25P02`).

## 5. ca8f9396 - quote binding (A6)
- Reason: wallet checkout debited the live price.
- Files/functions: `orders.ts` (`ExpectedTotal`, `QuoteMismatchError`, `assertQuotedTotal`; `createOrderFromCart`, `createOrderDirect` take `expectedTotal`, `afterDiscount` computed earlier), `wallet_checkout.ts` (`walletExpectedTotal`), storefront `checkout.ts`, `api.ts`, `apiTopup.ts`; tests `quote_binding.test.ts`, `checkout-quote-dedupe.test.ts`.
- Regressions prevented: silent price-change debit; header path and idempotency hash unchanged.

## 6. 4bcbd71c - keyless dedupe (A7)
- Reason: double tap without a header created two orders/charges/top-ups.
- Files/functions: `idempotency.ts` (`KEYLESS_DEDUPE_WINDOW_MS`, `deriveKeylessIdempotencyKey`, `replayWindowMs`), `apiTopup.ts`, `wallet_topup.ts` (`createOrReuseWalletTopupOrder`), `apiWalletTopup.ts`; tests in `idempotency.test.ts`, `checkout-quote-dedupe.test.ts`, rewritten `topup-order-api.test.ts` and `wallet-topup-api.test.ts` cases.
- Regressions prevented: duplicate charge on double tap; header clients unaffected.

## 7. 62e472eb - authenticated checkout throttle (A8)
- Files/functions: storefront `rateLimit.ts` (`checkoutPreviewAuthedRateLimited`), `apiCheckout.ts`; `guest-checkout-api.test.ts`.
- Regressions prevented: voucher-code probing by registered accounts.

## 8. 34baeb36 - legacy ticket race (A9)
- Files/functions: `apiAccount.ts` (both create routes pass `dedupeOrder`), `support-api.test.ts`.
- Regressions prevented: duplicate open tickets per order.

## 9. 525e8b42 - id and page validation (B8)
- Files/functions: `packages/core` params (`parsePositiveId`, `parseQueryInt`, `parsePageParam`), `apps/web-admin/src/lib/params.ts` re-export, 12 admin list routes, `emailNotifications.ts`, `orderDigiflazzStream.ts`, `catalogPhoto.ts`, storefront `apiAccount.ts`; `route-id-params` and `support-api` tests.
- Regressions prevented: 500 responses on malformed ids and `page=1e999`.

## 10. c323cd92 - readonly media (B10)
- Files/functions: `apps/web-admin/src/routes/api/supportMedia.ts` uses `blockReadonlyReads`.
- Regressions prevented: readonly admins reading ticket attachments via the redirect route.

## 11. c73684c2 - download caps (B13)
- Files/functions: `packages/core/src/boundedBody.ts` (`readBodyWithLimit`), admin photo proxy in `api/support.ts` (20 MB, 413), bot `downloadTgText` in `conversations/admin.ts` (1 MB); tests `boundedBody`, photo, bot.
- Regressions prevented: unbounded memory use on oversized bodies.

## 12. 31d7bd08 - outbox semantics (B1, B2, B3, B4, B5, B7)
- Files/functions: `packages/core/src/enums.ts` (`NotificationStatus.SKIPPED`), `emailEvents.ts` (`enqueueEmailEvent` skipped rows with `:skipped` key), `notifications.ts` (`markNotificationSkipped`, `retryNotification` status filter, `resolveOwnerEmailRecipient` via `isEmailEventEnabled`), `emailPolicy.ts` (trim/case-insensitive), `pruneSentOutbox`, admin outbox API (`STATUS_VALUES`, `deliveryOutcome`), `packages/outbox-dispatcher/src/dispatcher.ts` (SKIPPED for dedupe drops, SMTP_AUTH/TLS backoff, `trySend` with `withTimeout`, `setTelegramSendTimeoutMsForTests`).
- Regressions prevented: inflated FAILED counts, retry of live rows, permanent dedupe slot after re-enabling an event, mass dead-lettering on SMTP misconfiguration, hung Telegram sends outliving the claim.

## 13. a138517a - outbox review fixes
- Files/functions: `dispatcher.ts` (`SUPPORT_REPLY_SEND_TIMEOUT_MS` 4 min, `smtpBlocked` flag in `drainBatch`), admin retry route (409 for ineligible existing rows), `ownerEmail.ts` header comment; dispatcher and `outbox-reviews-api` tests.
- Regressions prevented: support replies timing out at 60 s; one `sendMail` call per queued row during a global SMTP outage; retry of PENDING/SENDING/SENT/SKIPPED rows.

## 14. c11e69a0 - ticket-closed DM (B6)
- Files/functions: `support.ts` (`closeTicket` shared helper, `transitionTicketStatus`), `notifications.ts` (`enqueueTicketClosedDm` with `dedupeKey` and `autoClosed`), web close/bulk close, bot `closeTicketAdmin`, `autoCloseStaleTickets` (direct send removed), dispatcher template for `auto_closed`; tests in `support`, `notifications`, `templates`, `jobs`, `handlers`, dispatcher.
- Regressions prevented: missing or duplicate close notices; non-retried direct sends.

## 15. b8017e54 - housekeeping
- Stopped tracking a scratch report file under the SDD directory. No source change.

## 16. e123731b - fix wave
- Files/functions: `createTicket` returns `reused?: true` (apiAccount routes use it; timestamp heuristic removed); `notificationIsolation.ts` logs the original error before `ROLLBACK TO` (new `notificationIsolation.test.ts`, 2 tests); photo proxy cancels the unused upstream body on `!ok` and 415; new characterization tests in `dispatcher.test.ts` (SMTP_RECIPIENT/SMTP_REJECTED do not block, flag resets per tick) and `web.test.ts` (nonce invalidated on retry, cleared on finish).
- Regressions prevented: clock-skew misdetection of duplicate tickets, a lost original error when rollback fails, leaked upstream bodies.

## Follow-up pass: wizard fix, A4 and A5
| # | Commit | Summary |
|---|--------|---------|
| 17 | cf946938 | fix(setup): the wizard sets the first admin when env ADMIN_IDS is empty (corrects the Task 1 over-restriction) |
| 18 | 330e5d3d | fix(orders): resolve aged UNDERPAID orders and alert on aged FAILED ones (A4) |
| 19 | 42a561b3 | fix(orders): A4 review fixes (default off, owner-settable keys, minors) |
| 20 | bb44592b | fix(digiflazz): keep orders still Pending after 24h locked as unresolved, not failed (A5) |
| 21 | 76dce158 | fix(digiflazz): A5 review fixes (recheck structural errors are transient, alert wording, tests) |
