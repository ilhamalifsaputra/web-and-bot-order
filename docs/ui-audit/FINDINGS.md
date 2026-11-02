# Findings

Branch `worktree-ui-states-audit`, head `e3ddb406` (base `2ebb5de0`). Template and
severity scale from the audit spec (sections 9 and 10). Machine-readable copy:
[report.json](report.json); the two must match.

**Status meanings used here**
- **Fixed**: code changed on this branch (commit listed) and the targeted tests
  pass. Not checked in a real browser.
- **Verified**: a Fixed finding that was also exercised in a real browser on
  2026-11-02 (headless Chromium, built bundles, dummy data in a disposable
  schema, one viewport, no screen reader, no R2, no real payment gateway). The
  browser note is in the finding's Test case section; its commit list is unchanged.
- **Open**: not fixed; a recommendation is given.
- **Accepted Risk**: owner accepted it. None yet.
- **Not Tested**: the outcome depends on a check that has not been run.

Line numbers marked "audit base" refer to commit `2ebb5de0` and may have moved.

| Status | Count |
|---|---|
| Fixed | 24 |
| Verified | 5 |
| Open | 35 |
| Accepted Risk | 0 |
| Not Tested | 1 |

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 15 |
| Medium | 32 |
| Low | 16 |

## Index

| ID | Severity | Status | Title |
|---|---|---|---|
| UPL-01 | High | Not Tested | Admin ticket image/video upload fails at the browser PUT to R2 |
| UPL-02 | Medium | Fixed | Upload errors blamed the network and the Send block had no reason |
| ADM-C1 | Critical | Fixed | Wallet adjustment could be applied twice and had no confirmation |
| ADM-C2 | Critical | Open | A settlement batch can be recorded twice after a lost response |
| ADM-H1 | High | Fixed | Readonly admins read full order data through tickets and order lists |
| ADM-H2 | High | Fixed | Support CSV export and Telegram ticket photos were open to readonly |
| ADM-H3 | High | Verified | Session expiry had no handling; a failed refetch unmounted drafts |
| ADM-H4 | High | Fixed | Broadcast could be sent twice |
| ADM-H5 | High | Fixed | One-click Deliver and bulk Mark Delivered had no confirmation |
| ADM-H6 | High | Fixed | Bulk actions showed a green toast when items failed |
| ADM-M1 | Medium | Open | Offline mutations pause silently and fire later |
| ADM-M2 | Medium | Open | Offline list pages can show a false empty state |
| ADM-M3 | Medium | Open | No request timeout in the admin API client |
| ADM-M4 | Medium | Open | Settlements, Audit and Wallet ledger show an error line beside an empty state |
| ADM-M5 | Medium | Verified | List page errors hid filters and had no Retry |
| ADM-M6 | Medium | Open | No permission-denied state in the admin SPA |
| ADM-M7 | Medium | Open | Order detail actions give little success feedback; errors render off-screen |
| ADM-M8 | Medium | Open | Support-role admins get an empty assignee list |
| ADM-M9 | Medium | Fixed | Edit Denomination loaded forever for a missing denomination |
| ADM-M10 | Medium | Open | Search exact-order redirect traps the Back button |
| ADM-M11 | Medium | Open | Stale-chunk reload in admin has no once-only guard |
| ADM-M12 | Medium | Open | Catalog lookups in create/voucher forms fail silently |
| ADM-M13 | Medium | Open | Bulk resend has no confirm and no idempotency key |
| ADM-M14 | Medium | Fixed | Digiflazz detection showed "no issues" when its load failed |
| ADM-M15 | Medium | Open | Digiflazz hourly sync status can skeleton forever if its SSE stream never connects |
| ADM-M16 | Medium | Open | A single Deliver retried after a lost response reports not pending verification although it was delivered |
| ADM-M17 | Medium | Open | Row Deliver or Resend and the bulk actions do not block each other |
| ADM-M18 | Medium | Fixed | A second admin sending the same Idempotency-Key was given the first admin's wallet or broadcast response |
| ADM-L1 | Low | Open | Remaining Low items from the admin audit |
| ADM-L2 | Low | Open | Readonly ticket photo thumbnails render as broken images |
| ADM-L3 | Low | Open | Wallet adjustments have no rate limit |
| ADM-L4 | Low | Fixed | A pending button lost a leading label component and measured layout on every commit |
| SF-H1 | High | Verified | Lost checkout response turned into an empty cart and lost the order |
| SF-H2 | High | Fixed | Session ending mid-checkout showed a wrong email error and a dead end |
| SF-H3 | High | Verified | Failed first loads showed endless skeletons on 11 routes |
| SF-H4 | High | Fixed | Order and ticket detail went blank on any refetch error |
| SF-H5 | High | Fixed | Order-recovery sessions were stuck on skeletons |
| SF-H6 | High | Verified | No ErrorBoundary: a stale chunk or render throw whitened the app |
| SF-H7 | High | Fixed | Cancel reported success when the server refused it |
| SF-M1 | Medium | Fixed | Cancel failure was silent |
| SF-M2 | Medium | Open | Pay poll failures are invisible |
| SF-M3 | Medium | Open | No offline handling or request timeout in the storefront |
| SF-M4 | Medium | Open | Cart update/remove failures are silent |
| SF-M5 | Medium | Open | Voucher preview failure is silent |
| SF-M6 | Medium | Open | Stale CSRF token outside checkout is unrecoverable until reload |
| SF-M7 | Medium | Open | Search overlay shows a blank panel on error |
| SF-M8 | Medium | Open | Raw developer strings reach users |
| SF-M9 | Medium | Open | New-ticket description has no draft |
| SF-M10 | Medium | Open | Unknown-outcome guest replay lands on /login |
| SF-M11 | Medium | Open | Mutation 401s have no shared handling |
| SF-L1 | Low | Open | Remaining Low items from the storefront audit |
| SF-L2 | Low | Open | Help page new-ticket submit has a silent busy block |
| LD-01 | Medium | Fixed | Loading states were inconsistent (text, two fallbacks, no aria-busy, fake 0%) |
| VIS-01 | Low | Fixed | Admin failure notices had no state icon; a failed refresh looked like a failed load |
| VIS-02 | Low | Fixed | Admin session-ended banner looked like an error |
| VIS-03 | Low | Fixed | Admin bulk-failure panel and error boundary had no icon; boundary not announced |
| VIS-04 | Low | Fixed | Admin upload rows showed a made-up 0% and raw state names |
| VIS-05 | Low | Fixed | Storefront error and warning alerts used the same icon |
| VIS-06 | Low | Fixed | Storefront refresh-failed notice and error boundary had no state icon |
| VIS-07 | Low | Fixed | Storefront upload rows had no state icons; failure reason not coloured |
| VIS-08 | Medium | Open | Neither client has an offline (wifi-off) or slow-network (signal-low) visual |
| VIS-09 | Low | Open | No permission-denied visual in use |
| VIS-10 | Low | Open | Admin filtered-empty states reuse the first-time-empty icon |
| VIS-11 | Low | Open | Small admin empty states (dashboard widgets, sub-tables) have no icon |
| SEC-01 | High | Open | Order.customerData is stored as plaintext |


### [UPL-01] [High] Admin ticket image/video upload fails at the browser PUT to R2

- Status: Not Tested
- Commit: -
- Confidence: Likely
- Surface: both
- Module: Support / tickets
- Route: /support/:ticketId
- Component/Function: useSupportUploads (xhr PUT)
- File: apps/web-admin/client/src/lib/supportUploads.ts
- Line: 61-65
- State: Error (upload failed)
- Trigger/Precondition: Admin attaches an image or MP4 to a ticket reply on the deployed admin origin.

**Actual behavior**
Owner report: customer uploads work, admin uploads fail with "Network unavailable". That text came only from xhr.onerror on the direct PUT to the R2 presigned URL, so the intent request had succeeded and the browser failed the PUT at the network/CORS level.

**Expected behavior**
Admin can upload supported images and videos; the attachment appears for admin and customer.

**Impact**
Admins cannot send evidence to customers from the ticket screen.

**Root cause**
R2 bucket CORS AllowedOrigins did not include the admin origin (customer origin was listed). Code path, bucket and request shape are the same for both apps; only the Origin differs. The owner confirmed the admin origin was missing, then edited and saved the CORS rule. This is a storage configuration fix, not a code fix.

**Recommended fix**
Keep the admin origin (for example https://admin.<shop-domain>) in the bucket's CORS AllowedOrigins with PUT and the Content-Type header. No code change needed for the root cause.

**Test case**
Owner: on the admin origin, upload one image and one MP4, send the reply, confirm both appear in admin and on the customer ticket; repeat one customer upload. Watch the Network tab for OPTIONS + PUT to the storage host (redact the query string).

**Regression risk**
None in code. A CORS edit that drops the shop origin would break customer uploads; the customer re-test covers that.

### [UPL-02] [Medium] Upload errors blamed the network and the Send block had no reason

- Status: Fixed
- Commit: `f0a7c8fb`
- Confidence: Confirmed
- Surface: both
- Module: Support / tickets
- Route: /support/:ticketId, /account/support/:id
- Component/Function: supportUploads.ts, SupportUploadPicker, TicketDetailReply, TicketComposer
- File: apps/web-admin/client/src/lib/supportUploads.ts; apps/storefront/client/src/lib/supportUploads.ts
- Line: 65; 52
- State: Error, Form validation
- Trigger/Precondition: A PUT to storage fails while the browser is online, or a file is in the failed state.

**Actual behavior**
Every xhr.onerror said "Network unavailable" even when online; the options request failing looked like "R2 not configured"; Send stayed disabled with no reason when a file had failed.

**Expected behavior**
Online failures say storage could not be reached; options loading/error/disabled are distinct with Retry; a failed file shows why Send is blocked; draft and files kept.

**Impact**
Misdirected the investigation toward the admin's connection; admins could not tell why Send was disabled.

**Root cause**
onerror mapped to one key regardless of navigator.onLine; picker took a single boolean for options.

**Recommended fix**
Done: helpdesk.upload_storage_blocked when online, optionsState prop, failed-file send reason in both clients.

**Test case**
lib/supportUploads.test.tsx (both clients), SupportUploadPicker.test.tsx, TicketDetailReply.test.tsx, TicketComposer.test.tsx, apps/web-admin/test/support-media-api.test.ts (21 server tests incl. readonly 403, MIME/size 400, finalize/abort ownership).

**Regression risk**
Copy only; storefront HelpPage new-ticket form still has a silent busy block (see SF-L-HELP).

### [ADM-C1] [Critical] Wallet adjustment could be applied twice and had no confirmation

- Status: Fixed
- Commit: `dea4baf1`, `25d91357`
- Confidence: Confirmed
- Surface: web-admin
- Module: Customers / wallet
- Route: /users/:userId
- Component/Function: UserDetailPage wallet form; POST /api/users/:userId/wallet
- File: apps/web-admin/src/routes/api/users.ts; apps/web-admin/client/src/pages/UserDetailPage.tsx
- Line: audit base: users.ts:277, UserDetailPage.tsx:84-93
- State: Success, Slow network
- Trigger/Precondition: Response lost (timeout, 502/504) after the commit; admin clicks Adjust again.

**Actual behavior**
A second click moved the money again; one click committed a mistyped amount.

**Expected behavior**
Same request is applied once; the admin confirms amount, sign and reason first; unknown outcome is said as such.

**Impact**
Wrong customer balance.

**Root cause**
No idempotency key, no confirm dialog, no state guard on a pure delta.

**Recommended fix**
Done: Idempotency-Key with the response stored inside the money transaction, ConfirmDialog, unknown-outcome copy that points to the ledger.

**Test case**
apps/web-admin/test/users-wallet-idempotency.test.ts (replay, concurrency, store-failure rollback), UserDetailPage.test.tsx.

**Regression risk**
A reload or edit after a lost response mints a new key; the copy tells the admin to check the ledger first.

### [ADM-C2] [Critical] A settlement batch can be recorded twice after a lost response

- Status: Open
- Commit: -
- Confidence: Likely
- Surface: web-admin
- Module: Payments / settlements
- Route: /settlements
- Component/Function: SettlementsPage; POST /api/settlements; recordSettlement
- File: apps/web-admin/src/routes/api/settlements.ts
- Line: 26-32 ("No Idempotency-Key here")
- State: Success, Slow network
- Trigger/Precondition: Response lost after commit, admin presses Record settlement again.

**Actual behavior**
Two batches and two SETTLEMENT postings can be created.

**Expected behavior**
Owner decides whether a replay should collapse into the first.

**Impact**
Overstated cash; drained provider_clearing.

**Root cause**
Deliberate design: the route comment explains two identical batches are legitimate and batchReference is non-unique on purpose.

**Recommended fix**
Owner decision. Options: an Idempotency-Key that only collapses a same-key replay (identical manual entries still allowed), or keep as is. The posted:false banner wording that says "record this batch again" should be reviewed with it.

**Test case**
If changed: replay with the same key creates one batch and one posting; two different keys create two.

**Regression risk**
Money-flow behaviour change; not done on this branch by rule.

### [ADM-H1] [High] Readonly admins read full order data through tickets and order lists

- Status: Fixed
- Commit: `9975500c`, `0cd0e22b`
- Confidence: Confirmed
- Surface: web-admin
- Module: Permissions
- Route: /support/:ticketId, /orders, /users/:userId, /payments
- Component/Function: GET /api/support/:ticketId, /api/orders, /api/users/:userId, /api/payments
- File: apps/web-admin/src/lib/readonlyOrders.ts; apps/web-admin/src/routes/api/support.ts
- Line: audit base: support.ts:281, :348
- State: Permission denied
- Trigger/Precondition: A readonly admin opens a ticket linked to an order, or an order list.

**Actual behavior**
Every Order scalar except deliveredContent, including customerData, reached readonly.

**Expected behavior**
Readonly gets the same allow-list the order route enforces.

**Impact**
Buyer checkout answers exposed to a role meant to be read-limited.

**Root cause**
Ticket and list routes used currentAdmin and spread whole order rows.

**Recommended fix**
Done: typed allow-lists for readonly on the ticket detail, recentOrders, order list, user detail and payments lists.

**Test case**
users-vouchers-support-audit-api.test.ts sentinel tests for both product families and each route.

**Regression risk**
Support and super paths unchanged; readonly ticket photos now show as broken images (ADM-L-PHOTO).

### [ADM-H2] [High] Support CSV export and Telegram ticket photos were open to readonly

- Status: Fixed
- Commit: `9975500c`
- Confidence: Confirmed
- Surface: web-admin
- Module: Permissions
- Route: /support
- Component/Function: GET /api/support/export, GET /api/support/photo/:fileId
- File: apps/web-admin/src/routes/api/support.ts
- Line: audit base: 253, 744
- State: Permission denied
- Trigger/Precondition: Readonly requests the export or a photo.

**Actual behavior**
200 with bulk customer names / photo bytes.

**Expected behavior**
403, as the other exports and the S3 media route.

**Impact**
Bulk customer data to readonly.

**Root cause**
currentAdmin instead of blockReadonlyReads.

**Recommended fix**
Done: blockReadonlyReads on both.

**Test case**
Role-access tests for anonymous, readonly, support, super.

**Regression risk**
Readonly export link lands on a plain-text 403 page.

### [ADM-H3] [High] Session expiry had no handling; a failed refetch unmounted drafts

- Status: Verified
- Commit: `f848a5ef`, `b65c8a1b`, `dcd14aff`, `a8e3bc2a`, `aeb594b8`
- Confidence: Confirmed
- Surface: web-admin
- Module: Auth / session
- Route: all
- Component/Function: api/client.ts, main.tsx QueryClient, page early returns (every admin page that fetches its own data)
- File: apps/web-admin/client/src/api/sessionExpiry.ts; components/layout/SessionExpiredBanner.tsx
- Line: -
- State: Session expiry, Error
- Trigger/Precondition: Session ends; window refocus refetch gets 401 while a reply, refund reason or wallet form is open.

**Actual behavior**
401 retried 3 times then the whole page was replaced by "Failed to load X"; typed text unreachable; no login path.

**Expected behavior**
One non-blocking banner with Log in (new tab) and Reload; pages keep data and inputs; failed refresh shows a small notice with Retry.

**Impact**
Lost drafts, confusing dead ends.

**Root cause**
No 401 branch, bare QueryClient, if (isError) early returns. Six pages kept that early return after the first fix (Edit Denomination, Catalog, Product Detail, Stock Product, Categories, Admins), and Pricing swapped its form for an alert on any error; all now show the error only when there is no data.

**Recommended fix**
Done: central 401 flag, no retry on 401/403, SessionExpiredBanner, QueryErrorNotice/QueryFailureGate, filters kept on first-load failure.

**Test case**
api/sessionExpiry.test.tsx (21), TicketDetail/OrderDetail refetch tests, first-load tests on 9 list pages, and a first-load plus a typed-draft-survives-a-failed-refetch test on Edit Denomination (typed price and cost), Catalog (pasted CSV), Product Detail (name draft), Stock Product (credentials), Categories (New category name), Admins (Telegram ID) and Pricing (markup).

Browser, 2026-11-02 (HEAD e3ddb406): on Edit Denomination (/catalog/1/denominations/1/edit) the price 12345 was typed, then every /api call answered 401 and a window-focus refetch fired (6 API calls). The typed value survived, no full-page error appeared, and exactly one banner showed "Your session has ended. Log in again in a new tab; what you have typed here stays on this page." with a Log in link (href=/login, target=_blank) and Reload. A first attempt with a non-bubbling visibilitychange event triggered no request and was discarded as inconclusive. Ticket reply, order and wallet forms were not exercised in a browser. Environment: headless Chromium against built bundles, dummy data in a disposable Postgres schema (dropped afterwards), one viewport, no screen reader, no R2 and no real payment gateway.

**Regression risk**
Shared notice on many pages.

### [ADM-H4] [High] Broadcast could be sent twice

- Status: Fixed
- Commit: `5a399d94`
- Confidence: Confirmed
- Surface: web-admin
- Module: Broadcast
- Route: /broadcast
- Component/Function: BroadcastPage; POST /api/broadcast
- File: apps/web-admin/src/routes/api/broadcast.ts
- Line: -
- State: Success, Slow network
- Trigger/Precondition: Lost response or 5xx after create, then Send again.

**Actual behavior**
A second message to the whole segment.

**Expected behavior**
Same key replays; unknown outcome says check the list.

**Impact**
Duplicate customer messages.

**Root cause**
No idempotency.

**Recommended fix**
Done: optional Idempotency-Key, row + audit + stored response in one transaction, success toast, no fake 0 recipients.

**Test case**
broadcast.test.ts, BroadcastPage.test.tsx.

**Regression risk**
Old clients send without a key (old behaviour).

### [ADM-H5] [High] One-click Deliver and bulk Mark Delivered had no confirmation

- Status: Fixed
- Commit: `5a399d94`
- Confidence: Confirmed
- Surface: web-admin
- Module: Orders
- Route: /orders
- Component/Function: OrdersPage row and bulk actions
- File: apps/web-admin/client/src/pages/OrdersPage.tsx; pages/orders/useOrderActions.ts
- Line: audit base: 692, 802
- State: Success
- Trigger/Precondition: Misclick in the row menu or bulk bar.

**Actual behavior**
Stock and credentials delivered immediately.

**Expected behavior**
Confirm dialog naming the orders; row Deliver disabled during a delivery.

**Impact**
Irreversible delivery by accident.

**Root cause**
No ConfirmDialog (order detail had one).

**Recommended fix**
Done.

**Test case**
OrdersPage.test.tsx.

**Regression risk**
Selection semantics changed: ineligible orders stay selected.

### [ADM-H6] [High] Bulk actions showed a green toast when items failed

- Status: Fixed
- Commit: `5a399d94`, `e1ff9c49`
- Confidence: Confirmed
- Surface: web-admin
- Module: Orders / Payments / Vouchers
- Route: /orders, /payments, /vouchers
- Component/Function: bulk handlers
- File: apps/web-admin/client/src/lib/bulkOutcome.ts; components/shared/BulkFailuresNotice.tsx
- Line: -
- State: Success, Error
- Trigger/Precondition: Some or all items in a bulk action fail; bulk dismiss over 20 items hits the rate limit.

**Actual behavior**
"0 succeeded, 5 failed" as success; reasons dropped; selection cleared; parallel dismiss guaranteed 429s.

**Expected behavior**
Error/partial toasts, a persistent reasons panel, failed items stay selected, sequential dismiss that stops at the first 429.

**Impact**
False success; failed set lost.

**Root cause**
toast.success for every outcome; Promise.allSettled in parallel.

**Recommended fix**
Done, plus copy for every error key the bulk routes send.

**Test case**
bulkOutcome.test.ts, OrdersPage/PaymentsPage/VouchersPage tests.

**Regression risk**
Bulk resend still has no confirm or key (ADM-M13).

### [ADM-M1] [Medium] Offline mutations pause silently and fire later

- Status: Open
- Commit: -
- Confidence: Needs reproduction
- Surface: web-admin
- Module: All
- Route: all
- Component/Function: TanStack Query networkMode online
- File: apps/web-admin/client/src/api/queryClient.ts
- Line: -
- State: Offline
- Trigger/Precondition: Admin clicks Adjust/Approve while offline.

**Actual behavior**
Button stays pending with no explanation, then the request runs on reconnect.

**Expected behavior**
An offline indicator; mutations refuse or ask before resuming.

**Impact**
Surprising late mutations.

**Root cause**
No onlineManager/offline UI; navigator.onLine never read.

**Recommended fix**
Offline banner (wifi-off) and networkMode policy for mutations.

**Test case**
Playwright page.setOffline during a mutation.

**Regression risk**
All mutations.

### [ADM-M2] [Medium] Offline list pages can show a false empty state

- Status: Open
- Commit: -
- Confidence: Needs reproduction
- Surface: web-admin
- Module: Lists
- Route: /orders, /users, /reviews, /stock, /settlements, /audit, /wallet-transactions
- Component/Function: list pages
- File: apps/web-admin/client/src/pages/*
- Line: -
- State: Offline, Empty
- Trigger/Precondition: Page opened offline.

**Actual behavior**
A paused query has no data and no error, so some pages render their empty state.

**Expected behavior**
Offline is said as offline.

**Impact**
Admin believes there is no data.

**Root cause**
Pages key the empty state on !isLoading && no rows.

**Recommended fix**
Treat fetchStatus 'paused' as its own state.

**Test case**
page.setOffline(true) before load.

**Regression risk**
List pages.

### [ADM-M3] [Medium] No request timeout in the admin API client

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: All
- Route: all
- Component/Function: apiGet/apiPost
- File: apps/web-admin/client/src/api/client.ts
- Line: -
- State: Slow network, Loading
- Trigger/Precondition: A hung proxy.

**Actual behavior**
Skeleton or pending button until the browser gives up.

**Expected behavior**
Explicit timeout and a slow-network message.

**Impact**
Infinite loading.

**Root cause**
No AbortSignal.timeout.

**Recommended fix**
Per-request-type timeouts; idempotent mutations keep their key on timeout.

**Test case**
route.fulfill with a long delay.

**Regression risk**
Every request.

### [ADM-M4] [Medium] Settlements, Audit and Wallet ledger show an error line beside an empty state

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Payments / audit
- Route: /settlements, /audit, /wallet-transactions
- Component/Function: SettlementsPage, AuditPage, WalletTransactionsPage
- File: apps/web-admin/client/src/pages/SettlementsPage.tsx; AuditPage.tsx; WalletTransactionsPage.tsx
- Line: 327; 331; 226
- State: Error, Empty
- Trigger/Precondition: First load fails.

**Actual behavior**
Red text-only line plus "No ... found" in the table; no Retry.

**Expected behavior**
QueryFailureGate as on the other list pages.

**Impact**
Misleading on money and audit pages.

**Root cause**
These pages were not in the session-expiry task's list.

**Recommended fix**
Wrap rows in QueryFailureGate (same pattern as Orders).

**Test case**
First-load failure test per page.

**Regression risk**
Low.

### [ADM-M5] [Medium] List page errors hid filters and had no Retry

- Status: Verified
- Commit: `f848a5ef`, `b65c8a1b`, `dcd14aff`
- Confidence: Confirmed
- Surface: web-admin
- Module: Lists
- Route: 9 list pages
- Component/Function: QueryFailureGate
- File: apps/web-admin/client/src/components/shared/QueryErrorNotice.tsx
- Line: -
- State: Error
- Trigger/Precondition: First load or a poll fails.

**Actual behavior**
Whole page replaced by one line.

**Expected behavior**
Filters stay; notice with Retry in place of rows.

**Impact**
Dead end.

**Root cause**
Early returns.

**Recommended fix**
Done.

**Test case**
First-load and refresh tests on Orders, Support, Users, Reviews, Payments, Vouchers, Tasks, Stock, FlashSales.

Browser, 2026-11-02 (HEAD e3ddb406): /orders with GET /api/orders answered 502 on first load showed the alert "Failed to load orders." with Retry, the search box still present and no "No orders" text. After Retry (one more fetch; four fetches before it are the default 5xx retries) the list loaded and the alert was gone. Only the Orders list page was exercised; the other eight list pages are covered by jsdom tests. Environment: headless Chromium against built bundles, dummy data in a disposable Postgres schema (dropped afterwards), one viewport, no screen reader, no R2 and no real payment gateway.

**Regression risk**
Stat cards show Unavailable.

### [ADM-M6] [Medium] No permission-denied state in the admin SPA

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Permissions
- Route: all
- Component/Function: throwForResponse; pages
- File: apps/web-admin/client/src/api/client.ts
- Line: -
- State: Permission denied
- Trigger/Precondition: Readonly opens a page or action it may not use.

**Actual behavior**
403 text now reads "You don't have permission to do this..." (fixed in f848a5ef), but the SPA has no role knowledge: every button and nav item shows, and a readonly order detail says it failed to load.

**Expected behavior**
Role-aware UI and a permission-denied state (shield-alert, warning).

**Impact**
Confusing for readonly admins; not a security gap (server enforces).

**Root cause**
No role field reaches the client.

**Recommended fix**
Additive role field on the session/context response; hide or disable actions; a PermissionDenied state component.

**Test case**
Readonly session renders no mutation buttons.

**Regression risk**
Navigation and every action button.

### [ADM-M7] [Medium] Order detail actions give little success feedback; errors render off-screen

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Orders
- Route: /orders/:orderId
- Component/Function: OrderDetailPage
- File: apps/web-admin/client/src/pages/OrderDetailPage.tsx
- Line: audit base: 224-273, 395
- State: Success, Error
- Trigger/Precondition: Approve, reject, fulfil, resend.

**Actual behavior**
No success toast; resend changes nothing on screen; errors at the page top while the Actions card is at the bottom.

**Expected behavior**
Toast on success; error next to the action.

**Impact**
Repeat clicks; duplicate credential DMs on resend.

**Root cause**
-

**Recommended fix**
Add toasts and inline errors.

**Test case**
Page tests per action.

**Regression risk**
Low.

### [ADM-M8] [Medium] Support-role admins get an empty assignee list

- Status: Open
- Commit: -
- Confidence: Likely
- Surface: web-admin
- Module: Support
- Route: /support, /support/:ticketId
- Component/Function: assignee query
- File: apps/web-admin/client/src/pages/SupportPage.tsx; TicketDetailPage.tsx
- Line: audit base: 241; 226
- State: Permission denied, Empty
- Trigger/Precondition: Support-role admin opens the assign control.

**Actual behavior**
requireSuper /api/admins answers 403; list is empty.

**Expected behavior**
Use /api/admin-tasks/assignees like TasksPage.

**Impact**
Cannot assign tickets.

**Root cause**
Wrong endpoint.

**Recommended fix**
Switch endpoint.

**Test case**
Support-role test.

**Regression risk**
Low.

### [ADM-M9] [Medium] Edit Denomination loaded forever for a missing denomination

- Status: Fixed
- Commit: `3ee981f4`
- Confidence: Confirmed
- Surface: web-admin
- Module: Catalog
- Route: /catalog/:productId/denominations/:denomId/edit
- Component/Function: DenominationEditPage
- File: apps/web-admin/client/src/pages/DenominationEditPage.tsx
- Line: audit base: 376
- State: Loading, Error
- Trigger/Precondition: Bad or deleted denomId.

**Actual behavior**
"Loading..." forever.

**Expected behavior**
"This denomination no longer exists."

**Impact**
Dead end.

**Root cause**
No not-found branch.

**Recommended fix**
Done.

**Test case**
DenominationEdit loading + not-found tests.

**Regression risk**
Low.

### [ADM-M10] [Medium] Search exact-order redirect traps the Back button

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Search
- Route: /search
- Component/Function: SearchPage
- File: apps/web-admin/client/src/pages/SearchPage.tsx
- Line: 74
- State: Success
- Trigger/Precondition: Search for an exact order code.

**Actual behavior**
navigate() without replace; Back returns to /search which redirects again.

**Expected behavior**
replace: true.

**Impact**
Navigation trap.

**Root cause**
-

**Recommended fix**
navigate(..., { replace: true }).

**Test case**
History length test.

**Regression risk**
Low.

### [ADM-M11] [Medium] Stale-chunk reload in admin has no once-only guard

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: App shell
- Route: all
- Component/Function: vite:preloadError handler
- File: apps/web-admin/client/src/main.tsx
- Line: 18-20
- State: Error, Offline
- Trigger/Precondition: A chunk keeps failing (offline, broken deploy).

**Actual behavior**
Unconditional reload, possible loop; drafts lost.

**Expected behavior**
One reload per window, as the storefront's lib/chunkReload.ts.

**Impact**
Reload loop.

**Root cause**
-

**Recommended fix**
Port the storefront guard.

**Test case**
chunkReload-style unit test.

**Regression risk**
Low.

### [ADM-M12] [Medium] Catalog lookups in create/voucher forms fail silently

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Catalog / vouchers
- Route: /catalog/new, /vouchers, denomination create, /catalog/digiflazz-sync
- Component/Function: ProductCreatePage, VouchersPage pickers, DenominationCreatePage, DigiflazzSyncPage
- File: apps/web-admin/client/src/pages/*
- Line: audit base: ProductCreatePage:29,51; VouchersPage:253,291
- State: Error, Empty
- Trigger/Precondition: Lookup query fails.

**Actual behavior**
Empty picker or "No products found".

**Expected behavior**
Error with Retry.

**Impact**
Admin thinks the catalog is empty.

**Root cause**
No error branch.

**Recommended fix**
Add QueryErrorNotice to each picker.

**Test case**
Picker failure tests.

**Regression risk**
Low.

### [ADM-M13] [Medium] Bulk resend has no confirm and no idempotency key

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Orders
- Route: /orders
- Component/Function: bulk-action resend
- File: apps/web-admin/src/routes/api/orders.ts
- Line: -
- State: Success
- Trigger/Precondition: Retry after a lost answer.

**Actual behavior**
Buyers can get a second credentials DM.

**Expected behavior**
Confirm + key, as bulk deliver.

**Impact**
Duplicate messages.

**Root cause**
Out of the bulk task's scope.

**Recommended fix**
Add both.

**Test case**
Route replay test.

**Regression risk**
Low.

### [ADM-M14] [Medium] Digiflazz detection showed "no issues" when its load failed

- Status: Fixed
- Commit: `ae876166`
- Confidence: Confirmed
- Surface: web-admin
- Module: Catalog / Digiflazz
- Route: /catalog/digiflazz-sync
- Component/Function: DigiflazzSyncPage detection cards
- File: apps/web-admin/client/src/pages/DigiflazzSyncPage.tsx
- Line: -
- State: Error, Empty
- Trigger/Precondition: Metrics or issues query fails.

**Actual behavior**
"Never run" / "No issues" empty text.

**Expected behavior**
QueryErrorNotice with Retry.

**Impact**
False all-clear.

**Root cause**
Empty branch keyed on missing data.

**Recommended fix**
Done.

**Test case**
DigiflazzSyncPage.test.tsx failure tests.

**Regression risk**
Low.

### [ADM-M15] [Medium] Digiflazz hourly sync status can skeleton forever if its SSE stream never connects

- Status: Open
- Commit: -
- Confidence: Needs reproduction
- Surface: web-admin
- Module: Catalog / Digiflazz
- Route: /catalog/digiflazz-sync
- Component/Function: sync status (SSE)
- File: apps/web-admin/client/src/pages/DigiflazzSyncPage.tsx
- Line: -
- State: Loading
- Trigger/Precondition: The event stream never opens (proxy strips SSE, network).

**Actual behavior**
Status skeleton stays.

**Expected behavior**
Timeout to an unavailable state with Retry.

**Impact**
Infinite loading.

**Root cause**
Status only arrives over the stream.

**Recommended fix**
Fallback GET or timeout.

**Test case**
Stream that never opens in a test.

**Regression risk**
Low.

### [ADM-M16] [Medium] A single Deliver retried after a lost response reports not pending verification although it was delivered

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Orders
- Route: /orders/:orderId, /orders
- Component/Function: POST /api/orders/:orderId/approve (single Deliver)
- File: apps/web-admin/src/routes/api/orders.ts
- Line: -
- State: Success, Lost response
- Trigger/Precondition: The Deliver request succeeds on the server but the response never reaches the browser; the admin clicks Deliver again.

**Actual behavior**
The second request finds the order already delivered and answers that it is not pending verification, so the admin sees an error for an order that was in fact delivered.

**Expected behavior**
The retry recognises its own earlier delivery and shows success (an Idempotency-Key, as bulk deliver has), or the error says the order is already delivered.

**Impact**
A confusing error after a successful delivery; the admin may try to fix an order that is fine. No double delivery: the status claim still refuses the second run.

**Root cause**
The approve route has no Idempotency-Key, so a retry cannot be told apart from a second, different attempt.

**Recommended fix**
Send an Idempotency-Key from the single Deliver button and honour it in the route, as the bulk path does. Not fixed here.

**Test case**
Route test: same key twice returns the stored response once.

**Regression risk**
Low; the status claim already prevents double delivery.

### [ADM-M17] [Medium] Row Deliver or Resend and the bulk actions do not block each other

- Status: Open
- Commit: -
- Confidence: Likely
- Surface: web-admin
- Module: Orders
- Route: /orders
- Component/Function: useOrderActions (row and bulk mutations)
- File: apps/web-admin/client/src/pages/orders/useOrderActions.ts
- Line: -
- State: Pending
- Trigger/Precondition: A bulk action is running and the admin clicks Deliver or Resend on one of the same rows, or the other way round.

**Actual behavior**
The row button and the bulk bar are tracked separately, so both can be in flight for one order. Deliver is safe (the server's status claim lets only one run). Resend is not: the buyer can get the credentials twice (see ADM-M13).

**Expected behavior**
While any bulk action runs, row actions on the page are disabled, and the reverse.

**Impact**
Duplicate credentials DM for Resend; a spurious error toast for Deliver.

**Root cause**
Separate pending flags per mutation, with no shared busy state.

**Recommended fix**
Share one busy flag across row and bulk actions; pair it with the Resend confirmation and key in ADM-M13. Not fixed here.

**Test case**
Page test: a bulk action in flight disables the row buttons.

**Regression risk**
Low.

### [ADM-M18] [Medium] A second admin sending the same Idempotency-Key was given the first admin's wallet or broadcast response

- Status: Fixed
- Commit: `d359284e`
- Confidence: Confirmed
- Surface: web-admin
- Module: Customers / wallet, Broadcast
- Route: /users/:userId, /broadcast
- Component/Function: POST /api/users/:userId/wallet, POST /api/broadcast
- File: apps/web-admin/src/routes/api/users.ts; apps/web-admin/src/routes/api/broadcast.ts
- Line: -
- State: Success
- Trigger/Precondition: Two admins use the same key (a copied request, or a key reused by a script) for the same body.

**Actual behavior**
The idempotency ledger is keyed by key plus endpoint, and the request hash did not name the acting admin, so the second admin got the first admin's stored response and no wallet move or broadcast of their own, while seeing success.

**Expected behavior**
A key belongs to the admin who used it: another admin gets the key-reused refusal.

**Impact**
An admin believing they moved money or sent a broadcast when nothing ran for them.

**Root cause**
requestHash covered the body only.

**Recommended fix**
Done: the hash includes the acting admin's user id for both routes. Same-admin replay is unchanged.

**Test case**
users-wallet-idempotency.test.ts and broadcast.test.ts: another admin gets 409 key-reused with nothing moved; the same admin still replays the stored response once.

**Regression risk**
Keys stored by the old hash no longer match for an in-flight retry across the deploy (a short window; answered as key-reused).

### [ADM-L1] [Low] Remaining Low items from the admin audit

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Various
- Route: various
- Component/Function: various
- File: see docs/ui-audit/WEB_ADMIN_UI_STATES_AUDIT.md
- Line: -
- State: Various
- Trigger/Precondition: -

**Actual behavior**
StockProduct dead reason reset; raw i18n keys on TicketDetail/StockProduct; filtered-zero copy says "none yet" (Settlements, Wallet); Orders q/dates not in URL; voucher create no success toast; POST /logout without CSRF; lib/upload.ts skips originOk; sidebar badges vanish on failure.

**Expected behavior**
-

**Impact**
Usability.

**Root cause**
-

**Recommended fix**
Fix individually.

**Test case**
-

**Regression risk**
Low.

### [ADM-L2] [Low] Readonly ticket photo thumbnails render as broken images

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Support
- Route: /support/:ticketId
- Component/Function: ticket attachments
- File: apps/web-admin/src/routes/api/support.ts
- Line: -
- State: Permission denied, Preview unavailable
- Trigger/Precondition: Readonly opens a ticket with Telegram photos.

**Actual behavior**
403 image, alt text "Attachment".

**Expected behavior**
A preview-unavailable state (file-warning) for roles without access.

**Impact**
Cosmetic; access is correctly refused.

**Root cause**
Client has no role signal.

**Recommended fix**
Additive role field (see ADM-M6).

**Test case**
-

**Regression risk**
Low.

### [ADM-L3] [Low] Wallet adjustments have no rate limit

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Customers / wallet
- Route: /users/:userId
- Component/Function: POST /api/users/:userId/wallet
- File: apps/web-admin/src/routes/api/users.ts
- Line: -
- State: -
- Trigger/Precondition: -

**Actual behavior**
Payment mutations are throttled; wallet adjustment is not.

**Expected behavior**
Owner decides.

**Impact**
Low; idempotency already prevents replays.

**Root cause**
-

**Recommended fix**
Optional throttle.

**Test case**
-

**Regression risk**
Low.

### [ADM-L4] [Low] A pending button lost a leading label component and measured layout on every commit

- Status: Fixed
- Commit: `92ca9cc7`
- Confidence: Confirmed
- Surface: both
- Module: Button primitive
- Route: all
- Component/Function: withoutLeadingIcon, usePendingWidth
- File: apps/web-admin/client/src/components/ui/button.tsx; apps/storefront/client/src/components/ui/Button.tsx
- Line: -
- State: Pending
- Trigger/Precondition: A pending button whose first child is a label component such as Trans or CurrencyAmount; any re-render of any button.

**Actual behavior**
The first non-DOM child was always treated as an icon, so the label vanished while pending. Every commit of every button read getBoundingClientRect, forcing a layout each time.

**Expected behavior**
Only a real icon is swapped for the spinner; idle widths are tracked without forcing layout.

**Impact**
Missing label while pending; avoidable layout work on busy pages.

**Root cause**
Any component element counted as an icon; a deps-less layout effect measured on each commit.

**Recommended fix**
Done: an icon is an svg, a Lucide icon (a forwardRef component without children) or a component named ...Icon; the idle width comes from a ResizeObserver (ignoring reports made while pending), with the old per-commit measure only where ResizeObserver does not exist.

**Test case**
loading-primitives.test.tsx and Button.test.tsx: leading label kept, icon by name dropped, no layout read on idle re-render, held width, disconnect on unmount.

**Regression risk**
Low; a custom icon component not named ...Icon keeps its place next to the spinner.

### [SF-H1] [High] Lost checkout response turned into an empty cart and lost the order

- Status: Verified
- Commit: `b8bb1776`, `2d5ae303`, `b42abd66`
- Confidence: Confirmed
- Surface: storefront
- Module: Checkout
- Route: /checkout
- Component/Function: CheckoutPage, useIdempotentPost
- File: apps/storefront/client/src/pages/CheckoutPage.tsx
- Line: audit base: 250-257, 308, 361, 475
- State: Slow network, Error, Success
- Trigger/Precondition: POST /api/v1/checkout commits, response lost, window refocuses.

**Actual behavior**
Form remounted as "cart empty"; banner and key gone; wallet already debited.

**Expected behavior**
Unknown outcome is said; form frozen; same-key Try again; link to orders/track.

**Impact**
Buyer may pay twice or think a paid order failed.

**Root cause**
Idempotency hook inside a keyed form; refetch-on-focus.

**Recommended fix**
Done.

**Test case**
CheckoutPage.test.tsx (same key and body on retry), idempotency.test.ts.

Browser, 2026-11-02 (HEAD e3ddb406): signed-in dummy shopper, wallet payment. POST /api/v1/checkout reached the real server and its response was dropped. Server state: one order, wallet 1,000,000 -> 995,000, one stock item SOLD. The UI showed "We couldn't confirm your order ... It may have been placed", the Place order button was absent, and only View my orders / Try again / Start over remained. Try again sent the same Idempotency-Key as the first attempt, the server answered 201 and the page moved to that order's detail. Afterwards the database still held exactly one order, the wallet was still 995,000 and stock was SOLD=1, AVAILABLE=3: no duplicate order and no double debit. The guest variant was not exercised. Environment: headless Chromium against built bundles, dummy data in a disposable Postgres schema (dropped afterwards), one viewport, no screen reader, no R2 and no real payment gateway.

**Regression risk**
Guest edited retry can still create a second order (pre-existing, SF-M10).

### [SF-H2] [High] Session ending mid-checkout showed a wrong email error and a dead end

- Status: Fixed
- Commit: `b8bb1776`, `2d5ae303`, `b42abd66`
- Confidence: Confirmed
- Surface: storefront
- Module: Checkout / cart
- Route: /checkout, /cart
- Component/Function: CheckoutPage, CartPage
- File: apps/storefront/client/src/pages/CheckoutPage.tsx; apps/storefront/src/routes/cart.ts
- Line: -
- State: Session expiry
- Trigger/Precondition: Signed-in buyer's session dies on /checkout.

**Actual behavior**
"Enter a valid email" with no email field; reload showed an empty cart; answers lost.

**Expected behavior**
"Your session ended" with Log in in a new tab and an explicit continue; answers kept in memory only.

**Impact**
Lost checkout.

**Root cause**
Server fell through to the guest branch.

**Recommended fix**
Done: additive signed_in and csrf_token on GET; no answers written to storage.

**Test case**
CheckoutPage/CartPage tests; spa-api and security-hardening server tests.

**Regression risk**
Client and server ship together.

### [SF-H3] [High] Failed first loads showed endless skeletons on 11 routes

- Status: Verified
- Commit: `9539336f`
- Confidence: Confirmed
- Surface: storefront
- Module: Catalog / account
- Route: /cart, /account/orders, /account, /, /products, /categories, /flash, /account/referral, /account/reviews, /account/settings
- Component/Function: LoadFailedState
- File: apps/storefront/client/src/components/shop/LoadFailed.tsx
- Line: -
- State: Error, Loading
- Trigger/Precondition: 5xx, 429, 403 or network failure on first load.

**Actual behavior**
Skeleton forever; Settings rendered nothing.

**Expected behavior**
Error with Try again.

**Impact**
Looks like loading forever.

**Root cause**
Pages tested only !data.

**Recommended fix**
Done.

**Test case**
firstLoadFailure.test (10 routes, exact fetch counts).

Browser, 2026-11-02 (HEAD e3ddb406): /account/orders with GET answered 500 on first load showed "Something went wrong ... Try again" with no aria-busy skeleton left; after Retry the alert was gone. Only this one of the ten affected routes was exercised in a browser; the rest are covered by the firstLoadFailure jsdom test. Environment: headless Chromium against built bundles, dummy data in a disposable Postgres schema (dropped afterwards), one viewport, no screen reader, no R2 and no real payment gateway.

**Regression risk**
Low.

### [SF-H4] [High] Order and ticket detail went blank on any refetch error

- Status: Fixed
- Commit: `9539336f`
- Confidence: Confirmed
- Surface: storefront
- Module: Orders / support
- Route: /account/orders/:code, /account/support/:id
- Component/Function: loadFailureView
- File: apps/storefront/client/src/pages/loadFailureView.tsx
- Line: -
- State: Error
- Trigger/Precondition: One failed poll with data on screen.

**Actual behavior**
Whole page, including credentials and edit form, disappeared.

**Expected behavior**
Page stays; Couldn't refresh notice.

**Impact**
Lost view and drafts.

**Root cause**
Early return on any error.

**Recommended fix**
Done.

**Test case**
OrderDetailPage/TicketDetailPage tests.

**Regression risk**
Low.

### [SF-H5] [High] Order-recovery sessions were stuck on skeletons

- Status: Fixed
- Commit: `9539336f`
- Confidence: Confirmed
- Surface: storefront
- Module: Track
- Route: /track then any page
- Component/Function: RecoveryScopeNotice
- File: apps/storefront/client/src/lib/recoveryScope.ts
- Line: -
- State: Permission denied
- Trigger/Precondition: Guest recovers an order then clicks Products.

**Actual behavior**
Endless skeleton; false 404.

**Expected behavior**
A notice explaining the scoped session with View order and Log out.

**Impact**
Dead end.

**Root cause**
Server scoping had no client handling.

**Recommended fix**
Done: additive order_scope on context.

**Test case**
Layout.test, recoveryScope.test, security-hardening server test.

**Regression risk**
Search overlay not covered (SF-M7).

### [SF-H6] [High] No ErrorBoundary: a stale chunk or render throw whitened the app

- Status: Verified
- Commit: `8a12842c`
- Confidence: Confirmed
- Surface: storefront
- Module: App shell
- Route: all
- Component/Function: ErrorBoundary, chunkReload, randomId
- File: apps/storefront/client/src/components/ErrorBoundary.tsx
- Line: -
- State: Error
- Trigger/Precondition: Deploy replaces chunks while a tab is open; crypto.randomUUID on plain http.

**Actual behavior**
White page.

**Expected behavior**
Root + per-route boundary, one guarded auto-reload.

**Impact**
Lost session.

**Root cause**
No boundary.

**Recommended fix**
Done.

**Test case**
ErrorBoundary.test, chunkReload.test, randomId.test.

Browser, 2026-11-02 (HEAD e3ddb406): the lazy chunk CartPage-*.js was aborted. The page showed the boundary alert "Something went wrong. This page stopped working. Reloading usually fixes it." with a Reload page button, the site header still rendered (not a white page), and the URL stayed /cart. Only the boundary fallback was exercised: the chunk was aborted, so the reload-once-per-window guard for a stale deploy was NOT exercised (jsdom tests only). Environment: headless Chromium against built bundles, dummy data in a disposable Postgres schema (dropped afterwards), one viewport, no screen reader, no R2 and no real payment gateway.

**Regression risk**
Low.

### [SF-H7] [High] Cancel reported success when the server refused it

- Status: Fixed
- Commit: `3f4bfb48`
- Confidence: Confirmed
- Surface: storefront
- Module: Payments
- Route: /checkout/:code/pay, /wallet/topup/:code/pay
- Component/Function: PayPage; cancelAsBuyer
- File: apps/storefront/src/routes/buyerCancel.ts
- Line: -
- State: Success
- Trigger/Precondition: Payment lands between the last poll and the confirm tap.

**Actual behavior**
Buyer sent to cart believing the order cancelled while it was paid.

**Expected behavior**
Additive cancelled flag; page stays and re-reads.

**Impact**
False success; repeat purchase.

**Root cause**
ValidationError swallowed into {ok:true}.

**Recommended fix**
Done.

**Test case**
PayPage.test (cancel outcome), wallet-topup-api, topup-order-api tests.

**Regression risk**
Low.

### [SF-M1] [Medium] Cancel failure was silent

- Status: Fixed
- Commit: `3f4bfb48`, `e1ff9c49`
- Confidence: Confirmed
- Surface: storefront
- Module: Payments
- Route: /checkout/:code/pay
- Component/Function: usePaymentCancel
- File: apps/storefront/client/src/pages/usePaymentCancel.ts
- Line: -
- State: Error
- Trigger/Precondition: 401, 403, 5xx or network on cancel.

**Actual behavior**
Dialog stayed, spinner stopped, nothing said.

**Expected behavior**
Unknown-outcome alert and a re-read.

**Impact**
Confusion.

**Root cause**
No onError.

**Recommended fix**
Done.

**Test case**
PayPage.test.

**Regression risk**
Low.

### [SF-M2] [Medium] Pay poll failures are invisible

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: storefront
- Module: Payments
- Route: /checkout/:code/pay
- Component/Function: PayPage poll
- File: apps/storefront/client/src/pages/PayPage.tsx
- Line: audit base: 523-528
- State: Error, Slow network
- Trigger/Precondition: Poll fails (5xx, offline).

**Actual behavior**
QR and "waiting" stay, no warning.

**Expected behavior**
Couldn't refresh notice.

**Impact**
Stale status.

**Root cause**
Poll error discarded.

**Recommended fix**
RefreshFailedNotice on poll error.

**Test case**
-

**Regression risk**
Low.

### [SF-M3] [Medium] No offline handling or request timeout in the storefront

- Status: Open
- Commit: -
- Confidence: Needs reproduction
- Surface: storefront
- Module: All
- Route: all
- Component/Function: api/client.ts
- File: apps/storefront/client/src/api/client.ts
- Line: -
- State: Offline, Slow network
- Trigger/Precondition: Browser offline or hung request.

**Actual behavior**
Paused queries look like loading; mutations resume on reconnect without a tap.

**Expected behavior**
Offline indicator (wifi-off) and timeouts.

**Impact**
Confusion; late mutations.

**Root cause**
No navigator.onLine / AbortSignal.timeout.

**Recommended fix**
Offline banner and timeout policy.

**Test case**
page.setOffline.

**Regression risk**
All requests.

### [SF-M4] [Medium] Cart update/remove failures are silent

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: storefront
- Module: Cart
- Route: /cart
- Component/Function: CartPage
- File: apps/storefront/client/src/pages/CartPage.tsx
- Line: audit base: 90-96
- State: Error
- Trigger/Precondition: 400/403/5xx on update.

**Actual behavior**
No message; qty field disagrees with the server.

**Expected behavior**
Inline error; reset draft.

**Impact**
Wrong expectation.

**Root cause**
-

**Recommended fix**
onError.

**Test case**
-

**Regression risk**
Low.

### [SF-M5] [Medium] Voucher preview failure is silent

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: storefront
- Module: Checkout
- Route: /checkout
- Component/Function: CheckoutPage voucher
- File: apps/storefront/client/src/pages/CheckoutPage.tsx
- Line: audit base: 363-367
- State: Error
- Trigger/Precondition: 403/429/5xx on preview.

**Actual behavior**
Apply does nothing visibly.

**Expected behavior**
Error under the field.

**Impact**
Confusion; server still blocks wrong totals.

**Root cause**
-

**Recommended fix**
onError.

**Test case**
-

**Regression risk**
Low.

### [SF-M6] [Medium] Stale CSRF token outside checkout is unrecoverable until reload

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: storefront
- Module: All
- Route: all except /checkout
- Component/Function: api/client.ts
- File: apps/storefront/client/src/api/client.ts
- Line: 5-7
- State: Session expiry
- Trigger/Precondition: Re-login in another tab.

**Actual behavior**
Every mutation 403 csrf_failed; checkout now adopts the token from its GET (2d5ae303), other pages do not.

**Expected behavior**
Adopt or reload prompt.

**Impact**
Stuck actions.

**Root cause**
Per-session CSRF in a meta tag.

**Recommended fix**
Generalise the GET token adoption.

**Test case**
-

**Regression risk**
Low.

### [SF-M7] [Medium] Search overlay shows a blank panel on error

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: storefront
- Module: Search
- Route: overlay
- Component/Function: SearchOverlay
- File: apps/storefront/client/src/components/shop/SearchOverlay.tsx
- Line: audit base: 150, 430-434
- State: Error, Zero results
- Trigger/Precondition: Search request fails.

**Actual behavior**
Empty panel.

**Expected behavior**
Error with retry, distinct from zero results.

**Impact**
Looks like no results.

**Root cause**
No error branch.

**Recommended fix**
Add error branch.

**Test case**
-

**Regression risk**
Low.

### [SF-M8] [Medium] Raw developer strings reach users

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: storefront
- Module: Various
- Route: order detail edit, ticket, help, login
- Component/Function: tError
- File: apps/storefront/client/src/lib/errors.ts
- Line: audit base: 59-62
- State: Error
- Trigger/Precondition: Unmapped error.

**Actual behavior**
"/api/v1/... responded 500", csrf_failed, Failed to fetch.

**Expected behavior**
Friendly copy.

**Impact**
Leaks internals; confusing.

**Root cause**
No key-prefix check.

**Recommended fix**
Map unknown to a generic message.

**Test case**
-

**Regression risk**
Low.

### [SF-M9] [Medium] New-ticket description has no draft

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: storefront
- Module: Support
- Route: /help
- Component/Function: HelpPage
- File: apps/storefront/client/src/pages/HelpPage.tsx
- Line: audit base: 38, 58
- State: Session expiry
- Trigger/Precondition: Session ends while typing; buyer follows the login link.

**Actual behavior**
Description lost.

**Expected behavior**
Draft kept (ticket composer already autosaves).

**Impact**
Lost text.

**Root cause**
-

**Recommended fix**
Reuse the composer draft pattern.

**Test case**
-

**Regression risk**
Low.

### [SF-M10] [Medium] Unknown-outcome guest replay lands on /login

- Status: Open
- Commit: -
- Confidence: Needs reproduction
- Surface: storefront
- Module: Checkout
- Route: /checkout
- Component/Function: guest replay
- File: apps/storefront/src/routes/api.ts
- Line: audit base: 644-654
- State: Session expiry
- Trigger/Precondition: Guest's response and cookie both lost.

**Actual behavior**
Pay page 401 redirects a passwordless guest to login.

**Expected behavior**
Point to the emailed recovery link / track.

**Impact**
Confusing.

**Root cause**
Documented server trade-off.

**Recommended fix**
Owner decision.

**Test case**
-

**Regression risk**
Low.

### [SF-M11] [Medium] Mutation 401s have no shared handling

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: storefront
- Module: All
- Route: /wallet/topup, pay cancel, ticket reply
- Component/Function: api/client.ts
- File: apps/storefront/client/src/api/client.ts
- Line: -
- State: Session expiry
- Trigger/Precondition: Session ends, buyer submits.

**Actual behavior**
Generic error; order-detail info edits lost after the refetch redirect.

**Expected behavior**
Session-ended notice like checkout.

**Impact**
Lost edits.

**Root cause**
-

**Recommended fix**
Central 401 signal as in admin.

**Test case**
-

**Regression risk**
Low.

### [SF-L1] [Low] Remaining Low items from the storefront audit

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: storefront
- Module: Various
- Route: various
- Component/Function: various
- File: see docs/ui-audit/STOREFRONT_UI_STATES_AUDIT.md
- Line: -
- State: Various
- Trigger/Precondition: -

**Actual behavior**
L1-L10 of the audit: wallet top-up has no idempotency key; two idempotency keys lack copy; copy-to-clipboard claims success without awaiting; logout has no onError; Pay redirect pushes history; guest email error lingers; possible cart focus-refetch overwrite; Checkout/Wallet error states have no retry; failed context looks signed out; tracking replaces a signed-in session.

**Expected behavior**
-

**Impact**
Usability.

**Root cause**
-

**Recommended fix**
Fix individually.

**Test case**
-

**Regression risk**
Low.

### [SF-L2] [Low] Help page new-ticket submit has a silent busy block

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: storefront
- Module: Support
- Route: /help
- Component/Function: HelpPage
- File: apps/storefront/client/src/pages/HelpPage.tsx
- Line: -
- State: Form validation
- Trigger/Precondition: A file failed.

**Actual behavior**
Submit disabled with no reason.

**Expected behavior**
Reuse helpdesk.upload_failed_blocks_send.

**Impact**
Confusion.

**Root cause**
-

**Recommended fix**
Same as TicketComposer.

**Test case**
-

**Regression risk**
Low.

### [LD-01] [Medium] Loading states were inconsistent (text, two fallbacks, no aria-busy, fake 0%)

- Status: Fixed
- Commit: `58de858b`, `3ee981f4`, `99874fbf`, `a6481143`, `24591480`, `ae876166`, `838deaf1`, `a33e86df`, `9eeef9ab`, `1bd69dc9`, `45b3f03e`
- Confidence: Confirmed
- Surface: both
- Module: All
- Route: all
- Component/Function: Button pending, Spinner, Skeleton, LoadingRegion, RouteFallback
- File: apps/*/client/src/components
- Line: -
- State: Loading
- Trigger/Precondition: Any async load or mutation.

**Actual behavior**
~30 "Loading..." texts in admin, two admin route fallbacks, no aria-busy on pending buttons, storefront showed "Uploading 0%".

**Expected behavior**
Skeletons for predictable content, spinner + kept label in pending buttons, one fallback, real progress only, motion-safe.

**Impact**
Inconsistent feedback.

**Root cause**
-

**Recommended fix**
Done.

**Test case**
loading-primitives.test.tsx, Button pending tests, page skeleton tests (both client suites run once: 272 files / 2892 tests).

**Regression risk**
Shared Button/DataTable reach every page.

### [VIS-01] [Low] Admin failure notices had no state icon; a failed refresh looked like a failed load

- Status: Fixed
- Commit: `5162acb7`
- Confidence: Confirmed
- Surface: web-admin
- Module: All
- Route: all
- Component/Function: QueryErrorNotice
- File: apps/web-admin/client/src/components/shared/QueryErrorNotice.tsx
- Line: -
- State: Error
- Trigger/Precondition: Any failed query.

**Actual behavior**
Text-only rust box for both cases.

**Expected behavior**
Error: circle-alert, rust. Failed refresh: triangle-alert, amber warning.

**Impact**
Colour was the only cue.

**Root cause**
-

**Recommended fix**
Done.

**Test case**
stateVisuals.test.tsx.

**Regression risk**
Low.

### [VIS-02] [Low] Admin session-ended banner looked like an error

- Status: Fixed
- Commit: `5162acb7`
- Confidence: Confirmed
- Surface: web-admin
- Module: Auth
- Route: all
- Component/Function: SessionExpiredBanner
- File: apps/web-admin/client/src/components/layout/SessionExpiredBanner.tsx
- Line: -
- State: Session expiry
- Trigger/Precondition: 401.

**Actual behavior**
Rust box, no icon.

**Expected behavior**
lock-keyhole, warning tone.

**Impact**
Read as a failure.

**Root cause**
-

**Recommended fix**
Done.

**Test case**
stateVisuals.test.tsx.

**Regression risk**
Low.

### [VIS-03] [Low] Admin bulk-failure panel and error boundary had no icon; boundary not announced

- Status: Fixed
- Commit: `5162acb7`
- Confidence: Confirmed
- Surface: web-admin
- Module: All
- Route: all
- Component/Function: BulkFailuresNotice, ErrorBoundary
- File: apps/web-admin/client/src/components/shared/
- Line: -
- State: Error
- Trigger/Precondition: -

**Actual behavior**
No icon; fallback had no role.

**Expected behavior**
circle-alert; role=alert on the fallback.

**Impact**
Low.

**Root cause**
-

**Recommended fix**
Done.

**Test case**
stateVisuals.test.tsx.

**Regression risk**
Low.

### [VIS-04] [Low] Admin upload rows showed a made-up 0% and raw state names

- Status: Fixed
- Commit: `5162acb7`
- Confidence: Confirmed
- Surface: web-admin
- Module: Support
- Route: /support/:ticketId
- Component/Function: SupportUploadPicker
- File: apps/web-admin/client/src/components/support/SupportUploadPicker.tsx
- Line: -
- State: Uploading, Uploaded, Failed upload
- Trigger/Precondition: Attach a file.

**Actual behavior**
"Uploading 0%" and an empty bar before progress; "ready"/"failed" as raw words; failure not coloured.

**Expected behavior**
Words plus cloud-upload / file-check / file-x; percentage only once measured; failure reason in rust.

**Impact**
Fake progress.

**Root cause**
-

**Recommended fix**
Done.

**Test case**
SupportUploadPicker.test.tsx (5 new).

**Regression risk**
Low.

### [VIS-05] [Low] Storefront error and warning alerts used the same icon

- Status: Fixed
- Commit: `d158b647`
- Confidence: Confirmed
- Surface: storefront
- Module: All
- Route: all
- Component/Function: Alert
- File: apps/storefront/client/src/components/ui/Alert.tsx
- Line: -
- State: Error
- Trigger/Precondition: Any error banner or panel.

**Actual behavior**
AlertTriangle/TriangleAlert for both error and warning; only colour differed.

**Expected behavior**
Error uses circle-alert.

**Impact**
Colour-only differentiator.

**Root cause**
-

**Recommended fix**
Done (Flash.test assertion updated on purpose).

**Test case**
stateVisuals.test.tsx, Flash.test.tsx.

**Regression risk**
Every error Alert changes icon.

### [VIS-06] [Low] Storefront refresh-failed notice and error boundary had no state icon

- Status: Fixed
- Commit: `d158b647`
- Confidence: Confirmed
- Surface: storefront
- Module: All
- Route: all
- Component/Function: RefreshFailedNotice, ErrorBoundary
- File: apps/storefront/client/src/components/shop/LoadFailed.tsx; components/ErrorBoundary.tsx
- Line: -
- State: Error
- Trigger/Precondition: -

**Actual behavior**
Text only.

**Expected behavior**
triangle-alert (warning) / circle-alert (error), hidden from assistive tech.

**Impact**
Low.

**Root cause**
-

**Recommended fix**
Done.

**Test case**
stateVisuals.test.tsx.

**Regression risk**
Low.

### [VIS-07] [Low] Storefront upload rows had no state icons; failure reason not coloured

- Status: Fixed
- Commit: `d158b647`
- Confidence: Confirmed
- Surface: storefront
- Module: Support
- Route: /account/support/:id, /help
- Component/Function: SupportUploadPicker
- File: apps/storefront/client/src/components/shop/SupportUploadPicker.tsx
- Line: -
- State: Uploading, Uploaded, Failed upload
- Trigger/Precondition: Attach a file.

**Actual behavior**
Words only.

**Expected behavior**
cloud-upload / file-check / file-x; reason in rust-dark.

**Impact**
Low.

**Root cause**
-

**Recommended fix**
Done.

**Test case**
SupportUploadPicker.test.tsx (3 new).

**Regression risk**
Low.

### [VIS-08] [Medium] Neither client has an offline (wifi-off) or slow-network (signal-low) visual

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: both
- Module: All
- Route: all
- Component/Function: -
- File: -
- Line: -
- State: Offline, Slow network
- Trigger/Precondition: -

**Actual behavior**
No indicator exists.

**Expected behavior**
Per section D, once ADM-M1/M3 and SF-M3 define the behaviour.

**Impact**
See ADM-M1, ADM-M3, SF-M3.

**Root cause**
No offline/timeout handling.

**Recommended fix**
Build with those findings.

**Test case**
-

**Regression risk**
-

### [VIS-09] [Low] No permission-denied visual in use

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: both
- Module: Permissions
- Route: all
- Component/Function: PermissionDeniedState (storefront), none (admin)
- File: apps/storefront/client/src/components/shop/PermissionDeniedState.tsx
- Line: -
- State: Permission denied
- Trigger/Precondition: -

**Actual behavior**
Storefront component exists (ShieldX) with no call sites; admin has none.

**Expected behavior**
shield-alert, warning, once ADM-M6 lands.

**Impact**
Low.

**Root cause**
-

**Recommended fix**
With ADM-M6.

**Test case**
-

**Regression risk**
-

### [VIS-10] [Low] Admin filtered-empty states reuse the first-time-empty icon

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Lists
- Route: list pages
- Component/Function: EmptyState call sites
- File: apps/web-admin/client/src/pages/*Page.tsx
- Line: -
- State: Zero search results
- Trigger/Precondition: Filter returns nothing.

**Actual behavior**
Same entity icon; distinguished by copy and Clear Filters (so not colour-only).

**Expected behavior**
search-x for filtered empty (as SearchPage already does).

**Impact**
Cosmetic.

**Root cause**
-

**Recommended fix**
Per-page icon swap.

**Test case**
-

**Regression risk**
Low.

### [VIS-11] [Low] Small admin empty states (dashboard widgets, sub-tables) have no icon

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Dashboard / detail tables
- Route: /, detail pages
- Component/Function: EmptyState without icon (19 call sites)
- File: apps/web-admin/client/src/components/dashboard/*; pages/*
- Line: -
- State: Empty
- Trigger/Precondition: -

**Actual behavior**
Text only.

**Expected behavior**
Owner decides; a 48px icon would change compact card layout.

**Impact**
Cosmetic.

**Root cause**
-

**Recommended fix**
Leave or add a small inbox icon variant.

**Test case**
-

**Regression risk**
Layout of compact cards.

### [SEC-01] [High] Order.customerData is stored as plaintext

- Status: Open
- Commit: -
- Confidence: Confirmed
- Surface: web-admin
- Module: Orders (data)
- Route: -
- Component/Function: createOrder / performCheckout
- File: packages/db/src/crud/orders.ts
- Line: 942-975 (also 1263-1292, 3512)
- State: -
- Trigger/Precondition: Checkout with info-step answers.

**Actual behavior**
Answers are stored verbatim as JSON text.

**Expected behavior**
Owner rule 2026-11-01: sensitive data must be protected (credentialCrypto).

**Impact**
Answers may include account credentials.

**Root cause**
No encryption at rest.

**Recommended fix**
Separate branch: encrypt at write, decrypt on authorised reads, migrate existing rows.

**Test case**
Round-trip and readonly projection tests.

**Regression risk**
Schema/data migration; out of this branch.
